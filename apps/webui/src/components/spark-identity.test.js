/**
 * @verifies docs/BACKLOG.md#SPK-74 · docs/DAT.md §17.5 (l'identité présentée),
 * §17.2 (aucune clé privée) ·
 * docs/DESIGN_SYSTEM.md §3.1 (données techniques), §14.6 (zéro, en cours et
 * indisponible), §6.23 « Frapper le nom », §9.9 (état désactivé), §1.3 (pas de
 * succès simulé)
 *
 * Ce que ces preuves gardent : « aucune identité » et « illisible » sont deux
 * écrans différents. Les fondre ferait créer une seconde identité en croyant
 * réparer la première, ce qui invaliderait la clé déjà posée chez le tiers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IDENTITE_VIDE, renderIdentityPanel } from './spark-identity.js';

const SPARK = { name: 'crm-production' };
const CLE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ1YQr7 spark:crm-production';
const PRESENTE = {
  state: 'presente', public_key: CLE,
  fingerprint: 'SHA256:6EGw/1AFGadCLeO6pkpi6K2X40kw1MIVh9jDK0XT4q8',
  comment: 'spark:crm-production', key_type: 'ssh-ed25519',
  path: '/root/.ssh/id_ed25519',
};

const ui = (champs = {}) => ({ ...IDENTITE_VIDE, status: 'pret', ...champs });

test('la section dit le SENS : ce que le Spark présente, pas qui entre', () => {
  const rendu = renderIdentityPanel(SPARK, ui({ releve: PRESENTE }));
  assert.match(rendu, /présente/);
  assert.match(rendu, /laissent entrer|inverse des clés autorisées/);
  // §17.2 : la clé privée n'est jamais rendue, et l'écran le DIT.
  assert.match(rendu, /privée[\s\S]*?reste dans la cellule/);
});

test('la clé publique et l’empreinte sont en MONOSPACE (§3.1)', () => {
  const rendu = renderIdentityPanel(SPARK, ui({ releve: PRESENTE }));
  assert.match(rendu, /class="fragment technique bloc-cle"/);
  assert.match(rendu, /<dd class="technique">SHA256:/);
  assert.ok(rendu.includes(CLE), 'la clé publique est affichée en entier');
});

test('le bloc de clé reste SÉLECTIONNABLE : la copie a un repli', () => {
  // `navigator.clipboard` peut manquer ou être refusée. Sans repli manuel, le
  // bouton serait une impasse le jour où il échoue.
  const rendu = renderIdentityPanel(SPARK, ui({ releve: PRESENTE }));
  assert.match(rendu, /<pre class="fragment technique bloc-cle" tabindex="0"/);
  assert.match(rendu, /data-identite-copie/);
});

test('« absente » et « illisible » sont DEUX écrans, pas un (§14.6)', () => {
  const absente = renderIdentityPanel(SPARK, ui({ releve: { state: 'absente' } }));
  const indispo = renderIdentityPanel(SPARK, ui({ releve: { state: 'indisponible' } }));

  assert.match(absente, /Aucune identité/);
  assert.match(absente, /data-identite-creer/);

  assert.match(indispo, /illisible/);
  assert.match(indispo, /Démarrez-le/);
  // Le geste attendu est de démarrer le Spark, PAS d'en créer une seconde.
  assert.ok(!indispo.includes('data-identite-creer'),
            'un Spark arrêté ne propose pas de créer une identité');
  assert.ok(!indispo.includes('Aucune identité'),
            '« illisible » ne doit jamais se lire « aucune »');
});

test('le chargement n’est ni zéro ni indisponible', () => {
  const rendu = renderIdentityPanel(SPARK, { ...IDENTITE_VIDE, status: 'chargement' });
  assert.match(rendu, /aria-busy="true"/);
  assert.ok(!rendu.includes('Aucune identité'));
  assert.ok(!rendu.includes('illisible'));
});

test('remplacer exige la FRAPPE DU NOM, et le bouton reste présent et désactivé', () => {
  // §6.23 : les trois conditions tiennent — irréversible, objet confondable,
  // nom court et visible. §9.9 : désactivé, pas absent.
  const attente = renderIdentityPanel(SPARK, ui({
    releve: PRESENTE, confirming: 'identite', frappe: 'crm' }));
  assert.match(attente, /data-identite-remplace[^>]*disabled/);
  assert.match(attente, /aria-describedby="identite-aide"/);
  assert.match(attente, /n’est pas encore celui du Spark/);
  // L'écran dit ce qui CASSE, avant le geste.
  assert.match(attente, /cesse d’être valide/);
  assert.match(attente, /clé de déploiement/);

  const prete = renderIdentityPanel(SPARK, ui({
    releve: PRESENTE, confirming: 'identite', frappe: 'crm-production' }));
  assert.ok(!/data-identite-remplace[^>]*disabled/.test(prete),
            'le nom exact rend le remplacement engageable');
  assert.match(prete, /Le nom correspond\./);
});

test('la comparaison du nom est EXACTE : la casse ne passe pas', () => {
  const rendu = renderIdentityPanel(SPARK, ui({
    releve: PRESENTE, confirming: 'identite', frappe: 'CRM-PRODUCTION' }));
  assert.match(rendu, /data-identite-remplace[^>]*disabled/);
});

test('créer une identité ABSENTE ne demande AUCUNE confirmation', () => {
  // Le geste ne détruit rien. Confirmer sans conséquence apprend à confirmer
  // sans lire (§6.23).
  const rendu = renderIdentityPanel(SPARK, ui({ releve: { state: 'absente' } }));
  assert.ok(!rendu.includes('data-frappe-identite'));
  assert.ok(!rendu.includes('Frappez'));
});

test('« Copié » n’est affiché qu’une fois le presse-papier d’accord (§1.3)', () => {
  const muet = renderIdentityPanel(SPARK, ui({ releve: PRESENTE }));
  assert.ok(!muet.includes('copiée'), 'rien n’est annoncé avant le geste');

  const ok = renderIdentityPanel(SPARK, ui({
    releve: PRESENTE, copie: { ok: true, message: 'Clé publique copiée dans le presse-papier.' } }));
  assert.match(ok, /role="status"/);
  assert.match(ok, /copiée dans le presse-papier/);

  const refus = renderIdentityPanel(SPARK, ui({
    releve: PRESENTE, copie: { ok: false, message: 'Copie refusée par le navigateur : sélectionnez le texte.' } }));
  assert.match(refus, /class="avertissement"/);
  assert.match(refus, /Copie refusée/);
});

test('une erreur de lecture se dit et offre de RÉESSAYER, sans effacer le sens', () => {
  const rendu = renderIdentityPanel(SPARK, {
    ...IDENTITE_VIDE, status: 'erreur', erreur: 'HTTP 502' });
  assert.match(rendu, /role="alert"/);
  assert.match(rendu, /HTTP 502/);
  assert.match(rendu, /data-identite-relire/);
});

test('l’écran nomme le fichier de la cellule, en technique', () => {
  const rendu = renderIdentityPanel(SPARK, ui({ releve: PRESENTE }));
  assert.match(rendu, /\/root\/\.ssh\/id_ed25519/);
});

test('rien n’est injecté : le rendu échappe ce qui vient du serveur', () => {
  const rendu = renderIdentityPanel({ name: '<script>x</script>' }, ui({
    releve: { ...PRESENTE, public_key: 'ssh-ed25519 AAA <img onerror=1>' } }));
  assert.ok(!rendu.includes('<img onerror=1>'));
  assert.match(rendu, /&lt;img onerror=1&gt;/);

  // Le nom du Spark n'atteint l'écran que dans la confirmation : c'est là qu'on
  // vérifie qu'il y est échappé.
  const confirme = renderIdentityPanel({ name: '<script>x</script>' }, ui({
    releve: PRESENTE, confirming: 'identite' }));
  assert.ok(!confirme.includes('<script>x</script>'));
  assert.match(confirme, /&lt;script&gt;/);
});
