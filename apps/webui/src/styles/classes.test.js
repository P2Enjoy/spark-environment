/**
 * Toute classe employée par un composant existe dans la feuille de style.
 *
 * @verifies docs/BACKLOG.md#SPK-43 · docs/DESIGN_SYSTEM.md §12.3 (une classe
 *           dépendant d'un token inexistant disparaît SILENCIEUSEMENT du CSS,
 *           et ce cas doit être contrôlé automatiquement), §6.23 (le point
 *           d'engagement d'une action sensible est destructif)
 *
 * Pourquoi ce fichier existe, et il vaut la peine de le dire : le 2026-08-20,
 * la confirmation du dépannage (§37.3) a été écrite avec `bouton--danger`. Cette
 * classe n'existe pas — le projet nomme sa variante destructive
 * `bouton--destructif`. Le bouton s'est donc rendu en secondaire, blanc, à
 * l'endroit précis où le §6.23 exige la variante destructive.
 *
 * Vingt-six preuves de composant étaient VERTES avec ce défaut en place : elles
 * cherchaient la classe dans la chaîne rendue, ce qui prouve qu'on l'a écrite,
 * pas qu'elle peint quoi que ce soit. Seule la capture l'a montré. C'est
 * exactement le cas que le §12.3 décrit, et il demande un contrôle automatique
 * plutôt qu'un œil attentif.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ICI = dirname(fileURLToPath(import.meta.url));
const SRC = join(ICI, '..');

const FEUILLES = ['app.css', 'tokens.css'];
const COMPOSANTS = join(SRC, 'components');

/**
 * Classes déjà manquantes au 2026-08-20, mesurées en introduisant ce contrôle.
 *
 * Elles sont ÉTRANGÈRES à l'unité qui a ajouté ce fichier : le `CloudWorker.md`
 * §3.1 demande de les consigner et de laisser le comportement inchangé plutôt
 * que de retoucher au passage quatre écrans qu'on n'éprouve pas. Chacune a son
 * entrée au registre — INC-06.
 *
 * Cette liste ne peut que DÉCROÎTRE : une classe neuve absente du CSS fait
 * échouer ce contrôle, et rejoindre cette liste demande d'écrire pourquoi.
 */
const CONNUES = new Set([
  'controle--compact',    // app.js
  'epreuve--absent',      // servers-view.js
  'epreuve--ok',          // servers-view.js
  'recette-lignes',       // spark-admin.js
]);

function classesDefinies() {
  const css = FEUILLES.map((f) => readFileSync(join(SRC, 'styles', f), 'utf8')).join('\n');
  return new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
}

function fichiersDeRendu() {
  return readdirSync(COMPOSANTS)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .map((f) => join(COMPOSANTS, f))
    .concat([join(SRC, 'app.js')]);
}

/**
 * Les classes littérales d'un fichier.
 *
 * Les attributs contenant une interpolation sont écartés : `badge--${token}` ne
 * se lit pas statiquement, et le prétendre produirait de fausses alertes. Ces
 * cas-là sont couverts par les tables de correspondance, elles-mêmes éprouvées
 * — `VERDICTS`, `SPARK_STATES`, `CHEMINS` — qui n'emploient que des jetons du
 * design system (§2.6, §12.5).
 */
function classesEmployees(source) {
  const vues = new Set();
  for (const attribut of source.matchAll(/class="([^"${}]+)"/g)) {
    for (const classe of attribut[1].split(/\s+/).filter(Boolean)) vues.add(classe);
  }
  return vues;
}

test('toute classe littérale employée par un composant EXISTE dans le CSS', () => {
  const definies = classesDefinies();
  const manquantes = [];
  for (const fichier of fichiersDeRendu()) {
    for (const classe of classesEmployees(readFileSync(fichier, 'utf8'))) {
      if (!definies.has(classe) && !CONNUES.has(classe)) {
        manquantes.push(`${classe} (${fichier.split('/').pop()})`);
      }
    }
  }
  assert.deepEqual(manquantes, [],
    'ces classes ne peignent RIEN : elles sont écrites, mais absentes de la '
    + 'feuille de style. Une preuve de composant qui les cherche dans la chaîne '
    + 'rendue reste verte sans rien garantir (DESIGN_SYSTEM.md §12.3).');
});

test('la liste des manquantes connues ne contient QUE des classes encore manquantes', () => {
  // Sans ce contrôle, la liste survivrait à la correction qu'elle attend, et
  // masquerait la réapparition du même défaut sous le même nom. C'est la règle
  // « la documentation suit la réalité » appliquée à une exemption de test.
  const definies = classesDefinies();
  const soldees = [...CONNUES].filter((c) => definies.has(c));
  assert.deepEqual(soldees, [],
    'ces classes existent désormais : retirez-les de CONNUES et de INC-06.');
});

test('la variante destructive employée est bien celle du projet', () => {
  // Le défaut qui a motivé ce fichier, gardé nommément : `bouton--danger` est
  // la classe des BADGES, pas des boutons.
  const definies = classesDefinies();
  assert.ok(definies.has('bouton--destructif'));
  assert.ok(!definies.has('bouton--danger'),
    'si cette classe apparaît un jour, ce test doit être revu, pas supprimé : '
    + 'deux noms pour une même variante finiraient par diverger.');
});
