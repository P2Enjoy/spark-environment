/**
 * @verifies docs/BACKLOG.md#SPK-173 · docs/DAT.md §68 (l'anneau de Mémoire et de
 *           Disque, la ligne des totaux de l'onglet « Tous ») ·
 *           docs/DESIGN_SYSTEM_APP.md SPK-DS-44 · docs/DESIGN_SYSTEM.md §1.5
 *           (la couleur ne porte jamais seule), §6.14 (une absence reste vide),
 *           §14.6 (zéro n'est pas inconnu)
 *
 * Ce que ces preuves verrouillent : la part se calcule, se borne au dessin et
 * pas au chiffre, bascule au seuil avec autre chose que la couleur ; une mesure
 * ou une limite absente ne produit PAS un anneau vide ; la ligne des totaux
 * somme ce qui est mesuré, dit ce qu'elle n'a pas pu mesurer, nomme la capacité
 * qu'elle n'a pas, et n'existe que dans l'onglet « Tous ».
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderSparksView, renderAnneau, renderTotaux, capaciteDeForge, sommerMesures }
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
const FORGE = {
  cpu: { cores_total: 8 }, memory: { total_bytes: 64 * GIO },
  pools: { storage: { capacity: 500 * GIO } },
};

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
  const html = renderTotaux([spark('a')], { a: mesure(0.1, 0.896 * 8 * GIO, 1 * GIO) },
    { cpu: { cores_total: 8 }, memory: { total_bytes: 8 * GIO }, pools: { storage: { capacity: 500 * GIO } } });
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

// --- la ligne des totaux -------------------------------------------------------

test('totaux : somme des mesures face à la capacité PHYSIQUE de la Forge', () => {
  const html = vue();
  assert.match(html, /<tfoot>/);
  assert.match(html, /scope="row"[^>]*>Total/);
  assert.match(html, /4,0 Gio \/ 64 Gio/);        // mémoire : 3 + 1 sur 64
  assert.match(html, /12 Gio \/ 500 Gio/);          // disque : 9,5 + 2 = 11,5 (arrondi à 12) sur 500
  assert.match(html, /0,30 sur 8 cœurs/);           // CPU : 0,2 + 0,1 sur 8
});

test('totaux : le CPU garde sa forme de colonne, la barre', () => {
  const pied = vue().split('<tfoot>')[1];
  assert.match(pied, /class="jauge"/);
});

test('totaux : seulement dans l\'onglet « Tous » — jamais dans celui d\'un projet', () => {
  assert.match(vue(), /<tfoot>/);
  assert.equal(vue({ projet: { name: 'side-projects' } }).includes('<tfoot>'), false);
});

test('totaux : une somme partielle le DIT (un Spark arrêté n\'a pas de mémoire mesurée)', () => {
  const html = renderSparksView({
    status: 'ready', sparks: [spark('a'), spark('b', 'stopped')],
    usage: { a: mesure(0.2, 3 * GIO, 1 * GIO), b: { memory: { used_bytes: null }, disk: { used_bytes: 2 * GIO } } },
    forge: FORGE,
  });
  assert.match(html, /1 Spark sur 2 mesuré/);
});

test('totaux : capacité non relevée → la somme reste, l\'absence est NOMMÉE', () => {
  const html = vue({ forge: null });
  assert.match(html, /Capacité de la Forge non relevée/);
  assert.match(html, /4,0 Gio/);
  assert.equal(html.split('<tfoot>')[1].includes('class="anneau"'), false);
});

test('totaux : aucune mesure du tout → des cellules vides, pas des zéros (§14.6)', () => {
  const html = renderTotaux([spark('a')], {}, FORGE);
  assert.equal(/0,0 CPU|0 o/.test(html), false);
  // Le premier relevé n'a pas de fenêtre : la cellule CPU le dit, comme les lignes.
  assert.match(html, /Mesure en cours/);
});

test('totaux : aucun Spark en marche, aucune mesure → la cellule CPU reste vide', () => {
  const html = renderTotaux([spark('a', 'stopped')], {}, FORGE);
  assert.equal(html.includes('Mesure en cours'), false);
});

test('totaux : le total mémoire au-delà de 90 % de la machine passe en alerte', () => {
  const html = renderTotaux([spark('a')], { a: mesure(0.1, 60 * GIO, 1 * GIO) }, FORGE);
  assert.match(html, /mesure--alerte/);
  assert.match(html, /proche de la limite/);
});

test('capacité : lue des champs de /v1/forge, null par grandeur manquante', () => {
  assert.deepEqual(capaciteDeForge(FORGE), { cpu: 8, memoire: 64 * GIO, disque: 500 * GIO });
  assert.deepEqual(capaciteDeForge({}), { cpu: null, memoire: null, disque: null });
  assert.equal(capaciteDeForge(null), null);
});

test('sommerMesures : zéro est une mesure, null n\'en est pas une', () => {
  const r = sommerMesures([spark('a'), spark('b'), spark('c')],
    { a: { memory: { used_bytes: 0 } }, b: { memory: { used_bytes: null } } },
    (u) => u.memory?.used_bytes);
  assert.deepEqual(r, { somme: 0, mesures: 1, sparks: 3 });
});
