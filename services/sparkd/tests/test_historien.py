"""@verifies docs/BACKLOG.md#SPK-93 · docs/DAT.md §52 (l'historien), §52.3 (ce
qu'une ligne dit), §52.4 (deux causes a un trou), §52.5 (retention), §52.6
(re-echantillonnage), §52.7 (l'agregat), §52.10 (le doublon) · §20.1 (`null`,
jamais `0`), §20.4 (un Spark arrete) · docs/SCHEMA.md §10 sexies

Le piege que ces preuves gardent : une courbe ment plus facilement qu'un
chiffre. Un seau vide rendu `0` trace une ligne au sol qu'on lit comme « il ne
consommait rien », et un trou sans cause trace le meme blanc qu'un Spark arrete
et qu'un sparkd eteint. Les deux erreurs sont invisibles a l'oeil.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from sparkd import historian, images, metrics
from sparkd.db import connect
from sparkd.incus import FakeIncus, IncusError, InstanceAbsente, etat_simule
from sparkd.migrations import upgrade
from sparkd.sparks import SparkSpec, create

GIO = 1024**3
T0 = datetime(2026, 9, 7, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "h.db")
    upgrade(connection)
    connection.execute(
        "INSERT INTO forge (id, hostname, cpu_threads_total, cpu_cores_total, "
        "memory_total_bytes, storage_total_bytes, network_total_bps) "
        "VALUES (1, 'forge', 8, 4, ?, ?, 1000000000)",
        (94 * GIO, 5000 * GIO))
    # Depuis SPK-32, la creation n'accepte qu'une image du catalogue VERIFIEE.
    images.seed_defaults(connection)
    images.verify(connection, fetch=images.fake_fetch)
    yield connection
    connection.close()


def _spec(nom, **champs):
    base = dict(name=nom, image="images:debian/13", cpu_mode="shared",
                cpu_reservation=0.5, memory_bytes=2 * GIO,
                network_bps=100_000_000, storage_bytes=10 * GIO)
    base.update(champs)
    return SparkSpec(**base)


def _poser(db, nom, state, cellule=None):
    spark = create(db, _spec(nom))
    db.execute("UPDATE spark SET state = ?, incus_name = ? WHERE id = ?",
               (state, cellule, spark["id"]))
    return spark["id"]


class PiloteMuet:
    """Un pilote qui ne repond a rien : la cellule a disparu."""

    def __init__(self, erreur=InstanceAbsente):
        self.erreur = erreur

    def instance_state(self, name):
        raise self.erreur(f"Aucune instance « {name} ».")


# --------------------------------------------------------------------------- #
# Le relevé (§52.3)
# --------------------------------------------------------------------------- #

def test_un_spark_arrete_a_une_ligne_SANS_mesure_et_sans_appel_au_pilote(db):
    """§20.4, §52.3 : un Spark arrete n'a pas un usage nul, il n'en a pas.

    La ligne existe pourtant — c'est tout son interet — et le pilote n'est PAS
    interroge : le §52.3 refuse de depenser un appel par Spark eteint et par tic.
    """
    _poser(db, "dormeur", "stopped", "dormeur")
    pilote = PiloteMuet()  # tout appel leverait

    lignes = historian.relever(db, pilote, metrics.RateTracker())

    assert len(lignes) == 1
    ligne = lignes[0]
    assert ligne["state"] == "stopped"
    for colonne in historian.MESURES:
        assert ligne[colonne] is None, f"{colonne} devrait etre NULL, pas 0"


def test_le_PREMIER_releve_porte_memoire_et_disque_mais_ni_CPU_ni_reseau(db):
    """§20.1 : memoire et disque sont instantanees, CPU et reseau sont des
    COMPTEURS. Un compteur seul ne fait pas un taux, et `0` serait une mesure
    affirmee sans avoir ete faite."""
    _poser(db, "helo", "running", "helo")
    pilote = FakeIncus(created={"helo": {"name": "helo", "status": "Running"}})

    premier = historian.relever(db, pilote, metrics.RateTracker())[0]

    assert premier["memory_bytes"] is not None
    assert premier["disk_bytes"] is not None
    assert premier["cpu_used"] is None
    assert premier["net_rx_bps"] is None
    assert premier["window_seconds"] is None


def test_le_second_releve_porte_un_taux_parce_que_les_compteurs_AVANCENT(db):
    """§52.10 : un compteur qui n'avance pas n'est pas un compteur. Sans cette
    fidelite du doublon, la supervision resterait a `null` indefiniment contre
    la pile de developpement."""
    spark_id = _poser(db, "helo", "running", "helo")
    pilote = FakeIncus(created={"helo": {"name": "helo", "status": "Running"}})
    rates = metrics.RateTracker()

    historian.relever(db, pilote, rates)
    # Le taux exige une FENETRE. On recule le releve precedent de quinze
    # secondes plutot que d'attendre quinze secondes : la preuve porte sur le
    # calcul du taux, pas sur la patience de qui l'execute.
    rates.previous[spark_id] = metrics.Sample(
        at=rates.previous[spark_id].at - 15.0, cpu_ns=0, rx_bytes=0, tx_bytes=0)
    second = historian.relever(db, pilote, rates)[0]

    assert second["window_seconds"] == pytest.approx(15.0, abs=1.0)
    assert second["cpu_used"] > 0
    assert second["net_rx_bps"] > 0


@pytest.mark.parametrize("erreur", [InstanceAbsente, IncusError])
def test_une_cellule_que_le_pilote_ne_sait_pas_mesurer_ne_produit_AUCUNE_ligne(db, erreur):
    """§52.4 : « personne n'a releve » est exact, et c'est un fait sur la FORGE.

    Ecrire une ligne `running` sans mesure la ferait lire comme un premier
    releve — c'est-a-dire comme une mesure EN COURS —, ce qui serait faux."""
    _poser(db, "perdu", "running", "perdu")

    lignes = historian.relever(db, PiloteMuet(erreur), metrics.RateTracker())

    assert lignes == []


def test_une_cellule_perdue_ne_fait_pas_tomber_le_releve_des_AUTRES(db):
    """Une cellule perdue est un fait sur elle, pas une panne de la supervision."""
    _poser(db, "aaa-perdu", "running", "aaa-perdu")
    _poser(db, "zzz-vivant", "running", "zzz-vivant")

    class Selectif:
        def instance_state(self, name):
            if name == "aaa-perdu":
                raise InstanceAbsente("disparue")
            return etat_simule(name, 42.0)

    lignes = historian.relever(db, Selectif(), metrics.RateTracker())

    assert [l["state"] for l in lignes] == ["running"]
    assert lignes[0]["memory_bytes"] is not None


# --------------------------------------------------------------------------- #
# L'écriture, la purge, la cascade (§52.5)
# --------------------------------------------------------------------------- #

def test_la_purge_retire_ce_qui_depasse_la_retention(db):
    spark_id = _poser(db, "helo", "stopped", "helo")
    for age_heures in (0, 2, 30):
        historian.ecrire(db, [{
            "spark_id": spark_id,
            "sampled_at": (T0 - timedelta(hours=age_heures)).isoformat(timespec="seconds"),
            "state": "stopped", "window_seconds": None,
            **{c: None for c in historian.MESURES}}])

    otees = historian.purger(db, retention_secondes=24 * 3600, reference=T0)

    assert otees == 1
    reste = db.execute("SELECT COUNT(*) AS n FROM metric_sample").fetchone()["n"]
    assert reste == 2


def test_une_retention_NULLE_ne_purge_RIEN(db):
    """§52.5 : `0` desactive la purge, il ne veut pas dire « ne rien garder ».

    L'autre lecture viderait la table a chaque tic, et la supervision
    fonctionnerait sans jamais rien montrer."""
    spark_id = _poser(db, "helo", "stopped", "helo")
    historian.ecrire(db, [{
        "spark_id": spark_id,
        "sampled_at": (T0 - timedelta(days=900)).isoformat(timespec="seconds"),
        "state": "stopped", "window_seconds": None,
        **{c: None for c in historian.MESURES}}])

    assert historian.purger(db, retention_secondes=0, reference=T0) == 0
    assert db.execute("SELECT COUNT(*) AS n FROM metric_sample").fetchone()["n"] == 1


def test_supprimer_un_spark_emporte_ses_mesures(db):
    """§14.4 : ce qui est rendu a la suppression l'est entierement."""
    spark_id = _poser(db, "helo", "stopped", "helo")
    historian.ecrire(db, [{
        "spark_id": spark_id, "sampled_at": T0.isoformat(timespec="seconds"),
        "state": "stopped", "window_seconds": None,
        **{c: None for c in historian.MESURES}}])

    db.execute("DELETE FROM spark WHERE id = ?", (spark_id,))

    assert db.execute("SELECT COUNT(*) AS n FROM metric_sample").fetchone()["n"] == 0


# --------------------------------------------------------------------------- #
# Le ré-échantillonnage (§52.6)
# --------------------------------------------------------------------------- #

def _remplir(db, spark_id, valeurs, depart=T0, pas=15):
    lignes = []
    for index, cpu in enumerate(valeurs):
        lignes.append({
            "spark_id": spark_id,
            "sampled_at": (depart + timedelta(seconds=index * pas)).isoformat(
                timespec="seconds"),
            "state": "running" if cpu is not None else "stopped",
            "window_seconds": 15.0,
            "cpu_used": cpu,
            "memory_bytes": None if cpu is None else 1024,
            "disk_bytes": None if cpu is None else 2048,
            "net_rx_bps": None if cpu is None else 100,
            "net_tx_bps": None if cpu is None else 50,
        })
    historian.ecrire(db, lignes)


def test_un_seau_SANS_releve_rend_null_et_jamais_zero(db):
    """§52.6 regle 1 — et c'est la regle qui decide de toute la lecture.

    `0` tracerait une ligne au sol qu'on lit comme « il ne consommait rien ».
    Recopier le seau precedent ferait apparaitre une continuite que rien n'a
    mesuree. Les deux erreurs sont indetectables a l'oeil."""
    spark_id = _poser(db, "helo", "running", "helo")
    # Deux relevés, puis un trou de deux seaux, puis un relevé.
    _remplir(db, spark_id, [0.4, 0.6])
    _remplir(db, spark_id, [0.8], depart=T0 + timedelta(seconds=60))

    serie = historian.serie(db, spark_id, T0, pas=15.0, points=5)

    assert [p["cpu"] for p in serie] == [0.4, 0.6, None, None, 0.8]
    assert [p["samples"] for p in serie] == [1, 1, 0, 0, 1]


def test_un_seau_moyenne_ses_releves_et_dit_combien_il_en_a(db):
    spark_id = _poser(db, "helo", "running", "helo")
    _remplir(db, spark_id, [0.2, 0.4, 0.6, 0.8], pas=15)

    serie = historian.serie(db, spark_id, T0, pas=30.0, points=2)

    assert [p["cpu"] for p in serie] == [0.3, 0.7]
    assert [p["samples"] for p in serie] == [2, 2]


def test_une_grandeur_manquante_n_efface_pas_les_autres_du_meme_seau(db):
    """Un premier releve a une memoire sans taux : moyenner grandeur par
    grandeur est la seule facon de ne perdre ni l'une ni l'autre."""
    spark_id = _poser(db, "helo", "running", "helo")
    historian.ecrire(db, [{
        "spark_id": spark_id, "sampled_at": T0.isoformat(timespec="seconds"),
        "state": "running", "window_seconds": None, "cpu_used": None,
        "memory_bytes": 4096, "disk_bytes": 8192,
        "net_rx_bps": None, "net_tx_bps": None}])

    point = historian.serie(db, spark_id, T0, pas=15.0, points=1)[0]

    assert point["cpu"] is None and point["rx_bps"] is None
    assert point["memory_bytes"] == 4096 and point["disk_bytes"] == 8192
    assert point["states"] == ["running"]


def test_un_seau_NOMME_les_etats_qu_il_a_traverses(db):
    """§52.4 : un trou du a l'arret se distingue d'un trou du a l'absence de
    releve. C'est `states` qui porte cette difference jusqu'a l'ecran."""
    spark_id = _poser(db, "helo", "running", "helo")
    _remplir(db, spark_id, [None, None])

    point = historian.serie(db, spark_id, T0, pas=30.0, points=1)[0]

    assert point["states"] == ["stopped"]
    assert point["samples"] == 2
    assert point["cpu"] is None


# --------------------------------------------------------------------------- #
# Les bornes de fenêtre (§52.6)
# --------------------------------------------------------------------------- #

def test_le_nombre_de_points_est_PLAFONNE_par_la_cadence():
    """Sinon 240 points sur 15 minutes donneraient des seaux de 3,75 s, dont
    cinq sur six seraient vides : une courbe pointillee sans qu'aucune mesure ne
    manque, donc une panne inexistante a chercher."""
    bornes = historian.fenetre("15m", 240, cadence=15.0)

    assert bornes["points"] == 60
    assert bornes["bucket_seconds"] == 15.0


def test_une_cadence_nulle_ne_plafonne_rien():
    """Historien desactive : il n'y a plus de cadence a respecter."""
    assert historian.fenetre("15m", 240, cadence=0.0)["points"] == 240


@pytest.mark.parametrize("nom,points", [
    ("30m", None), ("1j", None), ("1 heure", None), ("1h", 0), ("1h", -3),
    ("1h", historian.POINTS_MAX + 1),
])
def test_une_fenetre_ou_un_nombre_de_points_hors_bornes_est_REFUSE(nom, points):
    with pytest.raises(historian.FenetreInvalide):
        historian.fenetre(nom, points, cadence=15.0)


@pytest.mark.parametrize("vide", [None, ""])
def test_une_fenetre_VIDE_vaut_non_demandee_et_non_refusee(vide):
    """Un `?window=` sans valeur arrive en chaine vide. La refuser ferait
    echouer une requete que personne n'a voulu mal former."""
    assert historian.fenetre(vide, None, cadence=15.0)["nom"] == historian.FENETRE_DEFAUT


def test_la_fenetre_par_defaut_est_offerte_sans_rien_demander():
    bornes = historian.fenetre(None, None, cadence=15.0)
    assert bornes["nom"] == historian.FENETRE_DEFAUT


# --------------------------------------------------------------------------- #
# L'agrégat de la Forge (§52.7)
# --------------------------------------------------------------------------- #

def test_l_agregat_SOMME_et_dit_combien_de_sparks_il_somme(db):
    """§52.7 : une somme dont le nombre de termes varie change de marche sans
    que rien n'ait bouge dans la machine. Publier `sparks` laisse l'ecran nommer
    la marche au lieu de la faire lire comme un incident."""
    un = _poser(db, "un", "running", "un")
    deux = _poser(db, "deux", "running", "deux")
    _remplir(db, un, [0.4, 0.4])
    # Le second n'existe que sur le SECOND seau.
    _remplir(db, deux, [1.0], depart=T0 + timedelta(seconds=15))

    total = historian.agregat(db, T0, pas=15.0, points=2)

    assert [p["sparks"] for p in total] == [1, 2]
    assert [p["cpu"] for p in total] == [0.4, 1.4]


def test_un_spark_ARRETE_ne_compte_PAS_parmi_ceux_que_la_somme_somme(db):
    """§52.7 : `sparks` doit EXPLIQUER la marche, donc ne compter que ceux qui
    ajoutent quelque chose. Un Spark arrete a bien une ligne — sans quoi son
    arret serait indiscernable d'une panne de la supervision (§52.4) — mais il
    n'ajoute rien : le compter ferait annoncer « somme de 8 Sparks » sous une
    courbe qui n'en somme que quatre."""
    marche = _poser(db, "marche", "running", "marche")
    dort = _poser(db, "dort", "stopped", "dort")
    _remplir(db, marche, [0.4])
    _remplir(db, dort, [None])

    seul = historian.agregat(db, T0, pas=15.0, points=1)[0]

    assert seul["sparks"] == 1, "un seul Spark a contribue a la somme"
    assert seul["samples"] == 2, "mais DEUX releves ont bien ete pris"
    assert seul["cpu"] == 0.4


def test_un_seau_sans_aucun_spark_reste_null_dans_l_agregat(db):
    _poser(db, "un", "running", "un")
    total = historian.agregat(db, T0, pas=15.0, points=3)

    assert [p["cpu"] for p in total] == [None, None, None]
    assert [p["sparks"] for p in total] == [0, 0, 0]


def test_le_dernier_releve_se_lit_pour_la_forge_et_pour_un_spark(db):
    un = _poser(db, "un", "running", "un")
    _poser(db, "deux", "running", "deux")
    _remplir(db, un, [0.4, 0.5])

    assert historian.dernier_releve(db) == (
        T0 + timedelta(seconds=15)).isoformat(timespec="seconds")
    assert historian.dernier_releve(db, un) is not None
    assert historian.dernier_releve(db, "inconnu") is None


# --------------------------------------------------------------------------- #
# Le tic complet, et le fil (§52.2)
# --------------------------------------------------------------------------- #

def test_un_tic_ecrit_une_ligne_par_spark_et_purge(db, tmp_path):
    _poser(db, "helo", "running", "helo")
    _poser(db, "dormeur", "stopped", "dormeur")
    pilote = FakeIncus(created={"helo": {"name": "helo", "status": "Running"}})

    compte = historian.tic(db, pilote, metrics.RateTracker(), retention_secondes=7 * 86400)

    assert compte["ecrites"] == 2
    assert db.execute("SELECT COUNT(*) AS n FROM metric_sample").fetchone()["n"] == 2


def test_une_cadence_nulle_DESACTIVE_l_historien(tmp_path):
    """§52.2 : c'est une configuration, pas une panne. Le fil ne demarre pas."""
    fil = historian.Historien(
        ouvrir=lambda: connect(tmp_path / "x.db"), incus=None,
        interval=0.0, retention=0.0)

    assert fil.actif is False


def test_un_tic_qui_echoue_ne_TUE_pas_le_fil(db, tmp_path, monkeypatch):
    """Une supervision qui cesse silencieusement laisse un trou indiscernable
    d'un arret de sparkd (§52.4). On compte l'erreur, et on retente."""
    chemin = tmp_path / "h.db"
    connection = connect(chemin)
    upgrade(connection)
    connection.close()

    fil = historian.Historien(
        ouvrir=lambda: connect(chemin), incus=None, interval=1.0, retention=0.0)
    monkeypatch.setattr(historian, "relever",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boum")))

    assert fil.un_tic() is None
    assert fil.erreurs == 1


# --------------------------------------------------------------------------- #
# Le doublon (§52.10)
# --------------------------------------------------------------------------- #

def test_les_compteurs_du_doublon_AVANCENT_et_ne_reculent_jamais():
    """Un compteur qui n'avance pas n'est pas un compteur (§12.1.3, §52.10)."""
    precedent = etat_simule("helo", 0.0)
    for seconde in range(1, 1800, 7):
        courant = etat_simule("helo", float(seconde))
        assert courant["cpu"]["usage"] >= precedent["cpu"]["usage"]
        assert (courant["network"]["eth0"]["counters"]["bytes_received"]
                >= precedent["network"]["eth0"]["counters"]["bytes_received"])
        precedent = courant


def test_le_profil_du_doublon_est_DETERMINISTE():
    """Sans quoi les captures du §30.1 cesseraient d'etre reproductibles."""
    assert etat_simule("helo", 123.0) == etat_simule("helo", 123.0)


def test_deux_sparks_du_doublon_n_ont_pas_le_meme_profil():
    """Quatre Sparks superposant la meme courbe ne prouveraient pas que l'ecran
    les distingue."""
    a = etat_simule("helo", 300.0)
    b = etat_simule("crm-production", 300.0)
    assert a["cpu"]["usage"] != b["cpu"]["usage"]
    assert a["memory"]["usage"] != b["memory"]["usage"]


def test_le_taux_du_doublon_VARIE_dans_le_temps():
    """Une ligne plate n'eprouve ni la mise a l'echelle d'un axe, ni la
    distinction burst du SPK-DS-02."""
    def taux(depart):
        avant = etat_simule("helo", depart)["cpu"]["usage"]
        apres = etat_simule("helo", depart + 15.0)["cpu"]["usage"]
        return (apres - avant) / (15 * 1e9)

    releves = [taux(t) for t in range(0, 900, 60)]
    assert min(releves) > 0
    assert max(releves) > min(releves) * 1.2, "le taux doit respirer"


def test_le_doublon_rend_AUSSI_les_bridges_docker():
    """§20.2 : la regle « seule eth0 compte » doit avoir de quoi s'eprouver."""
    etat = etat_simule("helo", 300.0)
    assert "docker0" in etat["network"]
    assert (etat["network"]["docker0"]["counters"]["bytes_received"]
            > etat["network"]["eth0"]["counters"]["bytes_received"])
