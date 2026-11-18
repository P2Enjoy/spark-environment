"""Un VRAI serveur SMTP local, pour éprouver ce qui part réellement sur la socket.

@verifies docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3.2 (mode TLS, certificat vérifié,
          compte, message), §47.5 (un serveur muet ne bloque jamais), §47.3.2 bis
          (deux témoins indépendants)

Ce n'est pas un doublon de `smtplib` : c'est un serveur qui parle le protocole sur une
socket, comme le webhook de test est un vrai serveur HTTP. Il sait annoncer STARTTLS,
parler en TLS implicite, exiger le TLS avant `AUTH`, refuser un mot de passe, et — pour
prouver le §47.5 — accepter une connexion puis se taire.

Le contrat simulé est celui de RFC 5321/4954 pour les seules commandes que `smtplib` émet
à l'envoi : EHLO, STARTTLS, AUTH PLAIN, MAIL, RCPT, DATA, QUIT. Il ne prétend pas imiter un
fournisseur réel (limites, anti-spam) : cela reste à prouver sur une vraie Forge.
"""

from __future__ import annotations

import base64
import datetime
import email
import ipaddress
import socketserver
import ssl
import threading
from email import policy
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


def fabriquer_certificat(dossier: Path) -> tuple[Path, Path]:
    """Un certificat auto-signé pour `127.0.0.1` et `localhost`, et sa clé."""
    cle = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    nom = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    maintenant = datetime.datetime.now(datetime.timezone.utc)
    certificat = (
        x509.CertificateBuilder().subject_name(nom).issuer_name(nom).public_key(cle.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(maintenant - datetime.timedelta(minutes=5))
        .not_valid_after(maintenant + datetime.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([
            x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]),
            critical=False)
        .sign(cle, hashes.SHA256()))
    chemin_cert, chemin_cle = dossier / "smtp.pem", dossier / "smtp.key"
    chemin_cert.write_bytes(certificat.public_bytes(serialization.Encoding.PEM))
    chemin_cle.write_bytes(cle.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption()))
    return chemin_cert, chemin_cle


class _Session(socketserver.BaseRequestHandler):
    def handle(self) -> None:  # noqa: C901 - un protocole, pas une abstraction
        s: ServeurSmtp = self.server  # type: ignore[assignment]
        sock = self.request
        s.connexions += 1
        if s.mode == "muet":
            # Accepte la connexion, ne dit RIEN : `smtplib` attend la bannière (§47.5).
            s.arret.wait(30)
            return
        try:
            if s.tls_implicite:
                sock = s.contexte.wrap_socket(sock, server_side=True)
            tls = bool(s.tls_implicite)
            lecture = sock.makefile("rb")

            def dire(texte: str) -> None:
                sock.sendall((texte + "\r\n").encode())

            dire("220 localhost ESMTP test")
            expediteur, destinataires = None, []
            while True:
                brut = lecture.readline()
                if not brut:
                    return
                ligne = brut.decode("utf-8", "replace").rstrip("\r\n")
                verbe = ligne.split(" ", 1)[0].upper()
                s.commandes.append(verbe)
                if verbe in ("EHLO", "HELO"):
                    reponses = ["250-localhost"]
                    if s.starttls and not tls:
                        reponses.append("250-STARTTLS")
                    if s.compte and (tls or not s.tls_avant_auth):
                        reponses.append("250-AUTH PLAIN")
                    reponses.append("250 8BITMIME")
                    sock.sendall(("\r\n".join(reponses) + "\r\n").encode())
                elif verbe == "STARTTLS":
                    dire("220 Ready to start TLS")
                    sock = s.contexte.wrap_socket(sock, server_side=True)
                    lecture = sock.makefile("rb")
                    tls = True
                elif verbe == "AUTH":
                    morceaux = ligne.split(" ")
                    try:
                        _, utilisateur, mot = base64.b64decode(morceaux[2]).decode().split("\0")
                    except Exception:  # noqa: BLE001
                        dire("501 syntaxe")
                        continue
                    s.authentifications.append(
                        {"utilisateur": utilisateur, "mot_de_passe": mot, "tls": tls})
                    if s.compte and (utilisateur, mot) == s.compte:
                        dire("235 2.7.0 Authentication successful")
                    else:
                        dire("535 5.7.8 Authentication credentials invalid")
                elif verbe == "MAIL":
                    expediteur = ligne.split(":", 1)[1].strip().strip("<>")
                    dire("250 OK")
                elif verbe == "RCPT":
                    destinataires.append(ligne.split(":", 1)[1].strip().strip("<>"))
                    dire("250 OK")
                elif verbe == "DATA":
                    if s.compte and not s.authentifications:
                        dire("530 5.7.0 Authentication required")
                        continue
                    dire("354 End data with <CR><LF>.<CR><LF>")
                    morceaux = []
                    while True:
                        donnee = lecture.readline()
                        if donnee in (b".\r\n", b""):
                            break
                        morceaux.append(donnee[1:] if donnee.startswith(b"..") else donnee)
                    brut_message = b"".join(morceaux)
                    s.recus.append({
                        "de": expediteur, "a": list(destinataires), "tls": tls,
                        "brut": brut_message.decode("utf-8", "replace"),
                        "message": email.message_from_bytes(brut_message, policy=policy.default),
                    })
                    destinataires = []
                    dire("250 OK queued")
                elif verbe == "RSET":
                    dire("250 OK")
                elif verbe == "QUIT":
                    dire("221 Bye")
                    return
                else:
                    dire("502 non géré")
        except (ssl.SSLError, ConnectionError, OSError):
            return


class ServeurSmtp(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, *, contexte: ssl.SSLContext | None = None, tls_implicite: bool = False,
                 starttls: bool = False, compte: tuple[str, str] | None = None,
                 tls_avant_auth: bool = True, mode: str = "normal"):
        super().__init__(("127.0.0.1", 0), _Session)
        self.contexte = contexte
        self.tls_implicite = tls_implicite
        self.starttls = starttls
        self.compte = compte
        self.tls_avant_auth = tls_avant_auth
        self.mode = mode
        self.recus: list[dict] = []
        self.commandes: list[str] = []
        self.authentifications: list[dict] = []
        self.connexions = 0
        self.arret = threading.Event()

    @property
    def port(self) -> int:
        return self.server_address[1]

    def demarrer(self) -> "ServeurSmtp":
        threading.Thread(target=self.serve_forever, daemon=True).start()
        return self

    def arreter(self) -> None:
        self.arret.set()
        self.shutdown()
        self.server_close()


def contexte_serveur(cert: Path, cle: Path) -> ssl.SSLContext:
    contexte = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    contexte.load_cert_chain(cert, cle)
    return contexte


def contexte_client(cert: Path) -> ssl.SSLContext:
    """Un client qui fait confiance à CE certificat — et vérifie la chaîne et le nom."""
    return ssl.create_default_context(cafile=str(cert))
