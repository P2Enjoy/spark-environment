/**
 * @verifies docs/BACKLOG.md#SPK-188 · docs/DAT.md §76.2 (aucun geste), §76.3 (les états de la synthèse),
 *           §76.3 bis (la charge de la semaine), §76.4 (un lien par ligne vers la bonne facette) ·
 *           docs/DESIGN_SYSTEM.md §1.5, §5.2, §6.13, §6.14, §14.5, §14.6 · docs/DESIGN_SYSTEM_APP.md SPK-DS-54
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SURVEILLANCE_VIDE, GRAPHE, lienSla, lienSante, libelleTranche, lectureTranche, trancheSousLePointeur,
  renderChargeSemaine, renderSlaForge, renderSanteForge,
} from './forge-surveillance.js';
import { ONGLETS_FORGE } from './forge-images.js';

const PRETE = (donnees) => ({ ...SURVEILLANCE_VIDE, status: 'ready', donnees, luA: '17:42' });

function semaine(chargees = {}) {
  const slots = new Array(672).fill(0);
  const par = {};
  for (const [i, noms] of Object.entries(chargees)) { slots[i] = noms.length; par[i] = noms; }
  const rangs = Object.keys(chargees).map(Number).sort((a, b) => slots[b] - slots[a] || a - b);
  return {
    start: '2026-11-16T00:00:00+00:00', slot_minutes: 15, slots, peak: Math.max(0, ...slots),
    busy_slots: rangs.length, sparks_by_slot: par,
    busiest: rangs.slice(0, 5).map((i) => ({ index: i, at: '', count: slots[i], sparks: par[i] })),
  };
}

const SLA = {
  summary: { sparks: 4, configured: 3, active: 1, failing: 1, suspended: 1, snapshots_count: 2, snapshots_size_bytes: 2048 },
  sparks: [
    { spark: 'bravo', state: 'failing', schedule: '0 2 * * *', description: 'Tous les jours à 02:00 UTC', enabled: true,
      next_run_at: '2026-11-20T02:00:00+00:00', last_run_at: '2026-11-19T02:00:00+00:00', last_status: 'error',
      last_error: 'pool saturé', retention_days: 7, retention_count: null, snapshots: { count: 0, size_bytes: null } },
    { spark: 'alpha', state: 'active', schedule: '0 2 * * *', description: 'Tous les jours à 02:00 UTC', enabled: true,
      next_run_at: '2026-11-20T02:00:00+00:00', last_run_at: '2026-11-19T02:00:00+00:00', last_status: 'ok',
      last_error: null, retention_days: 7, retention_count: 10, snapshots: { count: 2, size_bytes: 2048 } },
    { spark: 'charlie', state: 'suspended', schedule: '0 3 * * 0', description: 'Le dimanche à 03:00 UTC', enabled: false,
      next_run_at: null, last_run_at: null, last_status: null, last_error: null, retention_days: null,
      retention_count: 3, snapshots: { count: 0, size_bytes: null } },
  ],
  without: ['delta'],
  week: semaine({ 8: ['alpha', 'bravo'], 104: ['alpha'] }),
};

const SANTE = {
  summary: { sparks: 4, monitored: 3, checks: 4, down: 1, unstable: 1, unknown: 0, stopped: 0, healthy: 1, suspended: 1 },
  sparks: [
    { spark: 'alpha', worst: 'down', checks: [
      { name: 'api', kind: 'http', state: 'down', enabled: true, schedule: '*/5 * * * *', description: 'Toutes les 5 minutes (UTC)',
        threshold: 1, consecutive_failures: 4, state_since: '2026-11-19T10:00:00+00:00', last_run_at: '2026-11-19T10:20:00+00:00',
        next_run_at: null, last_latency_ms: 31, last_detail: 'HTTP 500 (attendu 200)',
        results: [{ run_at: 'x', ok: false, latency_ms: 31 }, { run_at: 'y', ok: true, latency_ms: 12 }] },
      { name: 'web', kind: 'script', state: 'healthy', enabled: true, schedule: '*/5 * * * *', description: 'x', threshold: 3,
        consecutive_failures: 0, state_since: null, last_run_at: null, next_run_at: null, last_latency_ms: null,
        last_detail: null, results: [] },
    ] },
    { spark: 'charlie', worst: 'suspended', checks: [
      { name: 'api', kind: 'http', state: 'down', enabled: false, schedule: '*/5 * * * *', description: 'x', threshold: 1,
        consecutive_failures: 2, state_since: null, last_run_at: null, next_run_at: null, last_latency_ms: null,
        last_detail: 'délai dépassé', results: [] },
    ] },
  ],
  without: ['delta'],
};

// --- les liens ------------------------------------------------------------------------------------------

test('les liens mènent à la facette qui règle l\'objet, noms hostiles encodés', () => {
  assert.equal(lienSla('crm'), '#/sparks/crm/instantanes');
  assert.equal(lienSante('crm'), '#/sparks/crm/sante');
  assert.equal(lienSla('a b/<x>'), '#/sparks/a%20b%2F%3Cx%3E/instantanes');
});

test('les deux onglets existent, comme des liens, après la supervision', () => {
  const adresses = ONGLETS_FORGE.map(([href]) => href);
  assert.ok(adresses.includes('#/forge/sla') && adresses.includes('#/forge/sante'));
  assert.ok(adresses.indexOf('#/forge/sla') > adresses.indexOf('#/forge/supervision'));
  assert.equal(ONGLETS_FORGE.find(([h]) => h === '#/forge/sla')[1], 'SLA');
  assert.equal(ONGLETS_FORGE.find(([h]) => h === '#/forge/sante')[1], 'Santé');
});

// --- l'onglet SLA -----------------------------------------------------------------------------------------

test('SLA : la synthèse dit les chiffres avec leurs mots, et le pire vient en tête', () => {
  const rendu = renderSlaForge(PRETE(SLA));
  assert.match(rendu, /SLA programmés<\/dt>\s*<dd><span class="synthese__chiffre technique">3</);
  assert.match(rendu, /<dt><span class="badge badge--danger">\s*<span class="badge__point" aria-hidden="true"><\/span>En échec<\/span><\/dt>\s*<dd><span class="synthese__chiffre technique">1<\/span>/);
  assert.equal((rendu.match(/En échec<\/span>/g) ?? []).length, 2, 'le mot n\u2019est pas répété à côté de sa pastille : une pastille de synthèse, une de ligne');
  assert.match(rendu, /Instantanés tenus<\/dt>\s*<dd><span class="synthese__chiffre technique">2<\/span> <span class="note">2[,\u00a0 ]0? ?Kio|Instantanés tenus<\/dt>\s*<dd><span class="synthese__chiffre technique">2<\/span> <span class="note">[^<]*[Kk]io/);
  const ordre = [...rendu.matchAll(/data-sla-ligne="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ordre, ['bravo', 'alpha', 'charlie']);
});

test('SLA : deux liens par ligne — le Spark, et sa facette Instantanés — et aucun geste', () => {
  const rendu = renderSlaForge(PRETE(SLA));
  assert.match(rendu, /href="#\/sparks\/bravo" class|class="lien-spark technique" href="#\/sparks\/bravo"/);
  assert.match(rendu, /href="#\/sparks\/bravo\/instantanes" data-lien-sla="bravo"\s+aria-label="Ouvrir les instantanés de bravo">Ouvrir les instantanés<\/a>/);
  assert.doesNotMatch(rendu, /data-ouvre|>Programmer<|>Suspendre<|>Reprendre<|>Retirer<|>Modifier<|data-sla-(bascule|retrait|confirme)/);
  assert.doesNotMatch(rendu, /<tr[^>]*onclick|role="link"/);
});

test('SLA : l\'échec dit son motif, un SLA jamais exécuté ne passe pas pour un échec, un suspendu dit qu\'il ne prend rien', () => {
  const rendu = renderSlaForge(PRETE(SLA));
  assert.match(rendu, /Échec : pool saturé/);
  assert.match(rendu, /Aucune prise pour l’instant\./);
  assert.match(rendu, /Suspendu : aucune prise prévue\./);
  assert.match(rendu, /Tenus par le SLA/);
});

test('SLA : une taille inconnue se dit, elle ne vaut pas zéro (§14.6)', () => {
  const donnees = { ...SLA, summary: { ...SLA.summary, snapshots_size_bytes: null },
                    sparks: [{ ...SLA.sparks[1], snapshots: { count: 2, size_bytes: null } }] };
  const rendu = renderSlaForge(PRETE(donnees));
  assert.match(rendu, /taille inconnue/);
  assert.doesNotMatch(rendu, /\b0 o\b/);
});

test('SLA : les Sparks sans SLA sont nommés, chacun un lien', () => {
  const rendu = renderSlaForge(PRETE(SLA));
  assert.match(rendu, /Sparks sans SLA : <a class="lien-spark technique" href="#\/sparks\/delta\/instantanes"/);
});

test('SLA : aucun SLA — l\'absence est nommée, sans rangée de zéros ni graphe', () => {
  const vide = { summary: { sparks: 2, configured: 0, active: 0, failing: 0, suspended: 0,
                            snapshots_count: 0, snapshots_size_bytes: 0 },
                 sparks: [], without: ['alpha', 'bravo'], week: semaine() };
  const rendu = renderSlaForge(PRETE(vide));
  assert.match(rendu, /Aucun SLA n’est programmé sur cette Forge/);
  assert.doesNotMatch(rendu, /synthese|<table|graphe-semaine/);
  assert.match(rendu, /href="#\/sparks\/alpha\/instantanes"/);
});

test('SLA : chargement et erreur — jamais « aucun SLA » à la place de « illisible »', () => {
  const charge = renderSlaForge({ ...SURVEILLANCE_VIDE });
  assert.match(charge, /role="status" aria-busy="true"/);
  assert.match(charge, /data-surveillance-relire="sla" disabled/);
  assert.doesNotMatch(charge, /Aucun SLA/);
  const erreur = renderSlaForge({ ...SURVEILLANCE_VIDE, status: 'error', error: 'La Forge n’a pas répondu.' });
  assert.match(erreur, /role="alert"[\s\S]*La Forge n’a pas répondu\./);
  assert.doesNotMatch(erreur, /Aucun SLA|<table/);
});

test('SLA : la date de lecture est dite, et le bouton relit', () => {
  const rendu = renderSlaForge(PRETE(SLA));
  assert.match(rendu, /Lu à <span class="technique">17:42<\/span>/);
  assert.match(rendu, /<button type="button" class="bouton" data-surveillance-relire="sla">Relire<\/button>/);
});

// --- la charge de la semaine ---------------------------------------------------------------------------

test('graphe : 672 colonnes d\'un pixel, sept repères de jours, UN seul tracé de colonnes', () => {
  const rendu = renderChargeSemaine(SLA.week);
  assert.equal(GRAPHE.largeur, 672);
  assert.match(rendu, /<svg class="graphe-semaine" data-charge-semaine width="672" height="78"\s+viewBox="0 0 672 78" role="img"/);
  assert.equal((rendu.match(/graphe__jour/g) ?? []).length, 7);
  for (const jour of ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim']) assert.ok(rendu.includes(`>${jour}</text>`), jour);
  const colonnes = rendu.match(/class="graphe__colonnes" d="([^"]*)"/)[1];
  assert.deepEqual([...colonnes.matchAll(/M([\d.]+) /g)].map((m) => Number(m[1])), [8.5, 104.5]);
  // la plus chargée (2) touche le haut, l'autre (1) la moitié
  assert.match(colonnes, /M8\.5 64V0\.00M104\.5 64V32\.00/);
});

test('graphe : il a un nom accessible qui résume, un équivalent textuel et une ligne de lecture annoncée', () => {
  const rendu = renderChargeSemaine(SLA.week);
  assert.match(rendu, /aria-label="2 tranches chargées sur 672, pic de 2 prises : la liste des tranches les plus chargées suit"/);
  assert.match(rendu, /<strong>Lundi 02:00 – 02:15 UTC<\/strong> — 2 prises · <span class="technique">alpha, bravo<\/span>/);
  assert.match(rendu, /<strong>Mardi 02:00 – 02:15 UTC<\/strong> — 1 prise ·/);
  assert.match(rendu, /data-charge-lecture aria-live="polite"/);
  assert.match(rendu, /en UTC/);
  assert.match(rendu, /Le graphe défile horizontalement\./);
  assert.doesNotMatch(rendu, /legend|légende/i);        // une seule série : le titre la nomme
});

test('graphe : sans aucune prise planifiée, l\'absence est dite et rien n\'est tracé', () => {
  const rendu = renderChargeSemaine(semaine());
  assert.match(rendu, /Aucune prise n’est planifiée cette semaine/);
  assert.doesNotMatch(rendu, /<svg/);
  assert.match(renderChargeSemaine(undefined), /Aucune prise n’est planifiée/);
});

test('survol : la tranche sous le pointeur se lit en toutes lettres, avec ses Sparks', () => {
  const s = SLA.week;
  assert.equal(libelleTranche(s, 0), 'Lundi 00:00 – 00:15 UTC');
  assert.equal(libelleTranche(s, 95), 'Lundi 23:45 – 00:00 UTC');
  assert.equal(libelleTranche(s, 671), 'Dimanche 23:45 – 00:00 UTC');
  assert.equal(lectureTranche(s, 8), 'Lundi 02:00 – 02:15 UTC · 2 prises · alpha, bravo');
  assert.equal(lectureTranche(s, 104), 'Mardi 02:00 – 02:15 UTC · 1 prise · alpha');
  assert.equal(lectureTranche(s, 9), 'Lundi 02:15 – 02:30 UTC · aucune prise');
  assert.equal(lectureTranche(s, -1), '');
  assert.equal(lectureTranche(s, 672), '');
  assert.equal(lectureTranche(s, 1.5), '');
});

test('survol : la fraction de la largeur donne le rang, bornes comprises', () => {
  const s = SLA.week;
  assert.equal(trancheSousLePointeur(s, 0), 0);
  assert.equal(trancheSousLePointeur(s, 8 / 672), 8);
  assert.equal(trancheSousLePointeur(s, 0.9999), 671);
  assert.equal(trancheSousLePointeur(s, 1), 671);
  assert.equal(trancheSousLePointeur(s, -0.1), null);
  assert.equal(trancheSousLePointeur(s, Number.NaN), null);
});

// --- l'onglet Santé -------------------------------------------------------------------------------------

test('Santé : la synthèse porte les six états, avec leur mot et leur pastille — la couleur ne porte pas seule', () => {
  const rendu = renderSanteForge(PRETE(SANTE));
  for (const mot of ['En panne', 'Instables', 'Jamais relevées', 'Arrêtées', 'Saines', 'Suspendues']) {
    assert.match(rendu, new RegExp(`<dt><span class="badge badge--[a-z]+">\\s*<span class="badge__point" aria-hidden="true"></span>${mot}</span></dt>`), mot);
  }
  assert.match(rendu, /Sparks surveillés<\/dt>\s*<dd><span class="synthese__chiffre technique">3 sur 4</);
  assert.match(rendu, /<dd><span class="synthese__chiffre technique">1<\/span><\/dd>/);
});

test('Santé : une ligne par sonde, le Spark répété en tête, deux liens, la frise et son équivalent textuel', () => {
  const rendu = renderSanteForge(PRETE(SANTE));
  assert.deepEqual([...rendu.matchAll(/data-sante-ligne="([^"]+)"/g)].map((m) => m[1]),
    ['alpha:api', 'alpha:web', 'charlie:api']);
  assert.match(rendu, /href="#\/sparks\/alpha\/sante" data-lien-sante="alpha:api"\s+aria-label="Ouvrir la santé de alpha">Ouvrir la santé<\/a>/);
  assert.match(rendu, /<th scope="row" class="nom-cellule"><a class="lien-spark technique" href="#\/sparks\/alpha">alpha<\/a><\/th>/);
  assert.match(rendu, /1 relevé réussi sur les 2 derniers/);
  assert.match(rendu, /4 échecs consécutifs · seuil 1/);
  assert.match(rendu, /Motif : HTTP 500 \(attendu 200\)/);
  assert.doesNotMatch(rendu, /data-ouvre|Ajouter une sonde|data-sante-(modifie|bascule|retrait)/);
});

test('Santé : une sonde suspendue le dit en texte, et ne montre pas sa commande', () => {
  const rendu = renderSanteForge(PRETE(SANTE));
  assert.match(rendu, /data-sante-ligne="charlie:api"[\s\S]*Suspendue/);
  assert.doesNotMatch(rendu, /target|commande/i);
});

test('Santé : aucune sonde — l\'absence est nommée, les Sparks aussi', () => {
  const vide = { summary: { sparks: 1, monitored: 0, checks: 0, down: 0, unstable: 0, unknown: 0, stopped: 0, healthy: 0, suspended: 0 },
                 sparks: [], without: ['alpha'] };
  const rendu = renderSanteForge(PRETE(vide));
  assert.match(rendu, /Aucune sonde ne surveille cette Forge/);
  assert.match(rendu, /Sparks sans sonde : <a class="lien-spark technique" href="#\/sparks\/alpha\/sante"/);
  assert.doesNotMatch(rendu, /<table|synthese/);
});

test('Santé : chargement et erreur', () => {
  assert.match(renderSanteForge({ ...SURVEILLANCE_VIDE }), /aria-busy="true"/);
  const erreur = renderSanteForge({ ...SURVEILLANCE_VIDE, status: 'error', error: 'refusé' });
  assert.match(erreur, /role="alert"[\s\S]*refusé/);
  assert.doesNotMatch(erreur, /Aucune sonde/);
});

// --- l'échappement ---------------------------------------------------------------------------------------

test('un nom de Spark hostile est échappé partout', () => {
  const hostile = '"><img src=x onerror=alert(1)>';
  const sla = { ...SLA, sparks: [{ ...SLA.sparks[0], spark: hostile }], without: [hostile] };
  const sante = { ...SANTE, sparks: [{ ...SANTE.sparks[0], spark: hostile }], without: [hostile] };
  for (const rendu of [renderSlaForge(PRETE(sla)), renderSanteForge(PRETE(sante))]) {
    assert.doesNotMatch(rendu, /<img/);
    assert.match(rendu, /&lt;img/);
  }
});
