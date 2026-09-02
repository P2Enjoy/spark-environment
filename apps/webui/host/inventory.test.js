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

import {
  load, loadFile, save, saveFile, validate, InventoryError, VERSION,
} from './inventory.js';

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
  // REVISE par SPK-41 : le fichier porte desormais sa VERSION et le serveur
  // courant (§22.4.2), donc un OBJET remplace le tableau nu a la racine. Ce que
  // la preuve etablit est inchange — un champ etranger n'atteint pas le disque —
  // et c'est l'enveloppe qui a change, pas la regle.
  const chemin = await fichier();
  await save([{ ...OK, extra: 'ignoré' }], chemin);
  const fichierEcrit = JSON.parse(await readFile(chemin, 'utf8'));
  assert.equal(fichierEcrit.version, VERSION);
  assert.deepEqual(Object.keys(fichierEcrit.servers[0]).sort(),
                   ['host', 'kind', 'name', 'port', 'remotePort', 'user']);
});

// --- la forme du fichier (SPK-41, docs/DAT.md §22.4.2) ---------------------

test('la forme HISTORIQUE se lit encore, et n’est pas recrite a la lecture', async () => {
  // Une console qui migrerait le fichier en l'affichant le recrirait sans qu'on
  // l'ait demande. La conversion attend un enregistrement, qui est un geste.
  const chemin = await fichier();
  await writeFile(chemin, JSON.stringify([OK]));
  const avant = await readFile(chemin, 'utf8');

  const lu = await loadFile(chemin);
  assert.equal(lu.version, 0, 'le tableau nu EST la version 0');
  assert.deepEqual(lu.servers, [OK]);
  assert.equal(await readFile(chemin, 'utf8'), avant, 'le fichier n’a pas bouge');
});

test('un enregistrement CONVERTIT le fichier dans la forme courante', async () => {
  const chemin = await fichier();
  await writeFile(chemin, JSON.stringify([OK]));
  await save([OK], chemin);
  const ecrit = JSON.parse(await readFile(chemin, 'utf8'));
  assert.equal(ecrit.version, VERSION);
  assert.ok(Array.isArray(ecrit.servers));
});

test('enregistrer une liste n’efface ni le serveur courant ni les ancres', async () => {
  // Ils vivent dans le meme fichier : les perdre a chaque ajout de serveur
  // reviendrait a oublier ou l'on regardait, et ce que la console avait vu.
  const chemin = await fichier();
  await saveFile({ servers: [OK], current: 'prod', anchors: { prod: { head: 'a' } } }, chemin);
  await save([OK, { ...OK, name: 'autre' }], chemin);
  const relu = await loadFile(chemin);
  assert.equal(relu.current, 'prod');
  assert.deepEqual(relu.anchors, { prod: { head: 'a' } });
});

test('un serveur courant qui ne designe plus rien vaut null', async () => {
  // Le garder ferait chercher un serveur qui n'est plus la.
  const chemin = await fichier();
  await saveFile({ servers: [OK], current: 'prod' }, chemin);
  await saveFile({ servers: [{ ...OK, name: 'autre' }], current: 'prod' }, chemin);
  assert.equal((await loadFile(chemin)).current, null);
});

test('un fichier de forme inconnue ECHOUE plutot que de repartir vide', async () => {
  const chemin = await fichier();
  await writeFile(chemin, JSON.stringify({ version: 1, serveurs: [] }));
  await assert.rejects(loadFile(chemin), /illisible/);
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
  // Les deux ecritures doivent marcher, et `port` doit primer : l'aller-retour
  // rend `port`, donc relire ce qu'on a ecrit doit donner la meme valeur.
  assert.equal(validate({ name: 'dev', kind: 'local', remotePort: 9999 }).port, 9999);
  assert.equal(validate({ name: 'dev', kind: 'local', port: 38561 }).port, 38561);
  assert.equal(validate({ name: 'dev', kind: 'local', port: 38561, remotePort: 9876 }).port,
               38561, 'le port fourni ne doit pas etre jete au profit du defaut');
});

test('un serveur local survit a un aller-retour sur un port quelconque', () => {
  // Le defaut trouve par le harnais E2E : `validate` rendait toujours 9876, et
  // une pile montee sur un port libre pointait sur un sparkd qui n'etait pas le
  // sien. Le test precedent ne le voyait pas : il utilisait justement 9876.
  const ecrit = { name: 'dev', kind: 'local', host: '127.0.0.1', port: 44013 };
  assert.deepEqual(validate(ecrit), ecrit);
});

test('un genre inconnu est refuse, en nommant ce qui est attendu', () => {
  // REVISE par SPK-41 : le §22.4 bis ajoute le genre `alias`, qui delegue TOUT
  // a OpenSSH. Le message enumere donc trois genres et non deux. Ce que la
  // preuve etablit — un genre inconnu est refuse EN NOMMANT les attendus — est
  // inchange : c'est la liste qui a grandi, pas la regle.
  assert.throws(() => validate({ name: 'x', kind: 'telepathie', host: 'a' }),
                /attendu ssh ou alias ou local/);
});

// --- le genre `alias` (SPK-41, docs/DAT.md §22.4 bis, §22.4.1) -------------

test('une entree par ALIAS ne porte ni user ni port de connexion', () => {
  // Les deviner donnerait l'illusion de les connaitre, et ils seraient faux des
  // qu'un ProxyJump s'interpose.
  const entree = validate({ name: 'prod', kind: 'alias', sshHost: 'spark-prod' });
  assert.deepEqual(entree, { name: 'prod', kind: 'alias', sshHost: 'spark-prod',
                             remotePort: 9876 });
  assert.ok(!('user' in entree) && !('port' in entree) && !('host' in entree));
});

test('un alias VIDE est refuse, et dit ou le chercher', () => {
  assert.throws(() => validate({ name: 'prod', kind: 'alias' }),
                /~\/\.ssh\/config/);
  assert.throws(() => validate({ name: 'prod', kind: 'alias', sshHost: '   ' }),
                InventoryError);
});

test('une entree par alias porte quand meme le port de sparkd', () => {
  // C'est le produit qui sait ou `sparkd` ecoute a l'autre bout ; OpenSSH ne le
  // sait pas, et le §22.4 bis lui delegue la CONNEXION, pas le produit.
  assert.equal(validate({ name: 'p', kind: 'alias', sshHost: 'h', remotePort: 9999 })
                 .remotePort, 9999);
  assert.throws(() => validate({ name: 'p', kind: 'alias', sshHost: 'h', remotePort: 0 }),
                /hors bornes/);
});

test('une entree par alias refuse un secret comme les autres', () => {
  assert.throws(() => validate({ name: 'p', kind: 'alias', sshHost: 'h', passphrase: 'x' }),
                InventoryError);
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

// --- SPK-77 · L'ADRESSE PUBLIQUE DÉCLARÉE (docs/DAT.md §38.8.5) -------------

test('une adresse publique DECLAREE survit a l’aller-retour, quel que soit le genre', () => {
  // Le transport ne porte pas toujours l'adresse publique : un alias `ssh` la
  // cache dans le `ssh_config`, une Forge locale est atteinte par une boucle
  // locale. Sans ce champ, l'inventaire DNS n'a rien a rapprocher.
  assert.equal(validate({ name: 'a', kind: 'alias', sshHost: 'ma-forge',
                           publicAddress: '203.0.113.10' }).publicAddress,
               '203.0.113.10');
  assert.equal(validate({ name: 'b', kind: 'local', host: '127.0.0.1', port: 9876,
                           publicAddress: '203.0.113.10' }).publicAddress,
               '203.0.113.10');
  assert.equal(validate({ name: 'c', kind: 'ssh', host: '51.158.54.202',
                           publicAddress: '203.0.113.10' }).publicAddress,
               '203.0.113.10');
});

test('une adresse publique ABSENTE ne pose aucun champ', () => {
  assert.ok(!('publicAddress' in validate({ name: 'a', kind: 'ssh', host: 'h' })));
  assert.ok(!('publicAddress' in validate({ name: 'a', kind: 'ssh', host: 'h',
                                            publicAddress: '  ' })));
});

test('une BOUCLE LOCALE est refusee comme adresse publique', () => {
  // L'accepter ferait rapprocher l'inventaire DNS sur une adresse que personne
  // ne peut atteindre — et declarer « servi » ce qui ne l'est pas.
  for (const boucle of ['127.0.0.1', 'localhost', '::1']) {
    assert.throws(
      () => validate({ name: 'a', kind: 'ssh', host: 'h', publicAddress: boucle }),
      /boucle locale/);
  }
});
