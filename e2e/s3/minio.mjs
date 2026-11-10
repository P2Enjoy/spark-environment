/**
 * Le MinIO éphémère des preuves : démarrer, attendre, créer des comptes, retirer.
 *
 * @spec docs/BACKLOG.md#SPK-160 · docs/DAT.md §67.13 (MinIO, le S3 de développement
 *       et de preuve) · CLAUDE.md §3 (aucune variable d'environnement), §19 (licence)
 *
 * Ce module ne prend PAS le verrou des épreuves lourdes (CLAUDE.md §15 bis) : ce sont
 * ses importeurs qui le prennent, avant leur première allocation. `spk160-minio.mjs`
 * le prend à son import ; la mesure de la VM tourne dans le processus du banc, qui le
 * tient déjà.
 *
 * MinIO est sous licence AGPLv3 : il ne sert qu'aux preuves, il n'est ni distribué ni
 * installé avec le produit. Les identifiants ci-dessous sont JETABLES et ne valent que
 * sur la boucle locale de ce poste ; aucun secret réel n'entre ici.
 */
import { spawnSync } from 'node:child_process';

export const IMAGE_MINIO = 'quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z';
export const IMAGE_MC = 'quay.io/minio/mc:RELEASE.2025-04-16T18-13-26Z';
export const ADMIN = { utilisateur: 'spk160root', motDePasse: 'spk160-jetable-pass' };

export const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });

/** Démarre un MinIO sur `127.0.0.1:<port>`, mémoire plafonnée, retiré à l'arrêt. */
export function demarrerMinio({ nom, port, extra = [] }) {
  const r = docker('run', '-d', '--rm', '--name', nom, '--memory', '768m',
    '-p', `127.0.0.1:${port}:9000`,
    '-e', `MINIO_ROOT_USER=${ADMIN.utilisateur}`, '-e', `MINIO_ROOT_PASSWORD=${ADMIN.motDePasse}`,
    ...extra, IMAGE_MINIO, 'server', '/data');
  if (r.status !== 0) throw new Error(`${nom} : ${r.stderr.trim()}`);
}

/** Vrai quand `/minio/health/live` répond 200. Le conteneur TLS ne répond pas en clair. */
export function minioVivant(port, secondes = 40) {
  for (let i = 0; i < secondes; i += 1) {
    const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '2',
      `http://127.0.0.1:${port}/minio/health/live`], { encoding: 'utf8' });
    if (r.stdout === '200') return true;
    spawnSync('sleep', ['1']);
  }
  return false;
}

/** Joue un script `mc` (shell) contre `http://127.0.0.1:<port>`, alias `l`. */
export function jouerMc(port, script) {
  const entete = `set -e\nmc alias set l http://127.0.0.1:${port} ${ADMIN.utilisateur} ${ADMIN.motDePasse} >/dev/null\n`;
  const r = docker('run', '--rm', '--network', 'host', '--entrypoint', '/bin/sh', IMAGE_MC,
    '-c', entete + script);
  if (r.status !== 0) throw new Error(`mc a échoué : ${r.stderr.trim()}`);
  return r.stdout;
}

/** Retire des conteneurs par NOM — jamais par motif : un autre projet a les siens. */
export function retirerConteneurs(...noms) {
  for (const nom of noms) docker('rm', '-f', nom);
}
