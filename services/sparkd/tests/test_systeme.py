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
