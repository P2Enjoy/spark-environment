/**
 * @verifies docs/BACKLOG.md#SPK-104 · docs/DAT.md §54.2 (ce que chaque note est
 * censée porter), §54.4, §54.9, §54.10 (les trois états, le refus qui ne perd
 * pas la saisie) · docs/BACKLOG.md#SPK-105 · docs/DAT.md §55.5 (consulter ne
 * consomme pas), §55.9 · docs/DESIGN_SYSTEM.md §14.5, §14.6, §1.3, §1.5 bis,
 * §9.9
 *
 * Ce que ces preuves gardent : « personne n'a encore écrit » et « texte vide »
 * sont deux écrans, un refus n'efface jamais la saisie, et une version proposée
 * se lit À CÔTÉ de celle qu'elle remplacerait — jamais à sa place.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NOTES_VIDE, renderNotes } from './spark-notes.js';

const SPARK = { name: 'sso' };

const NOTE = (champs = {}) => ({
  id: 'readme', file: 'README.md', title: 'README',
  expected: 'Ce qu’est ce Spark et à quoi il sert.',
  path: '/etc/spark/notes/README.md',
  body: '', revision: 0, origin: null, updated_at: null, written: false,
  ...champs,
});

const ui = (champs = {}) => ({
  ...NOTES_VIDE, status: 'pret', cellLue: true,
  items: [NOTE()], ...champs,
});

test('l’en-tête dit que le produit TRANSPORTE ces textes sans les vérifier', () => {
  const rendu = renderNotes(SPARK, ui());
  assert.match(rendu, /ne les vérifie pas\s*:\s*il les transporte/);
  // Ils partent vers un tiers : l'avertissement doit être là où on écrit.
  assert.match(rendu, /N’y écrivez aucun secret/);
  assert.match(rendu, /\/etc\/spark\/notes\//);
});

test('« personne n’a encore écrit » n’est PAS « texte vide » (§14.6)', () => {
  const jamais = renderNotes(SPARK, ui({ items: [NOTE()] }));
  assert.match(jamais, /Personne n’a encore écrit cette note/);

  const vide = renderNotes(SPARK, ui({
    items: [NOTE({ written: true, revision: 1, origin: 'console', body: '' })] }));
  assert.doesNotMatch(vide, /Personne n’a encore écrit/);
  assert.match(vide, /Révision 1/);
});

test('l’origine se lit en français, et distingue la console de la proposition', () => {
  const console_ = renderNotes(SPARK, ui({
    items: [NOTE({ written: true, revision: 2, origin: 'console' })] }));
  assert.match(console_, /écrite depuis la console/);

  const sugg = renderNotes(SPARK, ui({
    items: [NOTE({ written: true, revision: 2, origin: 'suggestion' })] }));
  assert.match(sugg, /écrite depuis une proposition acceptée/);
});

test('ce que la note est CENSÉE porter est rendu avec elle (§54.2)', () => {
  const rendu = renderNotes(SPARK, ui());
  assert.match(rendu, /Ce qu’est ce Spark et à quoi il sert/);
});

test('le titre est le NOM DU FICHIER, dit une seule fois', () => {
  // Vu à l'écran : « README README.md » répétait le même mot deux fois, et
  // passait sur deux lignes à 390 px. Le nom du fichier suffit — c'est lui
  // qu'on retrouvera dans la cellule.
  const rendu = renderNotes(SPARK, ui());
  assert.match(rendu, /<h2 id="titre-note-readme" class="technique">README\.md<\/h2>/);
  assert.doesNotMatch(rendu, /README\s+README\.md/);
  // Et le chemin exact est dit : on doit pouvoir aller le lire.
  assert.match(rendu, /Dans la cellule[\s\S]*?\/etc\/spark\/notes\/README\.md/);
});

test('« Enregistrer » est DÉSACTIVÉ tant que rien n’a changé (§9.9)', () => {
  const inchange = renderNotes(SPARK, ui({
    items: [NOTE({ written: true, body: 'a', revision: 1 })] }));
  assert.match(inchange, /data-note-enregistrer="readme"[^>]*disabled/);
  assert.doesNotMatch(inchange, /data-note-annuler/);

  const modifie = renderNotes(SPARK, ui({
    items: [NOTE({ written: true, body: 'a', revision: 1 })],
    brouillons: { readme: 'a modifié' } }));
  assert.doesNotMatch(modifie, /data-note-enregistrer="readme"[^>]*disabled/);
  // Pouvoir revenir en arrière fait partie du geste : sans cela, la seule façon
  // d'abandonner une saisie est de recharger la page.
  assert.match(modifie, /data-note-annuler="readme"/);
});

test('le bouton porte la RÉVISION éditée : c’est elle qui part au serveur', () => {
  const rendu = renderNotes(SPARK, ui({
    items: [NOTE({ written: true, body: 'a', revision: 7 })],
    brouillons: { readme: 'b' } }));
  assert.match(rendu, /data-note-enregistrer="readme"[^>]*data-revision="7"/);
});

test('un refus de révision montre les DEUX textes et NE PERD PAS la saisie', () => {
  const rendu = renderNotes(SPARK, ui({
    items: [NOTE({ written: true, body: 'du registre', revision: 3 })],
    brouillons: { readme: 'ce que je tapais' },
    conflit: { id: 'readme', note: { body: 'venu d’ailleurs', revision: 4 } },
  }));
  // §1.5 bis : la saisie reste dans le champ.
  assert.match(rendu, /<textarea[^>]*>ce que je tapais<\/textarea>/);
  // Et le texte courant est lisible à côté, replié mais ouvert.
  assert.match(rendu, /Ce que le registre porte aujourd’hui/);
  assert.match(rendu, /venu d’ailleurs/);
  assert.match(rendu, /data-note-reprendre="readme"/);
  assert.match(rendu, /Rien n’a\s*\n?\s*été écrit/);
});

test('un conflit ne dit PAS deux fois la même mauvaise nouvelle (§6.11)', () => {
  // « Deux états contradictoires ne sont jamais affichés simultanément ». Le
  // bloc de conflit porte déjà le refus ; répéter le message du serveur au
  // -dessous ferait lire deux fois la même chose.
  const rendu = renderNotes(SPARK, ui({
    items: [NOTE({ written: true, body: 'a', revision: 3 })],
    conflit: { id: 'readme', note: { body: 'b', revision: 4 } },
    issue: { id: 'readme', ok: false, message: 'Ce texte a changé.' },
  }));
  assert.equal(rendu.match(/role="alert"/g).length, 1);
  assert.doesNotMatch(rendu, /<p class="refus"/);
});

test('le succès ne s’affiche qu’avec son issue, jamais d’avance (§1.3)', () => {
  const sans = renderNotes(SPARK, ui());
  assert.doesNotMatch(sans, /class="succes"/);

  const avec = renderNotes(SPARK, ui({
    issue: { id: 'readme', ok: true, message: 'Note enregistrée.' } }));
  assert.match(avec, /class="succes"[^>]*role="status"/);
  assert.match(avec, /Note enregistrée\./);
});

test('un refus du serveur est un REFUS, pas un avertissement décoratif', () => {
  const rendu = renderNotes(SPARK, ui({
    issue: { id: 'readme', ok: false,
             message: 'Ce texte contient la valeur du secret « SMTP_PASSWORD ».' } }));
  assert.match(rendu, /class="refus"[^>]*role="alert"/);
  assert.match(rendu, /SMTP_PASSWORD/);
});

// --- les propositions venues de la cellule (SPK-105, §55.9) -----------------

test('une version proposée se lit À CÔTÉ de celle qu’elle remplacerait', () => {
  const rendu = renderNotes(SPARK, ui({
    items: [NOTE({ written: true, body: 'la version du registre', revision: 1 })],
    propositions: [{ kind: 'readme', present: true, body: 'la version proposée',
                     sha256: 'abc123' }],
  }));
  // Les deux sont là : accepter un remplacement intégral sans voir ce qu'on
  // remplace serait décider à l'aveugle.
  assert.match(rendu, /<textarea[^>]*>la version du registre<\/textarea>/);
  assert.match(rendu, /la version proposée/);
  assert.match(rendu, /remplacerait ce texte en entier/);
  assert.match(rendu, /data-note-accepter="readme"[^>]*data-sha="abc123"/);
  assert.match(rendu, /data-note-refuser="readme"[^>]*data-sha="abc123"/);
});

test('l’écran dit que LIRE ne consomme pas, et qu’une décision vide (§55.5)', () => {
  const rendu = renderNotes(SPARK, ui({
    propositions: [{ kind: 'readme', present: true, body: 'x', sha256: 'a' }] }));
  assert.match(rendu, /la lire ne l’efface pas/);
  assert.match(rendu, /vide le fichier/);
});

test('une proposition ABSENTE n’affiche aucun bouton', () => {
  const rendu = renderNotes(SPARK, ui({
    propositions: [{ kind: 'readme', present: false, body: '', sha256: null }] }));
  assert.doesNotMatch(rendu, /data-note-accepter/);
});

test('une cellule NON CONSULTÉE le dit, au lieu de laisser croire à l’absence', () => {
  const rendu = renderNotes(SPARK, ui({ cellLue: false }));
  assert.match(rendu, /La cellule n’a pas été consultée/);
  // Le registre fait foi, et l'écran ne prétend pas savoir ce qu'il n'a pas lu.
  assert.match(rendu, /viennent du registre/);

  const lue = renderNotes(SPARK, ui({ cellLue: true }));
  assert.doesNotMatch(lue, /La cellule n’a pas été consultée/);
});

test('le chargement et l’erreur ont chacun leur écran (§14.6)', () => {
  assert.match(renderNotes(SPARK, NOTES_VIDE), /Lecture des notes/);
  const erreur = renderNotes(SPARK, {
    ...NOTES_VIDE, status: 'erreur', erreur: 'Spark introuvable.' });
  assert.match(erreur, /role="alert"/);
  assert.match(erreur, /Spark introuvable\./);
  assert.match(erreur, /data-notes-relire/);
});

test('rien de ce qui vient du serveur n’est injecté sans échappement', () => {
  const rendu = renderNotes(SPARK, ui({
    items: [NOTE({ written: true, body: '<script>alert(1)</script>',
                   revision: 1, origin: 'console' })] }));
  assert.doesNotMatch(rendu, /<script>alert/);
  assert.match(rendu, /&lt;script&gt;/);
});
