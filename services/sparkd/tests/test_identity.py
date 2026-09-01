"""@verifies docs/BACKLOG.md#SPK-74 · docs/DAT.md §17.5 (l'identité présentée),
            §17.2 (aucune clé privée, jamais), §21.2 (ce qui traverse le
            journal), §42.5 (exec_capture), §14.6 du design system

Ce que ces preuves gardent : l'identité est le sens INVERSE des clés de SPK-11.
Elle laisse le Spark SORTIR — se présenter à GitHub en clé de déploiement — et
sa partie privée ne doit jamais quitter la cellule.

La seconde garde est la distinction « absente » / « indisponible ». Les fondre
ferait créer une seconde identité en croyant réparer la première, ce qui
invaliderait la clé déjà posée chez le tiers.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from sparkd import identity
from sparkd.app import create_app
from sparkd.config import load

GIO = 1024**3


class PiloteFactice:
    """Doublon minimal : il REND ce qu'on lui dit, et retient ce qu'on lui passe."""

    def __init__(self, reponses):
        self.reponses = list(reponses)
        self.appels: list[list[str]] = []

    def exec_capture(self, name, command):
        self.appels.append(command)
        return self.reponses.pop(0)


CLE = ("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ1YQr7v3xVYQ8Vb5Wl0Zx8mS0F5Zt3n"
       "Qh7pQ2bK9tXe spark:crm")


# --- le relevé : trois états, et il en faut bien trois (§14.6) ---------------


def test_une_identite_presente_rend_sa_cle_publique_et_son_empreinte():
    pilote = PiloteFactice([(0, CLE + "\n", "")])
    vu = identity.relever(pilote, "cellule")
    assert vu["state"] == identity.PRESENTE
    assert vu["public_key"].startswith("ssh-ed25519 ")
    assert vu["fingerprint"].startswith("SHA256:")
    assert vu["comment"] == "spark:crm"


def test_le_releve_N_ECRIT_RIEN():
    """§42.1 : on doit pouvoir regarder sans créer. Un relevé qui créerait
    obligerait à poser une identité pour savoir s'il y en a une."""
    pilote = PiloteFactice([(4, "", "")])
    identity.relever(pilote, "cellule")
    joint = " ".join(" ".join(c) for c in pilote.appels)
    assert "ssh-keygen" not in joint
    assert "rm " not in joint


def test_absente_et_indisponible_sont_DEUX_etats_distincts():
    """LE point de l'unité côté lecture. « Absente » appelle à créer,
    « indisponible » appelle à démarrer le Spark : les fondre ferait créer une
    seconde identité et invaliderait la clé déjà posée chez le tiers."""
    absente = identity.relever(PiloteFactice([(4, "", "")]), "cellule")
    indispo = identity.relever(PiloteFactice([(1, "", "erreur")]), "cellule")
    assert absente["state"] == identity.ABSENTE
    assert indispo["state"] == identity.INDISPONIBLE
    assert absente["state"] != indispo["state"]


def test_une_sortie_illisible_ne_passe_PAS_pour_une_cle():
    """Le même analyseur que les clés entrantes (§17.2) : deux analyseurs
    finiraient par accepter deux choses différentes."""
    pilote = PiloteFactice([(0, "ceci n'est pas une clé\n", "")])
    with pytest.raises(identity.IdentityError):
        identity.relever(pilote, "cellule")


# --- la création, et le refus d'écraser -------------------------------------


def test_creer_passe_le_commentaire_en_ARGUMENT_et_pas_par_interpolation():
    """Un nom de Spark n'a pas à pouvoir fermer une quote dans un script shell."""
    pilote = PiloteFactice([(0, CLE + "\n", "")])
    identity.creer(pilote, "cellule", "crm; rm -rf /")
    commande = pilote.appels[0]
    assert "spark:crm; rm -rf /" in commande, "le nom passe en argument"
    script = commande[2]
    assert "crm; rm -rf /" not in script, "et JAMAIS dans le corps du script"


def test_creer_REFUSE_d_ecraser_une_identite_existante():
    """Régénérer invalide la clé de déploiement déjà posée chez le tiers, et
    rien sur la Forge ne le sait (§17.5)."""
    pilote = PiloteFactice([(identity.DEJA, "", "")])
    with pytest.raises(identity.IdentityError) as refus:
        identity.creer(pilote, "cellule", "crm")
    assert "déjà une identité" in str(refus.value)
    assert "remplacement" in str(refus.value)


def test_le_remplacement_est_DEMANDE_explicitement():
    pilote = PiloteFactice([(0, CLE + "\n", "")])
    identity.creer(pilote, "cellule", "crm", remplacer=True)
    assert pilote.appels[0][-1] == "oui"
    pilote = PiloteFactice([(0, CLE + "\n", "")])
    identity.creer(pilote, "cellule", "crm")
    assert pilote.appels[0][-1] == "non"


def test_un_echec_de_la_cellule_DIT_ce_qu_elle_a_dit():
    pilote = PiloteFactice([(1, "", "ssh-keygen: command not found")])
    with pytest.raises(identity.IdentityError) as refus:
        identity.creer(pilote, "cellule", "crm")
    assert "command not found" in str(refus.value)


# --- l'API, contre la vraie pile locale -------------------------------------


def _client(tmp_path):
    client = TestClient(create_app(load({"SPARKD_DB": str(tmp_path / "i.db"),
                                         "SPARKD_DRIVER": "fake"})))
    assert client.post("/v1/forge/sync").status_code in (200, 201)
    return client


def _creer_spark(client, nom="crm", demarrer=True):
    assert client.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.5, "memory_bytes": GIO, "storage_bytes": 5 * GIO,
        "network_bps": 10_000_000}).status_code == 201
    assert client.post(f"/v1/sparks/{nom}/apply").status_code == 200
    if demarrer:
        assert client.post(f"/v1/sparks/{nom}/start").status_code == 200
    return nom


def test_API_absente_puis_creee_puis_deja_presente(tmp_path):
    client = _client(tmp_path)
    _creer_spark(client)

    avant = client.get("/v1/sparks/crm/identity")
    assert avant.status_code == 200
    assert avant.json()["state"] == identity.ABSENTE

    cree = client.post("/v1/sparks/crm/identity", json={})
    assert cree.status_code == 201, cree.text
    corps = cree.json()
    assert corps["state"] == identity.PRESENTE
    assert corps["public_key"].startswith("ssh-ed25519 ")
    assert corps["comment"] == "spark:crm"

    # Le relevé rend EXACTEMENT ce que la création a rendu : la cellule est la
    # seule source, et une copie au registre divergerait (§17.5).
    relu = client.get("/v1/sparks/crm/identity").json()
    assert relu["public_key"] == corps["public_key"]
    assert relu["fingerprint"] == corps["fingerprint"]

    # Second appel sans drapeau : REFUS, et il nomme la conséquence.
    encore = client.post("/v1/sparks/crm/identity", json={})
    assert encore.status_code == 409
    assert encore.json()["detail"]["error"] == "identity_exists"
    assert client.get("/v1/sparks/crm/identity").json()["public_key"] == corps["public_key"]


def test_API_le_remplacement_change_reellement_la_cle(tmp_path):
    client = _client(tmp_path)
    _creer_spark(client)
    premiere = client.post("/v1/sparks/crm/identity", json={}).json()
    seconde = client.post("/v1/sparks/crm/identity", json={"replace": True})
    assert seconde.status_code == 201, seconde.text
    assert seconde.json()["public_key"] != premiere["public_key"]


def test_API_un_Spark_ARRETE_rend_indisponible_et_non_absente(tmp_path):
    """§14.6 : lire l'écran des clés d'un Spark éteint ne doit pas tomber sur
    une erreur, ni faire croire qu'il n'y a pas d'identité."""
    client = _client(tmp_path)
    _creer_spark(client, demarrer=False)
    vu = client.get("/v1/sparks/crm/identity")
    assert vu.status_code == 200
    assert vu.json()["state"] == identity.INDISPONIBLE


def test_API_creer_sur_un_Spark_ARRETE_est_REFUSE(tmp_path):
    """Lire est passif et rend un état ; créer exige une cellule vivante et
    refuse en le disant."""
    client = _client(tmp_path)
    _creer_spark(client, demarrer=False)
    assert client.post("/v1/sparks/crm/identity", json={}).status_code == 409


def test_API_la_cle_PRIVEE_ne_sort_JAMAIS(tmp_path):
    """§17.2 tenu par la construction : rien ne lit la partie privée."""
    client = _client(tmp_path)
    _creer_spark(client)
    corps = client.post("/v1/sparks/crm/identity", json={}).text
    assert "PRIVATE KEY" not in corps.upper()
    assert client.get("/v1/sparks/crm/identity").text.upper().count("PRIVATE KEY") == 0


def test_API_le_journal_retient_l_EMPREINTE_jamais_le_corps(tmp_path):
    """§21.2 : une clé publique n'est pas un secret, mais un journal n'a pas à
    la répéter — et une clé privée n'y entre en aucun cas."""
    client = _client(tmp_path)
    _creer_spark(client)
    cree = client.post("/v1/sparks/crm/identity", json={}).json()
    journal = client.get("/v1/audit").text
    assert cree["fingerprint"] in journal
    corps_cle = cree["public_key"].split()[1]
    assert corps_cle not in journal
    assert "PRIVATE KEY" not in journal.upper()
