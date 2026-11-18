"""Preuves du relevé des mises à jour du système de la Forge.

@verifies docs/BACKLOG.md#SPK-171 · docs/DAT.md §70.5 (chaque champ, sa source,
          et ce que son absence veut dire ; le relevé de démonstration) ·
          docs/BACKLOG.md#SPK-176 · docs/DAT.md §70.6 (les pools à mettre à
          niveau, les fonctionnalités `(*)` à part)

Les sorties sont celles relevées sur `spark-010` le 2026-11-18 quand elles
existent, et la forme documentée d'`apt` pour les paquets en attente (la Forge
n'en avait aucun ce jour-là).
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from sparkd import systeme
from sparkd.app import create_app
from sparkd.config import load
from sparkd.systeme import Lecteur

#: Relevé RÉEL de `zpool upgrade` sur `spark-010`, le 2026-11-18.
ZPOOL_UPGRADE_REEL = """\
This system supports ZFS pool feature flags.

All pools are formatted using feature flags.


Some supported features are not enabled on the following pools. Once a
feature is enabled the pool may become incompatible with software
that does not support the feature. See zpool-features(7) for details.

Note that the pool 'compatibility' feature can be used to inhibit
feature upgrades.

Features marked with (*) are not applied automatically on upgrade, and
must be applied explicitly with zpool-set(7).

POOL  FEATURE
---------------
spark
      redaction_list_spill
      raidz_expansion
      fast_dedup
      longname
      large_microzap
      dynamic_gang_header(*)
      block_cloning_endian
      physical_rewrite
"""

ZPOOL_A_JOUR = """\
This system supports ZFS pool feature flags.

All pools are formatted using feature flags.

Every feature flags pool has all supported and requested features enabled.
"""

APT_LISTE = """\
Listing...
openssl/resolute-security 3.5.2-1ubuntu1.1 amd64 [upgradable from: 3.5.2-1ubuntu1]
incus/resolute 1:7.7-ubuntu26.04 amd64 [upgradable from: 1:7.6-ubuntu26.04]
libssl3t64/resolute-updates,resolute-security 3.5.2-1ubuntu1.1 amd64 [upgradable from: 3.5.2-1ubuntu1]
"""

OS_RELEASE = 'PRETTY_NAME="Ubuntu 26.04.1 LTS"\nNAME="Ubuntu"\nVERSION_CODENAME=resolute\n'


def lecteur(*, commandes=None, fichiers=None, dates=None, presents=()) -> Lecteur:
    commandes = commandes or {}
    fichiers = fichiers or {}
    dates = dates or {}
    return Lecteur(
        executer=lambda c: commandes.get(" ".join(c)),
        lire=lambda p: fichiers.get(p),
        date_de=lambda p: dates.get(p),
        presence=lambda p: p in presents or p in fichiers,
    )


def test_les_pools_a_mettre_a_niveau_sont_lus_et_les_fonctionnalites_manuelles_mises_a_part():
    pools = systeme.pools_a_niveau(ZPOOL_UPGRADE_REEL)
    assert [p["pool"] for p in pools] == ["spark"]
    assert len(pools[0]["fonctionnalites"]) == 7
    assert "physical_rewrite" in pools[0]["fonctionnalites"]
    assert pools[0]["manuelles"] == ["dynamic_gang_header"]
    assert systeme.pools_a_niveau(ZPOOL_A_JOUR) == []


def test_les_paquets_en_attente_sont_lus_et_la_securite_passe_devant():
    paquets = systeme.paquets_en_attente(APT_LISTE)
    assert [p["nom"] for p in paquets] == ["libssl3t64", "openssl", "incus"]
    assert paquets[0]["securite"] and paquets[1]["securite"] and not paquets[2]["securite"]
    assert paquets[2]["installee"] == "1:7.6-ubuntu26.04"
    assert paquets[2]["proposee"] == "1:7.7-ubuntu26.04"


def test_apt_check_fait_foi_pour_les_comptes_quand_il_existe():
    """`apt-check` compte aussi ce qu'`apt list` ne qualifie pas de sécurité."""
    vu = systeme.releve(lecteur(
        commandes={"apt list --upgradable": (0, APT_LISTE, ""),
                   systeme.APT_CHECK: (0, "", "3;2"), "uname -r": (0, "7.0.0-43-generic\n", ""),
                   "zpool upgrade": (0, ZPOOL_A_JOUR, "")},
        fichiers={"/etc/os-release": OS_RELEASE}, presents={systeme.APT_CHECK}))
    assert vu["source"] == "hote"
    assert vu["os"] == "Ubuntu 26.04.1 LTS" and vu["noyau"] == "7.0.0-43-generic"
    assert vu["mises_a_jour"]["total"] == 3 and vu["mises_a_jour"]["securite"] == 2


def test_sans_apt_check_la_securite_se_compte_dans_la_liste():
    vu = systeme.releve(lecteur(commandes={"apt list --upgradable": (0, APT_LISTE, "")}))
    assert vu["mises_a_jour"]["total"] == 3 and vu["mises_a_jour"]["securite"] == 2


def test_une_forge_a_jour_le_dit_sans_inventer_de_date():
    """Le relevé RÉEL de `spark-010` : `apt-check` rend « 0;0 », pas de
    redémarrage requis, le fichier de version existe et il est vide."""
    vu = systeme.releve(lecteur(
        commandes={"apt list --upgradable": (0, "Listing...\n", ""),
                   systeme.APT_CHECK: (0, "", "0;0"), "zpool upgrade": (0, ZPOOL_UPGRADE_REEL, "")},
        fichiers={systeme.FICHIER_VERSION: ""}, presents={systeme.APT_CHECK}))
    assert vu["mises_a_jour"] == {"total": 0, "securite": 0, "paquets": [],
                                  "paquets_rendus": 0, "liste_relue_a": None}
    assert vu["redemarrage"] == {"requis": False, "paquets": []}
    assert vu["version"] == {"connue": True, "disponible": None}
    assert vu["zfs"]["a_niveau"][0]["pool"] == "spark"


def test_un_redemarrage_requis_et_une_version_disponible_sont_lus():
    vu = systeme.releve(lecteur(
        fichiers={systeme.FICHIER_REDEMARRAGE: "*** System restart required ***\n",
                  systeme.FICHIER_REDEMARRAGE_PAQUETS: "linux-image-7.0.0-44-generic\nlinux-base\nlinux-base\n",
                  systeme.FICHIER_VERSION: "\nNew release '26.10' available.\nRun 'do-release-upgrade' to upgrade to it.\n"},
        dates={"/var/lib/apt/lists": 1_763_451_240.0}))
    assert vu["redemarrage"] == {"requis": True,
                                 "paquets": ["linux-base", "linux-image-7.0.0-44-generic"]}
    assert vu["version"] == {"connue": True, "disponible": "26.10"}
    assert vu["mises_a_jour"]["liste_relue_a"].startswith("2025-11-18")


def test_une_source_absente_est_NOMMEE_jamais_inventee():
    """Rien de lisible : aucune valeur fabriquée (DESIGN_SYSTEM.md §14.6)."""
    vu = systeme.releve(lecteur())
    assert vu["os"] is None and vu["noyau"] is None
    assert vu["version"] == {"connue": False, "disponible": None}
    assert vu["mises_a_jour"]["liste_relue_a"] is None
    assert vu["zfs"] == {"a_niveau": []}


def test_la_liste_est_plafonnee_et_le_nombre_reel_reste_dit():
    ligne = "p{0}/resolute 2 amd64 [upgradable from: 1]\n"
    sortie = "Listing...\n" + "".join(ligne.format(i) for i in range(250))
    vu = systeme.releve(lecteur(commandes={"apt list --upgradable": (0, sortie, "")}))
    assert vu["mises_a_jour"]["total"] == 250
    assert len(vu["mises_a_jour"]["paquets"]) == systeme.PAQUETS_MAX == 200


def test_l_API_rend_le_releve_de_DEMONSTRATION_sous_le_pilote_factice(tmp_path):
    client = TestClient(create_app(load({"SPARKD_DB": str(tmp_path / "a.db"),
                                         "SPARKD_DRIVER": "fake"})))
    r = client.get("/v1/forge/systeme")
    assert r.status_code == 200
    corps = r.json()
    assert corps["source"] == "fake", "un relevé de démonstration se dit"
    assert corps["mises_a_jour"]["total"] == 3 and corps["redemarrage"]["requis"] is True
    assert corps["version"]["disponible"] == "26.10"
    assert corps["zfs"]["a_niveau"][0]["pool"] == "spark"


def test_l_API_ne_journalise_rien_et_n_ecrit_rien(tmp_path):
    """Une lecture : aucune ligne d'audit (§31.3)."""
    client = TestClient(create_app(load({"SPARKD_DB": str(tmp_path / "a.db"),
                                         "SPARKD_DRIVER": "fake"})))
    avant = client.get("/v1/audit").json()
    client.get("/v1/forge/systeme")
    assert client.get("/v1/audit").json() == avant


# --- SPK-181 · §73 : appliquer les mises à jour choisies -----------------------
#
# @verifies docs/BACKLOG.md#SPK-181 · docs/DAT.md §73.2 (422 hors liste, 409
#           occupé ou verrouillé, travail en arrière-plan, audit de la demande et
#           de l'issue, jamais de redémarrage)

import time  # noqa: E402

import pytest  # noqa: E402

from sparkd.systeme import Application, RefusApplication  # noqa: E402

EN_ATTENTE = {"openssl", "incus", "linux-image-generic"}


def test_seuls_des_paquets_EN_ATTENTE_se_mettent_a_jour():
    assert systeme.valider(["openssl", "incus", "openssl"], EN_ATTENTE) == ["openssl", "incus"]
    for demande, motif in ((["nginx"], "n'est pas une mise à jour en attente"),
                           (["-o", "openssl"], "invalide"), (["openssl=1.0"], "invalide"),
                           (["openssl; reboot"], "invalide"), ([], "Aucun paquet"),
                           ("openssl", "Aucun paquet"), (["x"] * 501, "Au plus")):
        with pytest.raises(RefusApplication) as refus:
            systeme.valider(demande, EN_ATTENTE | {"x"})
        assert refus.value.code == 422 and motif in str(refus.value), demande


def test_la_commande_met_a_jour_et_garde_la_configuration_locale():
    assert systeme.commande_application(["openssl"]) == [
        "apt-get", "install", "-y", "--only-upgrade",
        "-o", "Dpkg::Options::=--force-confold", "openssl"]


def test_une_application_reussie_puis_une_en_echec_disent_leur_issue_bornee():
    fins = []
    app = Application(executer=lambda c: (0, "ok\n" * 100), verrouille=lambda: False,
                      fin=fins.append, en_arriere_plan=False)
    assert app.etat() == {"etat": "aucune"}
    etat = app.lancer(["openssl"])
    assert etat["etat"] == "terminee" and etat["code"] == 0
    assert len(etat["sortie"].splitlines()) == systeme.LIGNES_GARDEES
    rate = Application(executer=lambda c: (100, "E: Sub-process /usr/bin/dpkg returned an error code (1)"),
                       verrouille=lambda: False, fin=fins.append, en_arriere_plan=False)
    assert rate.lancer(["incus"])["etat"] == "echec"
    assert [f["etat"] for f in fins] == ["terminee", "echec"]


def test_une_seule_application_a_la_fois_et_jamais_sur_dpkg_verrouille():
    lent = Application(executer=lambda c: (time.sleep(0.3), (0, ""))[1], verrouille=lambda: False)
    lent.lancer(["openssl"])
    with pytest.raises(RefusApplication) as occupe:
        lent.lancer(["incus"])
    assert occupe.value.code == 409
    verrouille = Application(executer=lambda c: (0, ""), verrouille=lambda: True)
    inscrit = []
    with pytest.raises(RefusApplication) as refus:
        verrouille.lancer(["openssl"], avant=lambda: inscrit.append(1))
    assert refus.value.code == 409 and "lock-frontend" in str(refus.value)
    assert inscrit == [], "un geste refusé ne s'inscrit pas comme demandé"


def _client(tmp_path):
    return TestClient(create_app(load({"SPARKD_DB": str(tmp_path / "a.db"),
                                       "SPARKD_DRIVER": "fake"})))


def _attendre_fin(client):
    for _ in range(50):
        etat = client.get("/v1/forge/systeme/appliquer").json()
        if etat["etat"] != "en_cours":
            return etat
        time.sleep(0.05)
    raise AssertionError("l'application ne se termine pas")


def test_l_API_applique_retire_du_releve_et_journalise_demande_puis_issue(tmp_path):
    client = _client(tmp_path)
    assert client.get("/v1/forge/systeme/appliquer").json()["etat"] == "aucune"
    r = client.post("/v1/forge/systeme/appliquer", json={"paquets": ["openssl"]})
    assert r.status_code == 202 and r.json()["source"] == "fake"
    assert _attendre_fin(client)["etat"] == "terminee"
    noms = [p["nom"] for p in client.get("/v1/forge/systeme").json()["mises_a_jour"]["paquets"]]
    assert "openssl" not in noms and "incus" in noms
    lignes = [e for e in client.get("/v1/audit").json()["entries"] if e["action"] == "system.upgrade"]
    assert len(lignes) == 2, lignes
    assert any("demandées" in e["message"] for e in lignes)
    assert any("appliquées" in e["message"] for e in lignes)


def test_l_API_refuse_un_paquet_hors_liste_sans_rien_journaliser(tmp_path):
    client = _client(tmp_path)
    r = client.post("/v1/forge/systeme/appliquer", json={"paquets": ["nginx"]})
    assert r.status_code == 422 and r.json()["detail"]["error"] == "refused"
    assert not [e for e in client.get("/v1/audit").json()["entries"] if e["action"] == "system.upgrade"]
    assert client.post("/v1/forge/systeme/appliquer", json={}).status_code == 422
