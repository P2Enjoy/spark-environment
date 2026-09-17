"""Le pare-feu du bridge privé : rendu, pose et rechargement.

@spec docs/BACKLOG.md#SPK-108 · docs/DAT.md §56.2 (80 et 443, et rien d'autre),
      §56.3 (une règle statique, posée par comparaison du fichier rendu),
      §56.4 · §48.1, §48.2 bis (la règle est posée par l'INSTALLATION), §48.3 ·
      docs/BACKLOG.md#SPK-109 · docs/DAT.md §57.2 (le verrou `forward` : le
      détour par la passerelle, mesuré le 2026-09-17) ·
      docs/BACKLOG.md#SPK-110 · docs/DAT.md §58.3 (un réseau privé n'est une
      route vers rien), §58.6 (mesuré le 2026-09-18 : sans règle, la Forge route
      `spn* → sparkbr0` et son sshd répond sur la passerelle du réseau) ·
      docs/PROD_MIGRATIONS.md#OP-21, docs/PROD_MIGRATIONS.md#OP-22,
      docs/PROD_MIGRATIONS.md#OP-23

Une seule table, `inet spark_filter`, rendue comme une FONCTION PURE du nom du
bridge : ce qui se pose se lit d'un coup, et se compare à un témoin. La pose ne
regarde jamais une étiquette pour décider — c'est ce qui aurait privé toute
Forge déjà durcie d'une règle nouvelle (§56.3). Elle compare le fichier rendu au
fichier en place, et ne recharge que s'il a changé.

Rien n'est flushé : le fichier remplace SA table, atomiquement — déclaration,
suppression, définition, dans la seule transaction d'un `nft -f`. Le
`/etc/nftables.conf` d'Ubuntu commence par `flush ruleset`, ce qui effacerait la
table d'Incus, donc le NAT, le DNS et le DHCP de tous les Sparks (§48.2 bis).
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable

#: Les ports de l'ingress, et eux seuls (§56.2). Caddy écoute sur toutes les
#: adresses de la Forge : un Spark le joint donc comme un visiteur d'Internet.
#: Le 22, le 9876 et le 2019 restent hors liste, et le préflight l'exige.
PORTS_INGRESS = (80, 443)

UNITE = "spark-firewall.service"
#: Le préfixe des bridges des réseaux privés (§58.2) : `spn<n>` pour
#: `10.78.<n>.0/24`. Les règles le matchent par joker — une interface de plus
#: n'est pas une règle de plus, la table reste STATIQUE.
PREFIXE_RESEAU_PRIVE = "spn"
CHEMIN_REGLES = Path("etc/sparkd/firewall.nft")
CHEMIN_UNITE = Path("etc/systemd/system") / UNITE

#: Ordonnée APRÈS Incus — la table d'Incus doit exister pour que le trafic du
#: bridge ait un sens — et AVANT sparkd. `ExecReload` recharge le fichier, qui
#: remplace sa propre table : recharger ne duplique rien.
TEXTE_UNITE = """[Unit]
Description=Filtrage du bridge privé Spark
After=incus.service
Before=sparkd.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=-/usr/sbin/nft delete table inet spark_filter
ExecStart=/usr/sbin/nft -f /etc/sparkd/firewall.nft
ExecReload=/usr/sbin/nft -f /etc/sparkd/firewall.nft

[Install]
WantedBy=multi-user.target
"""

Executeur = Callable[[list[str]], object]


def rendre(bridge: str) -> str:
    """La table entière, pour un bridge. Pure : même entrée, même texte.

    L'ordre des règles est celui d'OP-11, et il n'est pas négociable : les
    connexions établies d'abord — le produit va de la Forge VERS ses Sparks et
    les réponses reviennent par le bridge —, puis le résolveur et le DHCP, puis
    l'ingress (§56.2), puis l'ICMP utile, et le `drop` en dernier.
    """
    tcp = ", ".join(str(port) for port in (53, *PORTS_INGRESS))
    prive = f"{PREFIXE_RESEAU_PRIVE}*"
    return (
        "add table inet spark_filter\n"
        "delete table inet spark_filter\n"
        "table inet spark_filter {\n"
        "  chain input {\n"
        "    type filter hook input priority 10; policy accept;\n"
        f'    iifname "{bridge}" ct state established,related accept\n'
        f'    iifname "{bridge}" udp dport {{ 53, 67 }} accept\n'
        f'    iifname "{bridge}" tcp dport {{ {tcp} }} accept\n'
        f'    iifname "{bridge}" ip protocol icmp accept\n'
        f'    iifname "{bridge}" ip6 nexthdr ipv6-icmp accept\n'
        f'    iifname "{bridge}" drop\n'
        # SPK-110 · §58.3 : un réseau privé est une interface de plus sur la
        # Forge, et la porte du §48.1 ne se rouvre pas par lui. Son résolveur
        # et son DHCP, oui — c'est lui qui donne aux membres adresse et noms
        # (§58.6) — ; rien d'autre, pas même l'ingress : un service public se
        # joint par sparkbr0. MESURÉ le 2026-09-18 : sans ces lignes, sshd
        # répondait sur la passerelle du réseau privé.
        f'    iifname "{prive}" ct state established,related accept\n'
        f'    iifname "{prive}" udp dport {{ 53, 67 }} accept\n'
        f'    iifname "{prive}" tcp dport 53 accept\n'
        f'    iifname "{prive}" ip protocol icmp accept\n'
        f'    iifname "{prive}" drop\n'
        "  }\n"
        # SPK-109 · §57.2 : l'isolation de port ferme la couche 2 ; ce qu'une
        # cellule route VIA la passerelle vers un voisin traverse `forward`, et
        # c'est ici qu'on le ferme. MESURÉ le 2026-09-17 : 3 échos livrés par le
        # détour sans cette règle, 0 avec — le drop survit à l'accept d'Incus.
        "  chain forward {\n"
        "    type filter hook forward priority 10; policy accept;\n"
        "    ct state established,related accept\n"
        f'    iifname "{bridge}" oifname "{bridge}" drop\n'
        # SPK-110 · §58.3 : rien n'est routé DEPUIS ni VERS un réseau privé —
        # ni Internet, ni sparkbr0, ni un autre réseau. Entre membres, tout est
        # commuté et ne passe pas par là. MESURÉ le 2026-09-18 : sans ces
        # lignes, une cellule du réseau privé joignait le SSO sur sparkbr0.
        f'    iifname "{prive}" drop\n'
        f'    oifname "{prive}" drop\n'
        "  }\n"
        "}\n"
    )


def regles(bridge: str, chaine: str = "input") -> list[str]:
    """Les seules lignes qui filtrent dans UNE chaîne, sans l'enveloppe — pour
    un relevé ou un remède qui les cite."""
    lignes: list[str] = []
    dedans = False
    for brut in rendre(bridge).splitlines():
        ligne = brut.strip()
        if ligne.startswith("chain "):
            dedans = ligne == f"chain {chaine} {{"
            continue
        if dedans and ligne and not ligne.startswith(("type ", "}")):
            lignes.append(ligne)
    return lignes


def _ecrire_si_change(chemin: Path, contenu: str, mode: int) -> bool:
    try:
        if (chemin.read_text(encoding="utf-8") == contenu
                and (chemin.stat().st_mode & 0o777) == mode):
            return False
    except OSError:
        pass
    chemin.parent.mkdir(parents=True, exist_ok=True)
    temporaire = chemin.with_name(f".{chemin.name}.tmp")
    temporaire.write_text(contenu, encoding="utf-8")
    temporaire.chmod(mode)
    temporaire.replace(chemin)
    return True


def ecrire(bridge: str, *, racine: Path = Path("/")) -> dict[str, bool]:
    """Pose les deux fichiers s'ils diffèrent, et dit lesquels ont changé.

    N'exécute rien : l'installateur du paquet recharge systemd lui-même, et la
    phase d'installation d'une Forge appelle `activer` ensuite.
    """
    return {
        "regles": _ecrire_si_change(racine / CHEMIN_REGLES, rendre(bridge), 0o644),
        "unite": _ecrire_si_change(racine / CHEMIN_UNITE, TEXTE_UNITE, 0o644),
    }


def activer(changement: dict[str, bool], executer: Executeur, *,
            daemon_recharge: bool = False) -> list[list[str]]:
    """Recharge ce qui a changé, et rien d'autre. Rend les commandes passées.

    `enable --now` pose l'unité au premier passage et ne fait rien ensuite ;
    `reload-or-restart` applique le fichier nouveau à une unité déjà active —
    et démarre celle qui ne l'est pas encore. Une pose identique ne passe
    AUCUNE commande : c'est ce que l'installation rejouée doit garantir.
    """
    commandes: list[list[str]] = []
    if changement["unite"] and not daemon_recharge:
        commandes.append(["systemctl", "daemon-reload"])
    if changement["unite"] or changement["regles"]:
        commandes.append(["systemctl", "enable", "--now", UNITE])
        commandes.append(["systemctl", "reload-or-restart", UNITE])
    for commande in commandes:
        executer(commande)
    return commandes


def poser(bridge: str, *, racine: Path = Path("/"), executer: Executeur) -> dict[str, object]:
    """Écrit puis active : la forme qu'emploie la phase d'installation."""
    changement = ecrire(bridge, racine=racine)
    commandes = activer(changement, executer)
    return {"changed": any(changement.values()), "commandes": commandes}
