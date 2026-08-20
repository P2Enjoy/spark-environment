"""@verifies docs/BACKLOG.md#SPK-40 · docs/DAT.md §36.10.1 (ce que l'unité n'est
            PAS), §36.10.4 (où la vérification a lieu), §36.10.6 (le registre),
            §36.10.7 (la surface d'API) · §36.4 (deux classes de lignes) ·
            §45.4 (ce n'est pas de l'authentification)

Ce que ces preuves gardent : **une requête non signée passe, une signature
invalide est refusée**. Les confondre ferait de ce mécanisme un contrôle
d'accès, ce que l'arbitrage de SPK-35 dit qu'il n'est pas.

Elles traversent la VRAIE route et le VRAI middleware, avec de vraies clés
jetables et un vrai `ssh-keygen`.
"""

from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sparkd import signature
from sparkd.app import create_app
from sparkd.config import load


@pytest.fixture
def atelier(tmp_path):
    for nom in ("resp", "intrus"):
        subprocess.run(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", nom,
                        "-f", str(tmp_path / nom)], capture_output=True, check=True)
    pub = (tmp_path / "resp.pub").read_text("utf-8").split()
    (tmp_path / "signataires").write_text(
        f"console/prod {pub[0]} {pub[1]}\n", "utf-8")
    return tmp_path


def _client(atelier: Path, signataires: str | None = "signataires"):
    reglages = {"SPARKD_DB": str(atelier / "a.db"), "SPARKD_DRIVER": "fake"}
    if signataires:
        reglages["SPARKD_ALLOWED_SIGNERS"] = str(atelier / signataires)
    return TestClient(create_app(load(reglages)))


def _signe(atelier: Path, *, method: str, path: str, actor: str, body,
           action: str, cle: str = "resp") -> dict:
    """Les deux en-têtes du §36.10.7, produits par un VRAI ssh-keygen."""
    octets = signature.canonique({
        "method": method, "path": path, "actor": actor, "body": body,
        "action": action, "ts": "2026-08-21T00:30:00+00:00"})
    fichier = atelier / "a-signer"
    fichier.write_bytes(octets)
    (atelier / "a-signer.sig").unlink(missing_ok=True)
    subprocess.run(["ssh-keygen", "-Y", "sign", "-f", str(atelier / cle),
                    "-n", signature.NAMESPACE, str(fichier)],
                   capture_output=True, check=True)
    sig = (atelier / "a-signer.sig").read_text("utf-8")
    return {"x-spark-actor": actor,
            "x-spark-signature": "".join(
                l for l in sig.splitlines() if not l.startswith("-----")),
            "x-spark-signed": base64.b64encode(octets).decode("ascii")}


CORPS = {"action": "spark.terminal_open", "target_id": "crm", "message": "essai"}


def _signee(client, avec=False) -> list[dict]:
    url = "/v1/audit" + ("?with_signature=true" if avec else "")
    return [e for e in client.get(url).json()["entries"]
            if e["action"] == "spark.terminal_open"]


# --- Le point de l'unité : non signé PASSE, invalide est REFUSÉ -------------


def test_une_requête_NON_SIGNÉE_passe_et_sa_ligne_est_non_signée(atelier):
    """§36.10.1 : refuser faute de signature ferait de ce mécanisme un contrôle
    d'accès. La signature enrichit la trace ; elle ne garde pas la porte."""
    client = _client(atelier)
    r = client.post("/v1/audit", json=CORPS, headers={"x-spark-actor": "console/prod"})
    assert r.status_code == 201
    ligne = _signee(client)[0]
    assert ligne["signed"] is False
    assert ligne["signature_version"] is None


def test_une_requête_SIGNÉE_est_acceptée_et_sa_signature_est_CONSERVÉE(atelier):
    client = _client(atelier)
    entetes = _signe(atelier, method="POST", path="/v1/audit",
                     actor="console/prod", body=None, action="spark.terminal_open")
    r = client.post("/v1/audit", json=CORPS, headers=entetes)
    assert r.status_code == 201, r.text

    # §36.10.7 : par défaut, l'entrée DIT qu'elle est signée sans porter la
    # signature — celle-ci ne sert qu'à qui vérifie.
    ligne = _signee(client)[0]
    assert ligne["signed"] is True
    assert ligne["signature_version"] == signature.VERSION
    assert "signature" not in ligne and "signed_bytes" not in ligne

    ligne = _signee(client, avec=True)[0]
    assert ligne["signature"] and ligne["signed_bytes"]
    # Les octets conservés sont EXACTEMENT ceux qui ont été signés : qui audite
    # rejoue la vérification ailleurs, et il lui faut les octets, pas un résumé.
    vu = json.loads(base64.b64decode(ligne["signed_bytes"]))
    assert vu["method"] == "POST" and vu["path"] == "/v1/audit"


def test_une_signature_INVALIDE_est_refusée_en_422_et_RIEN_n_est_inscrit(atelier):
    """Inscrire ferait mentir le journal : la ligne affirmerait une preuve
    qu'elle n'a pas, ce qui est pire que de n'en porter aucune (§36.10.4)."""
    client = _client(atelier)
    entetes = _signe(atelier, method="POST", path="/v1/audit",
                     actor="console/prod", body=None, action="spark.terminal_open",
                     cle="intrus")
    r = client.post("/v1/audit", json=CORPS, headers=entetes)
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "signature_invalide"
    assert _signee(client) == [], "aucune ligne ne doit avoir été inscrite"


def test_des_octets_qui_décrivent_UN_AUTRE_geste_sont_refusés(atelier):
    """Sans ce contrôle, on signerait n'importe quoi pour l'attacher à n'importe
    quel geste : la signature serait valide, et attachée à autre chose."""
    client = _client(atelier)
    entetes = _signe(atelier, method="DELETE", path="/v1/sparks/crm",
                     actor="console/prod", body=None, action="spark.delete")
    r = client.post("/v1/audit", json=CORPS, headers=entetes)
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "octets_etrangers"
    assert _signee(client) == []


def test_une_signature_SANS_ses_octets_est_refusée(atelier):
    client = _client(atelier)
    r = client.post("/v1/audit", json=CORPS, headers={
        "x-spark-actor": "console/prod", "x-spark-signature": "abc"})
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "octets_absents"


def test_sans_fichier_de_signataires_une_signature_est_refusée_et_NOMMÉE(atelier):
    """§36.10.5 : une signature qu'on ne peut rattacher à personne ne prouve
    rien. Le refus dit que la Forge n'est pas réglée, et ne laisse pas croire à
    une signature invalide."""
    client = _client(atelier, signataires=None)
    entetes = _signe(atelier, method="POST", path="/v1/audit",
                     actor="console/prod", body=None, action="spark.terminal_open")
    r = client.post("/v1/audit", json=CORPS, headers=entetes)
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "signataires_absents"
    assert "SPARKD_ALLOWED_SIGNERS" in r.json()["detail"]["message"]


# --- La chaîne et la signature restent INDÉPENDANTES (§36.10.6) -------------


def test_la_signature_n_entre_PAS_dans_l_empreinte_de_la_chaîne(atelier):
    """Le champ retenu du §36.9.2 est figé. L'y ajouter invaliderait toutes les
    lignes existantes — ce que ce paragraphe interdit expressément."""
    client = _client(atelier)
    entetes = _signe(atelier, method="POST", path="/v1/audit",
                     actor="console/prod", body=None, action="spark.terminal_open")
    client.post("/v1/audit", json=CORPS, headers=entetes)
    client.post("/v1/audit", json=CORPS, headers={"x-spark-actor": "console/prod"})

    verdict = client.get("/v1/audit/verify").json()
    assert verdict["intact"] is True, "signées et non signées se chaînent pareil"


def test_une_LECTURE_ne_porte_jamais_de_signature(atelier):
    """§36.7 : les lectures ne sont pas journalisées, sauf la vérification
    elle-même — et celle-là est un événement du runtime, donc non signée."""
    client = _client(atelier)
    client.get("/v1/audit/verify")
    lignes = [e for e in client.get("/v1/audit").json()["entries"]
              if e["action"].startswith("audit.")]
    assert lignes, "la vérification est journalisée (§36.7)"
    assert all(l["signed"] is False for l in lignes)


def test_la_signature_ne_pèse_sur_le_journal_que_si_on_la_DEMANDE(atelier):
    """§36.10.7 : elle ne sert qu'à qui vérifie, et pèse quelques centaines
    d'octets par ligne. La rendre par défaut alourdirait chaque page pour tous
    les autres."""
    client = _client(atelier)
    entetes = _signe(atelier, method="POST", path="/v1/audit",
                     actor="console/prod", body=None, action="spark.terminal_open")
    client.post("/v1/audit", json=CORPS, headers=entetes)

    sans = len(client.get("/v1/audit").content)
    avec = len(client.get("/v1/audit?with_signature=true").content)
    assert avec > sans, "la signature pèse, et c'est pourquoi elle est optionnelle"


# --- La vérification HORS LIGNE, celle qui porte la preuve (§36.10.4) -------


def test_le_journal_entier_se_REVERIFIE_ligne_à_ligne(atelier):
    """C'est ce geste-ci qui attrape l'adversaire qui a root : il peut supprimer
    ou tronquer, il ne peut pas produire une signature qu'il n'a pas la clé de
    produire."""
    from sparkd.db import connect

    client = _client(atelier)
    entetes = _signe(atelier, method="POST", path="/v1/audit",
                     actor="console/prod", body=None, action="spark.terminal_open")
    client.post("/v1/audit", json=CORPS, headers=entetes)
    client.post("/v1/audit", json=CORPS, headers={"x-spark-actor": "console/prod"})

    connexion = connect(atelier / "a.db")
    verdict = signature.verifier_journal(connexion, atelier / "signataires")
    assert verdict["signees"] == 1, "seule la ligne signée est jugée"
    assert verdict["verifiees"] == 1
    assert verdict["intact"] is True
    assert verdict["rupture"] is None


def test_une_signature_FABRIQUÉE_après_coup_est_démasquée(atelier):
    """L'attaque que cette unité existe pour attraper : root récrit le journal et
    y colle une signature. Le verrou d'écriture est désactivé le temps de la
    simuler — c'est un adversaire qui a déjà root."""
    from sparkd.db import connect

    client = _client(atelier)
    client.post("/v1/audit", json=CORPS, headers={"x-spark-actor": "console/prod"})

    connexion = connect(atelier / "a.db")
    connexion.execute("DROP TRIGGER audit_log_immuable_update")
    connexion.execute(
        "UPDATE audit_log SET signature = 'fabriquee', signed_bytes = 'eyJ4IjoxfQ==',"
        " signature_version = ? WHERE action = 'spark.terminal_open'",
        (signature.VERSION,))

    verdict = signature.verifier_journal(connexion, atelier / "signataires")
    assert verdict["intact"] is False
    assert verdict["rupture"]["action"] == "spark.terminal_open"
    assert verdict["rupture"]["motif"] == "signature_invalide"


def test_une_VERSION_inconnue_n_est_pas_une_rupture(atelier):
    """§36.9.2 : la forme évolue par versions. Confondre « je ne sais pas
    vérifier » avec « c'est falsifié » serait faux, et ferait crier au loup le
    jour d'une migration de format."""
    from sparkd.db import connect

    client = _client(atelier)
    client.post("/v1/audit", json=CORPS, headers={"x-spark-actor": "console/prod"})
    connexion = connect(atelier / "a.db")
    connexion.execute("DROP TRIGGER audit_log_immuable_update")
    connexion.execute(
        "UPDATE audit_log SET signature = 'x', signed_bytes = 'eyJ4IjoxfQ==',"
        " signature_version = 'sshsig-v99' WHERE action = 'spark.terminal_open'")

    verdict = signature.verifier_journal(connexion, atelier / "signataires")
    assert verdict["signees"] == 1
    assert verdict["verifiees"] == 0, "elle n'est pas vérifiable"
    assert verdict["intact"] is True, "et ce n'est pas une rupture"
