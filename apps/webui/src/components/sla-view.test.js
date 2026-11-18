/**
 * @verifies docs/BACKLOG.md#SPK-183 · docs/DAT.md §74.10 · docs/DESIGN_SYSTEM_APP.md SPK-DS-50 ·
 *           docs/DESIGN_SYSTEM.md §1.5 (la couleur ne porte pas seule), §6.13 (l'absence se nomme),
 *           §6.23 (l'engagement destructif NOMME la suppression), §14.6 (mesure indisponible)
 *
 * Ce que ces preuves verrouillent : le menu ne stocke rien — seule la chaîne compte ; l'engagement
 * change de nom et de variante quand l'enregistrement supprimerait ; un SLA illisible ne se rend
 * pas comme une absence de SLA ; une date se donne en UTC puis dans un fuseau, jamais l'un sans l'autre.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PRESETS_SLA, PERSONNALISEE, presetPour, SLA_VIDE, valeursDe, corpsDe, dateUtc, dateLocale,
  libelleRetention, renderZoneApercu, engagementSla, detruit, renderSlaSection, badgeSla,
} from './sla-view.js';

const SLA = {
  configured: true, enabled: true, schedule: '0 2 * * *', description: 'Tous les jours à 02:00 UTC',
  retention_days: 7, retention_count: 5, next_run_at: '2026-11-19T02:00:00+00:00',
  last_run_at: '2026-11-18T02:00:05+00:00', last_status: 'ok', last_error: null,
  snapshots: { count: 5, size_bytes: 2_500_000_000 },
};
const ui = (extra = {}) => ({ ...SLA_VIDE, values: { ...SLA_VIDE.values }, ...extra });

// --- le menu ------------------------------------------------------------------------------------------

test('sept fréquences courantes, chacune une chaîne crontab à cinq champs', () => {
  assert.equal(PRESETS_SLA.length, 7);
  for (const p of PRESETS_SLA) assert.equal(p.schedule.split(' ').length, 5, p.libelle);
});

test('presetPour : la chaîne qui correspond (blancs normalisés) ou « Personnalisée »', () => {
  assert.equal(presetPour('0 2 * * *'), '0 2 * * *');
  assert.equal(presetPour('  0   2  *  * * '), '0 2 * * *');
  assert.equal(presetPour('15 4 * * *'), PERSONNALISEE);
  assert.equal(presetPour(''), PERSONNALISEE);
  assert.equal(presetPour(null), PERSONNALISEE);
});

test('la modale sélectionne la fréquence courante qui correspond à la chaîne, sinon « Personnalisée »', () => {
  const ouverte = (schedule) => renderSlaSection(SLA, ui({ open: true, values: { ...SLA_VIDE.values, schedule } }));
  assert.match(ouverte('0 3 * * 0'), /<option value="0 3 \* \* 0" selected>/);
  assert.match(ouverte('7 7 * * *'), /<option value="" selected>Personnalisée/);
});

// --- les valeurs et le corps -----------------------------------------------------------------------------------

test('valeursDe : la politique AFFICHÉE, jamais des champs vides', () => {
  assert.deepEqual(valeursDe(SLA), { schedule: '0 2 * * *', retention_days: '7', retention_count: '5', enabled: true });
  assert.deepEqual(valeursDe({ ...SLA, retention_days: null }).retention_days, '');
  assert.deepEqual(valeursDe(null), SLA_VIDE.values);
});

test('corpsDe : un champ vide vaut « pas de critère », un texte illisible part tel quel pour que le serveur le refuse', () => {
  assert.deepEqual(corpsDe({ schedule: ' 0 2 * * * ', retention_days: '7', retention_count: '', enabled: true }),
    { schedule: '0 2 * * *', retention_days: 7, retention_count: null, enabled: true });
  assert.equal(corpsDe({ ...SLA_VIDE.values, retention_days: 'sept' }).retention_days, 'sept');
  assert.equal(corpsDe(SLA_VIDE.values, { accepter: true }).accept_deletion, true);
  assert.equal('accept_deletion' in corpsDe(SLA_VIDE.values), false);
});

// --- les dates ------------------------------------------------------------------------------------------------------

test('dateUtc et dateLocale : le même instant, UTC puis fuseau', () => {
  assert.equal(dateUtc('2026-11-19T02:00:00+00:00'), '2026-11-19 02:00 UTC');
  assert.equal(dateLocale('2026-11-19T02:00:00+00:00', 'Europe/Paris'), '2026-11-19 03:00 (Europe/Paris)');
  assert.equal(dateLocale('2026-07-19T02:00:00+00:00', 'Europe/Paris'), '2026-07-19 04:00 (Europe/Paris)');
  assert.equal(dateLocale('pas une date', 'Europe/Paris'), '');
  assert.equal(dateLocale('2026-11-19T02:00:00+00:00', 'Fuseau/Inconnu'), '');
  assert.equal(dateUtc(null), '');
});

test('la prochaine prise se dit en UTC PUIS dans le fuseau, jamais l\'un sans l\'autre', () => {
  const html = renderSlaSection(SLA, SLA_VIDE, { fuseau: 'Europe/Paris' });
  assert.match(html, /2026-11-19 02:00 UTC, soit 2026-11-19 03:00 \(Europe\/Paris\)/);
});

test('si le fuseau EST l\'UTC, on ne répète pas la même heure', () => {
  const html = renderSlaSection(SLA, SLA_VIDE, { fuseau: 'UTC' });
  assert.match(html, /2026-11-19 02:00 UTC<\/dd>/);
  assert.equal(html.includes('soit'), false);
});

// --- la section : ses quatre états ---------------------------------------------------------------------------------------

test('sans SLA : l\'absence est NOMMÉE et la seule commande qui a un objet est « Programmer »', () => {
  const html = renderSlaSection({ configured: false, snapshots: { count: 0, size_bytes: null } });
  assert.match(html, /Aucun SLA : aucun instantané n’est pris automatiquement/);
  assert.match(html, /data-ouvre=\"sla\">Programmer</);
  for (const absent of ['data-sla-bascule', 'data-sla-retrait', 'Modifier']) assert.equal(html.includes(absent), false, absent);
});

test('un SLA illisible ne se rend PAS comme une absence de SLA (§14.6)', () => {
  const html = renderSlaSection(null);
  assert.match(html, /n’a pas pu être lu/);
  assert.equal(html.includes('Aucun SLA'), false);
  assert.equal(html.includes('data-ouvre="sla"'), false);
});

test('un SLA actif : état en pastille ET en texte, fréquence lisible et chaîne, rétention, ce qu\'il tient', () => {
  const html = renderSlaSection(SLA);
  assert.match(html, /badge--success[^>]*><span class="badge__point"[^>]*><\/span>Actif/);
  assert.match(html, /Tous les jours à 02:00 UTC/);
  assert.match(html, /<span class="champ__aide technique">0 2 \* \* \*<\/span>/);
  assert.match(html, /7 jours · 5 instantanés au plus/);
  assert.match(html, /5 instantanés · 2\.\d+ Gio|5 instantanés · 2,\d Gio/);
  assert.match(html, /data-sla-bascule="suspend">Suspendre/);
  assert.match(html, /<h2 id="titre-sla">SLA des instantanés/);
});

test('un SLA suspendu est NEUTRE (une pause n\'est pas une panne) et ne promet aucune prise', () => {
  const html = renderSlaSection({ ...SLA, enabled: false, next_run_at: null });
  assert.match(html, /badge--neutral[^>]*><span class="badge__point"[^>]*><\/span>Suspendu/);
  assert.match(html, /Suspendu : aucune prise prévue/);
  assert.match(html, /data-sla-bascule="resume">Reprendre/);
});

test('un échec se dit en pastille danger ET en texte, avec la raison du serveur telle quelle', () => {
  const html = renderSlaSection({ ...SLA, last_status: 'error', last_error: 'pool saturé' });
  assert.match(html, /badge--danger[^>]*><span class="badge__point"[^>]*><\/span>Échec/);
  assert.match(html, /pool saturé/);
});

test('une taille inconnue n\'est pas zéro (§14.6)', () => {
  const html = renderSlaSection({ ...SLA, snapshots: { count: 3, size_bytes: null } });
  assert.match(html, /3 instantanés<\/dd>/);
  assert.equal(/0 o/.test(html), false);
});

test('sans prise encore : « Aucune prise pour l\'instant »', () => {
  assert.match(renderSlaSection({ ...SLA, last_run_at: null, last_status: null }), /Aucune prise pour l’instant/);
});

test('retirer demande une confirmation DANS LE FLUX qui dit que les instantanés restent', () => {
  const html = renderSlaSection(SLA, ui({ confirmingRetrait: true }));
  assert.match(html, /role="group" aria-label="Confirmer le retrait du SLA"/);
  assert.match(html, /Les 5 instantanés déjà pris restent/);
  assert.match(html, /bouton bouton--destructif" data-sla-confirme-retrait/);
  assert.equal(renderSlaSection(SLA, ui()).includes('data-sla-confirme-retrait'), false);
});

test('un refus d\'un geste de section se dit en alerte', () => {
  assert.match(renderSlaSection(SLA, ui({ refusGeste: 'Le Spark « crm » est protégé' })), /role="alert"><p><strong>Le Spark « crm » est protégé/);
});

// --- la modale et l'aperçu ----------------------------------------------------------------------------------------------------

const APERCU = {
  schedule: '0 2 * * *', description: 'Tous les jours à 02:00 UTC',
  next_runs: ['2026-11-19T02:00:00+00:00', '2026-11-20T02:00:00+00:00', '2026-11-21T02:00:00+00:00'],
  would_delete: [],
};

test('la modale porte le titre de la section, un menu, la chaîne, deux rétentions et « Actif »', () => {
  const html = renderSlaSection(SLA, ui({ open: true, apercu: APERCU }));
  assert.match(html, /<dialog class="modale" id="sla" aria-labelledby="sla-titre">/);
  assert.match(html, /<h2 class="modale__titre" id="sla-titre">SLA des instantanés/);
  for (const attendu of ['id="sla-preset"', 'id="sla-schedule"', 'id="sla-days"', 'id="sla-count"', 'id="sla-enabled"', 'id="sla-apercu"']) {
    assert.ok(html.includes(attendu), attendu);
  }
  assert.match(html, /<label for="sla-preset">Fréquence courante/);
  assert.match(html, /aria-live="polite"/);
});

test('la modale fermée ne rend rien', () => {
  assert.equal(renderSlaSection(SLA, ui({ open: false })).includes('<dialog'), false);
});

test('l\'aperçu dit la phrase lisible et les trois prochaines prises, en UTC', () => {
  const zone = renderZoneApercu(ui({ apercu: APERCU }));
  assert.match(zone, /<strong>Tous les jours à 02:00 UTC<\/strong>/);
  assert.equal((zone.match(/<li><span class="technique">/g) ?? []).length, 3);
  assert.match(zone, /2026-11-20 02:00 UTC/);
});

test('une chaîne refusée porte sa raison, en alerte, sans aperçu', () => {
  const zone = renderZoneApercu(ui({ erreur: 'Cadence : 15 minutes au plus serré' }));
  assert.match(zone, /role="alert"><strong>Cadence : 15 minutes/);
  assert.equal(zone.includes('Prochaines prises'), false);
});

test('avant tout aperçu la zone le dit, et l\'engagement est présent mais DÉSACTIVÉ (§9.9)', () => {
  assert.match(renderZoneApercu(ui()), /Saisissez une fréquence/);
  assert.match(renderZoneApercu(ui({ chargement: true })), /Calcul de l’aperçu/);
  const html = renderSlaSection(SLA, ui({ open: true }));
  assert.match(html, /data-engage="sla"\s+disabled/);
});

test('sans suppression : « Enregistrer », variante primaire', () => {
  const u = ui({ open: true, apercu: APERCU });
  assert.equal(engagementSla(u), 'Enregistrer');
  assert.equal(detruit(u), false);
  const html = renderSlaSection(SLA, u);
  assert.match(html, /bouton bouton--primaire" data-engage="sla"[^>]*>Enregistrer</);
});

test('avec suppression : le bloc NOMME chaque instantané, le bouton dit combien et prend la variante destructive', () => {
  const apercu = { ...APERCU, would_delete: [
    { name: 'SLA_20261108-000000', created_at: 'x', size_bytes: 1_048_576 },
    { name: 'SLA_20261109-000000', created_at: 'x', size_bytes: null }] };
  const u = ui({ open: true, apercu });
  assert.equal(engagementSla(u), 'Enregistrer et supprimer 2 instantanés');
  assert.equal(detruit(u), true);
  const zone = renderZoneApercu(u);
  assert.match(zone, /supprimerait 2\s+instantanés/);
  assert.match(zone, /SLA_20261108-000000<\/span> — 1\.?0? ?Mio|SLA_20261108-000000<\/span> — 1,0 Mio/);
  assert.match(zone, /SLA_20261109-000000<\/span><\/li>/);                       // taille inconnue : pas de zéro
  assert.match(zone, /Cette suppression est définitive/);
  const html = renderSlaSection(SLA, u);
  assert.match(html, /bouton bouton--destructif" data-engage="sla"[^>]*>Enregistrer et supprimer 2 instantanés</);
});

test('au singulier : « supprimer 1 instantané »', () => {
  const u = ui({ apercu: { ...APERCU, would_delete: [{ name: 'SLA_x', size_bytes: null }] } });
  assert.equal(engagementSla(u), 'Enregistrer et supprimer 1 instantané');
});

test('un refus du serveur s\'affiche DANS la modale et n\'efface rien', () => {
  const html = renderSlaSection(SLA, ui({ open: true, apercu: APERCU, refusal: 'Le Spark « crm » est protégé',
                                          values: { ...SLA_VIDE.values, retention_days: '14' } }));
  assert.match(html, /<div class="refus" role="alert"><p><strong>Le Spark « crm » est protégé/);
  assert.match(html, /id="sla-days"[^>]*value="14"/);
});

test('la valeur saisie est échappée', () => {
  const html = renderSlaSection(SLA, ui({ open: true, values: { ...SLA_VIDE.values, schedule: '"><script>x</script>' } }));
  assert.equal(html.includes('<script>'), false);
});

// --- la liste ---------------------------------------------------------------------------------------------------------------------

test('le badge SLA ne se déduit pas d\'un nom : il lit la provenance', () => {
  assert.match(badgeSla({ incus_name: 'SLA_20261118-020005', origin: 'sla' }), /badge--brand[^>]*>SLA</);
  assert.equal(badgeSla({ incus_name: 'SLA_20261118-020005', origin: 'manual' }), '');
  assert.equal(badgeSla({ incus_name: 'avant-deploiement', origin: 'manual' }), '');
  assert.equal(badgeSla(null), '');
});

test('libelleRetention : singulier, pluriel, les deux, aucune', () => {
  assert.equal(libelleRetention(1, null), '1 jour');
  assert.equal(libelleRetention(14, 20), '14 jours · 20 instantanés au plus');
  assert.equal(libelleRetention(null, 1), '1 instantané au plus');
  assert.equal(libelleRetention(null, null), 'aucune');
});


// --- SPK-189 · DAT §74.14 : le taux d'occupation de chaque prise, et « Calculer un autre horaire » ----------------
// @verifies docs/BACKLOG.md#SPK-189 · docs/DAT.md §74.14 · docs/DESIGN_SYSTEM_APP.md SPK-DS-55 · docs/DESIGN_SYSTEM.md §1.5, §6.27

import { horaireAutre, valeursHoraire, phraseCharge } from './sla-view.js';

const RUN = (extra = {}) => ({ at: '2026-11-20T02:00:00+00:00', slot_start: '2026-11-20T02:00:00+00:00',
  slot_end: '2026-11-20T02:15:00+00:00', others: 0, sparks: [], rate: 0, ...extra });
const APERCU_CHARGE = (runs) => ({ schedule: '0 2 * * *', description: 'Tous les jours à 02:00 (UTC)',
  next_runs: runs.map((r) => r.at), would_delete: [], load: { slot_minutes: 15, peak: 2, runs } });
const zone = (runs) => renderZoneApercu({ ...SLA_VIDE, apercu: APERCU_CHARGE(runs) });

test('chaque prise porte SA barre de taux, à côté de sa phrase', () => {
  const html = zone([RUN({ others: 2, sparks: ['crm', 'gram'], rate: 1 }), RUN({ at: '2026-11-21T02:00:00+00:00' })]);
  assert.equal((html.match(/class="charge"/g) ?? []).length, 2);
  assert.match(html, /role="img" aria-label="Taux d’occupation : 100 %"/);
  assert.match(html, /class="charge__barre" style="width:100%"/);
  assert.match(html, /class="charge__barre" style="width:0%"/);
});

test('la phrase NOMME les Sparks et le taux : la couleur ne porte jamais seule', () => {
  assert.equal(phraseCharge(RUN({ others: 2, sparks: ['crm', 'gram'], rate: 1 })),
    '2 autres prises dans cette tranche (02:00–02:15 UTC) : crm, gram · 100 %');
  assert.equal(phraseCharge(RUN({ others: 1, sparks: ['gram'], rate: 0.5 })),
    '1 autre prise dans cette tranche (02:00–02:15 UTC) : gram · 50 %');
});

test('l’absence est NOMMÉE : un zéro vrai, jamais un silence', () => {
  assert.equal(phraseCharge(RUN()), 'aucune autre prise dans cette tranche (02:00–02:15 UTC)');
  assert.match(zone([RUN()]), /aucune autre prise dans cette tranche/);
});

test('la légende dit ce que 100 % veut dire — une seule fois, sous la liste', () => {
  const html = zone([RUN({ others: 1, sparks: ['a'], rate: 1 }), RUN({ at: '2026-11-21T02:00:00+00:00' })]);
  assert.equal((html.match(/Taux d’occupation : la part de la tranche/g) ?? []).length, 1);
  assert.match(html, /sans celle-ci/);
});

test('un aperçu SANS charge (ancien serveur) n’affiche ni barre ni légende, et ne casse rien', () => {
  const html = renderZoneApercu({ ...SLA_VIDE, apercu: { schedule: '0 2 * * *', description: 'x',
    next_runs: ['2026-11-20T02:00:00+00:00'], would_delete: [] } });
  assert.doesNotMatch(html, /class="charge"|Taux d’occupation/);
  assert.match(html, /2026-11-20 02:00/);
});

test('un nom de Spark hostile est échappé dans la phrase', () => {
  const html = zone([RUN({ others: 1, sparks: ['<img onerror=1>'], rate: 1 })]);
  assert.ok(!html.includes('<img onerror=1>'));
  assert.match(html, /&lt;img onerror=1&gt;/);
});

test('la modale porte « Calculer un autre horaire », replié, avec ses deux champs étiquetés', () => {
  const html = renderSlaSection({ configured: false, snapshots: { count: 0 } }, { ...SLA_VIDE, open: true });
  assert.match(html, /data-sla-autre aria-expanded="false"/);
  assert.match(html, /id="sla-autre-champs" hidden/);
  assert.match(html, /<label for="sla-heure">Heure \(UTC\)<\/label>/);
  assert.match(html, /<label for="sla-minute">Minute<\/label>/);
  assert.match(html, /data-sla-calculer/);
  assert.match(html, /Rien n’est enregistré avant/);
});

test('ouverte, la zone l’est — et reprend ce qu’on y avait saisi, refus compris', () => {
  const html = renderSlaSection({ configured: false, snapshots: { count: 0 } },
    { ...SLA_VIDE, open: true, autre: { open: true, heure: '25', minute: '3', erreur: 'L’heure est un entier de 0 à 23 (UTC).' } });
  assert.match(html, /aria-expanded="true"/);
  assert.doesNotMatch(html, /id="sla-autre-champs" hidden/);
  assert.match(html, /id="sla-heure"[^>]*value="25"/);
  assert.match(html, /id="sla-autre-refus" role="alert">L’heure est un entier de 0 à 23/);
});

test('horaireAutre remplace MINUTE et HEURE, et garde jour, mois et jour de la semaine', () => {
  assert.deepEqual(horaireAutre('0 2 * * *', '3', '30'), { schedule: '30 3 * * *' });
  assert.deepEqual(horaireAutre('0 2 1 * *', '4', '5'), { schedule: '5 4 1 * *' });
  assert.deepEqual(horaireAutre('0 3 * * 0', '23', '59'), { schedule: '59 23 * * 0' });
});

test('une fréquence plus fine qu’un jour devient quotidienne à l’instant choisi', () => {
  assert.deepEqual(horaireAutre('*/15 * * * *', '2', '0'), { schedule: '0 2 * * *' });
  assert.deepEqual(horaireAutre('0 */6 * * *', '2', '0'), { schedule: '0 2 * * *' });
});

test('une chaîne illisible retombe sur « tous les jours » plutôt que d’inventer', () => {
  assert.deepEqual(horaireAutre('n’importe quoi', '2', '0'), { schedule: '0 2 * * *' });
});

test('les bornes se refusent ICI, avec leur raison, sans rien proposer', () => {
  for (const [h, m] of [['24', '0'], ['-1', '0'], ['x', '0'], ['', '0'], ['2', '60'], ['2', 'abc'], ['2', '']]) {
    const r = horaireAutre('0 2 * * *', h, m);
    assert.ok(r.erreur && !r.schedule, `${h}:${m}`);
  }
  assert.match(horaireAutre('0 2 * * *', '24', '0').erreur, /heure.*0 à 23/i);
  assert.match(horaireAutre('0 2 * * *', '2', '60').erreur, /minute.*0 à 59/i);
});

test('les champs partent de la chaîne actuelle quand minute et heure sont des entiers', () => {
  assert.deepEqual(valeursHoraire('30 3 * * *'), { heure: '3', minute: '30' });
  assert.deepEqual(valeursHoraire('*/15 * * * *'), { heure: '', minute: '' });
  assert.deepEqual(valeursHoraire('0 */6 * * *'), { heure: '', minute: '' });
  assert.deepEqual(valeursHoraire(''), { heure: '', minute: '' });
});
