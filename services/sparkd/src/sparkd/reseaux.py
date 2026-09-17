"""Les réseaux privés : un commutateur de la Forge auquel on attache des Sparks.

@spec docs/BACKLOG.md#SPK-110 · docs/DAT.md §58.1 (l'objet et ses mots), §58.2
      (le modèle : sous-réseau et adresses attribués par le registre, un nom
      DNS), §58.3 (un réseau géré d'Incus sans NAT, un device NIC par adhésion,
      le pool porté par la migration), §58.4 (les gestes et leurs refus), §58.6
      (ce que le produit pose dans la cellule — mesuré le 2026-09-18) ·
      docs/SCHEMA.md §6 ter · §14.2 (le registre s'écrit avant Incus), §15.1,
      §15.3 (attribution déterministe, épuisement explicite), §35.2

Le registre attribue, Incus épingle, et le produit configure l'interface dans
la cellule quand la famille le permet. Rien ici ne pose de règle netfilter : la
table `spark_filter` couvre `spn*` par joker (`pare_feu`), une interface de plus
n'est pas une règle de plus.
"""

from __future__ import annotations

import ipaddress
import re
import secrets
import sqlite3
from datetime import datetime, timezone
from typing import Any

from . import audit
from . import bootstrap
from .incus import IncusError, InstanceAbsente
from .pare_feu import PREFIXE_RESEAU_PRIVE

#: Un nom de réseau est un nom DNS (§58.3) : `dns.domain` d'Incus le porte, et
#: les membres se nomment `<spark>.<réseau>`.
NOM = re.compile(r"^[a-z][a-z0-9-]{0,30}$")
#: La valeur du 2026-09-17, portée par la migration 018 (§58.3). Lue ici SEULEMENT
#: si la ligne `forge` n'existe pas encore — jamais une variable d'environnement.
POOL_DEFAUT = "10.78.0.0/16"
#: Le plan du §15.2, transposé à un /24 : `.1` passerelle, `.16`–`.239` registre,
#: `.240`–`.254` dynamique hors produit.
PREMIER_HOTE, DERNIER_HOTE = 16, 239
DHCP_PREMIER, DHCP_DERNIER = 240, 254

#: Ce que le produit pose DANS la cellule (§58.6). Un seul fichier pour tous les
#: réseaux privés ; `UseGateway=no` et `UseRoutes=no` parce que le DHCP d'un
#: réseau privé annonce une passerelle et que la cellule prenait une seconde
#: route par défaut — mesuré le 2026-09-18.
FICHIER_NETWORKD = "/etc/systemd/network/50-spark-reseaux-prives.network"
DROPIN_NETWORKD = (
    "# Posé par sparkd (docs/DAT.md §58.6) : les interfaces des réseaux privés\n"
    "# reçoivent par DHCP l'adresse que le registre a épinglée, le résolveur du\n"
    "# réseau et son domaine — jamais une route.\n"
    f"[Match]\nName={PREFIXE_RESEAU_PRIVE}*\n\n"
    "[Network]\nDHCP=ipv4\n\n"
    "[DHCPv4]\nUseGateway=no\nUseRoutes=no\nUseDNS=yes\nUseDomains=yes\n"
)


class ReseauError(RuntimeError):
    """Le geste est refusé, et la raison se lit."""


class ReseauIntrouvable(ReseauError):
    """Aucun réseau privé de ce nom."""


class PoolEpuise(ReseauError):
    """Plus un seul sous-réseau libre sur le pool."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _audit(connection, action, target_type, target_id, payload, result="ok", message=""):
    audit.record(connection, None, action, result, message,
                 target_type=target_type, target_id=target_id, payload=payload)


# --- le pool et l'attribution ---------------------------------------------------


def pool(connection: sqlite3.Connection) -> ipaddress.IPv4Network:
    """Le pool des réseaux privés, tel que la ligne `forge` le porte."""
    try:
        row = connection.execute("SELECT private_pool_cidr FROM forge WHERE id = 1").fetchone()
    except sqlite3.OperationalError:
        row = None
    return ipaddress.IPv4Network(row[0] if row and row[0] else POOL_DEFAUT, strict=False)


def sous_reseaux(reserve: ipaddress.IPv4Network) -> list[ipaddress.IPv4Network]:
    """Les /24 attribuables du pool, dans l'ordre. Le premier est laissé de
    côté : `spn0` et `10.78.0.0/24` se lisent comme « aucun »."""
    if reserve.prefixlen > 24:
        return []
    return list(reserve.subnets(new_prefix=24))[1:]


def interface(cidr: str) -> str:
    """`spn<n>` pour `10.78.<n>.0/24` — le même nom sur la Forge et dans la
    cellule, sous les 15 caractères d'un nom d'interface (§58.2)."""
    reseau = ipaddress.IPv4Network(cidr)
    return f"{PREFIXE_RESEAU_PRIVE}{int(reseau.network_address) >> 8 & 0xFF}"


def passerelle(cidr: str) -> str:
    return str(ipaddress.IPv4Network(cidr).network_address + 1)


def plage_dhcp(cidr: str) -> str:
    base = ipaddress.IPv4Network(cidr).network_address
    return f"{base + DHCP_PREMIER}-{base + DHCP_DERNIER}"


def usage(connection: sqlite3.Connection) -> dict[str, Any]:
    reserve = pool(connection)
    capacite = len(sous_reseaux(reserve))
    occupes = connection.execute("SELECT COUNT(*) FROM private_network").fetchone()[0]
    return {"cidr": str(reserve), "capacity": capacite, "used": occupes,
            "free": max(capacite - occupes, 0)}


def _attribuer_sous_reseau(connection: sqlite3.Connection) -> str:
    """Le plus petit sous-réseau libre, ou un refus qui nomme l'épuisement
    (§15.3 transposé)."""
    pris = {row[0] for row in connection.execute("SELECT cidr FROM private_network")}
    reserve = pool(connection)
    for candidat in sous_reseaux(reserve):
        if str(candidat) not in pris:
            return str(candidat)
    raise PoolEpuise(
        f"Pool des réseaux privés épuisé : les {len(sous_reseaux(reserve))} "
        f"sous-réseaux de {reserve} sont attribués. Supprimer un réseau, ou "
        "élargir le pool.")


def _attribuer_adresse(connection: sqlite3.Connection, network_id: str, cidr: str) -> str:
    base = ipaddress.IPv4Network(cidr).network_address
    prises = {row[0] for row in connection.execute(
        "SELECT ipv4_address FROM private_network_member WHERE network_id = ?", (network_id,))}
    for hote in range(PREMIER_HOTE, DERNIER_HOTE + 1):
        candidate = str(base + hote)
        if candidate not in prises:
            return candidate
    raise ReseauError(
        f"Réseau {cidr} plein : les {DERNIER_HOTE - PREMIER_HOTE + 1} adresses "
        "de membre sont attribuées.")


# --- lecture --------------------------------------------------------------------


def _membres(connection: sqlite3.Connection, network_id: str) -> list[dict[str, Any]]:
    return [
        {"spark": row["name"], "spark_id": row["spark_id"],
         "ipv4_address": row["ipv4_address"], "applied_at": row["applied_at"],
         "cell_configured": bool(row["cell_configured"]), "cell_note": row["cell_note"],
         # §35.4 : l'état protégé se lit partout où le Spark est listé — ici
         # c'est lui qui refusera le détachement, et l'écran doit le dire.
         "protected": row["protected_at"] is not None}
        for row in connection.execute(
            "SELECT m.*, s.name, s.protected_at FROM private_network_member m "
            "JOIN spark s ON s.id = m.spark_id WHERE m.network_id = ? ORDER BY s.name",
            (network_id,))
    ]


def _decorer(connection: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"], "name": row["name"], "cidr": row["cidr"],
        "interface": interface(row["cidr"]), "gateway": passerelle(row["cidr"]),
        "note": row["note"], "applied_at": row["applied_at"], "created_at": row["created_at"],
        "members": _membres(connection, row["id"]),
        # SPK-111 donnera aux liens leur portée ; jusque-là un réseau n'en porte
        # aucun, et le refus de suppression ne compte que les membres.
        "links": 0,
    }


def listing(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    return [_decorer(connection, row) for row in connection.execute(
        "SELECT * FROM private_network ORDER BY name")]


def by_name(connection: sqlite3.Connection, name: str) -> dict[str, Any]:
    row = connection.execute("SELECT * FROM private_network WHERE name = ?", (name,)).fetchone()
    if row is None:
        raise ReseauIntrouvable(f"Aucun réseau privé « {name} ».")
    return _decorer(connection, row)


def for_spark(connection: sqlite3.Connection, spark_id: str) -> list[dict[str, Any]]:
    """Les adhésions d'UN Spark, pour son dossier."""
    return [
        {"network": row["name"], "network_id": row["network_id"], "cidr": row["cidr"],
         "interface": interface(row["cidr"]), "gateway": passerelle(row["cidr"]),
         "ipv4_address": row["ipv4_address"], "applied_at": row["applied_at"],
         "cell_configured": bool(row["cell_configured"]), "cell_note": row["cell_note"]}
        for row in connection.execute(
            "SELECT m.*, n.name, n.cidr FROM private_network_member m "
            "JOIN private_network n ON n.id = m.network_id WHERE m.spark_id = ? "
            "ORDER BY n.name", (spark_id,))
    ]


# --- ce qui se pose chez Incus et dans la cellule --------------------------------


def _device(cidr: str, adresse: str) -> dict[str, str]:
    """Le device NIC d'un membre (§58.3) : sans isolation de port — c'est le
    point du réseau —, avec l'anti-usurpation, sans plafond de débit."""
    return {"type": "nic", "network": interface(cidr), "name": interface(cidr),
            "ipv4.address": adresse, "security.ipv4_filtering": "true"}


def _en_marche(incus, incus_name: str) -> bool:
    etat = incus.instance_state(incus_name)
    meta = etat.get("metadata") or etat
    return str(meta.get("status", "")).lower() == "running"


#: Les deux emplacements d'`os-release`, dans l'ordre de la spécification :
#: `/etc/os-release` d'abord, `/usr/lib/os-release` sinon. MESURÉ sur la Forge le
#: 2026-09-18 : sur Ubuntu comme sur Debian, le premier est un LIEN vers le
#: second, et l'API de fichiers d'Incus rend la cible du lien, pas son contenu —
#: lire le premier seul donnait « famille non lue ».
FICHIERS_OS_RELEASE = ("/etc/os-release", "/usr/lib/os-release")


def _famille_cellule_arretee(incus, incus_name: str) -> tuple[Any, dict[str, str]]:
    """Une cellule arrêtée n'exécute rien : sa famille se lit dans son
    `os-release`, par le chemin des fichiers, qui ne demande pas qu'elle
    tourne (§58.6). Rend `(famille, brut)` — `brut` au format du relevé de
    l'amorçage, pour que `famille_de` soit la SEULE lecture de la famille."""
    valeurs: dict[str, str] = {}
    for chemin in FICHIERS_OS_RELEASE:
        contenu = incus.pull_file(incus_name, chemin) or ""
        for ligne in contenu.splitlines():
            cle, separateur, valeur = ligne.partition("=")
            if separateur:
                valeurs[cle.strip()] = valeur.strip().strip('"')
        if valeurs.get("ID"):
            break
    brut = {"os_id": valeurs.get("ID", ""), "os_like": valeurs.get("ID_LIKE", "")}
    return bootstrap.famille_de(brut), brut


def _configurer_cellule(incus, incus_name: str, iface: str) -> tuple[bool, str]:
    """Pose le drop-in networkd et recharge, si la famille le permet (§58.6).

    Rend `(configuré, note)`. Une famille sans networkd n'est pas une panne :
    le device et l'adresse sont posés, et l'adhésion DIT que l'interface reste
    à configurer par le locataire.

    Une cellule ARRÊTÉE reçoit le fichier sans rechargement — networkd le lit
    au démarrage —, et l'adhésion le dit : « configuration posée, prise au
    démarrage ». Sa famille se lit dans son `/etc/os-release`, puisque rien ne
    peut s'y exécuter.
    """
    try:
        en_marche = _en_marche(incus, incus_name)
        if en_marche:
            brut = bootstrap.releve_brut(incus, incus_name)
            famille = bootstrap.famille_de(brut)
        else:
            famille, brut = _famille_cellule_arretee(incus, incus_name)
            if not brut.get("os_id"):
                return False, ("interface non configurée dans la cellule : cellule arrêtée, "
                               "famille non lue dans os-release")
        if famille is None or famille.services != "systemd":
            identite = brut.get("os_id") or "inconnue"
            return False, f"interface non configurée dans la cellule : famille sans networkd ({identite})"
        incus.push_file(incus_name, FICHIER_NETWORKD, DROPIN_NETWORKD, mode="0644")
        if not en_marche:
            return True, "cellule arrêtée : configuration posée, prise au démarrage"
        incus.exec_command(incus_name, ["sh", "-c",
                                         f"networkctl reload && networkctl reconfigure {iface}"])
        return True, ""
    except (IncusError, InstanceAbsente) as erreur:
        return False, f"interface non configurée dans la cellule : {erreur}"


def _poser(connection: sqlite3.Connection, incus, network: dict[str, Any],
           spark: dict[str, Any], adresse: str) -> None:
    iface = network["interface"]
    incus.update_device_config(spark["incus_name"], iface, _device(network["cidr"], adresse))
    configure, note = _configurer_cellule(incus, spark["incus_name"], iface)
    connection.execute(
        "UPDATE private_network_member SET applied_at = ?, cell_configured = ?, "
        "cell_note = ? WHERE network_id = ? AND spark_id = ?",
        (_now(), 1 if configure else 0, note, network["id"], spark["id"]))


def apply_memberships(connection: sqlite3.Connection, incus, spark: dict[str, Any]) -> int:
    """Pose les adhésions déclarées AVANT que la cellule n'existe (§14.2 : on
    déclare avant de créer). Rend le nombre d'adhésions posées."""
    if not spark.get("incus_name"):
        return 0
    posees = 0
    for adhesion in for_spark(connection, spark["id"]):
        if adhesion["applied_at"]:
            continue
        network = by_name(connection, adhesion["network"])
        _poser(connection, incus, network, spark, adhesion["ipv4_address"])
        posees += 1
    return posees


# --- les gestes -------------------------------------------------------------------


def create(connection: sqlite3.Connection, incus, name: str, note: str = "") -> dict[str, Any]:
    """Crée un réseau privé : le registre d'abord, Incus ensuite (§14.2)."""
    if not NOM.match(name or ""):
        raise ReseauError(
            f"Nom « {name} » refusé : un réseau privé porte un nom DNS — minuscules, "
            "chiffres et tirets, 31 caractères au plus, une lettre en tête.")
    if connection.execute("SELECT 1 FROM private_network WHERE name = ?", (name,)).fetchone():
        raise ReseauError(f"Un réseau privé « {name} » existe déjà.")
    cidr = _attribuer_sous_reseau(connection)
    identifiant = secrets.token_hex(12)
    connection.execute(
        "INSERT INTO private_network (id, name, cidr, note, created_at) VALUES (?, ?, ?, ?, ?)",
        (identifiant, name, cidr, note or "", _now()))
    try:
        incus.create_network(interface(cidr), {
            "ipv4.address": f"{passerelle(cidr)}/24",
            "ipv4.nat": "false",
            "ipv6.address": "none",
            "ipv4.dhcp.ranges": plage_dhcp(cidr),
            "dns.domain": name,
        })
    except IncusError as erreur:
        # Un réseau sans bridge n'est qu'un nom qui bloque un sous-réseau : la
        # ligne est retirée et le refus du pilote est rendu tel quel.
        connection.execute("DELETE FROM private_network WHERE id = ?", (identifiant,))
        raise ReseauError(f"Le pilote a refusé de créer le réseau « {name} » : {erreur}") from erreur
    connection.execute("UPDATE private_network SET applied_at = ? WHERE id = ?",
                       (_now(), identifiant))
    _audit(connection, "network.create", "network", identifiant,
           {"name": name, "cidr": cidr, "interface": interface(cidr)},
           message=f"réseau privé « {name} » créé sur {cidr}")
    return by_name(connection, name)


def delete(connection: sqlite3.Connection, incus, name: str) -> None:
    """Supprime un réseau VIDE. Habité, le refus nomme ce qui reste (§58.4)."""
    network = by_name(connection, name)
    if network["members"]:
        noms = ", ".join(m["spark"] for m in network["members"])
        motif = f"Le réseau « {name} » a encore des membres : {noms}. Détachez-les d'abord."
        # Un geste destructif refusé est un fait du journal (§21.1) : la trace
        # est écrite AVANT de lever, et la connexion est en autocommit.
        _audit(connection, "network.delete", "network", network["id"],
               {"name": name, "members": [m["spark"] for m in network["members"]]},
               result="denied", message=motif)
        raise ReseauError(motif)
    if network["links"]:
        raise ReseauError(f"Le réseau « {name} » porte encore {network['links']} lien(s).")
    try:
        incus.delete_network(network["interface"])
    except InstanceAbsente:
        pass  # déjà parti : la suppression est acquise, la ligne suit
    except IncusError as erreur:
        raise ReseauError(f"Le pilote a refusé de supprimer « {name} » : {erreur}") from erreur
    connection.execute("DELETE FROM private_network WHERE id = ?", (network["id"],))
    _audit(connection, "network.delete", "network", network["id"],
           {"name": name, "cidr": network["cidr"]}, message=f"réseau privé « {name} » supprimé")


def attach(connection: sqlite3.Connection, incus, name: str, spark: dict[str, Any]) -> dict[str, Any]:
    """Attache un Spark : adresse attribuée, ligne écrite, device posé si la
    cellule existe. La protection est vérifiée par l'appelant (§35.2)."""
    network = by_name(connection, name)
    if any(m["spark_id"] == spark["id"] for m in network["members"]):
        raise ReseauError(f"« {spark['name']} » est déjà membre de « {name} ».")
    adresse = _attribuer_adresse(connection, network["id"], network["cidr"])
    connection.execute(
        "INSERT INTO private_network_member (network_id, spark_id, ipv4_address, created_at) "
        "VALUES (?, ?, ?, ?)", (network["id"], spark["id"], adresse, _now()))
    if spark.get("incus_name"):
        try:
            _poser(connection, incus, network, spark, adresse)
        except (IncusError, InstanceAbsente) as erreur:
            # La ligne reste : l'écart se voit par `applied_at` (§18.5, §39.5),
            # et la prochaine application le comble.
            _audit(connection, "network.attach", "spark", spark["id"],
                   {"network": name, "ipv4_address": adresse}, result="error", message=str(erreur))
            raise ReseauError(
                f"Le pilote a refusé de poser l'interface de « {spark['name']} » : {erreur}") from erreur
    _audit(connection, "network.attach", "spark", spark["id"],
           {"network": name, "ipv4_address": adresse},
           message=f"« {spark['name']} » attaché à « {name} » en {adresse}")
    return next(m for m in by_name(connection, name)["members"] if m["spark_id"] == spark["id"])


def detach(connection: sqlite3.Connection, incus, name: str, spark: dict[str, Any]) -> None:
    network = by_name(connection, name)
    if not any(m["spark_id"] == spark["id"] for m in network["members"]):
        raise ReseauError(f"« {spark['name']} » n'est pas membre de « {name} ».")
    if spark.get("incus_name"):
        try:
            incus.remove_device(spark["incus_name"], network["interface"])
        except InstanceAbsente:
            pass
        except IncusError as erreur:
            raise ReseauError(
                f"Le pilote a refusé de retirer l'interface de « {spark['name']} » : {erreur}") from erreur
    connection.execute(
        "DELETE FROM private_network_member WHERE network_id = ? AND spark_id = ?",
        (network["id"], spark["id"]))
    _audit(connection, "network.detach", "spark", spark["id"], {"network": name},
           message=f"« {spark['name']} » détaché de « {name} »")
