/**
 * @verifies docs/BACKLOG.md#SPK-178 · docs/DAT.md §71.3 (les gestes), §71.4 (ce que
 *           GitHub répond), §71.7 (la démonstration) · docs/DESIGN_SYSTEM.md §1.3
 *           (pas de succès simulé), §1.4 (pas de commande morte), §1.5 (jamais la
 *           couleur seule), §6.8 (badges), §6.9 (champs), §6.10 (cases), §6.13 (un
 *           état relevé se date), §6.22 et §6.23 (la confirmation d'un retrait),
 *           §9.7 (régions annoncées), §9.9 (état désactivé) ·
 *           docs/DESIGN_SYSTEM_APP.md SPK-DS-48
 *
 * Ce que ces preuves gardent : ce que l'écran montre est ce que GitHub a RÉPONDU,
 * relu, daté — et la seule voie vers l'écriture est une case décochée suivie
 * d'une confirmation qui nomme le dépôt.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEPOT_CLE_VIDE, renderDepotPanel } from './spark-depot-cle.js';

const SPARK = { name: 'crm' };
const IDENTITE = { state: 'presente', public_key: 'ssh-ed25519 AAAAC3 spark:crm',
                   fingerprint: 'SHA256:x' };
const ui = (champs = {}) => ({ ...DEPOT_CLE_VIDE, spark: 'crm', status: 'pret',
                               configured: true, ...champs });
const rendre = (champs, identite = IDENTITE) => renderDepotPanel(SPARK, ui(champs), identite);

// --- quand la section existe ------------------------------------------------

test('sans identité présente, la section ne se rend pas : il n’y a pas de clé à poser', () => {
  for (const state of ['absente', 'indisponible']) {
    assert.equal(rendre({}, { state }), '');
  }
  assert.equal(rendre({}, null), '');
});

test('en lecture de la configuration, la section le dit sans formulaire', () => {
  const rendu = renderDepotPanel(SPARK, { ...DEPOT_CLE_VIDE, status: 'chargement' }, IDENTITE);
  assert.match(rendu, /aria-busy="true"/);
  assert.doesNotMatch(rendu, /<form/);
});

test('sans jeton : la raison est dite, le formulaire n’est pas rendu (§1.4)', () => {
  const rendu = rendre({ configured: false });
  assert.match(rendu, /Aucun jeton GitHub/);
  assert.match(rendu, /SPARK_GITHUB_DEPLOY_TOKEN/);
  assert.doesNotMatch(rendu, /<form/);
  assert.doesNotMatch(rendu, /data-depot-poser/);
});

test('une configuration illisible a son erreur et un « Réessayer »', () => {
  const rendu = renderDepotPanel(SPARK, { ...DEPOT_CLE_VIDE, status: 'erreur',
    erreur: 'La console ne répond pas.' }, IDENTITE);
  assert.match(rendu, /role="alert"/);
  assert.match(rendu, /La console ne répond pas\./);
  assert.match(rendu, /data-depot-relire/);
});

// --- le formulaire (§6.9, §6.10) --------------------------------------------

test('le champ a son libellé, son aide liée, et la forme attendue', () => {
  const rendu = rendre({});
  assert.match(rendu, /<label for="depot-cle-champ">/);
  assert.match(rendu, /id="depot-cle-champ"[^>]*aria-describedby="depot-cle-aide"/);
  assert.match(rendu, /id="depot-cle-aide"/);
  assert.match(rendu, /propriétaire\/dépôt/);
  assert.match(rendu, /Un Spark sert un seul dépôt/);
});

test('la saisie est rendue ÉCHAPPÉE', () => {
  const rendu = rendre({ repository: '"><img src=x onerror=1>' });
  assert.doesNotMatch(rendu, /<img/);
  assert.match(rendu, /value="&quot;&gt;&lt;img/);
});

test('la case d’écriture est DÉCOCHÉE à l’ouverture, et dit ce qu’elle accorde', () => {
  const rendu = rendre({});
  assert.match(rendu, /<label class="case">/);
  assert.match(rendu, /<input type="checkbox" data-depot-ecriture/);
  assert.doesNotMatch(rendu, /data-depot-ecriture[^>]*checked/);
  assert.match(rendu, /ne peut que cloner/);
  assert.match(rendre({ ecriture: true }), /data-depot-ecriture[^>]*checked/);
});

test('le formulaire se soumet au clavier : Entrée vérifie', () => {
  assert.match(rendre({}), /<form[^>]*data-depot-form/);
});

// --- les états de la clé (§6.8, §1.5) ---------------------------------------

const bilan = (champs) => ({ repository: 'p2enjoy/crm', ...champs });

test('non posée : badge neutre, et la sortie est de la poser — lecture seule par défaut', () => {
  const rendu = rendre({ bilan: bilan({ state: 'non_posee' }), releveLe: '2026-11-18T14:03:22' });
  assert.match(rendu, /badge--neutral[^>]*>[\s\S]*non posée/);
  assert.match(rendu, /data-depot-poser/);
  assert.match(rendu, /Poser la clé en lecture seule/);
  assert.doesNotMatch(rendu, /data-depot-retirer/);
});

test('posée en lecture seule : succès, avec le MOT et pas seulement la couleur', () => {
  const rendu = rendre({ bilan: bilan({ state: 'posee', access: 'lecture' }),
                         releveLe: '2026-11-18T14:03:22' });
  assert.match(rendu, /badge--success/);
  assert.match(rendu, /posée · lecture seule/);
  assert.match(rendu, /data-depot-retirer/);
  assert.doesNotMatch(rendu, /data-depot-poser/, 'rien à poser : elle l’est déjà');
});

test('posée en écriture : badge accent, l’écriture est nommée', () => {
  const rendu = rendre({ bilan: bilan({ state: 'posee', access: 'ecriture' }),
                         releveLe: '2026-11-18T14:03:22' });
  assert.match(rendu, /badge--accent/);
  assert.match(rendu, /posée · écriture/);
});

test('périmée : danger, et la pastille PORTE sa sortie sur la même ligne (§6.8)', () => {
  const rendu = rendre({ bilan: bilan({ state: 'perimee', access: 'lecture' }),
                         releveLe: '2026-11-18T14:03:22' });
  assert.match(rendu, /badge--danger/);
  assert.match(rendu, /périmée/);
  assert.match(rendu, /Remplacer la clé périmée/);
  assert.match(rendu, /data-depot-poser/);
});

test('l’état relevé est DATÉ (§6.13)', () => {
  const rendu = rendre({ bilan: bilan({ state: 'posee', access: 'lecture' }),
                         releveLe: '2026-11-18T14:03:22' });
  assert.match(rendu, /Relevé à \d{2}:\d{2}/);
});

test('pendant une relecture, l’ancien état ne reste PAS affiché comme actuel (§6.13)', () => {
  const rendu = rendre({ bilan: bilan({ state: 'posee', access: 'lecture' }),
                         releveLe: '2026-11-18T14:03:22', busy: 'verifier' });
  assert.doesNotMatch(rendu, /posée · lecture seule/);
  assert.match(rendu, /aria-busy="true"/);
  assert.match(rendu, /Lecture chez GitHub/);
});

test('pendant un geste, les commandes sont présentes et DÉSACTIVÉES (§9.9)', () => {
  const rendu = rendre({ bilan: bilan({ state: 'non_posee' }), busy: 'poser' });
  assert.match(rendu, /data-depot-poser[^>]*disabled/);
  assert.match(rendu, /data-depot-verifier[^>]*disabled/);
  assert.match(rendu, /Pose en cours/);
});

// --- les confirmations (§6.22, §6.23) ---------------------------------------

test('retirer demande une confirmation qui NOMME le dépôt et la conséquence', () => {
  const rendu = rendre({ bilan: bilan({ state: 'posee', access: 'lecture' }),
                         confirming: 'retirer', repository: 'p2enjoy/crm' });
  assert.match(rendu, /role="group"/);
  assert.match(rendu, /confirmation--sensible/);
  assert.match(rendu, /p2enjoy\/crm/);
  assert.match(rendu, /ne pourra plus cloner/);
  assert.match(rendu, /data-depot-retire-confirme/);
  assert.match(rendu, /data-depot-annule/);
  // §6.23 : retirer une clé est réversible — on la repose. Pas de frappe du nom.
  assert.doesNotMatch(rendu, /data-frappe/);
  // SPK-DS-09 : confirmation sensible, bouton ordinaire — pas de rouge.
  assert.doesNotMatch(rendu, /bouton--destructif/);
});

test('poser en écriture se confirme, et dit ce que l’écriture permet', () => {
  const rendu = rendre({ ecriture: true, confirming: 'ecriture', repository: 'p2enjoy/crm',
                         bilan: bilan({ state: 'non_posee' }) });
  assert.match(rendu, /confirmation--sensible/);
  assert.match(rendu, /pousser/);
  assert.match(rendu, /data-depot-poser-confirme/);
});

test('poser en lecture seule ne demande aucune confirmation', () => {
  const rendu = rendre({ bilan: bilan({ state: 'non_posee' }) });
  assert.doesNotMatch(rendu, /confirmation/);
});

// --- ce qui revient du système qui fait autorité (§1.3, §9.7) ---------------

test('une erreur est annoncée en alerte, sans succès à côté', () => {
  const rendu = rendre({ erreur: 'Jeton refusé par GitHub.', info: null });
  assert.match(rendu, /role="alert"[\s\S]*Jeton refusé par GitHub\./);
});

test('un geste abouti est annoncé en statut, et le journal muet est DIT', () => {
  const abouti = rendre({ info: 'Clé posée en lecture seule.' });
  assert.match(abouti, /role="status"[^>]*>[^<]*Clé posée en lecture seule\./);
  const muet = rendre({ info: 'Clé posée en lecture seule.', journalise: false });
  assert.match(muet, /journal/);
  assert.match(muet, /pas pu/);
});
