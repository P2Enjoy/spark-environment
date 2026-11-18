/**
 * @verifies docs/BACKLOG.md#SPK-173 · docs/DAT.md §68 (l'anneau de Mémoire et de
 *           Disque, le bloc « Total de la Forge » de l'onglet « Tous ») ·
 *           docs/DESIGN_SYSTEM_APP.md SPK-DS-44 · docs/DESIGN_SYSTEM.md §1.5
 *           (la couleur ne porte jamais seule), §6.14 (une absence reste vide),
 *           §14.6 (zéro n'est pas inconnu)
 *
 * Ce que ces preuves verrouillent : la part se calcule, se borne au dessin et
 * pas au chiffre, bascule au seuil avec autre chose que la couleur ; une mesure
 * ou une limite absente ne produit PAS un anneau vide ; le bloc des totaux lit
 * capacité, alloué et disponible de `/v1/forge`, somme l'utilisé mesuré, dit ce
 * qu'il n'a pas pu mesurer, nomme la capacité qu'il n'a pas, et n'existe que dans
 * l'onglet « Tous ».
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderSparksView, renderAnneau, renderBlocTotal, capaciteDeForge, sommerMesures }
  from './sparks-view.js';
import { proportionRessource, SEUIL_ALERTE_RESSOURCE } from './tokens.js';

const GIO = 1024 ** 3;
const spark = (name, state = 'running', extra = {}) => ({
  name, state, cpu_mode: 'shared', cpu_reservation: 0.5,
  memory_reservation_bytes: 8 * GIO, storage_bytes: 10 * GIO,
  ipv4_address: '10.77.0.2', image: 'images:ubuntu/26.04', ...extra,
});
const mesure = (cpu, mem, disque) => ({
  cpu: { used: cpu, over_limit: false }, memory: { used_bytes: mem }, disk: { used_bytes: disque },
});
const pool = (capacity, allocated, overcommit = 1) =>
  ({ capacity, allocated, available: capacity - allocated, overcommit });
const FORGE = { pools: {
  cpu: pool(8, 2.5), memory: pool(64 * GIO, 20 * GIO, 1.5), storage: pool(500 * GIO, 120 * GIO, 1),
} };

// --- la proportion -----------------------------------------------------------

test('proportion : usage / limite, NON bornée (104 % est un fait)', () => {
  assert.equal(proportionRessource(4, 8), 0.5);
  assert.equal(proportionRessource(10.4, 10), 1.04);
});

test('proportion : zéro est une valeur, pas une absence (§14.6)', () => {
  assert.equal(proportionRessource(0, 8), 0);
});

test('proportion : limite absente, nulle ou négative → null, jamais 0 %', () => {
  for (const limite of [null, undefined, 0, -1, NaN, '8']) {
    assert.equal(proportionRessource(3, limite), null, `limite ${String(limite)}`);
  }
  for (const usage of [null, undefined, NaN, '3']) {
    assert.equal(proportionRessource(usage, 8), null, `usage ${String(usage)}`);
  }
});

test('le seuil est de 90 %, nommé à un seul endroit', () => {
  assert.equal(SEUIL_ALERTE_RESSOURCE, 0.9);
});

// --- l'anneau ----------------------------------------------------------------

test('anneau : décoratif (aria-hidden), piste + remplissage proportionnel', () => {
  const html = renderAnneau(0.5);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /anneau__piste/);
  const [, trait, total] = html.match(/stroke-dasharray="([\d.]+) ([\d.]+)"/);
  assert.ok(Math.abs(Number(trait) / Number(total) - 0.5) < 0.005);
  assert.equal(html.includes('anneau__part--alerte'), false);
});

test('anneau : sous le seuil, brand ; au seuil exact et au-delà, danger', () => {
  assert.equal(renderAnneau(0.89).includes('anneau__part--alerte'), false);
  assert.match(renderAnneau(0.9), /anneau__part--alerte/);
  assert.match(renderAnneau(0.97), /anneau__part--alerte/);
});

test('anneau : le dessin se borne à 100 % même quand le chiffre le dépasse', () => {
  const [, trait, total] = renderAnneau(1.04).match(/stroke-dasharray="([\d.]+) ([\d.]+)"/);
  assert.equal(trait, total);
});

test('anneau : à 0 %, la piste seule — aucun arc de longueur nulle', () => {
  assert.equal(renderAnneau(0).includes('anneau__part'), false);
});

// --- les cellules Mémoire et Disque ------------------------------------------

function vue(extra = {}) {
  return renderSparksView({
    status: 'ready',
    sparks: [spark('crm'), spark('gram')],
    usage: { crm: mesure(0.2, 3 * GIO, 9.5 * GIO), gram: mesure(0.1, 1 * GIO, 2 * GIO) },
    forge: FORGE, ...extra,
  });
}

test('cellule : les chiffres restent, et l\'anneau les accompagne', () => {
  const html = vue();
  assert.match(html, /3,0 Gio \/ 8,0 Gio/);
  assert.match(html, /class="anneau"/);
});

test('cellule : au-delà du seuil, la couleur est DOUBLÉE d\'un texte et du gras (§1.5)', () => {
  const html = vue();
  // 9,5 Gio sur 10 Gio : 95 %.
  assert.match(html, /mesure mesure--alerte/);
  assert.match(html, /95 % de la limite, proche de la limite/);
  // 3 Gio sur 8 Gio : 38 %, pas d'alerte, mais la part est dite aux lecteurs d'écran.
  assert.match(html, /37 % de la limite<\/span>/);
});

test('cellule : le pourcentage est TRONQUÉ — 89,6 % ne se dit pas 90 % sans alerte', () => {
  const html = renderSparksView({ status: 'ready', sparks: [spark('a', 'running', { memory_reservation_bytes: 8 * GIO })],
    usage: { a: mesure(0.1, 0.896 * 8 * GIO, 1 * GIO) }, projet: { name: 'p' } });
  assert.match(html, /89 % de la limite<\/span>/);
  assert.equal(html.includes('mesure--alerte'), false);
});

test('cellule : mesure absente → VIDE, pas d\'anneau (§6.14)', () => {
  const html = renderSparksView({
    status: 'ready', sparks: [spark('arret', 'stopped')],
    usage: { arret: { memory: { used_bytes: null }, disk: { used_bytes: 2 * GIO } } },
    forge: FORGE, projet: { name: 'p' },
  });
  // Mémoire vide ; le disque, lui, garde sa vraie occupation et son anneau (§20.4).
  assert.equal((html.match(/class="anneau"/g) ?? []).length, 1);
  assert.match(html, /2,0 Gio \/ 10 Gio/);
});

test('cellule : limite absente → les chiffres seuls, pas d\'anneau muet', () => {
  const html = renderSparksView({
    status: 'ready', sparks: [spark('x', 'running', { memory_reservation_bytes: null, storage_bytes: null })],
    usage: { x: mesure(0.1, 2 * GIO, 3 * GIO) }, forge: FORGE, projet: { name: 'p' },
  });
  assert.equal(html.includes('class="anneau"'), false);
  assert.match(html, /2,0 Gio/);
});

// --- le bloc « Total de la Forge » ---------------------------------------------

const bloc = (html) => html.split('<h2 id="titre-total-forge">')[1].split('<div class="carte">')[0];
const arcs = (html, classe) => [...html.matchAll(
  new RegExp(`total-anneau__arc ${classe}" [^>]*stroke-dasharray="([\\d.]+) ([\\d.]+)"`, 'g'))]
  .map((m) => Number(m[1]) / Number(m[2]));

test('bloc : un GRAPHIQUE — trois anneaux, pas une liste terme / valeur recopiée de l\'écran Forge', () => {
  const b = bloc(vue());
  assert.equal((b.match(/<svg viewBox="0 0 128 128"/g) ?? []).length, 3);
  for (const nom of ['Processeur', 'Mémoire', 'Disque']) assert.match(b, new RegExp(`<h3>${nom}`));
  // Le texte n'est que la LÉGENDE : aucune liste de définitions Utilisé / Alloué / … .
  assert.equal(b.includes('<dl'), false);
  assert.equal(b.includes('<dt>'), false);
  assert.equal((b.match(/<ul class="total-legende">/g) ?? []).length, 3);
});

test('bloc : la capacité au centre de chaque anneau, nommée', () => {
  const b = bloc(vue());
  assert.match(b, /total-anneau__centre"><strong class="technique">64 Gio<\/strong><span>capacité/);
  assert.match(b, /<strong class="technique">500 Gio<\/strong><span>capacité/);
  assert.match(b, /<strong class="technique">8,00 CPU<\/strong><span>capacité/);
});

test('bloc : la légende donne utilisé, alloué et disponible — alloué et disponible LUS de /v1/forge', () => {
  const b = bloc(vue());
  for (const nom of ['Utilisé', 'Alloué', 'Disponible']) {
    assert.equal((b.match(new RegExp(`total-legende__nom">${nom}<`, 'g')) ?? []).length, 3, nom);
  }
  assert.match(b, /Alloué<\/span><span class="technique">20 Gio/);      // mémoire
  assert.match(b, /Disponible<\/span><span class="technique">44 Gio/);   // 64 − 20
  assert.match(b, /Alloué<\/span><span class="technique">2,50 CPU/);     // CPU
  assert.match(b, /Utilisé<\/span><span class="technique">4,0 Gio/);     // 3 + 1
  assert.match(b, /Utilisé<\/span><span class="technique">12 Gio/);      // 9,5 + 2
  assert.match(b, /Utilisé<\/span><span class="technique">0,30 CPU/);    // 0,2 + 0,1
});

test('bloc : les arcs sont des parts de la capacité — l\'alloué, et l\'utilisé par-dessus', () => {
  const b = bloc(vue());
  // Mémoire : alloué 20/64 = 31,25 %, utilisé 4/64 = 6,25 %.
  const alloues = arcs(b, 'total-anneau__arc--alloue');
  const utilises = arcs(b, 'total-anneau__arc--utilise');
  assert.equal(alloues.length, 3);
  assert.equal(utilises.length, 3);
  assert.ok(alloues.some((p) => Math.abs(p - 20 / 64) < 0.002), 'part allouée de la mémoire');
  assert.ok(utilises.some((p) => Math.abs(p - 4 / 64) < 0.002), 'part utilisée de la mémoire');
});

test('bloc : alloué + disponible = capacité (les trois parts se réconcilient)', () => {
  const c = capaciteDeForge(FORGE);
  for (const cle of ['cpu', 'memoire', 'disque']) {
    assert.equal(c[cle].alloue + c[cle].disponible, c[cle].capacite, cle);
  }
});

test('bloc : au-delà de 90 % ALLOUÉ, arc rouge + gras + texte (§1.5) ; l\'utilisé n\'alerte pas', () => {
  const plein = { pools: { ...FORGE.pools, storage: pool(500 * GIO, 460 * GIO, 1) } };
  const b = bloc(vue({ forge: plein }));
  assert.match(b, /total-anneau__arc total-anneau__arc--alerte"/);
  assert.match(b, /total-legende__pastille--alerte/);
  assert.match(b, /mesure--alerte"><span class="total-legende__pastille[^>]*><\/span><span class="total-legende__nom">Alloué<\/span><span class="technique">460 Gio<span class="sr-only">, proche de la limite/);
  assert.equal(bloc(vue()).includes('--alerte'), false);
  const burst = renderBlocTotal([spark('a')], { a: mesure(7.9, 60 * GIO, 1 * GIO) }, FORGE);
  assert.equal(burst.includes('--alerte'), false);
});

test('bloc : l\'utilisé qui dépasse l\'alloué (burst CPU) se dessine borné, et se lit en entier', () => {
  const html = renderBlocTotal([spark('a')], { a: mesure(9, 1 * GIO, 1 * GIO) }, FORGE);
  assert.ok(arcs(html, 'total-anneau__arc--utilise').every((p) => p <= 1));
  assert.match(html, /Utilisé<\/span><span class="technique">9,00 CPU/);
});

test('bloc : CPU et mémoire portent « surengagé ×N », jamais le disque', () => {
  const b = bloc(vue());
  assert.match(b, /Mémoire <span class="badge badge--accent">surengagé ×1,5/);
  assert.equal((b.match(/surengagé/g) ?? []).length, 1);
});

test('bloc : l\'utilisé du CPU exclut les Sparks à cœurs dédiés, et le dit', () => {
  const html = renderBlocTotal(
    [spark('a'), spark('d', 'running', { cpu_mode: 'dedicated', cpu_cores: 2 })],
    { a: mesure(0.2, 1 * GIO, 1 * GIO), d: mesure(1.8, 1 * GIO, 1 * GIO) }, FORGE);
  assert.match(html, /Utilisé<\/span><span class="technique">0,20 CPU/);
  assert.match(html, /Sparks à cœurs dédiés exclus/);
});

test('bloc : les notes d\'une ressource tiennent en UNE ligne', () => {
  // `a` est partagé et sans CPU mesuré, `d` est dédié : deux notes sur le CPU.
  const html = renderBlocTotal(
    [spark('a'), spark('d', 'running', { cpu_mode: 'dedicated', cpu_cores: 2 })],
    { a: { memory: { used_bytes: 1 * GIO }, disk: { used_bytes: 1 * GIO } } }, FORGE);
  assert.match(html, /<p class="total__note">0 Spark sur 1 mesuré · Sparks à cœurs dédiés exclus<\/p>/);
});

test('bloc : seulement dans l\'onglet « Tous » — jamais dans celui d\'un projet', () => {
  assert.match(vue(), /total-forge/);
  assert.equal(vue({ projet: { name: 'side-projects' } }).includes('total-forge'), false);
});

test('bloc : il est SÉPARÉ du tableau — avant lui, et aucun pied de tableau', () => {
  const html = vue();
  assert.ok(html.indexOf('total-forge') < html.indexOf('<table>'));
  assert.equal(html.includes('<tfoot'), false);
});

test('bloc : une somme partielle le DIT (un Spark arrêté n\'a pas de mémoire mesurée)', () => {
  const html = renderBlocTotal([spark('a'), spark('b', 'stopped')], {
    a: mesure(0.2, 3 * GIO, 1 * GIO), b: { memory: { used_bytes: null }, disk: { used_bytes: 2 * GIO } } }, FORGE);
  assert.match(html, /1 Spark sur 2 mesuré/);
});

test('bloc : capacité non relevée → l\'utilisé reste, l\'absence est NOMMÉE', () => {
  const html = bloc(vue({ forge: null }));
  assert.match(html, /Capacité de la Forge non relevée/);
  assert.match(html, /Utilisé<\/span><span class="technique">4,0 Gio/);
  for (const terme of ['Alloué', 'Disponible']) {
    assert.equal(html.includes(`total-legende__nom">${terme}<`), false, `pas de « ${terme} » inventé`);
  }
  // Pas de capacité : rien à découper, donc pas d'anneau.
  assert.equal(html.includes('<svg'), false);
});

test('bloc : aucune mesure du tout → « Mesure en cours » ou « Aucune mesure », jamais zéro (§14.6)', () => {
  const html = renderBlocTotal([spark('a')], {}, FORGE);
  assert.match(html, /Mesure en cours/);
  assert.equal(/Utilisé<\/span><span class="technique">0/.test(html), false);
  const arretes = renderBlocTotal([spark('a', 'stopped')], {}, FORGE);
  assert.equal(arretes.includes('Mesure en cours'), false);
  assert.match(arretes, /Aucune mesure/);
});

test('capacité : lue des pools de /v1/forge, null par ressource manquante', () => {
  assert.deepEqual(capaciteDeForge(FORGE).memoire,
    { capacite: 64 * GIO, alloue: 20 * GIO, disponible: 44 * GIO, surengagement: 1.5 });
  assert.deepEqual(capaciteDeForge({ pools: { cpu: pool(8, 1) } }).disque, null);
  assert.equal(capaciteDeForge({}), null);
  assert.equal(capaciteDeForge(null), null);
});

test('sommerMesures : zéro est une mesure, null n\'en est pas une', () => {
  const r = sommerMesures([spark('a'), spark('b'), spark('c')],
    { a: { memory: { used_bytes: 0 } }, b: { memory: { used_bytes: null } } },
    (u) => u.memory?.used_bytes);
  assert.deepEqual(r, { somme: 0, mesures: 1, sparks: 3 });
});
