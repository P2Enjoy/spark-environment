/**
 * L'écran du manuel et son rendu Markdown.
 *
 * @verifies docs/BACKLOG.md#SPK-56 · docs/DESIGN_SYSTEM.md §1.5 bis (l'écran
 *           nomme, le manuel explique), §1.4 (pas de commande morte),
 *           §6.13 (états d'une vue), §8.2 (débordement), §9.3 (titres)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderManuel, renderMarkdown, enrichir, ancre } from './manuel-view.js';

const CHAPITRES = [
  { id: 'M4-pools', numero: 4, titre: 'M4 · Lire les pools' },
  { id: 'M12-annexes', numero: 12, titre: 'M12 · Annexes' },
];

test('le code est protégé AVANT le gras et les liens', () => {
  // Sans cette précaution, une commande qui contient des astérisques serait
  // réécrite, et le lecteur copierait une commande fausse.
  const rendu = enrichir('Lancer `rm -- *.tmp` puis **relire**');
  assert.ok(rendu.includes('<code>rm -- *.tmp</code>'));
  assert.ok(rendu.includes('<strong>relire</strong>'));
  assert.ok(!rendu.includes('<strong>.tmp'), 'le contenu du code n’est pas réécrit');
});

test('le HTML d’un document est échappé, jamais rendu', () => {
  const rendu = renderMarkdown('Un <script>alert(1)</script> dans le texte');
  assert.ok(!rendu.includes('<script>'));
  assert.ok(rendu.includes('&lt;script&gt;'));
});

test('une illustration passe par la route du manuel, pas par un chemin de fichier', () => {
  const rendu = enrichir('![Les pools](images/m4-pools.png)');
  assert.ok(rendu.includes('src="/api/manuel/image?nom=m4-pools.png"'));
  assert.ok(rendu.includes('alt="Les pools"'));
});

test('un renvoi d’un chapitre à l’autre reste une destination de la console', () => {
  const rendu = enrichir('voir [M4](M4-pools.md#pools)');
  assert.ok(rendu.includes('href="#/manuel/M4-pools#pools"'));
});

test('les titres du document descendent d’un cran sous celui de la page', () => {
  // §9.3 : la page porte déjà son `h1`. Un second ferait deux titres de page.
  const rendu = renderMarkdown('# Chapitre\n\n## Section\n');
  assert.ok(rendu.includes('<h2 id="chapitre">'));
  assert.ok(rendu.includes('<h3 id="section">'));
  assert.ok(!rendu.includes('<h1'));
});

test('un tableau défile dans SON conteneur', () => {
  const rendu = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n');
  assert.ok(rendu.includes('class="table-defilante"'));
  assert.ok(rendu.includes('<th>a</th>'));
  assert.ok(rendu.includes('<td>2</td>'));
});

test('les ancres sont stables et sans accent', () => {
  assert.equal(ancre('D’où vient la mémoire allouable'), 'd-ou-vient-la-memoire-allouable');
  assert.equal(ancre('Le surengagement'), 'le-surengagement');
});

test('un chapitre réel du manuel se rend entièrement', async () => {
  const markdown = await readFile(
    new URL('../../../../docs/manuel/M4-pools.md', import.meta.url), 'utf8');
  const rendu = renderMarkdown(markdown);
  assert.ok(rendu.includes('<h2'), 'le titre du chapitre');
  assert.ok(rendu.includes('<pre class="bloc-code">'), 'les blocs de code');
  assert.ok(rendu.includes('<img '), 'les illustrations');
  assert.ok(!rendu.includes('```'), 'aucune clôture de bloc ne fuit dans le texte');
});

test('les quatre états de la vue sont traités', () => {
  assert.ok(renderManuel({ status: 'loading' }).includes('aria-busy="true"'));

  const enErreur = renderManuel({ status: 'error', error: new Error('Chapitre absent.') });
  assert.ok(enErreur.includes('role="alert"'));
  assert.ok(enErreur.includes('Chapitre absent.'));
  assert.ok(enErreur.includes('docs/manuel/'), 'l’écran dit OÙ le manuel est censé vivre');

  const vide = renderManuel({ status: 'ready', chapters: CHAPITRES });
  assert.ok(vide.includes('Choisir un chapitre'));

  const lu = renderManuel({ status: 'ready', chapters: CHAPITRES,
                            current: 'M4-pools', markdown: '# Titre\n' });
  assert.ok(lu.includes('<h2 id="titre">'));
});

test('le chapitre courant est annoncé, et pas seulement coloré', () => {
  const rendu = renderManuel({ status: 'ready', chapters: CHAPITRES,
                               current: 'M4', markdown: '# T\n' });
  // Un renvoi vise « M4 » ; le sommaire porte « M4-pools ». L'indicateur doit
  // suivre, sinon la page courante n'est annoncée nulle part.
  assert.ok(rendu.includes('href="#/manuel/M4-pools" class="destination" aria-current="page"'));
});
