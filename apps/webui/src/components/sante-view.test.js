/**
 * @verifies docs/BACKLOG.md#SPK-186 · docs/DAT.md §75.10 · docs/DESIGN_SYSTEM_APP.md SPK-DS-51 ·
 *           docs/DESIGN_SYSTEM.md §1.4 (pas de commande morte), §1.5 (la couleur ne porte pas seule),
 *           §6.13 (l'absence se nomme), §14.6 (mesure indisponible)
 *
 * Ce que ces preuves verrouillent : un état se lit en texte ET en pastille ; la frise distingue succès et
 * échec par la FORME ; une sonde HTTPS se choisit parmi les routes du Spark, jamais ne se saisit ; une
 * sonde illisible ne se rend pas comme une absence ; un « test » dit qu'il n'a rien enregistré.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PRESETS_SANTE, PERSONNALISEE, presetPour, SANTE_VIDE, definitionDe, valeursDeSonde, routesSondables,
  renderFrise, renderZoneApercu, renderZoneTest, renderSanteFacette, ETATS_SANTE,
} from './sante-view.js';

const releves = (...oks) => oks.map((ok, i) => ({ run_at: `2026-11-18T10:${String(i).padStart(2, '0')}:00+00:00`, ok, latency_ms: 12, detail: null }));
const SONDE = {
  name: 'api', kind: 'http', target: 'https://crm.example.com/healthz', expected: 200,
  schedule: '*/5 * * * *', threshold: 3, enabled: true, state: 'healthy', consecutive_failures: 0,
  state_since: '2026-11-18T09:00:00+00:00', last_run_at: '2026-11-18T10:55:00+00:00',
  last_latency_ms: 14, last_detail: null, description: 'Toutes les 5 minutes (UTC)',
  results: releves(true, true, true),
};
const ROUTES = [
  { domain: 'crm.example.com', tls: 1 }, { domain: 'vip.example.com', tls: 1 },
  { domain: 'vieux.example.com', tls: 0 }, { domain: '*.clients.example.com', tls: 1 },
];
const ui = (extra = {}) => ({ ...SANTE_VIDE, values: { ...SANTE_VIDE.values }, ...extra });
const facette = (checks, u = ui(), opts = {}) => renderSanteFacette({ checks, limit: 20 }, u, { routes: ROUTES, canal: true, ...opts });

// --- les cadences -----------------------------------------------------------------------------------------

test('six cadences courantes, toutes à cinq champs, la plus serrée est 5 minutes', () => {
  assert.equal(PRESETS_SANTE.length, 6);
  for (const p of PRESETS_SANTE) assert.equal(p.schedule.split(' ').length, 5);
  assert.equal(PRESETS_SANTE[0].schedule, '*/5 * * * *');
  assert.equal(presetPour('*/15 * * * *'), '*/15 * * * *');
  assert.equal(presetPour('*/4 * * * *'), PERSONNALISEE);
});

// --- la définition envoyée --------------------------------------------------------------------------------------

test('la cible HTTPS est COMPOSÉE d\'une route choisie et d\'un chemin, jamais saisie en entier', () => {
  const d = definitionDe({ ...SANTE_VIDE.values, kind: 'http', route: 'crm.example.com', chemin: '/healthz', expected: '200', threshold: '3' });
  assert.deepEqual(d, { kind: 'http', target: 'https://crm.example.com/healthz', expected: 200,
                        schedule: '*/5 * * * *', threshold: 3 });
  assert.equal(definitionDe({ ...SANTE_VIDE.values, route: 'a.example.com', chemin: 'sans-slash' }).target, 'https://a.example.com/sans-slash');
  assert.equal(definitionDe({ ...SANTE_VIDE.values, route: 'a.example.com', chemin: '' }).target, 'https://a.example.com/');
});

test('un script envoie sa commande telle quelle, et un nombre illisible part tel quel pour être refusé par le serveur', () => {
  const d = definitionDe({ ...SANTE_VIDE.values, kind: 'script', commande: ' pg_isready -q ', expected: '0', threshold: 'trois' });
  assert.equal(d.target, 'pg_isready -q');
  assert.equal(d.expected, 0);
  assert.equal(d.threshold, 'trois');
});

test('valeursDeSonde : la sonde AFFICHÉE, décomposée ; une sonde neuve vise la première route sondable', () => {
  assert.deepEqual(valeursDeSonde(SONDE).route, 'crm.example.com');
  assert.equal(valeursDeSonde({ ...SONDE, target: 'https://crm.example.com/a/b?x=1' }).chemin, '/a/b?x=1');
  assert.equal(valeursDeSonde({ ...SONDE, kind: 'script', target: 'docker ps' }).commande, 'docker ps');
  assert.equal(valeursDeSonde(null, ROUTES).route, 'crm.example.com');
  assert.equal(valeursDeSonde(null, []).route, '');
});

test('routesSondables : servies en TLS, jamais un joker', () => {
  assert.deepEqual(routesSondables(ROUTES).map((r) => r.domain), ['crm.example.com', 'vip.example.com']);
});

// --- la liste : les cinq états -------------------------------------------------------------------------------------

test('chaque état se lit en TEXTE et en pastille (§1.5), avec le jeton qui lui revient', () => {
  const attendu = { unknown: ['neutral', 'Jamais relevée'], healthy: ['success', 'Saine'], unstable: ['accent', 'Instable'],
                    down: ['danger', 'En panne'], stopped: ['neutral', 'Arrêtée'] };
  for (const [etat, [jeton, texte]] of Object.entries(attendu)) {
    assert.deepEqual([ETATS_SANTE[etat].jeton, ETATS_SANTE[etat].libelle], [jeton, texte]);
    const html = facette([{ ...SONDE, state: etat }]);
    assert.match(html, new RegExp(`badge--${jeton}"><span class="badge__point" aria-hidden="true"></span>${texte}`));
  }
});

test('instable dit les échecs SUR le seuil ; en panne dit les échecs consécutifs ET le seuil, jamais « 13 sur 1 »', () => {
  assert.match(facette([{ ...SONDE, state: 'unstable', consecutive_failures: 2 }]), /2 échecs sur 3/);
  assert.match(facette([{ ...SONDE, state: 'down', consecutive_failures: 3, last_detail: 'HTTP 503 (attendu 200)' }]), /3 échecs consécutifs · seuil 3/);
  assert.match(facette([{ ...SONDE, state: 'down', consecutive_failures: 13, threshold: 1 }]), /13 échecs consécutifs · seuil 1/);
  assert.equal(/13 échecs sur 1/.test(facette([{ ...SONDE, state: 'down', consecutive_failures: 13, threshold: 1 }])), false);
  assert.match(facette([{ ...SONDE, state: 'down', consecutive_failures: 1, threshold: 1 }]), /1 échec consécutif · seuil 1/);
  assert.equal(/échec/.test(facette([SONDE]).replace(/relevé|réussi/g, '')), false);
});

test('le motif de la dernière erreur se dit, tel que le serveur le donne, sauf pour une sonde saine', () => {
  assert.match(facette([{ ...SONDE, state: 'down', last_detail: 'HTTP 503 (attendu 200)' }]), /Motif : HTTP 503 \(attendu 200\)/);
  assert.equal(facette([{ ...SONDE, last_detail: 'ancien motif' }]).includes('Motif'), false);
});

test('une sonde suspendue le DIT et propose de la reprendre ; une active propose de la suspendre', () => {
  assert.match(facette([{ ...SONDE, enabled: false }]), /badge--neutral">Suspendue/);
  assert.match(facette([{ ...SONDE, enabled: false }]), /data-sante-bascule="resume"/);
  assert.match(facette([SONDE]), /data-sante-bascule="suspend"/);
});

test('le dernier relevé, sa latence et la durée de l\'état se disent en UTC', () => {
  const html = facette([SONDE]);
  assert.match(html, /Dernier relevé 2026-11-18 10:55 UTC · 14 ms/);
  assert.match(html, /depuis 2026-11-18 09:00 UTC/);
  assert.match(html, /Toutes les 5 minutes \(UTC\)/);
});

test('une sonde jamais relevée le dit au lieu d\'afficher un zéro (§14.6)', () => {
  const html = facette([{ ...SONDE, state: 'unknown', last_run_at: null, last_latency_ms: null, state_since: null, results: [] }]);
  assert.match(html, /Aucun relevé pour l’instant/);
  assert.equal(html.includes('0 ms'), false);
  assert.equal(html.includes('depuis'), false);
});

test('un script montre sa commande exacte ; une sonde HTTPS son adresse et son statut attendu', () => {
  assert.match(facette([{ ...SONDE, kind: 'script', target: 'docker compose exec -T db pg_isready', expected: 0 }]),
    /Commande exécutée dans la cellule : <span class="technique">docker compose exec -T db pg_isready/);
  assert.match(facette([SONDE]), /https:\/\/crm\.example\.com\/healthz<\/span> · statut attendu 200/);
});

test('retirer demande une confirmation DANS le flux, et dit que l\'historique disparaît', () => {
  const html = facette([SONDE], ui({ confirmingRetrait: 'api' }));
  assert.match(html, /aria-label="Confirmer le retrait de la sonde"/);
  assert.match(html, /Son historique disparaît avec elle/);
  assert.match(html, /bouton--destructif" data-sante-confirme-retrait="api"/);
  assert.equal(facette([SONDE]).includes('data-sante-confirme-retrait'), false);
});

// --- les trois absences -------------------------------------------------------------------------------------------------

test('sans sonde : l\'absence est NOMMÉE et la seule commande qui a un objet est « Ajouter une sonde »', () => {
  const html = facette([]);
  assert.match(html, /Aucune sonde : rien ne surveille ce Spark/);
  assert.match(html, /data-ouvre="sante">Ajouter une sonde/);
  assert.equal(html.includes('data-sante-modifie'), false);
});

test('des sondes illisibles ne se rendent PAS comme une absence de sonde (§14.6)', () => {
  const html = renderSanteFacette(null, ui(), { routes: ROUTES, canal: true });
  assert.match(html, /n’ont pas pu être lues/);
  assert.equal(html.includes('Aucune sonde : rien ne surveille'), false);
});

test('sans canal d\'alerte la facette le dit UNE fois, avec le renvoi vers les alertes de la Forge', () => {
  const html = facette([SONDE], ui(), { canal: false });
  assert.equal((html.match(/Aucun canal d’alerte n’est configuré/g) ?? []).length, 1);
  assert.match(html, /<a href="#\/forge\/alertes">/);
  assert.equal(facette([SONDE], ui(), { canal: true }).includes('Aucun canal'), false);
  assert.match(facette([SONDE], ui(), { canal: null }), /n’a pas pu être lu/);
});

// --- la frise ------------------------------------------------------------------------------------------------------------

test('la frise : un rond plein pour un succès, une croix pour un échec, et un équivalent textuel', () => {
  const html = renderFrise(releves(true, false, true, true));
  assert.equal((html.match(/<circle class="frise__ok"/g) ?? []).length, 3);
  assert.equal((html.match(/<path class="frise__echec"/g) ?? []).length, 1);
  assert.match(html, /role="img" aria-label="3 relevés réussis sur les 4 derniers"/);
  assert.match(html, /<span class="frise__texte">3 relevés réussis sur les 4 derniers/);
});

test('la frise : singulier, et rien sans relevé', () => {
  assert.match(renderFrise(releves(true)), /1 relevé réussi sur les 1 derniers/);
  assert.equal(renderFrise([]), '');
});

// --- la modale -------------------------------------------------------------------------------------------------------------

const ouverte = (extra = {}) => facette([SONDE], ui({ open: 'neuve', values: valeursDeSonde(null, ROUTES), ...extra }));

test('la modale porte le titre de la facette et ses contrôles', () => {
  const html = ouverte();
  assert.match(html, /<dialog class="modale" id="sante" aria-labelledby="sante-titre">/);
  assert.match(html, /<h2 class="modale__titre" id="sante-titre">Santé/);
  for (const id of ['sante-name', 'sante-kind', 'sante-route', 'sante-chemin', 'sante-expected', 'sante-preset',
                    'sante-schedule', 'sante-threshold', 'sante-apercu', 'sante-test']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /Ajouter la sonde/);
  assert.match(html, /data-sante-tester/);
});

test('une adresse HTTPS se CHOISIT parmi les routes du Spark : TLS seulement, jamais un joker ni un champ libre', () => {
  const html = ouverte();
  const select = html.match(/<select class="controle technique" id="sante-route"[\s\S]*?<\/select>/)[0];
  assert.deepEqual([...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]), ['crm.example.com', 'vip.example.com']);
  assert.equal(select.includes('vieux.example.com'), false);          // servie en clair
  assert.equal(select.includes('*'), false);                           // un joker ne désigne aucune adresse
  assert.match(html, /il se choisit, il ne se saisit pas/);
});

test('sans route servie en TLS, la modale le DIT au lieu d\'offrir un champ à remplir (§1.4)', () => {
  const html = renderSanteFacette({ checks: [], limit: 20 }, ui({ open: 'neuve' }), { routes: [{ domain: 'vieux.example.com', tls: 0 }], canal: true });
  assert.match(html, /n’a aucune route servie en TLS/);
  assert.equal(html.includes('<select class="controle technique" id="sante-route"'), false);
});

test('le type script montre la commande et DIT sous quel compte elle s\'exécute (§75.5)', () => {
  const html = ouverte({ values: { ...SANTE_VIDE.values, kind: 'script', commande: 'true' } });
  assert.match(html, /data-sante-groupe="script">/);
  assert.match(html, /data-sante-groupe="http" hidden>/);
  assert.match(html, /sous le compte de la pile/);
  assert.match(html, /sa sortie n’est ni gardée ni envoyée/);
  assert.match(html, /Code de sortie attendu/);
});

test('le type http cache la commande et demande un statut attendu', () => {
  const html = ouverte();
  assert.match(html, /data-sante-groupe="script" hidden>/);
  assert.match(html, /Statut HTTP attendu/);
});

test('modifier : le nom est en lecture seule et le dit ; ajouter : le nom se saisit', () => {
  const modif = facette([SONDE], ui({ open: 'api', values: valeursDeSonde(SONDE, ROUTES) }));
  assert.match(modif, /id="sante-name"[^>]*readonly/);
  assert.match(modif, /Le nom d’une sonde ne change pas/);
  assert.match(modif, /Enregistrer la sonde/);
  assert.equal(/id="sante-name"[^>]*readonly/.test(ouverte()), false);
});

test('la fréquence courante qui correspond à la chaîne est sélectionnée, sinon « Personnalisée »', () => {
  assert.match(ouverte({ values: { ...valeursDeSonde(null, ROUTES), schedule: '0 * * * *' } }), /<option value="0 \* \* \* \*" selected>/);
  assert.match(ouverte({ values: { ...valeursDeSonde(null, ROUTES), schedule: '7 * * * *' } }), /<option value="" selected>Personnalisée/);
});

test('l\'engagement est présent mais DÉSACTIVÉ tant qu\'aucune vérification n\'a réussi (§9.9)', () => {
  assert.match(ouverte(), /data-engage="sante"\s+disabled/);
  assert.match(ouverte({ apercu: { description: 'Toutes les 5 minutes (UTC)', next_runs: [] } }), /data-engage="sante"[^>]*>Ajouter la sonde/);
  assert.equal(/data-engage="sante"\s+disabled/.test(ouverte({ apercu: { description: 'x', next_runs: [] } })), false);
});

test('« Tester » est présent, désactivé sans vérification, et un essai dit qu\'il n\'enregistre rien', () => {
  assert.match(ouverte(), /data-sante-tester disabled/);
  assert.equal(ouverte({ apercu: { description: 'x', next_runs: [] } }).includes('data-sante-tester disabled'), false);
  assert.match(renderZoneTest(ui({ test: { ok: true, latency_ms: 18 } })), /L’essai a réussi<\/strong> · 18 ms\. Rien n’a été enregistré/);
  assert.match(renderZoneTest(ui({ test: { ok: false, detail: 'HTTP 503 (attendu 200)' } })), /L’essai a échoué<\/strong> : HTTP 503 \(attendu 200\)[\s\S]*aucune alerte n’est partie/);
  assert.match(renderZoneTest(ui({ essai: true })), /Essai en cours/);
  assert.equal(renderZoneTest(ui()), '');
});

test('l\'aperçu dit la cadence en clair et les prochains relevés ; un refus se dit en alerte', () => {
  const zone = renderZoneApercu(ui({ apercu: { description: 'Toutes les 5 minutes (UTC)', next_runs: ['2026-11-18T11:00:00+00:00', '2026-11-18T11:05:00+00:00'] } }));
  assert.match(zone, /<strong>Toutes les 5 minutes \(UTC\)<\/strong>/);
  assert.equal((zone.match(/<li class="technique">/g) ?? []).length, 2);
  assert.match(renderZoneApercu(ui({ erreur: '« autre.example.com » n’est pas une route de ce Spark' })), /role="alert"><strong>« autre\.example\.com »/);
  assert.match(renderZoneApercu(ui({ chargement: true })), /Vérification…/);
});

test('un refus du serveur s\'affiche DANS la modale et la saisie reste', () => {
  const html = ouverte({ refusal: 'Le Spark « crm » est protégé', values: { ...valeursDeSonde(null, ROUTES), chemin: '/sante' } });
  assert.match(html, /<div class="refus" role="alert"><p><strong>Le Spark « crm » est protégé/);
  assert.match(html, /id="sante-chemin"[^>]*value="\/sante"/);
});

test('la modale fermée ne rend rien, et la saisie est échappée', () => {
  assert.equal(facette([SONDE]).includes('<dialog'), false);
  assert.equal(ouverte({ values: { ...SANTE_VIDE.values, kind: 'script', commande: '"><script>x</script>' } }).includes('<script>'), false);
});

test('un nom de sonde hostile est échappé dans la liste', () => {
  assert.equal(facette([{ ...SONDE, name: '"><img onerror=x>' }]).includes('<img'), false);
});
