/**
 * @verifies docs/BACKLOG.md#SPK-43 · docs/DAT.md §37.2 (un Spark sans `sshd`),
 *           §37.4 (le contrat), §37.4.3 (la limite du redimensionnement) ·
 *           docs/DESIGN_SYSTEM_APP.md SPK-DS-04 · docs/DESIGN_SYSTEM.md §6.13
 *
 * SPK-DS-04 : l'état protégé et le chemin employé restent affichés PENDANT toute
 * la session. Les montrer à l'ouverture seulement laisserait oublier par quel
 * chemin on est entré.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderTerminal, TERMINAL_VIDE, CHAMP_TERMINAL } from './spark-terminal.js';

const SPARK = { name: 'crm', ipv4_address: '10.77.0.16', protected: 0 };
const etat = (surcharge = {}) => ({ ...TERMINAL_VIDE, ...surcharge });

test('fermé, l’écran propose d’OUVRIR et la saisie est désactivée', () => {
  const rendu = renderTerminal(SPARK);
  assert.ok(rendu.includes('Ouvrir un terminal'));
  assert.match(rendu, /id="terminal-entree"[^>]*disabled/);
});

test('pendant l’ouverture, le bouton le DIT et ne se re-clique pas', () => {
  const rendu = renderTerminal(SPARK, etat({ status: 'ouverture' }));
  assert.ok(rendu.includes('Ouverture…'));
  assert.match(rendu, /data-terminal="ouvrir"[^>]*disabled/);
});

test('ouvert, la saisie est active et la session peut se fermer', () => {
  const rendu = renderTerminal(SPARK, etat({
    status: 'ouvert', session: { id: 'a', path: 'ssh' } }));
  assert.ok(!/id="terminal-entree"[^>]*disabled/.test(rendu));
  assert.ok(rendu.includes('Fermer la session'));
});

// --- SPK-DS-04 : ce qui reste affiché PENDANT toute la session --------------

test('le CHEMIN employé est affiché en permanence, pas seulement à l’ouverture', () => {
  const rendu = renderTerminal(SPARK, etat({
    status: 'ouvert', session: { id: 'a', path: 'ssh' } }));
  assert.ok(rendu.includes('>ssh<'), 'on ne doit pas oublier par quel chemin on est entré');
});

test('un Spark PROTÉGÉ le dit pendant toute la session', () => {
  const rendu = renderTerminal({ ...SPARK, protected: 1 }, etat({ status: 'ouvert' }));
  assert.ok(rendu.includes('Spark protégé'));
  assert.ok(rendu.includes('badge--accent'), 'un gel est un accent, pas un danger');
});

test('l’écran PRÉVIENT que quitter l’onglet termine la session', () => {
  // §37.4 : une session qui survivrait à son écran serait un shell root
  // abandonné dont personne ne se souvient.
  assert.ok(renderTerminal(SPARK, etat({ status: 'ouvert' }))
    .includes('termine</strong> la session'));
});

test('le terminal ne porte AUCUN bouton d’action Docker', () => {
  // SPK-DS-04 : ces gestes appartiennent à l'onglet Docker, où ils sont nommés
  // et confirmés. Un bouton posé à côté d'un shell laisserait croire que les
  // deux font la même chose de deux façons.
  const rendu = renderTerminal(SPARK, etat({ status: 'ouvert' }));
  assert.ok(!/docker/i.test(rendu));
  assert.ok(!/démarrer|arrêter|redémarrer/i.test(rendu));
});

// --- les états à traiter (§6.13, §37.2) -------------------------------------

test('un Spark SANS cellule est nommé, pas rendu par une erreur technique', () => {
  // RÉVISÉ : la preuve parlait d'ADRESSE. Mesuré depuis, l'adresse est attribuée
  // dès l'écriture au registre (§15.1) — un Spark « pending » porte déjà la
  // sienne. Le signal est la CELLULE. Ce que la preuve établit — l'écran nomme
  // ce qui manque, et n'offre aucune saisie — est inchangé.
  const rendu = renderTerminal(SPARK, etat({
    status: 'refus',
    refus: { error: 'spark_not_reachable',
             message: 'Le Spark « neuf » n’a pas encore de cellule.' } }));
  assert.ok(rendu.includes('pas encore de cellule'));
  assert.ok(rendu.includes('doit être <strong>créé</strong>'));
  assert.ok(!rendu.includes('terminal-entree'), 'aucune saisie n’est offerte');
});

test('un refus quelconque s’affiche SANS le commentaire du Spark non créé', () => {
  const rendu = renderTerminal(SPARK, etat({
    status: 'refus', refus: { error: 'tunnel_unavailable',
                              message: 'Tunnel vers « prod » indisponible.' } }));
  assert.ok(rendu.includes('Tunnel vers'));
  assert.ok(!rendu.includes('doit être créé'));
});

test('l’avis d’inactivité s’affiche en accent, pas en danger', () => {
  // C'est un préavis, pas une panne : la session vit encore (§37.4.2).
  const rendu = renderTerminal(SPARK, etat({
    status: 'ouvert', avertissement: 'Cette session se fermera dans 60 s.' }));
  assert.ok(rendu.includes('Cette session se fermera'));
  assert.ok(rendu.includes('avertissement'));
  assert.ok(!rendu.includes('class="refus"'));
});

test('le motif de fermeture est dit en FRANÇAIS, pas en jeton technique', () => {
  // §14.7 : une valeur technique brute n'atteint pas l'écran.
  // L'écran ÉCHAPPE ce qu'il rend : une apostrophe y devient une entité. On lit
  // donc le texte décodé, sinon la preuve mesurerait l'échappement.
  const lisible = (html) => html.replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  for (const [motif, attendu] of [
    ['inactivite', "faute d'activité"],
    ['distant_termine', 'shell distant'],
    ['flux_ferme', 'connexion a été interrompue'],
  ]) {
    const rendu = lisible(renderTerminal(SPARK, etat({ fin: motif })));
    assert.ok(rendu.includes(attendu), motif);
    assert.ok(!rendu.includes(motif), `« ${motif} » ne doit pas atteindre l’écran`);
  }
});

// --- le mode lecteur d'écran (SPK-DS-04) ------------------------------------

test('le mode lecteur d’écran est ACTIVABLE et son état se voit', () => {
  const eteint = renderTerminal(SPARK, etat({ status: 'ouvert' }));
  assert.ok(eteint.includes('Mode lecteur d’écran'));
  assert.ok(!/data-terminal="lecteur"[^>]*checked/.test(eteint));

  const allume = renderTerminal(SPARK, etat({ status: 'ouvert', lecteurEcran: true }));
  assert.match(allume, /data-terminal="lecteur"[^>]*checked/);
});

test('le mode lecteur d’écran fait du terminal une région ANNONCÉE', () => {
  // Un terminal est utilisable au clavier par construction, mais il n'est pas
  // LISIBLE par défaut : sans cela, la sortie défile sans être lue.
  const allume = renderTerminal(SPARK, etat({ status: 'ouvert', lecteurEcran: true }));
  assert.match(allume, /role="log"/);
  assert.match(allume, /aria-live="polite"/);

  const eteint = renderTerminal(SPARK, etat({ status: 'ouvert' }));
  assert.match(eteint, /role="region"/);
  assert.ok(!eteint.includes('aria-live'));
});

test('la sortie a un conteneur nommé, atteignable au clavier', () => {
  const rendu = renderTerminal(SPARK, etat({ status: 'ouvert' }));
  assert.ok(rendu.includes(`id="${CHAMP_TERMINAL}"`));
  assert.match(rendu, /tabindex="0"/);
  assert.ok(rendu.includes('aria-label="Sortie du terminal"'));
});

test('la limite du redimensionnement est DITE, pas laissée à découvrir', () => {
  // §37.4.3 : « stty » ne réveille pas un programme plein écran déjà en cours.
  const rendu = renderTerminal(SPARK, etat({ status: 'ouvert' }));
  assert.ok(rendu.includes('déjà lancé'));
  assert.ok(rendu.includes('relancer'));
});

test('sans Spark, l’écran ne rend RIEN plutôt qu’un cadre vide', () => {
  assert.equal(renderTerminal(null), '');
});
