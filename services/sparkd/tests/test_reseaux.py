"""@verifies docs/BACKLOG.md#SPK-110 · docs/DAT.md §58.2 (sous-réseau et adresses
           attribués par le registre, nom DNS, unicité par la base, cascade),
           §58.3 (un réseau géré sans NAT, un device par adhésion sans isolation
           de port), §58.4 (les gestes et leurs refus : protégé, habité, déjà
           membre, épuisement), §58.6 (ce que le produit pose dans la cellule),
           §58.8 · §14.2, §35.2 · docs/PROD_MIGRATIONS.md#OP-23

Le pilote est le doublon : il retient les réseaux créés et les devices posés,
là où le vrai Incus les garde, et simule l'identité d'une cellule d'après son
image — c'est ce qui permet d'éprouver la famille sans networkd.
"""

from __future__ import annotations

import sqlite3
import tempfile

from fastapi.testclient import TestClient

from sparkd import reseaux
from sparkd.app import create_app
from sparkd.config import load

GIO = 1024**3


def client() -> tuple[TestClient, str]:
    base = tempfile.mkdtemp() + "/spark.db"
    return TestClient(create_app(load({"SPARKD_DB": base, "SPARKD_DRIVER": "fake"}))), base


def creer(c: TestClient, nom: str, *, image: str = "images:debian/13",
          appliquer: bool = True) -> None:
    reponse = c.post("/v1/sparks", json={
        "name": nom, "image": image, "cpu_mode": "shared",
        "cpu_reservation": 0.25, "memory_bytes": GIO, "storage_bytes": 10 * GIO,
        "network_bps": 100_000_000})
    assert reponse.status_code == 201, reponse.text
    if appliquer:
        assert c.post(f"/v1/sparks/{nom}/apply").status_code == 200
        assert c.post(f"/v1/sparks/{nom}/start").status_code == 200


def pret() -> tuple[TestClient, str]:
    c, base = client()
    assert c.post("/v1/forge/sync").status_code == 200
    return c, base


def test_un_reseau_prive_est_cree_sur_le_premier_sous_reseau_libre_sans_nat():
    c, _ = pret()
    r = c.post("/v1/networks", json={"name": "backoffice", "note": "base et cache"})
    assert r.status_code == 201, r.text
    reseau = r.json()
    assert reseau["cidr"] == "10.78.1.0/24"
    assert reseau["interface"] == "spn1" and reseau["gateway"] == "10.78.1.1"
    assert reseau["applied_at"] and reseau["members"] == []
    pose = c.app.state.incus.networks["spn1"]["config"]
    assert pose["ipv4.nat"] == "false" and pose["ipv6.address"] == "none"
    assert pose["dns.domain"] == "backoffice"
    assert pose["ipv4.address"] == "10.78.1.1/24"
    assert pose["ipv4.dhcp.ranges"] == "10.78.1.240-10.78.1.254"
    second = c.post("/v1/networks", json={"name": "frontal"}).json()
    assert second["cidr"] == "10.78.2.0/24" and second["interface"] == "spn2"
    catalogue = c.get("/v1/networks").json()
    assert [n["name"] for n in catalogue["networks"]] == ["backoffice", "frontal"]
    assert catalogue["pool"] == {"cidr": "10.78.0.0/16", "capacity": 255, "used": 2, "free": 253}


def test_un_nom_qui_n_est_pas_un_nom_dns_et_un_doublon_sont_refuses_en_nommant():
    c, _ = pret()
    for faux in ("Back Office", "1abc", "", "a" * 32, "réseau"):
        r = c.post("/v1/networks", json={"name": faux})
        assert r.status_code == 409, faux
        assert "nom DNS" in r.json()["detail"]["message"]
    assert c.post("/v1/networks", json={"name": "backoffice"}).status_code == 201
    doublon = c.post("/v1/networks", json={"name": "backoffice"})
    assert doublon.status_code == 409 and "existe déjà" in doublon.json()["detail"]["message"]


def test_attacher_pose_le_device_l_adresse_et_configure_la_cellule():
    """§58.3 : sans isolation de port — c'est le point du réseau —, avec
    l'anti-usurpation ; §58.6 : le drop-in networkd et le rechargement."""
    c, _ = pret()
    creer(c, "web")
    creer(c, "db")
    c.post("/v1/networks", json={"name": "backoffice"})
    a = c.post("/v1/networks/backoffice/members", json={"spark": "web"})
    assert a.status_code == 201, a.text
    assert a.json()["ipv4_address"] == "10.78.1.16"
    b = c.post("/v1/networks/backoffice/members", json={"spark": "db"}).json()
    assert b["ipv4_address"] == "10.78.1.17"
    assert a.json()["applied_at"] and a.json()["cell_configured"] is True
    incus = c.app.state.incus
    device = incus.created["web"]["devices"]["spn1"]
    assert device == {"type": "nic", "network": "spn1", "name": "spn1",
                      "ipv4.address": "10.78.1.16", "security.ipv4_filtering": "true"}
    assert "security.port_isolation" not in device
    assert reseaux.DROPIN_NETWORKD == incus.created["web"]["files"][reseaux.FICHIER_NETWORKD]
    assert "UseGateway=no" in reseaux.DROPIN_NETWORKD and "UseRoutes=no" in reseaux.DROPIN_NETWORKD
    assert any("networkctl reconfigure spn1" in " ".join(cmd)
               for cmd in incus.created["web"]["commands"])
    dossier = c.get("/v1/sparks/web/networks").json()["memberships"]
    assert dossier[0]["network"] == "backoffice" and dossier[0]["interface"] == "spn1"
    membres = c.get("/v1/networks/backoffice").json()["members"]
    assert [m["spark"] for m in membres] == ["db", "web"]
    entrees = [e for e in c.get("/v1/audit?limit=50").json()["entries"]
               if e["action"] == "network.attach"]
    assert len(entrees) == 2 and all(e["result"] == "ok" for e in entrees)


def test_une_famille_sans_networkd_recoit_le_device_et_une_adhesion_qui_le_DIT():
    """§58.6 : première version, familles à networkd. Ailleurs, l'adresse est
    réservée, le device posé, et l'écart nommé — jamais tu."""
    c, _ = pret()
    creer(c, "alpine", image="images:alpine/3.21")
    c.post("/v1/networks", json={"name": "backoffice"})
    a = c.post("/v1/networks/backoffice/members", json={"spark": "alpine"}).json()
    assert a["applied_at"] and a["cell_configured"] is False
    assert "networkd" in a["cell_note"]
    assert "spn1" in c.app.state.incus.created["alpine"]["devices"]
    assert reseaux.FICHIER_NETWORKD not in c.app.state.incus.created["alpine"].get("files", {})


def test_un_spark_protege_refuse_l_attachement_et_le_detachement_en_423():
    c, _ = pret()
    creer(c, "garde")
    c.post("/v1/networks", json={"name": "backoffice"})
    assert c.post("/v1/sparks/garde/protection", json={"password": "mot"}).status_code == 200
    assert c.post("/v1/networks/backoffice/members", json={"spark": "garde"}).status_code == 423
    assert c.get("/v1/networks/backoffice").json()["members"] == []


def test_deja_membre_et_spark_inconnu_sont_refuses():
    c, _ = pret()
    creer(c, "web")
    c.post("/v1/networks", json={"name": "backoffice"})
    assert c.post("/v1/networks/backoffice/members", json={"spark": "web"}).status_code == 201
    encore = c.post("/v1/networks/backoffice/members", json={"spark": "web"})
    assert encore.status_code == 409 and "déjà membre" in encore.json()["detail"]["message"]
    assert c.post("/v1/networks/backoffice/members", json={"spark": "personne"}).status_code == 404
    assert c.post("/v1/networks/inconnu/members", json={"spark": "web"}).status_code == 404


def test_detacher_retire_le_device_et_supprimer_un_reseau_habite_est_refuse_en_nommant():
    c, _ = pret()
    creer(c, "web")
    creer(c, "db")
    c.post("/v1/networks", json={"name": "backoffice"})
    c.post("/v1/networks/backoffice/members", json={"spark": "web"})
    c.post("/v1/networks/backoffice/members", json={"spark": "db"})
    refus = c.delete("/v1/networks/backoffice")
    assert refus.status_code == 409
    assert "db, web" in refus.json()["detail"]["message"]
    # Le refus est un fait du journal, nommé (§21.1) — et rien n'a été supprimé.
    refuses = [e for e in c.get("/v1/audit?limit=50").json()["entries"]
               if e["action"] == "network.delete" and e["result"] == "denied"]
    assert len(refuses) == 1 and "db, web" in refuses[0]["message"]
    assert c.get("/v1/networks/backoffice").status_code == 200
    assert c.delete("/v1/networks/backoffice/members/web").status_code == 200
    assert "spn1" not in c.app.state.incus.created["web"]["devices"]
    assert c.delete("/v1/networks/backoffice/members/db").status_code == 200
    assert c.delete("/v1/networks/backoffice").status_code == 200
    assert "spn1" not in c.app.state.incus.networks
    assert c.get("/v1/networks/backoffice").status_code == 404
    actions = [e["action"] for e in c.get("/v1/audit?limit=50").json()["entries"]]
    assert "network.delete" in actions and "network.detach" in actions


def test_le_pool_epuise_est_un_refus_nomme():
    """§15.3 transposé : un /23 ne porte qu'UN sous-réseau attribuable."""
    c, base = pret()
    with sqlite3.connect(base) as connection:
        connection.execute("UPDATE forge SET private_pool_cidr = '10.78.0.0/23'")
    assert c.post("/v1/networks", json={"name": "un"}).status_code == 201
    refus = c.post("/v1/networks", json={"name": "deux"})
    assert refus.status_code == 409
    assert refus.json()["detail"]["error"] == "pool_exhausted"
    assert "10.78.0.0/23" in refus.json()["detail"]["message"]
    assert c.get("/v1/forge").json()["private_networks"] == {
        "cidr": "10.78.0.0/23", "capacity": 1, "used": 1, "free": 0}


def test_une_adhesion_declaree_avant_la_cellule_se_pose_a_l_application():
    """§14.2 : on déclare avant de créer, et l'écart se voit par `applied_at`."""
    c, _ = pret()
    creer(c, "futur", appliquer=False)
    c.post("/v1/networks", json={"name": "backoffice"})
    a = c.post("/v1/networks/backoffice/members", json={"spark": "futur"}).json()
    assert a["applied_at"] is None and a["ipv4_address"] == "10.78.1.16"
    assert c.post("/v1/sparks/futur/apply").status_code == 200
    membre = c.get("/v1/networks/backoffice").json()["members"][0]
    assert membre["applied_at"] and membre["cell_configured"] is True
    assert c.app.state.incus.created["futur"]["devices"]["spn1"]["ipv4.address"] == "10.78.1.16"


def test_supprimer_un_spark_emporte_ses_adhesions():
    c, _ = pret()
    creer(c, "web")
    c.post("/v1/networks", json={"name": "backoffice"})
    c.post("/v1/networks/backoffice/members", json={"spark": "web"})
    assert c.post("/v1/sparks/web/stop").status_code == 200
    assert c.post("/v1/sparks/web/delete").json() == {"deleted": "web"}
    assert c.get("/v1/networks/backoffice").json()["members"] == []
    assert c.delete("/v1/networks/backoffice").status_code == 200


def test_un_pilote_qui_refuse_le_bridge_ne_laisse_pas_de_ligne():
    c, _ = pret()
    c.app.state.incus.fail_next["create_network"] = "socket fermée"
    refus = c.post("/v1/networks", json={"name": "backoffice"})
    assert refus.status_code == 409 and "socket fermée" in refus.json()["detail"]["message"]
    assert c.get("/v1/networks").json()["networks"] == []
    assert c.post("/v1/networks", json={"name": "backoffice"}).status_code == 201


def test_une_cellule_arretee_recoit_le_fichier_sans_rechargement_et_l_adhesion_le_DIT():
    """§58.6 : rien ne s'exécute dans une cellule arrêtée. Sa famille se lit dans
    /etc/os-release, le drop-in est posé, networkd le prendra au démarrage — et
    l'adhésion le dit, comme une précision, pas comme un défaut."""
    c, _ = pret()
    creer(c, "dormante")
    assert c.post("/v1/sparks/dormante/stop").status_code == 200, \
        "la cellule doit être arrêtée par le produit"
    assert c.app.state.incus.created["dormante"]["status"] == "Stopped"
    c.post("/v1/networks", json={"name": "backoffice"})
    a = c.post("/v1/networks/backoffice/members", json={"spark": "dormante"}).json()
    assert a["applied_at"] and a["cell_configured"] is True
    assert a["cell_note"] == "cellule arrêtée : configuration posée, prise au démarrage"
    cellule = c.app.state.incus.created["dormante"]
    # Le doublon rend, comme Incus, la CIBLE du lien pour /etc/os-release : la
    # famille n'a pu être lue qu'en suivant la spécification jusqu'à /usr/lib.
    incus = c.app.state.incus
    assert incus.pull_file("dormante", "/etc/os-release") == "../usr/lib/os-release"
    assert "ID=debian" in incus.pull_file("dormante", "/usr/lib/os-release")
    assert cellule["files"][reseaux.FICHIER_NETWORKD] == reseaux.DROPIN_NETWORKD
    assert not any("networkctl" in " ".join(cmd) for cmd in cellule.get("commands", [])), \
        "rien ne s'exécute dans une cellule arrêtée"


def test_une_cellule_arretee_sans_networkd_le_DIT_aussi():
    c, _ = pret()
    creer(c, "alpine-dormante", image="images:alpine/3.21")
    assert c.post("/v1/sparks/alpine-dormante/stop").status_code == 200
    c.post("/v1/networks", json={"name": "backoffice"})
    a = c.post("/v1/networks/backoffice/members", json={"spark": "alpine-dormante"}).json()
    assert a["applied_at"] and a["cell_configured"] is False
    assert "famille sans networkd (alpine)" in a["cell_note"]
    assert reseaux.FICHIER_NETWORKD not in c.app.state.incus.created["alpine-dormante"].get("files", {})
