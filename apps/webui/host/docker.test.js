/**
 * @verifies docs/BACKLOG.md#SPK-44 · docs/DAT.md §37.6 (l'onglet en lecture),
 *           §37.6 bis (les absences se distinguent par le CODE de sortie),
 *           §37.2 (le chemin normal) · docs/DESIGN_SYSTEM.md §6.13, §14.5, §14.6
 *
 * Ce que ces preuves gardent : **c'est le code de sortie qui distingue les
 * absences, pas la sortie**, qui est vide dans deux cas sur trois. Mesuré sur un
 * vrai Docker le 2026-08-20 — `127` quand la commande est introuvable, `1` quand
 * le démon ne répond pas, `0` avec zéro ligne quand tout va bien et qu'il n'y a
 * rien.
 *
 * Les deux premiers se confondent à l'œil et n'appellent pas le même geste :
 * l'un s'amorce, l'autre se redémarre.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  analyser, attacher, classer, relever, ETATS, INVENTAIRE, MESURES,
  OK, SANS_CONTENEUR, DOCKER_ABSENT, MOTEUR_MUET, SSHD_MUET, INJOIGNABLE,
  analyserInspection, analyserReseaux, analyserMontages, analyserJournaux,
  inspecter, journaux, quoter, inspecterConteneur, lireJournaux,
  CONTENEUR_INCONNU, doublonPour,
} from './docker.js';

const SPARK = { name: 'helo', ipv4_address: '10.77.0.17',
                incus_name: 'helo', state: 'running' };
const TUNNEL = { jumpArgs: () => ['-J', 'ubuntu@203.0.113.10:22'] };

const LIGNE = 'abc123\thelo-web-1\trunning\tUp 2 minutes\tnginx:alpine\t'
  + '0.0.0.0:8080->80/tcp, :::8080->80/tcp';

/** Un `ssh` doublé : chaque appel rend le code et la sortie qu'on lui donne. */
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
      // `close` et non `exit` : c'est celui que le module attend, parce que
      // `exit` peut précéder le drainage de stdout (voir docker.js).
      e.emit('close', r.code);
    });
    return e;
  };
  return { spawnFn, vus };
}

// --- LE POINT QUI DÉCIDE : le code de sortie, pas la sortie -----------------

test('docker INTROUVABLE et moteur MUET ne se confondent pas', () => {
  // Mesuré : `127` quand la commande n'existe pas, `1` quand elle existe et que
  // le démon ne répond pas. Les deux rendent une sortie vide.
  assert.equal(classer(127, ''), DOCKER_ABSENT);
  assert.equal(classer(1, ''), MOTEUR_MUET);
  // …et l'écran ne dit pas la même chose, parce que le geste n'est pas le même.
  assert.match(ETATS[DOCKER_ABSENT].detail, /amorçage/i);
  assert.match(ETATS[MOTEUR_MUET].detail, /redémarrer/i);
  assert.notEqual(ETATS[DOCKER_ABSENT].titre, ETATS[MOTEUR_MUET].titre);
});

test('zéro conteneur est un état NORMAL, pas un tableau vide', () => {
  // §6.13 et §14.5 : une cellule fraîchement amorcée n'a rien qui tourne, et ce
  // n'est ni une panne ni une absence de données.
  assert.equal(classer(0, ''), SANS_CONTENEUR);
  assert.equal(classer(0, '\n  \n'), SANS_CONTENEUR);
  assert.match(ETATS[SANS_CONTENEUR].detail, /état normal/i);
});

test('un ssh en échec rend le cas du §37.2, pas un diagnostic Docker', () => {
  // `ssh` rend 255 quand c'est LUI qui a échoué. Conclure « Docker absent »
  // enverrait amorcer un Spark dont le problème est ailleurs.
  assert.equal(classer(255, '', 'ssh: connect to host 10.77.0.17 port 22: Connection refused'),
               SSHD_MUET);
  assert.match(ETATS[SSHD_MUET].detail, /Terminal/);
});

test('un échec ssh NON RECONNU ne se déclare pas « sshd muet »', () => {
  // Le même principe qu'au §37.3.1 : conclure sur un doute reviendrait à
  // conclure toujours.
  assert.equal(classer(255, '', 'kex_exchange_identification: banner'), INJOIGNABLE);
  assert.match(ETATS[INJOIGNABLE].detail, /n’est pas établie/);
});

test('des conteneurs présents rendent « ok »', () => {
  assert.equal(classer(0, LIGNE), OK);
});

// --- L'inventaire, et ce qu'il refuse d'inventer -----------------------------

test('une ligne d’inventaire se découpe en six champs', () => {
  const [c] = analyser(LIGNE);
  assert.equal(c.id, 'abc123');
  assert.equal(c.name, 'helo-web-1');
  assert.equal(c.state, 'running');
  assert.equal(c.status, 'Up 2 minutes');
  assert.equal(c.image, 'nginx:alpine');
  assert.match(c.ports, /8080->80\/tcp/);
});

test('un conteneur SANS port publié ne casse pas le découpage', () => {
  // Le champ `Ports` est vide, ce qui donne une ligne à cinq séparateurs.
  const [c] = analyser('def456\tbase\texited\tExited (0) 1 hour ago\tpostgres:16\t');
  assert.equal(c.name, 'base');
  assert.equal(c.state, 'exited');
  assert.equal(c.ports, '');
});

test('un conteneur ARRÊTÉ est listé — c’est ce qu’on vient chercher', () => {
  // `docker ps -a`, pas `docker ps` : une pile qui ne répond plus a justement
  // des conteneurs arrêtés (§37.6 bis).
  assert.match(INVENTAIRE, /docker ps -a\b/);
  const noms = analyser(`${LIGNE}\ndef456\tbase\texited\tExited (0)\tpostgres:16\t`)
    .map((c) => c.state);
  assert.deepEqual(noms, ['running', 'exited']);
});

test('une ligne MAL FORMÉE est ignorée, jamais devinée', () => {
  assert.deepEqual(analyser('pas-une-ligne-tabulee'), []);
  assert.equal(analyser(`bruit\n${LIGNE}`).length, 1);
});

// --- Les mesures : absentes plutôt que nulles (§14.6) -----------------------

test('les mesures s’attachent par NOM', () => {
  const [c] = attacher(analyser(LIGNE),
                       'helo-web-1\t0.03%\t12.3MiB / 2GiB\t0.60%');
  assert.equal(c.cpu, '0.03%');
  assert.equal(c.memory, '12.3MiB / 2GiB');
  assert.equal(c.memoryPercent, '0.60%');
});

test('un conteneur SANS mesure n’en reçoit PAS une nulle', () => {
  // §14.6 : « pas mesuré » et « zéro » sont deux états différents. Une mesure
  // inventée à 0 % ferait croire à un conteneur au repos.
  const [c] = attacher(analyser(LIGNE), 'un-autre\t9%\t1MiB / 2GiB\t0.1%');
  assert.equal(c.cpu, undefined);
  assert.ok(!('memory' in c));
});

test('`docker stats` emploie --no-stream, sans quoi il ne rend jamais la main', () => {
  assert.match(MESURES, /--no-stream/);
});

// --- Le relevé complet ------------------------------------------------------

test('le relevé passe par SSH, avec le rebond du tunnel (§37.2)', async () => {
  const { spawnFn, vus } = fauxSsh([
    { code: 0, sortie: LIGNE },
    { code: 0, sortie: 'helo-web-1\t0.03%\t12.3MiB / 2GiB\t0.60%' },
  ]);
  const vu = await relever({ tunnel: TUNNEL, spark: SPARK, spawn: spawnFn });
  assert.equal(vus[0].programme, 'ssh');
  assert.ok(vus[0].args.includes('-J'), 'le rebond vient du tunnel');
  assert.ok(vus[0].args.includes('root@10.77.0.17'));
  assert.equal(vu.state, OK);
  assert.equal(vu.containers[0].cpu, '0.03%');
});

test('quand `docker stats` échoue, les conteneurs restent listés SANS mesure', async () => {
  // Ne pas avoir mesuré n'est pas une panne de Docker : l'inventaire a abouti.
  const { spawnFn } = fauxSsh([
    { code: 0, sortie: LIGNE },
    { code: 1, sortie: '', erreurs: 'boom' },
  ]);
  const vu = await relever({ tunnel: TUNNEL, spark: SPARK, spawn: spawnFn });
  assert.equal(vu.state, OK);
  assert.equal(vu.containers.length, 1);
  assert.equal(vu.containers[0].cpu, undefined);
});

test('un Spark ARRÊTÉ le dit, et n’essaie même pas', async () => {
  const { spawnFn, vus } = fauxSsh([]);
  const vu = await relever({ tunnel: TUNNEL, spark: { ...SPARK, state: 'stopped' },
                             spawn: spawnFn });
  assert.match(vu.titre, /arrêté/);
  assert.deepEqual(vus, [], 'aucune commande n’est lancée vers une cellule à l’arrêt');
});

test('un Spark SANS CELLULE le dit aussi, dans ses propres termes', async () => {
  const { spawnFn, vus } = fauxSsh([]);
  const vu = await relever({ tunnel: TUNNEL, spark: { name: 'neuf' }, spawn: spawnFn });
  assert.match(vu.detail, /pas encore de cellule/);
  assert.deepEqual(vus, []);
});

test('le relevé n’exécute QUE des lectures', async () => {
  // L'unité est en lecture seule : aucun bouton, aucune écriture (SPK-44).
  for (const commande of [INVENTAIRE, MESURES]) {
    for (const interdit of ['docker run', 'docker rm', 'docker stop', 'docker start',
                            'docker exec', 'rm ', '>']) {
      assert.ok(!commande.includes(interdit), `${interdit} dans « ${commande} »`);
    }
  }
});

// --- SPK-44, tranche 2 · INSPECTER ET LIRE LES JOURNAUX (§37.6 ter) ---------

test('le nom rendu par Docker perd sa barre oblique de tête', () => {
  // MESURÉ : `.Name` revient « /spark-mesure ». Un nom qui n'est pas celui qu'on
  // a tapé fait douter de ce qu'on regarde.
  const vu = analyserInspection('/helo-web-1\trunning\t0\t2026-08-20T18:52:01Z\t\t0\tnginx:alpine');
  assert.equal(vu.name, 'helo-web-1');
});

test('le code de sortie n’existe QUE pour un conteneur arrêté', () => {
  // §14.6 : rendre 0 pour un conteneur en marche ferait croire qu'il s'est
  // terminé sans erreur.
  const marche = analyserInspection('/web\trunning\t0\t2026-08-20T18:52:01Z\t\t0\tnginx');
  assert.equal(marche.exitCode, null);
  assert.equal(marche.finishedAt, null);

  const arrete = analyserInspection(
    '/web\texited\t137\t2026-08-20T18:52:01Z\t2026-08-20T18:52:18Z\t2\tnginx');
  assert.equal(arrete.exitCode, 137);
  assert.equal(arrete.finishedAt, '2026-08-20T18:52:18Z');
  assert.equal(arrete.restarts, 2);
});

test('réseaux et montages se découpent en listes', () => {
  const r = analyserReseaux('helo_default\t172.18.0.2\nbridge\t172.17.0.2\n');
  assert.deepEqual(r, [{ name: 'helo_default', address: '172.18.0.2' },
                       { name: 'bridge', address: '172.17.0.2' }]);
  const m = analyserMontages('volume\thelo_data\t/var/lib/postgresql/data\trw\n');
  assert.equal(m[0].type, 'volume');
  assert.equal(m[0].destination, '/var/lib/postgresql/data');
  assert.equal(m[0].mode, 'rw');
});

test('un conteneur sans réseau ni montage rend des listes VIDES, pas nulles', () => {
  assert.deepEqual(analyserReseaux(''), []);
  assert.deepEqual(analyserMontages(''), []);
});

test('les horodatages des journaux sont rendus TELS QUELS', () => {
  // §37.6 ter : ce sont ceux du locataire. Les reformater dans le fuseau du
  // poste décalerait l'écran de ce qu'il lit dans son propre journal.
  const [l] = analyserJournaux('2026-08-20T18:52:01.555868713Z ligne 195');
  assert.equal(l.at, '2026-08-20T18:52:01.555868713Z');
  assert.equal(l.text, 'ligne 195');
});

test('une ligne SANS horodatage n’en reçoit pas un inventé', () => {
  const [l] = analyserJournaux('nginx: [alert] socketpair() failed');
  assert.equal(l.at, null);
  assert.match(l.text, /socketpair/);
});

test('les journaux sont BORNÉS, et la borne est dans la commande', () => {
  // Sans `--tail`, un conteneur bavard renvoie tout son historique par le
  // tunnel et l'écran devient inutilisable au moment où l'on en a besoin.
  assert.match(journaux('web'), /--tail 200/);
  assert.match(journaux('web', 50), /--tail 50/);
  // Une borne absurde retombe sur le défaut plutôt que de partir sans borne.
  assert.match(journaux('web', 0), /--tail 200/);
});

test('un nom de conteneur est CITÉ avant de traverser un ssh', () => {
  // Il vient de Docker, mais il traverse un shell distant : on ne suppose pas
  // qu'une valeur est sûre parce qu'on l'a lue quelque part.
  assert.equal(quoter('web'), "'web'");
  assert.equal(quoter("a'b"), "'a'\\''b'");
  assert.match(inspecter("; rm -rf /"), /'; rm -rf \/'/);
  assert.match(journaux("; rm -rf /"), /'; rm -rf \/'/);
});

test('un conteneur DISPARU est dit, et ce n’est pas une panne', async () => {
  // MESURÉ : `docker inspect` d'un conteneur inconnu rend 1. Le locataire a le
  // droit de le supprimer pendant qu'on le regarde.
  const { spawnFn } = fauxSsh([{ code: 1, sortie: '', erreurs: 'No such container' }]);
  const vu = await inspecterConteneur({ tunnel: TUNNEL, spark: SPARK,
                                        nom: 'parti', spawn: spawnFn });
  assert.equal(vu.state, CONTENEUR_INCONNU);
  assert.match(vu.titre, /a disparu/);
  assert.ok(!/panne|erreur/i.test(vu.detail));
});

test('l’identité survit à l’échec des listes', async () => {
  // Savoir qu'un conteneur est mort en 137 vaut mieux que rien.
  const { spawnFn } = fauxSsh([
    { code: 0, sortie: '/web\texited\t137\t2026-08-20T18:52:01Z\t2026-08-20T18:52:18Z\t0\tnginx' },
    { code: 1, sortie: '', erreurs: 'boom' },
    { code: 1, sortie: '', erreurs: 'boom' },
  ]);
  const vu = await inspecterConteneur({ tunnel: TUNNEL, spark: SPARK,
                                        nom: 'web', spawn: spawnFn });
  assert.equal(vu.exitCode, 137);
  assert.equal(vu.networks, null, 'une liste non lue est NULLE, pas vide');
  assert.equal(vu.mounts, null);
});

test('« truncated » est rendu, jamais déduit par l’écran', async () => {
  // Déduire de `lines.length === tail` marcherait aujourd'hui et mentirait le
  // jour où un conteneur a exactement `tail` lignes.
  const trois = Array.from({ length: 3 }, (_, i) => `2026-08-20T18:52:0${i}Z l${i}`).join('\n');
  const { spawnFn } = fauxSsh([{ code: 0, sortie: trois }]);
  const court = await lireJournaux({ tunnel: TUNNEL, spark: SPARK, nom: 'web',
                                     tail: 200, spawn: spawnFn });
  assert.equal(court.truncated, false);
  assert.equal(court.lines.length, 3);

  const plein = fauxSsh([{ code: 0, sortie: trois }]);
  const borne = await lireJournaux({ tunnel: TUNNEL, spark: SPARK, nom: 'web',
                                     tail: 3, spawn: plein.spawnFn });
  assert.equal(borne.truncated, true);
});

test('les journaux d’un conteneur disparu ne rendent pas une liste vide muette', async () => {
  const { spawnFn } = fauxSsh([{ code: 1, sortie: '', erreurs: 'No such container' }]);
  const vu = await lireJournaux({ tunnel: TUNNEL, spark: SPARK, nom: 'parti',
                                  spawn: spawnFn });
  assert.equal(vu.state, CONTENEUR_INCONNU);
  assert.match(vu.titre, /a disparu/);
  assert.deepEqual(vu.lines, []);
});

test('le doublon répond PAR GESTE, et « * » sert de défaut', () => {
  // La deuxième tranche a besoin qu'inspecter et lire les journaux ne rendent
  // pas la même chose, et que l'un échoue pendant que l'autre aboutit.
  const table = JSON.stringify({ ps: 'A', logs: 'B', '*': 'C' });
  assert.equal(doublonPour(table, INVENTAIRE), 'A');
  assert.equal(doublonPour(table, journaux('web')), 'B');
  assert.equal(doublonPour(table, inspecter('web')), 'C');
  assert.equal(doublonPour(table, MESURES), 'C');
  // Une chaîne simple répond à tout — c'est le doublon de la première tranche.
  assert.equal(doublonPour('printf x', INVENTAIRE), 'printf x');
  assert.equal(doublonPour(null, INVENTAIRE), null);
  // Sans réponse ni défaut, la VRAIE commande passe : un échec bruyant vaut
  // mieux qu'une sortie muette prise pour un relevé.
  assert.equal(doublonPour(JSON.stringify({ ps: 'A' }), journaux('web')), null);
});

test('un doublon passe par un shell, donc une sortie à espaces est possible', async () => {
  const { spawnFn, vus } = fauxSsh([{ code: 0, sortie: '' }]);
  await relever({ tunnel: TUNNEL, spark: SPARK, spawn: spawnFn,
                  doublon: "printf 'a b\\n'" });
  assert.equal(vus[0].programme, 'sh');
  assert.deepEqual(vus[0].args, ['-c', "printf 'a b\\n'", INVENTAIRE],
    'la VRAIE commande est passée en $0, sans quoi un doublon ne peut pas '
    + 'répondre selon le conteneur demandé');
});

test('une sortie ENCORE EN COURS n’est pas rendue tronquée', async () => {
  // MESURÉ le 2026-08-20 sur deux cents lignes de journal : `exit` arrive avant
  // que stdout ait fini d'être drainé, et le relevé perdait une trentaine de
  // lignes SANS RIEN DIRE. C'est le pire défaut possible pour un écran dont le
  // seul rôle est de rapporter. Ce doublon rejoue exactement cet ordre.
  const spawnFn = () => {
    const e = new EventEmitter();
    e.stdout = new EventEmitter();
    e.stderr = new EventEmitter();
    setImmediate(() => {
      e.stdout.emit('data', Buffer.from('2026-08-20T18:52:01Z début\n'));
      e.emit('exit', 0);                       // le processus est terminé…
      setImmediate(() => {                     // …mais stdout n'est pas drainé.
        e.stdout.emit('data', Buffer.from('2026-08-20T18:52:02Z fin\n'));
        e.emit('close', 0);
      });
    });
    return e;
  };
  const vu = await lireJournaux({ tunnel: TUNNEL, spark: SPARK, nom: 'web',
                                  spawn: spawnFn });
  assert.equal(vu.lines.length, 2, 'la ligne arrivée après « exit » est gardée');
  assert.equal(vu.lines.at(-1).text, 'fin');
});
