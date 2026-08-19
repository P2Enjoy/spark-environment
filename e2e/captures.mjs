/**
 * Captures de l'écran liste des Sparks.
 *
 * @verifies docs/BACKLOG.md#SPK-18 · docs/DESIGN_SYSTEM.md §13 (les captures
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
    ipv4_address: '10.77.0.19', image: 'images:debian/13' },
];
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

async function demarrer({ sparks = SPARKS, lent = false, casse = false, tunnelRompu = false } = {}) {
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

await navigateur.close();
console.log('\n  captures dans e2e/captures/');
process.exit(0);
