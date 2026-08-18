"""@verifies docs/BACKLOG.md#SPK-09 · docs/DAT.md §14.1, §14.3 · docs/SCHEMA.md §4

La Definition of Done exige la machine a etats testee « y compris les transitions
interdites et la reprise apres echec en cours de creation ». Ce sont les deux
moities que ces tests couvrent — et les interdits pesent plus que les permis :
une machine a etats qui n'a jamais rien refuse n'a rien prouve.
"""

from __future__ import annotations

import pytest

from sparkd.lifecycle import (
    STABLE,
    TRANSIENT,
    Command,
    State,
    TransitionError,
    allowed,
    next_state,
    reconcile,
    settle,
)


# --- transitions autorisees -------------------------------------------------

@pytest.mark.parametrize("depart,commande,arrivee", [
    (State.PENDING, Command.APPLY,   State.CREATING),
    (State.PENDING, Command.DELETE,  State.DELETING),
    (State.STOPPED, Command.START,   State.STARTING),
    (State.STOPPED, Command.DELETE,  State.DELETING),
    (State.RUNNING, Command.STOP,    State.STOPPING),
    (State.RUNNING, Command.RESTART, State.STOPPING),
    (State.RUNNING, Command.DELETE,  State.DELETING),
    (State.ERROR,   Command.RETRY,   State.CREATING),
    (State.ERROR,   Command.DELETE,  State.DELETING),
])
def test_transitions_autorisees(depart, commande, arrivee):
    assert next_state(depart, commande) is arrivee


def test_le_redemarrage_passe_par_l_arret():
    """docs/DAT.md §14.1 : un redemarrage n'est pas un etat.

    Le modeliser autrement cacherait la fenetre pendant laquelle le Spark est
    reellement arrete.
    """
    assert next_state(State.RUNNING, Command.RESTART) is State.STOPPING


def test_tout_etat_stable_peut_etre_supprime():
    for etat in STABLE:
        assert Command.DELETE in allowed(etat)


# --- transitions interdites -------------------------------------------------

@pytest.mark.parametrize("etat", sorted(TRANSIENT, key=lambda e: e.value))
@pytest.mark.parametrize("commande", list(Command))
def test_aucun_etat_transitoire_n_accepte_de_commande(etat, commande):
    """Une seconde commande produirait deux verites concurrentes."""
    with pytest.raises(TransitionError):
        next_state(etat, commande)


@pytest.mark.parametrize("depart,commande", [
    (State.PENDING, Command.START),    # rien n'existe encore dans Incus
    (State.PENDING, Command.STOP),
    (State.STOPPED, Command.STOP),     # deja arrete
    (State.STOPPED, Command.RESTART),
    (State.RUNNING, Command.START),    # deja demarre
    (State.RUNNING, Command.APPLY),
    (State.ERROR,   Command.START),    # il faut reprendre, pas demarrer
    (State.ERROR,   Command.STOP),
])
def test_transitions_interdites(depart, commande):
    with pytest.raises(TransitionError):
        next_state(depart, commande)


def test_le_refus_nomme_l_etat_et_les_commandes_possibles():
    """Un refus muet obligerait l'appelant a deviner."""
    with pytest.raises(TransitionError) as refus:
        next_state(State.STOPPED, Command.STOP)
    message = str(refus.value)
    assert "stopped" in message
    assert "start" in message and "delete" in message


def test_le_refus_sur_etat_transitoire_dit_d_attendre():
    with pytest.raises(TransitionError) as refus:
        next_state(State.CREATING, Command.START)
    assert "deja en cours" in str(refus.value).replace("é", "e").replace("à", "a")


# --- aboutissement d'une operation ------------------------------------------

@pytest.mark.parametrize("transitoire,arrivee", [
    (State.CREATING, State.STOPPED),
    (State.STARTING, State.RUNNING),
    (State.STOPPING, State.STOPPED),
])
def test_operation_reussie(transitoire, arrivee):
    assert settle(transitoire, success=True) is arrivee


@pytest.mark.parametrize("transitoire", [State.CREATING, State.STARTING, State.STOPPING])
def test_operation_echouee_mene_a_error(transitoire):
    assert settle(transitoire, success=False) is State.ERROR


def test_suppression_ratee_ne_perd_pas_le_spark():
    """Une suppression ratee laisse le Spark la ou il etait, pas dans un etat
    d'ou l'on ne pourrait plus rien faire."""
    assert settle(State.DELETING, success=False) is State.ERROR
    assert Command.DELETE in allowed(State.ERROR)


# --- reprise apres echec (§14.3) --------------------------------------------

@pytest.mark.parametrize("etat,existe,demarre,attendu", [
    # Creation : rien n'a ete cree -> la demande reste valide.
    (State.CREATING, False, False, State.PENDING),
    (State.CREATING, True,  False, State.STOPPED),
    # Demarrage / arret : la realite d'Incus tranche.
    (State.STARTING, True,  True,  State.RUNNING),
    (State.STARTING, True,  False, State.STOPPED),
    (State.STOPPING, True,  True,  State.RUNNING),
    (State.STOPPING, True,  False, State.STOPPED),
    # Suppression en cours, instance encore la : a reprendre.
    (State.DELETING, True,  False, State.DELETING),
])
def test_reconciliation_au_demarrage(etat, existe, demarre, attendu):
    assert reconcile(etat, exists=existe, running=demarre).state is attendu


def test_suppression_aboutie_retire_la_ligne():
    resultat = reconcile(State.DELETING, exists=False, running=False)
    assert resultat.state is None
    assert "retiree" in resultat.reason.replace("é", "e")


def test_creation_interrompue_revient_a_pending_pas_a_error():
    """Rien n'a ete cree : l'exploitant n'a rien a arbitrer."""
    resultat = reconcile(State.CREATING, exists=False, running=False)
    assert resultat.state is State.PENDING
    assert resultat.state is not State.ERROR


def test_instance_disparue_pendant_une_operation_demande_un_humain():
    """Le registre et la machine divergent : ce n'est pas rattrapable seul."""
    resultat = reconcile(State.STARTING, exists=False, running=False)
    assert resultat.state is State.ERROR
    assert "humain" in resultat.reason


def test_un_etat_stable_n_est_pas_reconcilie():
    for etat in STABLE:
        assert reconcile(etat, exists=True, running=False).state is etat


def test_chaque_reconciliation_est_motivee():
    """La trace doit se lire comme celle d'un arret, pas comme une anomalie."""
    for etat in TRANSIENT:
        for existe in (True, False):
            assert reconcile(etat, exists=existe, running=False).reason
