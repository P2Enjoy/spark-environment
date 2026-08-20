/**
 * @verifies docs/BACKLOG.md#SPK-56 · docs/DESIGN_SYSTEM.md §1.5 bis (le renvoi
 *           remplace le paragraphe), §1.4 (pas de commande morte)
 *
 * Le §1.5 bis sort les explications des écrans et les remplace par des renvois.
 * Un renvoi qui ne mène nulle part est une commande morte — et c'est le piège
 * que SPK-56 a évité de justesse en servant le manuel dans le même changement.
 *
 * Cette garde le rend impossible à retomber dedans : chaque « #/manuel/Mx »
 * écrit dans un composant doit désigner un chapitre qui EXISTE sur le disque.
 * Sans elle, renommer ou retirer un chapitre casserait les renvois en silence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const COMPOSANTS = new URL('../components/', import.meta.url).pathname;
const MANUEL = new URL('../../../../docs/manuel/', import.meta.url).pathname;

/** Les numéros de chapitre réellement présents — « M4-pools.md » → « M4 ». */
function chapitres() {
  return new Set(readdirSync(MANUEL)
    .filter((f) => /^M\d+-.*\.md$/.test(f))
    .map((f) => f.match(/^(M\d+)-/)[1]));
}

/** Tous les renvois écrits dans les composants, avec leur fichier. */
function renvois() {
  const vus = [];
  for (const fichier of readdirSync(COMPOSANTS).filter((f) => f.endsWith('.js')
      && !f.endsWith('.test.js'))) {
    const source = readFileSync(join(COMPOSANTS, fichier), 'utf8');
    for (const m of source.matchAll(/#\/manuel\/(M\d+)(?:-[\w-]+)?(?:#[\w-]+)?/g)) {
      vus.push({ fichier, chapitre: m[1], brut: m[0] });
    }
  }
  return vus;
}

test('chaque renvoi au manuel mène à un chapitre qui EXISTE', () => {
  const presents = chapitres();
  assert.ok(presents.size >= 10, `le manuel a été trouvé : ${[...presents].join(', ')}`);
  const morts = renvois().filter((r) => !presents.has(r.chapitre));
  assert.deepEqual(morts, [],
    `renvois morts : ${morts.map((r) => `${r.brut} (${r.fichier})`).join(', ')}`);
});

test('les écrans qui ont délégué leur explication PORTENT bien un renvoi', () => {
  // La contrepartie : le §1.5 bis autorise à retirer un paragraphe SI un renvoi
  // mène à l'explication. Retirer sans renvoyer rendrait l'écran muet, ce que la
  // règle interdit explicitement.
  const attendus = ['spark-detail.js', 'forge-view.js', 'forge-journal.js'];
  const parFichier = new Set(renvois().map((r) => r.fichier));
  for (const fichier of attendus) {
    assert.ok(parFichier.has(fichier), `${fichier} a délégué sans renvoyer`);
  }
});
