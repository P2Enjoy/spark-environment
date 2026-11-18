/**
 * @verifies docs/BACKLOG.md#SPK-181 · docs/DAT.md §73.2 (validation contre la
 *           liste, script fermé, issue lue sur le marqueur, verrou nommé, une
 *           application à la fois, l'issue transmise au journal)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { APPLICATION_SCRIPT, Applications, ApplicationRefusee, executerApplication,
         lireIssue, sshArgs, validerPaquets } from './forge-paquets.js';

const EN_ATTENTE = new Set(['nano', 'openssl']);
const SERVEUR = { name: 'spark-010', kind: 'ssh', host: '203.0.113.10', user: 'ubuntu', port: 22 };

test('le script fermé passe le VRAI analyseur sh, et ne prend que ses arguments', () => {
  const dossier = mkdtempSync(join(tmpdir(), 'paquets-'));
  writeFileSync(join(dossier, 's.sh'), APPLICATION_SCRIPT);
  execFileSync('sh', ['-n', join(dossier, 's.sh')]);
  assert.match(APPLICATION_SCRIPT, /apt-get install -y --only-upgrade -o Dpkg::Options::=--force-confold/);
  assert.match(APPLICATION_SCRIPT, /-o DPkg::Lock::Timeout=0 "\$@"/);
  assert.match(APPLICATION_SCRIPT, /DEBIAN_FRONTEND=noninteractive/);
  assert.doesNotMatch(APPLICATION_SCRIPT, /reboot|shutdown/, 'jamais de redémarrage');
});

test('seuls des noms de paquets EN ATTENTE passent', () => {
  assert.deepEqual(validerPaquets(['nano', 'openssl', 'nano'], EN_ATTENTE), ['nano', 'openssl']);
  for (const demande of [[], 'nano', ['vim'], ['-o', 'x'], ['nano;reboot'], ['Nano'],
                         Array.from({ length: 501 }, () => 'nano')]) {
    assert.throws(() => validerPaquets(demande, EN_ATTENTE),
                  (e) => e instanceof ApplicationRefusee && e.status === 422, JSON.stringify(demande).slice(0, 40));
  }
});

test('OpenSSH ne reçoit que la destination, sh -s -- et les noms', () => {
  assert.deepEqual(sshArgs(SERVEUR, ['nano']).slice(-5), ['ubuntu@203.0.113.10', 'sh', '-s', '--', 'nano']);
});

test('l’issue se lit sur le marqueur : terminée, occupée, sans droit, échec', () => {
  assert.equal(lireIssue('Setting up nano\nmarqueur=code:0\n').etat, 'terminee');
  const occupe = lireIssue('E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 1234\nmarqueur=code:100');
  assert.deepEqual([occupe.etat, occupe.motif, occupe.code], ['echec', 'occupe', 100]);
  assert.equal(lireIssue('marqueur=sans_droit').motif, 'sans_droit');
  assert.equal(lireIssue('E: seteuid failed\nmarqueur=code:100').motif, 'apt');
  assert.equal(lireIssue('<html>', 255).etat, 'echec', 'sans marqueur, jamais un succès');
  const longue = Array.from({ length: 100 }, (_, i) => `ligne ${i}`).join('\n') + '\nmarqueur=code:0';
  assert.equal(lireIssue(longue).sortie.split('\n').length, 40);
});

test('le doublon reçoit le script sur stdin et les paquets en arguments', async () => {
  const issue = await executerApplication(SERVEUR, ['nano', 'openssl'], {
    doublon: 'cat >/dev/null; printf "reçu %s\\n" "$@"; printf "marqueur=code:0\\n"' });
  assert.equal(issue.etat, 'terminee');
  assert.match(issue.sortie, /reçu nano\nreçu openssl/);
});

test('une application à la fois par serveur ; l’issue passe à fin()', async () => {
  const fins = [];
  let liberer;
  const apps = new Applications({
    executer: () => new Promise((r) => { liberer = () => r({ etat: 'terminee', motif: null, code: 0, sortie: 'ok' }); }),
    fin: (serveur, final) => fins.push([serveur.name, final.etat]),
  });
  const demande = [];
  const etat = await apps.lancer(SERVEUR, ['nano'], { avant: async () => demande.push('inscrite') });
  assert.equal(etat.etat, 'en_cours');
  await assert.rejects(apps.lancer(SERVEUR, ['openssl']), (e) => e.status === 409);
  assert.deepEqual(demande, ['inscrite'], 'un refus 409 n’inscrit rien');
  liberer();
  await apps.dernierTravail;
  assert.equal(apps.etat('spark-010').etat, 'terminee');
  assert.deepEqual(fins, [['spark-010', 'terminee']]);
  assert.deepEqual(apps.etat('autre'), { etat: 'aucune' });
});

test('une demande qui ne s’inscrit pas n’est pas lancée', async () => {
  let lance = false;
  const apps = new Applications({ executer: async () => { lance = true; return { etat: 'terminee' }; } });
  await assert.rejects(apps.lancer(SERVEUR, ['nano'], { avant: async () => { throw new Error('journal'); } }));
  assert.equal(lance, false);
  assert.equal(apps.etat('spark-010').etat, 'aucune');
});
