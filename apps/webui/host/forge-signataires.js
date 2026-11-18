/**
 * La console pose sa ligne dans `allowed_signers`, à la connexion.
 *
 * @spec docs/BACKLOG.md#SPK-172 · docs/DAT.md §70.3 (par qui, quand,
 *       comment ; ce qui se voit) · §36.10.5 (où vivent les clés autorisées),
 *       §36.10.8 (un échec de signature ne bloque jamais un geste) · §50.1
 *       (le transport SSH, distinct du plan de contrôle)
 *
 * La console est seule à connaître le principal (`console/<serveur>`) et la clé
 * publique qui signe pour ce serveur : ni le cloud-init ni la Forge ne savent le
 * nom que la console lui donne. Sans ce geste, la première signature arrivait
 * sur une Forge qui ne pouvait la rattacher à personne, et le premier ajout
 * d'image au catalogue échouait (`spark-010`, 2026-11-18).
 *
 * Le navigateur ne fournit rien ici. Le nom vient de l'inventaire et la clé du
 * fichier PUBLIC que l'inventaire désigne ; les deux sont validés, puis passés
 * en arguments positionnels au script fermé ci-dessous, qui ne fait qu'appeler
 * `python -m sparkd.signataires poser` — ce module-là revalide en root.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

export const SIGNATAIRES_TIMEOUT_MS = 20_000;
export const MAX_OUTPUT_BYTES = 8 * 1024;

/** Les états que la carte du serveur sait dire (DAT §70.3). */
export const ETATS = Object.freeze(['deja', 'pose', 'remplace', 'sans_droit',
  'sans_sparkd', 'sparkd_ancien', 'refus', 'echec']);

/** Même forme que `sparkd.signataires.PRINCIPAL`. */
export const PRINCIPAL = /^console\/[a-z0-9][a-z0-9._-]{0,62}$/;
/** Le type d'une clé publique OpenSSH, et son corps base64. */
const TYPE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/;
const CORPS = /^[A-Za-z0-9+/]+={0,3}$/;

/**
 * Script POSIX fermé, envoyé sur stdin. Ses seules entrées sont trois arguments
 * déjà validés — le principal, le type et le corps de la clé —, dont aucun ne
 * porte d'espace ni de caractère que le shell distant interpréterait.
 */
export const SIGNATAIRES_SCRIPT = String.raw`#!/bin/sh
set -u
principal="__DOLLAR__{1-}"
cle="__DOLLAR__{2-} __DOLLAR__{3-}"
if [ "$(id -u 2>/dev/null || printf x)" = 0 ]; then
  admin() { "$@"; }
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  admin() { sudo -n "$@"; }
else
  printf '%s\n' '{"etat":"sans_droit"}'
  exit 0
fi
py=/opt/sparkd/venv/bin/python
if [ ! -x "$py" ]; then
  printf '%s\n' '{"etat":"sans_sparkd"}'
  exit 0
fi
if ! admin "$py" -c 'import sparkd.signataires' >/dev/null 2>&1; then
  printf '%s\n' '{"etat":"sparkd_ancien"}'
  exit 0
fi
admin "$py" -m sparkd.signataires poser --principal "$principal" --cle "$cle"
`.replaceAll('__DOLLAR__', '$');

/** Le principal et les deux champs de la clé, ou `null` si quelque chose cloche. */
export function argumentsDe(server, clePublique) {
  const principal = `console/${server?.name ?? ''}`;
  if (!PRINCIPAL.test(principal)) return null;
  const [type, corps] = String(clePublique ?? '').trim().split(/\s+/);
  if (!TYPE.test(type ?? '') || !CORPS.test(corps ?? '')) return null;
  return [principal, type, corps];
}

/** Arguments OpenSSH ; le script fermé est lu sur stdin par `sh -s`. */
export function sshArgs(server, args) {
  const commun = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  const cible = server.kind === 'alias' ? [server.sshHost]
    : ['-p', String(server.port), `${server.user}@${server.host}`];
  return [...commun, ...cible, 'sh', '-s', '--', ...args];
}

/** La ligne JSON du script devient un état fermé, jamais un texte libre. */
export function lireResultat(sortie) {
  const derniere = String(sortie ?? '').trim().split('\n').pop() ?? '';
  try {
    const lu = JSON.parse(derniere);
    if (ETATS.includes(lu?.etat)) {
      return { etat: lu.etat, ...(lu.message ? { message: String(lu.message).slice(0, 300) } : {}) };
    }
  } catch { /* une sortie qui n'est pas la ligne attendue est un échec, nommé ci-dessous */ }
  return { etat: 'echec', message: 'La Forge n’a pas rendu la ligne attendue.' };
}

const chemin = (valeur) => String(valeur).replace(/^~(?=\/)/, homedir());

/**
 * Pose la ligne de cette console sur la Forge. Ne lève jamais : l'échec est un
 * ÉTAT, rendu à la carte du serveur (§36.10.8 — ne pas pouvoir signer
 * n'empêche aucun geste).
 *
 * Rend `null` quand le geste ne s'applique pas : Forge locale (aucun transport
 * SSH), ou serveur sans clé de signature (la console ne signe pas pour lui).
 */
export async function poserSignataires(server, {
  spawnFn = spawn, lire = (f) => readFile(f, 'utf8'),
  timeoutMs = SIGNATAIRES_TIMEOUT_MS,
} = {}) {
  if (!server || server.kind === 'local' || !server.signingKey) return null;
  let clePublique;
  try {
    clePublique = await lire(chemin(server.signingKey));
  } catch {
    return { etat: 'echec', message: 'La clé publique de signature déclarée est illisible sur ce poste.' };
  }
  const args = argumentsDe(server, clePublique);
  if (!args) {
    return { etat: 'refus', message: 'La clé de signature déclarée n’est pas une clé publique OpenSSH.' };
  }
  return new Promise((resolve) => {
    let enfant;
    try {
      enfant = spawnFn('ssh', sshArgs(server, args), { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (erreur) {
      resolve({ etat: 'echec', message: `OpenSSH n’a pas pu démarrer : ${erreur.message}` });
      return;
    }
    let sortie = '';
    let fini = false;
    const finir = (resultat) => { if (!fini) { fini = true; clearTimeout(minuteur); resolve(resultat); } };
    const minuteur = setTimeout(() => {
      enfant.kill?.('SIGTERM');
      finir({ etat: 'echec', message: 'La pose des signataires a dépassé 20 secondes.' });
    }, timeoutMs);
    enfant.stdout?.on('data', (morceau) => {
      if (sortie.length < MAX_OUTPUT_BYTES) sortie += String(morceau);
    });
    enfant.on('error', (erreur) => finir({ etat: 'echec', message: `OpenSSH : ${erreur.message}` }));
    enfant.on('close', (code) => {
      if (code !== 0 && !sortie.trim()) {
        finir({ etat: 'echec', message: `OpenSSH s’est arrêté (code ${code}).` });
        return;
      }
      finir(lireResultat(sortie));
    });
    enfant.stdin?.end(SIGNATAIRES_SCRIPT);
  });
}
