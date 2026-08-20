"""@verifies docs/BACKLOG.md#SPK-40 · docs/DAT.md §36.3, §36.4,
            §36.10 (le contrat), §36.10.2 (SSHSIG, mesuré),
            §36.10.3 (la forme canonique), §36.10.4 (où la vérification a lieu),
            §36.10.5 (les clés autorisées) · §45.4 (ce n'est PAS de
            l'authentification)

Ce que ces preuves gardent, et c'est LE point de l'unité : **une requête non
signée reste acceptée, une signature invalide est refusée**. Confondre les deux
ferait de ce mécanisme un contrôle d'accès, ce que l'arbitrage de SPK-35 dit
qu'il n'est pas.

Elles emploient un VRAI `ssh-keygen` et de vraies clés jetables : doubler la
cryptographie ne prouverait que la fidélité du doublon, et c'est justement
OpenSSH dont le comportement décide des refus (§36.10.2).
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from sparkd import signature


@pytest.fixture
def atelier(tmp_path):
    """Deux clés — celle du responsable et une intruse — et la liste autorisée."""
    for nom in ("resp", "intrus"):
        subprocess.run(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", nom,
                        "-f", str(tmp_path / nom)], capture_output=True, check=True)
    pub = (tmp_path / "resp.pub").read_text("utf-8").split()
    (tmp_path / "signataires").write_text(
        f"responsable@p2enjoy {pub[0]} {pub[1]}\n", "utf-8")
    return tmp_path


def _signer(atelier: Path, octets: bytes, cle: str = "resp") -> str:
    fichier = atelier / "a-signer"
    fichier.write_bytes(octets)
    (atelier / "a-signer.sig").unlink(missing_ok=True)
    subprocess.run(["ssh-keygen", "-Y", "sign", "-f", str(atelier / cle),
                    "-n", signature.NAMESPACE, str(fichier)],
                   capture_output=True, check=True)
    return (atelier / "a-signer.sig").read_text("utf-8")


INTENTION = {
    "method": "POST", "path": "/v1/sparks", "actor": "responsable@p2enjoy",
    "ts": "2026-08-21T00:20:00+00:00", "action": "spark.create",
    "body": {"name": "essai"},
}


# --- La forme canonique, figée (§36.10.3) -----------------------------------


def test_la_forme_est_TRIÉE_sans_espace_et_en_ascii():
    """Le premier piège du §36.5 : une vérification qui échouerait un an plus
    tard sans qu'aucune ligne n'ait bougé détruirait la confiance dans tout le
    dispositif."""
    octets = signature.canonique(INTENTION)
    assert octets == (b'{"action":"spark.create","actor":"responsable@p2enjoy",'
                      b'"body":{"name":"essai"},"method":"POST",'
                      b'"path":"/v1/sparks","ts":"2026-08-21T00:20:00+00:00"}')


def test_une_valeur_ABSENTE_est_sérialisée_null_jamais_omise():
    """Omettre une clé produirait deux octets différents pour deux intentions
    équivalentes, et la vérification échouerait sans que rien n'ait bougé."""
    octets = signature.canonique({"method": "GET", "path": "/x"})
    assert b'"body":null' in octets
    assert b'"actor":null' in octets
    assert b'"ts":null' in octets


def test_l_ORDRE_des_clés_ne_dépend_pas_de_celui_du_dictionnaire():
    a = signature.canonique({"ts": "t", "action": "a", "method": "M",
                             "path": "/p", "actor": "moi", "body": None})
    b = signature.canonique({"body": None, "actor": "moi", "path": "/p",
                             "method": "M", "action": "a", "ts": "t"})
    assert a == b


def test_un_champ_HORS_LISTE_n_entre_pas_dans_les_octets():
    """Le champ retenu est figé : y laisser entrer un extra rendrait la forme
    dépendante de ce que l'appelant a mis dans son dictionnaire."""
    octets = signature.canonique({**INTENTION, "surprise": "valeur"})
    assert b"surprise" not in octets


# --- Ce que les octets doivent décrire (§36.10.7) ---------------------------


def test_des_octets_qui_décrivent_UN_AUTRE_geste_sont_rejetés():
    """Sans ce contrôle, on signerait n'importe quoi pour l'attacher à n'importe
    quel geste : la signature serait valide, et attachée à autre chose."""
    octets = signature.canonique(INTENTION)
    assert signature.decrit_bien(octets, method="POST", path="/v1/sparks",
                                 actor="responsable@p2enjoy")
    assert not signature.decrit_bien(octets, method="DELETE", path="/v1/sparks",
                                     actor="responsable@p2enjoy")
    assert not signature.decrit_bien(octets, method="POST", path="/v1/autre",
                                     actor="responsable@p2enjoy")
    assert not signature.decrit_bien(octets, method="POST", path="/v1/sparks",
                                     actor="quelqu-un-d-autre")


def test_des_octets_ILLISIBLES_sont_rejetés_sans_lever():
    assert not signature.decrit_bien(b"\xff\xfe pas du json", method="POST",
                                     path="/x", actor="moi")


# --- La vérification, contre un VRAI ssh-keygen (§36.10.2) ------------------


def test_une_signature_VALIDE_est_acceptée(atelier):
    octets = signature.canonique(INTENTION)
    signature.verifier(octets, _signer(atelier, octets), "responsable@p2enjoy",
                       atelier / "signataires")


def test_l_armure_retirée_est_acceptée_car_l_en_tête_la_porte_sur_UNE_ligne(atelier):
    """§36.10.7 : la signature voyage sur une ligne. Exiger l'armure obligerait à
    encoder des sauts de ligne dans un en-tête HTTP."""
    octets = signature.canonique(INTENTION)
    sig = _signer(atelier, octets)
    une_ligne = "".join(l for l in sig.splitlines() if not l.startswith("-----"))
    signature.verifier(octets, une_ligne, "responsable@p2enjoy",
                       atelier / "signataires")


def test_des_octets_ALTÉRÉS_sont_refusés(atelier):
    """MESURÉ : `-Y verify` rend 255 sur « incorrect signature »."""
    octets = signature.canonique(INTENTION)
    sig = _signer(atelier, octets)
    with pytest.raises(signature.SignatureError) as refus:
        signature.verifier(octets + b" ", sig, "responsable@p2enjoy",
                           atelier / "signataires")
    assert refus.value.motif == "signature_invalide"
    # Le message d'OpenSSH est repris TEL QUEL : il nomme lequel des refus.
    assert "incorrect signature" in str(refus.value)


def test_une_clé_HORS_de_la_liste_est_refusée(atelier):
    """C'est la mesure qui a dû être rejouée de zéro (§36.10.2) : un résidu d'un
    essai précédent avait fait croire à une acceptation."""
    octets = signature.canonique(INTENTION)
    sig = _signer(atelier, octets, cle="intrus")
    with pytest.raises(signature.SignatureError) as refus:
        signature.verifier(octets, sig, "responsable@p2enjoy",
                           atelier / "signataires")
    assert refus.value.motif == "signature_invalide"


def test_une_IDENTITÉ_inconnue_est_refusée(atelier):
    octets = signature.canonique(INTENTION)
    with pytest.raises(signature.SignatureError):
        signature.verifier(octets, _signer(atelier, octets), "autre@ailleurs",
                           atelier / "signataires")


def test_un_ESPACE_DE_NOMS_différent_est_refusé(atelier):
    """Sans lui, une signature produite par le responsable pour un commit ou un
    courriel serait rejouable ici."""
    octets = signature.canonique(INTENTION)
    fichier = atelier / "autre-usage"
    fichier.write_bytes(octets)
    subprocess.run(["ssh-keygen", "-Y", "sign", "-f", str(atelier / "resp"),
                    "-n", "git", str(fichier)], capture_output=True, check=True)
    with pytest.raises(signature.SignatureError) as refus:
        signature.verifier(octets, (atelier / "autre-usage.sig").read_text("utf-8"),
                           "responsable@p2enjoy", atelier / "signataires")
    assert "namespace" in str(refus.value)


# --- Les signataires : absents, la fonction se DÉSACTIVE (§36.10.5) ---------


def test_un_fichier_de_signataires_ABSENT_est_dit_et_non_confondu(atelier):
    """§14.5 : une configuration absente se NOMME. La confondre avec une
    signature invalide ferait chercher un défaut de la signature là où c'est la
    Forge qui n'est pas réglée."""
    octets = signature.canonique(INTENTION)
    with pytest.raises(signature.SignatureError) as refus:
        signature.verifier(octets, _signer(atelier, octets), "responsable@p2enjoy",
                           atelier / "nexistepas")
    assert refus.value.motif == "signataires_absents"
    assert "SPARKD_ALLOWED_SIGNERS" in str(refus.value)


def test_un_fichier_de_signataires_VIDE_vaut_absent(atelier):
    """Un fichier créé mais jamais rempli est le cas le plus fréquent d'une
    installation à moitié faite."""
    (atelier / "vide").write_text("   \n", "utf-8")
    assert signature.signataires(atelier / "vide") is None
    assert signature.signataires(atelier / "signataires") is not None
    assert signature.signataires(None) is None


# --- Les en-têtes (§36.10.7) ------------------------------------------------


def test_une_signature_SANS_ses_octets_est_refusée():
    """Il n'y a rien à vérifier, et le dire vaut mieux que de vérifier du vide."""
    with pytest.raises(signature.SignatureError) as refus:
        signature.lire_entetes({"x-spark-signature": "abc"})
    assert refus.value.motif == "octets_absents"


def test_des_octets_qui_ne_sont_pas_du_base64_sont_refusés():
    with pytest.raises(signature.SignatureError) as refus:
        signature.lire_entetes({"x-spark-signature": "abc",
                                "x-spark-signed": "pas du base64 !!"})
    assert refus.value.motif == "octets_illisibles"


def test_une_requête_SANS_signature_n_en_porte_pas():
    """§36.10.1 : elle passera, et la ligne sera inscrite non signée. Refuser
    ferait de ce mécanisme un contrôle d'accès."""
    assert signature.entete_present({}) is False
    assert signature.entete_present({"x-spark-signature": ""}) is False
    assert signature.entete_present({"x-spark-signature": "sig"}) is True
