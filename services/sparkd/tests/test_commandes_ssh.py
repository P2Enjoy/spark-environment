"""@spec docs/BACKLOG.md#SPK-154 · docs/DAT.md §44.9.8
@verifies docs/BACKLOG.md#SPK-154 · docs/DAT.md §44.9.8 (la propriété
          `ssh_commands`, hors du modèle, le même calcul que le dossier),
          §44.9.4 (la surface d'API), §44.9.2 (une cible non reconnue ne compose
          rien), §42.2 quater (root toujours, `spark-docker` en rootless seul)

Ce que ces preuves gardent : la console AFFICHE des commandes qu'elle ne compose
pas. Elles doivent donc venir toutes faites de la route, une par porte, et dire
exactement ce que dit la section 1 du dossier — deux présentations d'un même
calcul, jamais deux calculs (§44.8).
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from sparkd import bootstrap
from sparkd import briefing
from sparkd.app import create_app
from sparkd.config import load

GIO = 1024**3

CLE_PUBLIQUE = ("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILklM4dl9E+GCZog4f8+fV4q3f"
                "R0CvBnyFDMmDcrFbYT poste")

#: La forme minimale d'une ligne de `spark` telle que le modèle la lit.
_CELLULE = {
    "name": "cellule", "ipv4_address": "10.77.0.31", "protected": False,
    "cpu_mode": "shared", "cpu_reservation": 0.5,
    "memory_reservation_bytes": GIO, "storage_bytes": 5 * GIO,
    "network_reservation_bps": 10_000_000, "docker_enabled": 1,
}


def _modele(mode: str | None, *, adresse: str | None = "10.77.0.31",
            docker_enabled: int = 1) -> dict:
    releve = None if mode == "jamais" else {
        "observed_at": "2026-10-11T08:00:00+00:00", "openssh_version": "1:9",
        "docker_version": "5:29", "compose_version": "2.40",
        "docker_mode": mode, "managed_items": []}
    return briefing.modele(
        {**_CELLULE, "ipv4_address": adresse, "docker_enabled": docker_enabled},
        forge_public_address="", routes=[], ports=[], environment=[],
        bootstrap=releve, written_at="2026-10-11T08:00:00+00:00")


def _client(tmp_path) -> TestClient:
    client = TestClient(create_app(load({"SPARKD_DB": str(tmp_path / "c.db"),
                                         "SPARKD_DRIVER": "fake"})))
    assert client.post("/v1/forge/sync").status_code in (200, 201)
    return client


def _creer(client: TestClient, nom: str) -> str:
    assert client.post("/v1/sparks", json={
        "name": nom, "image": "images:debian/13", "cpu_mode": "shared",
        "cpu_reservation": 0.5, "memory_bytes": GIO, "storage_bytes": 5 * GIO,
        "network_bps": 10_000_000}).status_code == 201
    assert client.post(f"/v1/sparks/{nom}/apply").status_code == 200
    assert client.post(f"/v1/sparks/{nom}/start").status_code == 200
    deja = [c["label"] for c in client.get("/v1/ssh-keys").json()["keys"]]
    if "poste" not in deja:
        assert client.post("/v1/ssh-keys", json={
            "label": "poste", "public_key": CLE_PUBLIQUE}).status_code == 201
    assert client.post(f"/v1/sparks/{nom}/ssh-keys/poste").status_code == 200
    return nom


# --- La composition : une entrée par porte ----------------------------------


def test_en_rootless_DEUX_entrees_root_d_abord_chacune_avec_sa_commande():
    entrees = briefing.entrees_ssh(_modele("rootless"), "ops@forge.test:2222")
    assert [e["user"] for e in entrees] == ["root", bootstrap.COMPTE_ROOTLESS]
    assert [e["command"] for e in entrees] == [
        "ssh -J ops@forge.test:2222 root@10.77.0.31",
        "ssh -J ops@forge.test:2222 spark-docker@10.77.0.31",
    ]
    # Chaque porte DIT à quoi elle sert (SPK-DS-21) : le rôle et le détail sont
    # ceux de `comptes_du_spark`, pas une seconde rédaction.
    attendus = briefing.comptes_du_spark(_modele("rootless"))
    assert [(e["role"], e["detail"]) for e in entrees] == [
        (p["role"], p["detail"]) for p in attendus]


def test_enracine_jamais_amorce_ou_sans_docker_UNE_seule_entree():
    """§42.2 bis : le second compte n'est offert que parce que le relevé le dit,
    jamais parce qu'un compte pourrait exister."""
    for modele in (_modele("enracine"), _modele("jamais"), _modele(None),
                   _modele("rootless", docker_enabled=0)):
        entrees = briefing.entrees_ssh(modele, None, direct=True)
        assert [e["user"] for e in entrees] == ["root"]
        assert entrees[0]["command"] == "ssh root@10.77.0.31"


def test_sans_rebond_ni_acces_direct_les_portes_restent_SANS_commande():
    """§44.9.2 : on ne fabrique pas une commande qui échouerait. Les portes, elles,
    restent dites : la console nomme ce qui manque au lieu d'un bloc muet."""
    entrees = briefing.entrees_ssh(_modele("rootless"), None)
    assert [e["user"] for e in entrees] == ["root", bootstrap.COMPTE_ROOTLESS]
    assert all(e["command"] is None for e in entrees)

    sans_adresse = briefing.entrees_ssh(_modele("rootless", adresse=None),
                                        "forge.test")
    assert all(e["command"] is None for e in sans_adresse)


def test_une_cible_de_rebond_piegee_ne_compose_AUCUNE_commande():
    for piege in ("forge.test; rm -rf /", "$(id)", "a b",
                  "-oProxyCommand=touch /tmp/x"):
        entrees = briefing.entrees_ssh(_modele("rootless"), piege)
        assert all(e["command"] is None for e in entrees), piege


# --- La route : la même chose que le dossier, hors du modèle ----------------


def test_la_route_rend_ssh_commands_et_le_dossier_dit_les_MEMES_lignes(tmp_path):
    client = _client(tmp_path)
    nom = _creer(client, "avec")
    assert client.post(f"/v1/sparks/{nom}/bootstrap",
                       json={"rootless": True}).status_code == 200

    corps = client.get(f"/v1/sparks/{nom}/briefing",
                       params={"jump": "ops@forge.test:2222"}).json()
    adresse = client.get(f"/v1/sparks/{nom}").json()["ipv4_address"]
    commandes = corps["ssh_commands"]
    assert [c["command"] for c in commandes] == [
        f"ssh -J ops@forge.test:2222 root@{adresse}",
        f"ssh -J ops@forge.test:2222 spark-docker@{adresse}",
    ]
    # §44.8 : deux présentations d'un même calcul. Chaque ligne affichée est une
    # ligne du dossier, au caractère près.
    for commande in commandes:
        assert f"```sh\n{commande['command']}\n```" in corps["markdown"]
    # §44.9.8 : le rebond n'appartient pas au plan de contrôle ; il n'entre donc
    # pas dans le modèle, qui est aussi posé dans la cellule.
    assert "ssh_commands" not in corps["model"]
    assert all("command" not in p for p in corps["model"]["access"]["accounts"])


def test_la_route_suit_le_releve_d_amorcage(tmp_path):
    """« En fonction de la config d'amorçage » : jamais amorcé ou enraciné, root
    seul ; amorcé en rootless, les deux portes."""
    client = _client(tmp_path)
    jamais = _creer(client, "jamais")
    enracine = _creer(client, "enracine")
    assert client.post(f"/v1/sparks/{enracine}/bootstrap").status_code == 200
    rootless = _creer(client, "rootless")
    assert client.post(f"/v1/sparks/{rootless}/bootstrap",
                       json={"rootless": True}).status_code == 200

    def comptes(nom):
        return client.get(f"/v1/sparks/{nom}/briefing",
                          params={"direct": "true"}).json()["ssh_commands"]

    assert [c["user"] for c in comptes(jamais)] == ["root"]
    assert [c["user"] for c in comptes(enracine)] == ["root"]
    deux = comptes(rootless)
    assert [c["user"] for c in deux] == ["root", bootstrap.COMPTE_ROOTLESS]
    assert deux[1]["command"].startswith("ssh spark-docker@")


def test_sans_rebond_la_route_rend_les_portes_sans_commande(tmp_path):
    client = _client(tmp_path)
    nom = _creer(client, "seul")
    corps = client.get(f"/v1/sparks/{nom}/briefing").json()
    assert [c["user"] for c in corps["ssh_commands"]] == ["root"]
    assert corps["ssh_commands"][0]["command"] is None
