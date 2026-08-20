/**
 * @verifies docs/BACKLOG.md#SPK-45 · docs/DAT.md §37.4.7 (le terminal DANS un
 *           conteneur, mesuré), §37.3.1 (sonder avant de conclure) ·
 *           docs/DESIGN_SYSTEM.md §14.5, §14.7
 *
 * Ce que ces preuves gardent, et c'est LE point de l'unité : **le `127` d'un
 * binaire manquant arrive sur la SORTIE STANDARD**, pas sur la sortie d'erreur.
 * Mesuré le 2026-08-20 sur Docker 29.6.1.
 *
 * Une console qui ne surveillerait que `stderr` ne verrait rien et prendrait
 * l'échec pour un shell ouvert et muet — donc laisserait une fenêtre noire dont
 * il faut deviner pourquoi elle est vide.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  sonderShell, classer, premierChemin, sondage, ouverture, ETATS,
  SHELL_TROUVE, SANS_SHELL, CONTENEUR_ARRETE, CONTENEUR_INCONNU,
  SSHD_MUET, INDETERMINE,
} from './shell-conteneur.js';

const SPARK = { name: 'helo', ipv4_address: '10.77.0.17',
                incus_name: 'helo', state: 'running' };
const TUNNEL = { jumpArgs: () => ['-J', 'ubuntu@203.0.113.10:22'] };

const ABSENT = 'OCI runtime exec failed: exec failed: unable to start container '
  + 'process: exec: "bash": executable file not found in $PATH';

function fauxSsh(reponses) {
  const vus = [];
  const spawnFn = (programme, args) => {
    const e = new EventEmitter();
    e.stdout = new EventEmitter();
    e.stderr = new EventEmitter();
    vus.push({ programme, args });
    const r = reponses[vus.length - 1] ?? { code: 0, sortie: '' };
    setImmediate(() => {
      if (r.sortie) e.stdout.emit('data', Buffer.from(r.sortie));
      if (r.erreurs) e.stderr.emit('data', Buffer.from(r.erreurs));
      e.emit('close', r.code);
    });
    return e;
  };
  return { spawnFn, vus };
}

// --- LE POINT QUI DÉCIDE : le 127 est sur STDOUT ---------------------------

test('un binaire manquant est reconnu alors que stderr est VIDE', () => {
  // MESURÉ : `docker exec c bash` sur une image sans bash rend 127, et écrit sur
  // la SORTIE STANDARD. Ne lire que stderr ferait conclure « tout va bien ».
  assert.equal(classer(127, ABSENT, ''), SANS_SHELL);
  assert.equal(classer(127, '', ''), SANS_SHELL);
  // …et l'écran ne présente pas cela comme une panne.
  assert.match(ETATS[SANS_SHELL].detail, /distroless/);
  assert.match(ETATS[SANS_SHELL].detail, /pas une panne/);
});

test('un code 0 SANS chemin est un conteneur sans shell, pas un succès', () => {
  // `command -v bash || command -v sh` peut rendre 0 en n'imprimant rien selon
  // le shell hôte. Prendre cela pour un succès ouvrirait sur rien.
  assert.equal(classer(0, ''), SANS_SHELL);
  assert.equal(classer(0, '\n  \n'), SANS_SHELL);
  assert.equal(classer(0, '/bin/sh\n'), SHELL_TROUVE);
});

// --- Les trois refus, chacun nommé (§14.5) ---------------------------------

test('un conteneur ARRÊTÉ et un conteneur DISPARU ne se confondent pas', () => {
  // MESURÉ : les deux rendent 1. Seul le texte les sépare, et ils n'appellent
  // pas le même geste — l'un se démarre, l'autre n'existe plus.
  assert.equal(classer(1, '', 'Error response from daemon: container '
    + 'edd360a7a4d9 is not running'), CONTENEUR_ARRETE);
  assert.equal(classer(1, '', 'Error response from daemon: No such container: '
    + 'parti'), CONTENEUR_INCONNU);
  assert.match(ETATS[CONTENEUR_ARRETE].detail, /Démarrez-le/);
  assert.match(ETATS[CONTENEUR_INCONNU].detail, /n’existe plus/);
});

test('« disparu » l’emporte sur « arrêté » quand les deux textes se croisent', () => {
  // « No such container » est plus précis. Dire « arrêté » d'un conteneur
  // supprimé enverrait cliquer « Démarrer » sur ce qui n'existe pas.
  assert.equal(classer(1, '', 'No such container: x — container is not running'),
               CONTENEUR_INCONNU);
});

test('l’IDENTIFIANT que Docker rend n’est jamais montré à l’écran (§14.7)', () => {
  // MESURÉ : le message d'un conteneur arrêté nomme l'ID long, pas le nom. Il
  // n'apprendrait rien à personne.
  assert.ok(!/[0-9a-f]{12,}/.test(ETATS[CONTENEUR_ARRETE].detail));
  assert.ok(!/[0-9a-f]{12,}/.test(ETATS[CONTENEUR_ARRETE].titre));
});

test('un échec de ssh est le cas du §37.2, pas un diagnostic de conteneur', () => {
  assert.equal(classer(255, '', 'ssh: connect to host 10.77.0.17 port 22: '
    + 'Connection refused'), SSHD_MUET);
  assert.equal(classer(255, '', 'kex_exchange_identification: banner'), INDETERMINE);
});

test('un échec NON RECONNU n’est pas qualifié', () => {
  // §37.3.1 : conclure sur un doute reviendrait à conclure toujours.
  assert.equal(classer(125, '', 'driver failed'), INDETERMINE);
  assert.match(ETATS[INDETERMINE].detail, /ne conclut pas/);
});

// --- Les commandes -----------------------------------------------------------

test('le sondage préfère bash, accepte sh, et n’emploie pas « which »', () => {
  const c = sondage('web');
  assert.match(c, /command -v bash \|\| command -v sh/);
  // `which` n'existe pas dans toutes les images : le sondage échouerait pour
  // une raison qui n'a rien à voir avec la présence d'un shell.
  assert.ok(!/which/.test(c));
  assert.ok(c.indexOf('bash') < c.indexOf('|| command -v sh'), 'bash d’abord');
});

test('l’ouverture emploie -it, sans quoi il n’y a pas de terminal', () => {
  assert.match(ouverture('web', '/bin/bash'), /docker exec -it/);
  assert.match(ouverture('web', '/bin/bash'), /'\/bin\/bash'/);
});

test('le nom ET le shell sont CITÉS avant de traverser un ssh', () => {
  // Le shell vient de la sortie d'une image du LOCATAIRE : il traverse deux
  // shells, et on ne suppose pas qu'une valeur est sûre parce qu'on l'a lue.
  assert.match(sondage("; rm -rf /"), /'; rm -rf \/'/);
  assert.match(ouverture('web', "; rm -rf /"), /'; rm -rf \/'/);
});

test('seul un CHEMIN ABSOLU est retenu comme shell', () => {
  // Lancer une ligne quelconque reviendrait à exécuter ce qu'une image aurait
  // écrit sur sa sortie.
  assert.equal(premierChemin('/bin/bash\n'), '/bin/bash');
  assert.equal(premierChemin('bash: not found\n/bin/sh\n'), '/bin/sh');
  assert.equal(premierChemin('bash\n'), null, 'un nom nu n’est pas un chemin');
  assert.equal(premierChemin('rm -rf /\n'), null);
  assert.equal(premierChemin(''), null);
});

// --- Le sondage complet -----------------------------------------------------

test('le sondage passe par SSH, avec le rebond du tunnel (§37.2)', async () => {
  const { spawnFn, vus } = fauxSsh([{ code: 0, sortie: '/bin/bash\n' }]);
  const vu = await sonderShell({ tunnel: TUNNEL, spark: SPARK, nom: 'helo-web-1',
                                 spawn: spawnFn });
  assert.equal(vus[0].programme, 'ssh');
  assert.ok(vus[0].args.includes('-J'));
  assert.ok(vus[0].args.includes('root@10.77.0.17'));
  assert.equal(vu.state, SHELL_TROUVE);
  assert.equal(vu.shell, '/bin/bash');
});

test('sh est retenu quand bash manque', async () => {
  const { spawnFn } = fauxSsh([{ code: 0, sortie: '/bin/sh\n' }]);
  const vu = await sonderShell({ tunnel: TUNNEL, spark: SPARK, nom: 'web',
                                 spawn: spawnFn });
  assert.equal(vu.shell, '/bin/sh');
});

test('un conteneur SANS shell ne rend AUCUN shell — pas un défaut', async () => {
  // Rendre « /bin/sh » par défaut ferait ouvrir une session sur rien, et
  // l'échec n'arriverait qu'après, sans dire pourquoi.
  const { spawnFn } = fauxSsh([{ code: 127, sortie: ABSENT }]);
  const vu = await sonderShell({ tunnel: TUNNEL, spark: SPARK, nom: 'web',
                                 spawn: spawnFn });
  assert.equal(vu.state, SANS_SHELL);
  assert.equal(vu.shell, null);
  assert.match(vu.titre, /pas de shell/);
});

test('un Spark ARRÊTÉ le dit, et ne sonde même pas', async () => {
  const { spawnFn, vus } = fauxSsh([]);
  const vu = await sonderShell({ tunnel: TUNNEL, spark: { ...SPARK, state: 'stopped' },
                                 nom: 'web', spawn: spawnFn });
  assert.match(vu.titre, /arrêté/);
  assert.equal(vus.length, 0);
  assert.equal(vu.shell, null);
});

test('sans conteneur nommé, rien n’est sondé', async () => {
  const { spawnFn, vus } = fauxSsh([]);
  const vu = await sonderShell({ tunnel: TUNNEL, spark: SPARK, spawn: spawnFn });
  assert.equal(vu.state, INDETERMINE);
  assert.equal(vus.length, 0);
});
