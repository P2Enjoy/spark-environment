"""@verifies docs/BACKLOG.md#SPK-108 · docs/DAT.md §56.2 (80 et 443, et rien
           d'autre), §56.3 (la pose par comparaison du fichier rendu, le
           rechargement seulement quand il a changé), §56.5 · §48.2 bis (rien
           n'est flushé, l'ordre d'OP-11) · docs/PROD_MIGRATIONS.md#OP-21

Le rendu est une fonction pure : la preuve le compare à un TÉMOIN écrit ici,
mot pour mot. Une ligne qui change dans le rendu change ce témoin, et la
relecture du diff est la revue de la règle.
"""

from __future__ import annotations

from pathlib import Path

from sparkd import pare_feu

TEMOIN = """add table inet spark_filter
delete table inet spark_filter
table inet spark_filter {
  chain input {
    type filter hook input priority 10; policy accept;
    iifname "sparkbr0" ct state established,related accept
    iifname "sparkbr0" udp dport { 53, 67 } accept
    iifname "sparkbr0" tcp dport { 53, 80, 443 } accept
    iifname "sparkbr0" ip protocol icmp accept
    iifname "sparkbr0" ip6 nexthdr ipv6-icmp accept
    iifname "sparkbr0" drop
    iifname "spn*" ct state established,related accept
    iifname "spn*" udp dport { 53, 67 } accept
    iifname "spn*" tcp dport 53 accept
    iifname "spn*" ip protocol icmp accept
    iifname "spn*" drop
  }
  chain forward {
    type filter hook forward priority 10; policy accept;
    ct state established,related accept
    iifname "sparkbr0" oifname "sparkbr0" drop
    iifname "spn*" drop
    oifname "spn*" drop
  }
}
"""

#: Le fichier qu'OP-11 a posé à la main sur la Forge le 2026-08-21, tel que le
#: code de SPK-55 le rendait : sans l'ingress. C'est CE fichier qu'une mise à
#: jour doit remplacer.
ANTERIEUR = """table inet spark_filter {
  chain input {
    type filter hook input priority 10; policy accept;
    iifname "sparkbr0" ct state established,related accept
    iifname "sparkbr0" udp dport { 53, 67 } accept
    iifname "sparkbr0" tcp dport 53 accept
    iifname "sparkbr0" ip protocol icmp accept
    iifname "sparkbr0" ip6 nexthdr ipv6-icmp accept
    iifname "sparkbr0" drop
  }
}
"""


def test_le_rendu_est_le_temoin_mot_pour_mot():
    assert pare_feu.rendre("sparkbr0") == TEMOIN


def test_l_ordre_d_OP_11_tient_et_l_ingress_precede_le_drop():
    """§48.2 bis : les connexions établies d'abord, le drop en dernier — inversé,
    chaque Spark devient muet. §56.2 : 80 et 443 AVANT le drop, sinon la ligne
    est morte."""
    lignes = [r for r in pare_feu.regles("sparkbr0") if 'iifname "sparkbr0"' in r]
    assert lignes[0].endswith("ct state established,related accept")
    assert lignes[-1] == 'iifname "sparkbr0" drop'
    assert lignes.index('iifname "sparkbr0" tcp dport { 53, 80, 443 } accept') < len(lignes) - 1


def test_rien_d_autre_que_le_resolveur_et_l_ingress_n_est_accepte():
    """§56.4 : ni 22, ni 9876, ni 2019, ni les ports publiés."""
    rendu = pare_feu.rendre("sparkbr0")
    for port in ("22", "9876", "2019"):
        assert f" {port}" not in rendu and f"{port} " not in rendu, port
    assert "flush" not in rendu, "le fichier remplace SA table, il ne flushe rien (§48.2 bis)"
    assert rendu.index("add table inet spark_filter") < rendu.index("delete table inet spark_filter")


def test_le_verrou_forward_ferme_le_detour_par_la_passerelle():
    """@verifies docs/BACKLOG.md#SPK-109 · docs/DAT.md §57.2

    MESURÉ le 2026-09-17 : une route via 10.77.0.1 livre les paquets à un
    voisin isolé ; cette règle, en forward à filter + 10, les arrête — et
    survit à l'accept explicite d'Incus. Les connexions établies passent avant :
    les liens du §59 et le retour de l'ingress en dépendent."""
    rendu = pare_feu.rendre("sparkbr0")
    forward = rendu[rendu.index("chain forward"):]
    assert "ct state established,related accept" in forward
    assert 'iifname "sparkbr0" oifname "sparkbr0" drop' in forward
    assert forward.index("established") < forward.index("drop")
    assert "priority 10" in forward


def test_un_reseau_prive_n_ouvre_pas_la_forge_et_ne_mene_nulle_part():
    """@verifies docs/BACKLOG.md#SPK-110 · docs/DAT.md §58.3, §58.6

    MESURÉ le 2026-09-18 : sans ces lignes, sshd répondait sur la passerelle du
    réseau privé et la Forge routait spn* → sparkbr0. Le résolveur et le DHCP
    du réseau restent ouverts — ils donnent aux membres adresse et noms —,
    l'ingress non : un service public se joint par sparkbr0."""
    entree = pare_feu.regles("sparkbr0", "input")
    prives = [r for r in entree if 'iifname "spn*"' in r]
    assert prives[-1] == 'iifname "spn*" drop'
    assert any("udp dport { 53, 67 } accept" in r for r in prives)
    assert any("tcp dport 53 accept" in r for r in prives)
    assert not any("443" in r or "80" in r for r in prives), "pas d'ingress par un réseau privé"
    rendu = pare_feu.rendre("sparkbr0")
    forward = rendu[rendu.index("chain forward"):]
    assert 'iifname "spn*" drop' in forward and 'oifname "spn*" drop' in forward
    assert forward.index("established") < forward.index('iifname "spn*" drop')


def test_le_bridge_est_celui_qu_on_lui_donne():
    assert 'iifname "autrebr0" drop' in pare_feu.rendre("autrebr0")
    assert "sparkbr0" not in pare_feu.rendre("autrebr0")


def test_la_premiere_pose_ecrit_les_deux_fichiers_et_active(tmp_path: Path):
    commandes: list[list[str]] = []
    resultat = pare_feu.poser("sparkbr0", racine=tmp_path, executer=commandes.append)
    assert resultat["changed"] is True
    assert (tmp_path / "etc/sparkd/firewall.nft").read_text(encoding="utf-8") == TEMOIN
    assert (tmp_path / "etc/systemd/system/spark-firewall.service").read_text(
        encoding="utf-8") == pare_feu.TEXTE_UNITE
    assert commandes == [
        ["systemctl", "daemon-reload"],
        ["systemctl", "enable", "--now", "spark-firewall.service"],
        ["systemctl", "reload-or-restart", "spark-firewall.service"],
    ]


def test_une_pose_identique_n_ecrit_rien_et_ne_passe_aucune_commande(tmp_path: Path):
    """§56.3 : c'est ce qu'une installation rejouée doit garantir — et ce que
    la garde par l'étiquette ne garantissait pas dans l'autre sens."""
    pare_feu.poser("sparkbr0", racine=tmp_path, executer=lambda _: None)
    avant = (tmp_path / "etc/sparkd/firewall.nft").stat().st_mtime_ns
    commandes: list[list[str]] = []
    resultat = pare_feu.poser("sparkbr0", racine=tmp_path, executer=commandes.append)
    assert resultat["changed"] is False
    assert commandes == []
    assert (tmp_path / "etc/sparkd/firewall.nft").stat().st_mtime_ns == avant


def test_une_forge_durcie_par_OP_11_recoit_la_regle_nouvelle(tmp_path: Path):
    """Le défaut que le §56.3 corrige : une Forge déjà en « drop » ne recevait
    JAMAIS une règle nouvelle. Ici l'unité est déjà en place et identique ; seul
    le fichier de règles diffère — il est réécrit et rechargé, sans
    daemon-reload."""
    regles = tmp_path / "etc/sparkd/firewall.nft"
    regles.parent.mkdir(parents=True)
    regles.write_text(ANTERIEUR, encoding="utf-8")
    regles.chmod(0o644)
    unite = tmp_path / "etc/systemd/system/spark-firewall.service"
    unite.parent.mkdir(parents=True)
    unite.write_text(pare_feu.TEXTE_UNITE, encoding="utf-8")
    unite.chmod(0o644)

    commandes: list[list[str]] = []
    resultat = pare_feu.poser("sparkbr0", racine=tmp_path, executer=commandes.append)
    assert resultat["changed"] is True
    assert regles.read_text(encoding="utf-8") == TEMOIN
    assert commandes == [
        ["systemctl", "enable", "--now", "spark-firewall.service"],
        ["systemctl", "reload-or-restart", "spark-firewall.service"],
    ]


def test_l_installateur_du_paquet_n_ajoute_pas_de_daemon_reload_en_double(tmp_path: Path):
    """`sparkd.install` recharge systemd une fois pour toutes ses unités ; la
    pose du pare-feu n'en ajoute pas un second."""
    changement = pare_feu.ecrire("sparkbr0", racine=tmp_path)
    assert changement == {"regles": True, "unite": True}
    commandes: list[list[str]] = []
    pare_feu.activer(changement, commandes.append, daemon_recharge=True)
    assert commandes == [
        ["systemctl", "enable", "--now", "spark-firewall.service"],
        ["systemctl", "reload-or-restart", "spark-firewall.service"],
    ]
