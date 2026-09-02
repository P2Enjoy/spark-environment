"""@verifies docs/BACKLOG.md#SPK-26 · docs/DAT.md §31, §31.2 (mesurer, nommer,
           remédier), §31.3 (lecture seule), §31.4 · §3.1, §11, §16

Les relevés sont INJECTÉS : ces preuves n'ont besoin d'aucun serveur. Ceux du
`ss` viennent de la Forge cible, relevés le 2026-08-19 — c'est ce relevé qui a
montré que le contrôle de surface réseau était faux.
"""

from __future__ import annotations

import pytest

from sparkd import preflight
from sparkd.preflight import AVERTISSEMENT, ECHEC, INCONNU, OK, Hote, Verdict

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
         binaires: set[str] = None, declarations=None) -> Hote:
    commandes = commandes or {}
    fichiers = fichiers or {}
    binaires = binaires if binaires is not None else {"caddy"}
    return Hote(
        executer=lambda c: commandes.get(" ".join(c)),
        lire=lambda p: fichiers.get(p),
        presence=lambda b: b in binaires,
        # SPK-36 : par défaut AUCUNE déclaration, donc aucun fantôme possible.
        # Les preuves qui visent ce contrôle fournissent leur propre relevé.
        declarations=declarations if declarations is not None else (lambda: []),
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


def test_un_pool_sur_fichier_AVERTIT_sans_declarer_la_Forge_en_panne():
    """RÉVISÉE le 2026-09-02 par SPK-28, arbitrage du responsable.

    La preuve précédente exigeait un verdict VERT : il y avait alors deux
    dispositions de rang égal. Il n'y en a plus qu'une, et le pool sur fichier
    est retiré du produit. Le verdict change donc de niveau — mais pas jusqu'à
    l'échec, et c'est le point : ce pool FONCTIONNE, c'est le même ZFS, et le
    produit ne casse pas ce qui tourne. Un rouge ferait croire à une panne là où
    il n'y a qu'une disposition sortie du périmètre.

    Ce que la preuve gardait déjà, et qui reste : le verdict nomme ce que cette
    disposition N'APPORTE PAS. Le taire laisserait croire qu'un pool ZFS protège
    toujours de la corruption silencieuse, alors qu'ici le miroir est géré en
    dessous et que « md » ne sait pas laquelle des deux copies est la bonne.
    """
    montre = "driver: zfs\nconfig:\n  source: /var/lib/incus/disks/spark.img\n"
    verdict = preflight.pool_de_stockage(hote({"incus storage show spark": montre}))
    assert verdict.etat == AVERTISSEMENT
    assert verdict.etat != ECHEC, "un pool qui fonctionne n'est pas une panne"
    assert "corruption silencieuse" in verdict.releve
    assert "NON couverte" in verdict.releve
    assert "retirée" in verdict.releve
    # Le remède ne presse pas : migrer suppose deux supports libres, que cette
    # machine n'a probablement pas — sinon elle ne serait pas sur fichier.
    assert "urgence" in verdict.remede


def test_un_pool_NATIF_est_le_seul_verdict_VERT():
    """§8.5 révisé : une seule disposition passe au vert, et elle est nommée."""
    montre = "driver: zfs\nconfig:\n  source: /dev/sda5\n"
    verdict = preflight.pool_de_stockage(hote({"incus storage show spark": montre}))
    assert verdict.etat == OK
    assert "miroir ZFS natif" in verdict.releve
    assert "NON couverte" not in verdict.releve


def test_un_pool_absent_est_bloquant():
    verdict = preflight.pool_de_stockage(hote({}))
    assert verdict.etat == ECHEC and "creer-pool.sh" in verdict.remede


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
    # RÉVISÉE le 2026-08-21 : SPK-55 ajoute deux contrôles (`docs/DAT.md` §48.2),
    # puis SPK-36 en ajoute un — `REG-FANTOME` (`docs/CONTINGENCE.md` §4.4).
    # La liste est gardée EN ENTIER et non par inclusion, et c'est voulu : un
    # contrôle retiré par mégarde doit faire rougir cette preuve, sans quoi la
    # série pourrait maigrir sans que personne ne le voie.
    assert set(codes) == {
        "INC-VERSION", "STO-POOL", "STO-COMPRESSION", "MEM-ARC",
        "NET-BRIDGE", "NET-DHCP", "ING-CADDY", "SEC-PORTS", "RUN-SPARKD",
        "RUN-SLICE", "NET-REMONTEE", "SSH-X11", "REG-FANTOME",
        # SPK-84 · §50.7.2 : un dpkg incohérent empêche TOUTE installation,
        # donc l'amorce d'une Forge comme l'amorçage d'un Spark.
        "PKG-DPKG",
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
    assert "sparkd.install" in verdict.remede


def test_une_tranche_sans_controleurs_delegues_est_bloquante():
    """Presente mais inerte : les limites ne s'appliqueraient pas a l'interieur."""
    verdict = preflight.tranche_des_sparks(hote(
        commandes={"systemctl is-enabled spark.slice": "enabled"},
        fichiers={"/sys/fs/cgroup/spark.slice/cgroup.subtree_control": "pids\n"}))
    assert verdict.etat == ECHEC
    # Le releve NOMME ce qui manque : « corriger » sans savoir quoi coute un
    # aller-retour sur une machine distante.
    assert "cpu" in verdict.releve and "memory" in verdict.releve
    assert preflight.UNITE_DELEGATION in verdict.remede


def test_une_tranche_non_activee_au_demarrage_est_bloquante():
    """Creee a la main, elle disparait au redemarrage (mesure du §32.4)."""
    verdict = preflight.tranche_des_sparks(hote(
        commandes={},
        fichiers={"/sys/fs/cgroup/spark.slice/cgroup.subtree_control":
                  "cpuset cpu io memory pids\n"}))
    assert verdict.etat == ECHEC
    assert "redemarrage" in verdict.releve or "redemarrage" in verdict.remede


def test_des_controleurs_que_RIEN_ne_maintiendra_sont_bloquants():
    """@verifies docs/BACKLOG.md#SPK-71 · docs/DAT.md §32.4 ter

    MESURE le 2026-09-01 : ecrits a la main, les controleurs disparaissent au
    premier `daemon-reload`. Vert sur le seul relevé du fichier serait vert a
    l'instant du controle et faux une minute plus tard — pire que rouge, parce
    qu'on ne chercherait plus la panne.
    """
    verdict = preflight.tranche_des_sparks(hote(
        commandes={"systemctl is-enabled spark.slice": "enabled"},
        fichiers={"/sys/fs/cgroup/spark.slice/cgroup.subtree_control":
                  "cpuset cpu io memory pids\n"}))
    assert verdict.etat == ECHEC, "sans l'unite deleguee, rien ne les maintient"
    assert preflight.UNITE_DELEGATION in verdict.releve
    assert "daemon-reload" in verdict.remede


def test_une_tranche_conforme():
    verdict = preflight.tranche_des_sparks(hote(
        commandes={"systemctl is-enabled spark.slice": "enabled",
                   f"systemctl is-enabled {preflight.UNITE_DELEGATION}": "enabled"},
        fichiers={"/sys/fs/cgroup/spark.slice/cgroup.subtree_control":
                  "cpuset cpu io memory pids\n"}))
    assert verdict.etat == OK, verdict.releve


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


def test_le_REMEDE_d_un_pool_ABSENT_designe_le_geste_qui_existe():
    """Il ne propose PLUS « size= » : ce serait créer un pool sur fichier, qui
    est retiré du produit depuis le 2026-09-02 (§8.5 révisé)."""
    verdict = preflight.pool_de_stockage(hote({}))
    assert verdict.etat == ECHEC
    assert "creer-pool.sh" in verdict.remede
    assert "SPARK_POOL_SOURCE" in verdict.remede
    assert "size=" not in verdict.remede


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


# --- SPK-55 · durcir la Forge (docs/DAT.md §48) ------------------------------


def test_une_entree_de_bridge_qui_accepte_tout_est_un_ECHEC():
    """§48.1 : mesuré sur la Forge réelle, `10.77.0.1:22` répondait depuis un
    Spark. Le sens du produit est à SENS UNIQUE — aucun de ses chemins ne part
    d'un Spark vers sa Forge."""
    verdict = preflight.remontee_vers_la_forge(hote({
        "incus network get sparkbr0 ipv4.firewall": "true",
    }))
    assert verdict.etat == ECHEC
    assert "22" in verdict.releve


def test_le_remede_LAISSE_le_DNS_et_la_sortie():
    """§48.1, la moitié difficile : une règle qui fermerait tout rendrait chaque
    Spark muet — une panne, pas une protection."""
    verdict = preflight.remontee_vers_la_forge(hote({
        "incus network get sparkbr0 ipv4.firewall": "true",
    }))
    assert "dport 53 accept" in verdict.remede, "le résolveur reste joignable"
    assert verdict.remede.index("dport 53 accept") < verdict.remede.index("drop"), (
        "le DNS doit être ouvert AVANT la fermeture, sinon la règle qui tombe "
        "en premier ferme tout")


def test_une_entree_deja_fermee_est_OK():
    for pose in ("drop", "reject", "DROP"):
        verdict = preflight.remontee_vers_la_forge(hote({
            "incus network get sparkbr0 user.spark.input_policy": pose,
        }))
        assert verdict.etat == OK, pose


def test_un_reseau_ILLISIBLE_ne_conclut_a_rien():
    """§31.2 : ne pas avoir mesuré n'est pas avoir mesuré une valeur fautive.
    Conclure ici ferait « corriger » une Forge correcte."""
    verdict = preflight.remontee_vers_la_forge(hote())
    assert verdict.etat == INCONNU
    assert not verdict.bloquant


#: Relevé RÉEL de `sshd -T` sur la Forge, le 2026-09-01. C'est ce relevé qui a
#: montré que le contrôle SSH-X11 mentait : le fichier principal porte encore
#: `X11Forwarding yes`, et `sshd` applique pourtant `no`.
SSHD_T_FORGE = "permitrootlogin no\nx11forwarding no\nx11displayoffset 10\n"


def test_X11_ouvert_est_SIGNALE_sans_bloquer():
    """§48.2 : ce n'est pas une faille ouverte, c'est une surface qui ne sert à
    rien. Un préflight qui échoue pour un détail apprend à passer outre ses
    échecs."""
    verdict = preflight.x11_sans_usage(
        hote(commandes={"sshd -T": "x11forwarding yes\npermitrootlogin no\n"}))
    assert verdict.etat == preflight.AVERTISSEMENT
    assert not verdict.bloquant, "un avertissement ne refuse pas une installation"
    assert "X11Forwarding no" in verdict.remede


def test_la_configuration_EFFECTIVE_fait_foi_contre_le_fichier():
    """@verifies docs/BACKLOG.md#SPK-72 · docs/DAT.md §48.2

    LE CAS RÉEL DE LA FORGE, relevé le 2026-09-01. `phase_foundation` écrit sa
    règle dans `/etc/ssh/sshd_config.d/90-spark.conf` ; le fichier principal
    garde le `X11Forwarding yes` de la distribution. L'ancien contrôle lisait ce
    seul fichier et ne pouvait donc JAMAIS passer au vert sur une Forge
    correctement installée.
    """
    verdict = preflight.x11_sans_usage(hote(
        commandes={"sshd -T": SSHD_T_FORGE},
        fichiers={"/etc/ssh/sshd_config": "X11Forwarding yes\n"}))
    assert verdict.etat == OK, verdict.releve
    assert "sshd -T" in verdict.releve, "le relevé doit nommer la source qui a parlé"


def test_X11_ferme_ou_absent_est_OK():
    # Absent du relevé : le défaut d'OpenSSH est « yes », mais le produit ne
    # conclut que sur ce qu'il LIT — deviner ferait signaler des Forges saines.
    for contenu in ("X11Forwarding no\n", "PermitRootLogin no\n"):
        verdict = preflight.x11_sans_usage(hote(fichiers={"/etc/ssh/sshd_config": contenu}))
        assert verdict.etat == OK, contenu


def test_le_fichier_sert_de_REPLI_quand_sshd_ne_repond_pas():
    """@verifies docs/BACKLOG.md#SPK-72

    Un hôte sans `sshd` invocable — ou un préflight lancé sans les droits — ne
    doit pas perdre le contrôle : il retombe sur le fichier, et le DIT.
    """
    verdict = preflight.x11_sans_usage(
        hote(fichiers={"/etc/ssh/sshd_config": "X11Forwarding yes\n"}))
    assert verdict.etat == preflight.AVERTISSEMENT
    assert "repli" in verdict.releve, "le relevé doit avouer qu'il n'a pas lu l'effectif"


def test_la_DERNIERE_valeur_lue_fait_foi_EN_REPLI():
    # `sshd` retient la PREMIÈRE ; le repli retient la dernière, ce qui est plus
    # SÉVÈRE et donc plus sûr : il signale un fichier ambigu au lieu de le
    # déclarer sain. Écrit ici pour que l'écart soit vu, pas découvert.
    verdict = preflight.x11_sans_usage(
        hote(fichiers={"/etc/ssh/sshd_config": "X11Forwarding no\nX11Forwarding yes\n"}))
    assert verdict.etat == preflight.AVERTISSEMENT


def test_aucune_source_lisible_ne_conclut_a_rien():
    verdict = preflight.x11_sans_usage(hote())
    assert verdict.etat == INCONNU
    assert not verdict.bloquant


def test_un_avertissement_est_COMPTE_a_part_dans_le_rendu():
    """§14.6 appliqué au texte : « signalé » n'est ni « bloquant » ni « non
    mesuré », et les confondre ferait chercher une panne ou l'ignorer."""
    texte = preflight.rendu_texte([
        preflight.Verdict("SSH-X11", "t", preflight.AVERTISSEMENT, "r", "m"),
    ])
    assert "1 signalé(s)" in texte
    assert "0 bloquant(s)" in texte


# --- l'entrée fantôme au registre (SPK-36, docs/CONTINGENCE.md §4) -----------

def _declare(nom, cellule, cpu=1.0, memoire=2147483648):
    return {"name": nom, "incus_name": cellule, "state": "error",
            "cpu_reservation": cpu, "memory_reservation_bytes": memoire}


def test_une_cellule_declaree_mais_ABSENTE_est_signalee_avec_son_cout():
    """@verifies docs/BACKLOG.md#SPK-36 · docs/CONTINGENCE.md §4.2, §4.4

    MESURÉ sur la Forge de validation : une ligne fantôme y consommait 1,0 CPU
    et 2 Gio, et faisait passer le poids de `spark.slice` de **43 à 180** —
    quatre fois trop. La Forge est restée ainsi deux jours en rendant
    « 0 bloquant » : l'écart joue en faveur des Sparks vivants, donc personne ne
    s'en plaint, donc personne ne le voit.

    Le chiffre fait partie du signal : sans lui, on ne sait pas s'il faut agir
    aujourd'hui ou la semaine prochaine.
    """
    v = preflight.registre_sans_fantome(hote(
        commandes={"incus list --format csv -c n": "helo\n"},
        declarations=lambda: [_declare("helo", "helo", 0.5, 1),
                              _declare("mesure-cpu", "mesure-cpu", 1.0, 2147483648)]))
    assert v.code == "REG-FANTOME"
    assert v.etat == preflight.ECHEC
    assert "mesure-cpu" in v.releve
    assert "helo" not in v.releve, "un Spark dont la cellule VIT n'est pas un fantôme"
    assert "1 CPU" in v.releve and "2147483648" in v.releve, "le coût est CHIFFRÉ"
    assert v.remede, "le contrôle dit quoi faire"


def test_un_Spark_SANS_cellule_declaree_n_est_PAS_un_fantome():
    """§4.4 : un Spark « pending », jamais appliqué, n'a jamais prétendu avoir de
    cellule. Le confondre avec un fantôme ferait crier au défaut sur le
    déroulement NORMAL d'une création — et le contrôle deviendrait du bruit."""
    # Le lecteur du registre ne rend que les lignes portant `incus_name` : un
    # Spark sans cellule n'arrive donc jamais jusqu'ici. La preuve garde ce
    # contrat côté contrôle.
    v = preflight.registre_sans_fantome(hote(
        commandes={"incus list --format csv -c n": ""},
        declarations=lambda: []))
    assert v.etat == preflight.OK


def test_un_registre_ILLISIBLE_rend_non_mesure_et_non_fautif():
    """§31.2 : « pas mesuré » n'est pas « mesuré fautif ». Conclure sur une
    absence de réponse ferait signaler comme fantômes tous les Sparks d'une
    Forge dont on n'a simplement pas pu lire l'état — et l'exploitant
    supprimerait des Sparks bien vivants."""
    v = preflight.registre_sans_fantome(hote(
        commandes={"incus list --format csv -c n": "helo\n"},
        declarations=lambda: None))
    assert v.etat == preflight.INCONNU
    assert "illisible" in v.releve


def test_INCUS_injoignable_rend_non_mesure_aussi():
    """Même raison, symétrique : sans la liste des cellules vivantes, toute
    déclaration paraîtrait fantôme."""
    v = preflight.registre_sans_fantome(hote(
        commandes={},
        declarations=lambda: [_declare("helo", "helo")]))
    assert v.etat == preflight.INCONNU
    assert "injoignable" in v.releve


# --- SPK-84 · un dpkg incoherent est une panne du produit (§50.7.2) --------
#
# @verifies docs/BACKLOG.md#SPK-84 · docs/DAT.md §50.7.2, §31.2 (« pas mesuré »
#           n'est pas « mesuré sain »), §31.3 (un contrôle ne répare rien)


def _dpkg(sortie):
    return Hote(executer=lambda args: sortie, lire=lambda chemin: None)


def test_un_paquet_en_defaut_BLOQUE_car_plus_aucune_installation_n_aboutit():
    """Mesuré le 2026-09-02 : `grub-pc` en `iF` sur un `/boot` en RAID. Ni
    l'amorce d'une Forge ni l'amorçage d'un Spark ne peuvent plus installer, et
    le message désignait à chaque fois le paquet demandé, jamais le bloquant."""
    verdict = preflight.paquets_coherents(
        _dpkg("ii  bash\niF  grub-pc\niU  grub2\n"))
    assert verdict.etat == ECHEC
    assert verdict.bloquant
    assert "grub-pc" in verdict.releve and "grub2" in verdict.releve
    # Le remède RENVOIE au runbook : la commande dépend de ce qui est cassé, et
    # un contrôle ne répare rien (§31.3).
    assert "C.5" in verdict.remede
    assert "dpkg --configure -a" in verdict.remede


def test_les_paquets_RETIRES_ne_font_pas_crier_au_loup():
    """`rc` est l'état normal d'un paquet désinstallé dont la configuration
    reste. Toute Forge en porte : les signaler rendrait le contrôle inutile."""
    verdict = preflight.paquets_coherents(
        _dpkg("ii  bash\nrc  cryptsetup\nrc  dracut\nrc  tiny-initramfs\n"))
    assert verdict.etat == OK
    assert "aucun paquet en défaut" in verdict.releve


def test_un_dpkg_ILLISIBLE_est_inconnu_et_jamais_sain():
    """§31.2 : conclure « sain » d'une absence de réponse ferait déclarer prête
    une Forge sur laquelle rien ne s'installera."""
    verdict = preflight.paquets_coherents(_dpkg(None))
    assert verdict.etat == INCONNU
    assert verdict.etat != OK
    assert not verdict.bloquant


def test_la_liste_des_paquets_casses_est_BORNEE():
    """Un relevé qui déborde l'écran ne se lit pas. On en montre six, et on dit
    combien restent — taire le reste ferait croire à un défaut plus petit."""
    sortie = "".join(f"iF  paquet-{n}\n" for n in range(10))
    verdict = preflight.paquets_coherents(_dpkg(sortie))
    assert verdict.etat == ECHEC
    assert "(+4)" in verdict.releve


def test_le_controle_figure_dans_la_serie():
    """Un contrôle qui n'est pas dans CONTROLES ne s'exécute jamais."""
    assert preflight.paquets_coherents in preflight.CONTROLES
