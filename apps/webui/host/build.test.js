/**
 * @verifies docs/BACKLOG.md#SPK-53 · docs/DAT.md §40.2 (« inconnue » est une
 *           réponse), §40.3 (les cinq situations) ·
 *           docs/DESIGN_SYSTEM.md §14.6
 *
 * Ce que ces preuves gardent, et c'est LE point de l'unité : la console NOMME ce
 * qu'elle sait au lieu de conclure. Le §40.3 le dit des deux derniers cas —
 * « une console qui afficherait "à jour" faute de savoir comparer mentirait
 * exactement au moment où l'on a besoin d'elle ».
 *
 * Les cas se construisent sur un VRAI dépôt jetable plutôt que sur un `git`
 * simulé : c'est l'ascendance des commits qu'on éprouve, et un doublon de `git`
 * ne prouverait que la fidélité du doublon.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  comparer, etatDepot, A_JOUR, FORGE_EN_RETARD, POSTE_EN_RETARD, ETRANGERE,
  NON_ESTAMPILLEE, SANS_DEPOT, VERDICTS, A_TRAITER,
} from './build.js';

/** Un dépôt jetable avec `n` commits, et la liste de leurs empreintes. */
async function depotJetable(n = 3) {
  const racine = await mkdtemp(join(tmpdir(), 'spark-build-'));
  const g = (...args) => execFileSync('git', args, { cwd: racine, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'contact@p2enjoy.studio');
  g('config', 'user.name', 'P2Enjoy');
  const commits = [];
  for (let i = 0; i < n; i += 1) {
    await writeFile(join(racine, 'f.txt'), `${i}\n`);
    g('add', 'f.txt');
    g('commit', '-q', '-m', `c${i}`);
    commits.push(g('rev-parse', 'HEAD').trim());
  }
  return { racine, commits, g, nettoyer: () => rm(racine, { recursive: true, force: true }) };
}

// --- Les cinq situations du §40.3 -------------------------------------------

test('même commit : à jour', async () => {
  const d = await depotJetable(2);
  const vu = await comparer({ commit: d.commits.at(-1) }, d.racine);
  assert.equal(vu.verdict, A_JOUR);
  assert.equal(vu.behind, 0);
  await d.nettoyer();
});

test('commit de la Forge ANCÊTRE du dépôt : elle est en retard, et de combien', async () => {
  const d = await depotJetable(4);
  const vu = await comparer({ commit: d.commits[0] }, d.racine);
  assert.equal(vu.verdict, FORGE_EN_RETARD);
  assert.equal(vu.behind, 3, 'le nombre est CHIFFRÉ, pas « en retard » tout court');
  await d.nettoyer();
});

test('une empreinte setuptools-scm ABREGEE est résolue avant tout geste', async () => {
  const d = await depotJetable(3);
  const vu = await comparer({ commit: d.commits[0].slice(0, 9) }, d.racine);
  assert.equal(vu.verdict, FORGE_EN_RETARD);
  assert.equal(vu.forgeCommit, d.commits[0]);
  await d.nettoyer();
});

test('commit local ancêtre de celui de la Forge : c’est le POSTE qui est en retard', async () => {
  // Le cas qu'on oublie, et celui qui trompe le plus : l'écran dirait « en
  // retard » et l'exploitant redéploierait une version PLUS ANCIENNE.
  const d = await depotJetable(4);
  const tete = d.commits.at(-1);
  d.g('reset', '-q', '--hard', d.commits[1]);
  const vu = await comparer({ commit: tete }, d.racine);
  assert.equal(vu.verdict, POSTE_EN_RETARD);
  assert.equal(vu.ahead, 2);
  await d.nettoyer();
});

test('commit INCONNU du dépôt : étrangère, et aucune conclusion', async () => {
  const d = await depotJetable(2);
  const vu = await comparer({ commit: 'f'.repeat(40) }, d.racine);
  assert.equal(vu.verdict, ETRANGERE);
  assert.match(VERDICTS[ETRANGERE].detail, /on ne sait pas/);
  await d.nettoyer();
});

test('deux histoires DIVERGENTES ne se déclarent pas « à jour »', async () => {
  // Connu, mais ni ancêtre ni descendant. Le §40.3 ne le nomme pas séparément ;
  // « aucune conclusion » le décrit exactement.
  const d = await depotJetable(2);
  d.g('checkout', '-q', '-b', 'autre', d.commits[0]);
  await writeFile(join(d.racine, 'g.txt'), 'x\n');
  d.g('add', 'g.txt'); d.g('commit', '-q', '-m', 'divergent');
  const divergent = d.g('rev-parse', 'HEAD').trim();
  d.g('checkout', '-q', 'main');
  const vu = await comparer({ commit: divergent }, d.racine);
  assert.equal(vu.verdict, ETRANGERE);
  await d.nettoyer();
});

test('build NON ESTAMPILLÉE : dit qu’elle l’est, et ne compare rien', async () => {
  // §40.2 : « inconnue » est une réponse, pas un défaut.
  const d = await depotJetable(2);
  for (const forge of [{ commit: null }, {}, null]) {
    const vu = await comparer(forge, d.racine);
    assert.equal(vu.verdict, NON_ESTAMPILLEE, JSON.stringify(forge));
  }
  assert.match(VERDICTS[NON_ESTAMPILLEE].detail, /Réinstallez/);
  await d.nettoyer();
});

// --- Le sixième cas, absent de la table et rencontré en l'implémentant -------

test('sans dépôt sur le poste, la console le DIT au lieu de conclure', async () => {
  // Une console installée chez un exploitant qui ne développe pas n'a rien à
  // quoi comparer. Ranger ce cas dans « étrangère » serait faux : on ne sait
  // pas si elle est étrangère, on n'a rien pour le dire.
  const vide = await mkdtemp(join(tmpdir(), 'spark-sans-depot-'));
  const vu = await comparer({ commit: 'a'.repeat(40) }, vide);
  assert.equal(vu.verdict, SANS_DEPOT);
  assert.equal(vu.local, null);
  await rm(vide, { recursive: true, force: true });
});

test('etatDepot rend null hors d’un dépôt, sans lever', async () => {
  // Un `git` en échec est une RÉPONSE, pas une panne de la console : lever
  // ferait d'une absence de comparaison une panne d'écran.
  const vide = await mkdtemp(join(tmpdir(), 'spark-sans-depot-'));
  assert.equal(await etatDepot(vide), null);
  await rm(vide, { recursive: true, force: true });
});

// --- Ce que les verdicts promettent -----------------------------------------

test('les six verdicts ont chacun leur libellé, et aucun ne dit « à jour » par défaut', () => {
  for (const cle of [A_JOUR, FORGE_EN_RETARD, POSTE_EN_RETARD, ETRANGERE,
                     NON_ESTAMPILLEE, SANS_DEPOT]) {
    assert.ok(VERDICTS[cle]?.titre, cle);
    assert.ok(VERDICTS[cle]?.detail, cle);
  }
  // Le seul qui affirme que tout va bien est celui qui l'a mesuré.
  const rassurants = Object.entries(VERDICTS)
    .filter(([, v]) => /à jour/i.test(v.titre)).map(([k]) => k);
  assert.deepEqual(rassurants, [A_JOUR]);
});

test('seuls les verdicts qui APPELLENT un geste sont à traiter', () => {
  // Un « c'est le poste qui est en retard » n'appelle rien SUR LA FORGE, et le
  // signaler comme un défaut de la Forge enverrait redéployer une version plus
  // ancienne — exactement l'erreur que ce cas existe pour éviter.
  assert.deepEqual([...A_TRAITER].sort(), [FORGE_EN_RETARD, NON_ESTAMPILLEE].sort());
  assert.ok(!A_TRAITER.includes(POSTE_EN_RETARD));
  assert.ok(!A_TRAITER.includes(A_JOUR));
});
