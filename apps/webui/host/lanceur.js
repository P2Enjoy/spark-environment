/**
 * Lanceur de la console : il garde le processus, et relance l'hôte quand
 * celui-ci l'ANNONCE.
 *
 * @spec docs/BACKLOG.md#SPK-117 · docs/DAT.md §62.1 (un lanceur, parce qu'un
 *       processus ne se relance pas lui-même)
 *
 * Un processus Node ne peut pas se remplacer : il peut seulement mourir.
 * Quelqu'un doit rester en vie pour démarrer le suivant, et ce ne peut être ni
 * le shell de `sparkui` ni `make` — ils ne distinguent pas une mort voulue d'une
 * panne. Ce fichier est ce quelqu'un. Il ne fait RIEN d'autre : pas de réglage,
 * pas d'argument, pas de variable d'environnement.
 *
 * Le protocole tient en trois messages sur le canal IPC :
 *
 *   enfant  → lanceur  { type: DEMANDE }       « qui me porte ? »
 *   lanceur → enfant   { type: PRESENTATION }  « moi, et je sais te relancer »
 *   enfant  → lanceur  { type: RELANCE }       « relance-moi quand je sors »
 *
 * La présentation est une RÉPONSE, et non un envoi à la naissance : un message
 * posé avant que l'enfant n'écoute serait perdu, et la console se croirait non
 * relançable pour de bon.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const DEMANDE = 'spark-console:qui-me-porte';
export const PRESENTATION = 'spark-console:lanceur';
export const RELANCE = 'spark-console:relance';

const SIGNAUX = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

/**
 * Démarre `script` et le relance tant qu'il l'annonce avant de sortir.
 *
 * Rend une promesse du code de sortie que le lanceur doit prendre : celui de
 * l'enfant, ou 128 + le numéro du signal qui l'a tué, comme un shell.
 *
 * Une panne n'est JAMAIS relancée : seul un enfant qui a annoncé sa relance
 * l'obtient. Relancer en boucle une console qui ne démarre pas cacherait la
 * panne dans un journal qui défile.
 */
export function superviser({ script, spawnFn = spawn, processus = process,
                             journal = (ligne) => console.log(ligne) }) {
  return new Promise((terminer) => {
    let enfant = null;
    let arret = null;
    let relanceAnnoncee = false;

    const vivant = () => enfant && enfant.exitCode === null && enfant.signalCode === null;
    const ecouteurs = Object.keys(SIGNAUX).map((signal) => [signal, () => {
      // Un signal reçu arrête tout : ni `Ctrl-C` ni `sparkui stop` ne doivent
      // être pris pour une demande de relance.
      arret = signal;
      if (vivant()) enfant.kill(signal);
    }]);
    for (const [signal, ecouteur] of ecouteurs) processus.on(signal, ecouteur);

    const finir = (code) => {
      for (const [signal, ecouteur] of ecouteurs) processus.off(signal, ecouteur);
      terminer(code);
    };

    const demarrer = () => {
      relanceAnnoncee = false;
      enfant = spawnFn(processus.execPath, [script], {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      });
      enfant.on('message', (message) => {
        if (message?.type === DEMANDE) enfant.send({ type: PRESENTATION });
        if (message?.type === RELANCE) relanceAnnoncee = true;
      });
      enfant.on('error', (erreur) => {
        journal(`Lanceur : la console n'a pas pu démarrer : ${erreur.message}`);
        finir(1);
      });
      // `close` et non `exit` : `exit` peut précéder la lecture du dernier
      // message du canal, et l'annonce de relance serait alors perdue — une
      // relance demandée deviendrait un arrêt.
      enfant.on('close', (code, signal) => {
        if (!arret && relanceAnnoncee) {
          journal('Lanceur : console relancée avec le code du dépôt.');
          demarrer();
          return;
        }
        finir(code ?? 128 + (SIGNAUX[signal] ?? SIGNAUX[arret] ?? 0));
      });
    };
    demarrer();
  });
}

/**
 * Le côté ENFANT du protocole, pour `main.js`.
 *
 * `relancable` ne devient vrai qu'après la présentation du lanceur. Un canal IPC
 * seul ne suffit pas : un processus qui ouvrirait `main.js` avec un canal sans
 * l'écouter ferait d'un redémarrage un arrêt.
 */
export function canalEnfant(processus = process) {
  const etat = { presente: false };
  if (typeof processus.send !== 'function') {
    return { get relancable() { return false; }, saluer() {}, surPerte() {},
             async relancer() { throw new Error('aucun lanceur'); } };
  }
  processus.on('message', (message) => {
    if (message?.type === PRESENTATION) etat.presente = true;
  });
  return {
    get relancable() { return etat.presente; },
    /** À appeler une fois à l'écoute : c'est la question « qui me porte ? ». */
    saluer() { processus.send({ type: DEMANDE }); },
    /** Le lanceur est mort : on ne lui survit pas en tenant le port. */
    surPerte(agir) { processus.on('disconnect', agir); },
    /**
     * Annonce la relance, laisse `fermer` rendre le port et les enfants, puis
     * sort. L'annonce part AVANT la fermeture : une console qui sortirait sans
     * l'avoir fait serait prise, à juste titre, pour une panne.
     */
    async relancer(fermer) {
      await new Promise((ok) => processus.send({ type: RELANCE }, ok));
      await fermer();
      processus.exit(0);
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'main.js');
  superviser({ script }).then((code) => process.exit(code));
}
