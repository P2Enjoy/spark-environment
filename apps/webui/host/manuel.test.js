/**
 * Le manuel servi par l'hôte console.
 *
 * @verifies docs/BACKLOG.md#SPK-56 · docs/DESIGN_SYSTEM.md §1.5 bis, §1.4 (pas
 *           de commande morte) · docs/DAT.md §30
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chapitres, chapitre, image, titreDe, ManuelError } from './manuel.js';

const RACINE = new URL('../../../docs/manuel/', import.meta.url).pathname;

test('les chapitres sont rendus dans l’ordre des NUMÉROS, pas de l’alphabet', async () => {
  const liste = await chapitres(RACINE);
  const numeros = liste.map((c) => c.numero);
  assert.deepEqual(numeros, [...numeros].sort((a, b) => a - b));
  // Le piège que le tri alphabétique produit : M10 avant M2.
  assert.ok(numeros.indexOf(2) < numeros.indexOf(10));
});

test('chaque chapitre porte son titre, lu dans le document', async () => {
  const liste = await chapitres(RACINE);
  assert.ok(liste.length >= 12);
  for (const c of liste) assert.ok(c.titre.length > 3, `${c.id} sans titre`);
});

test('un renvoi désigne un chapitre par son NUMÉRO, pas par son slug', async () => {
  // Un écran renvoie « M4 » : le nom de fichier est un détail d'écriture.
  const parNumero = await chapitre(RACINE, 'M4');
  const parSlug = await chapitre(RACINE, 'M4-pools');
  assert.equal(parNumero, parSlug);
});

test('un nom qui n’est pas un chapitre est refusé AVANT le disque', async () => {
  for (const mauvais of ['../../.env', 'M1/../../secret', 'README', '', null]) {
    await assert.rejects(() => chapitre(RACINE, mauvais), ManuelError,
                         `« ${mauvais} » aurait dû être refusé`);
  }
});

test('une image hors du dossier des illustrations est refusée', async () => {
  await assert.rejects(() => image(RACINE, '../../../.env'), ManuelError);
  await assert.rejects(() => image(RACINE, 'M4-pools.md'), ManuelError);
});

test('une illustration réelle du manuel est servie avec son type', async () => {
  const { contenu, type } = await image(RACINE, 'm4-pools.png');
  assert.ok(contenu.length > 100);
  assert.equal(type, 'image/png');
});

test('titreDe retombe sur le repli quand le document n’a pas de titre', () => {
  assert.equal(titreDe('pas de titre ici', 'M9'), 'M9');
  assert.equal(titreDe('# M9 · Instantanés\n', 'M9'), 'M9 · Instantanés');
});
