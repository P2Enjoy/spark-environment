/**
 * Appliquer les mises à jour du système de la Forge : l'hôte console, par SSH.
 *
 * @spec docs/BACKLOG.md#SPK-181 · docs/DAT.md §73.2 (par où passe le geste ; ce
 *       qui se refuse ; l'état d'une application ; le doublon d'épreuve) ·
 *       §40.6, §51.4 (le même chemin que la mise à jour et le redémarrage) ·
 *       §53.3 (SPARK_UPGRADE_COMMAND, lu sous SPARK_EPREUVE=1 seulement)
 *
 * sparkd ne PEUT pas appliquer de paquets : son unité est durcie
 * (`ProtectSystem=strict`, `NoNewPrivileges`), et c'est voulu — mesuré sur
 * `spark-010` le 2026-11-18, `apt-get` y échouait en code 100. Le geste passe
 * donc par le transport de l'exploitant, comme les autres gestes de système.
 *
 * Le navigateur ne fournit que des NOMS, validés ici, puis vérifiés contre la
 * liste que sparkd rend à l'instant. Ils deviennent les arguments positionnels
 * d'un script fermé ; aucun autre texte ne vient de la page.
 */

import { spawn } from 'node:child_process';

export const APPLICATION_TIMEOUT_MS = 30 * 60 * 1000;
export const PAQUETS_MAX = 500;
export const LIGNES_GARDEES = 40;
export const OCTETS_GARDES = 8 * 1024;
export const NOM_PAQUET = /^[a-z0-9][a-z0-9+.-]{0,127}$/;

export class ApplicationRefusee extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Script fermé, lu sur stdin par `sh -s`. Ses seuls arguments sont les noms. Il
 * dit son issue sur une dernière ligne `marqueur=…`, la seule qu'on interprète.
 */
export const APPLICATION_SCRIPT = String.raw`#!/bin/sh
set -u
if [ "$(id -u 2>/dev/null || printf x)" = 0 ]; then
  admin() { "$@"; }
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  admin() { sudo -n "$@"; }
else
  printf 'marqueur=sans_droit\n'
  exit 0
fi
sortie=$(admin env DEBIAN_FRONTEND=noninteractive LANG=C LC_ALL=C \
  apt-get install -y --only-upgrade -o Dpkg::Options::=--force-confold \
  -o DPkg::Lock::Timeout=0 "$@" 2>&1)
code=$?
printf '%s\n' "$sortie" | tail -n 40
printf 'marqueur=code:%s\n' "$code"
`;

/** Les noms, s'ils ont la forme d'un paquet Debian et sont en attente (§73.2). */
export function validerPaquets(demandes, enAttente) {
  if (!Array.isArray(demandes) || demandes.length === 0) {
    throw new ApplicationRefusee(422, 'refused', 'Aucun paquet n’est désigné.');
  }
  if (demandes.length > PAQUETS_MAX) {
    throw new ApplicationRefusee(422, 'refused', `Au plus ${PAQUETS_MAX} paquets par application.`);
  }
  const noms = [];
  for (const nom of demandes) {
    if (typeof nom !== 'string' || !NOM_PAQUET.test(nom)) {
      throw new ApplicationRefusee(422, 'refused',
        `Nom de paquet invalide : « ${String(nom).slice(0, 60)} ».`);
    }
    if (!enAttente.has(nom)) {
      throw new ApplicationRefusee(422, 'refused',
        `« ${nom} » n’est pas une mise à jour en attente sur cette Forge : seul ce qui l’attend se met à jour.`);
    }
    if (!noms.includes(nom)) noms.push(nom);
  }
  return noms;
}

/** La sortie du script devient un état fermé (§73.2). */
export function lireIssue(sortie, codeProcessus = 0) {
  const lignes = String(sortie ?? '').replace(/\r/g, '').split('\n');
  while (lignes.length && lignes[lignes.length - 1] === '') lignes.pop();
  const marqueur = lignes.length && /^marqueur=/.test(lignes[lignes.length - 1]) ? lignes.pop() : null;
  const texte = lignes.slice(-LIGNES_GARDEES).join('\n').slice(-OCTETS_GARDES);
  if (marqueur === 'marqueur=sans_droit') {
    return { etat: 'echec', motif: 'sans_droit', code: null, sortie: '' };
  }
  const code = /^marqueur=code:(\d+)$/.exec(marqueur ?? '');
  if (!code) {
    return { etat: 'echec', motif: 'apt', code: codeProcessus || null,
             sortie: texte || 'La Forge n’a pas rendu son issue.' };
  }
  const n = Number(code[1]);
  if (n === 0) return { etat: 'terminee', motif: null, code: 0, sortie: texte };
  const occupe = /Could not get lock|is held by process|Unable to acquire the dpkg/.test(texte);
  return { etat: 'echec', motif: occupe ? 'occupe' : 'apt', code: n, sortie: texte };
}

/** Arguments OpenSSH : la destination, `sh -s --`, puis les noms validés. */
export function sshArgs(server, paquets) {
  const commun = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  const cible = server.kind === 'alias' ? [server.sshHost]
    : ['-p', String(server.port), `${server.user}@${server.host}`];
  return [...commun, ...cible, 'sh', '-s', '--', ...paquets];
}

/** Lance le script ; ne lève jamais : l'échec est une ISSUE. */
export function executerApplication(server, paquets, {
  spawnFn = spawn, doublon = null, timeoutMs = APPLICATION_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve) => {
    let enfant;
    try {
      // SPK-100 · §53.3 : le doublon est PASSÉ, jamais relu ici.
      enfant = doublon
        ? spawnFn('sh', ['-c', doublon, 'doublon', ...paquets], { stdio: ['pipe', 'pipe', 'pipe'] })
        : spawnFn('ssh', sshArgs(server, paquets), { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (erreur) {
      resolve({ etat: 'echec', motif: 'apt', code: null, sortie: `OpenSSH n’a pas pu démarrer : ${erreur.message}` });
      return;
    }
    let sortie = '';
    let fini = false;
    const finir = (issue) => { if (!fini) { fini = true; clearTimeout(minuteur); resolve(issue); } };
    const minuteur = setTimeout(() => {
      enfant.kill?.('SIGTERM');
      finir({ etat: 'echec', motif: 'apt', code: null, sortie: 'L’application a dépassé 30 minutes.' });
    }, timeoutMs);
    const prendre = (morceau) => { sortie = (sortie + String(morceau)).slice(-4 * OCTETS_GARDES); };
    enfant.stdout?.on('data', prendre);
    enfant.stderr?.on('data', prendre);
    enfant.on('error', (erreur) => finir({ etat: 'echec', motif: 'apt', code: null, sortie: erreur.message }));
    enfant.on('close', (code) => finir(lireIssue(sortie, code)));
    enfant.stdin?.end(APPLICATION_SCRIPT);
  });
}

/**
 * Une application à la fois PAR SERVEUR ; l'état vit ici, dans l'hôte (§73.2).
 *
 * `executer(serveur, paquets)` rend l'issue ; `fin(serveur, état)` est appelé une
 * fois l'issue connue — c'est là que l'issue s'inscrit au journal.
 */
export class Applications {
  #etats = new Map();

  constructor({ executer = executerApplication, fin = () => {} } = {}) {
    this.executer = executer;
    this.fin = fin;
  }

  etat(nom) {
    return { ...(this.#etats.get(nom) ?? { etat: 'aucune' }) };
  }

  /** Lance, ou refuse en 409. `avant` s'exécute après le refus éventuel. */
  async lancer(serveur, paquets, { avant = async () => {} } = {}) {
    if (this.#etats.get(serveur.name)?.etat === 'en_cours') {
      throw new ApplicationRefusee(409, 'busy',
        'Une application de mises à jour est déjà en cours sur cette Forge.');
    }
    const debut = new Date().toISOString();
    this.#etats.set(serveur.name, { etat: 'en_cours', motif: null, paquets: [...paquets],
                                    debut, fin: null, code: null, sortie: '' });
    try {
      await avant();
    } catch (erreur) {
      this.#etats.delete(serveur.name);
      throw erreur;
    }
    const travail = Promise.resolve()
      .then(() => this.executer(serveur, paquets))
      .then((issue) => {
        const final = { ...this.#etats.get(serveur.name), ...issue, fin: new Date().toISOString() };
        this.#etats.set(serveur.name, final);
        return Promise.resolve(this.fin(serveur, final)).catch(() => null).then(() => final);
      });
    this.dernierTravail = travail;
    return this.etat(serveur.name);
  }
}
