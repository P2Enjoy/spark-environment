/**
 * @verifies docs/BACKLOG.md#SPK-25 · docs/DAT.md §30 (le manuel et sa
 *           fraîcheur), §30.1, §30.2 (le lien vérifié dans les deux sens),
 *           §30.3 (ce qu'un chapitre a le droit d'affirmer) · CLAUDE.md §7
 *
 * `CLAUDE.md` §7 exige que les captures soient renouvelées quand l'apparence
 * change. Cette exigence ne tient pas sans mécanisme : elle dépend de la
 * vigilance, et la vigilance s'épuise. Ces preuves sont ce mécanisme.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANUEL = fileURLToPath(new URL('../docs/manuel/', import.meta.url));
const IMAGES = join(MANUEL, 'images');

async function pages() {
  const fichiers = (await readdir(MANUEL)).filter((f) => f.endsWith('.md'));
  return Promise.all(fichiers.map(async (f) => ({
    nom: f,
    texte: await readFile(join(MANUEL, f), 'utf8'),
  })));
}

async function imagesProduites() {
  return (await readdir(IMAGES)).filter((f) => f.endsWith('.png')).sort();
}

/** Toutes les images citées par le manuel, quel que soit le chapitre. */
function citees(textes) {
  const trouvees = new Set();
  for (const texte of textes) {
    for (const m of texte.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      trouvees.add(m[1].split('/').pop());
    }
  }
  return trouvees;
}

test('le manuel comporte au moins un chapitre', async () => {
  const chapitres = await pages();
  assert.ok(chapitres.length > 0, 'aucune page sous docs/manuel/');
});

test('toute image citée par le manuel EXISTE', async () => {
  const chapitres = await pages();
  const produites = new Set(await imagesProduites());
  const manquantes = [...citees(chapitres.map((c) => c.texte))]
    .filter((i) => !produites.has(i));
  assert.deepEqual(manquantes, [],
    'ces images sont citées mais absentes : le lecteur verrait un cadre vide. '
    + 'Relancer « make manuel ».');
});

test('toute image produite est CITÉE quelque part', async () => {
  // §30.2 : une image orpheline n'est vue de personne, et survit indéfiniment à
  // l'écran qu'elle montrait. C'est la dérive qu'aucun relecteur ne trouve.
  const chapitres = await pages();
  const employees = citees(chapitres.map((c) => c.texte));
  const orphelines = (await imagesProduites()).filter((i) => !employees.has(i));
  assert.deepEqual(orphelines, [],
    'ces images ne sont citées par aucun chapitre : soit le chapitre a été '
    + 'retiré, soit le harnais produit une illustration inutile.');
});

test('les images citées le sont par un chemin relatif à leur page', async () => {
  for (const { nom, texte } of await pages()) {
    for (const m of texte.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      assert.ok(m[1].startsWith('images/'),
        `${nom} cite « ${m[1]} » : les images vivent dans images/, à côté du manuel.`);
      assert.ok(!m[1].includes('..'),
        `${nom} remonte hors du manuel pour « ${m[1]} ».`);
    }
  }
});

test('chaque image porte un texte alternatif non vide (accessibilité)', async () => {
  for (const { nom, texte } of await pages()) {
    for (const m of texte.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
      assert.ok(m[1].trim().length > 0,
        `${nom} : l'image « ${m[2]} » n'a pas de texte alternatif.`);
    }
  }
});

test("le manuel ne contient ni secret, ni clé privée, ni adresse réelle", async () => {
  // CLAUDE.md §7 : les NOMS de variables d'environnement sont autorisés, leurs
  // valeurs jamais. Une adresse publique réelle non plus.
  const interdits = [
    [/BEGIN [A-Z ]*PRIVATE KEY/, 'une clé privée'],
    [/\bpassword\s*[:=]\s*\S/i, 'un mot de passe'],
    [/\b(?:api[_-]?key|token|secret)\s*[:=]\s*["']?[A-Za-z0-9/+_-]{12,}/i, 'un secret'],
    // L'adresse du serveur de validation ne doit pas se retrouver dans un
    // document destiné à être lu au-delà de l'équipe.
    [/\b51\.158\.\d{1,3}\.\d{1,3}\b/, "l'adresse réelle du serveur de validation"],
  ];
  for (const { nom, texte } of await pages()) {
    for (const [motif, quoi] of interdits) {
      assert.ok(!motif.test(texte), `${nom} contient ${quoi}.`);
    }
  }
});

test('un chapitre non rédigé dit POURQUOI et quelle unité le débloque', async () => {
  // §30.3 : un chapitre dont l'unité n'est pas livrée n'est pas écrit d'avance
  // et faux. Mais il ne disparaît pas non plus : il annonce son blocage.
  const index = (await pages()).find((c) => c.nom === 'README.md');
  assert.ok(index, 'le manuel doit avoir un sommaire (docs/manuel/README.md)');
  for (const ligne of index.texte.split('\n')) {
    if (!/pas encore rédigé/i.test(ligne)) continue;
    assert.match(ligne, /SPK-\d{2}/,
      `« ${ligne.trim()} » annonce un chapitre non rédigé sans nommer l'unité qui le débloque.`);
  }
});
