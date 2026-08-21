/**
 * @verifies docs/BACKLOG.md#SPK-58, docs/BACKLOG.md#SPK-64 · docs/DAT.md §43.3
 * (la valeur d'un secret ne s'affiche jamais), §43.6 révisé (la Forge propose,
 * le Spark choisit), §43.7 (écrire ne redémarre rien), §43.9.4 (l'origine de
 * chaque valeur) ·
 * docs/DESIGN_SYSTEM.md §6.27, §9.9, §14.5, §14.6
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderModale } from './modale.js';
import { ENV_VIDE, ORIGINES, renderEnvPanel, renderCatalogueCases } from './spark-env.js';

const SPARK = { name: 'crm-production', protected: false };
// La VRAIE modale, pas un doublon : c'est elle qui rend le refus et l'engagement,
// et un doublon qui les ignorerait laisserait passer une composition fausse.

const entree = (champs) => ({
  name: 'TZ', is_secret: false, value: 'Europe/Paris', fingerprint: null,
  scope: 'forge', origin: 'forge', updated_at: '2026-08-21T08:00:00+00:00',
  ...champs,
});

const ui = (champs = {}) => ({ ...ENV_VIDE, ...champs,
                               values: { ...ENV_VIDE.values, ...(champs.values ?? {}) } });

test('la valeur d’un SECRET n’est jamais rendue, son empreinte l’est', () => {
  const rendu = renderEnvPanel(SPARK, [entree({
    name: 'STRIPE_API_KEY', is_secret: true, value: null,
    fingerprint: '07acff4bc411', scope: 'spark', origin: 'spark',
  })], ENV_VIDE, renderModale);
  assert.match(rendu, /STRIPE_API_KEY/);
  assert.match(rendu, /07acff4bc411/, 'l’empreinte compare sans révéler');
  // §14.6 : « défini mais masqué » n’est ni « absent » ni « vide ». Un blanc
  // laisserait croire qu’aucun secret n’est posé.
  assert.match(rendu, /Secret/);
});

test('l’ORIGINE de chaque valeur est écrite, pas déduite', () => {
  const rendu = renderEnvPanel(SPARK, [
    entree({ name: 'TZ', origin: 'forge', scope: 'forge' }),
    entree({ name: 'SMTP_HOST', origin: 'overridden', scope: 'spark' }),
    entree({ name: 'APP_NAME', origin: 'spark', scope: 'spark' }),
  ], ENV_VIDE, renderModale);
  for (const { libelle } of Object.values(ORIGINES)) assert.match(rendu, new RegExp(libelle));
});

test('« surcharge » se distingue de « propre » : la valeur de la Forge est MASQUÉE', () => {
  // Les confondre ferait chercher une valeur là où elle est écrite, en vain.
  assert.notEqual(ORIGINES.overridden.libelle, ORIGINES.spark.libelle);
});

test('chaque niveau a SA section, et chacune nomme son absence', () => {
  const rendu = renderEnvPanel(SPARK, [], ENV_VIDE, renderModale);
  assert.match(rendu, /id="titre-env-forge"/);
  assert.match(rendu, /id="titre-env-spark"/);
  // §14.5 : l’absence est un FAIT, et il se nomme.
  assert.match(rendu, /Aucune entrée du catalogue ne descend/);
  assert.match(rendu, /Aucune variable propre/);
});

test('les entrées de la FORGE ne se mélangent pas à celles du Spark', () => {
  const rendu = renderEnvPanel(SPARK, [
    entree({ name: 'DE_LA_FORGE', scope: 'forge', origin: 'forge' }),
    entree({ name: 'DU_SPARK', scope: 'spark', origin: 'spark' }),
  ], ENV_VIDE, renderModale);
  const forge = rendu.slice(rendu.indexOf('titre-env-forge'), rendu.indexOf('titre-env-spark'));
  assert.match(forge, /DE_LA_FORGE/);
  assert.doesNotMatch(forge, /DU_SPARK/);
});

test('un Spark PROTÉGÉ garde la commande, DÉSACTIVÉE, avec sa raison', () => {
  // §9.9 : la faire disparaître ferait croire que le produit ne sait pas poser
  // de variable.
  const rendu = renderEnvPanel({ ...SPARK, protected: true }, [], ENV_VIDE, renderModale);
  assert.match(rendu, /data-ouvre-env="spark" disabled/);
  assert.match(rendu, /levez la protection/i);
  // Les cases sont aussi des écritures qui visent ce Spark : elles restent
  // visibles mais inertes, avec la même raison que le bouton de saisie.
  const avecCatalogue = renderEnvPanel({ ...SPARK, protected: true }, [], ENV_VIDE,
    renderModale, [{ name: 'SMTP_HOST', is_secret: false }]);
  assert.match(avecCatalogue, /data-descend="SMTP_HOST"\s+disabled/);
  assert.match(avecCatalogue, /modifier ses sélections/);
});

test('la modale ANNONCE que rien ne redémarre', () => {
  // §43.7 : laisser croire à un effet immédiat qui n’aura pas lieu ferait
  // chercher une panne là où il n’y en a pas.
  const rendu = renderEnvPanel(SPARK, [], ui({ open: 'spark' }), renderModale);
  assert.match(rendu, /prochain démarrage/);
  assert.match(rendu, /ne redémarre rien/);
});

test('la modale dit ce qu’une déclaration de SECRET engage', () => {
  const rendu = renderEnvPanel(SPARK, [], ui({ open: 'spark' }), renderModale);
  assert.match(rendu, /n’est plus jamais affichée/);
  assert.match(rendu, /On la remplace/);
});

test('un refus reste dans SA section, sans effacer la saisie', () => {
  const rendu = renderEnvPanel(SPARK, [],
    ui({ open: 'spark', refusal: { niveau: 'spark', message: 'Nom refusé.' },
         values: { name: 'AVEC-TIRET', value: 'x' } }), renderModale);
  assert.match(rendu, /Nom refusé\./);
  assert.match(rendu, /value="AVEC-TIRET"/, 'la saisie survit (§6.27)');
});

test('le tableau SIGNALE son débordement', () => {
  // §14.2 : un débordement muet est un contenu fonctionnellement caché.
  const rendu = renderEnvPanel(SPARK, [entree({})], ENV_VIDE, renderModale);
  assert.match(rendu, /tableau-enveloppe/);
  assert.match(rendu, /défile horizontalement/);
});

test('une valeur est ÉCHAPPÉE avant d’atteindre l’écran', () => {
  const rendu = renderEnvPanel(SPARK, [entree({
    name: 'X', value: '<script>alert(1)</script>' })], ENV_VIDE, renderModale);
  assert.doesNotMatch(rendu, /<script>/);
});

// --- SPK-64 · le catalogue descend par SÉLECTION -----------------------------

test('une entrée du catalogue porte une case, cochée si elle descend', () => {
  const rendu = renderCatalogueCases('crm', [
    { name: 'TZ', is_secret: false },
    { name: 'SMTP_PASSWORD', is_secret: true },
    { name: 'OBJECT_STORAGE_URL', is_secret: false },
  ], [
    { name: 'TZ', origin: 'forge' },
    { name: 'SMTP_PASSWORD', origin: 'forge' },
  ]);

  assert.match(rendu, /data-descend="TZ"[^>]*checked/);
  assert.match(rendu, /data-descend="SMTP_PASSWORD"[^>]*checked/);
  // Celle que personne n'a cochée est PRÉSENTE et NON cochée : c'est l'état que
  // l'unité existe pour rendre visible.
  assert.match(rendu, /data-descend="OBJECT_STORAGE_URL"(?![^>]*checked)/);
});

test('une entrée MASQUÉE reste cochée, et le dit', () => {
  // Sans cette mention, on cherche pourquoi la valeur affichée n'est pas celle
  // du catalogue alors que la case est cochée.
  const rendu = renderCatalogueCases('crm',
    [{ name: 'SMTP_HOST', is_secret: false }],
    [{ name: 'SMTP_HOST', origin: 'overridden' }]);

  assert.match(rendu, /data-descend="SMTP_HOST"[^>]*checked/);
  assert.match(rendu, /masquée par une entrée propre/);
});

test('une entrée cochée se retire par le geste de sélection, jamais du catalogue', () => {
  const rendu = renderEnvPanel(SPARK, [entree({ name: 'TZ', scope: 'forge', origin: 'forge' })],
    ENV_VIDE, renderModale, [{ name: 'TZ', is_secret: false }]);
  assert.match(rendu, /data-env-decocher="TZ"/);
  assert.doesNotMatch(rendu, /data-env-retire="TZ" data-env-portee="forge"/);
});

test('un catalogue vide se NOMME et dit où en ajouter une', () => {
  const rendu = renderCatalogueCases('crm', [], []);
  assert.match(rendu, /catalogue de la Forge est vide/);
  assert.match(rendu, /#\/forge\/environnement/);
});

test('le mot « héritée » a disparu de l’écran', () => {
  // SPK-64 : rien n'est hérité. Le mot décrivait le défaut, pas le produit.
  assert.doesNotMatch(JSON.stringify(ORIGINES), /[Hh]érit/);
  assert.match(ORIGINES.forge.libelle, /coch/i);
});
