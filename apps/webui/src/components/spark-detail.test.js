/**
 * @verifies docs/BACKLOG.md#SPK-19 · docs/DAT.md §24 ·
 *           docs/DESIGN_SYSTEM.md §6.4, §6.22, §6.23, §14.5, §14.9
 *
 * Le coeur de l'unite : les commandes viennent du RUNTIME. Ces tests verifient
 * que la vue n'en invente aucune et n'en cache aucune.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderSparkDetail, renderCommands, renderDetailNotFound, renderProtection, COMMANDES,
} from './spark-detail.js';

const GIO = 1024 ** 3;
const SPARK = {
  name: 'crm-production', state: 'running', cpu_mode: 'shared', cpu_reservation: 0.5,
  memory_reservation_bytes: 2 * GIO, storage_bytes: 10 * GIO,
  network_burst_bps: 100_000_000, ipv4_address: '10.77.0.16', image: 'images:debian/13',
  allowed_commands: ['delete', 'restart', 'stop'], transient: false, last_error: null,
};

// --- les commandes viennent du runtime (§24.1) ------------------------------

test('seules les commandes publiees par le runtime sont rendues', () => {
  const html = renderCommands(SPARK);
  for (const attendu of ['Arrêter', 'Redémarrer', 'Supprimer'])
    assert.ok(html.includes(attendu), `${attendu} attendu`);
  // « Démarrer » n'est pas dans allowed_commands : il ne doit pas apparaitre,
  // meme desactive (§24.1).
  assert.equal(html.includes('Démarrer'), false);
  assert.equal(html.includes('disabled'), false);
});

test('la vue ne connait pas la machine a etats', () => {
  // Un etat inconnu du frontal, avec des commandes publiees : elles passent.
  const html = renderCommands({ ...SPARK, state: 'etat-futur', allowed_commands: ['delete'] });
  assert.ok(html.includes('Supprimer'));
  assert.equal(html.includes('Arrêter'), false);
});

test('un etat transitoire le DIT au lieu d afficher des boutons morts', () => {
  const html = renderCommands({ ...SPARK, state: 'creating', allowed_commands: [], transient: true });
  assert.match(html, /Une opération est en cours/);
  assert.match(html, /Aucune commande n’est acceptée/);
  assert.equal(html.includes('<button'), false);
  assert.match(html, /role="status"/);
});

test('aucune commande possible hors transitoire est dit aussi', () => {
  const html = renderCommands({ ...SPARK, allowed_commands: [], transient: false });
  assert.match(html, /Aucune commande disponible/);
});

// --- confirmations (§24.2, §6.22, §6.23) ------------------------------------

test('seule la suppression demande une confirmation', () => {
  const confirmantes = Object.entries(COMMANDES).filter(([, c]) => c.confirme).map(([n]) => n);
  assert.deepEqual(confirmantes, ['delete']);
});

test('la confirmation NOMME le Spark et la consequence', () => {
  const html = renderCommands(SPARK, { confirming: 'delete' });
  assert.match(html, /Supprimer « crm-production » \?/);
  assert.match(html, /disque et ses instantanés/);
  assert.match(html, /bouton--destructif/);
  assert.match(html, /Annuler/);
});

test('la confirmation est integree au flux, pas une modale', () => {
  const html = renderCommands(SPARK, { confirming: 'delete' });
  // Pas de voile, pas de dialog : §6.22 evite le piege de focus et l'Echap global.
  assert.equal(/role="dialog"|aria-modal|voile/.test(html), false);
  assert.match(html, /role="group"/);
});

test('sans confirmation en cours, aucun bouton destructif final', () => {
  assert.equal(renderCommands(SPARK).includes('bouton--destructif'), false);
});

// --- l identite d abord (§6.3, §24.3) ---------------------------------------

test('le nom et l etat precedent les ressources', () => {
  // Revise avec SPK-33 : la fenetre repartit ses facettes en onglets (§6.27), et
  // les instantanes ne sont plus sur l'apercu. Ce qui reste verifie — l'identite
  // avant le contenu — est le point du §24.3, et il ne change pas.
  const html = renderSparkDetail({ status: 'ready', spark: SPARK });
  assert.ok(html.indexOf('crm-production') < html.indexOf('Ressources'));
  assert.ok(html.indexOf('crm-production') < html.indexOf('Facettes'),
    'l’identite precede aussi les onglets');
});

test('les paires terme/valeur utilisent dl/dt/dd', () => {
  const html = renderSparkDetail({ status: 'ready', spark: SPARK });
  for (const balise of ['<dl', '<dt>', '<dd']) assert.ok(html.includes(balise));
});

// --- absences nommees (§6.4, §14.5) -----------------------------------------

test('une absence qui informe est NOMMEE', () => {
  // Revise avec SPK-33 : chaque absence se lit desormais dans SA facette. Une
  // surface a un sujet et un seul (§5.4, point 2).
  const rendu = (facette) => renderSparkDetail({
    status: 'ready', spark: SPARK, routes: [], keys: [], snapshots: [], facette });
  assert.match(rendu('routes'), /Aucune route publique/);
  assert.match(rendu('cles'), /Aucune clé n’est autorisée : personne ne peut s’y connecter/);
  assert.match(rendu('instantanes'), /Aucun instantané/);
});

test('une valeur absente n est simplement PAS rendue', () => {
  const html = renderSparkDetail({
    status: 'ready', spark: { ...SPARK, ipv4_address: null, image: null },
  });
  assert.equal(html.includes('Adresse privée'), false);
  assert.equal(/—<\/dd>|N\/A/.test(html), false);
});

test('les trois absences de mesure restent distinctes', () => {
  const arrete = renderSparkDetail({ status: 'ready', spark: { ...SPARK, state: 'stopped' } });
  const attente = renderSparkDetail({ status: 'ready', spark: SPARK, usage: { cpu: { used: null } } });
  assert.match(arrete, /aucune mesure d’exécution/);
  assert.match(attente, /Mesure en cours/);
});

// --- etats de la vue --------------------------------------------------------

test('chargement, erreur et introuvable sont distincts', () => {
  assert.match(renderSparkDetail({ status: 'loading' }), /squelette/);
  assert.match(renderSparkDetail({ status: 'error', error: { message: 'tunnel rompu' } }), /tunnel rompu/);
  assert.match(renderDetailNotFound(), /n’existe pas/);
});

test('la derniere erreur du Spark est montree', () => {
  const html = renderSparkDetail({
    status: 'ready', spark: { ...SPARK, state: 'error', last_error: 'image introuvable',
                              allowed_commands: ['delete', 'retry'] },
  });
  assert.match(html, /Dernière erreur : image introuvable/);
  assert.match(html, /Reprendre/);
});

test('le contenu venant du backend est echappe', () => {
  const html = renderSparkDetail({
    status: 'ready', spark: { ...SPARK, name: '<img src=x onerror=alert(1)>' },
  });
  assert.equal(/<img src=x/.test(html), false);
});

// --- journal : forme distincte (§14.8) --------------------------------------

test('un evenement de journal est une ligne, pas une carte', () => {
  const html = renderSparkDetail({
    status: 'ready', spark: SPARK,
    audit: [{ ts: '2026-08-19T10:00:00', action: 'spark.start', result: 'ok', message: 'démarré' }],
    facette: 'journal',
  });
  assert.match(html, /class="evenement"/);
  assert.equal(/class="carte"[^>]*>\s*<li/.test(html), false);
});


// --- ordre des commandes (defaut trouve en capture) -------------------------

test("l action destructive n est jamais la premiere", () => {
  // Le runtime publie allowed_commands trie alphabetiquement, ce qui placait
  // « Supprimer » en tete : l'action la plus dangereuse etait la plus
  // proeminente et la premiere atteinte au clavier.
  const html = renderCommands(SPARK);
  const positions = ['Arrêter', 'Redémarrer', 'Supprimer'].map((l) => html.indexOf(l));
  assert.equal(Math.max(...positions), html.indexOf('Supprimer'));
});

test("une action reparatrice vient en premier", () => {
  const html = renderCommands({ ...SPARK, state: 'error', allowed_commands: ['delete', 'retry'] });
  assert.ok(html.indexOf('Reprendre') < html.indexOf('Supprimer'));
});

// --- valeurs techniques traduites (§14.7) -----------------------------------

test("le resultat d audit est affiche en francais, pas en brut", () => {
  const html = renderSparkDetail({
    status: 'ready', spark: SPARK,
    audit: [{ ts: '2026-08-19T10:00', action: 'a', result: 'denied', message: 'refus' }],
    facette: 'journal',
  });
  assert.match(html, /refusé/);
  assert.equal(/>denied</.test(html), false);
});

test("un resultat inconnu ne casse pas l affichage", () => {
  const html = renderSparkDetail({
    status: 'ready', spark: SPARK,
    audit: [{ ts: '2026-08-19T10:00', action: 'a', result: 'bizarre', message: 'x' }],
    facette: 'journal',
  });
  assert.match(html, /badge--neutral/);
  assert.equal(/undefined/.test(html), false);
});


// --- la protection (SPK-34, docs/DAT.md §35) --------------------------------

const PROTEGE = { ...SPARK, protected: true, protected_at: '2026-08-19T10:00:00',
                  allowed_commands: [] };

test('un Spark protege ne montre AUCUNE commande, et dit pourquoi', () => {
  // §24.1 : le runtime ne publie plus rien. Sans le cas explicite, l'ecran
  // dirait « aucune commande dans cet etat » — la mauvaise cause.
  const html = renderCommands(PROTEGE);
  for (const absent of ['Arrêter', 'Redémarrer', 'Supprimer'])
    assert.ok(!html.includes(absent), `${absent} ne doit pas etre propose`);
  assert.match(html, /protégé/);
  assert.ok(!html.includes('dans cet état'), 'la cause nommee doit etre la protection');
});

test("la section dit son etat DANS LES DEUX SENS", () => {
  // §35.4 : un Spark desarme le dit aussi clairement, pour que l'oubli de
  // rearmement se voie.
  assert.match(renderProtection(PROTEGE), /Armée/);
  assert.match(renderProtection(SPARK), /Désarmée/);
  assert.match(renderProtection(PROTEGE), /Lever la protection/);
  assert.match(renderProtection(SPARK), /Armer la protection/);
});

test("l'ecran ne presente JAMAIS la protection comme une frontiere de securite", () => {
  // §35.1 : c'est un garde-fou. L'ecran est le premier endroit ou l'on serait
  // tente de laisser croire le contraire.
  const html = renderProtection(PROTEGE);
  assert.match(html, /n’est pas un\s+contrôle d’accès/s);
  assert.match(html, /Retirer un accès n’est jamais bloqué/);
});

test('la saisie du mot de passe passe par la MODALE de la section (§6.27)', () => {
  const ferme = renderProtection(PROTEGE, { open: null, values: {} });
  assert.ok(!ferme.includes('<dialog'), 'rien tant qu’on n’a rien demande');
  const ouvert = renderProtection(PROTEGE,
    { open: 'protection', values: { password: '' } });
  assert.match(ouvert, /<dialog class="modale" id="protection"/);
  assert.match(ouvert, /id="protection-titre">Protection</);
  // Le champ est de type `password` : il ne s'affiche pas en clair a l'ecran.
  assert.match(ouvert, /id="protection-mot"[^>]*type="password"/s);
  assert.match(ouvert, /data-engage="protection"[^>]*>Lever la protection</s);
});

test("l'absence de recuperation est DITE, pas laissee a decouvrir", () => {
  // §35.3 : il n'y a aucune recuperation par l'API. Le taire ferait chercher un
  // mecanisme de secours qui n'existe pas.
  const html = renderProtection(PROTEGE, { open: 'protection', values: {} });
  assert.match(html, /aucune récupération/);
});
