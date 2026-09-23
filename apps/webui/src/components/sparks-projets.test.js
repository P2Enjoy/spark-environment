/**
 * @verifies docs/BACKLOG.md#SPK-116 · docs/DAT.md §61.1 (la suppression nomme
 *           les Sparks désaffectés et dit qu'ils ne sont pas modifiés), §61.4
 *           (Tous, un onglet par projet, Projets ; l'onglet d'un projet est la
 *           liste de Tous restreinte ; ranger depuis la fenêtre du Spark) ·
 *           docs/DESIGN_SYSTEM.md §5.2, §6.8, §6.10, §6.23, §6.27, §14.5, §14.6 ·
 *           docs/DESIGN_SYSTEM_APP.md SPK-DS-33
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ongletsSparks, renderProjetsGestion, renderProjetsSpark, renderPastillesProjets,
         projetsCoches, filtrerParProjet, PROJETS_UI_VIDE, ADRESSE_GESTION, adresseProjet }
  from './sparks-projets.js';
import { renderSparksView } from './sparks-view.js';

const A = { id: 'a1', name: 'Client A', sparks: ['crm', 'vitrine'] };
const B = { id: 'b2', name: 'Interne', sparks: [] };

test('la rangée : Tous, un onglet par projet dans l’ordre reçu, puis Projets', () => {
  assert.deepEqual(ongletsSparks([A, B]), [
    ['#/sparks', 'Tous'], ['#/sparks/~projet/a1', 'Client A'],
    ['#/sparks/~projet/b2', 'Interne'], ['#/sparks/~projets', 'Projets']]);
  // Une liste illisible n'efface pas la rangée : Tous et Projets restent.
  assert.deepEqual(ongletsSparks(null), [['#/sparks', 'Tous'], ['#/sparks/~projets', 'Projets']]);
});

test('les adresses ne peuvent pas être le nom d’un Spark (`~` hors de [a-z0-9-])', () => {
  const NOM_SPARK = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  for (const adresse of [ADRESSE_GESTION, adresseProjet('projets')]) {
    assert.ok(!NOM_SPARK.test(adresse.split('/')[2]), adresse);
  }
});

test('l’onglet d’un projet RESTREINT la liste de Tous, et nomme un projet disparu', () => {
  const sparks = [{ name: 'crm', projects: [{ id: 'a1', name: 'Client A' }] },
                  { name: 'seul', projects: [] }];
  assert.deepEqual(filtrerParProjet(sparks, [A], null).sparks, sparks);
  const vue = filtrerParProjet(sparks, [A], 'a1');
  assert.deepEqual(vue.sparks.map((s) => s.name), ['crm']);
  assert.equal(vue.projet.name, 'Client A');
  assert.equal(filtrerParProjet(sparks, [A], 'zz').absent, true);
});

test('la liste porte les projets de chaque Spark en pastilles NEUTRES (§6.8)', () => {
  const rendu = renderSparksView({ status: 'ready', sparks: [
    { name: 'crm', state: 'running', projects: [{ id: 'a1', name: 'Client A' }] }] });
  assert.match(rendu, /<span class="pastilles-projets"><span class="badge badge--neutral">Client A<\/span><\/span>/);
  assert.equal(renderPastillesProjets([]), '');
});

test('un projet vide et un projet introuvable ont chacun leur texte (§14.5, §14.6)', () => {
  const vide = renderSparksView({ status: 'ready', sparks: [], projet: B });
  assert.match(vide, /Aucun Spark dans ce projet/);
  assert.match(vide, /onglet <em>Infos<\/em>, section <em>Projets<\/em>/);
  assert.doesNotMatch(vide, /Aucun Spark sur ce serveur/);
  const absent = renderSparksView({ status: 'ready', sparks: [], projetAbsent: true });
  assert.match(absent, /Ce projet n’existe pas, ou plus/);
});

test('la gestion liste les projets et leurs Sparks, avec Renommer et Supprimer', () => {
  const rendu = renderProjetsGestion([A, B]);
  assert.match(rendu, /href="#\/sparks\/~projet\/a1">Client A<\/a>/);
  assert.match(rendu, /Sparks : <a class="lien-spark" href="#\/sparks\/crm">crm<\/a>, /);
  assert.match(rendu, /aucun Spark/);
  assert.match(rendu, /data-renomme-projet="a1"/);
  assert.match(rendu, /data-supprime-projet="b2"/);
  assert.match(rendu, /data-ouvre="projet-creation"/);
});

test('supprimer se confirme DANS LE FLUX, en nommant les Sparks désaffectés et intacts', () => {
  const rendu = renderProjetsGestion([A, B], { ...PROJETS_UI_VIDE, confirming: 'a1' });
  assert.match(rendu, /Supprimer le projet « Client A » \?/);
  assert.match(rendu, /Ces Sparks sont désaffectés : <span class="technique">crm<\/span>, <span class="technique">vitrine<\/span>/);
  assert.match(rendu, /Ils ne sont pas modifiés/);
  assert.match(rendu, /class="bouton bouton--destructif" data-confirme-suppression-projet="a1"/);
  assert.doesNotMatch(rendu, /<dialog/, 'une confirmation n’est pas une modale (§6.22)');
  const vide = renderProjetsGestion([B], { ...PROJETS_UI_VIDE, confirming: 'b2' });
  assert.match(vide, /Aucun Spark n’y est rangé/);
});

test('créer et renommer passent par une modale, dont le refus reste dedans (§6.27)', () => {
  const creation = renderProjetsGestion([A], { ...PROJETS_UI_VIDE, open: 'projet-creation',
                                                refusal: { modale: 'Un projet « x » existe déjà.' } });
  assert.match(creation, /<dialog class="modale" id="projet-creation"/);
  assert.match(creation, />Créer le projet</);
  assert.match(creation, /maxlength="40"/);
  assert.match(creation, /Un projet « x » existe déjà\./);
  const renommage = renderProjetsGestion([A], { ...PROJETS_UI_VIDE, open: 'projet-renommage',
                                                 cible: 'a1', nom: 'Client A' });
  assert.match(renommage, /Renommer « Client A »/);
  assert.match(renommage, /value="Client A"/);
});

test('les états de lecture de la gestion : lecture, échec, aucun projet', () => {
  assert.match(renderProjetsGestion(undefined), /aria-busy="true">Lecture des projets…/);
  assert.match(renderProjetsGestion(null), /role="alert"/);
  assert.match(renderProjetsGestion([]), /Aucun projet\./);
});

test('la section Projets du Spark : pastilles, absence nommée, et Modifier toujours offert', () => {
  const range = renderProjetsSpark({ name: 'crm', projects: [{ id: 'a1', name: 'Client A' }] }, [A, B]);
  assert.match(range, /<h2 id="titre-projets-spark">Projets<\/h2>/);
  assert.match(range, /badge--neutral">Client A</);
  const nu = renderProjetsSpark({ name: 'seul', projects: [], protected: true }, [A]);
  assert.match(nu, /n’est rangé dans aucun projet/);
  // §61.1 : un Spark protégé se range comme un autre — le bouton n'est pas désactivé.
  assert.match(nu, /<button type="button" class="bouton" data-ouvre="projets">Modifier<\/button>/);
});

test('la modale de rangement : une case par projet, cochée d’après le Spark (§6.10)', () => {
  const spark = { name: 'crm', projects: [{ id: 'a1', name: 'Client A' }] };
  const rendu = renderProjetsSpark(spark, [A, B], { open: 'projets', values: {} });
  assert.match(rendu, /<input type="checkbox" name="projet:a1" checked>/);
  assert.match(rendu, /<input type="checkbox" name="projet:b2">/);
  assert.match(rendu, />Enregistrer le rangement</);
  // Ce qu'on a coché l'emporte sur ce que le Spark porte, et c'est ce qui part.
  assert.deepEqual(projetsCoches(spark, [A, B], { 'projet:a1': false, 'projet:b2': true }), ['b2']);
  assert.deepEqual(projetsCoches(spark, [A, B], {}), ['a1']);
});

test('sans aucun projet, la modale explique et n’offre pas de l’engager (§6.27)', () => {
  const rendu = renderProjetsSpark({ name: 'crm', projects: [] }, [], { open: 'projets', values: {} });
  assert.match(rendu, /Aucun projet n’existe encore/);
  assert.match(rendu, /href="#\/sparks\/~projets">Projets<\/a>/);
  assert.doesNotMatch(rendu, /data-engage=/);
  assert.match(rendu, />Fermer</);
});

test('rien de ce qui vient du serveur n’est injecté sans échappement', () => {
  const piege = { id: '"x', name: '<img src=x>', sparks: ['<b>'] };
  const rendu = renderProjetsGestion([piege], { ...PROJETS_UI_VIDE, confirming: '"x' })
    + renderProjetsSpark({ name: 'crm', projects: [piege] }, [piege], { open: 'projets', values: {} });
  assert.doesNotMatch(rendu, /<img|<b>/);
});
