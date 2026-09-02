/**
 * @verifies docs/BACKLOG.md#SPK-85 · docs/DAT.md §44.9.5 (ce que la console en
 *           fait), §44.9.3 (ce qu'il ne porte jamais) ·
 *           docs/DESIGN_SYSTEM_APP.md SPK-DS-19 ·
 *           docs/DESIGN_SYSTEM.md §1.3 (pas de succès simulé), §6.27 (une
 *           information s'affiche dans une SECTION, pas dans une modale),
 *           §14.5 (l'absence se nomme), §14.6 (états distincts)
 *
 * Ces preuves portent sur ce que la section REND. Elles ne prouvent pas que le
 * presse-papier a reçu quoi que ce soit — c'est le rôle du parcours E2E, qui le
 * relit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DOSSIER_VIDE, renderDossier, rebondDuServeur } from './spark-dossier.js';

const SPARK = { name: 'crm-production', state: 'running' };
const TEXTE = '# Dossier de déploiement — Spark « crm-production »\n\n'
  + '```sh\nssh -J responsable@forge.test root@10.77.0.12\n```\n';

const pret = (extra = {}) => ({
  ...DOSSIER_VIDE, status: 'pret', texte: TEXTE, amorce: true,
  ecritLe: '2026-09-02 16:29', ...extra,
});

test('la section annonce ce que le texte contient AVANT qu’on le copie', () => {
  const rendu = renderDossier(SPARK, pret());
  assert.match(rendu, /Aucune valeur de secret/);
  assert.match(rendu, /Copier pour un LLM/);
});

test('le texte est présent, replié et sélectionnable (SPK-DS-19)', () => {
  const rendu = renderDossier(SPARK, pret());
  assert.match(rendu, /<details class="repli">/);
  assert.match(rendu, /<summary>Lire le texte avant de le coller<\/summary>/);
  assert.match(rendu, /class="fragment technique dossier__texte"/);
  // Le contenu est ÉCHAPPÉ : ce texte vient du serveur et traverse `innerHTML`.
  assert.match(rendu, /Spark « crm-production »/);
  assert.doesNotMatch(rendu, /<script/);
});

test('aucune modale : une information s’affiche dans une section (§6.27)', () => {
  const rendu = renderDossier(SPARK, pret());
  assert.doesNotMatch(rendu, /<dialog/);
  assert.match(rendu, /<section class="carte bloc dossier"/);
});

test('« Copié » n’apparaît qu’une fois le presse-papier d’accord (§1.3)', () => {
  const sans = renderDossier(SPARK, pret());
  assert.doesNotMatch(sans, /copié/i);

  const avec = renderDossier(SPARK, pret({
    copie: { ok: true, message: 'Dossier copié dans le presse-papier.' } }));
  assert.match(avec, /class="succes"/);
  assert.match(avec, /Dossier copié dans le presse-papier/);
});

test('un refus du presse-papier renvoie au texte, il ne ment pas', () => {
  const rendu = renderDossier(SPARK, pret({
    copie: { ok: false, message: 'Copie refusée par le navigateur : dépliez le texte.' } }));
  assert.match(rendu, /class="avertissement"/);
  assert.match(rendu, /Copie refusée/);
  assert.doesNotMatch(rendu, /class="succes"/);
});

test('un Spark jamais amorcé garde son dossier, et le dit (§14.6)', () => {
  const rendu = renderDossier(SPARK, pret({ amorce: false }));
  assert.match(rendu, /jamais été amorcé/);
  assert.match(rendu, /class="avertissement"/);
  // Le bouton reste : le dossier existe, il est seulement amputé des relevés.
  assert.match(rendu, /data-dossier-copie/);
});

test('un Spark sans cellule NOMME l’absence au lieu d’offrir une copie vide', () => {
  const rendu = renderDossier(SPARK, {
    ...DOSSIER_VIDE, status: 'absent',
    message: 'Ce Spark n’a pas encore de cellule.' });
  assert.match(rendu, /class="absence"/);
  assert.match(rendu, /pas encore de cellule/);
  assert.doesNotMatch(rendu, /data-dossier-copie/);
});

test('une lecture qui échoue est un refus annoncé, pas une absence', () => {
  const rendu = renderDossier(SPARK, {
    ...DOSSIER_VIDE, status: 'erreur', message: 'HTTP 502' });
  assert.match(rendu, /class="refus" role="alert"/);
  assert.match(rendu, /HTTP 502/);
  assert.doesNotMatch(rendu, /data-dossier-copie/);
});

test('le chargement est un état annoncé, pas un blanc (§6.13)', () => {
  const rendu = renderDossier(SPARK, DOSSIER_VIDE);
  assert.match(rendu, /aria-busy="true"/);
  assert.match(rendu, /Composition du dossier/);
});

test('la date du relevé est rendue : un dossier daté ne se lit pas comme un état actuel', () => {
  assert.match(renderDossier(SPARK, pret()), /2026-09-02 16:29/);
});


// --- Par où l'on saute (SPK-85, docs/DAT.md §44.9.2) --------------------------
//
// Cette information n'appartient PAS au plan de contrôle : elle vit dans
// l'inventaire du poste. Ces preuves fixent la traduction des trois genres de
// serveur, parce qu'une erreur ici produit une commande qui échoue chez l'agent.

test('un serveur SSH donne compte, hôte, et le port quand il n’est pas 22', () => {
  assert.deepEqual(
    rebondDuServeur({ kind: 'ssh', host: 'forge.test', user: 'responsable', port: 22 }),
    { jump: 'responsable@forge.test' });
  assert.deepEqual(
    rebondDuServeur({ kind: 'ssh', host: 'forge.test', user: 'responsable', port: 2222 }),
    { jump: 'responsable@forge.test:2222' });
  assert.deepEqual(
    rebondDuServeur({ kind: 'ssh', host: 'forge.test' }),
    { jump: 'forge.test' });
});

test('un serveur alias délègue TOUT à OpenSSH : on rend le Host, rien de plus', () => {
  assert.deepEqual(
    rebondDuServeur({ kind: 'alias', sshHost: 'spark-recette' }),
    { jump: 'spark-recette' });
  // §22.4 bis : un alias sans `Host` ne se devine pas.
  assert.deepEqual(rebondDuServeur({ kind: 'alias' }), {});
});

test('une console servie SUR la Forge n’a rien à sauter', () => {
  assert.deepEqual(rebondDuServeur({ kind: 'local', host: '127.0.0.1' }),
                   { direct: true });
});

test('sans serveur courant, on ne nomme AUCUN rebond plutôt qu’un faux', () => {
  assert.deepEqual(rebondDuServeur(undefined), {});
  assert.deepEqual(rebondDuServeur({ kind: 'ssh' }), {});
});

test('le repli SURVIT à une repeinture : on déplie, on copie, le texte reste', () => {
  // Mesuré en capturant la copie : sans cet état, `peindre()` refermait le
  // texte que l'exploitant venait d'ouvrir pour le vérifier (§14.3).
  assert.doesNotMatch(renderDossier(SPARK, pret()), /<details class="repli" open>/);
  assert.match(renderDossier(SPARK, pret({ deplie: true })),
               /<details class="repli" open>/);
});
