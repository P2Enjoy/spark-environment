"""@verifies docs/BACKLOG.md#SPK-12 · docs/DAT.md §9, §18 · docs/SCHEMA.md §6

La DoD nomme trois choses : application a chaud, reconstruction COMPLETE depuis
le registre, et conflit de domaine refuse PAR LA BASE. Les trois sont ici.
"""

from __future__ import annotations

import pytest

from sparkd import ingress, migrations
from sparkd.db import connect

GIO = 1024**3


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "i.db")
    migrations.upgrade(connection)
    yield connection
    connection.close()


def poser_spark(db, ident, nom, adresse="10.77.0.16"):
    db.execute(
        "INSERT INTO spark (id,name,image,cpu_mode,cpu_reservation,"
        "memory_reservation_bytes,network_reservation_bps,storage_bytes,"
        "ipv4_address,created_at,updated_at) VALUES (?,?,?,'shared',0.5,?,?,?,?,'x','x')",
        (ident, nom, "images:debian/13", GIO, 10_000_000, GIO, adresse))


# --- declaration ------------------------------------------------------------

def test_declaration(db):
    poser_spark(db, "S1", "crm")
    r = ingress.declare(db, "S1", "crm.example.com", 8080)
    assert r["domain"] == "crm.example.com" and r["target_port"] == 8080
    assert r["tls"] == 1 and r["enabled"] == 1
    assert r["applied_at"] is None      # rien n'est applique a la declaration


def test_le_domaine_est_normalise(db):
    poser_spark(db, "S1", "crm")
    assert ingress.declare(db, "S1", "  CRM.Example.COM ", 8080)["domain"] == "crm.example.com"


@pytest.mark.parametrize("domaine", ["", "pas-un-domaine", "http://x.com", "x", ".com", "a b.com"])
def test_domaine_invalide_refuse(db, domaine):
    poser_spark(db, "S1", "crm")
    with pytest.raises(ingress.IngressError, match="invalide"):
        ingress.declare(db, "S1", domaine, 8080)


def test_joker_accepte(db):
    poser_spark(db, "S1", "crm")
    assert ingress.declare(db, "S1", "*.crm.example.com", 8080)["domain"].startswith("*.")


@pytest.mark.parametrize("port", [0, 70000, -1])
def test_port_hors_bornes_refuse(db, port):
    poser_spark(db, "S1", "crm")
    with pytest.raises(ingress.IngressError, match="hors bornes"):
        ingress.declare(db, "S1", "crm.example.com", port)


# --- conflit de domaine : la DoD l'exige PAR LA BASE ------------------------

def test_conflit_de_domaine_refuse(db):
    poser_spark(db, "S1", "crm")
    poser_spark(db, "S2", "boutique", "10.77.0.17")
    ingress.declare(db, "S1", "crm.example.com", 8080)
    with pytest.raises(ingress.IngressError, match="déjà routé vers le Spark « crm »"):
        ingress.declare(db, "S2", "crm.example.com", 9090)


def test_l_unicite_est_portee_par_la_base_pas_par_le_code(db):
    """docs/DAT.md §18.4 — un controle applicatif ne protege pas de deux
    requetes simultanees."""
    import sqlite3
    poser_spark(db, "S1", "crm")
    ingress.declare(db, "S1", "crm.example.com", 8080)
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO ingress_route (id,domain,spark_id,target_port)"
                   " VALUES ('x','crm.example.com','S1',9090)")


def test_le_domaine_libere_est_reutilisable(db):
    poser_spark(db, "S1", "crm")
    poser_spark(db, "S2", "boutique", "10.77.0.17")
    ingress.declare(db, "S1", "crm.example.com", 8080)
    ingress.withdraw(db, "crm.example.com")
    assert ingress.declare(db, "S2", "crm.example.com", 9090)["target_port"] == 9090


# --- construction de la configuration ---------------------------------------

def test_config_vide_ne_sert_que_le_refus(db):
    serveur = ingress.build_config(db)["apps"]["http"]["servers"]["spark"]
    assert serveur["listen"] == [":80", ":443"]
    assert len(serveur["routes"]) == 1
    assert serveur["routes"][0]["handle"][0]["status_code"] == 404


def test_un_domaine_non_route_est_refuse_pas_accepte(db):
    """Mesure : sans route terminale, Caddy rend 200 et un corps vide pour TOUT
    domaine. L'hote repondrait pour des noms qu'il ne sert pas, et une erreur de
    pointage DNS resterait invisible."""
    poser_spark(db, "S1", "crm")
    ingress.declare(db, "S1", "crm.example.com", 8080)
    routes = ingress.build_config(db)["apps"]["http"]["servers"]["spark"]["routes"]
    terminale = routes[-1]
    assert "match" not in terminale            # elle attrape tout le reste
    assert terminale["handle"][0]["status_code"] == 404
    # Et elle vient APRES les routes nommees, sans quoi elle les masquerait.
    assert routes[0]["match"][0]["host"] == ["crm.example.com"]


def test_l_amont_vient_du_registre(db):
    """docs/DAT.md §18.2 — jamais d'une decouverte par Docker."""
    poser_spark(db, "S1", "crm", "10.77.0.42")
    ingress.declare(db, "S1", "crm.example.com", 8080)
    route = ingress.build_config(db)["apps"]["http"]["servers"]["spark"]["routes"][0]
    assert route["match"][0]["host"] == ["crm.example.com"]
    assert route["handle"][0]["upstreams"][0]["dial"] == "10.77.0.42:8080"


def test_une_route_sur_un_spark_sans_adresse_n_est_pas_servie(db):
    """On declare avant de creer ; rien ne peut la servir encore."""
    poser_spark(db, "S1", "pas-encore", adresse=None)
    ingress.declare(db, "S1", "crm.example.com", 8080)
    routes = ingress.build_config(db)["apps"]["http"]["servers"]["spark"]["routes"]
    assert len(routes) == 1 and "match" not in routes[0]   # seule la terminale


def test_une_route_desactivee_n_est_pas_servie(db):
    poser_spark(db, "S1", "crm")
    r = ingress.declare(db, "S1", "crm.example.com", 8080)
    db.execute("UPDATE ingress_route SET enabled = 0 WHERE id = ?", (r["id"],))
    routes = ingress.build_config(db)["apps"]["http"]["servers"]["spark"]["routes"]
    assert len(routes) == 1 and "match" not in routes[0]


def test_une_route_en_clair_est_soustraite_au_tls_automatique(db):
    """Sinon Caddy tenterait d'emettre un certificat que personne n'a demande."""
    poser_spark(db, "S1", "crm")
    ingress.declare(db, "S1", "interne.example.com", 8080, tls=False)
    serveur = ingress.build_config(db)["apps"]["http"]["servers"]["spark"]
    assert serveur["automatic_https"]["skip"] == ["interne.example.com"]


def test_pas_de_skip_quand_tout_est_en_tls(db):
    poser_spark(db, "S1", "crm")
    ingress.declare(db, "S1", "crm.example.com", 8080)
    assert "automatic_https" not in ingress.build_config(db)["apps"]["http"]["servers"]["spark"]


# --- reconciliation : le mecanisme NORMAL -----------------------------------

def test_la_reconciliation_applique_et_date(db):
    poser_spark(db, "S1", "crm")
    ingress.declare(db, "S1", "crm.example.com", 8080)
    faux = ingress.FakeCaddy()
    resultat = ingress.reconcile(db, faux)
    # Le compte annonce les routes SERVIES, la terminale n'en est pas une.
    assert resultat["routes"] == 1
    assert faux.config == resultat["config"]
    assert ingress.by_domain(db, "crm.example.com")["applied_at"] is not None


def test_la_configuration_est_REGENEREE_pas_rapiecee(db):
    """Le coeur du §18.1 : une route retiree disparait de la configuration."""
    poser_spark(db, "S1", "crm")
    ingress.declare(db, "S1", "a.example.com", 8080)
    ingress.declare(db, "S1", "b.example.com", 9090)
    faux = ingress.FakeCaddy()
    ingress.reconcile(db, faux)
    assert len(faux.config["apps"]["http"]["servers"]["spark"]["routes"]) == 3  # 2 + terminale

    ingress.withdraw(db, "a.example.com")
    ingress.reconcile(db, faux)
    hotes = [r["match"][0]["host"][0]
             for r in faux.config["apps"]["http"]["servers"]["spark"]["routes"] if "match" in r]
    assert hotes == ["b.example.com"]


def test_caddy_injoignable_est_signale_pas_masque(db):
    poser_spark(db, "S1", "crm")
    ingress.declare(db, "S1", "crm.example.com", 8080)
    with pytest.raises(ingress.IngressError):
        ingress.reconcile(db, ingress.FakeCaddy(fail=True))
    # La route n'est PAS marquee appliquee : la derive reste visible (§18.5).
    assert ingress.by_domain(db, "crm.example.com")["applied_at"] is None
    ligne = db.execute(
        "SELECT * FROM audit_log WHERE action='ingress.reconcile'"
    ).fetchone()
    assert ligne["result"] == "error"


def test_la_suppression_d_un_spark_emporte_ses_routes(db):
    poser_spark(db, "S1", "crm")
    ingress.declare(db, "S1", "crm.example.com", 8080)
    db.execute("DELETE FROM spark WHERE id='S1'")
    assert ingress.listing(db) == []


# --- SPK-48 · le joker et la préséance (docs/DAT.md §18.3 bis) ---------------


def test_les_trois_bornes_du_joker_sont_refusees_en_les_nommant(db):
    """@verifies docs/BACKLOG.md#SPK-48 · docs/DAT.md §18.3 bis

    Un joker ne vaut qu'en tête et sur UN seul niveau. Le refus NOMME la borne :
    « invalide » seul laisserait chercher entre une faute de frappe et une règle
    du produit.
    """
    poser_spark(db, "01J0", "demo")
    for mauvais in ("*.*.monapi.fr", "api.*.monapi.fr", "*.fr", "*"):
        with pytest.raises(ingress.IngressError) as leve:
            ingress.declare(db, "01J0", mauvais, 8080)
        assert "joker" in str(leve.value), mauvais


def test_un_joker_de_premier_niveau_est_accepte(db):
    poser_spark(db, "01J0", "demo")
    route = ingress.declare(db, "01J0", "*.monapi.fr", 8080)
    assert route["domain"] == "*.monapi.fr"


def test_un_joker_ne_couvre_QU_UN_niveau(db):
    """C'est la règle du DNS et celle de Caddy. En adopter une autre ferait
    diverger ce que le produit affiche de ce que le trafic fait réellement."""
    assert ingress.covers("*.monapi.fr", "api.monapi.fr")
    assert not ingress.covers("*.monapi.fr", "a.b.monapi.fr")
    assert not ingress.covers("*.monapi.fr", "monapi.fr")
    assert not ingress.covers("*.monapi.fr", "api.autre.fr")
    assert ingress.covers("api.monapi.fr", "api.monapi.fr")


def test_le_plus_SPECIFIQUE_passe_avant_dans_la_configuration(db):
    """LE cœur de l'unité, et il ne se voit pas à l'écran.

    Caddy retient la PREMIÈRE route qui correspond. Le listing triait par ordre
    alphabétique, où « * » précède les lettres : « *.monapi.fr » passait donc
    avant « api.monapi.fr » et le joker gagnait, à l'inverse exact de la règle.
    """
    poser_spark(db, "01J0", "general", "10.77.0.10")
    poser_spark(db, "01J1", "dedie", "10.77.0.11")
    ingress.declare(db, "01J0", "*.monapi.fr", 8080)
    ingress.declare(db, "01J1", "api.monapi.fr", 9090)

    config = ingress.build_config(db)
    hotes = [r["match"][0]["host"][0]
             for r in config["apps"]["http"]["servers"]["spark"]["routes"]
             if "match" in r]
    assert hotes.index("api.monapi.fr") < hotes.index("*.monapi.fr"), (
        "le nom exact doit être rencontré AVANT le joker")

    # Et l'amont du nom exact est bien celui du Spark dédié.
    exacte = next(r for r in config["apps"]["http"]["servers"]["spark"]["routes"]
                  if "match" in r and r["match"][0]["host"] == ["api.monapi.fr"])
    assert exacte["handle"][0]["upstreams"] == [{"dial": "10.77.0.11:9090"}]


def test_entre_deux_jokers_le_plus_long_passe_avant(db):
    poser_spark(db, "01J0", "large", "10.77.0.10")
    poser_spark(db, "01J1", "etroit", "10.77.0.11")
    ingress.declare(db, "01J0", "*.monapi.fr", 8080)
    ingress.declare(db, "01J1", "*.eu.monapi.fr", 9090)
    hotes = [r["match"][0]["host"][0]
             for r in ingress.build_config(db)["apps"]["http"]["servers"]["spark"]["routes"]
             if "match" in r]
    assert hotes.index("*.eu.monapi.fr") < hotes.index("*.monapi.fr")


def test_declarer_un_nom_exact_NOMME_le_spark_dont_il_prend_le_pas(db):
    """§18.3 bis : la déclaration réussit, mais le silence produirait une panne
    cherchée pendant des heures du mauvais côté."""
    poser_spark(db, "01J0", "general", "10.77.0.10")
    poser_spark(db, "01J1", "dedie", "10.77.0.11")
    ingress.declare(db, "01J0", "*.monapi.fr", 8080)

    route = ingress.declare(db, "01J1", "admin.monapi.fr", 9090)
    assert route["supersedes"] == {"domain": "*.monapi.fr", "spark_name": "general"}


def test_prendre_le_pas_sur_SON_PROPRE_joker_ne_se_signale_pas(db):
    """Ce n'est pas un détournement : c'est le même exploitant qui affine sa
    propre route. Le signaler serait du bruit."""
    poser_spark(db, "01J0", "general", "10.77.0.10")
    ingress.declare(db, "01J0", "*.monapi.fr", 8080)
    route = ingress.declare(db, "01J0", "admin.monapi.fr", 9090)
    assert "supersedes" not in route


def test_un_nom_qu_aucun_joker_ne_couvre_ne_signale_rien(db):
    poser_spark(db, "01J0", "general", "10.77.0.10")
    ingress.declare(db, "01J0", "*.monapi.fr", 8080)
    poser_spark(db, "01J1", "autre", "10.77.0.11")
    assert "supersedes" not in ingress.declare(db, "01J1", "admin.autre.fr", 9090)


def test_deux_routes_de_MEME_texte_se_refusent_toujours(db):
    """§18.3 bis : ce que l'unicité devient — elle ne change PAS. Un joker et un
    nom exact ne sont pas le même nom, mais deux textes identiques le sont."""
    poser_spark(db, "01J0", "a", "10.77.0.10")
    poser_spark(db, "01J1", "b", "10.77.0.11")
    ingress.declare(db, "01J0", "*.monapi.fr", 8080)
    with pytest.raises(ingress.IngressError) as leve:
        ingress.declare(db, "01J1", "*.monapi.fr", 9090)
    assert "déjà routé" in str(leve.value)
