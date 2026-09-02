/**
 * @verifies docs/BACKLOG.md#SPK-82 · docs/DAT.md §42.10.2 (quelle clé, et
 *           comment la console la connaît), §42.10.3 (l'absence se dit)
 *
 * Ce que ces preuves gardent : on ne pousse pas « une » clé du poste, on pousse
 * CELLE dont l'empreinte correspond à ce qu'OpenSSH a déclaré accepter. Une clé
 * plausible accordée au hasard serait un octroi d'accès non demandé.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clesDuPoste, empreinteDe, cleCorrespondante, libelleConsole }
  from './identite-console.js';

const ED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILklM4dl9E+GCZog4f8+fV4q3fR0CvBnyFDMmDcrFbYT poste';

test('l’empreinte est celle qu’OpenSSH écrit, pas une réimplémentation', async () => {
  // C'est la commande que le manuel M6 donne au lecteur pour comparer : deux
  // façons de calculer une empreinte finissent par diverger.
  const empreinte = await empreinteDe(ED);
  assert.match(empreinte, /^SHA256:[A-Za-z0-9+/=]+$/);
});

test('sans empreinte, on ne choisit RIEN', async () => {
  // §42.10.3 : un serveur local n'emploie pas de clé. Retourner la première du
  // poste serait accorder un accès au hasard.
  assert.equal(await cleCorrespondante(null), null);
  assert.equal(await cleCorrespondante(''), null);
});

test('une empreinte inconnue ne fait pas retenir une clé « plausible »', async () => {
  const dossier = await mkdtemp(join(tmpdir(), 'spark-cles-'));
  await writeFile(join(dossier, 'id_ed25519.pub'), `${ED}\n`);
  const trouvee = await cleCorrespondante('SHA256:CeciNestPasUneEmpreinteConnue', {
    lire: async () => '', dossier });
  assert.equal(trouvee, null);
});

test('la clé dont l’empreinte CORRESPOND est retenue', async () => {
  const dossier = await mkdtemp(join(tmpdir(), 'spark-cles-'));
  await writeFile(join(dossier, 'id_ed25519.pub'), `${ED}\n`);
  const empreinte = await empreinteDe(ED);
  const trouvee = await cleCorrespondante(empreinte, { lire: async () => '', dossier });
  assert.equal(trouvee, ED);
});

test('l’agent PRIME sur les fichiers, et rien n’est compté deux fois', async () => {
  // OpenSSH interroge l'agent d'abord, et une clé protégée par phrase n'existe
  // sous forme utilisable QUE là.
  const dossier = await mkdtemp(join(tmpdir(), 'spark-cles-'));
  await writeFile(join(dossier, 'id_ed25519.pub'), `${ED}\n`);
  const cles = await clesDuPoste({ lire: async () => `${ED}\n`, dossier });
  assert.equal(cles.length, 1, 'la même clé ne doit pas figurer deux fois');
});

test('un dossier .ssh absent n’est pas une panne', async () => {
  const cles = await clesDuPoste({ lire: async () => '', dossier: '/n/existe/pas' });
  assert.deepEqual(cles, []);
});

test('le libellé est STABLE, et sans caractère qui casserait un chemin', async () => {
  // Un libellé qui changerait d'un amorçage à l'autre inscrirait une seconde
  // entrée pour la même clé, et le panneau Clés montrerait deux accès.
  assert.equal(libelleConsole(ED), 'console-poste');
  assert.equal(libelleConsole(ED), libelleConsole(ED));
  assert.equal(libelleConsole('ssh-ed25519 AAAA a/b c'), 'console-ab');
  assert.equal(libelleConsole('ssh-ed25519 AAAA'), 'console');
});
