/**
 * @verifies docs/BACKLOG.md#SPK-117 · docs/DAT.md §62.2 (ce que la route refuse,
 *           et pourquoi), §62.3 (le nouveau code doit se charger avant qu'on
 *           quitte l'ancien)
 *
 * Le préflight est éprouvé sur de VRAIS modules écrits dans un dossier jetable :
 * la seule façon de savoir si un import casse est d'importer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { examinerRelance, verifierChargement, tete } from './relance.js';

const PRET = { relancable: true };

test('rien ne s’oppose : aucun refus', () => {
  assert.equal(examinerRelance(PRET), null);
});

test('les sessions nommées dans la confirmation ne refusent pas la relance', () => {
  assert.equal(examinerRelance({ ...PRET,
    sessions: [{ id: 'a', spark: 'helo' }, { id: 'b', spark: 'helo' }],
    annoncees: ['a', 'b'] }), null);
});

test('chaque refus porte son code, dans l’ordre du plus fondamental', () => {
  const tout = { relancable: true, enCours: true, misesAJour: ['v'], installations: ['n'],
                 sessions: [{ id: 'x', spark: 's' }], annoncees: [] };
  assert.equal(examinerRelance({ ...tout, relancable: false }).code, 'relance_indisponible');
  assert.equal(examinerRelance(tout).code, 'relance_en_cours');
  assert.equal(examinerRelance({ ...tout, enCours: false }).code, 'mise_a_jour_en_cours');
  assert.equal(examinerRelance({ ...tout, enCours: false, misesAJour: [] }).code,
               'installation_en_cours');
  assert.equal(examinerRelance({ ...tout, enCours: false, misesAJour: [],
                                 installations: [] }).code, 'sessions_changees');
});

test('un Spark qui porte deux sessions imprévues n’est nommé qu’une fois', () => {
  const refus = examinerRelance({ ...PRET, sessions: [
    { id: '1', spark: 'helo' }, { id: '2', spark: 'helo' }] });
  assert.equal(refus.message.match(/« helo »/g).length, 1);
});

async function arbre(fichiers) {
  const dossier = await mkdtemp(join(tmpdir(), 'spark-relance-'));
  await mkdir(join(dossier, 'host'));
  for (const [nom, contenu] of Object.entries(fichiers)) {
    await writeFile(join(dossier, 'host', nom), contenu);
  }
  return dossier;
}

test('un code qui se charge passe le préflight, sans exécuter le démarrage', async () => {
  // Le bloc de démarrage NE doit PAS courir : s'il courait, il écrirait sur la
  // sortie d'erreur et le préflight échouerait.
  const dossier = await arbre({
    'voisin.js': 'export const v = 1;',
    'main.js': `import { v } from './voisin.js';
      if (import.meta.url === \`file://\${process.argv[1]}\`) { console.error('démarré'); process.exit(9); }
      export const w = v;`,
  });
  try {
    assert.deepEqual(await verifierChargement(join(dossier, 'host', 'main.js')), { ok: true });
  } finally { await rm(dossier, { recursive: true, force: true }); }
});

test('une erreur de syntaxe dans un module importé est rendue, fichier et ligne en tête', async () => {
  const dossier = await arbre({
    'voisin.js': 'export const v = ;',
    'main.js': "import { v } from './voisin.js'; export const w = v;",
  });
  try {
    const verdict = await verifierChargement(join(dossier, 'host', 'main.js'));
    assert.equal(verdict.ok, false);
    assert.match(verdict.sortie, /voisin\.js:1/);
    assert.match(verdict.sortie, /SyntaxError/);
    assert.doesNotMatch(verdict.sortie, /^\s+at /m, 'la pile du chargeur n’apprend rien');
  } finally { await rm(dossier, { recursive: true, force: true }); }
});

test('un import introuvable est refusé', async () => {
  const dossier = await arbre({ 'main.js': "import './disparu.js';" });
  try {
    const verdict = await verifierChargement(join(dossier, 'host', 'main.js'));
    assert.equal(verdict.ok, false);
    assert.match(verdict.sortie, /disparu\.js/);
  } finally { await rm(dossier, { recursive: true, force: true }); }
});

test('un chargement qui ne rend pas la main est borné par le délai', async () => {
  const dossier = await arbre({ 'main.js': 'setInterval(() => {}, 1000);' });
  try {
    const verdict = await verifierChargement(join(dossier, 'host', 'main.js'), { delaiMs: 300 });
    assert.equal(verdict.ok, false);
    assert.match(verdict.sortie, /n’a pas abouti/);
  } finally { await rm(dossier, { recursive: true, force: true }); }
});

test('le vrai main.js de la console passe le préflight', async () => {
  const verdict = await verifierChargement(new URL('./main.js', import.meta.url).pathname);
  assert.deepEqual(verdict, { ok: true });
});

test('la tête garde le message et coupe la pile d’appels', () => {
  assert.equal(tete('f.js:3\nx = ;\n  ^\n\nSyntaxError: nope\n    at a (b:1)\n    at c\n'),
               'f.js:3\nx = ;\n  ^\n\nSyntaxError: nope');
  assert.equal(tete('sans pile'), 'sans pile');
});
