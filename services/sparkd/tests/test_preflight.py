"""@verifies docs/BACKLOG.md#SPK-26 · docs/DAT.md §31, §31.2 (mesurer, nommer,
           remédier), §31.3 (lecture seule), §31.4 · §3.1, §11, §16

Les relevés sont INJECTÉS : ces preuves n'ont besoin d'aucun serveur. Ceux du
`ss` viennent de la Forge cible, relevés le 2026-08-19 — c'est ce relevé qui a
montré que le contrôle de surface réseau était faux.
"""

from __future__ import annotations

import pytest

from sparkd import preflight
from sparkd.preflight import ECHEC, INCONNU, OK, Hote, Verdict

GIO = 1024**3

#: Relevé RÉEL de `ss -lntH` sur la Forge cible. `dnsmasq` écoute sur le bridge
#: privé et `systemd-resolved` sur des adresses de boucle locale que la première
#: version du contrôle ne reconnaissait pas.
SS_HOTE_REEL = """\
LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*
LISTEN 0 2048 127.0.0.1:9876 0.0.0.0:*
LISTEN 0 4096 127.0.0.1:2019 0.0.0.0:*
LISTEN 0 4096 *:443 *:*
LISTEN 0 4096 *:80 *:*
LISTEN 0 32 10.77.0.1:53 0.0.0.0:*
LISTEN 0 4096 127.0.0.54:53 0.0.0.0:*
LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*
LISTEN 0 4096 [::]:22 [::]:*
"""


def hote(commandes: dict[str, str | None] = None, fichiers: dict[str, str] = None,
         binaires: set[str] = None) -> Hote:
    commandes = commandes or {}
    fichiers = fichiers or {}
    binaires = binaires if binaires is not None else {"caddy"}
    return Hote(
        executer=lambda c: commandes.get(" ".join(c)),
        lire=lambda p: fichiers.get(p),
        presence=lambda b: b in binaires,
    )


# --- la surface réseau, et le défaut qu'un relevé réel a révélé --------------


def test_le_bridge_prive_et_la_boucle_locale_ne_sont_PAS_exposes():
    """Le contrôle dénonçait le port 53 de dnsmasq, lié au bridge privé.

    Le côté privé du bridge est ce que les Sparks doivent joindre pour leur DNS.
    Le tenir pour exposé rendait un verdict rouge sur un serveur correct.
    """
    verdict = preflight.surface_reseau(hote({"ss -lntH": SS_HOTE_REEL}))
    assert verdict.etat == OK, verdict.releve
    assert "22" in verdict.releve and "80" in verdict.releve and "443" in verdict.releve
    assert "53" not in verdict.releve
    assert "9876" not in verdict.releve, "sparkd est sur la boucle locale, pas exposé"


@pytest.mark.parametrize("adresse,portee", [
    ("127.0.0.1:9876", "locale"),
    ("127.0.0.53%lo:53", "locale"),
    ("127.0.0.54:53", "locale"),
    ("[::1]:9876", "locale"),
    ("10.77.0.1:53", "privee"),
    ("192.168.1.4:8080", "privee"),
    ("172.17.0.1:53", "privee"),
    ("172.32.0.1:53", "exposee"),
    ("0.0.0.0:22", "exposee"),
    ("*:443", "exposee"),
    ("[::]:22", "exposee"),
    ("51.158.54.202:9876", "exposee"),
])
def test_la_portee_d_une_adresse_d_ecoute(adresse, portee):
    assert preflight._portee(adresse) == portee


def test_une_api_d_administration_joignable_du_reseau_est_un_echec():
    """docs/DAT.md §11 — c'est la propriété de sécurité du produit."""
    fautif = SS_HOTE_REEL.replace("127.0.0.1:9876", "0.0.0.0:9876")
    verdict = preflight.surface_reseau(hote({"ss -lntH": fautif}))
    assert verdict.etat == ECHEC
    assert "9876" in verdict.releve
    assert verdict.remede


def test_sans_ss_le_verdict_est_INCONNU_et_non_un_echec():
    """§31.2 — ne pas avoir mesuré n'est pas avoir mesuré une valeur fautive."""
    verdict = preflight.surface_reseau(hote({}))
    assert verdict.etat == INCONNU
    assert not verdict.bloquant


# --- Incus (docs/DAT.md §3.1) ------------------------------------------------


def test_incus_trop_ancien_est_bloquant_et_nomme_la_cause():
    verdict = preflight.incus_assez_recent(hote({"incus --version": "6.0.0"}))
    assert verdict.etat == ECHEC
    assert "6.0.0" in verdict.releve
    assert "CVE-2025-52881" in verdict.remede


def test_incus_conforme():
    verdict = preflight.incus_assez_recent(hote({"incus --version": "7.3"}))
    assert verdict.etat == OK and verdict.releve == "7.3"


def test_incus_absent_est_INCONNU_avec_son_remede():
    verdict = preflight.incus_assez_recent(hote({}))
    assert verdict.etat == INCONNU
    assert "Zabbly" in verdict.remede


# --- ARC (docs/DAT.md §16) ---------------------------------------------------


def test_arc_plafonne_correctement():
    verdict = preflight.arc_plafonne(
        hote(fichiers={"/sys/module/zfs/parameters/zfs_arc_max": str(16 * GIO)}))
    assert verdict.etat == OK and "16.0 Gio" in verdict.releve


def test_arc_a_zero_est_un_echec_car_zfs_prend_la_moitie_de_la_ram():
    verdict = preflight.arc_plafonne(
        hote(fichiers={"/sys/module/zfs/parameters/zfs_arc_max": "0"}))
    assert verdict.etat == ECHEC
    assert "moitié de la RAM" in verdict.releve


def test_arc_trop_haut_est_un_echec():
    verdict = preflight.arc_plafonne(
        hote(fichiers={"/sys/module/zfs/parameters/zfs_arc_max": str(48 * GIO)}))
    assert verdict.etat == ECHEC and "48.0 Gio" in verdict.releve


def test_arc_illisible_est_INCONNU():
    assert preflight.arc_plafonne(hote()).etat == INCONNU


# --- stockage ----------------------------------------------------------------


def test_un_pool_sur_fichier_passe_et_dit_CE_QU_IL_NE_COUVRE_PAS():
    """RÉVISÉE le 2026-08-20 par SPK-28, arbitrage du responsable.

    La preuve exigeait le mot « provisoire » et un renvoi à SPK-28. Le §8.5 ne
    dit plus cela : il y a DEUX dispositions, pas une cible et un repli, et une
    dette qu'on ne compte pas rembourser n'est pas une dette.

    Ce que la preuve gardait vraiment est INCHANGÉ, et mieux dit : le verdict
    nomme ce que cette disposition N'APPORTE PAS. Le taire laisserait croire
    qu'un pool ZFS protège toujours de la corruption silencieuse, alors qu'ici le
    miroir est géré en dessous et que « md » ne sait pas laquelle des deux copies
    est la bonne.

    Et ce n'est PAS un remède : on ne répare pas une disposition qu'on a choisie.
    """
    montre = "driver: zfs\nconfig:\n  source: /var/lib/incus/disks/spark.img\n"
    verdict = preflight.pool_de_stockage(hote({"incus storage show spark": montre}))
    assert verdict.etat == OK
    assert "corruption silencieuse" in verdict.releve
    assert "NON couverte" in verdict.releve
    # Ce qui FONCTIONNE est dit aussi : sans cela, le relevé se lirait comme un
    # défaut, et c'est le même ZFS.
    assert "quotas" in verdict.releve
    assert verdict.remede == ""


def test_un_pool_NATIF_est_distingue_du_pool_sur_fichier():
    """§8.5 : deux dispositions, donc deux relevés qui ne se confondent pas."""
    montre = "driver: zfs\nconfig:\n  source: /dev/sda5\n"
    verdict = preflight.pool_de_stockage(hote({"incus storage show spark": montre}))
    assert verdict.etat == OK
    assert "disposition native" in verdict.releve
    assert "NON couverte" not in verdict.releve


def test_un_pool_absent_est_bloquant():
    verdict = preflight.pool_de_stockage(hote({}))
    assert verdict.etat == ECHEC and verdict.remede.startswith("incus storage create")


def test_un_pool_qui_n_est_pas_zfs_est_bloquant():
    verdict = preflight.pool_de_stockage(hote({"incus storage show spark": "driver: dir\n"}))
    assert verdict.etat == ECHEC and "dir" in verdict.releve


def test_compression_desactivee_est_bloquante():
    verdict = preflight.compression_active(
        hote({"zfs get -H -o value compression spark": "off"}))
    assert verdict.etat == ECHEC and "compression=on" in verdict.remede


# --- réseau privé ------------------------------------------------------------


def test_plage_dhcp_non_restreinte_est_bloquante():
    """Sinon dnsmasq peut distribuer une adresse que le registre a promise."""
    verdict = preflight.plage_dhcp_disjointe(hote({}))
    assert verdict.etat == ECHEC and "ipv4.dhcp.ranges" in verdict.remede


def test_bridge_present():
    verdict = preflight.bridge_prive(
        hote({"incus network get sparkbr0 ipv4.address": "10.77.0.1/24"}))
    assert verdict.etat == OK


# --- sparkd doit SURVIVRE à un redémarrage (§31.4) ---------------------------


def test_sparkd_lance_a_la_main_est_un_echec_meme_s_il_est_actif():
    """Le cœur du §31.4.

    `is-active` seul déclarerait conforme un sparkd lancé depuis une session
    ssh. Il disparaîtrait au premier redémarrage, les Sparks continueraient de
    tourner sans que rien ne les administre, et la panne ne se découvrirait qu'à
    la première opération.
    """
    verdict = preflight.sparkd_survit_au_redemarrage(hote({
        "systemctl is-active sparkd": "active",
        "systemctl is-enabled sparkd": None,
    }))
    assert verdict.etat == ECHEC
    assert "install-serveur.sh" in verdict.remede


def test_sparkd_active_au_demarrage_et_en_marche():
    verdict = preflight.sparkd_survit_au_redemarrage(hote({
        "systemctl is-active sparkd": "active",
        "systemctl is-enabled sparkd": "enabled",
    }))
    assert verdict.etat == OK


def test_sparkd_active_au_demarrage_mais_arrete_est_un_echec():
    verdict = preflight.sparkd_survit_au_redemarrage(hote({
        "systemctl is-active sparkd": "inactive",
        "systemctl is-enabled sparkd": "enabled",
    }))
    assert verdict.etat == ECHEC and verdict.remede == "systemctl start sparkd"


# --- la série entière --------------------------------------------------------


def test_chaque_controle_porte_un_code_stable_et_unique():
    """Le contrat de déploiement cite ces codes : ils ne doivent pas bouger."""
    verdicts = preflight.verifier(hote())
    codes = [v.code for v in verdicts]
    assert len(set(codes)) == len(codes), "deux contrôles partagent un code"
    assert set(codes) == {
        "INC-VERSION", "STO-POOL", "STO-COMPRESSION", "MEM-ARC",
        "NET-BRIDGE", "NET-DHCP", "ING-CADDY", "SEC-PORTS", "RUN-SPARKD",
        "RUN-SLICE",
    }


def test_tout_verdict_non_ok_porte_un_releve_lisible():
    """§31.2 — un verdict sans valeur relevée oblige à remesurer à la main."""
    for verdict in preflight.verifier(hote()):
        assert verdict.releve.strip(), f"{verdict.code} ne dit pas ce qu'il a relevé"


def test_le_rendu_texte_montre_le_remede_des_echecs_seulement():
    rendu = preflight.rendu_texte([
        Verdict("A", "va bien", OK, "3.2", "remède inutile"),
        Verdict("B", "va mal", ECHEC, "absent", "faire ceci"),
    ])
    assert "faire ceci" in rendu
    assert "remède inutile" not in rendu
    assert "1 bloquant(s)" in rendu


def test_la_verification_n_execute_aucune_commande_qui_ecrit():
    """§31.3 — lecture seule, sans exception.

    On enregistre tout ce qui est lancé et on vérifie qu'aucun verbe mutant n'y
    figure. C'est ce qui rend l'outil lançable sur un serveur en service.
    """
    lancees: list[list[str]] = []

    def espion(commande: list[str]) -> str | None:
        lancees.append(commande)
        return None

    preflight.verifier(Hote(executer=espion, lire=lambda p: None, presence=lambda b: True))
    interdits = {"set", "create", "delete", "rm", "start", "stop", "restart",
                 "enable", "disable", "apply", "install", "write"}
    for commande in lancees:
        assert not (set(commande) & interdits), f"commande mutante : {commande}"


# --- la tranche parente des Sparks (docs/DAT.md §32.4) ----------------------


def test_une_tranche_absente_est_bloquante():
    """Le piege : une tranche absente ne casse RIEN de visible.

    Les Sparks demarrent et tournent ; leur reservation cesse simplement d'etre
    absolue. Sans ce controle, la regression serait silencieuse.
    """
    verdict = preflight.tranche_des_sparks(hote())
    assert verdict.etat == ECHEC
    assert "install-serveur.sh" in verdict.remede


def test_une_tranche_sans_controleurs_delegues_est_bloquante():
    """Presente mais inerte : les limites ne s'appliqueraient pas a l'interieur."""
    verdict = preflight.tranche_des_sparks(hote(
        commandes={"systemctl is-enabled spark.slice": "enabled"},
        fichiers={"/sys/fs/cgroup/spark.slice/cgroup.subtree_control": "pids\n"}))
    assert verdict.etat == ECHEC
    assert "cpu" in verdict.remede


def test_une_tranche_non_activee_au_demarrage_est_bloquante():
    """Creee a la main, elle disparait au redemarrage (mesure du §32.4)."""
    verdict = preflight.tranche_des_sparks(hote(
        commandes={},
        fichiers={"/sys/fs/cgroup/spark.slice/cgroup.subtree_control":
                  "cpuset cpu io memory pids\n"}))
    assert verdict.etat == ECHEC
    assert "redemarrage" in verdict.releve or "redemarrage" in verdict.remede


def test_une_tranche_conforme():
    verdict = preflight.tranche_des_sparks(hote(
        commandes={"systemctl is-enabled spark.slice": "enabled"},
        fichiers={"/sys/fs/cgroup/spark.slice/cgroup.subtree_control":
                  "cpuset cpu io memory pids\n"}))
    assert verdict.etat == OK


# --- SPK-28 · La vérification LIT sa configuration (§8.5 bis) ---------------


def test_le_nom_du_pool_vient_de_la_CONFIGURATION_pas_d_un_defaut():
    """Vérifier une Forge dont le pool s'appelle « tank » doit parler d'elle.

    Avec un défaut de fonction, le verdict annonçait « pool « spark » absent »
    sur une installation parfaitement saine — un rouge qui ne dit rien du
    produit, exactement ce que le §31.2 interdit.
    """
    montre = "driver: zfs\nconfig:\n  source: /dev/sda5\n"
    verdict = preflight.pool_de_stockage(
        hote({"incus storage show tank": montre}),
        nom=preflight.reglages({"SPARKD_STORAGE_POOL": "tank"}).storage_pool)
    assert verdict.etat == OK
    assert "tank" in verdict.titre


def test_le_REMEDE_propose_la_taille_configuree():
    """Une consigne de réparation qui contredit le script d'installation apprend
    à se méfier des deux."""
    reglages = preflight.reglages({"SPARK_POOL_FILE_SIZE": "1TiB"})
    verdict = preflight.pool_de_stockage(hote({}), taille=reglages.pool_file_size)
    assert verdict.etat == ECHEC
    assert "size=1TiB" in verdict.remede


def test_le_jeu_de_donnees_SUIT_le_pool_par_defaut():
    """§8.5 bis : les désynchroniser en silence ferait vérifier la compression
    d'un jeu de données qui n'est pas celui du pool."""
    assert preflight.reglages({"SPARKD_STORAGE_POOL": "tank"}).storage_dataset == "tank"
    assert preflight.reglages({
        "SPARKD_STORAGE_POOL": "tank",
        "SPARKD_STORAGE_DATASET": "tank/sparks"}).storage_dataset == "tank/sparks"


def test_la_compression_est_verifiee_sur_le_jeu_de_donnees_CONFIGURE():
    verdict = preflight.compression_active(
        hote({"zfs get -H -o value compression tank/sparks": "lz4"}),
        dataset=preflight.reglages({
            "SPARKD_STORAGE_POOL": "tank",
            "SPARKD_STORAGE_DATASET": "tank/sparks"}).storage_dataset)
    assert verdict.etat == OK and verdict.releve == "lz4"
