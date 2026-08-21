/**
 * @verifies docs/BACKLOG.md#SPK-45 · docs/DAT.md §37.7 (la décision et le gel),
 *           §37.7.1 (les codes, mesurés), §37.7.3 (où le refus est rendu),
 *           §37.7.4 (les quatre actions d'audit) · docs/DESIGN_SYSTEM.md §6.23
 *
 * Ce que ces preuves gardent, et c'est LE point de l'unité : **le code `1` a
 * deux causes, et seule la sortie d'erreur les sépare**. Mesuré le 2026-08-20
 * sur Docker 29.6.1 — « No such container » quand il a disparu, « is not
 * running » quand `kill` tombe sur un conteneur déjà arrêté.
 *
 * Les confondre annoncerait une disparition à propos d'un conteneur simplement
 * arrêté, et enverrait chercher une suppression qui n'a jamais eu lieu.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  agir, classer, messageEchec, GESTES, ETATS, DELAI_ARRET, DELAI_SSH,
  ABOUTI, DEJA_ARRETE, CONTENEUR_INCONNU, ECHEC, SSHD_MUET, INJOIGNABLE,
} from './gestes-docker.js';

const SPARK = { name: 'helo', ipv4_address: '10.77.0.17',
                incus_name: 'helo', state: 'running', protected: false };
const TUNNEL = { jumpArgs: () => ['-J', 'ubuntu@203.0.113.10:22'] };

function fauxSsh(reponses) {
  const vus = [];
  const spawnFn = (programme, args) => {
    const e = new EventEmitter();
    e.stdout = new EventEmitter();
    e.stderr = new EventEmitter();
    e.kill = () => {};
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

// --- LE POINT QUI DÉCIDE : la sortie d'erreur, pas le code ------------------

test('le code 1 a DEUX causes, et seule la sortie d’erreur les sépare', () => {
  // MESURÉ : les deux rendent 1. Les confondre annoncerait une disparition à
  // propos d'un conteneur simplement arrêté.
  assert.equal(classer(1, 'Error response from daemon: No such container: web'),
               CONTENEUR_INCONNU);
  assert.equal(classer(1, 'Error response from daemon: cannot kill container: '
                        + 'web: container web is not running'), DEJA_ARRETE);
  // …et l'écran ne dit pas la même chose.
  assert.notEqual(ETATS[CONTENEUR_INCONNU].titre, ETATS[DEJA_ARRETE].titre);
  assert.match(ETATS[DEJA_ARRETE].detail, /rien à tuer/);
  assert.match(ETATS[CONTENEUR_INCONNU].detail, /n’existe plus/);
});

test('un échec NON RECONNU n’est pas qualifié', () => {
  // Conclure sur un doute reviendrait à conclure toujours (§37.3.1). On rend ce
  // que Docker a dit, sans le traduire en un diagnostic qu'on n'a pas.
  assert.equal(classer(1, 'Error response from daemon: driver failed'), ECHEC);
  assert.equal(classer(125, ''), ECHEC);
});

test('un échec de ssh est le cas du §37.2, pas un diagnostic Docker', () => {
  assert.equal(classer(255, 'ssh: connect to host 10.77.0.17 port 22: '
                          + 'Connection refused'), SSHD_MUET);
  assert.equal(classer(255, 'kex_exchange_identification: banner'), INJOIGNABLE);
  assert.match(ETATS[SSHD_MUET].detail, /Terminal/);
  // Un geste qui n'est PAS parti doit le dire : sinon on le rejoue à l'aveugle.
  assert.match(ETATS[INJOIGNABLE].detail, /n’est pas parti/);
});

test('un geste ABOUTI se lit sur le code 0, pour les quatre gestes', () => {
  // MESURÉ : les quatre rendent 0 et impriment le nom du conteneur.
  assert.equal(classer(0, ''), ABOUTI);
});

test('le message d’un échec est celui de DOCKER, débarrassé de son préfixe', () => {
  assert.equal(messageEchec('Error response from daemon: driver failed\n'),
               'driver failed');
  assert.match(messageEchec(''), /rien dit de plus/);
});

// --- Les quatre gestes, et ce qu'ils promettent -----------------------------

test('les quatre gestes existent, chacun avec SON action de journal', () => {
  // §37.7.4 : quatre actions et non une, pour que « combien en a-t-on tués »
  // se réponde par un filtre et non par la lecture des charges.
  const actions = Object.values(GESTES).map((g) => g.action);
  assert.deepEqual(actions.sort(), [
    'spark.container_kill', 'spark.container_restart',
    'spark.container_start', 'spark.container_stop'].sort());
  assert.equal(new Set(actions).size, 4, 'aucune action n’est partagée');
});

test('chaque confirmation NOMME le conteneur et l’effet (§6.23)', () => {
  for (const [cle, geste] of Object.entries(GESTES)) {
    const effet = geste.effet('crm-web-1');
    assert.match(effet, /crm-web-1/, cle);
    // Jamais un « êtes-vous sûr » : l'effet est décrit.
    assert.ok(!/sûr|confirmer/i.test(effet), cle);
    assert.ok(effet.length > 30, `${cle} : l’effet doit être décrit`);
  }
});

test('« tuer » est le SEUL destructif', () => {
  // Distinguer visuellement « arrêter » de « tuer » est le seul moyen d'empêcher
  // qu'on les confonde au moment où l'on est pressé — donc où l'on tue.
  const destructifs = Object.entries(GESTES)
    .filter(([, g]) => g.destructif).map(([k]) => k);
  assert.deepEqual(destructifs, ['kill']);
  assert.match(GESTES.kill.effet('web'), /IMMÉDIATEMENT/);
  assert.match(GESTES.kill.effet('web'), /perdu/);
});

test('le délai d’arrêt est EXPLICITE dans la commande', () => {
  // Laissé implicite, il serait celui de la version de Docker du locataire —
  // une valeur que le produit ne choisit pas et qui peut changer sous lui.
  assert.match(GESTES.stop.commande('web'), new RegExp(`-t ${DELAI_ARRET}\\b`));
  assert.match(GESTES.restart.commande('web'), new RegExp(`-t ${DELAI_ARRET}\\b`));
  // Et l'écran l'annonce, plutôt que de laisser découvrir l'attente.
  assert.match(GESTES.stop.effet('web'), new RegExp(`${DELAI_ARRET} secondes`));
});

test('le délai du ssh est PLUS LONG que celui de l’arrêt', () => {
  // Sinon la console abandonnerait un arrêt qui se déroule normalement — un
  // conteneur a le droit de prendre ses dix secondes.
  assert.ok(DELAI_SSH > DELAI_ARRET);
});

test('un nom de conteneur est CITÉ avant de traverser un ssh', () => {
  for (const geste of Object.values(GESTES)) {
    assert.match(geste.commande("; rm -rf /"), /'; rm -rf \/'/);
  }
});

// --- Le gel : refusé AVANT toute connexion (§37.7.3) ------------------------

test('un Spark PROTÉGÉ refuse le geste sans ouvrir la moindre connexion', () => {
  // Docker n'a aucune raison de refuser : la protection n'existe pas chez le
  // locataire. C'est l'écart assumé du §37.7 — un garde-fou, pas un contrôle.
  const { spawnFn, vus } = fauxSsh([]);
  return agir({ tunnel: TUNNEL, spark: { ...SPARK, protected: true },
                nom: 'web', geste: 'stop', spawn: spawnFn })
    .then((vu) => {
      assert.equal(vus.length, 0, 'aucun ssh n’est parti');
      assert.equal(vu.refus, 'protege');
      assert.match(vu.titre, /protégé/);
      // Le refus NOMME la levée : un refus qui ne dit pas comment avancer se
      // contourne au jugé.
      assert.match(vu.detail, /Levez la protection/);
      assert.match(vu.detail, /Infos/);
      // …et il rappelle que la lecture, elle, reste entière (§37.7).
      assert.match(vu.detail, /lecture/);
    });
});

test('le gel refuse les QUATRE gestes, pas seulement le destructif', async () => {
  for (const geste of Object.keys(GESTES)) {
    const { spawnFn, vus } = fauxSsh([]);
    const vu = await agir({ tunnel: TUNNEL, spark: { ...SPARK, protected: true },
                            nom: 'web', geste, spawn: spawnFn });
    assert.equal(vu.refus, 'protege', geste);
    assert.equal(vus.length, 0, geste);
  }
});

test('un Spark ARRÊTÉ le dit, et n’essaie même pas', async () => {
  const { spawnFn, vus } = fauxSsh([]);
  const vu = await agir({ tunnel: TUNNEL, spark: { ...SPARK, state: 'stopped' },
                          nom: 'web', geste: 'start', spawn: spawnFn });
  assert.equal(vu.state, INJOIGNABLE);
  assert.match(vu.titre, /arrêté/);
  assert.equal(vus.length, 0);
});

// --- Le chemin complet ------------------------------------------------------

test('le geste passe par SSH, avec le rebond du tunnel (§37.2)', async () => {
  const { spawnFn, vus } = fauxSsh([{ code: 0, sortie: 'helo-web-1\n' }]);
  const vu = await agir({ tunnel: TUNNEL, spark: SPARK, nom: 'helo-web-1',
                          geste: 'stop', spawn: spawnFn });
  assert.equal(vus[0].programme, 'ssh');
  assert.ok(vus[0].args.includes('-J'));
  assert.ok(vus[0].args.includes('root@10.77.0.17'));
  assert.match(vus[0].args.at(-1), /docker info/,
    'le socket rootless est vérifié avant de choisir le démon');
  assert.match(vus[0].args.at(-1), /exec docker stop -t 10 'helo-web-1'/,
    'le geste ne peut être rejoué sur Docker root après un échec rootless');
  assert.equal(vu.state, ABOUTI);
  assert.equal(vu.action, 'spark.container_stop');
  assert.equal(vu.name, 'helo-web-1');
});

test('« start » sur un conteneur DÉJÀ EN MARCHE aboutit', async () => {
  // MESURÉ : idempotent, code 0. Faire échouer un geste parce qu'il n'avait
  // plus rien à faire produirait une erreur là où il ne s'est rien passé.
  const { spawnFn } = fauxSsh([{ code: 0, sortie: 'helo-web-1\n' }]);
  const vu = await agir({ tunnel: TUNNEL, spark: SPARK, nom: 'helo-web-1',
                          geste: 'start', spawn: spawnFn });
  assert.equal(vu.state, ABOUTI);
});

test('« kill » sur un conteneur déjà arrêté n’est pas une PANNE', async () => {
  // MESURÉ : le seul geste non idempotent. L'état voulu est pourtant atteint.
  const { spawnFn } = fauxSsh([{ code: 1, erreurs:
    'Error response from daemon: cannot kill container: web: container web is not running' }]);
  const vu = await agir({ tunnel: TUNNEL, spark: SPARK, nom: 'web',
                          geste: 'kill', spawn: spawnFn });
  assert.equal(vu.state, DEJA_ARRETE);
  assert.ok(!/panne|erreur/i.test(vu.detail));
});

test('un geste sur un conteneur DISPARU est dit, sans crier à la panne', async () => {
  const { spawnFn } = fauxSsh([{ code: 1, erreurs:
    'Error response from daemon: No such container: parti' }]);
  const vu = await agir({ tunnel: TUNNEL, spark: SPARK, nom: 'parti',
                          geste: 'restart', spawn: spawnFn });
  assert.equal(vu.state, CONTENEUR_INCONNU);
  assert.match(vu.titre, /a disparu/);
});

test('un geste INCONNU est refusé sans rien lancer', async () => {
  const { spawnFn, vus } = fauxSsh([]);
  const vu = await agir({ tunnel: TUNNEL, spark: SPARK, nom: 'web',
                          geste: 'supprimer', spawn: spawnFn });
  assert.equal(vu.refus, 'geste_inconnu');
  assert.equal(vus.length, 0);
});
