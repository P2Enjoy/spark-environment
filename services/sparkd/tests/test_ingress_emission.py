"""@verifies docs/BACKLOG.md#SPK-156 · docs/DAT.md §18.9 (ce que Caddy dit de ses
tentatives d'émission : la source, ce qui se lit nom par nom, la surface), §18.2
(le journal d'émission dans la configuration posée)

Les lignes analysées sont celles de **Caddy 2.6.2 sur la Forge**, le
2026-10-11 de 15:19 à 15:41 — l'incident qui a fait naître l'unité —, filtrées
sur les trois enregistreurs du journal d'émission. Seuls les noms et l'adresse
de l'ancienne machine sont remplacés : `gram.exemple.test`, `pfia.exemple.test`,
`203.0.113.50` (`caddy-2.6.2-emission.jsonl`, à côté de ce fichier).

Ce que ces lignes racontent, et que les preuves vérifient : les deux noms
échouent ensemble à 15:19 — Let's Encrypt valide sur l'ancienne adresse, ZeroSSL
refuse —, `pfia` obtient son certificat à 15:21:00 ; `gram` est limité en débit
jusqu'à 15:31, réessaie à 15:22:49, 15:24:59, 15:30:04 sans plus tenter de
validation, et obtient le sien à 15:40:25.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sparkd import ingress, migrations
from sparkd.app import create_app
from sparkd.config import load
from sparkd.db import connect
from sparkd.ingress_diagnostic import (
    ReleveEmission, SondesFactices, SondesReelles, analyser_emission, diagnostiquer)

GIO = 1024**3
LIGNES = (Path(__file__).parent / "caddy-2.6.2-emission.jsonl").read_text(
    encoding="utf-8").splitlines()


def _evenements(jusqu_a: str | None = None) -> list[dict]:
    """Les événements de l'incident, éventuellement arrêtés à une heure UTC."""
    evenements = [json.loads(ligne) for ligne in LIGNES]
    if jusqu_a is None:
        return evenements
    borne = datetime.fromisoformat(f"2026-10-11T{jusqu_a}+00:00").timestamp()
    return [e for e in evenements if e["ts"] <= borne]


def _heure(iso: str) -> str:
    return datetime.fromisoformat(iso).astimezone(timezone.utc).strftime("%H:%M:%S")


# --- l'analyse, nom par nom, sur les lignes réelles ----------------------------


def test_a_15h23_gram_echoue_et_tout_ce_que_caddy_a_rencontre_est_rendu():
    """L'état que l'écran aurait dû montrer pendant l'incident."""
    e = analyser_emission(_evenements("15:23:00"), "gram.exemple.test")

    assert e["state"] == "failing"
    assert _heure(e["since"]) == "15:19:25"          # le premier échec
    assert _heure(e["last_attempt_at"]) == "15:22:49"
    assert _heure(e["next_retry_at"]) == "15:24:59"  # 15:22:59 + 120 s annoncés
    # La dernière tentative n'a tenté AUCUNE validation : l'adresse jointe vient
    # de la précédente, et sa date le dit.
    assert [(c["type"], c["address"], _heure(c["at"])) for c in e["challenges"]] == [
        ("http-01", "203.0.113.50", "15:20:45"),
        ("tls-alpn-01", "203.0.113.50", "15:20:48")]
    assert e["challenges"][1]["error"] == "203.0.113.50: remote error: tls: internal error"
    assert _heure(e["rate_limited_until"]) == "15:31:34"


def test_l_erreur_de_chaque_emetteur_est_rendue_telle_quelle_et_nommee():
    e = analyser_emission(_evenements("15:23:00"), "gram.exemple.test")
    par_emetteur = {i["issuer"]: i for i in e["issuers"]}
    assert set(par_emetteur) == {"acme-v02.api.letsencrypt.org-directory",
                                 "acme.zerossl.com-v2-DV90"}
    le = par_emetteur["acme-v02.api.letsencrypt.org-directory"]
    assert le["name"] == "Let's Encrypt"
    assert le["error"].startswith("HTTP 429 urn:ietf:params:acme:error:rateLimited")
    assert par_emetteur["acme.zerossl.com-v2-DV90"]["name"] == "ZeroSSL"
    assert "caddy_legacy_user_removed" in par_emetteur["acme.zerossl.com-v2-DV90"]["error"]


def test_les_noms_ne_se_melangent_pas():
    """Les tentatives de `pfia` et de `gram` s'entrelacent dans le fichier : celles
    de l'un ne doivent jamais remonter sous l'autre."""
    gram = analyser_emission(_evenements("15:20:00"), "gram.exemple.test")
    pfia = analyser_emission(_evenements("15:20:00"), "pfia.exemple.test")
    assert _heure(gram["since"]) == "15:19:25"
    assert _heure(pfia["since"]) == "15:19:38"
    assert all("pfia" not in i["error"] for i in gram["issuers"])


def test_un_succes_clot_l_histoire():
    """Un échec suivi d'un succès est réparé : l'afficher ferait chercher une
    panne qui n'existe plus."""
    pfia = analyser_emission(_evenements(), "pfia.exemple.test")
    assert pfia == {"state": "ok", "obtained_at": pfia["obtained_at"]}
    assert _heure(pfia["obtained_at"]) == "15:21:00"
    gram = analyser_emission(_evenements(), "gram.exemple.test")
    assert gram["state"] == "ok" and _heure(gram["obtained_at"]) == "15:40:25"


def test_une_tentative_en_cours_n_annonce_pas_de_prochaine():
    """À 15:24:59 Caddy réessaie : le délai annoncé à 15:22:59 est écoulé, et
    écrire « prochaine vers 15:24:59 » à 15:25 mentirait."""
    e = analyser_emission(_evenements("15:25:00"), "gram.exemple.test")
    assert e["state"] == "failing"
    assert _heure(e["last_attempt_at"]) == "15:24:59"
    assert e["next_retry_at"] is None


def test_un_nom_sans_evenement_n_a_rien_a_dire():
    assert analyser_emission(_evenements(), "inconnu.exemple.test") == {"state": "none"}


def test_une_tentative_sans_echec_encore_est_en_cours():
    debut = [e for e in _evenements() if e.get("identifier") == "gram.exemple.test"][:3]
    assert [e["msg"] for e in debut][-1] == "obtaining certificate"
    assert analyser_emission(debut, "gram.exemple.test") == {"state": "pending"}


def test_une_adresse_ipv6_se_reconnait_et_une_phrase_n_est_pas_une_adresse():
    base = {"level": "error", "logger": "http.acme_client", "msg": "challenge failed",
            "identifier": "a.exemple.test", "challenge_type": "http-01", "ts": 1.0}
    v6 = analyser_emission([{**base, "error": "2001:db8::7: Connection refused"}],
                           "a.exemple.test")
    assert v6["challenges"][0]["address"] == "2001:db8::7"
    texte = analyser_emission([{**base, "error": "DNS problem: NXDOMAIN looking up A"}],
                              "a.exemple.test")
    assert texte["challenges"][0]["address"] is None


def test_un_renouvellement_en_echec_se_lit_comme_une_emission():
    """`tls.renew` porte les mêmes messages que `tls.obtain`."""
    evenements = [
        {"level": "info", "ts": 10.0, "logger": "tls.renew",
         "msg": "renewing certificate", "identifier": "a.exemple.test"},
        {"level": "error", "ts": 11.0, "logger": "tls.renew",
         "msg": "could not get certificate from issuer", "identifier": "a.exemple.test",
         "issuer": "acme-v02.api.letsencrypt.org-directory", "error": "panne"},
        {"level": "error", "ts": 12.0, "logger": "tls.renew", "msg": "will retry",
         "error": "[a.exemple.test] Renew: panne", "retrying_in": 300},
    ]
    e = analyser_emission(evenements, "a.exemple.test")
    assert e["state"] == "failing"
    assert e["next_retry_at"] == datetime.fromtimestamp(312, timezone.utc).isoformat(
        timespec="seconds")
    assert e["rate_limited_until"] is None and e["challenges"] == []


# --- la lecture du fichier ------------------------------------------------------


def test_le_journal_se_lit_et_se_decoupe(tmp_path):
    chemin = tmp_path / "emission-tls.log"
    chemin.write_text("\n".join(LIGNES) + "\n", encoding="utf-8")
    releve = SondesReelles(journal_emission=chemin).emission()
    assert releve.readable and releve.reason is None
    assert releve.pour("gram.exemple.test")["state"] == "ok"


def test_un_journal_absent_n_est_pas_une_erreur(tmp_path):
    """Caddy ne l'écrit qu'au premier événement d'émission."""
    releve = SondesReelles(journal_emission=tmp_path / "absent.log").emission()
    assert releve.readable
    assert releve.pour("gram.exemple.test") == {"state": "none"}


def test_un_journal_illisible_se_dit(tmp_path):
    """Un répertoire à la place du fichier : la lecture échoue, et c'est dit —
    jamais rendu comme une absence d'échec."""
    (tmp_path / "emission-tls.log").mkdir()
    releve = SondesReelles(journal_emission=tmp_path / "emission-tls.log").emission()
    assert not releve.readable and releve.reason


def test_seule_la_fin_d_un_gros_journal_est_lue_et_la_ligne_coupee_ignoree(tmp_path,
                                                                           monkeypatch):
    from sparkd import ingress_diagnostic
    monkeypatch.setattr(ingress_diagnostic, "LECTURE_MAX_OCTETS", 2000)
    chemin = tmp_path / "emission-tls.log"
    chemin.write_text("\n".join(LIGNES) + "\n", encoding="utf-8")
    releve = SondesReelles(journal_emission=chemin).emission()
    assert releve.readable
    # La fin du fichier : le succès de 15:40:25, et rien d'illisible n'a levé.
    assert releve.pour("gram.exemple.test")["state"] == "ok"


# --- le diagnostic, et la configuration qui déclare le journal ------------------


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "d.db")
    migrations.upgrade(connection)
    yield connection
    connection.close()


def poser_spark(db, ident, nom, adresse="10.77.0.16"):
    db.execute(
        "INSERT INTO spark (id,name,image,cpu_mode,cpu_reservation,"
        "memory_reservation_bytes,network_reservation_bps,storage_bytes,"
        "ipv4_address,created_at,updated_at) VALUES (?,?,?,'shared',0.5,?,?,?,?,'x','x')",
        (ident, nom, "images:debian/13", GIO, 10_000_000, GIO, adresse))


def test_la_configuration_declare_le_journal_d_emission(db):
    journal = ingress.build_config(db)["logging"]["logs"]["emission"]
    assert journal["writer"]["output"] == "file"
    assert journal["writer"]["filename"] == ingress.JOURNAL_EMISSION
    assert journal["encoder"] == {"format": "json"}
    assert journal["include"] == ["tls.obtain", "tls.renew", "http.acme_client"]


class _Sondes(SondesFactices):
    """Les doubles du §18.7, avec un relevé d'émission imposé."""

    def __init__(self, releve):
        super().__init__()
        self._releve = releve

    def emission(self):
        return self._releve


def test_le_diagnostic_porte_l_emission_des_routes_tls_servies(db, tmp_path):
    poser_spark(db, "S1", "gram")
    ingress.declare(db, "S1", "gram.exemple.test", 8080)
    ingress.declare(db, "S1", "clair.exemple.test", 8080, tls=False)
    caddy = ingress.FakeCaddy()
    ingress.reconcile(db, caddy)
    chemin = tmp_path / "emission-tls.log"
    chemin.write_text("\n".join(LIGNES[:40]) + "\n", encoding="utf-8")

    d = diagnostiquer(db, "gram", caddy,
                      _Sondes(SondesReelles(journal_emission=chemin).emission()))
    assert d["issuance_journal"] == {"readable": True, "reason": None}
    assert d["routes"]["gram.exemple.test"]["issuance"]["state"] == "failing"
    # Une route en clair n'a pas de certificat à émettre.
    assert "issuance" not in d["routes"]["clair.exemple.test"]


def test_un_journal_illisible_ne_donne_aucune_emission_aux_routes(db):
    poser_spark(db, "S1", "gram")
    ingress.declare(db, "S1", "gram.exemple.test", 8080)
    caddy = ingress.FakeCaddy()
    ingress.reconcile(db, caddy)
    d = diagnostiquer(db, "gram", caddy,
                      _Sondes(ReleveEmission(readable=False, reason="Permission denied")))
    assert d["issuance_journal"] == {"readable": False, "reason": "Permission denied"}
    assert "issuance" not in d["routes"]["gram.exemple.test"]


def test_une_route_non_servie_n_a_pas_d_emission(db):
    poser_spark(db, "S1", "gram")
    r = ingress.declare(db, "S1", "gram.exemple.test", 8080)
    db.execute("UPDATE ingress_route SET enabled = 0 WHERE id = ?", (r["id"],))
    caddy = ingress.FakeCaddy()
    ingress.reconcile(db, caddy)
    d = diagnostiquer(db, "gram", caddy, SondesFactices())
    assert "issuance" not in d["routes"]["gram.exemple.test"]


# --- les doubles du pilote factice ---------------------------------------------


def test_le_double_passe_par_la_meme_analyse_et_survit_au_demarrage(tmp_path):
    """Le seed déclare des ÉVÉNEMENTS de Caddy, datés par rapport à la lecture ;
    le double les analyse par le même code que la Forge."""
    chemin = tmp_path / "r.db.sondes.json"
    SondesFactices(state_path=chemin).poser("vip.exemple.test", emission=[
        {"il_y_a_minutes": 25, "level": "info", "logger": "tls.obtain",
         "msg": "obtaining certificate", "identifier": "vip.exemple.test"},
        {"il_y_a_minutes": 25, "level": "error", "logger": "http.acme_client",
         "msg": "challenge failed", "identifier": "vip.exemple.test",
         "challenge_type": "http-01", "error": "203.0.113.99: Connection refused"},
        {"il_y_a_minutes": 25, "level": "error", "logger": "tls.obtain",
         "msg": "could not get certificate from issuer", "identifier": "vip.exemple.test",
         "issuer": "acme-v02.api.letsencrypt.org-directory",
         "error": "HTTP 429 urn:ietf:params:acme:error:rateLimited - retry after "
                  "{dans_minutes:20} UTC: see https://letsencrypt.org/docs/rate-limits/"},
    ])
    maintenant = datetime(2026, 10, 11, 12, 0, tzinfo=timezone.utc)
    releve = SondesFactices(state_path=chemin, maintenant=lambda: maintenant).emission()
    e = releve.pour("vip.exemple.test")
    assert e["state"] == "failing"
    assert e["since"] == "2026-10-11T11:35:00+00:00"
    assert e["challenges"][0]["address"] == "203.0.113.99"
    assert e["rate_limited_until"] == "2026-10-11T12:20:00+00:00"
    assert releve.pour("autre.exemple.test") == {"state": "none"}


# --- la surface d'API -----------------------------------------------------------


def test_la_route_de_diagnostic_rend_l_emission_du_seed(tmp_path):
    """Le seed déclare l'émission en échec de `vip.boutique.example.com` (§18.9.3) :
    la route du diagnostic la rend, avec le journal lisible.

    Le registre est seedé puis `sparkd` démarre dessus, comme `make runDev`."""
    from sparkd import seed

    config = load({"SPARKD_DB": str(tmp_path / "seed.db"), "SPARKD_DRIVER": "fake"})
    seed.run(config)
    c = TestClient(create_app(config))

    avant = len(c.get("/v1/audit?limit=500").json()["entries"])
    corps = c.get("/v1/ingress/diagnostic", params={"spark": "crm-production"}).json()
    assert corps["issuance_journal"] == {"readable": True, "reason": None}
    vip = corps["routes"]["vip.boutique.example.com"]["issuance"]
    assert vip["state"] == "failing"
    assert vip["challenges"][0]["address"] == "203.0.113.99"
    assert vip["rate_limited_until"] is not None
    assert corps["routes"]["crm.example.com"]["issuance"] == {"state": "none"}
    # Une lecture : rien n'entre au journal (§36.7).
    assert len(c.get("/v1/audit?limit=500").json()["entries"]) == avant
