/**
 * Tout module de la console se CHARGE.
 *
 * @verifies docs/BACKLOG.md#SPK-56 · docs/DESIGN_SYSTEM.md §12.3 (la classe non
 *           générée) — même classe de défaut, une couche plus bas
 *
 * Mesuré le 2026-08-20, à mes dépens : une fonction posée entre deux entrées du
 * littéral `routes = { … }` de `host/main.js` passe la relecture humaine et
 * casse au CHARGEMENT du module. La console ne démarre plus, et aucune suite ne
 * le signale — puisque rien ne se charge, rien ne s'exécute, et un test qui ne
 * tourne pas ne rougit pas.
 *
 * Ce fichier ne vérifie aucun comportement. Il vérifie que le comportement est
 * ATTEIGNABLE : c'est le préalable de toutes les autres preuves.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';

// `src/styles` ne porte que des feuilles de style : son garde-fou est
// `styles/classes.test.js`, une couche au-dessus.
const DOSSIERS = ['host', 'src/components'];

/** Modules de production : les fichiers de test se chargent en s'exécutant. */
async function modulesDe(dossier) {
  const racine = new URL(`${dossier}/`, import.meta.url);
  const fichiers = await readdir(racine);
  return fichiers
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .map((f) => ({ chemin: `${dossier}/${f}`, url: new URL(f, racine) }));
}

for (const dossier of DOSSIERS) {
  test(`chaque module de « ${dossier} » se charge`, async () => {
    const modules = await modulesDe(dossier);
    assert.ok(modules.length > 0, `aucun module trouvé dans ${dossier}`);
    for (const { chemin, url } of modules) {
      // `main.js` ne démarre son serveur que lancé directement : l'importer est
      // sans effet de bord.
      await assert.doesNotReject(() => import(url.href),
                                 `« ${chemin} » ne se charge pas`);
    }
  });
}

test('un module de production n’écoute sur rien à l’import', async () => {
  // Corollaire du précédent : si l'import ouvrait un port, la suite le tiendrait
  // ouvert et le prochain lancement de la pile échouerait en EADDRINUSE, loin
  // d'ici.
  const { createConsoleHost } = await import('./host/main.js');
  assert.equal(typeof createConsoleHost, 'function',
               'l’hôte console s’instancie à la demande, jamais à l’import');
});
