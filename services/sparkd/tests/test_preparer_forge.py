"""Preuves de la commande qui produit le schema de partitionnement et le cloud-init.

@verifies docs/BACKLOG.md#SPK-158 · docs/DAT.md §66.2 a §66.5 (la decision, la regle
          de derivation, le cloud-init produit, la preuve), §66.7 (les schemas par
          defaut des offres sont versionnes), §66.8 (le pool est declare a
          l'hebergeur ; le JSON de partition de chaque offre est versionne, le
          cloud-init ne l'est PAS), §8.5, §8.6 · README.md (« Commander
          une Forge ») · scripts/README.md · deploy/cloud-init/offres/README.md

Ce que ces preuves gardent, et ce qu'elles ne gardent PAS :

- la regle de derivation, sur les VRAIS schemas par defaut releves chez l'hebergeur
  et versionnes sous deploy/cloud-init/offres/ (EM-L101X-SATA le 2026-11-10,
  EM-B311X-SATA le 2026-11-16) — pas sur un schema que ce fichier aurait lui-meme
  invente — et CHAQUE fichier de ce dossier est derive ;
- le cloud-init, relu avec PyYAML, la bibliotheque que cloud-init emploie : le
  contenu embarque est IDENTIQUE aux sources, et la ligne `runcmd` est acceptee
  par le VRAI analyseur d'arguments de l'amorce embarquee ;
- la commande, lancee comme un utilisateur : fichier, entree standard, codes de
  sortie, et rien sur la sortie standard en cas de refus.

Les schemas NVMe et UEFI sont CONSTRUITS ici d'apres la forme du defaut BIOS : ils
n'ont pas ete releves chez l'hebergeur, et le disent. Ils eprouvent la regle, pas
l'offre. Que l'hebergeur ACCEPTE la sortie reste a constater par un humain
(docs/BACKLOG.md#SPK-158, « Reste »).
"""

from __future__ import annotations

import copy
import importlib.util
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

RACINE = Path(__file__).resolve().parents[3]
COMMANDE = RACINE / "scripts" / "preparer-forge.py"
OFFRES_DIR = RACINE / "deploy" / "cloud-init" / "offres"
OFFRES = sorted(OFFRES_DIR.glob("*.json"))
#: La reference des preuves a structure exacte : le premier schema releve.
DEFAUT = OFFRES_DIR / "EM-L101X-SATA.json"
AMORCE = RACINE / "deploy" / "cloud-init" / "spark-amorce.sh"
CREER_POOL = RACINE / "scripts" / "creer-pool.sh"

_spec = importlib.util.spec_from_file_location("preparer_forge", COMMANDE)
pf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pf)

# Enumerations fermees de `scaleway.baremetal.v1.Schema`. Un libelle invente —
# « bios », « pool » — est refuse par l'hebergeur, et rien dans le depot ne le
# dirait avant la commande d'une machine (journal du 2026-08-28).
LIBELLES = {"unknown_partition_label", "uefi", "legacy", "root",
            "boot", "swap", "data", "home", "raid", "zfs"}
FORMATS = {"unknown_format", "fat32", "ext4", "swap", "zfs", "xfs"}
NIVEAUX_RAID = {"unknown_raid_level", "raid_level_0", "raid_level_1",
                "raid_level_5", "raid_level_6", "raid_level_10"}


def defaut() -> dict:
    return json.loads(DEFAUT.read_text(encoding="utf-8"))


def _en_nvme(schema: dict) -> dict:
    """sda/sdb -> nvme0n1/nvme1n1, partitions comprises (CONSTRUIT, non releve)."""
    texte = json.dumps(schema)
    texte = re.sub(r"/dev/sd([ab])(\d)", lambda m: f"/dev/nvme{ord(m[1]) - 97}n1p{m[2]}", texte)
    texte = re.sub(r'/dev/sd([ab])"', lambda m: f'/dev/nvme{ord(m[1]) - 97}n1"', texte)
    return json.loads(texte)


def _en_uefi(schema: dict) -> dict:
    """`legacy` -> `uefi`, avec son /boot/efi en fat32 (CONSTRUIT, non releve)."""
    s = copy.deepcopy(schema)
    for disque in s["disks"]:
        disque["partitions"][0]["label"] = "uefi"
    s["filesystems"].append({"device": "/dev/sda1", "format": "fat32", "mountpoint": "/boot/efi"})
    return s


# --- La regle de derivation (DAT §66.3) ------------------------------------------


PARTITIONS_ATTENDUES = [
    {"label": "legacy", "number": 1, "size": 536870912, "useAllAvailableSpace": False},
    {"label": "swap", "number": 2, "size": 4294967296, "useAllAvailableSpace": False},
    {"label": "boot", "number": 3, "size": 536870912, "useAllAvailableSpace": False},
    {"label": "root", "number": 4, "size": 214748364800, "useAllAvailableSpace": False},
    {"label": "zfs", "number": 5, "size": 0, "useAllAvailableSpace": True},
]
#: Le repli `--sans-zfs` : la meme chose, la partition du pool s'appelle `data`.
PARTITIONS_ATTENDUES_SANS_ZFS = PARTITIONS_ATTENDUES[:-1] + [
    {"label": "data", "number": 5, "size": 0, "useAllAvailableSpace": True}]
#: La section `zfs` que la commande ecrit : name, type, devices — et RIEN d'autre (§66.8).
ZFS_ATTENDU = {"pools": [{"name": "spark", "type": "mirror",
                          "devices": ["/dev/sda5", "/dev/sdb5"]}]}
TYPES_DE_POOL = {"unknown_type", "no_raid", "mirror", "raidz1", "raidz2"}


def test_le_defaut_REEL_donne_le_schema_POUR_LA_FORGE_avec_le_pool_declare():
    """DAT §66.8 : le schema produit est celui de la Forge — la partition 5 est `zfs`
    et la section `zfs` declare le miroir `spark` sur les deux partitions."""
    schema, supports = pf.deriver(defaut(), 200)
    assert list(schema) == ["disks", "filesystems", "raids", "zfs"]
    assert [d["device"] for d in schema["disks"]] == ["/dev/sda", "/dev/sdb"]
    for disque in schema["disks"]:
        assert disque["partitions"] == PARTITIONS_ATTENDUES, disque["device"]
    assert schema["zfs"] == ZFS_ATTENDU
    assert schema["filesystems"] == defaut()["filesystems"], "recopie telle quelle"
    assert schema["raids"] == defaut()["raids"], "recopie telle quelle"
    assert supports == ["/dev/sda5", "/dev/sdb5"]


def test_le_repli_SANS_ZFS_donne_le_schema_que_la_console_a_valide():
    """A la mise en forme pres, c'est le JSON que la console de l'hebergeur a
    affiche « correct and can be applied » le 2026-11-10 (capture du responsable) :
    `root` bornee a 200 Gio, `data` prenant le reste, aucun pool declare."""
    schema, supports = pf.deriver(defaut(), 200, declarer_zfs=False)
    assert list(schema) == ["disks", "filesystems", "raids"], "aucune cle ajoutee ni perdue"
    for disque in schema["disks"]:
        assert disque["partitions"] == PARTITIONS_ATTENDUES_SANS_ZFS, disque["device"]
    assert not schema.get("zfs")
    assert supports == ["/dev/sda5", "/dev/sdb5"]


def test_la_section_zfs_n_ecrit_QUE_name_type_et_devices():
    """Le format des chaines `options` / `filesystem_options` n'est pas documente, et
    leur cle dans le dialecte de la console est une deduction : elles ne s'ecrivent
    pas (DAT §66.8). Une cle devinee peut etre refusee, une cle absente vaut vide."""
    pool = pf.deriver(defaut(), 200)[0]["zfs"]["pools"][0]
    assert set(pool) == {"name", "type", "devices"}
    assert pool["type"] in TYPES_DE_POOL and pool["type"] == "mirror"


def test_le_nom_du_pool_de_la_commande_est_celui_de_l_amorce():
    """Deux textes, un seul nom : le registre attend « spark »."""
    amorce = AMORCE.read_text(encoding="utf-8")
    assert re.search(r"^POOL=(\S+)", amorce, re.M)[1] == pf.NOM_POOL == "spark"


def test_les_deux_offres_relevees_sont_versionnees_et_decrites_au_README_du_dossier():
    noms = {f.name for f in OFFRES}
    assert {"EM-L101X-SATA.json", "EM-B311X-SATA.json"} <= noms, noms
    readme = (OFFRES_DIR / "README.md").read_text(encoding="utf-8")
    for f in OFFRES:
        assert f.name in readme, f"{f.name} doit figurer au tableau du README du dossier"


def test_les_deux_offres_relevees_ne_different_que_par_la_cle_zfs():
    """C'est ce que le responsable a releve, et ce que le README du dossier dit."""
    a = json.loads((OFFRES_DIR / "EM-L101X-SATA.json").read_text(encoding="utf-8"))
    b = json.loads((OFFRES_DIR / "EM-B311X-SATA.json").read_text(encoding="utf-8"))
    assert "zfs" not in a and b["zfs"] is None
    assert {**a, "zfs": None} == b


@pytest.mark.parametrize("nom", ["EM-L101X-SATA.json", "EM-B311X-SATA.json"])
def test_chaque_offre_RELEVEE_donne_les_partitions_attendues_et_le_pool_declare(nom):
    brut = json.loads((OFFRES_DIR / nom).read_text(encoding="utf-8"))
    schema, supports = pf.deriver(brut, 200)
    for disque in schema["disks"]:
        assert disque["partitions"] == PARTITIONS_ATTENDUES, disque["device"]
    assert schema["zfs"] == ZFS_ATTENDU, "la cle `zfs` de l'offre (absente ou nulle) devient le pool"
    assert supports == ["/dev/sda5", "/dev/sdb5"]


@pytest.mark.parametrize("nom", ["EM-L101X-SATA.json", "EM-B311X-SATA.json"])
def test_le_repli_sans_zfs_garde_la_cle_zfs_de_l_offre_telle_quelle(nom):
    brut = json.loads((OFFRES_DIR / nom).read_text(encoding="utf-8"))
    schema, _ = pf.deriver(brut, 200, declarer_zfs=False)
    assert schema.get("zfs", "absente") == brut.get("zfs", "absente")


@pytest.mark.parametrize("offre", OFFRES, ids=lambda f: f.stem)
def test_CHAQUE_offre_versionnee_se_derive_selon_la_regle(offre):
    """Une offre ajoutee dont le defaut sort de la regle du §66.3 est refusee ICI,
    avec ses mots, avant qu'on commande la machine (DAT §66.7)."""
    brut = json.loads(offre.read_text(encoding="utf-8"))
    schema, supports = pf.deriver(brut, 200)
    assert len(supports) == 2 and all(pf.SUPPORT_SUR.fullmatch(s) for s in supports)
    assert set(schema) == set(brut) | {"zfs"}, "seule la cle `zfs` peut s'ajouter"
    assert schema["zfs"]["pools"][0]["devices"] == supports
    for cle in brut:
        if cle not in ("disks", "zfs"):
            assert schema[cle] == brut[cle], f"« {cle} » est recopie tel quel"
    for disque, avant in zip(schema["disks"], brut["disks"]):
        assert disque["partitions"][-1]["label"] == "zfs"
        assert disque["partitions"][:len(avant["partitions"]) - 1] == avant["partitions"][:-1]


def test_le_schema_par_defaut_n_est_JAMAIS_modifie():
    entree = defaut()
    avant = copy.deepcopy(entree)
    pf.deriver(entree, 200)
    assert entree == avant


@pytest.mark.parametrize("gio", [1, 100, 200, 512])
def test_la_taille_de_root_est_celle_demandee_en_Gio(gio):
    schema, _ = pf.deriver(defaut(), gio)
    for disque in schema["disks"]:
        root = next(p for p in disque["partitions"] if p["label"] == "root")
        assert root["size"] == gio * 1024 ** 3 and root["useAllAvailableSpace"] is False


def test_un_disque_NVMe_donne_des_supports_avec_le_p_de_partition():
    schema, supports = pf.deriver(_en_nvme(defaut()), 200)
    assert supports == ["/dev/nvme0n1p5", "/dev/nvme1n1p5"]
    assert [d["device"] for d in schema["disks"]] == ["/dev/nvme0n1", "/dev/nvme1n1"]
    assert "/dev/nvme0n1p3" in schema["raids"][0]["devices"], "les RAID restent ceux du defaut"
    assert schema["zfs"]["pools"][0]["devices"] == supports, "le pool est declare sur les memes supports"


def test_une_machine_UEFI_garde_sa_partition_uefi_et_son_boot_efi():
    schema, supports = pf.deriver(_en_uefi(defaut()), 200)
    assert [d["partitions"][0]["label"] for d in schema["disks"]] == ["uefi", "uefi"]
    assert {"device": "/dev/sda1", "format": "fat32", "mountpoint": "/boot/efi"} in schema["filesystems"]
    assert supports == ["/dev/sda5", "/dev/sdb5"]


def test_le_dialecte_snake_case_est_CONSERVE():
    """Le contrat de l'API ecrit `use_all_available_space`, la console
    `useAllAvailableSpace` : la commande reprend celui du schema qu'on lui donne."""
    entree = json.loads(json.dumps(defaut()).replace("useAllAvailableSpace", "use_all_available_space"))
    schema, _ = pf.deriver(entree, 200)
    texte = json.dumps(schema)
    assert "useAllAvailableSpace" not in texte
    derniere = schema["disks"][0]["partitions"][-1]
    assert derniere == {"label": "zfs", "number": 5, "size": 0, "use_all_available_space": True}
    assert schema["zfs"] == ZFS_ATTENDU


def _sans(schema, chemin):
    s = copy.deepcopy(schema)
    chemin(s)
    return s


REFUS = [
    ("un seul disque", lambda s: s.update(disks=s["disks"][:1]), "deux disques"),
    ("un pool zfs deja declare", lambda s: s.update(zfs={"pools": [{"name": "spark"}]}), "« zfs »"),
    ("deux partitions qui prennent le reste",
     lambda s: s["disks"][0]["partitions"][2].update(useAllAvailableSpace=True), "exactement une"),
    ("aucune partition qui prend le reste",
     lambda s: s["disks"][1]["partitions"][3].update(useAllAvailableSpace=False), "exactement une"),
    ("la partition qui prend le reste n'est pas la derniere",
     lambda s: s["disks"][0]["partitions"].append(
         {"label": "home", "number": 5, "size": 1, "useAllAvailableSpace": False}), "pas la derniere"),
    ("la partition qui prend le reste n'est pas root",
     lambda s: s["disks"][0]["partitions"][3].update(label="home"), "pas « root »"),
    ("un support deja confie a un RAID",
     lambda s: s["raids"].append({"devices": ["/dev/sda5", "/dev/sdb5"], "level": "raid_level_1",
                                  "name": "/dev/md2"}), "peripheriques nus"),
    ("un disque sans device", lambda s: s["disks"][0].pop("device"), "device"),
    ("une partition sans number", lambda s: s["disks"][0]["partitions"][0].pop("number"), "number"),
]


@pytest.mark.parametrize("nom, mutation, attendu", REFUS, ids=[r[0] for r in REFUS])
def test_chaque_entree_hors_regle_est_REFUSEE_avec_ses_mots(nom, mutation, attendu):
    with pytest.raises(pf.Refus) as refus:
        pf.deriver(_sans(defaut(), mutation), 200)
    assert attendu in str(refus.value)


@pytest.mark.parametrize("entree", [[], "x", 3, None, {"disks": "sda"}, {}])
def test_une_entree_qui_n_est_pas_un_schema_est_refusee(entree):
    with pytest.raises(pf.Refus, match="objet JSON"):
        pf.deriver(entree, 200)


@pytest.mark.parametrize("declarer", [True, False], ids=["pool declare", "--sans-zfs"])
def test_appliquer_la_commande_a_sa_propre_sortie_est_REFUSE(declarer):
    """Le schema derive n'a plus de partition « reste » : le redonner par erreur
    ne doit pas ajouter une partition de plus, il doit dire pourquoi."""
    derive, _ = pf.deriver(defaut(), 200, declarer)
    with pytest.raises(pf.Refus, match="deja derive"):
        pf.deriver(derive, 200)


# --- La forme que l'hebergeur attend (DAT §8.6, journal du 2026-08-28) -----------
#
# Ces propriétés étaient gardées sur le JSON du README ; elles le sont désormais sur
# la SORTIE de la commande, qui est ce que l'exploitant colle dans la console.


@pytest.mark.parametrize("variante", [lambda s: s, _en_nvme, _en_uefi],
                         ids=["sata-bios (releve)", "nvme (construit)", "uefi (construit)"])
def test_la_sortie_a_la_FORME_QUE_L_HEBERGEUR_ATTEND(variante):
    """Des LISTES, des valeurs prises dans les enumerations, des numeros contigus :
    un objet indexe par peripherique se lit tres bien et n'est jamais accepte."""
    schema, _ = pf.deriver(variante(defaut()), 200)
    assert set(schema) >= {"disks", "raids", "filesystems"}
    assert all(isinstance(schema[c], list) for c in ("disks", "raids", "filesystems"))
    for disque in schema["disks"]:
        assert disque["device"].startswith("/dev/")
        numeros = [p["number"] for p in disque["partitions"]]
        assert numeros == list(range(1, len(numeros) + 1)), "numeros contigus"
        for p in disque["partitions"]:
            assert p["label"] in LIBELLES, p["label"]
            assert isinstance(p["size"], int) and p["size"] >= 0
            # « tout le reste » se dit size 0 ET drapeau : jamais l'un sans l'autre.
            assert (p["size"] == 0) == (p["useAllAvailableSpace"] is True), p
        assert [p["label"] for p in disque["partitions"]].count("zfs") == 1
        assert disque["partitions"][-1]["label"] == "zfs", "zfs est la derniere"
    assert all(r["level"] in NIVEAUX_RAID for r in schema["raids"])
    assert all(f["format"] in FORMATS for f in schema["filesystems"])
    # La section `zfs` : une liste de pools, chacun du contrat (`name`, `type`, `devices`).
    assert isinstance(schema["zfs"]["pools"], list) and len(schema["zfs"]["pools"]) == 1
    for pool in schema["zfs"]["pools"]:
        assert pool["type"] in TYPES_DE_POOL and pool["name"] and isinstance(pool["devices"], list)


@pytest.mark.parametrize("declarer", [True, False], ids=["pool declare", "--sans-zfs"])
@pytest.mark.parametrize("variante", [lambda s: s, _en_nvme], ids=["sata", "nvme"])
def test_la_sortie_LAISSE_une_paire_de_partitions_NUE(variante, declarer):
    """Les supports ne sont NI dans un RAID NI dans un systeme de fichiers : confier
    `sda5` et `sdb5` a `md` reproduirait le probleme que le miroir ZFS resout (`md`
    ne sait pas laquelle des deux copies est la bonne). Pool declare, ils ne sont
    que dans la section `zfs` ; en repli, nulle part."""
    schema, supports = pf.deriver(variante(defaut()), 200, declarer)
    assert len(supports) == 2
    engages = {d for r in schema["raids"] for d in r["devices"]}
    engages |= {f["device"] for f in schema["filesystems"]}
    for libre in supports:
        assert libre not in engages, f"{libre} doit rester un peripherique NU"
    if declarer:
        assert schema["zfs"]["pools"][0]["devices"] == supports
    else:
        assert not schema.get("zfs"), "en repli, aucun pool n'est declare"


def test_le_systeme_reste_sur_un_RAID_en_MIROIR():
    """Borner « / » ne le laisse pas sans redondance."""
    schema, _ = pf.deriver(defaut(), 200)
    assert all(r["level"] == "raid_level_1" and len(r["devices"]) == 2 for r in schema["raids"])
    assert {f["mountpoint"] for f in schema["filesystems"]} == {"/", "/boot"}


# --- Le cloud-init produit (DAT §66.4) -------------------------------------------


def _cloud_init(supports=("/dev/sda5", "/dev/sdb5"), arc=None, net=None) -> str:
    return pf.rendre_cloud_init(AMORCE.read_text(encoding="utf-8"),
                                CREER_POOL.read_text(encoding="utf-8"), list(supports), arc, net)


def _fichiers(sortie: str) -> dict:
    return {f["path"]: f for f in yaml.safe_load(sortie)["write_files"]}


def test_le_contenu_embarque_est_IDENTIQUE_aux_sources_octet_pour_octet():
    """Le defaut du gabarit : un marqueur collé tel quel posait une amorce VIDE.
    Ici le contenu relu par PyYAML est celui du depot, et rien d'autre."""
    sortie = _cloud_init()
    assert sortie.startswith("#cloud-config\n")
    fichiers = _fichiers(sortie)
    assert set(fichiers) == {"/opt/spark-amorce.sh", "/opt/creer-pool.sh"}
    assert fichiers["/opt/spark-amorce.sh"]["content"] == AMORCE.read_text(encoding="utf-8")
    assert fichiers["/opt/creer-pool.sh"]["content"] == CREER_POOL.read_text(encoding="utf-8")
    for f in fichiers.values():
        assert (f["permissions"], f["owner"], f["encoding"]) == ("0755", "root:root", "text/plain")


def test_aucun_marqueur_a_remplacer_ne_subsiste():
    sortie = _cloud_init()
    # `<<<` existe legitimement dans creer-pool.sh (here-string) : on cherche le MARQUEUR.
    assert "# <<< contenu" not in sortie and "indente ici" not in sortie
    # L'amorce n'est pas vide : elle porte ses gestes, pas un commentaire.
    assert "zpool import" in _fichiers(sortie)["/opt/spark-amorce.sh"]["content"]


def test_le_runcmd_est_UNE_ligne_qui_lance_l_amorce_avec_les_supports():
    assert yaml.safe_load(_cloud_init())["runcmd"] == [
        "/opt/spark-amorce.sh --pool-source /dev/sda5,/dev/sdb5"]


def test_les_reglages_demandes_sont_dans_la_commande_et_seulement_eux():
    assert yaml.safe_load(_cloud_init(arc=4))["runcmd"] == [
        "/opt/spark-amorce.sh --pool-source /dev/sda5,/dev/sdb5 --arc-gib 4"]
    assert yaml.safe_load(_cloud_init(arc=1, net=1000))["runcmd"] == [
        "/opt/spark-amorce.sh --pool-source /dev/sda5,/dev/sdb5 --arc-gib 1 --net-mbit 1000"]


def test_compresse_le_contenu_decode_est_IDENTIQUE_aux_sources_et_la_sortie_est_plus_petite():
    """`--compresser` change la taille, pas le fichier que cloud-init pose : le
    contenu decode (base64 puis gzip, ce que fait cloud-init pour `gz+b64`) est celui
    du depot, octet pour octet. Le gzip est horodate a zero : la sortie reste stable."""
    import base64
    import gzip

    brut = _cloud_init()
    compresse = pf.rendre_cloud_init(AMORCE.read_text(encoding="utf-8"),
                                     CREER_POOL.read_text(encoding="utf-8"),
                                     ["/dev/sda5", "/dev/sdb5"], None, None, compresser=True)
    fichiers = _fichiers(compresse)
    sources = {"/opt/spark-amorce.sh": AMORCE, "/opt/creer-pool.sh": CREER_POOL}
    for chemin, f in fichiers.items():
        assert f["encoding"] == "gz+b64", chemin
        decode = gzip.decompress(base64.b64decode(f["content"])).decode("utf-8")
        assert decode == sources[chemin].read_text(encoding="utf-8"), chemin
    assert len(compresse.encode()) < 0.7 * len(brut.encode()), "au moins 30 % plus petit"
    assert yaml.safe_load(compresse)["runcmd"] == yaml.safe_load(brut)["runcmd"]
    assert compresse == pf.rendre_cloud_init(AMORCE.read_text(encoding="utf-8"),
                                             CREER_POOL.read_text(encoding="utf-8"),
                                             ["/dev/sda5", "/dev/sdb5"], None, None, compresser=True)


def test_la_sortie_est_REPRODUCTIBLE():
    """Aucune date, aucun hasard : deux lancements, la meme sortie, donc un diff."""
    assert _cloud_init() == _cloud_init()


def _bloc_arguments(amorce: str) -> str:
    """De `set -eu` a `export DEBIAN_FRONTEND` : la lecture des arguments, qui
    n'ecrit rien. C'est le VRAI texte de l'amorce embarquee, pas une copie."""
    debut = amorce.index("set -eu")
    return amorce[debut:amorce.index("export DEBIAN_FRONTEND=noninteractive")]


@pytest.mark.skipif(shutil.which("sh") is None, reason="aucun sh sur cet hote")
@pytest.mark.parametrize("arc, net, attendu", [
    (None, None, "POOL_SOURCE=/dev/sda5,/dev/sdb5 ARC_GIB=16 NET_MBIT="),
    (4, None, "POOL_SOURCE=/dev/sda5,/dev/sdb5 ARC_GIB=4 NET_MBIT="),
    (1, 1000, "POOL_SOURCE=/dev/sda5,/dev/sdb5 ARC_GIB=1 NET_MBIT=1000"),
])
def test_la_ligne_runcmd_est_ACCEPTEE_par_l_analyseur_de_l_amorce_embarquee(arc, net, attendu):
    """La commande et l'amorce sont deux textes : seule cette preuve les tient
    ensemble. La ligne est relue du YAML, l'analyseur du script EMBARQUE, et ce qu'il
    en retient est ce que l'amorce emploiera au premier demarrage."""
    doc = yaml.safe_load(_cloud_init(arc=arc, net=net))
    ligne = doc["runcmd"][0].split()
    assert ligne[0] == "/opt/spark-amorce.sh"
    embarquee = _fichiers(_cloud_init())["/opt/spark-amorce.sh"]["content"]
    programme = _bloc_arguments(embarquee) + 'echo "POOL_SOURCE=$POOL_SOURCE ARC_GIB=$ARC_GIB NET_MBIT=$NET_MBIT"\n'
    vu = subprocess.run(["sh", "-c", programme, "sh", *ligne[1:]], capture_output=True, text=True)
    assert vu.returncode == 0, vu.stderr
    assert vu.stdout.strip() == attendu


@pytest.mark.parametrize("support", [
    "/dev/sda5;reboot,/dev/sdb5", "/dev/sda5 /dev/sdb5", "/dev/sda5,/dev/sdb5'", "/dev/sda5,sdb5",
    "/dev/sda5", "/dev/sda5\n,/dev/sdb5", "/dev/sda5,/dev/sdb5,$(id)", ""])
def test_un_support_hors_de_la_liste_des_caracteres_surs_est_REFUSE(support):
    """La valeur finit dans une ligne YAML puis dans un script lance en root."""
    with pytest.raises(pf.Refus, match="--pool-source"):
        pf._verifier_support(support)


@pytest.mark.parametrize("script", ["a\r\nb\n", "a\x00b\n", "a\x1bb\n", "sans fin de ligne",
                                    "deux fins de ligne\n\n"])
def test_un_script_qui_ne_peut_pas_etre_embarque_tel_quel_est_REFUSE(script):
    with pytest.raises(pf.Refus):
        pf._entree("/opt/x.sh", script)


def test_les_deux_scripts_du_depot_sont_embarquables():
    """Garde des SOURCES : si l'un prend un CR ou une double fin de ligne, la
    commande refuse — mieux vaut que ce soit ici, avant la commande d'une machine."""
    for chemin in (AMORCE, CREER_POOL):
        pf._entree("/opt/x.sh", chemin.read_text(encoding="utf-8"))


# --- La commande, lancee comme un utilisateur (E2E de la commande) ----------------


def _commande(*argv: str, entree: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-I", str(COMMANDE), *argv], input=entree,
                          capture_output=True, text=True)


def test_E2E_partitionnement_par_fichier_donne_le_JSON_a_coller():
    vu = _commande("partitionnement", "--defaut", str(DEFAUT))
    assert vu.returncode == 0, vu.stderr
    assert json.loads(vu.stdout) == pf.deriver(defaut(), 200)[0]
    assert vu.stdout.endswith("}\n")
    assert "/dev/sda5,/dev/sdb5" in vu.stderr, "ce qui a ete decide se dit sur la sortie d'erreur"
    assert "capacite des disques" in vu.stderr, "ce que la commande NE sait PAS se dit aussi"


def test_E2E_l_entree_standard_donne_la_meme_sortie_que_le_fichier():
    par_fichier = _commande("partitionnement", "--defaut", str(DEFAUT))
    par_entree = _commande("partitionnement", "--defaut", "-", entree=DEFAUT.read_text(encoding="utf-8"))
    assert par_entree.returncode == 0, par_entree.stderr
    assert par_entree.stdout == par_fichier.stdout


@pytest.mark.parametrize("offre", OFFRES, ids=lambda f: f.stem)
def test_E2E_chaque_offre_versionnee_donne_un_partitionnement_et_un_cloud_init(offre):
    """Les commandes du README, jouees sur les fichiers que le README nomme."""
    brut = json.loads(offre.read_text(encoding="utf-8"))
    part = _commande("partitionnement", "--defaut", str(offre))
    assert part.returncode == 0, part.stderr
    assert json.loads(part.stdout) == pf.deriver(brut, 200)[0]
    cloud = _commande("cloud-init", "--defaut", str(offre), "--arc-gib", "8")
    assert cloud.returncode == 0, cloud.stderr
    assert yaml.safe_load(cloud.stdout)["runcmd"] == [
        "/opt/spark-amorce.sh --pool-source /dev/sda5,/dev/sdb5 --arc-gib 8"]


def test_E2E_racine_gio_change_la_sortie():
    vu = _commande("partitionnement", "--defaut", str(DEFAUT), "--racine-gio", "100")
    root = next(p for p in json.loads(vu.stdout)["disks"][0]["partitions"] if p["label"] == "root")
    assert root["size"] == 100 * 1024 ** 3


def test_E2E_cloud_init_par_defaut_donne_un_user_data_complet_et_dit_sa_taille():
    vu = _commande("cloud-init", "--defaut", str(DEFAUT), "--arc-gib", "8")
    assert vu.returncode == 0, vu.stderr
    doc = yaml.safe_load(vu.stdout)
    assert doc["runcmd"] == ["/opt/spark-amorce.sh --pool-source /dev/sda5,/dev/sdb5 --arc-gib 8"]
    assert f"{len(vu.stdout.encode('utf-8'))} octets" in vu.stderr, "la taille dite est la taille produite"
    assert "pas documentee" in vu.stderr, "la limite de l'hebergeur est dite inconnue, pas supposee"


def test_E2E_compresser_donne_un_user_data_plus_petit_et_le_dit():
    brut = _commande("cloud-init", "--defaut", str(DEFAUT))
    compresse = _commande("cloud-init", "--defaut", str(DEFAUT), "--compresser")
    assert compresse.returncode == 0, compresse.stderr
    assert len(compresse.stdout.encode()) < len(brut.stdout.encode())
    assert f"{len(compresse.stdout.encode('utf-8'))} octets" in compresse.stderr
    assert yaml.safe_load(compresse.stdout)["write_files"][0]["encoding"] == "gz+b64"


def test_E2E_cloud_init_par_pool_source_explicite():
    vu = _commande("cloud-init", "--pool-source", "/dev/vdb,/dev/vdc", "--arc-gib", "1",
                   "--net-mbit", "1000")
    assert vu.returncode == 0, vu.stderr
    assert yaml.safe_load(vu.stdout)["runcmd"] == [
        "/opt/spark-amorce.sh --pool-source /dev/vdb,/dev/vdc --arc-gib 1 --net-mbit 1000"]


@pytest.mark.skipif(shutil.which("sh") is None or shutil.which("bash") is None,
                    reason="sh et bash sont necessaires")
def test_E2E_les_scripts_deposes_par_le_cloud_init_passent_le_VRAI_parseur(tmp_path):
    """Ce que cloud-init ecrira dans /opt, extrait de la SORTIE de la commande."""
    vu = _commande("cloud-init", "--defaut", str(DEFAUT))
    fichiers = _fichiers(vu.stdout)
    amorce = tmp_path / "spark-amorce.sh"
    amorce.write_text(fichiers["/opt/spark-amorce.sh"]["content"], encoding="utf-8")
    creer = tmp_path / "creer-pool.sh"
    creer.write_text(fichiers["/opt/creer-pool.sh"]["content"], encoding="utf-8")
    assert subprocess.run(["sh", "-n", str(amorce)], capture_output=True, text=True).returncode == 0
    assert subprocess.run(["bash", "-n", str(creer)], capture_output=True, text=True).returncode == 0
    aide = subprocess.run(["sh", str(amorce), "--help"], capture_output=True, text=True)
    assert aide.returncode == 0 and "--pool-source" in aide.stdout


@pytest.mark.parametrize("fichier, attendu", [
    ("un-seul-disque", "deux disques"),
    ("pas-du-json", "JSON valide"),
])
def test_E2E_un_refus_sort_en_code_2_avec_un_message_et_RIEN_sur_la_sortie(tmp_path, fichier, attendu):
    entree = tmp_path / f"{fichier}.json"
    if fichier == "un-seul-disque":
        s = defaut()
        s["disks"] = s["disks"][:1]
        entree.write_text(json.dumps(s), encoding="utf-8")
    else:
        entree.write_text("{ ceci n'est pas du JSON", encoding="utf-8")
    for sous_commande in ("partitionnement", "cloud-init"):
        vu = _commande(sous_commande, "--defaut", str(entree))
        assert vu.returncode == 2, (sous_commande, vu.stderr)
        assert vu.stdout == "", "un refus n'ecrit RIEN a coller"
        assert vu.stderr.startswith("preparer-forge.py :") and attendu in vu.stderr


def test_E2E_un_fichier_absent_est_un_refus_pas_une_trace_de_pile():
    vu = _commande("partitionnement", "--defaut", "/nulle/part/defaut.json")
    assert vu.returncode == 2 and vu.stdout == "" and "illisible" in vu.stderr
    assert "Traceback" not in vu.stderr


@pytest.mark.parametrize("argv, attendu", [
    (["partitionnement"], "donnez --offre"),
    (["cloud-init"], "--defaut"),
    (["cloud-init", "--defaut", str(DEFAUT), "--pool-source", "/dev/a,/dev/b"], "ni les deux"),
    (["cloud-init", "--pool-source", "/dev/sda5;reboot,/dev/sdb5"], "--pool-source"),
    (["cloud-init", "--pool-source", "/dev/a,/dev/b", "--arc-gib", "0"], "superieur ou egal a 1"),
    (["cloud-init", "--pool-source", "/dev/a,/dev/b", "--net-mbit", "vite"], "superieur ou egal a 1"),
    (["partitionnement", "--defaut", str(DEFAUT), "--racine-gio", "-3"], "superieur ou egal a 1"),
])
def test_E2E_un_mauvais_usage_est_refuse_en_code_2_sans_rien_ecrire(argv, attendu):
    vu = _commande(*argv)
    assert vu.returncode == 2, (vu.returncode, vu.stderr)
    assert vu.stdout == ""
    assert attendu in vu.stderr


@pytest.mark.parametrize("sous_commande, noms", [
    ("partitionnement", ["--offre", "--defaut", "--racine-gio", "--sans-zfs"]),
    ("offres", ["--racine-gio", "--verifier"]),
    ("cloud-init", ["--offre", "--defaut", "--racine-gio", "--pool-source", "--arc-gib",
                    "--net-mbit", "--compresser"]),
])
def test_E2E_chaque_sous_commande_a_son_help_qui_nomme_ses_reglages(sous_commande, noms):
    """CLAUDE.md §3 : un reglage se lit dans la commande et dans son --help."""
    vu = _commande(sous_commande, "--help")
    assert vu.returncode == 0, vu.stderr
    for nom in noms:
        assert nom in vu.stdout, f"{nom} doit figurer dans l'aide de « {sous_commande} »"


def test_la_commande_ne_lit_aucune_variable_d_environnement():
    """CLAUDE.md §3 : aucune option cachee. Le script n'importe pas `os` et ne lit
    ni `environ` ni `getenv`."""
    texte = COMMANDE.read_text(encoding="utf-8")
    code = "\n".join(l for l in texte.splitlines() if not l.lstrip().startswith("#"))
    assert not re.search(r"\bimport os\b|\bos\.environ\b|\bgetenv\b|\bfrom os\b", code)


# --- Le repli --sans-zfs, par la commande (DAT §66.8) ------------------------------


def test_E2E_le_defaut_declare_le_pool_et_le_dit_sur_la_sortie_d_erreur():
    vu = _commande("partitionnement", "--defaut", str(DEFAUT))
    assert vu.returncode == 0, vu.stderr
    assert json.loads(vu.stdout)["zfs"] == ZFS_ATTENDU
    assert "declare a l'hebergeur" in vu.stderr


def test_E2E_sans_zfs_donne_le_repli_et_le_dit():
    vu = _commande("partitionnement", "--defaut", str(DEFAUT), "--sans-zfs")
    assert vu.returncode == 0, vu.stderr
    assert json.loads(vu.stdout) == pf.deriver(defaut(), 200, False)[0]
    assert [d["partitions"][-1]["label"] for d in json.loads(vu.stdout)["disks"]] == ["data", "data"]
    assert "--sans-zfs" in vu.stderr and "aucun pool n'est declare" in vu.stderr


# --- Le JSON de partition de chaque offre connue, versionne (DAT §66.8) --------------

FORGE_DIR = OFFRES_DIR / "forge"


def test_les_JSON_de_partition_versionnes_sont_ceux_que_la_commande_produit_AUJOURD_HUI():
    """C'est la preuve qui les GARDE : changer la regle sans regenerer la fait echouer.
    Pour regenerer : `python3 scripts/preparer-forge.py offres`."""
    assert pf.verifier_offres() == []


def test_AUCUN_cloud_init_n_est_versionne():
    """Le cloud-init EMBARQUE l'amorce, qui evolue : une copie versionnee serait en
    retard sur elle, et poserait une vieille amorce sur une machine neuve. Il se
    produit a la demande, depuis l'amorce courante (`cloud-init --offre <NOM>`).
    Un cloud-init pre-compile retrouve dans `forge/` est « sans offre » pour `offres
    --verifier`, mais cette preuve le dit pour ce qu'il est."""
    versionnes = [f.name for f in FORGE_DIR.iterdir() if f.suffix in (".yaml", ".yml")]
    assert versionnes == [], f"cloud-init pre-compile versionne : {versionnes}"
    assert all(f.name.endswith(".partitionnement.json") for f in FORGE_DIR.iterdir())


@pytest.mark.parametrize("offre", OFFRES, ids=lambda f: f.stem)
def test_chaque_offre_a_son_JSON_de_partition_pour_la_Forge(offre):
    schema_attendu, _ = pf.deriver(json.loads(offre.read_text(encoding="utf-8")), 200)
    part = FORGE_DIR / f"{offre.stem}.partitionnement.json"
    assert part.is_file(), "le JSON de partition doit etre versionne"
    schema = json.loads(part.read_text(encoding="utf-8"))
    assert schema == schema_attendu
    assert [d["partitions"][-1]["label"] for d in schema["disks"]] == ["zfs"] * len(schema["disks"])
    assert schema["zfs"]["pools"][0]["name"] == "spark"


def test_le_README_du_dossier_des_offres_nomme_le_JSON_versionne_et_le_cloud_init_a_la_demande():
    readme = (OFFRES_DIR / "README.md").read_text(encoding="utf-8")
    assert "forge/" in readme and "preparer-forge.py offres" in readme
    assert "cloud-init --offre" in readme, "le cloud-init se produit par nom d'offre"


def test_verifier_detecte_un_fichier_absent_perime_ou_sans_offre(tmp_path):
    dossier = tmp_path / "offres"
    dossier.mkdir()
    for offre in OFFRES:
        (dossier / offre.name).write_text(offre.read_text(encoding="utf-8"), encoding="utf-8")
    nb = len(OFFRES)
    assert len(pf.verifier_offres(dossier)) == nb and all(e.startswith("absent") for e in pf.verifier_offres(dossier))

    ecrits = pf.ecrire_offres(dossier)
    assert len(ecrits) == nb and pf.verifier_offres(dossier) == []

    premiere = sorted(OFFRES)[0].stem
    (dossier / "forge" / f"{premiere}.partitionnement.json").write_text("{}\n", encoding="utf-8")
    (dossier / "forge" / "OFFRE-SUPPRIMEE.partitionnement.json").write_text("{}\n", encoding="utf-8")
    (dossier / "forge" / f"{premiere}.cloud-init.yaml").write_text("#cloud-config\n", encoding="utf-8")
    ecarts = pf.verifier_offres(dossier)
    assert f"perime : forge/{premiere}.partitionnement.json" in ecarts
    assert "sans offre : forge/OFFRE-SUPPRIMEE.partitionnement.json" in ecarts
    assert f"sans offre : forge/{premiere}.cloud-init.yaml" in ecarts, "un cloud-init pre-compile est refuse"


def test_une_offre_hors_regle_est_refusee_avec_son_nom_de_fichier(tmp_path):
    dossier = tmp_path / "offres"
    dossier.mkdir()
    un_seul_disque = defaut()
    un_seul_disque["disks"] = un_seul_disque["disks"][:1]
    (dossier / "EM-X999X-SATA.json").write_text(json.dumps(un_seul_disque), encoding="utf-8")
    with pytest.raises(pf.Refus, match=r"EM-X999X-SATA\.json : .*deux disques"):
        pf.produire_offres(dossier)


# --- Une offre connue, par son NOM (--offre) ---------------------------------------------


@pytest.mark.parametrize("offre", OFFRES, ids=lambda f: f.stem)
def test_E2E_offre_par_son_nom_donne_la_meme_sortie_que_par_son_fichier(offre):
    for sous_commande in ("partitionnement", "cloud-init"):
        par_nom = _commande(sous_commande, "--offre", offre.stem)
        par_fichier = _commande(sous_commande, "--defaut", str(offre))
        assert par_nom.returncode == 0, par_nom.stderr
        assert par_nom.stdout == par_fichier.stdout, sous_commande


def test_E2E_le_cloud_init_par_nom_d_offre_embarque_l_amorce_COURANTE():
    """C'est tout l'interet de ne pas le versionner : demain, la meme commande
    produit le cloud-init de l'amorce de demain."""
    vu = _commande("cloud-init", "--offre", "EM-B311X-SATA")
    assert vu.returncode == 0, vu.stderr
    contenus = {f["path"]: f["content"] for f in yaml.safe_load(vu.stdout)["write_files"]}
    assert contenus["/opt/spark-amorce.sh"] == AMORCE.read_text(encoding="utf-8")
    assert contenus["/opt/creer-pool.sh"] == CREER_POOL.read_text(encoding="utf-8")
    assert yaml.safe_load(vu.stdout)["runcmd"] == ["/opt/spark-amorce.sh --pool-source /dev/sda5,/dev/sdb5"]


@pytest.mark.parametrize("argv, attendu", [
    (["cloud-init", "--offre", "EM-INCONNUE"], "offre inconnue"),
    (["partitionnement", "--offre", "EM-INCONNUE"], "offres versionnees : EM-B311X-SATA, EM-L101X-SATA"),
    (["partitionnement", "--offre", "../README"], "offre inconnue"),
    (["partitionnement", "--offre", "EM-B311X-SATA", "--defaut", str(DEFAUT)], "ni les deux"),
    (["cloud-init", "--offre", "EM-B311X-SATA", "--pool-source", "/dev/a,/dev/b"], "ni les deux"),
])
def test_E2E_une_offre_inconnue_ou_un_usage_ambigu_est_refuse_sans_rien_ecrire(argv, attendu):
    vu = _commande(*argv)
    assert vu.returncode == 2, (vu.returncode, vu.stderr)
    assert vu.stdout == "" and attendu in vu.stderr


def test_E2E_offres_verifier_est_vert_sur_les_fichiers_versionnes_et_n_ecrit_rien():
    avant = {f.name: f.read_bytes() for f in FORGE_DIR.iterdir()}
    vu = _commande("offres", "--verifier")
    assert vu.returncode == 0, vu.stderr
    assert vu.stdout == "" and "a jour" in vu.stderr
    assert {f.name: f.read_bytes() for f in FORGE_DIR.iterdir()} == avant, "--verifier n'ecrit RIEN"
