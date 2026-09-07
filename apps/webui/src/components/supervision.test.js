/**
 * @verifies docs/BACKLOG.md#SPK-93 · docs/DAT.md §52.6 (le pas de seau est
 *           écrit), §52.7 (l'agrégat dit combien de Sparks il somme), §52.8 (à
 *           quoi chaque courbe se compare), §52.11 (deux surfaces, un sujet
 *           chacune) · §20.3 (le réseau se compare au PLAFOND) ·
 *           docs/DESIGN_SYSTEM_APP.md SPK-DS-20, SPK-DS-02, SPK-DS-05 ·
 *           docs/DESIGN_SYSTEM.md §6.13, §6.14, §14.5
 *
 * Ce que ces preuves gardent, et qu'un œil ne verrait pas : que la ligne de
 * référence publiée soit la BONNE. Le réseau comparé à sa réservation
 * laisserait croire à une garantie que le noyau ne donne pas, et l'écran
 * paraîtrait parfaitement normal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderSupervisionForge, renderSupervisionSpark, renderFenetres,
  renderRepartition, renderContributeurs, decrirePas, renderFraicheur,
  RESSOURCES, FENETRES, SUPERVISION_VIDE,
} from './supervision.js';

const GIO = 1024 ** 3;

const seau = (at, surcharge = {}) => ({
  at, samples: 1, states: ['running'], sparks: 1,
  cpu: 0.4, memory_bytes: 512 * 1024 ** 2, disk_bytes: 3 * GIO,
  rx_bps: 4_000_000, tx_bps: 1_000_000, ...surcharge,
});

const SERIE = [
  seau('2026-09-07T12:00:00+00:00'),
  seau('2026-09-07T12:00:15+00:00', { cpu: 0.9 }),
  seau('2026-09-07T12:00:30+00:00', { cpu: 0.6 }),
];

const LIMITES_SPARK = {
  cpu: 0.5, cpu_mode: 'shared', cpu_capped: false,
  memory_bytes: 2 * GIO, disk_bytes: 10 * GIO, net_bps: 300_000_000,
};

const FORGE = {
  enabled: true, interval_seconds: 15, retention_seconds: 604800,
  window: { name: '1h', seconds: 3600, points: 240, bucket_seconds: 15 },
  last_sample_at: '2026-09-07T12:00:30+00:00',
  total: SERIE,
  limits: { cpu: 3.5, memory_bytes: 90 * GIO, disk_bytes: 5000 * GIO, net_bps: 1e9 },
  sparks: [{ spark: 'helo', state: 'running', limits: LIMITES_SPARK, series: SERIE }],
  spark_points: 60,
};

const pretForge = (surcharge = {}) => renderSupervisionForge({
  ...SUPERVISION_VIDE, status: 'pret', donnees: { ...FORGE, ...surcharge } });

const pretSpark = (surcharge = {}) => renderSupervisionSpark({
  ...SUPERVISION_VIDE, status: 'pret',
  donnees: {
    enabled: true, interval_seconds: 15, retention_seconds: 604800,
    window: { name: '1h', seconds: 3600, points: 240, bucket_seconds: 15 },
    last_sample_at: '2026-09-07T12:00:30+00:00',
    spark: 'helo', state: 'running', series: SERIE, limits: LIMITES_SPARK,
    ...surcharge,
  },
});

/* ---------------------------------------------- les quatre ressources */

test('les quatre ressources demandées sont là, et dans le même ordre partout', () => {
  assert.deepEqual(RESSOURCES.map((r) => r.cle),
                   ['cpu', 'memory_bytes', 'rx_bps', 'disk_bytes']);
  const forge = pretForge();
  const spark = pretSpark();
  for (const ressource of RESSOURCES) {
    assert.ok(forge.includes(ressource.titre), `${ressource.titre} manque à la Forge`);
    assert.ok(spark.includes(ressource.titre), `${ressource.titre} manque au Spark`);
  }
});

/* ------------------------------------------- à quoi chaque courbe se compare */

test('le réseau d’un Spark se compare à son PLAFOND, jamais à sa réservation', () => {
  // §20.3 : la réservation est une grandeur de comptabilité. L'afficher comme
  // référence laisserait croire à une garantie que le noyau ne donne pas.
  const html = pretSpark();
  assert.match(html, /Plafond : 300 Mbit\/s/);
});

test('le CPU d’un Spark partagé se compare à sa RÉSERVATION, et le burst est peint', () => {
  const html = pretSpark();
  assert.match(html, /Réservation : 0,50 CPU/);
  assert.match(html, /graphique__burst/);
  assert.match(html, /Burst/);
});

test('en mode plafonné, la référence CPU se nomme « Plafond »', () => {
  const html = pretSpark({ limits: { ...LIMITES_SPARK, cpu: 1.5, cpu_mode: 'capped', cpu_capped: true } });
  assert.match(html, /Plafond : 1,50 CPU/);
});

test('sur la Forge, les références sont les POOLS — et il n’y a pas de burst', () => {
  // Au-delà d'une capacité de pool, ce n'est plus du burst : c'est un pool
  // dépassé. Peindre l'un comme l'autre nommerait deux choses du même mot.
  const html = pretForge();
  assert.match(html, /Pool allouable : 3,50 CPU/);
  assert.doesNotMatch(html, /graphique__burst/);
});

/* ------------------------------------------------- le pas, et la fraîcheur */

test('le pas de temps est ÉCRIT à côté de la fenêtre', () => {
  // §52.6 : une valeur agrégée sans son pas n'est pas interprétable.
  assert.equal(decrirePas(FORGE), 'un point toutes les 15 s');
  assert.equal(decrirePas({ window: { bucket_seconds: 120 } }), 'un point toutes les 2 min');
  assert.equal(decrirePas({ window: { bucket_seconds: 7200 } }), 'un point toutes les 2 h');
  assert.match(pretForge(), /un point toutes les 15 s/);
});

test('le dernier relevé est DATÉ à l’écran', () => {
  assert.match(pretForge(), /Dernier relevé/);
});

test('sans aucun relevé, l’écran le dit au lieu de laisser un blanc', () => {
  assert.match(renderFraicheur({ ...FORGE, last_sample_at: null }),
               /Aucun relevé pour l’instant/);
});

test('un historien DÉSACTIVÉ est nommé, et ce n’est pas une erreur', () => {
  // §14.5 : c'est une configuration. La peindre en rouge enverrait chercher une
  // panne qui n'existe pas.
  const html = pretForge({ enabled: false, last_sample_at: null });
  assert.match(html, /Supervision désactivée sur cette Forge/);
  assert.match(html, /SPARKD_METRICS_INTERVAL/);
  assert.doesNotMatch(html, /role="alert"/);
});

/* ------------------------------------------------------------ les fenêtres */

test('les fenêtres offertes sont celles que le serveur accepte', () => {
  assert.deepEqual(FENETRES.map(([c]) => c), ['15m', '1h', '6h', '24h', '7d']);
});

test('la fenêtre courante ne se distingue pas QUE par la couleur', () => {
  // §1.5 : elle porte aussi `aria-current`, et le CSS la met en gras.
  const html = renderFenetres('6h', '#/forge/supervision');
  assert.match(html, /href="#\/forge\/supervision\?fenetre=6h" class="fenetre fenetre--courante" aria-current="true"/);
});

test('la fenêtre voyage dans l’adresse : c’est une destination', () => {
  const html = renderFenetres('1h', '#/sparks/helo/mesures');
  assert.match(html, /#\/sparks\/helo\/mesures\?fenetre=24h/);
});

/* -------------------------------------------------- l'agrégat de la Forge */

test('l’écran dit que la somme ne mesure PAS la Forge elle-même', () => {
  // §52.7 : ni sparkd, ni Incus, ni le proxy. Un total qu'on croirait complet
  // ferait chercher la différence dans les Sparks.
  assert.match(pretForge(), /ne mesure ni la\s+Forge elle-même/);
});

test('quand le nombre de Sparks sommés VARIE, l’écran le nomme', () => {
  // Sinon la marche se lit comme un incident (§52.7).
  const varie = [seau('a', { sparks: 1 }), seau('b', { sparks: 3 })];
  const html = renderContributeurs(varie);
  assert.match(html, /varie sur la période/);
  assert.match(html, /de 1 à 3/);
});

test('quand il ne varie pas, l’écran l’écrit simplement', () => {
  assert.match(renderContributeurs(SERIE), /Somme de 1 Spark/);
});

test('sans aucun seau porteur, il n’y a rien à dire sur les contributeurs', () => {
  assert.equal(renderContributeurs([{ at: 'a', samples: 0, sparks: 0 }]), '');
});

/* ---------------------------------------------------- la répartition */

test('la répartition est un TABLEAU, une ligne par Spark, avec des micro-courbes', () => {
  const html = renderRepartition(FORGE.sparks);
  assert.match(html, /<table>/);
  assert.match(html, /class="micro/);
  assert.match(html, /helo/);
});

test('chaque ligne RAMÈNE à la fenêtre du Spark, et ne porte AUCUN geste', () => {
  // §52.11 : l'écran de Forge a pour sujet la Forge. Un bouton « Arrêter » ici
  // donnerait deux sujets à une surface (§34).
  const html = renderRepartition(FORGE.sparks);
  assert.match(html, /href="#\/sparks\/helo\/mesures"/);
  assert.doesNotMatch(html, /<button/);
});

test('l’état de chaque Spark est visible dans la répartition', () => {
  assert.match(renderRepartition(FORGE.sparks), /badge badge--success/);
});

test('une Forge sans Spark NOMME le vide au lieu d’un tableau creux', () => {
  // §6.13 : un état vide se nomme.
  assert.match(renderRepartition([]), /Aucun Spark sur cette Forge/);
});

/* ---------------------------------------------- chargement, erreur, refus */

test('le chargement ne peint pas un graphique vide', () => {
  const html = renderSupervisionForge({ ...SUPERVISION_VIDE, status: 'loading' });
  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /<polyline/);
});

test('une lecture en échec dit que les Sparks, eux, tournent toujours', () => {
  const html = renderSupervisionForge({
    ...SUPERVISION_VIDE, status: 'erreur', error: 'Le tunnel est rompu.' });
  assert.match(html, /role="alert"/);
  assert.match(html, /Le tunnel est rompu\./);
  assert.match(html, /Les Sparks continuent de tourner/);
});

test('la facette d’un Spark rappelle que le burst est normal', () => {
  // SPK-DS-02 : sans cette phrase, chaque exploitant signalera le même faux
  // défaut en voyant 1,99 sur 0,5.
  assert.match(pretSpark(), /c’est le produit qui fonctionne/);
});

test('la facette d’un Spark arrêté nomme l’arrêt au lieu de tracer à zéro', () => {
  const arrete = [
    { at: 'a', cpu: null, memory_bytes: null, disk_bytes: null, rx_bps: null,
      tx_bps: null, samples: 1, states: ['stopped'] },
  ];
  const html = pretSpark({ state: 'stopped', series: arrete });
  assert.match(html, /Arrêté — aucune mesure d’exécution/);
  assert.doesNotMatch(html, /<polyline/);
});
