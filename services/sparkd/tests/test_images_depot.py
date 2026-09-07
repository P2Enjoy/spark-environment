"""@verifies docs/BACKLOG.md#SPK-92 · docs/DAT.md §33.6 (le depot se lit en
           direct, le catalogue se coche, et le serveur reconfirme), §33.7
           (retirer une entree et ses deux refus), §33.3 (la variante est dans
           l'alias, l'architecture non ; l'etat vient du releve) · §42.9.6
           (annoncer l'amorcabilite) · DESIGN_SYSTEM.md §1.3 (pas de succes
           simule)

Le coeur de l'unite : une entree COCHEE nait `verified`, mais son etat vient de
la lecture que le SERVEUR fait du depot — jamais de ce que le navigateur annonce.
Une reference que le depot ne publie pas ne peut donc pas entrer verifiee, quoi
que le client demande.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from sparkd import images, migrations
from sparkd.app import create_app
from sparkd.config import load
from sparkd.db import connect
from sparkd.images import UNKNOWN, VERIFIED, Catalogue, ImageError, Publication

GIO = 1024**3


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "c.db")
    migrations.upgrade(connection)
    images.seed_defaults(connection)
    yield connection
    connection.close()


def publication(alias, os="", release="", variante="default", archs=("amd64",)):
    return Publication(alias=alias, os=os, release=release, variante=variante,
                       architectures=frozenset(archs))


#: Un depot de laboratoire qui reproduit les TROIS formes de doublon mesurees le
#: 2026-09-07 sur `images.linuxcontainers.org` — celles qu'un fixture naif
#: manque, et qui font afficher des lignes que personne ne peut departager :
#:
#: 1. la variante par defaut redit la base (`debian/13` / `debian/13/default`) ;
#: 2. le nom de code redit le numero (`debian/13` / `debian/trixie`) ;
#: 3. une variante peut etre COMPOSEE (`freebsd/14.4/ufs` porte `default+ufs`),
#:    ce qui la fait passer pour une version a part si on la reconnait au seul
#:    dernier segment de l'alias ;
#: 4. une variante peut pendre sous une AUTRE variante
#:    (`archlinux/current/cloud`), donc s'arreter aux enfants directs la perd.
DEPOT = {
    "debian/13": publication("debian/13", "Debian", "trixie",
                             archs=("amd64", "arm64")),
    "debian/13/default": publication("debian/13/default", "Debian", "trixie"),
    "debian/13/cloud": publication("debian/13/cloud", "Debian", "trixie", "cloud"),
    "debian/trixie": publication("debian/trixie", "Debian", "trixie"),
    "debian/9": publication("debian/9", "Debian", "stretch"),
    "debian/10": publication("debian/10", "Debian", "buster"),
    "alpine/3.21": publication("alpine/3.21", "Alpine", "3.21", archs=("arm64",)),
    "archlinux": publication("archlinux", "Archlinux", "current"),
    "archlinux/cloud": publication("archlinux/cloud", "Archlinux", "current",
                                   "cloud"),
    # 4. une variante peut pendre sous une AUTRE variante.
    "archlinux/current": publication("archlinux/current", "Archlinux", "current"),
    "archlinux/current/cloud": publication("archlinux/current/cloud", "Archlinux",
                                           "current", "cloud"),
    "freebsd/14.4": publication("freebsd/14.4", "Freebsd", "14.4"),
    "freebsd/14.4/ufs": publication("freebsd/14.4/ufs", "Freebsd", "14.4",
                                    "default+ufs"),
}


def lecteur(depot=None, compteur=None):
    """Un `fetch` de laboratoire, qui compte ses appels."""
    contenu = DEPOT if depot is None else depot

    def _fetch(url, client=None):
        if compteur is not None:
            compteur.append(url)
        return Catalogue(frozenset(contenu), len(contenu) * 2, dict(contenu))

    return _fetch


def injoignable(url, client=None):
    raise RuntimeError("depot injoignable : connexion refusee")


# --- ce que la modale propose (§33.6) ----------------------------------------


def test_la_racine_et_sa_variante_par_defaut_ne_sont_pas_deux_lignes_soeurs(db):
    """Mesure du 2026-09-07 : `debian/13` et `debian/13/default` sont synonymes.

    Les rendre a plat afficherait un doublon que personne ne peut departager.
    """
    vue = images.depot_listing(db, fetch=lecteur())
    debian = next(f for f in vue["familles"] if f["famille"] == "debian")

    racines = [v["alias"] for v in debian["versions"]]
    assert "debian/13" in racines
    assert "debian/13/default" not in racines, "la variante par defaut EST la racine"

    treize = next(v for v in debian["versions"] if v["alias"] == "debian/13")
    variantes = [v["alias"] for v in treize["variantes"]]
    assert variantes == ["debian/13/cloud"], "la variante vit SOUS sa version"
    assert "debian/13/default" not in variantes


def test_le_nom_de_CODE_devient_un_synonyme_et_non_une_version(db):
    """`debian/trixie` et `debian/13` designent les memes produits (§33.6).

    Les afficher tous deux ferait croire a deux Debian differentes. Le synonyme
    est retenu, parce qu'on cherche « trixie » aussi souvent que « 13 ».
    """
    vue = images.depot_listing(db, fetch=lecteur())
    debian = next(f for f in vue["familles"] if f["famille"] == "debian")

    alias = [v["alias"] for v in debian["versions"]]
    assert "debian/13" in alias
    assert "debian/trixie" not in alias, "le nom de code n'est pas une version"

    treize = next(v for v in debian["versions"] if v["alias"] == "debian/13")
    assert treize["synonymes"] == ["debian/13/default", "debian/trixie"], \
        "le nom de code ET la variante par defaut restent cherchables"


def test_une_variante_COMPOSEE_reste_une_variante(db):
    """`freebsd/14.4/ufs` porte le variant `default+ufs` (mesure du 2026-09-07).

    La reconnaitre au seul dernier segment la manquerait, et `ufs` s'afficherait
    comme une version de FreeBSD.
    """
    vue = images.depot_listing(db, fetch=lecteur())
    freebsd = next(f for f in vue["familles"] if f["famille"] == "freebsd")

    assert [v["alias"] for v in freebsd["versions"]] == ["freebsd/14.4"]
    variantes = [v["alias"] for v in freebsd["versions"][0]["variantes"]]
    assert variantes == ["freebsd/14.4/ufs"]


def test_une_variante_d_une_distribution_SANS_version_reste_sous_elle(db):
    """`archlinux/cloud` est une variante d'`archlinux`, pas une version."""
    vue = images.depot_listing(db, fetch=lecteur())
    arch = next(f for f in vue["familles"] if f["famille"] == "archlinux")
    assert [v["alias"] for v in arch["versions"]] == ["archlinux"]

    variantes = arch["versions"][0]["variantes"]
    assert [v["alias"] for v in variantes] == ["archlinux/cloud"], \
        "une seule ligne « cloud », pas une par alias qui la nomme"
    assert variantes[0]["synonymes"] == ["archlinux/current/cloud"], \
        "la variante imbriquee reste cherchable"


def test_AUCUN_alias_publie_ne_disparait_de_l_ecran(db):
    """Le groupement resserre l'affichage ; il ne perd rien.

    Chaque alias du depot est soit une ligne, soit une variante, soit le
    synonyme d'une ligne. Un alias qui ne serait nulle part serait inatteignable.
    """
    vue = images.depot_listing(db, fetch=lecteur())
    vus = set()
    for famille in vue["familles"]:
        for version in famille["versions"]:
            vus.add(version["alias"])
            vus.update(version["synonymes"])
            for variante in version["variantes"]:
                vus.add(variante["alias"])
                vus.update(variante["synonymes"])

    assert set(DEPOT) - vus == set(), "aucun alias publie n'est inatteignable"


def test_une_distribution_sans_version_reste_proposee(db):
    """`archlinux` n'a pas de version : la faire disparaitre la rendrait inatteignable."""
    vue = images.depot_listing(db, fetch=lecteur())
    arch = next(f for f in vue["familles"] if f["famille"] == "archlinux")
    assert [v["alias"] for v in arch["versions"]] == ["archlinux"]


def test_les_versions_sont_triees_par_numero_et_non_lexicalement(db):
    """`debian/10` doit venir avant `debian/9`, sinon on lit une regression."""
    vue = images.depot_listing(db, fetch=lecteur())
    debian = next(f for f in vue["familles"] if f["famille"] == "debian")
    ordre = [v["version"] for v in debian["versions"]]
    assert ordre.index("13") < ordre.index("10") < ordre.index("9")


def test_ce_qui_est_deja_au_catalogue_est_marque(db):
    """La modale montre l'entree cochee et inerte : elle ne sert pas a retirer."""
    vue = images.depot_listing(db, fetch=lecteur())
    debian = next(f for f in vue["familles"] if f["famille"] == "debian")
    par_alias = {v["alias"]: v for v in debian["versions"]}
    assert par_alias["debian/13"]["au_catalogue"] is True, "pre-renseignee"
    assert par_alias["debian/10"]["au_catalogue"] is False


def test_l_amorcabilite_est_ANNONCEE_par_famille(db):
    """§42.9.6 : annonce, jamais filtre — l'entree reste choisissable."""
    vue = images.depot_listing(db, fetch=lecteur())
    par_famille = {f["famille"]: f for f in vue["familles"]}
    assert par_famille["debian"]["amorcable"] is True
    assert par_famille["alpine"]["amorcable"] is False
    assert par_famille["alpine"]["versions"], "annoncee, mais toujours proposee"


def test_le_libelle_est_DERIVE_de_ce_que_le_depot_publie(db):
    """Le depot donne `os` et `release_title` : on ne les invente pas."""
    vue = images.depot_listing(db, fetch=lecteur())
    debian = next(f for f in vue["familles"] if f["famille"] == "debian")
    treize = next(v for v in debian["versions"] if v["alias"] == "debian/13")
    assert treize["libelle"] == "Debian 13 « trixie »"
    cloud = treize["variantes"][0]
    assert cloud["libelle"] == "Debian 13 « trixie » (cloud)"


def test_les_architectures_publiees_sont_rendues(db):
    """L'alias n'en porte pas (§33.3) : elles se lisent dans les produits."""
    vue = images.depot_listing(db, fetch=lecteur())
    debian = next(f for f in vue["familles"] if f["famille"] == "debian")
    treize = next(v for v in debian["versions"] if v["alias"] == "debian/13")
    assert treize["architectures"] == ["amd64", "arm64"]


def test_un_depot_inconnu_du_produit_est_refuse(db):
    with pytest.raises(ImageError, match="inconnu du produit"):
        images.depot_listing(db, fetch=lecteur(), remote="quelque-part")


# --- cocher ajoute, et le serveur reconfirme (§33.6) -------------------------


def test_une_entree_cochee_nait_VERIFIEE_datee_de_la_lecture_du_serveur(db):
    resultat = images.add_selection(db, ["images:debian/10"], fetch=lecteur())

    posee = images.by_reference(db, "images:debian/10")
    assert posee["state"] == VERIFIED
    assert posee["verified_at"] == resultat["verified_at"]
    assert posee["verified_at"] is not None
    assert "produits publiés" in posee["detail"], "le releve dit ce qu'il a constate"
    assert images.ensure_selectable(db, "images:debian/10"), "utilisable aussitot"


def test_le_serveur_NE_CROIT_PAS_le_client(db):
    """LE test de l'unite (§33.6, DESIGN_SYSTEM.md §1.3).

    Le client peut demander n'importe quoi : si le depot ne publie pas l'alias,
    rien n'entre — et surtout rien n'entre `verified`.
    """
    with pytest.raises(ImageError, match="ne publie pas"):
        images.add_selection(db, ["images:debian/31"], fetch=lecteur())
    assert images.by_reference(db, "images:debian/31") is None


def test_un_lot_a_moitie_faux_n_ecrit_RIEN(db):
    """Un lot partiellement pose serait plus dur a comprendre qu'un refus."""
    with pytest.raises(ImageError, match="debian/31"):
        images.add_selection(
            db, ["images:debian/10", "images:debian/31"], fetch=lecteur())
    assert images.by_reference(db, "images:debian/10") is None, "rien n'a ete ecrit"


def test_cocher_dix_entrees_ne_lit_le_depot_QU_UNE_FOIS(db):
    """La preuve est commune au lot : c'est la raison d'etre du lot (§33.6)."""
    appels: list[str] = []
    images.add_selection(
        db, ["images:debian/10", "images:debian/9", "images:freebsd/14.4"],
        fetch=lecteur(compteur=appels))
    assert len(appels) == 1
    assert len(images.listing(db)) == len(images.DEFAULTS) + 3


def test_une_entree_deja_au_catalogue_est_ignoree_sans_erreur(db):
    """Cochee entre-temps par quelqu'un d'autre : l'entree est la, c'est le but."""
    resultat = images.add_selection(
        db, ["images:debian/13", "images:debian/10"], fetch=lecteur())
    assert resultat["skipped"] == ["images:debian/13"]
    assert [e["reference"] for e in resultat["added"]] == ["images:debian/10"]


def test_l_architecture_retenue_est_celle_que_le_depot_publie(db):
    """`alpine/3.21` n'existe qu'en arm64 ici : ecrire « amd64 » serait faux."""
    images.add_selection(db, ["images:alpine/3.21"], fetch=lecteur())
    # deja pre-renseignee : c'est l'entree existante qu'on lit, on prend une autre
    images.add_selection(db, ["images:debian/9"], fetch=lecteur())
    assert images.by_reference(db, "images:debian/9")["architecture"] == "amd64"


def test_cocher_sans_rien_cocher_est_refuse(db):
    with pytest.raises(ImageError, match="Aucune image"):
        images.add_selection(db, [], fetch=lecteur())


# --- retirer, et ses deux refus (§33.7) --------------------------------------


def test_retirer_une_entree_inutilisee_aboutit(db):
    entree = images.by_reference(db, "images:alpine/3.21")
    images.remove(db, entree["id"])
    assert images.by_reference(db, "images:alpine/3.21") is None


def test_retirer_l_entree_par_DEFAUT_est_refuse(db):
    """L'ecran de creation s'en sert comme preselection (§33.5)."""
    entree = images.by_reference(db, "images:debian/13")
    assert entree["is_default"]
    with pytest.raises(ImageError, match="par défaut"):
        images.remove(db, entree["id"])
    assert images.by_reference(db, "images:debian/13") is not None


def test_retirer_une_entree_INEXISTANTE_est_refuse(db):
    with pytest.raises(ImageError, match="n'est pas au catalogue"):
        images.remove(db, "00000000000000000000000000000000")


# --- par l'API ---------------------------------------------------------------


def _client(tmp_path):
    return TestClient(create_app(load({"SPARKD_DB": str(tmp_path / "a.db"),
                                       "SPARKD_DRIVER": "fake"})))


def test_le_pilote_factice_lit_le_depot_SANS_reseau_sortant(tmp_path):
    """§28.1 : la pile de developpement tient sans reseau, comme FakeIncus."""
    client = _client(tmp_path)
    vue = client.get("/v1/images/depot")
    assert vue.status_code == 200

    corps = vue.json()
    lignes = {v["alias"]: v for f in corps["familles"] for v in f["versions"]}
    tenues = {a for _, _, _, a, _ in images.DEFAULTS}
    assert tenues <= set(lignes), "les pre-renseignees sont proposees"
    assert all(lignes[a]["au_catalogue"] for a in tenues), "et deja tenues"


def test_le_depot_factice_propose_PLUS_que_ce_que_le_catalogue_tient(tmp_path):
    """Sans cela, la liste a cocher serait vide et l'unite indemontrable.

    Le seed est un contrat (CLAUDE.md §8) : il doit permettre de demontrer ce qui
    est livre. Un depot factice reduit aux quatre references deja posees rendrait
    l'ecran veridique et inutile.
    """
    client = _client(tmp_path)
    corps = client.get("/v1/images/depot").json()
    a_cocher = [v["alias"] for f in corps["familles"] for v in f["versions"]
                if not v["au_catalogue"]]
    assert a_cocher, "il y a de quoi cocher dans la pile de developpement"


def test_le_depot_factice_a_la_MEME_FORME_que_le_vrai(tmp_path):
    """Les trois doublons du §33.3 s'eprouvent donc sans reseau sortant."""
    client = _client(tmp_path)
    corps = client.get("/v1/images/depot").json()
    debian = next(f for f in corps["familles"] if f["famille"] == "debian")
    treize = next(v for v in debian["versions"] if v["alias"] == "debian/13")

    assert "debian/trixie" in treize["synonymes"], "le nom de code"
    assert "debian/13/default" in treize["synonymes"], "la variante par defaut"
    assert [v["alias"] for v in treize["variantes"]] == ["debian/13/cloud"], \
        "et la variante nommee, qui reste une ligne a part"


def test_un_depot_injoignable_rend_un_502_qui_le_NOMME(tmp_path, monkeypatch):
    """§33.6 : la console doit pouvoir le dire, et offrir le repli."""
    monkeypatch.setattr(images, "fake_fetch", injoignable)
    client = _client(tmp_path)

    refus = client.get("/v1/images/depot")
    assert refus.status_code == 502
    detail = refus.json()["detail"]
    assert detail["error"] == "depot_unreachable"
    assert "injoignable" in detail["message"], "le refus porte la cause"


def test_la_saisie_libre_reste_operante_quand_le_depot_ne_repond_pas(tmp_path,
                                                                     monkeypatch):
    """Le repli du §33.6 : sinon un depot muet supprimerait la seule voie restante."""
    monkeypatch.setattr(images, "fake_fetch", injoignable)
    client = _client(tmp_path)
    assert client.get("/v1/images/depot").status_code == 502

    pose = client.post("/v1/images", json={"reference": "images:fedora/41",
                                           "label": "Fedora 41"})
    assert pose.status_code == 201
    assert pose.json()["state"] == UNKNOWN, "une declaration ne prouve rien"


def test_cocher_par_l_API_rend_l_image_choisissable_a_la_creation(tmp_path):
    """Le parcours de l'unite, vu du serveur : cocher, puis creer avec."""
    client = _client(tmp_path)
    client.post("/v1/forge/sync")

    pose = client.post("/v1/images", json={"references": ["images:debian/12"]})
    assert pose.status_code == 201

    # `debian/12` est pre-renseignee : deja tenue, donc ignoree sans erreur.
    assert pose.json()["skipped"] == ["images:debian/12"]

    propose = client.get("/v1/images").json()
    assert "images:debian/12" in propose["selectable"]


def test_retirer_une_image_EMPLOYEE_par_un_Spark_est_refuse_et_les_NOMME(tmp_path):
    """§33.7 : ce n'est pas l'integrite, c'est la lisibilite qui est en jeu."""
    client = _client(tmp_path)
    client.post("/v1/forge/sync")
    cree = client.post("/v1/sparks", json={
        "name": "porteur", "image": "images:ubuntu/24.04", "cpu_mode": "shared",
        "cpu_reservation": 0.5, "memory_bytes": GIO, "storage_bytes": GIO,
        "network_bps": 10_000_000})
    assert cree.status_code == 201, cree.text

    entree = next(e for e in client.get("/v1/images").json()["images"]
                  if e["reference"] == "images:ubuntu/24.04")
    refus = client.delete(f"/v1/images/{entree['id']}")

    assert refus.status_code == 422
    assert "porteur" in refus.json()["detail"]["message"], "le refus NOMME le Spark"
    assert any(e["reference"] == "images:ubuntu/24.04"
               for e in client.get("/v1/images").json()["images"])


def test_retirer_une_image_libre_par_l_API_aboutit(tmp_path):
    client = _client(tmp_path)
    entree = next(e for e in client.get("/v1/images").json()["images"]
                  if e["reference"] == "images:alpine/3.21")

    assert client.delete(f"/v1/images/{entree['id']}").status_code == 200
    assert not any(e["reference"] == "images:alpine/3.21"
                   for e in client.get("/v1/images").json()["images"])
