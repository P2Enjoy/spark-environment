"""Machine à états du cycle de vie d'un Spark.

@spec docs/BACKLOG.md#SPK-09 · docs/DAT.md §14 (Cycle de vie d'un Spark),
      §14.2 (le registre s'écrit avant Incus), §14.3 (reprise après échec),
      §7.7 (ce que compte l'admission control) · docs/SCHEMA.md §4

Ce module ne décide que des transitions. Il ne parle ni à Incus ni au réseau :
c'est ce qui permet d'éprouver les refus sans Forge, et ce qui garde la règle
lisible au même endroit.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class State(str, Enum):
    PENDING = "pending"
    CREATING = "creating"
    STOPPED = "stopped"
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"
    ERROR = "error"
    DELETING = "deleting"


class Command(str, Enum):
    APPLY = "apply"
    START = "start"
    STOP = "stop"
    RESTART = "restart"
    DELETE = "delete"
    RETRY = "retry"


#: Un état transitoire décrit une opération EN COURS. Il n'accepte aucune
#: nouvelle commande : en lancer une seconde produirait deux vérités
#: concurrentes sur la même instance (docs/DAT.md §14.1).
TRANSIENT = frozenset({State.CREATING, State.STARTING, State.STOPPING, State.DELETING})

STABLE = frozenset({State.PENDING, State.STOPPED, State.RUNNING, State.ERROR})

#: Commande autorisée -> état atteint immédiatement.
_ALLOWED: dict[State, dict[Command, State]] = {
    State.PENDING: {Command.APPLY: State.CREATING, Command.DELETE: State.DELETING},
    State.STOPPED: {Command.START: State.STARTING, Command.DELETE: State.DELETING},
    State.RUNNING: {
        Command.STOP: State.STOPPING,
        # Un redémarrage n'est pas un état : c'est un arrêt suivi d'un
        # démarrage. Le modéliser autrement cacherait la fenêtre pendant
        # laquelle le Spark est réellement arrêté (docs/DAT.md §14.1).
        Command.RESTART: State.STOPPING,
        Command.DELETE: State.DELETING,
    },
    State.ERROR: {Command.RETRY: State.CREATING, Command.DELETE: State.DELETING},
}


class TransitionError(RuntimeError):
    """Commande impossible depuis l'état courant."""

    def __init__(self, state: State, command: Command) -> None:
        self.state = state
        self.command = command
        if state in TRANSIENT:
            raison = (
                f"une opération est déjà en cours (« {state.value} »). Attendre "
                "qu'elle aboutisse ; en lancer une seconde produirait deux "
                "vérités concurrentes sur la même instance."
            )
        else:
            possibles = ", ".join(sorted(c.value for c in _ALLOWED.get(state, {})))
            raison = (
                f"depuis « {state.value} », les commandes possibles sont : "
                f"{possibles or 'aucune'}."
            )
        super().__init__(f"« {command.value} » impossible : {raison}")


def allowed(state: State) -> set[Command]:
    """Commandes acceptables depuis cet état."""
    return set(_ALLOWED.get(state, {}))


def next_state(state: State, command: Command) -> State:
    """État atteint, ou refus nommant l'état courant et les commandes possibles."""
    try:
        return _ALLOWED[state][command]
    except KeyError:
        raise TransitionError(state, command) from None


def settle(state: State, success: bool) -> State:
    """État atteint quand une opération transitoire se termine.

    Une opération transitoire qui échoue mène à `error`, sauf la suppression :
    une suppression ratée laisse le Spark là où il était, pas dans un état d'où
    l'on ne pourrait plus rien faire.
    """
    if state not in TRANSIENT:
        raise TransitionError(state, Command.APPLY)
    if not success:
        return State.ERROR
    return {
        State.CREATING: State.STOPPED,
        State.STARTING: State.RUNNING,
        State.STOPPING: State.STOPPED,
        State.DELETING: State.DELETING,  # la ligne disparaît, elle ne « passe » nulle part
    }[state]


@dataclass(frozen=True)
class Reconciliation:
    """Ce qu'il faut faire d'un état transitoire retrouvé au démarrage."""

    state: State | None  #: None = la ligne doit être supprimée
    reason: str


def reconcile(state: State, exists: bool, running: bool) -> Reconciliation:
    """Confronte un état transitoire à la réalité d'Incus (docs/DAT.md §14.3).

    Un état transitoire retrouvé au démarrage n'est pas une anomalie du produit :
    c'est la trace d'un arrêt, et il doit se lire comme tel.
    """
    if state not in TRANSIENT:
        return Reconciliation(state, "état stable, rien à réconcilier")

    if state is State.CREATING:
        if not exists:
            # Retour a « pending » et non « error » : rien n'a ete cree, la
            # demande reste valide, et l'exploitant n'a rien a arbitrer.
            return Reconciliation(State.PENDING, "création interrompue avant d'aboutir")
        return Reconciliation(State.STOPPED, "création aboutie avant l'arrêt")

    if state is State.DELETING:
        if not exists:
            return Reconciliation(None, "suppression aboutie, la ligne est retirée")
        return Reconciliation(State.DELETING, "suppression à reprendre")

    if not exists:
        return Reconciliation(
            State.ERROR,
            "l'instance a disparu d'Incus pendant une opération : le registre et "
            "la machine divergent, un humain doit trancher",
        )

    if state is State.STARTING:
        return Reconciliation(
            State.RUNNING if running else State.STOPPED,
            "démarrage abouti" if running else "démarrage interrompu",
        )

    # STOPPING
    return Reconciliation(
        State.RUNNING if running else State.STOPPED,
        "arrêt interrompu" if running else "arrêt abouti",
    )
