"""@verifies docs/BACKLOG.md#SPK-130 · docs/DAT.md §18.7 (chaque badge dit ce qui
a été relevé à l'instant), §18.5 (`applied_at` date un geste, il ne décrit pas
Caddy)

Deux familles de preuves. Les états du diagnostic, avec `FakeCaddy` et les
doubles déclarés. Puis les SONDES RÉELLES contre de vrais serveurs TLS locaux,
signés par une autorité de test : ce qu'un navigateur penserait de chaque
certificat, et le statut qu'on lit — sans tricher sur la poignée de main.
"""

from __future__ import annotations

import socket
import ssl
import threading
from datetime import datetime, timedelta, timezone

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from sparkd import ingress, ingress_diagnostic, migrations
from sparkd.db import connect
from sparkd.ingress_diagnostic import SondesFactices, SondesReelles, diagnostiquer

GIO = 1024**3


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


# --- les états du diagnostic ---------------------------------------------------


def test_une_route_portee_et_qui_repond_est_servie(db):
    poser_spark(db, "S1", "crm")
    ingress.declare(db, "S1", "crm.example.com", 8080)
    caddy = ingress.FakeCaddy()
    ingress.reconcile(db, caddy)
    d = diagnostiquer(db, "crm", caddy, SondesFactices())

    route = d["routes"]["crm.example.com"]
    assert route["caddy"] == {"state": "served", "expected": "10.77.0.16:8080",
                              "found": "10.77.0.16:8080", "status": 200, "reason": None}
    assert route["certificate"]["state"] == "valid"
    assert d["caddy_reachable"] is True and d["probes"] == "fake"


def test_le_14_septembre_se_voit_la_route_est_absente_de_caddy(db):
    """Le registre disait « appliquée » ; Caddy servait le `Caddyfile`. Le
    diagnostic lit la configuration VIVANTE, pas `applied_at`."""
    poser_spark(db, "S1", "crm")
    ingress.declare(db, "S1", "crm.example.com", 8080)
    ingress.reconcile(db, ingress.FakeCaddy())
    assert ingress.by_domain(db, "crm.example.com")["applied_at"]

    caddyfile = ingress.FakeCaddy(config={"apps": {"http": {"servers": {
        "srv0": {"listen": [":80"], "routes": [{"handle": [{"handler": "file_server"}]}]}}}}})
    route = diagnostiquer(db, "crm", caddyfile, SondesFactices())["routes"]["crm.example.com"]
    assert route["caddy"]["state"] == "absent"


def test_une_autre_cible_est_nommee(db):
    poser_spark(db, "S1", "crm")
    ingress.declare(db, "S1", "crm.example.com", 8080)
    caddy = ingress.FakeCaddy()
    ingress.reconcile(db, caddy)
    ingress.update(db, "crm.example.com", 9090, True)   # corrigée, pas réappliquée
    route = diagnostiquer(db, "crm", caddy, SondesFactices())["routes"]["crm.example.com"]
    assert route["caddy"]["state"] == "other_target"
    assert route["caddy"]["found"] == "10.77.0.16:8080"
    assert route["caddy"]["expected"] == "10.77.0.16:9090"


def test_un_502_de_caddy_est_une_pile_muette(db):
    poser_spark(db, "S1", "analytics")
    ingress.declare(db, "S1", "analytics.example.com", 3000, tls=False)
    caddy = ingress.FakeCaddy()
    ingress.reconcile(db, caddy)
    sondes = SondesFactices()
    sondes.poser("analytics.example.com", http={"status": 502, "error": None})
    route = diagnostiquer(db, "analytics", caddy, sondes)["routes"]["analytics.example.com"]
    assert route["caddy"]["state"] == "silent_stack" and route["caddy"]["status"] == 502
    # Une route sans TLS n'a pas de certificat à juger.
    assert route["certificate"] == {"state": "not_applicable"}


def test_une_requete_sans_reponse_n_est_pas_une_route_servie(db):
    poser_spark(db, "S1", "crm")
    ingress.declare(db, "S1", "crm.example.com", 8080)
    caddy = ingress.FakeCaddy()
    ingress.reconcile(db, caddy)
    sondes = SondesFactices()
    sondes.poser("crm.example.com", http={"status": None, "error": "timed out"})
    route = diagnostiquer(db, "crm", caddy, sondes)["routes"]["crm.example.com"]
    assert route["caddy"]["state"] == "probe_failed" and route["caddy"]["reason"] == "timed out"


def test_une_route_desactivee_n_est_pas_une_panne(db):
    poser_spark(db, "S1", "crm")
    r = ingress.declare(db, "S1", "crm.example.com", 8080)
    db.execute("UPDATE ingress_route SET enabled = 0 WHERE id = ?", (r["id"],))
    caddy = ingress.FakeCaddy()
    ingress.reconcile(db, caddy)
    route = diagnostiquer(db, "crm", caddy, SondesFactices())["routes"]["crm.example.com"]
    assert route["caddy"]["state"] == "not_served"
    assert route["certificate"] == {"state": "not_applicable"}


def test_un_caddy_injoignable_se_dit_pour_chaque_route(db):
    poser_spark(db, "S1", "crm")
    ingress.declare(db, "S1", "crm.example.com", 8080)
    d = diagnostiquer(db, "crm", ingress.FakeCaddy(fail=True), SondesFactices())
    assert d["caddy_reachable"] is False
    assert d["routes"]["crm.example.com"]["caddy"]["state"] == "unreachable"


def test_un_joker_n_est_ni_interroge_ni_presente(db):
    """Un joker ne désigne aucun nom précis : ni `Host`, ni SNI à envoyer."""
    poser_spark(db, "S1", "boutique")
    ingress.declare(db, "S1", "*.boutique.example.com", 8080)
    caddy = ingress.FakeCaddy()
    ingress.reconcile(db, caddy)

    class Espion(SondesFactices):
        def http(self, domaine, tls):
            raise AssertionError("un joker ne s'interroge pas")

        def certificat(self, domaine):
            raise AssertionError("un joker ne se présente pas")

    route = diagnostiquer(db, "boutique", caddy, Espion())["routes"]["*.boutique.example.com"]
    assert route["caddy"]["state"] == "served" and "joker" in route["caddy"]["reason"]
    assert route["certificate"]["state"] == "wildcard"


def test_seules_les_routes_du_spark_demande_sont_sondees(db):
    poser_spark(db, "S1", "crm")
    poser_spark(db, "S2", "autre", "10.77.0.17")
    ingress.declare(db, "S1", "crm.example.com", 8080)
    ingress.declare(db, "S2", "autre.example.com", 8080)
    caddy = ingress.FakeCaddy()
    ingress.reconcile(db, caddy)
    assert list(diagnostiquer(db, "crm", caddy, SondesFactices())["routes"]) == ["crm.example.com"]


def test_les_doubles_survivent_au_demarrage_suivant(tmp_path):
    """Comme `FakeIncus` : ce que le seed déclare, la pile de développement le lit."""
    chemin = tmp_path / "r.db.sondes.json"
    SondesFactices(state_path=chemin).poser(
        "vip.example.com", certificat={"state": "invalid", "reason": "self-signed certificate"})
    relu = SondesFactices(state_path=chemin).certificat("vip.example.com")
    assert relu == {"state": "invalid", "reason": "self-signed certificate"}


def test_un_double_proche_de_l_echeance_est_dit_comme_tel():
    sondes = SondesFactices()
    sondes.poser("vip.example.com", certificat={"state": "valid", "days_left": 9})
    assert sondes.certificat("vip.example.com")["state"] == "expiring"


# --- les sondes RÉELLES, contre de vrais serveurs locaux ---------------------


def _cle():
    return ec.generate_private_key(ec.SECP256R1())


def _certificat(sujet, cle_sujet, emetteur, cle_emetteur, *, noms=(), jours=60, ca=False):
    maintenant = datetime.now(timezone.utc)
    constructeur = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, sujet),
                                 x509.NameAttribute(NameOID.ORGANIZATION_NAME, sujet)]))
        .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, emetteur),
                                x509.NameAttribute(NameOID.ORGANIZATION_NAME, emetteur)]))
        .public_key(cle_sujet.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(maintenant - timedelta(days=1))
        .not_valid_after(maintenant + timedelta(days=jours))
        .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(cle_sujet.public_key()),
                       critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(
            cle_emetteur.public_key()), critical=False)
    )
    if ca:
        constructeur = constructeur.add_extension(x509.KeyUsage(
            digital_signature=True, content_commitment=False, key_encipherment=False,
            data_encipherment=False, key_agreement=False, key_cert_sign=True,
            crl_sign=True, encipher_only=False, decipher_only=False), critical=True)
    else:
        constructeur = (
            constructeur
            .add_extension(x509.KeyUsage(
                digital_signature=True, content_commitment=False, key_encipherment=False,
                data_encipherment=False, key_agreement=False, key_cert_sign=False,
                crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),
                           critical=False)
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(n) for n in noms]),
                           critical=False))
    return constructeur.sign(cle_emetteur, hashes.SHA256())


def _pem(objet) -> bytes:
    if isinstance(objet, x509.Certificate):
        return objet.public_bytes(serialization.Encoding.PEM)
    return objet.private_bytes(serialization.Encoding.PEM,
                               serialization.PrivateFormat.PKCS8,
                               serialization.NoEncryption())


@pytest.fixture(scope="module")
def autorite():
    cle = _cle()
    return cle, _certificat("Autorité de test", cle, "Autorité de test", cle, ca=True)


def _serveur(tmp_path, certificat, cle, reponse=b"HTTP/1.1 302 Found\r\nContent-Length: 0\r\n\r\n",
             alerte=False):
    """Un serveur TLS d'une seule connexion à la fois, sur un port libre."""
    (tmp_path / "c.pem").write_bytes(_pem(certificat))
    (tmp_path / "k.pem").write_bytes(_pem(cle))
    contexte = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    contexte.load_cert_chain(tmp_path / "c.pem", tmp_path / "k.pem")
    if alerte:
        # Ce que fait Caddy pour un nom sans certificat : une alerte, pas un
        # certificat de repli.
        contexte.sni_callback = lambda *_: ssl.ALERT_DESCRIPTION_INTERNAL_ERROR
    ecoute = socket.create_server(("127.0.0.1", 0))
    recues: list[bytes] = []

    def servir():
        while True:
            try:
                brut, _ = ecoute.accept()
            except OSError:
                return
            try:
                with contexte.wrap_socket(brut, server_side=True) as flux:
                    recues.append(flux.recv(4096))
                    flux.sendall(reponse)
            except (OSError, ssl.SSLError):
                brut.close()

    threading.Thread(target=servir, daemon=True).start()
    return ecoute, recues


def _sondes(port, autorite_pem):
    return SondesReelles(port_https=port,
                         contexte_verifie=lambda: ssl.create_default_context(cadata=autorite_pem))


def test_un_certificat_de_l_autorite_attendue_est_valide(tmp_path, autorite):
    cle_ca, ca = autorite
    cle = _cle()
    ecoute, _ = _serveur(tmp_path, _certificat("app.test", cle, "Autorité de test", cle_ca,
                                                noms=["app.test"], jours=60), cle)
    with ecoute:
        releve = _sondes(ecoute.getsockname()[1], _pem(ca).decode()).certificat("app.test")
    assert releve["state"] == "valid"
    assert releve["issuer"] == "Autorité de test"
    assert 58 <= releve["days_left"] <= 60


def test_un_certificat_proche_de_son_echeance_se_signale(tmp_path, autorite):
    cle_ca, ca = autorite
    cle = _cle()
    ecoute, _ = _serveur(tmp_path, _certificat("app.test", cle, "Autorité de test", cle_ca,
                                                noms=["app.test"], jours=5), cle)
    with ecoute:
        releve = _sondes(ecoute.getsockname()[1], _pem(ca).decode()).certificat("app.test")
    assert releve["state"] == "expiring" and releve["days_left"] <= 5


def test_un_certificat_auto_signe_est_invalide_et_la_raison_est_rendue(tmp_path, autorite):
    """Le cas du repli de Caddy sur son autorité interne : non reconnue."""
    _, ca = autorite
    cle = _cle()
    ecoute, _ = _serveur(tmp_path, _certificat("app.test", cle, "app.test", cle,
                                                noms=["app.test"]), cle)
    with ecoute:
        releve = _sondes(ecoute.getsockname()[1], _pem(ca).decode()).certificat("app.test")
    assert releve["state"] == "invalid"
    assert "self-signed" in releve["reason"]


def test_un_certificat_d_un_autre_nom_est_invalide(tmp_path, autorite):
    cle_ca, ca = autorite
    cle = _cle()
    ecoute, _ = _serveur(tmp_path, _certificat("autre.test", cle, "Autorité de test", cle_ca,
                                                noms=["autre.test"]), cle)
    with ecoute:
        releve = _sondes(ecoute.getsockname()[1], _pem(ca).decode()).certificat("app.test")
    assert releve["state"] == "invalid"
    assert "app.test" in releve["reason"] or "mismatch" in releve["reason"].lower()


def test_un_nom_sans_certificat_est_absent(tmp_path, autorite):
    cle_ca, ca = autorite
    cle = _cle()
    ecoute, _ = _serveur(tmp_path, _certificat("app.test", cle, "Autorité de test", cle_ca,
                                                noms=["app.test"]), cle, alerte=True)
    with ecoute:
        releve = _sondes(ecoute.getsockname()[1], _pem(ca).decode()).certificat("app.test")
    assert releve["state"] == "missing"


def test_rien_n_ecoute_sur_443(autorite):
    _, ca = autorite
    libre = socket.create_server(("127.0.0.1", 0))
    port = libre.getsockname()[1]
    libre.close()
    assert _sondes(port, _pem(ca).decode()).certificat("app.test")["state"] == "unreachable"


def test_la_requete_lit_le_statut_meme_derriere_un_certificat_invalide(tmp_path, autorite):
    """Le statut et le certificat sont deux relevés : un certificat auto-signé
    ne doit pas cacher que la pile répond."""
    cle = _cle()
    ecoute, recues = _serveur(tmp_path, _certificat("app.test", cle, "app.test", cle,
                                                     noms=["app.test"]), cle)
    with ecoute:
        reponse = SondesReelles(port_https=ecoute.getsockname()[1]).http("app.test", tls=True)
    assert reponse == {"status": 302, "error": None}
    # La sonde demande CE nom, et se nomme.
    assert b"Host: app.test\r\n" in recues[0]
    assert b"User-Agent: sparkd-diagnostic\r\n" in recues[0]


def test_un_502_rendu_par_l_ingress_est_lu_tel_quel(tmp_path, autorite):
    cle = _cle()
    ecoute, _ = _serveur(tmp_path, _certificat("app.test", cle, "app.test", cle,
                                                noms=["app.test"]), cle,
                         reponse=b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
    with ecoute:
        assert SondesReelles(port_https=ecoute.getsockname()[1]).http(
            "app.test", tls=True)["status"] == 502


def test_une_route_en_clair_s_interroge_en_http():
    ecoute = socket.create_server(("127.0.0.1", 0))

    def servir():
        brut, _ = ecoute.accept()
        with brut:
            brut.recv(4096)
            brut.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")

    threading.Thread(target=servir, daemon=True).start()
    with ecoute:
        assert SondesReelles(port_http=ecoute.getsockname()[1]).http(
            "intranet.test", tls=False) == {"status": 200, "error": None}


def test_une_requete_vers_un_port_ferme_ne_rend_pas_de_statut():
    libre = socket.create_server(("127.0.0.1", 0))
    port = libre.getsockname()[1]
    libre.close()
    reponse = SondesReelles(port_https=port).http("app.test", tls=True)
    assert reponse["status"] is None and reponse["error"]


def test_les_sondes_de_la_forge_se_disent_reelles():
    assert ingress_diagnostic.SondesReelles().nature == "real"
    assert ingress_diagnostic.SondesFactices().nature == "fake"
