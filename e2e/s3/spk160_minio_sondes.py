"""Les sondes du protocole S3, jouées contre un MinIO éphémère (SPK-160, étape 0).

@spec docs/BACKLOG.md#SPK-160 (étape 0 : « MinIO seul, avant la VM ») ·
      docs/DAT.md §67.6 (la batterie V1 à V12 et ses causes typées), §67.3 (l'envoi
      par parts, le balayage des envois abandonnés), §67.13 (MinIO, le client S3)
@verifies SPK-160 : chaque ligne consigne un FAIT MESURÉ du 2026-11-10 contre
      `quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z` et `boto3` 1.43.127. Si l'un
      d'eux change, la ligne devient rouge et le DAT §67.6 est à corriger : c'est
      cette preuve qui garde la documentation vraie.

Lancé par `spk160-minio.mjs`, qui démarre les conteneurs et passe les adresses en
arguments NOMMÉS (CLAUDE.md §3 : aucune variable d'environnement). Les identifiants
sont jetables et ne valent que sur la boucle locale de ce poste.

MinIO prouve le PROTOCOLE, pas un fournisseur : la région n'y est pas imposée, et
le comportement d'un S3 réel (AWS, Scaleway, OVH…) reste à établir par le
propriétaire (DAT §67.13).
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import sys

parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
parser.add_argument("--site", required=True, help="dossier contenant boto3 (pip --target)")
parser.add_argument("--principal", required=True, help="URL du MinIO principal")
parser.add_argument("--region", required=True, help="URL du MinIO réglé sur eu-west-3")
parser.add_argument("--tls", required=True, help="URL https du MinIO au certificat auto-signé")
parser.add_argument("--certificat", required=True, help="le certificat public auto-signé")
args = parser.parse_args()
sys.path.insert(0, args.site)

import boto3  # noqa: E402
import botocore.auth  # noqa: E402
from botocore.config import Config  # noqa: E402
from botocore.exceptions import ClientError  # noqa: E402

BUCKET, MIO = "spk160", 1024 * 1024
ROOT = ("spk160root", "spk160-jetable-pass")
LECTEUR = ("lecteur", "lecteur-pass-12345")
SANS_SUPPR = ("sanssuppr", "sanssuppr-pass-12345")
RESULTATS: list[dict] = []


def client(identifiants, url=None, region="us-east-1", verify=None):
    return boto3.client(
        "s3", endpoint_url=url or args.principal, region_name=region,
        aws_access_key_id=identifiants[0], aws_secret_access_key=identifiants[1],
        verify=verify,
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"},
                      retries={"max_attempts": 1}, connect_timeout=3, read_timeout=15),
    )


def verifier(nom: str, attendu: str, produire) -> None:
    """Joue `produire()` et compare, à l'octet près, à ce qu'on a MESURÉ.

    `ok` : la requête a abouti sans valeur à comparer. `ok:<valeur>` : elle a abouti
    et rendu cette valeur. `<statut> <code>` : le S3 l'a refusée avec ce code.
    Autrement, le NOM du type d'exception (`SSLError`, `EndpointConnectionError`).
    """
    try:
        valeur = produire()
        observe = "ok" if valeur is None else f"ok:{valeur}"
        reussi = observe == attendu
    except ClientError as erreur:
        code = erreur.response["Error"].get("Code")
        observe = f"{erreur.response['ResponseMetadata']['HTTPStatusCode']} {code}"
        reussi = observe == attendu
    except Exception as erreur:  # noqa: BLE001 — on consigne le type, c'est la mesure
        observe = type(erreur).__name__
        reussi = observe == attendu
    RESULTATS.append({"nom": nom, "attendu": attendu, "observe": observe, "ok": reussi})


root = client(ROOT)

# --- 1. V6, V7 : écrire et relire -------------------------------------------------
donnees = os.urandom(300_000)
verifier("V6 écriture d'un objet", "ok", lambda: root.put_object(Bucket=BUCKET, Key="t/a", Body=donnees) and None)
verifier("V7 relecture, empreinte identique", "ok:True",
         lambda: hashlib.sha256(root.get_object(Bucket=BUCKET, Key="t/a")["Body"].read()).digest()
         == hashlib.sha256(donnees).digest())


# --- 2. V8 : l'envoi par parts ----------------------------------------------------
def envoi_par_parts(tailles):
    envoi = root.create_multipart_upload(Bucket=BUCKET, Key="t/mp")["UploadId"]
    empreinte, parts = hashlib.sha256(), []
    try:
        for numero, taille in enumerate(tailles, 1):
            morceau = os.urandom(taille)
            empreinte.update(morceau)
            etag = root.upload_part(Bucket=BUCKET, Key="t/mp", UploadId=envoi,
                                    PartNumber=numero, Body=morceau)["ETag"]
            parts.append({"PartNumber": numero, "ETag": etag})
        root.complete_multipart_upload(Bucket=BUCKET, Key="t/mp", UploadId=envoi,
                                       MultipartUpload={"Parts": parts})
    except Exception:
        # Une part non abandonnée reste FACTURÉE sans objet (DAT §67.3).
        root.abort_multipart_upload(Bucket=BUCKET, Key="t/mp", UploadId=envoi)
        raise
    relu = hashlib.sha256()
    for bloc in root.get_object(Bucket=BUCKET, Key="t/mp")["Body"].iter_chunks(MIO):
        relu.update(bloc)
    return relu.digest() == empreinte.digest()


verifier("V8 envoi par parts 5+5+0,1 Mio, relecture identique", "ok:True",
         lambda: envoi_par_parts([5 * MIO, 5 * MIO, MIO // 10]))
verifier("V8 envoi par parts, 9 parts de 5 Mio (45 Mio)", "ok:True",
         lambda: envoi_par_parts([5 * MIO] * 9))
verifier("V8 une part non finale de 1 Mio est refusée", "400 EntityTooSmall",
         lambda: envoi_par_parts([MIO, MIO, MIO // 10]))

# --- 3. V4 : la cause se lit sur un GET, jamais sur un HEAD -----------------------
verifier("V4 HEAD, mauvaise clé secrète : AUCUN code", "403 403",
         lambda: client(("spk160root", "FAUX")).head_bucket(Bucket=BUCKET))
verifier("V4 HEAD, bucket absent : AUCUN code", "404 404",
         lambda: root.head_bucket(Bucket="nexiste-pas"))
verifier("V4 GET, mauvaise clé secrète", "403 SignatureDoesNotMatch",
         lambda: client(("spk160root", "FAUX")).list_objects_v2(Bucket=BUCKET, MaxKeys=1))
verifier("V4 GET, identifiant inconnu", "403 InvalidAccessKeyId",
         lambda: client(("inconnu", "x" * 20)).list_objects_v2(Bucket=BUCKET, MaxKeys=1))
verifier("V4 GET, bucket absent", "404 NoSuchBucket",
         lambda: root.list_objects_v2(Bucket="nexiste-pas", MaxKeys=1))
verifier("V4 GET, bucket absent vu d'un compte restreint : indiscernable d'un refus",
         "403 AccessDenied",
         lambda: client(LECTEUR).list_objects_v2(Bucket="nexiste-pas", MaxKeys=1))
verifier("V2 hôte injoignable", "EndpointConnectionError",
         lambda: client(ROOT, url="http://127.0.0.1:1").list_objects_v2(Bucket=BUCKET, MaxKeys=1))

# --- 4. V5 à V9 : les droits, un compte restreint à la fois -----------------------
lecteur, sans_suppr = client(LECTEUR), client(SANS_SUPPR)
verifier("V5 liste, lecture seule", "ok", lambda: lecteur.list_objects_v2(Bucket=BUCKET, Prefix="t/") and None)
verifier("V7 lecture, lecture seule", "ok", lambda: lecteur.get_object(Bucket=BUCKET, Key="t/a")["Body"].read() and None)
verifier("V6 écriture, lecture seule", "403 AccessDenied",
         lambda: lecteur.put_object(Bucket=BUCKET, Key="t/ro", Body=b"x"))
verifier("V8 envoi par parts, lecture seule", "403 AccessDenied",
         lambda: lecteur.create_multipart_upload(Bucket=BUCKET, Key="t/ro"))
verifier("V9 suppression, lecture seule", "403 AccessDenied",
         lambda: lecteur.delete_object(Bucket=BUCKET, Key="t/a"))
verifier("V6 écriture, sans suppression", "ok", lambda: sans_suppr.put_object(Bucket=BUCKET, Key="t/nd", Body=b"x") and None)
verifier("V8 envoi puis abandon, sans suppression", "ok",
         lambda: sans_suppr.abort_multipart_upload(
             Bucket=BUCKET, Key="t/nd2",
             UploadId=sans_suppr.create_multipart_upload(Bucket=BUCKET, Key="t/nd2")["UploadId"]) and None)
verifier("V9 suppression, sans suppression", "403 AccessDenied",
         lambda: sans_suppr.delete_object(Bucket=BUCKET, Key="t/nd"))

# --- 5. V10, V11 : ce qui avertit sans bloquer ------------------------------------
verifier("V10 versionnage jamais activé", "ok:(jamais activé)",
         lambda: root.get_bucket_versioning(Bucket=BUCKET).get("Status", "(jamais activé)"))
verifier("V10 verrou d'objet absent", "404 ObjectLockConfigurationNotFoundError",
         lambda: root.get_object_lock_configuration(Bucket=BUCKET))
verifier("V10 versionnage, compte restreint : non vérifiable", "403 AccessDenied",
         lambda: lecteur.get_bucket_versioning(Bucket=BUCKET))
verifier("V11 bucket non public", "ok:False",
         lambda: root.get_bucket_policy_status(Bucket=BUCKET)["PolicyStatus"]["IsPublic"])

# --- 6. V3 : la dérive d'horloge, par le VRAI point d'entrée de botocore ----------
def avec_decalage(minutes):
    reel = botocore.auth.get_current_datetime
    botocore.auth.get_current_datetime = lambda *a, **k: dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=minutes)
    try:
        return client(ROOT).list_objects_v2(Bucket=BUCKET, MaxKeys=1) and None
    finally:
        botocore.auth.get_current_datetime = reel


verifier("V3 décalage de +14 min accepté", "ok", lambda: avec_decalage(14))
verifier("V3 décalage de +16 min refusé", "403 RequestTimeTooSkewed", lambda: avec_decalage(16))
verifier("V3 décalage de -16 min refusé", "403 RequestTimeTooSkewed", lambda: avec_decalage(-16))
ecart = abs((dt.datetime.now(dt.timezone.utc) - dt.datetime.strptime(
    root.head_bucket(Bucket=BUCKET)["ResponseMetadata"]["HTTPHeaders"]["date"],
    "%a, %d %b %Y %H:%M:%S GMT").replace(tzinfo=dt.timezone.utc)).total_seconds())
verifier("V3 l'en-tête Date de la réponse donne l'écart (moins de 5 s ici)", "ok:True", lambda: ecart < 5)

# --- 7. le client : les sommes de contrôle par défaut de boto3 --------------------
verifier("boto3 par défaut (sommes de contrôle CRC32) contre MinIO", "ok",
         lambda: root.put_object(Bucket=BUCKET, Key="t/c1", Body=os.urandom(1000)) and None)

# --- 8. le balayage des envois abandonnés : le préfixe n'est PAS fiable -----------
orphelin = root.create_multipart_upload(Bucket=BUCKET, Key="t/orphelin")["UploadId"]
root.upload_part(Bucket=BUCKET, Key="t/orphelin", UploadId=orphelin, PartNumber=1, Body=os.urandom(5 * MIO))
cles = lambda **kw: [u["Key"] for u in root.list_multipart_uploads(Bucket=BUCKET, **kw).get("Uploads", [])]
verifier("balayage sans préfixe : voit l'orphelin", "ok:True", lambda: "t/orphelin" in cles())
verifier("balayage Prefix='t/orphelin' : voit l'orphelin", "ok:True", lambda: "t/orphelin" in cles(Prefix="t/orphelin"))
verifier("balayage Prefix='t/' (finit par /) : NE VOIT RIEN — filtrer côté client", "ok:False",
         lambda: "t/orphelin" in cles(Prefix="t/"))
for envoi in root.list_multipart_uploads(Bucket=BUCKET).get("Uploads", []):
    root.abort_multipart_upload(Bucket=BUCKET, Key=envoi["Key"], UploadId=envoi["UploadId"])
verifier("après abandon de tous les envois : plus aucun", "ok:0", lambda: len(cles()))

# --- 9. V4 : la région se COMPARE (le serveur ne l'impose pas) --------------------
cr = client(ROOT, url=args.region, region="eu-west-3")
cr.create_bucket(Bucket="regtest", CreateBucketConfiguration={"LocationConstraint": "eu-west-3"})
verifier("région : MinIO accepte une région FAUSSE sur un bucket", "ok",
         lambda: client(ROOT, url=args.region, region="us-east-1").list_objects_v2(Bucket="regtest", MaxKeys=1) and None)
verifier("région : GetBucketLocation donne la VRAIE région, même signé en région fausse", "ok:eu-west-3",
         lambda: client(ROOT, url=args.region, region="us-east-1").get_bucket_location(Bucket="regtest")["LocationConstraint"])

# --- 10. V2 : le TLS ---------------------------------------------------------------
verifier("TLS : certificat auto-signé refusé", "SSLError",
         lambda: client(ROOT, url=args.tls).list_objects_v2(Bucket=BUCKET, MaxKeys=1))
verifier("TLS : accepté quand le certificat est fourni comme autorité", "ok",
         lambda: client(ROOT, url=args.tls, verify=args.certificat).list_buckets() and None)
verifier("TLS : parler http à un port TLS donne un 400 sans code", "400 400",
         lambda: client(ROOT, url=args.tls.replace("https://", "http://")).list_buckets())

print(json.dumps(RESULTATS, ensure_ascii=False))
sys.exit(0 if all(r["ok"] for r in RESULTATS) else 1)
