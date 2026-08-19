/**
 * @verifies docs/BACKLOG.md#SPK-16, docs/BACKLOG.md#SPK-23 ·
 *           docs/DAT.md §22.4, §28.2 (le serveur local)
 *
 * L'inventaire ne contient jamais de secret : dupliquer un secret, c'est
 * doubler les endroits ou il fuit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { load, save, validate, InventoryError } from './inventory.js';

// Un serveur porte desormais un GENRE (§28.2). Les deux attentes ci-dessous
// enumeraient les champs ecrits ; elles suivent la nouvelle forme.
const OK = { name: 'prod', kind: 'ssh', host: '203.0.113.10', user: 'ubuntu',
             port: 22, remotePort: 9876 };

async function fichier() {
  return join(await mkdtemp(join(tmpdir(), 'spark-')), 'servers.json');
}

test('valeurs par defaut raisonnables', () => {
  const s = validate({ name: 'prod', host: 'x.example.com' });
  assert.equal(s.user, 'root');
  assert.equal(s.port, 22);
  assert.equal(s.remotePort, 9876);
});

test('nom invalide refuse', () => {
  for (const nom of ['Majuscule', '-tiret', '', 'avec espace'])
    assert.throws(() => validate({ ...OK, name: nom }), InventoryError);
});

test('hote obligatoire', () => {
  assert.throws(() => validate({ name: 'prod' }), /pas d'hôte/);
});

test('ports hors bornes refuses', () => {
  assert.throws(() => validate({ ...OK, port: 0 }), /hors bornes/);
  assert.throws(() => validate({ ...OK, remotePort: 70000 }), /hors bornes/);
});

// --- aucun secret (§22.4) ---------------------------------------------------

test('un champ qui ressemble a un secret est REFUSE, pas filtre', () => {
  // Refuser plutot que filtrer en silence : l'auteur doit savoir qu'il a copie
  // un secret, pour le retirer de la ou il l'a pris.
  for (const champ of ['password', 'privateKey', 'passphrase', 'token', 'api_secret'])
    assert.throws(() => validate({ ...OK, [champ]: 'x' }), /ressemble à un secret/);
});

test('une cle privee collee dans un champ anodin est attrapee', () => {
  assert.throws(
    () => validate({ ...OK, note: '-----BEGIN OPENSSH PRIVATE KEY-----' }),
    /ressemble à un secret/,
  );
});

test('seuls les champs attendus sont ecrits sur le disque', async () => {
  const chemin = await fichier();
  await save([{ ...OK, extra: 'ignoré' }], chemin);
  const [ecrit] = JSON.parse(await readFile(chemin, 'utf8'));
  assert.deepEqual(Object.keys(ecrit).sort(),
                   ['host', 'kind', 'name', 'port', 'remotePort', 'user']);
});

// --- lecture ----------------------------------------------------------------

test('un inventaire absent rend une liste vide, pas une erreur', async () => {
  assert.deepEqual(await load(join(tmpdir(), 'absent-' + Date.now(), 'x.json')), []);
});

test('un inventaire illisible ECHOUE plutot que de repartir vide', async () => {
  // Repartir vide ferait croire a l'exploitant qu'il a perdu ses serveurs.
  const chemin = await fichier();
  await writeFile(chemin, '{ ceci n est pas du json');
  await assert.rejects(load(chemin), /illisible/);
});

test('aller-retour', async () => {
  const chemin = await fichier();
  await save([OK], chemin);
  assert.deepEqual(await load(chemin), [OK]);
});

// --- le serveur local (docs/DAT.md §28.2) -----------------------------------

test('un serveur sans genre reste un serveur SSH', () => {
  assert.equal(validate({ name: 'prod', host: 'x.example.com' }).kind, 'ssh');
});

test("un serveur local n'exige ni hote, ni utilisateur, ni port distant", () => {
  const s = validate({ name: 'dev', kind: 'local' });
  assert.equal(s.kind, 'local');
  assert.equal(s.host, '127.0.0.1');
  assert.equal(s.port, 9876, 'le port ou ecoute sparkd en local');
  assert.ok(!('user' in s), 'exiger un utilisateur obligerait a en inventer un');
  assert.ok(!('remotePort' in s), 'il n’y a pas de machine distante');
});

test('un serveur local accepte un port explicite', () => {
  assert.equal(validate({ name: 'dev', kind: 'local', remotePort: 9999 }).port, 9999);
});

test('un genre inconnu est refuse, en nommant ce qui est attendu', () => {
  assert.throws(() => validate({ name: 'x', kind: 'telepathie', host: 'a' }),
                /attendu ssh ou local/);
});

test('un serveur local aussi refuse un secret', () => {
  assert.throws(() => validate({ name: 'dev', kind: 'local', token: 'abc' }), InventoryError);
});

test('aller-retour d’un serveur local', async () => {
  const chemin = await fichier();
  const local = { name: 'dev', kind: 'local', host: '127.0.0.1', port: 9876 };
  await save([local], chemin);
  assert.deepEqual(await load(chemin), [local]);
});
