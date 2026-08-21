"""@verifies docs/BACKLOG.md#SPK-67 · docs/DAT.md §12.1 (le contrat d'échec du
            pilote, et ce que le doublon en doit), §12 (ce qu'un doublon ne
            prouve jamais), §33.3 (ne pas savoir n'est pas savoir que ce n'est
            pas là), §14.5, §14.6

Ces preuves comparent les DEUX pilotes sur la MÊME condition, méthode par
méthode, et elles le font par ÉNUMÉRATION du contrat : une méthode ajoutée
demain au protocole entre d'elle-même dans la comparaison. C'est le point de
l'unité — un doublon qui diverge du vrai fabrique des preuves vertes pour du
code faux, et la divergence a coûté un défaut de production (§14.6).
"""

from __future__ import annotations

import httpx
import pytest

from sparkd import incus as module
from sparkd.incus import FakeIncus, IncusClient, IncusError, InstanceAbsente

GIO = 1024**3

#: Les méthodes du contrat qui DÉSIGNENT une instance par son nom ET dont Incus
#: sait rapporter l'absence. Les autres interrogent le serveur ou une collection.
#:
#: `snapshots` en est ABSENTE, et c'est mesuré, pas supposé : Incus rend 200 et
#: une liste vide pour une instance inconnue (§12.1.2). L'y inclure exigerait du
#: doublon une distinction que la production ne sait pas faire.
def _appels(pilote):
    return {
        "instance_state":          lambda: pilote.instance_state("absente"),
        "set_instance_state":      lambda: pilote.set_instance_state("absente", "start"),
        "delete_instance":         lambda: pilote.delete_instance("absente"),
        "update_instance_config":  lambda: pilote.update_instance_config("absente", {"a": "b"}),
        "set_publication_devices": lambda: pilote.set_publication_devices("absente", {}),
        "update_root_size":        lambda: pilote.update_root_size("absente", "5GiB"),
        "push_file":               lambda: pilote.push_file("absente", "/etc/x", "y"),
        "exec_command":            lambda: pilote.exec_command("absente", ["true"]),
        "exec_capture":            lambda: pilote.exec_capture("absente", ["true"]),
        "create_snapshot":         lambda: pilote.create_snapshot("absente", "s"),
        "restore_snapshot":        lambda: pilote.restore_snapshot("absente", "s"),
        "delete_snapshot":         lambda: pilote.delete_snapshot("absente", "s"),
    }


def _transport_qui_repond(monkeypatch, statut: int, corps=None):
    """Fait parler un vrai `UnixSocketIncus` à un Incus SIMULÉ.

    Le client construit son transport lui-même dans chaque méthode : on
    l'intercepte à la source plutôt que d'inventer un second client, sans quoi
    la preuve mesurerait un code qui ne tourne pas.
    """
    def repondre(requete: httpx.Request) -> httpx.Response:
        return httpx.Response(statut, json=corps if corps is not None else {
            "error": "not found", "error_code": statut})

    monkeypatch.setattr(module.httpx, "HTTPTransport",
                        lambda *a, **k: httpx.MockTransport(repondre))
    return module.UnixSocketIncus(socket_path="/inexistant.sock")


# --- le contrat du VRAI pilote ----------------------------------------------


@pytest.mark.parametrize("methode", sorted(_appels(None)))
def test_le_VRAI_pilote_leve_InstanceAbsente_sur_un_404(methode, monkeypatch):
    """§12.1.2 : une absence RAPPORTÉE lève `InstanceAbsente`, quel que soit le
    transport.

    Mesuré le 2026-08-21 avant correction : le client emploie trois aides
    privées, et seule `_request` distinguait l'absence. `_get` et `_raw_push`
    noyaient le 404 dans une panne générique — donc `instance_state`,
    `snapshots` et `push_file` ne savaient pas dire qu'une cellule a disparu.
    """
    pilote = _transport_qui_repond(monkeypatch, 404)
    with pytest.raises(InstanceAbsente):
        _appels(pilote)[methode]()


@pytest.mark.parametrize("methode", sorted(_appels(None)))
def test_le_VRAI_pilote_leve_IncusError_sur_tout_le_reste(methode, monkeypatch):
    """La borne du §33.3 : ne pas pouvoir demander n'est pas savoir que ce n'est
    pas là. Un 500 ne doit JAMAIS se lire comme une absence, sans quoi le
    produit proposerait de reconstruire une cellule qui tourne encore."""
    pilote = _transport_qui_repond(monkeypatch, 500)
    with pytest.raises(IncusError) as vu:
        _appels(pilote)[methode]()
    assert not isinstance(vu.value, InstanceAbsente)


# --- le doublon doit rendre LA MÊME chose ------------------------------------


@pytest.mark.parametrize("methode", sorted(_appels(None)))
def test_le_DOUBLON_rend_la_meme_exception_que_le_vrai(methode, monkeypatch):
    """LE cœur de l'unité (§12.1.3, point 1).

    Le doublon est comparé au vrai sur la même condition, pas à une idée qu'on
    se fait du vrai. Mesuré avant correction : six méthodes divergeaient.
    """
    vrai = _transport_qui_repond(monkeypatch, 404)
    with pytest.raises(InstanceAbsente):
        _appels(vrai)[methode]()

    with pytest.raises(InstanceAbsente):
        _appels(FakeIncus())[methode]()


def test_le_DOUBLON_n_en_sait_pas_PLUS_que_le_vrai(tmp_path):
    """§12.1.3, point 2 — et cette preuve est née d'une erreur de ma part.

    J'avais d'abord fait LEVER le doublon ici, en écrivant que rendre `[]` sur
    une instance absente était son écart le plus silencieux. La mesure sur la
    Forge de validation, le 2026-08-21, contre un vrai Incus, dit l'inverse :

        GET /1.0/instances/<inconnue>/snapshots -> 200, metadata: []

    Tous les autres points du contrat rendent 404 ; celui-là non. Le doublon
    était donc FIDÈLE, et mon correctif l'avait fait diverger.

    Un doublon voit tout son état : il peut toujours répondre mieux qu'Incus.
    Il ne doit pas. En savoir plus que le vrai rend vertes des preuves fondées
    sur une distinction que la production ne sait pas faire — le défaut de cette
    unité, pris à l'envers.
    """
    assert FakeIncus().snapshots("jamais-creee") == []


def test_une_COLLECTION_n_est_pas_une_instance(tmp_path):
    """La borne du §12.1.2 : sans elle, la règle transformerait « aucun Spark »
    en panne, et l'écran de la Forge d'une machine neuve serait rouge."""
    assert FakeIncus().instances() == []


def test_un_CODE_DE_SORTIE_non_nul_reste_une_reponse(monkeypatch):
    """L'autre borne du §12.1.2, reprise du §42.5 : `command -v sshd` qui rend 1
    dit « absent », il ne dit pas que le pilote est en panne. Les confondre
    ferait échouer l'amorçage sur ce qu'il est précisément venu constater.

    Mesurée sur le VRAI client : c'est là que vit la règle. Le doublon rend
    toujours 0, et une preuve écrite contre lui ne dirait rien du produit —
    c'est le piège que cette unité entière traite.
    """
    pilote = _transport_qui_repond(monkeypatch, 200, {
        "metadata": {"metadata": {"return": 1, "output": {}}}})
    code, _, _ = pilote.exec_capture("vivante", ["command", "-v", "sshd"])
    assert code == 1, "un code non nul se REND, il ne lève pas"


# --- le doublon relit son état ----------------------------------------------


def test_le_DOUBLON_RELIT_son_etat_a_chaque_operation(tmp_path):
    """§12.1.3, point 3 : le vrai pilote n'a AUCUN cache.

    Sans cette relecture, une cellule qui disparaît hors du produit reste
    invisible au doublon tant que le service tourne — c'est-à-dire que
    l'évènement instruit par `docs/CONTINGENCE.md` §4 devient injouable contre
    la pile de développement sans redémarrer `sparkd`.
    """
    etat = tmp_path / "incus.json"
    pilote = FakeIncus(state_path=etat)
    pilote.create_instance({"name": "helo"})
    assert "helo" in pilote.created

    # La cellule disparaît SOUS le produit, comme sur la Forge le 2026-08-21.
    autre = FakeIncus(state_path=etat)
    autre.delete_instance("helo")

    with pytest.raises(InstanceAbsente):
        pilote.set_instance_state("helo", "start")


def test_sans_chemin_d_etat_le_DOUBLON_reste_en_memoire(tmp_path):
    """La relecture ne doit pas rendre le doublon inutilisable sans fichier :
    la grande majorité des preuves l'emploient ainsi, et une lecture disque par
    appel y serait un coût pour rien."""
    pilote = FakeIncus()
    pilote.create_instance({"name": "vivante"})
    pilote.set_instance_state("vivante", "start")
    assert pilote.created["vivante"]["status"] == "Running"


# --- l'énumération elle-même est gardée --------------------------------------


#: Ce qui est HORS de la comparaison, et POURQUOI. Chaque exclusion porte son
#: motif : une exclusion sans motif est une méthode oubliée qui se déguise.
_HORS_COMPARAISON = {
    "resources":              "interroge le SERVEUR, pas une instance",
    "storage_pool_resources": "interroge un POOL, pas une instance",
    "server_info":            "interroge le SERVEUR",
    "instances":              "COLLECTION : vide est une réponse (§12.1.2)",
    "create_instance":        "crée : il n'y a rien dont l'absence serait anormale",
    "snapshots":              "MESURÉ : Incus rend 200 et une liste vide pour une "
                              "instance inconnue — il ne SAIT PAS rapporter "
                              "l'absence ici (§12.1.2)",
}


def test_le_CONTRAT_ne_gagne_pas_de_methode_en_silence():
    """Cette preuve garde toutes les autres.

    Une méthode ajoutée au protocole sans entrer dans la comparaison
    échapperait à tout ce fichier — et c'est exactement ainsi que
    `set_instance_state` a divergé pendant que `delete_instance` était corrigée.

    Elle force donc un CLASSEMENT, pas un simple passage : toute méthode est
    soit comparée, soit exclue avec son motif écrit. Une exclusion muette serait
    le même oubli sous un autre nom.
    """
    du_contrat = {n for n in dir(IncusClient) if not n.startswith("_")}
    classees = set(_appels(None)) | set(_HORS_COMPARAISON)
    assert du_contrat == classees, (
        "le protocole a changé : toute méthode doit être soit comparée entre "
        "les deux pilotes, soit exclue AVEC son motif dans _HORS_COMPARAISON "
        "(docs/DAT.md §12.1.3)")
    assert all(_HORS_COMPARAISON.values()), "une exclusion sans motif n'en est pas une"
