/**
 * SPK-160, étape 0 : MinIO seul, avant la VM. Démarre trois MinIO éphémères, joue
 * les sondes du protocole S3, détruit tout.
 *
 * @spec docs/BACKLOG.md#SPK-160 (« MinIO seul, avant la VM ») · docs/DAT.md §67.6
 *       (V1 à V12), §67.13 (MinIO, le client S3) · CLAUDE.md §3 (aucune variable
 *       d'environnement : l'adresse et les chemins sont des ARGUMENTS), §15 bis (le
 *       verrou, pris à l'import), §19 (dépendance et licence)
 *
 * Ce que ça lance : trois conteneurs `quay.io/minio/minio` (principal ; réglé sur
 * `eu-west-3` ; servi en TLS par un certificat auto-signé), l'image `mc` pour créer
 * un compte en lecture seule et un compte sans suppression, et `boto3` installé
 * dans un dossier jetable (`pip --target`) — le venv du produit n'est PAS modifié.
 * Les ports sont ceux de la boucle locale, hors de la plage 9000-9001 qu'un autre
 * projet occupe ; les conteneurs portent le préfixe `spk160-` et rien d'autre n'est
 * jamais arrêté.
 *
 * MinIO est sous licence AGPLv3 : il ne sert qu'aux preuves, il n'est ni distribué
 * ni installé avec le produit (DAT §67.13).
 *
 *   node e2e/s3/spk160-minio.mjs            joue les sondes
 *   node e2e/s3/spk160-minio.mjs --aide     ce texte
 */
import { prendreLeVerrou } from '../verrou.mjs';

prendreLeVerrou();

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demarrerMinio, docker, jouerMc, minioVivant, retirerConteneurs } from './minio.mjs';

const RACINE = new URL('../../', import.meta.url).pathname;
const PYTHON = join(RACINE, 'services/sparkd/.venv/bin/python');
const SONDES = join(RACINE, 'e2e/s3/spk160_minio_sondes.py');
const BOTO3 = 'boto3==1.43.127';
const PORTS = { principal: 19090, region: 19092, tls: 19093 };
const NOMS = ['spk160-minio', 'spk160-minio-region', 'spk160-minio-tls'];
const VOLUME = 'spk160-minio-data';

if (process.argv.includes('--aide') || process.argv.includes('--help')) {
  console.log(new URL(import.meta.url).pathname + '\n'
    + 'Démarre trois MinIO éphémères (127.0.0.1:19090, :19092, :19093), joue\n'
    + 'e2e/s3/spk160_minio_sondes.py contre eux, puis détruit conteneurs, volume et\n'
    + 'dossier de travail. Code de sortie 0 si chaque fait mesuré tient.\n'
    + 'Prérequis : docker, openssl, et le venv de services/sparkd (make bootstrap).');
  process.exit(0);
}

const lancer = (commande, args, options = {}) =>
  spawnSync(commande, args, { encoding: 'utf8', ...options });

const travail = mkdtempSync(join(tmpdir(), 'spk160-minio-'));

/** Retire les conteneurs et le volume de CETTE épreuve (préfixe `spk160-`), et eux seuls. */
function retirerLesConteneurs() {
  retirerConteneurs(...NOMS);
  docker('volume', 'rm', '-f', VOLUME);
}
function nettoyer() {
  retirerLesConteneurs();
  rmSync(travail, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { nettoyer(); process.exit(130); });

try {
  // Un reste d'une exécution tuée : ces noms sont ceux de CETTE épreuve, et d'elle seule.
  retirerLesConteneurs();
  const certs = join(travail, 'certs');
  mkdirSync(certs);

  console.log('· boto3 dans un dossier jetable (le venv du produit reste intact)');
  const site = join(travail, 'site');
  const pip = lancer(PYTHON, ['-m', 'pip', 'install', '-q', '--target', site, BOTO3]);
  if (pip.status !== 0) throw new Error(`pip a échoué : ${pip.stderr.slice(-400)}`);

  console.log('· certificat auto-signé pour 127.0.0.1');
  const ssl = lancer('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(certs, 'private.key'), '-out', join(certs, 'public.crt'), '-days', '2',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1']);
  if (ssl.status !== 0) throw new Error(`openssl a échoué : ${ssl.stderr.slice(-300)}`);
  // MinIO tourne sous un autre utilisateur dans le conteneur, la clé doit se lire.
  chmodSync(join(certs, 'private.key'), 0o644);
  chmodSync(join(certs, 'public.crt'), 0o644);

  console.log('· trois MinIO sur la boucle locale');
  demarrerMinio({ nom: NOMS[0], port: PORTS.principal, extra: ['-v', `${VOLUME}:/data`] });
  demarrerMinio({ nom: NOMS[1], port: PORTS.region, extra: ['-e', 'MINIO_SITE_REGION=eu-west-3'] });
  demarrerMinio({ nom: NOMS[2], port: PORTS.tls, extra: ['-v', `${certs}:/root/.minio/certs:ro`] });
  for (const port of [PORTS.principal, PORTS.region]) {
    if (!minioVivant(port)) throw new Error(`MinIO n'est pas vivant sur ${port}`);
  }
  lancer('sleep', ['3']); // le conteneur TLS ne répond pas en clair : on lui laisse le temps

  console.log('· un bucket, un compte en lecture seule, un compte sans suppression');
  const politique = (actions) => JSON.stringify({ Version: '2012-10-17', Statement: [{
    Effect: 'Allow', Action: actions,
    Resource: ['arn:aws:s3:::spk160', 'arn:aws:s3:::spk160/*'] }] });
  const lecture = ['s3:GetBucketLocation', 's3:ListBucket', 's3:GetObject'];
  const sansSuppression = [...lecture, 's3:PutObject', 's3:AbortMultipartUpload',
    's3:ListMultipartUploadParts', 's3:ListBucketMultipartUploads'];
  jouerMc(PORTS.principal, [
    'mc mb --ignore-existing l/spk160 >/dev/null',
    `printf '%s' '${politique(lecture)}' > /tmp/ro.json`,
    `printf '%s' '${politique(sansSuppression)}' > /tmp/nd.json`,
    'mc admin user add l lecteur lecteur-pass-12345 >/dev/null',
    'mc admin user add l sanssuppr sanssuppr-pass-12345 >/dev/null',
    'mc admin policy create l lecture-seule /tmp/ro.json >/dev/null',
    'mc admin policy create l sans-suppression /tmp/nd.json >/dev/null',
    'mc admin policy attach l lecture-seule --user lecteur >/dev/null',
    'mc admin policy attach l sans-suppression --user sanssuppr >/dev/null',
  ].join('\n'));

  console.log('· les sondes\n');
  const sondes = lancer(PYTHON, ['-I', SONDES,
    '--site', site,
    '--principal', `http://127.0.0.1:${PORTS.principal}`,
    '--region', `http://127.0.0.1:${PORTS.region}`,
    '--tls', `https://127.0.0.1:${PORTS.tls}`,
    '--certificat', join(certs, 'public.crt')]);
  const derniere = sondes.stdout.trim().split('\n').pop();
  let resultats;
  try { resultats = JSON.parse(derniere); } catch {
    throw new Error(`sortie illisible (code ${sondes.status}) :\n${sondes.stdout}\n${sondes.stderr}`);
  }
  for (const r of resultats) {
    console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.nom.padEnd(78)} ${r.ok ? r.observe : `attendu « ${r.attendu} », observé « ${r.observe} »`}`);
  }
  const rouges = resultats.filter((r) => !r.ok).length;
  console.log(`\n${resultats.length - rouges}/${resultats.length} faits tiennent.`);
  process.exitCode = rouges === 0 ? 0 : 1;
} catch (erreur) {
  console.error(`\nÉPREUVE INTERROMPUE : ${erreur.message}`);
  process.exitCode = 2;
} finally {
  nettoyer();
}
