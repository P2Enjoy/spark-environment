/**
 * Parcours navigateur des trois panneaux d'administration.
 *
 * @verifies docs/BACKLOG.md#SPK-21 · docs/DAT.md §26, §26.2, §26.5, §26.6 ·
 *           CLAUDE.md §15 (le comportement s'éprouve, il ne se suppose pas)
 *
 * Les tests unitaires de `spark-admin.js` éprouvent le RENDU. Ici on éprouve ce
 * que le rendu ne peut pas dire : qu'un clic part réellement vers `sparkd`, avec
 * la bonne méthode et le bon corps, et que l'écran RELIT l'état ensuite (§26.6).
 *
 * Le parcours est celui de l'utilisateur : on ouvre le Spark depuis la liste, on
 * clique, on saisit. Aucun appel d'API direct ne remplace un geste.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { createConsoleHost } from '../apps/webui/host/main.js';
import { TunnelManager } from '../apps/webui/host/tunnel.js';

const GIO = 1024 ** 3;
const SPARK = {
  name: 'crm-production', state: 'running', cpu_mode: 'shared', cpu_reservation: 0.5,
  memory_reservation_bytes: 2 * GIO, storage_bytes: 10 * GIO, network_burst_bps: 1e8,
  ipv4_address: '10.77.0.16', image: 'images:debian/13', id: 'S1',
  allowed_commands: ['restart', 'stop', 'delete'], transient: false,
};

let navigateur;
let page;
let serveur;
let base;
/** Tout ce que la console a envoyé au faux `sparkd`, dans l'ordre. */
let appels = [];
/** Refus à servir sur la prochaine restauration, posé par le test qui l'exige. */
let refuseLaRestauration = false;

function fauxSsh() {
  const e = new EventEmitter(); e.stderr = new EventEmitter(); e.kill = () => {}; return e;
}

function repondre(url, init) {
  const methode = init?.method ?? 'GET';
  const corps = init?.body ? JSON.parse(init.body) : null;
  if (methode !== 'GET') appels.push({ methode, url: url.replace(/^.*?(\/v1\/)/, '$1'), corps });

  if (url.includes('/restore')) {
    if (refuseLaRestauration && !corps?.accept_losing_newer) {
      return new Response(JSON.stringify({ detail: {
        error: 'blocked_by_newer_snapshots',
        message: 'Des instantanés plus récents existent.',
        blocking: ['apres-migration'],
      } }), { status: 409 });
    }
    return new Response(JSON.stringify({ restored: true }), { status: 200 });
  }
  if (url.includes('/snapshots')) {
    if (methode !== 'GET') return new Response(JSON.stringify({ ok: true }), { status: 201 });
    return new Response(JSON.stringify({ snapshots: [
      { incus_name: 'avant-deploiement', created_at: '2026-08-19T09:12:00', size_bytes: 0 },
      { incus_name: 'apres-migration', created_at: '2026-08-19T11:40:00', size_bytes: 1e9 },
    ] }), { status: 200 });
  }
  if (url.includes('/ssh-config')) return new Response(JSON.stringify({
    host: SPARK.name, hostname: SPARK.ipv4_address,
    config: `Host ${SPARK.name}\n    HostName ${SPARK.ipv4_address}\n    User root\n    ProxyJump spark-host\n`,
    keys: [{ label: 'poste-admin', fingerprint: 'SHA256:Vf2N7ryPnZPNBN+vs56E1vFAqq' }],
  }), { status: 200 });
  if (url.includes('/ssh-keys')) {
    if (methode !== 'GET') return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response(JSON.stringify({ keys: [
      { label: 'poste-admin', fingerprint: 'SHA256:Vf2N7ryPnZPNBN+vs56E1vFAqq' },
      { label: 'ci-deploiement', fingerprint: 'SHA256:Dw8sT3vB6nMq0aZxKpL5hJ' },
    ] }), { status: 200 });
  }
  if (url.includes('/v1/ingress')) {
    if (methode !== 'GET') return new Response(JSON.stringify({ ok: true }), { status: 201 });
    return new Response(JSON.stringify({ routes: [
      { domain: 'crm.example.com', target_port: 8080, tls: 1,
        spark_name: SPARK.name, applied_at: '2026-08-19T09:00:00' },
    ] }), { status: 200 });
  }
  if (url.includes('/v1/host/cores')) return new Response(JSON.stringify({
    physical_cores: 4,
    shared: { cores: [0, 1, 2], cpus: [0, 4, 1, 5, 2, 6], capacity: 6 },
    dedicated: [{ core_id: 3, cpus: [3, 7], spark_id: 'S1' }],
  }), { status: 200 });
  if (url.includes('/v1/host/sync')) return new Response(JSON.stringify({ hostname: 'h' }), { status: 200 });
  if (url.includes('/v1/host')) return new Response(JSON.stringify({
    hostname: 'spark-experiment',
    cpu: { cores_total: 4, threads_total: 8, cores_dedicated: 1 },
    memory: { total_bytes: 94 * GIO },
    reserves: { memory_bytes: 18 * GIO, arc_bytes: 16 * GIO, margin_bytes: 2 * GIO, storage_bytes: 0 },
    pools: {
      cpu: { capacity: 6, allocated: 2.5, available: 3.5, overcommit: 2 },
      memory: { capacity: 76 * GIO, allocated: 12 * GIO, available: 64 * GIO, overcommit: 1 },
      storage: { capacity: 193 * GIO, allocated: 40 * GIO, available: 153 * GIO, overcommit: 1 },
      network: { capacity: 1e9, allocated: 3e8, available: 7e8, overcommit: 1 },
    },
    addresses: { capacity: 200, used: 4, free: 196, dhcp_dynamic_range: '10.77.0.240-10.77.0.254' },
    topology_synced_at: '2026-08-19T14:05:00',
    reservation_guarantee: 'proportional_between_sparks_only',
  }), { status: 200 });
  if (url.includes('/v1/audit')) return new Response(JSON.stringify({ entries: [] }), { status: 200 });
  if (url.includes('/usage')) return new Response(JSON.stringify({
    cpu: { used: 0.4, reservation: 0.5, over_limit: false },
    memory: { used_bytes: 1e8 }, disk: { used_bytes: 1e8 },
  }), { status: 200 });
  if (/\/v1\/sparks\/[^/?]+(\?|$)/.test(url)) return new Response(JSON.stringify(SPARK), { status: 200 });
  return new Response(JSON.stringify({ sparks: [SPARK] }), { status: 200 });
}

before(async () => {
  const chemin = join(await mkdtemp(join(tmpdir(), 'spark-gestes-')), 'servers.json');
  await writeFile(chemin, JSON.stringify([
    { name: 'validation', host: '203.0.113.10', user: 'ubuntu', port: 22, remotePort: 9876 },
  ]));
  const tunnels = new TunnelManager({
    spawn: () => fauxSsh(), probe: async () => {},
    probeIntervalMs: 3_600_000, openTimeoutMs: 800,
  });
  ({ server: serveur } = createConsoleHost({ tunnels, inventoryPath: chemin, fetch: repondre }));
  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${serveur.address().port}`;
  await fetch(`${base}/api/tunnels`, { method: 'POST', body: JSON.stringify({ name: 'validation' }) });
  navigateur = await chromium.launch();
  page = await navigateur.newPage();
});

after(async () => { await navigateur?.close(); serveur?.close(); });

/**
 * Attend la RELECTURE du §26.6.
 *
 * Après un geste réussi l'écran relit l'état : il repeint d'abord son squelette,
 * puis le panneau. Attendre seulement la disparition du formulaire se libère
 * pendant le squelette, quand le panneau n'est pas encore revenu.
 */
async function attendreRelecture() {
  await page.waitForFunction(
    () => !document.querySelector('dialog.modale[open]')
          && document.querySelector('.onglet[aria-current="page"]'),
    { timeout: 8000 });
}

/** Ouvre le Spark PAR LA LISTE, comme un utilisateur — jamais par URL directe. */
async function ouvrirDepuisLaListe(facette = 'routes') {
  appels = [];
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tbody a');
  await page.click(`tbody a:has-text("${SPARK.name}")`);
  // SPK-33 : la fenêtre répartit ses facettes en onglets (§6.27). On y va en
  // cliquant l'onglet, comme un exploitant. Seul le CHEMIN change.
  await page.click(`.onglet[href$="/${facette}"]`);
  await page.waitForSelector(`.onglet[href$="/${facette}"][aria-current="page"]`,
                             { timeout: 10000 });
  appels = [];
}

test('déclarer une route envoie le domaine, le port et le TLS saisis', async () => {
  await ouvrirDepuisLaListe();
  await page.click('[data-ouvre="route"]');
  await page.waitForSelector('#route-domaine');
  await page.fill('#route-domaine', 'boutique.example.com');
  await page.fill('#route-port', '3000');
  await page.uncheck('#route-tls');
  await page.click('dialog.modale[open] [data-engage]');
  await attendreRelecture();

  const envoi = appels.find((a) => a.url === '/v1/ingress');
  assert.ok(envoi, 'le geste doit partir vers sparkd');
  assert.equal(envoi.methode, 'POST');
  assert.deepEqual(envoi.corps, { spark: SPARK.name, domain: 'boutique.example.com',
                                  port: 3000, tls: false });
  // §26.6 : l'écran RELIT l'état après un succès, il ne le devine pas.
  assert.ok(await page.$('#titre-routes'), 'le panneau est repeint depuis un état relu');
});

test('retirer une route ne part qu’après la confirmation', async () => {
  await ouvrirDepuisLaListe();
  await page.click('[data-retire-route]');
  await page.waitForSelector('.confirmation');
  assert.equal(appels.length, 0, 'ouvrir la confirmation n’appelle rien');

  await page.click('[data-confirme-route]');
  await attendreRelecture();
  const envoi = appels.find((a) => a.url.startsWith('/v1/ingress/'));
  assert.ok(envoi);
  assert.equal(envoi.methode, 'DELETE');
  assert.ok(envoi.url.includes('crm.example.com'));
});

test('enregistrer une clé neuve l’inscrit PUIS l’accorde, dans cet ordre', async () => {
  await ouvrirDepuisLaListe('cles');
  await page.click('[data-ouvre="key"]');
  await page.waitForSelector('#cle-libelle');
  await page.fill('#cle-libelle', 'portable-astreinte');
  await page.fill('#cle-publique', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 astreinte');
  await page.click('dialog.modale[open] [data-engage]');
  await attendreRelecture();

  const ecritures = appels.filter((a) => a.methode === 'POST');
  assert.equal(ecritures[0].url, '/v1/ssh-keys', 'inscrire au registre d’abord');
  assert.deepEqual(ecritures[0].corps, { label: 'portable-astreinte',
                                         public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 astreinte' });
  assert.ok(ecritures[1].url.includes('/ssh-keys/portable-astreinte'), 'accorder ensuite');
  assert.ok(ecritures[1].url.includes(`/sparks/${SPARK.name}/`), 'accorder à CE Spark');
});

test('révoquer une clé part sans confirmation', async () => {
  await ouvrirDepuisLaListe('cles');
  await page.click('[data-revoque]');
  await page.waitForFunction(() => !document.querySelector('[aria-busy]'), { timeout: 6000 })
    .catch(() => {});
  const envoi = appels.find((a) => a.methode === 'DELETE');
  assert.ok(envoi, 'le geste part immédiatement : il est réversible (§26.4)');
  assert.ok(envoi.url.includes('/ssh-keys/poste-admin'));
});

test('prendre un instantané envoie le nom saisi', async () => {
  await ouvrirDepuisLaListe('instantanes');
  await page.click('[data-ouvre="snapshot"]');
  await page.waitForSelector('#instantane-nom');
  await page.fill('#instantane-nom', 'avant-bascule');
  await page.click('dialog.modale[open] [data-engage]');
  await attendreRelecture();

  const envoi = appels.find((a) => a.methode === 'POST' && a.url.endsWith('/snapshots'));
  assert.ok(envoi);
  assert.deepEqual(envoi.corps, { name: 'avant-bascule' });
});

// --- LE CŒUR DE L'UNITÉ (§26.5) ---------------------------------------------

test("l'acceptation de la perte n'est envoyée qu'APRÈS le refus, jamais avant", async () => {
  refuseLaRestauration = true;
  try {
    await ouvrirDepuisLaListe('instantanes');
    await page.click('[data-restaure="avant-deploiement"]');
    await page.waitForSelector('[data-confirme-restauration]');
    // Avant toute tentative, aucun moyen d'accepter la perte n'existe.
    assert.equal(await page.$('[data-accepte-perte]'), null);

    await page.click('[data-confirme-restauration]');
    await page.waitForSelector('[data-accepte-perte]', { timeout: 6000 });

    const premier = appels.find((a) => a.url.includes('/restore'));
    assert.deepEqual(premier.corps, {}, 'la première tentative n’accepte RIEN');
    assert.ok(await page.textContent('.refus').then((t) => t.includes('apres-migration')),
      'le refus nomme ce qui serait détruit');

    appels = [];
    await page.click('[data-accepte-perte]');
    await page.waitForFunction(() => !document.querySelector('[data-accepte-perte]'), { timeout: 6000 });
    const second = appels.find((a) => a.url.includes('/restore'));
    assert.deepEqual(second.corps, { accept_losing_newer: true },
      'et alors seulement le drapeau part, porté par CETTE requête');
  } finally {
    refuseLaRestauration = false;
  }
});

test('une restauration sans blocage ne demande jamais d’accepter une perte', async () => {
  await ouvrirDepuisLaListe('instantanes');
  await page.click('[data-restaure="avant-deploiement"]');
  await page.waitForSelector('[data-confirme-restauration]');
  await page.click('[data-confirme-restauration]');
  await page.waitForFunction(() => !document.querySelector('[data-confirme-restauration]'),
                             { timeout: 6000 });
  assert.equal(await page.$('[data-accepte-perte]'), null);
  const envoi = appels.find((a) => a.url.includes('/restore'));
  assert.deepEqual(envoi.corps, {});
});

test('la modale tient son contrat, et l’annulation rend le focus', async () => {
  // Révisé avec la modale du §6.27. La version précédente vérifiait que le
  // déclencheur S'EFFACE pendant la saisie : c'était vrai du formulaire ouvert
  // dans le flux, qui prenait sa place. La modale le garde visible — c'est lui
  // qui reçoit le focus à la fermeture, et un déclencheur disparu n'aurait rien
  // à qui le rendre.
  //
  // Ce qui reste vérifié est plus fort : une seule modale à la fois, un seul
  // sujet par surface, et le focus rendu.
  await ouvrirDepuisLaListe('routes');
  await page.click('[data-ouvre="route"]');
  await page.waitForSelector('dialog.modale[open]');

  assert.equal(await page.$$eval('dialog.modale[open]', (d) => d.length), 1,
    'une modale n’en ouvre pas une autre');
  assert.ok(await page.$('[data-ouvre="route"]'),
    'le déclencheur reste : c’est lui qui recevra le focus');
  assert.equal(await page.$('#titre-cles'), null,
    'les clés sont sur une autre facette : la surface a un seul sujet');

  await page.click('[data-annule-modale="route"]');
  await page.waitForFunction(() => !document.querySelector('dialog.modale[open]'),
                             { timeout: 6000 });
  const focus = await page.evaluate(() => document.activeElement?.getAttribute('data-ouvre'));
  assert.equal(focus, 'route', 'le focus revient au déclencheur');
});
