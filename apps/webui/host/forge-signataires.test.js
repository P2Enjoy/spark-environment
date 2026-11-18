/**
 * @verifies docs/BACKLOG.md#SPK-172 · docs/DAT.md §70.3 (la console pose sa
 *           ligne à la connexion ; rien du navigateur ; l'échec est un état) ·
 *           §36.10.8 (ne pas pouvoir signer n'empêche aucun geste)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SIGNATAIRES_SCRIPT, ETATS, argumentsDe, lireResultat, poserSignataires,
         sshArgs } from './forge-signataires.js';

const CLE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGp0cmVzLWNvdXJ0ZS1jbGUtZGUtdGVzdA resp@poste';
const SERVEUR = { name: 'spark-010', kind: 'ssh', host: '203.0.113.10', user: 'ubuntu',
                  port: 22, signingKey: '/poste/id_ed25519.pub' };

/** Un `ssh` doublé : il garde ses arguments et le script reçu, puis répond. */
function fauxSsh(reponse, code = 0) {
  const vu = {};
  const spawnFn = (commande, args) => {
    vu.commande = commande; vu.args = args;
    const enfant = new EventEmitter();
    enfant.stdout = new EventEmitter();
    enfant.stdin = { end: (script) => {
      vu.script = script;
      setImmediate(() => { enfant.stdout.emit('data', reponse); enfant.emit('close', code); });
    } };
    return enfant;
  };
  return { vu, spawnFn };
}

test('le script fermé passe le VRAI analyseur sh', () => {
  const dossier = mkdtempSync(join(tmpdir(), 'signataires-'));
  writeFileSync(join(dossier, 's.sh'), SIGNATAIRES_SCRIPT);
  execFileSync('sh', ['-n', join(dossier, 's.sh')]);
  assert.match(SIGNATAIRES_SCRIPT, /-m sparkd\.signataires poser --principal "\$principal" --cle "\$cle"/);
  assert.doesNotMatch(SIGNATAIRES_SCRIPT, /__DOLLAR__/);
});

test('les arguments sont le principal et les deux champs de la clé, sans commentaire', () => {
  assert.deepEqual(argumentsDe(SERVEUR, CLE),
    ['console/spark-010', 'ssh-ed25519', CLE.split(' ')[1]]);
});

test('une clé ou un nom hors forme ne part pas vers la Forge', () => {
  for (const cle of ['', 'AAAA', 'ssh-dss AAAA', 'ssh-ed25519 AA;reboot', 'ssh-ed25519 $(id)']) {
    assert.equal(argumentsDe(SERVEUR, cle), null, cle);
  }
  for (const name of ['', 'A b', 'x;y', 'a,b']) {
    assert.equal(argumentsDe({ ...SERVEUR, name }, CLE), null, name);
  }
});

test('OpenSSH ne reçoit que la destination, sh -s et trois arguments validés', () => {
  const args = sshArgs(SERVEUR, ['console/spark-010', 'ssh-ed25519', 'AAAA']);
  assert.deepEqual(args.slice(-7), ['ubuntu@203.0.113.10', 'sh', '-s', '--',
                                    'console/spark-010', 'ssh-ed25519', 'AAAA']);
  assert.ok(args.includes('BatchMode=yes'));
  assert.deepEqual(sshArgs({ kind: 'alias', sshHost: 'forge' }, ['a', 'b', 'c']).slice(4),
                   ['forge', 'sh', '-s', '--', 'a', 'b', 'c']);
});

test('la pose rend l’état que la Forge a dit', async () => {
  const { vu, spawnFn } = fauxSsh('{"etat": "pose", "fichier": "/etc/sparkd/allowed_signers"}\n');
  const resultat = await poserSignataires(SERVEUR, { spawnFn, lire: async () => `${CLE}\n` });
  assert.deepEqual(resultat, { etat: 'pose' });
  assert.equal(vu.commande, 'ssh');
  assert.equal(vu.script, SIGNATAIRES_SCRIPT, 'seul le script fermé est envoyé');
  assert.deepEqual(vu.args.slice(-3), ['console/spark-010', 'ssh-ed25519', CLE.split(' ')[1]]);
});

test('chaque refus de la Forge reste un ÉTAT, jamais une exception', async () => {
  for (const etat of ['deja', 'remplace', 'sans_droit', 'sans_sparkd', 'sparkd_ancien']) {
    const { spawnFn } = fauxSsh(`{"etat":"${etat}"}\n`);
    assert.equal((await poserSignataires(SERVEUR, { spawnFn, lire: async () => CLE })).etat, etat);
  }
  const { spawnFn: muet } = fauxSsh('', 255);
  assert.equal((await poserSignataires(SERVEUR, { spawnFn: muet, lire: async () => CLE })).etat, 'echec');
  const { spawnFn: bavard } = fauxSsh('<html>injecté</html>\n');
  assert.equal((await poserSignataires(SERVEUR, { spawnFn: bavard, lire: async () => CLE })).etat, 'echec');
});

test('sans clé de signature, ou sur une Forge locale, rien n’est tenté', async () => {
  let lance = false;
  const spawnFn = () => { lance = true; throw new Error('ne doit pas partir'); };
  assert.equal(await poserSignataires({ ...SERVEUR, signingKey: '' }, { spawnFn }), null);
  assert.equal(await poserSignataires({ ...SERVEUR, kind: 'local' }, { spawnFn }), null);
  assert.equal(lance, false);
});

test('une clé déclarée illisible ou qui n’est pas publique est dite, et rien ne part', async () => {
  let lance = false;
  const spawnFn = () => { lance = true; };
  const illisible = await poserSignataires(SERVEUR, { spawnFn, lire: async () => { throw new Error('ENOENT'); } });
  assert.equal(illisible.etat, 'echec');
  const privee = await poserSignataires(SERVEUR, {
    spawnFn, lire: async () => '-----BEGIN OPENSSH PRIVATE KEY-----\n' });
  assert.equal(privee.etat, 'refus');
  assert.equal(lance, false);
});

test('la ligne de résultat ne laisse passer que les états connus', () => {
  assert.deepEqual(lireResultat('bruit\n{"etat":"deja"}\n'), { etat: 'deja' });
  assert.equal(lireResultat('{"etat":"pirate"}').etat, 'echec');
  assert.equal(ETATS.includes('pose'), true);
});
