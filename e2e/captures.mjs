/**
 * Captures de l'écran liste des Sparks.
 *
 * @verifies docs/BACKLOG.md#SPK-18, #SPK-19, #SPK-20, #SPK-21, #SPK-22 ·
 *           docs/DAT.md §24, §25, §26, §27 · docs/DESIGN_SYSTEM.md §13 (les captures
 *           sont une preuve), §13.1 (validation attendue) · CLAUDE.md §16
 *
 * Les états sont produits depuis un faux `sparkd` local : la DoD demande de voir
 * l'état vide, le chargement, l'erreur et les données longues, et un serveur
 * réel ne les présente pas sur commande.
 */

import { chromium } from 'playwright';
import { createConsoleHost } from '../apps/webui/host/main.js';
import { TunnelManager } from '../apps/webui/host/tunnel.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const SORTIE = new URL('./captures/', import.meta.url).pathname;

const GIO = 1024 ** 3;
const COMMANDES = {
  running: ['delete', 'restart', 'stop'], stopped: ['delete', 'start'],
  pending: ['apply', 'delete'], error: ['delete', 'retry'], creating: [],
};
const SPARKS = [
  { name: 'crm-production', state: 'running', cpu_mode: 'shared', cpu_reservation: 0.5,
    memory_reservation_bytes: 2 * GIO, storage_bytes: 10 * GIO,
    ipv4_address: '10.77.0.16', image: 'images:debian/13' },
  { name: 'boutique', state: 'stopped', cpu_mode: 'shared', cpu_reservation: 1,
    memory_reservation_bytes: 4 * GIO, storage_bytes: 20 * GIO,
    ipv4_address: '10.77.0.17', image: 'images:debian/13' },
  { name: 'postgres-dedie', state: 'creating', cpu_mode: 'dedicated', cpu_cores: 2,
    memory_reservation_bytes: 8 * GIO, storage_bytes: 40 * GIO,
    ipv4_address: '10.77.0.18', image: 'images:debian/13' },
  { name: 'site-vitrine', state: 'error', cpu_mode: 'shared', cpu_reservation: 0.25,
    memory_reservation_bytes: GIO, storage_bytes: 5 * GIO,
    ipv4_address: '10.77.0.19', image: 'images:debian/13',
    last_error: "le noyau a refusé de démarrer la cellule : cgroup indisponible" },
].map((s, i) => ({ ...s, id: `S${i + 1}`, allowed_commands: COMMANDES[s.state] ?? [],
                transient: ['creating', 'starting', 'stopping', 'deleting'].includes(s.state),
                network_burst_bps: 100_000_000 }));
const LONGS = [
  { ...SPARKS[0],
    name: 'spark-au-nom-particulierement-long-pour-eprouver-la-mise-en-page',
    image: 'images:debian/13/cloud/variante-tres-longue-qui-ne-tient-pas-dans-la-cellule' },
  ...SPARKS.slice(1),
];

const USAGE = {
  'crm-production': { cpu: { used: 1.996, reservation: 0.5, over_limit: false },
    memory: { used_bytes: 174_764_032 }, disk: { used_bytes: 534_981_632 } },
  boutique: { cpu: null, memory: null, disk: null, state: 'stopped' },
  'postgres-dedie': { cpu: { used: null }, memory: { used_bytes: 90_000_000 },
    disk: { used_bytes: 210_000_000 } },
  'site-vitrine': { cpu: { used: null }, memory: null, disk: null },
};

function fauxSsh() { const e = new EventEmitter(); e.stderr = new EventEmitter(); e.kill = () => {}; return e; }

async function demarrer({ sparks = SPARKS, lent = false, casse = false, tunnelRompu = false,
                          refusCreation = false, routeEnAttente = false,
                          uneSeuleCle = false, refusRestauration = false,
                          hoteNonReleve = false, sansDetailMemoire = false } = {}) {
  const chemin = join(await mkdtemp(join(tmpdir(), 'spark-cap-')), 'servers.json');
  await writeFile(chemin, JSON.stringify([
    { name: 'validation', host: '203.0.113.10', user: 'ubuntu', port: 22, remotePort: 9876 },
  ]));
  const tunnels = new TunnelManager({
    spawn: () => fauxSsh(),
    probe: async () => { if (tunnelRompu) throw new Error('connexion refusée'); },
    probeIntervalMs: 3_600_000, openTimeoutMs: 800,
  });
  const { server } = createConsoleHost({
    tunnels, inventoryPath: chemin,
    fetch: async (url) => {
      if (lent) await new Promise((r) => setTimeout(r, 4000));
      if (casse) return new Response(JSON.stringify({ detail: { message: 'sparkd a répondu 500 : registre illisible.' } }), { status: 500 });
      // SPK-22 : la carte des cœurs de l'hôte.
      if (url.includes('/v1/host/cores')) return new Response(JSON.stringify({
        physical_cores: 4,
        shared: { cores: [0, 1, 2], cpus: [0, 4, 1, 5, 2, 6], capacity: 6 },
        dedicated: [{ core_id: 3, cpus: [3, 7], spark_id: 'S3' }],
      }), { status: 200 });
      if (url.includes('/v1/host')) {
        // §27.8 : une topologie jamais relevée n'est pas une panne.
        if (hoteNonReleve) return new Response(JSON.stringify({ detail: {
          error: 'host_not_synced',
          message: 'La capacité de cet hôte n’a jamais été relevée.',
          remedy: 'POST /v1/host/sync',
        } }), { status: 409 });
        const GIO = 1024 ** 3;
        return new Response(JSON.stringify({
          hostname: 'spark-experiment',
          cpu: { cores_total: 4, threads_total: 8, cores_dedicated: 1 },
          memory: { total_bytes: 94 * GIO },
          reserves: sansDetailMemoire
            ? { memory_bytes: 18 * GIO, arc_bytes: 0, margin_bytes: 0, storage_bytes: 0 }
            : { memory_bytes: 18 * GIO, arc_bytes: 16 * GIO, margin_bytes: 2 * GIO, storage_bytes: 0 },
          pools: {
            cpu: { capacity: 6, allocated: 2.5, available: 3.5, overcommit: 2 },
            memory: { capacity: 76 * GIO, allocated: 12 * GIO, available: 64 * GIO, overcommit: 1 },
            storage: { capacity: 193 * GIO, allocated: 40 * GIO, available: 153 * GIO, overcommit: 1 },
            network: { capacity: 1e9, allocated: 3e8, available: 7e8, overcommit: 1 },
          },
          addresses: { capacity: 200, used: 4, free: 196,
                       dhcp_dynamic_range: '10.77.0.240-10.77.0.254' },
          topology_synced_at: '2026-08-19T14:05:00',
          reservation_guarantee: 'proportional_between_sparks_only',
        }), { status: 200 });
      }
      // SPK-21 : la restauration d'un instantané ancien est refusée tant que des
      // instantanés plus récents existent (docs/DAT.md §19.1).
      if (url.includes('/restore')) {
        if (!refusRestauration) return new Response(JSON.stringify({ restored: true }), { status: 200 });
        return new Response(JSON.stringify({ detail: {
          error: 'blocked_by_newer_snapshots',
          message: 'Restaurer « avant-deploiement » détruirait des instantanés plus récents.',
          blocking: ['apres-migration', 'avant-mise-a-jour'],
          override: 'Renvoyer avec {"accept_losing_newer": true}.',
        } }), { status: 409 });
      }
      if (url.includes('/snapshots')) return new Response(JSON.stringify({ snapshots: [
        { incus_name: 'avant-deploiement', created_at: '2026-08-19T09:12:00', size_bytes: 0 },
        { incus_name: 'apres-migration', created_at: '2026-08-19T11:40:00', size_bytes: 1_395_864_371 },
        { incus_name: 'avant-mise-a-jour', created_at: '2026-08-19T14:05:00', size_bytes: 297_795_584 },
      ] }), { status: 200 });
      if (url.includes('/ssh-config')) return new Response(JSON.stringify({
        host: 'crm-production', hostname: '10.77.0.16',
        config: 'Host crm-production\n    HostName 10.77.0.16\n    User root\n    ProxyJump spark-host\n',
        keys: uneSeuleCle
          ? [{ label: 'poste-admin', fingerprint: 'SHA256:Vf2N7ryPnZPNBN+vs56E1vFAqq' }]
          : [{ label: 'poste-admin', fingerprint: 'SHA256:Vf2N7ryPnZPNBN+vs56E1vFAqq' },
             { label: 'portable-astreinte', fingerprint: 'SHA256:9kQ2mXbT4uLcR7wPzE1oYn' }],
      }), { status: 200 });
      // Registre commun des clés : ce qui peut être accordé sans en enregistrer.
      if (url.includes('/v1/ssh-keys')) return new Response(JSON.stringify({ keys: [
        { label: 'poste-admin', fingerprint: 'SHA256:Vf2N7ryPnZPNBN+vs56E1vFAqq' },
        { label: 'portable-astreinte', fingerprint: 'SHA256:9kQ2mXbT4uLcR7wPzE1oYn' },
        { label: 'ci-deploiement', fingerprint: 'SHA256:Dw8sT3vB6nMq0aZxKpL5hJ' },
      ] }), { status: 200 });
      if (url.includes('/v1/ingress')) return new Response(JSON.stringify({ routes: [
        { domain: 'crm.example.com', target_port: 8080, tls: 1, spark_name: 'crm-production', applied_at: '2026-08-19T09:00:00' },
        ...(routeEnAttente ? [{ domain: 'preprod.example.com', target_port: 3000, tls: 0,
                                spark_name: 'crm-production', applied_at: null }] : []),
      ] }), { status: 200 });
      if (url.includes('/v1/audit')) return new Response(JSON.stringify({ entries: [
        { ts: '2026-08-19T09:12:00', action: 'snapshot.create', result: 'ok', target_id: 'S1', message: 'Instantané « avant-deploiement » pris.' },
        { ts: '2026-08-19T09:00:00', action: 'ingress.declare', result: 'ok', target_id: 'S1', message: 'crm.example.com → port 8080.' },
        { ts: '2026-08-19T08:55:00', action: 'spark.start', result: 'ok', target_id: 'S1', message: '« starting » → « running ».' },
      ] }), { status: 200 });
      if (refusCreation) return new Response(JSON.stringify({ detail: {
        error: 'admission_refused',
        message: 'Capacité insuffisante — memory : 68719476736 octets demandés, 4294967296 disponibles (capacité 81854656512, alloué 77559689216) — il manque 64424509440 octets',
        shortfalls: [{ resource: 'memory', requested: 68719476736, available: 4294967296, missing: 64424509440 }],
      } }), { status: 409 });
      const detail = url.match(/\/v1\/sparks\/([^/?]+)(\?|$)/);
      if (detail) {
        const nom = decodeURIComponent(detail[1]);
        const s = sparks.find((x) => x.name === nom);
        return new Response(JSON.stringify(s ? { ...s, id: 'S1' } : { detail: { message: 'inconnu' } }),
                            { status: s ? 200 : 404 });
      }
      if (url.includes('/usage')) {
        const nom = decodeURIComponent(url.match(/sparks\/([^/]+)\/usage/)[1]);
        return new Response(JSON.stringify(USAGE[nom] ?? {}), { status: 200 });
      }
      return new Response(JSON.stringify({ sparks }), { status: 200 });
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${base}/api/tunnels`, { method: 'POST', body: JSON.stringify({ name: 'validation' }) });
  return { base, server };
}

async function capturer(page, base, nom, { attendre = 'table', largeur = 1440, hauteur = 900 } = {}) {
  await page.setViewportSize({ width: largeur, height: hauteur });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  if (attendre) await page.waitForSelector(attendre, { timeout: 8000 }).catch(() => {});
  // Attendre les DONNÉES, pas seulement la table : le squelette porte aussi
  // un <table>, et la capture saisissait le chargement au lieu du résultat.
  if (attendre === 'table') await page.waitForSelector('tbody a', { timeout: 8000 }).catch(() => {});
  await page.screenshot({ path: join(SORTIE, `${nom}.png`), fullPage: false });
  console.log(`  ${nom}.png`);
}

const navigateur = await chromium.launch();
const page = await navigateur.newPage();

// La console du navigateur doit rester VIERGE de tout message produit par
// L'APPLICATION. Un avertissement ignoré pendant des mois finit par masquer
// l'erreur qui comptait.
//
// Chromium journalise de lui-même « Failed to load resource » pour toute réponse
// non-2xx, et cette campagne provoque DÉLIBÉRÉMENT des 500, 502 et 409 pour
// capturer les états d'erreur et les refus. Ces lignes-là sont la trace du
// scénario, pas un défaut : elles sont comptées à part et affichées, jamais
// masquées.
const bruits = [];
const reseau = [];
const JOURNAL_RESEAU = /^Failed to load resource: the server responded with a status of \d{3}/;
page.on('console', (m) => {
  if (!['error', 'warning'].includes(m.type())) return;
  (JOURNAL_RESEAU.test(m.text()) ? reseau : bruits).push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => bruits.push(`[pageerror] ${e.message}`));

let ctx = await demarrer();
await capturer(page, ctx.base, '01-liste-chargee');
await capturer(page, ctx.base, '02-liste-mobile', { largeur: 390, hauteur: 844 });
// Navigation clavier : on tabule jusqu'au premier bouton de tri et on capture le focus.
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(ctx.base); await page.waitForSelector('tbody a');
for (let i = 0; i < 4; i += 1) await page.keyboard.press('Tab');
await page.screenshot({ path: join(SORTIE, '03-focus-clavier.png') });
console.log('  03-focus-clavier.png');
// Tri déclenché au clavier.
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
await page.screenshot({ path: join(SORTIE, '04-tri-au-clavier.png') });
console.log('  04-tri-au-clavier.png');
ctx.server.close();

ctx = await demarrer({ sparks: [] });
await capturer(page, ctx.base, '05-etat-vide', { attendre: '.etat-vue' });
ctx.server.close();

ctx = await demarrer({ casse: true });
await capturer(page, ctx.base, '06-etat-erreur', { attendre: '.etat-vue--erreur' });
ctx.server.close();

ctx = await demarrer({ lent: true });
await capturer(page, ctx.base, '07-etat-chargement', { attendre: '.squelette' });
ctx.server.close();

ctx = await demarrer({ sparks: LONGS });
await capturer(page, ctx.base, '08-donnees-longues');
ctx.server.close();

ctx = await demarrer({ tunnelRompu: true });
await capturer(page, ctx.base, '09-tunnel-rompu', { attendre: '.bandeau-tunnel' });
ctx.server.close();

// --- Écran détail (SPK-19) ------------------------------------------------
ctx = await demarrer();
for (const [nom, cible] of [['10-detail-en-marche', 'crm-production'],
                            ['11-detail-transitoire', 'postgres-dedie'],
                            ['12-detail-en-erreur', 'site-vitrine']]) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${ctx.base}/#/sparks/${cible}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.entete-entite', { timeout: 8000 }).catch(() => {});
  await page.screenshot({ path: join(SORTIE, `${nom}.png`) });
  console.log(`  ${nom}.png`);
}
// Confirmation de suppression, ouverte au CLAVIER.
await page.goto(`${ctx.base}/#/sparks/crm-production`);
await page.waitForSelector('[data-commande="delete"]');
await page.focus('[data-commande="delete"]');
await page.keyboard.press('Enter');
await page.waitForSelector('.confirmation', { timeout: 4000 }).catch(() => {});
await page.screenshot({ path: join(SORTIE, '13-confirmation-suppression.png') });
console.log('  13-confirmation-suppression.png');
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${ctx.base}/#/sparks/crm-production`);
await page.waitForSelector('.entete-entite');
await page.screenshot({ path: join(SORTIE, '14-detail-mobile.png') });
console.log('  14-detail-mobile.png');
ctx.server.close();

// --- Écran de création (SPK-20) -------------------------------------------
ctx = await demarrer();
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${ctx.base}/#/creer`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#formulaire-spark');
await page.screenshot({ path: join(SORTIE, '15-creation-vierge.png') });
console.log('  15-creation-vierge.png');

// Soumission vide : les erreurs de FORME, au clavier.
await page.click('button[type="submit"]');
await page.waitForSelector('.champ__erreur', { timeout: 4000 }).catch(() => {});
await page.screenshot({ path: join(SORTIE, '16-creation-forme-invalide.png') });
console.log('  16-creation-forme-invalide.png');

// Demande trop grande : avertissement, bouton TOUJOURS actif.
await page.fill('#name', 'gros-spark');
await page.fill('#memory_gib', '64');
await page.waitForTimeout(150);
await page.screenshot({ path: join(SORTIE, '17-creation-avertissement.png') });
console.log('  17-creation-avertissement.png');
ctx.server.close();

// Refus du serveur : la saisie survit.
ctx = await demarrer({ refusCreation: true });
await page.goto(`${ctx.base}/#/creer`);
await page.waitForSelector('#formulaire-spark');
await page.fill('#name', 'gros-spark');
await page.fill('#memory_gib', '64');
await page.click('button[type="submit"]');
await page.waitForSelector('.refus', { timeout: 6000 }).catch(() => {});
await page.screenshot({ path: join(SORTIE, '18-creation-refus-serveur.png') });
console.log('  18-creation-refus-serveur.png');
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: join(SORTIE, '19-creation-mobile.png') });
console.log('  19-creation-mobile.png');
ctx.server.close();

// --- Panneaux d'administration (SPK-21) -----------------------------------
// docs/DAT.md §26. Le parcours est celui de l'utilisateur : on ouvre le Spark,
// on clique sur le déclencheur, on saisit. Aucune URL directe vers un geste.
const DETAIL = 'crm-production';

async function ouvrirDetail(base, { largeur = 1440, hauteur = 1200 } = {}) {
  await page.setViewportSize({ width: largeur, height: hauteur });
  await page.goto(`${base}/#/sparks/${DETAIL}`, { waitUntil: 'domcontentloaded' });
  // Naviguer vers une URL identique ne recharge pas : sans ce rechargement,
  // l'état des panneaux d'une capture précédente survivrait dans la suivante.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#titre-routes', { timeout: 8000 });
}

ctx = await demarrer();
await ouvrirDetail(ctx.base);
await page.screenshot({ path: join(SORTIE, '20-panneaux-lecture.png') });
console.log('  20-panneaux-lecture.png');

// Formulaire de route ouvert AU CLAVIER, avec une saisie réelle.
await page.focus('[data-ouvre="route"]');
await page.keyboard.press('Enter');
await page.waitForSelector('#route-domaine');
await page.fill('#route-domaine', 'boutique.example.com');
await page.fill('#route-port', '3000');
await page.screenshot({ path: join(SORTIE, '21-route-formulaire.png') });
console.log('  21-route-formulaire.png');

// Confirmation de retrait d'une route, ouverte au clavier.
await ouvrirDetail(ctx.base);
await page.focus('[data-retire-route]');
await page.keyboard.press('Enter');
await page.waitForSelector('.confirmation', { timeout: 4000 });
await page.screenshot({ path: join(SORTIE, '22-route-retrait.png') });
console.log('  22-route-retrait.png');

// Panneau des clés, formulaire ouvert : registre + enregistrement d'une clé neuve.
await ouvrirDetail(ctx.base);
await page.click('[data-ouvre="key"]');
await page.waitForSelector('#cle-registre');
await page.screenshot({ path: join(SORTIE, '23-cles-formulaire.png') });
console.log('  23-cles-formulaire.png');

// Instantanés : prendre, puis confirmer une restauration.
await ouvrirDetail(ctx.base);
await page.click('[data-ouvre="snapshot"]');
await page.waitForSelector('#instantane-nom');
await page.fill('#instantane-nom', 'avant-bascule');
await page.screenshot({ path: join(SORTIE, '24-instantane-formulaire.png') });
console.log('  24-instantane-formulaire.png');

await ouvrirDetail(ctx.base);
await page.click('[data-restaure="avant-deploiement"]');
await page.waitForSelector('.confirmation', { timeout: 4000 });
await page.screenshot({ path: join(SORTIE, '25-instantane-restauration.png') });
console.log('  25-instantane-restauration.png');
ctx.server.close();

// LE CŒUR DE L'UNITÉ (§26.5) : le refus nomme les instantanés qui bloquent, et
// l'acceptation de leur perte n'apparaît qu'À CE MOMENT.
ctx = await demarrer({ refusRestauration: true });
await ouvrirDetail(ctx.base);
await page.click('[data-restaure="avant-deploiement"]');
await page.waitForSelector('[data-confirme-restauration]');
await page.click('[data-confirme-restauration]');
await page.waitForSelector('[data-accepte-perte]', { timeout: 6000 });
await page.screenshot({ path: join(SORTIE, '26-restauration-bloquee.png') });
console.log('  26-restauration-bloquee.png');
ctx.server.close();

// Une seule clé autorisée : la conséquence de la révocation est nommée.
// Et une route enregistrée mais non appliquée (§18.5).
ctx = await demarrer({ uneSeuleCle: true, routeEnAttente: true });
await ouvrirDetail(ctx.base);
await page.screenshot({ path: join(SORTIE, '27-derniere-cle-et-route-en-attente.png') });
console.log('  27-derniere-cle-et-route-en-attente.png');
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${ctx.base}/#/sparks/${DETAIL}`);
await page.waitForSelector('#titre-routes');
await page.screenshot({ path: join(SORTIE, '28-panneaux-mobile.png'), fullPage: true });
console.log('  28-panneaux-mobile.png');
ctx.server.close();

// --- Écran des pools de l'hôte (SPK-22) -----------------------------------
// docs/DAT.md §27. On y va PAR LA NAVIGATION, comme un utilisateur.
ctx = await demarrer();
await page.setViewportSize({ width: 1440, height: 1250 });
await page.goto(ctx.base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('tbody a');
await page.click('nav a[href="#/hote"]');
await page.waitForSelector('#titre-pools', { timeout: 8000 });
await page.screenshot({ path: join(SORTIE, '29-hote-pools.png') });
console.log('  29-hote-pools.png');
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: join(SORTIE, '30-hote-mobile.png'), fullPage: true });
console.log('  30-hote-mobile.png');
ctx.server.close();

// Base migrée mais pas encore relevée : la somme sans sa répartition inventée.
ctx = await demarrer({ sansDetailMemoire: true });
await page.setViewportSize({ width: 1440, height: 1250 });
await page.goto(`${ctx.base}/#/hote`, { waitUntil: 'domcontentloaded' });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#titre-memoire', { timeout: 8000 });
await page.screenshot({ path: join(SORTIE, '31-hote-reserve-sans-detail.png') });
console.log('  31-hote-reserve-sans-detail.png');
ctx.server.close();

// §27.8 : topologie jamais relevée — un état nommé, avec son remède en bouton.
ctx = await demarrer({ hoteNonReleve: true });
await page.goto(`${ctx.base}/#/hote`, { waitUntil: 'domcontentloaded' });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-action="relever"]', { timeout: 8000 });
await page.screenshot({ path: join(SORTIE, '32-hote-non-releve.png') });
console.log('  32-hote-non-releve.png');
ctx.server.close();

await navigateur.close();
console.log('\n  captures dans e2e/captures/');
if (reseau.length) {
  console.log(`  journal réseau de Chromium, attendu (états d’erreur et refus provoqués) :`);
  for (const r of [...new Set(reseau)]) console.log(`    ${r}`);
}
if (bruits.length) {
  console.error(`\n  CONSOLE NON VIERGE — ${bruits.length} message(s) de l’application :`);
  for (const b of [...new Set(bruits)]) console.error(`    ${b}`);
  process.exit(1);
}
console.log('  console vierge de tout message applicatif');
process.exit(0);
