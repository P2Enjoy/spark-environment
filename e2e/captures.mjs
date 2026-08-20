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
import { SessionManager } from '../apps/webui/host/terminal.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';

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
  // SPK-34 : un Spark PROTÉGÉ. Sans lui, la capture de la liste ne montrerait
  // pas le badge, que le §35.4 veut visible partout où le Spark est listé.
  { name: 'analytics', state: 'pending', cpu_mode: 'capped', cpu_max: 0.25,
    memory_reservation_bytes: GIO / 2, storage_bytes: 5 * GIO,
    ipv4_address: '10.77.0.20', image: 'images:debian/13',
    protected: true, protected_at: '2026-08-19T10:00:00' },
].map((s, i) => ({ ...s, id: `S${i + 1}`,
                // SPK-43 · §37.2 : la CELLULE est le signal d'un Spark où l'on
                // peut entrer, et elle n'existe qu'après une application
                // réussie — pas dès l'écriture au registre, contrairement à
                // l'adresse. Un Spark « pending » n'en a donc pas.
                incus_name: s.state === 'pending' ? null : s.name,
                // Un Spark protégé n'accepte AUCUNE commande (§24.1) : c'est le
                // runtime qui le dit, et le factice doit dire la même chose.
                allowed_commands: s.protected ? [] : (COMMANDES[s.state] ?? []),
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
                          hoteNonReleve = false, sansDetailMemoire = false, chaineRompue = false,
                          ancreEnAlerte = false, sansServeur = false,
                          // SPK-53 · §40.3 : l'empreinte que la Forge publie.
                          // Un VRAI commit du dépôt, pour que la comparaison
                          // porte sur une ascendance réelle et non simulée.
                          buildCommit = null,
                          // SPK-44 · §37.6 : le relevé Docker que la console
                          // rendra. Les états d'absence ne se provoquent pas sur
                          // un faux `sshd` — ils se posent.
                          dockerReleve = null,
                          // SPK-44, deuxième tranche : l'inspection et les
                          // journaux d'un conteneur ouvert.
                          dockerConteneur = null, dockerJournaux = null,
                          // SPK-45 : l'issue que le geste rend, et l'inspection
                          // RELUE après lui. Rendre deux fois la même ferait
                          // afficher « en marche » sous « arrêt réussi » — la
                          // contradiction même que le §37.7.2 existe pour
                          // éviter, et une capture qui la montre est fausse.
                          gesteRendu = null, dockerConteneurApres = null,
                          // SPK-45 tranche 2 : le sondage du shell (§37.4.7).
                          probeShell = null,
                          terminaux = null, sondageSshd = null } = {}) {
  const dossier = await mkdtemp(join(tmpdir(), 'spark-cap-'));
  const chemin = join(dossier, 'servers.json');
  // L'ANCRE vit dans ce dossier jetable, et c'est nécessaire à deux titres :
  // sans chemin explicite elle irait dans le `~/.config/spark` du poste, ce qui
  // ferait dépendre le verdict rendu par la capture de l'état de la machine qui
  // la produit — et y laisserait un fichier (SPK-38, docs/DAT.md §36.2).
  const cheminAncres = join(dossier, 'anchors.json');
  // SPK-41 : DEUX serveurs, sinon le sélecteur ne se voit pas — avec un seul,
  // le produit affiche le nom plutôt qu'un contrôle mort (§22.4.5). La forme du
  // fichier est la version 1 (§22.4.2), et le second est déclaré par ALIAS pour
  // que la capture montre les deux genres.
  await writeFile(chemin, JSON.stringify(sansServeur ? { version: 1, servers: [] } : {
    version: 1,
    current: 'validation',
    servers: [
      { name: 'validation', kind: 'ssh', host: '203.0.113.10', user: 'ubuntu',
        port: 22, remotePort: 9876 },
      { name: 'recette', kind: 'alias', sshHost: 'spark-recette', remotePort: 9876 },
    ],
  }));
  // Pour la capture de l'ALERTE : la console a déjà vu une histoire plus longue
  // que celle que la Forge annoncera. C'est exactement la troncature (§36.9.6).
  await writeFile(cheminAncres, JSON.stringify(ancreEnAlerte
    ? { validation: { head: 'a1b2c3', length: 128, seenAt: '2026-08-19T15:30:00' } }
    : {}));
  const tunnels = new TunnelManager({
    spawn: () => fauxSsh(),
    probe: async () => { if (tunnelRompu) throw new Error('connexion refusée'); },
    probeIntervalMs: 3_600_000, openTimeoutMs: 800,
  });
  const { server } = createConsoleHost({
    tunnels, inventoryPath: chemin, anchorPath: cheminAncres,
    // SPK-43 · §37.3 : le terminal lance un vrai `ssh` et sonde un vrai port.
    // Les captures ont besoin des ÉCRANS, pas d'un réseau : on injecte donc le
    // gestionnaire de sessions et le sondage, comme le font les preuves de
    // routes. Tout le reste du chemin est celui de la production.
    ...(terminaux ? { terminals: terminaux } : {}),
    ...(sondageSshd ? { probeSshd: async () => sondageSshd } : {}),
    ...(probeShell ? { probeShell } : {}),
    ...(dockerReleve ? { readDocker: async (spark) => ({ spark, ...dockerReleve }) } : {}),
    ...(dockerConteneur ? { readContainer: (() => {
      let lu = 0;
      return async () => (dockerConteneurApres && lu++ > 0
        ? dockerConteneurApres : dockerConteneur);
    })() } : {}),
    ...(dockerJournaux ? { readLogs: async () => dockerJournaux } : {}),
    ...(gesteRendu ? { actOnContainer: async (a) => ({ name: a.nom, geste: a.geste,
                                                       ...gesteRendu }) } : {}),
    fetch: async (url, options = {}) => {
      if (lent) await new Promise((r) => setTimeout(r, 4000));
      if (casse) return new Response(JSON.stringify({ detail: { message: 'sparkd a répondu 500 : registre illisible.' } }), { status: 500 });
      // SPK-22 : la carte des cœurs de la Forge.
      if (url.includes('/v1/forge/cores')) return new Response(JSON.stringify({
        physical_cores: 4,
        shared: { cores: [0, 1, 2], cpus: [0, 4, 1, 5, 2, 6], capacity: 6 },
        dedicated: [{ core_id: 3, cpus: [3, 7], spark_id: 'S3' }],
      }), { status: 200 });
      if (url.includes('/v1/forge')) {
        // §27.8 : une topologie jamais relevée n'est pas une panne.
        if (hoteNonReleve) return new Response(JSON.stringify({ detail: {
          error: 'forge_not_synced',
          message: 'La capacité de cette Forge n’a jamais été relevée.',
          remedy: 'POST /v1/forge/sync',
        } }), { status: 409 });
        const GIO = 1024 ** 3;
        return new Response(JSON.stringify({
          hostname: 'spark-experiment',
          // SPK-53 · §40.2 : `null` vaut « non estampillée », et c'est une
          // réponse. La console ne doit pas la confondre avec « à jour ».
          build: buildCommit
            ? { commit: buildCommit, version: `0.0.0+${buildCommit.slice(0, 12)}`,
                dirty: false, committed_at: null, installed_at: null,
                installed_from: null }
            : { commit: null, version: '0.0.0+inconnue', dirty: false,
                committed_at: null, installed_at: null, installed_from: null },
          cpu: { cores_total: 4, threads_total: 8, cores_dedicated: 1 },
          memory: { total_bytes: 94 * GIO },
          reserves: {
            ...(sansDetailMemoire
              ? { memory_bytes: 18 * GIO, arc_bytes: 0, margin_bytes: 0, storage_bytes: 0 }
              : { memory_bytes: 18 * GIO, arc_bytes: 16 * GIO, margin_bytes: 2 * GIO,
                  storage_bytes: 0 }),
            // SPK-30 : la marge de métadonnées grossit l'alloué du disque ; la
            // capture doit montrer que l'écart est expliqué (docs/DAT.md §8.8.2).
            storage_metadata_margin_bytes: 64 * 1024 * 1024,
            storage_metadata_total_bytes: 4 * 64 * 1024 * 1024,
          },
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
      // Catalogue d'images (§33.3) : les trois états, pour que la capture les
      // montre tous les trois plutôt qu'un seul.
      if (url.includes('/v1/images')) return new Response(JSON.stringify({ images: [
        { reference: 'images:debian/13', label: 'Debian 13 « trixie »', state: 'verified',
          verified_at: '2026-08-19T09:45:00', is_default: 1,
          detail: 'relevé sur 272 produits publiés' },
        { reference: 'images:ubuntu/24.04', label: 'Ubuntu 24.04 LTS', state: 'verified',
          verified_at: '2026-08-19T09:45:00', is_default: 0,
          detail: 'relevé sur 272 produits publiés' },
        { reference: 'images:debian/11', label: 'Debian 11 « bullseye »', state: 'missing',
          verified_at: '2026-08-19T09:45:00', is_default: 0,
          detail: 'le dépôt ne publie plus cet alias' },
        { reference: 'images:alpine/3.21', label: 'Alpine 3.21', state: 'unknown',
          verified_at: null, is_default: 0, detail: '' },
      ] }), { status: 200 });
      // SPK-54 · §42 : l'amorçage. Le relevé montre les TROIS états, dont le
      // `docker.io` de distribution — celui qui décide de l'unité (§41.2) —,
      // et l'amorçage rend le sort de chaque ligne.
      if (url.includes('/bootstrap')) {
        const pose = (key, label, state, detail, outcome) => ({
          key, label, state, detail,
          action: outcome && outcome !== 'inchangé' ? 'amorcé' : 'aucune',
          ...(outcome ? { outcome } : {}),
        });
        const amorce = options.method === 'POST';
        return new Response(JSON.stringify(amorce
          ? { spark: DETAIL, path: 'incus_exec', changed: true, complete: true, items: [
              pose('sshd', 'serveur SSH', 'present', 'active', 'inchangé'),
              pose('cles', 'clés d’accès', 'present', 'conformes au registre', 'installé'),
              pose('depot', 'dépôt Docker amont', 'present', 'sources.list.d/docker.list', 'installé'),
              pose('docker', 'moteur Docker', 'present', 'Docker version 29.7.2', 'installé'),
              pose('compose', 'greffon Compose', 'present', 'Docker Compose version v2.40.0', 'installé'),
            ] }
          : { spark: DETAIL, reachable: true, complete: false, items: [
              pose('sshd', 'serveur SSH', 'present', 'active'),
              pose('cles', 'clés d’accès', 'absent', 'aucun fichier authorized_keys'),
              pose('depot', 'dépôt Docker amont', 'absent', 'absent'),
              pose('docker', 'moteur Docker', 'defect',
                   'Docker version 26.1.5 — paquet « docker.io » de la distribution. '
                   + 'Son profil AppArmor refuse socketpair() sous imbrication : les '
                   + 'conteneurs démarrent puis meurent.'),
              pose('compose', 'greffon Compose', 'absent', 'absent'),
            ] }), { status: 200 });
      }
      // SPK-39 : la vérification de la chaîne est un relevé explicite.
      if (url.includes('/v1/audit/verify')) return new Response(JSON.stringify(
        chaineRompue
          ? { checked: 42, head: 'a1b2c3', length: 128, intact: false,
              verified_at: '2026-08-19T15:30:00',
              break: { id: 42, reason: 'entry_hash', ts: '2026-08-19T11:20:00',
                       action: 'spark.delete' } }
          : ancreEnAlerte
            // Chaîne PARFAITEMENT valide, et plus courte : c'est ce que voit la
            // Forge après qu'on lui a coupé la fin de son journal.
            ? { checked: 96, head: 'z9y8x7', length: 96, intact: true,
                verified_at: '2026-08-19T15:30:00', break: null }
            : { checked: 128, head: 'a1b2c3', length: 128, intact: true,
                verified_at: '2026-08-19T15:30:00', break: null },
      ), { status: 200 });
      if (url.includes('/v1/audit')) return new Response(JSON.stringify({ entries: [
        { ts: '2026-08-19T09:12:00', action: 'snapshot.create', result: 'ok', actor_class: 'human', actor: 'console/validation key=SHA256:AbCd12', target_id: 'S1', message: 'Instantané « avant-deploiement » pris.' },
        { ts: '2026-08-19T09:00:00', action: 'ingress.declare', result: 'ok', actor_class: 'human', actor: 'console/validation key=SHA256:AbCd12', target_id: 'S1', message: 'crm.example.com → port 8080.' },
        { ts: '2026-08-19T08:55:00', action: 'spark.settle', result: 'ok',
          actor_class: 'runtime', actor: 'sparkd',
          target_id: 'S1', message: '« starting » → « running ».' },
      ] }), { status: 200 });
      if (refusCreation) return new Response(JSON.stringify({ detail: {
        error: 'admission_refused',
        message: 'Capacité insuffisante — memory : 68719476736 octets demandés, 4294967296 disponibles (capacité 81854656512, alloué 77559689216) — il manque 64424509440 octets',
        shortfalls: [{ resource: 'memory', requested: 68719476736, available: 4294967296, missing: 64424509440 }],
      } }), { status: 409 });
      // SPK-34 : la protection, pour que la capture montre le badge, la section
      // et la confirmation de révocation qui NOMME (docs/DAT.md §35).
      if (url.includes('/protection')) return new Response(JSON.stringify({
        name: 'analytics', protected: true, protected_at: '2026-08-19T10:00:00',
      }), { status: 200 });
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

/**
 * Pousse un quota à sa borne haute, AU CLAVIER (SPK-59, §6.9 bis).
 *
 * On ne « remplit » pas un curseur : `page.fill` rend « Malformed value » sur un
 * `input[type=range]`. `Fin` est le geste natif qui va à la borne haute — la
 * capacité TOTALE de la Forge, donc au-delà de ce qui reste libre.
 */
async function auMaximum(selecteur) {
  const controle = page.locator(selecteur);
  const type = await controle.getAttribute('type');
  await controle.focus();
  if (type === 'range') await controle.press('End');
  else await controle.fill('999999');   // repli du §6.9 bis : resté une saisie
}

// Soumission vide : les erreurs de FORME, au clavier.
await page.click('button[type="submit"]');
await page.waitForSelector('.champ__erreur', { timeout: 4000 }).catch(() => {});
await page.screenshot({ path: join(SORTIE, '16-creation-forme-invalide.png') });
console.log('  16-creation-forme-invalide.png');

// Demande trop grande : avertissement, bouton TOUJOURS actif. Le curseur est
// poussé à la capacité TOTALE de la Forge, donc au-delà de ce qui reste libre —
// c'est là que l'avertissement doit apparaître, et il se rafraîchit désormais
// pendant le réglage (SPK-59).
await page.fill('#name', 'gros-spark');
await auMaximum('#memory_gib');
await page.waitForTimeout(150);
// Le formulaire est plus haut depuis les curseurs : sans cela l'avertissement,
// qui EST le sujet de cette capture, tombe sous la ligne de flottaison.
await page.setViewportSize({ width: 1440, height: 1100 });
await page.screenshot({ path: join(SORTIE, '17-creation-avertissement.png') });
console.log('  17-creation-avertissement.png');
ctx.server.close();

// Refus du serveur : la saisie survit.
ctx = await demarrer({ refusCreation: true });
await page.setViewportSize({ width: 1440, height: 1100 });
await page.goto(`${ctx.base}/#/creer`);
await page.waitForSelector('#formulaire-spark');
await page.fill('#name', 'gros-spark');
await auMaximum('#memory_gib');
await page.click('button[type="submit"]');
await page.waitForSelector('.refus', { timeout: 6000 }).catch(() => {});
await page.screenshot({ path: join(SORTIE, '18-creation-refus-serveur.png') });
console.log('  18-creation-refus-serveur.png');
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: join(SORTIE, '19-creation-mobile.png') });
console.log('  19-creation-mobile.png');
ctx.server.close();

// SPK-59 · §6.9 bis, condition 1 : sans capacité relevée, il n'y a pas de
// bornes, donc pas de curseur. Les quotas redeviennent des saisies, et le
// libellé reprend son unité — une saisie ne dit pas dans quoi taper.
ctx = await demarrer({ hoteNonReleve: true });
await page.setViewportSize({ width: 1440, height: 1000 });
await page.goto(`${ctx.base}/#/creer`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#formulaire-spark');
await page.screenshot({ path: join(SORTIE, '19b-creation-sans-capacite.png') });
console.log('  19b-creation-sans-capacite.png');
ctx.server.close();

// --- Panneaux d'administration (SPK-21) -----------------------------------
// docs/DAT.md §26. Le parcours est celui de l'utilisateur : on ouvre le Spark,
// on clique sur le déclencheur, on saisit. Aucune URL directe vers un geste.
const DETAIL = 'crm-production';

// SPK-33 : la fenêtre répartit ses facettes en onglets (§6.27). Chaque capture
// montre donc la facette qu'elle illustre.
async function ouvrirDetail(base, { largeur = 1440, hauteur = 1200, facette = '' } = {}) {
  await page.setViewportSize({ width: largeur, height: hauteur });
  await page.goto(`${base}/#/sparks/${DETAIL}`, { waitUntil: 'domcontentloaded' });
  // Naviguer vers une URL identique ne recharge pas : sans ce rechargement,
  // l'état des panneaux d'une capture précédente survivrait dans la suivante.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.onglet', { timeout: 8000 });
  if (facette) {
    await page.click(`.onglet[href$="/${facette}"]`);
    await page.waitForSelector(`.onglet[href$="/${facette}"][aria-current="page"]`,
                               { timeout: 8000 });
  }
}

ctx = await demarrer();
await ouvrirDetail(ctx.base, { facette: 'routes' });
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
await ouvrirDetail(ctx.base, { facette: 'routes' });
await page.focus('[data-retire-route]');
await page.keyboard.press('Enter');
await page.waitForSelector('.confirmation', { timeout: 4000 });
await page.screenshot({ path: join(SORTIE, '22-route-retrait.png') });
console.log('  22-route-retrait.png');

// Panneau des clés, formulaire ouvert : registre + enregistrement d'une clé neuve.
await ouvrirDetail(ctx.base, { facette: 'cles' });
await page.click('[data-ouvre="key"]');
await page.waitForSelector('#cle-registre');
await page.screenshot({ path: join(SORTIE, '23-cles-formulaire.png') });
console.log('  23-cles-formulaire.png');

// Instantanés : prendre, puis confirmer une restauration.
await ouvrirDetail(ctx.base, { facette: 'instantanes' });
await page.click('[data-ouvre="snapshot"]');
await page.waitForSelector('#instantane-nom');
await page.fill('#instantane-nom', 'avant-bascule');
await page.screenshot({ path: join(SORTIE, '24-instantane-formulaire.png') });
console.log('  24-instantane-formulaire.png');

await ouvrirDetail(ctx.base, { facette: 'instantanes' });
await page.click('[data-restaure="avant-deploiement"]');
await page.waitForSelector('.confirmation', { timeout: 4000 });
await page.screenshot({ path: join(SORTIE, '25-instantane-restauration.png') });
console.log('  25-instantane-restauration.png');
ctx.server.close();

// LE CŒUR DE L'UNITÉ (§26.5) : le refus nomme les instantanés qui bloquent, et
// l'acceptation de leur perte n'apparaît qu'À CE MOMENT.
ctx = await demarrer({ refusRestauration: true });
await ouvrirDetail(ctx.base, { facette: 'instantanes' });
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
await ouvrirDetail(ctx.base, { facette: 'routes' });
await page.screenshot({ path: join(SORTIE, '27-derniere-cle-et-route-en-attente.png') });
console.log('  27-derniere-cle-et-route-en-attente.png');
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${ctx.base}/#/sparks/${DETAIL}/routes`);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#titre-routes', { timeout: 15000 });
await page.screenshot({ path: join(SORTIE, '28-panneaux-mobile.png'), fullPage: true });
console.log('  28-panneaux-mobile.png');
ctx.server.close();

// --- Écran des pools de la Forge (SPK-22) -----------------------------------
// docs/DAT.md §27. On y va PAR LA NAVIGATION, comme un utilisateur.
ctx = await demarrer();
await page.setViewportSize({ width: 1440, height: 1250 });
await page.goto(ctx.base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('tbody a');
await page.click('nav a[href="#/forge"]');
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
await page.goto(`${ctx.base}/#/forge`, { waitUntil: 'domcontentloaded' });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#titre-memoire', { timeout: 8000 });
await page.screenshot({ path: join(SORTIE, '31-hote-reserve-sans-detail.png') });
console.log('  31-hote-reserve-sans-detail.png');
ctx.server.close();

// §27.8 : topologie jamais relevée — un état nommé, avec son remède en bouton.
ctx = await demarrer({ hoteNonReleve: true });
await page.goto(`${ctx.base}/#/forge`, { waitUntil: 'domcontentloaded' });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-action="relever"]', { timeout: 8000 });
await page.screenshot({ path: join(SORTIE, '32-hote-non-releve.png') });
console.log('  32-hote-non-releve.png');
ctx.server.close();

// --- Catalogue d'images (SPK-32) et sa modale (SPK-33) --------------------
// docs/DAT.md §33, §34.1. On y va PAR LA NAVIGATION : accueil, Forge, onglet
// Images. Aucune URL directe — c'est le parcours d'un utilisateur (CLAUDE.md §16).
ctx = await demarrer();
await page.setViewportSize({ width: 1440, height: 1000 });
await page.goto(ctx.base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('tbody a');
await page.click('nav a[href="#/forge"]');
await page.waitForSelector('#titre-pools', { timeout: 8000 });
await page.click('.onglet[href="#/forge/images"]');
await page.waitForSelector('#titre-catalogue', { timeout: 8000 });
await page.screenshot({ path: join(SORTIE, '33-hote-images.png') });
console.log('  33-hote-images.png');

// §6.27 : la commande de la section ouvre une modale dont le sujet est cette
// section. Ouverte AU CLAVIER, avec une saisie réelle.
await page.focus('[data-ouvre="image"]');
await page.keyboard.press('Enter');
await page.waitForSelector('dialog.modale[open] #image-reference', { timeout: 4000 });
await page.fill('#image-reference', 'images:debian/12');
await page.fill('#image-label', 'Debian 12 « bookworm »');
await page.screenshot({ path: join(SORTIE, '34-images-modale.png') });
console.log('  34-images-modale.png');

// Sous 768 px la modale occupe l'écran entier, sans changer de contrat.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(150);
await page.screenshot({ path: join(SORTIE, '35-images-modale-mobile.png') });
console.log('  35-images-modale-mobile.png');
ctx.server.close();

// --- Le catalogue des serveurs (SPK-41) ------------------------------------
// docs/DAT.md §22.4.7 bis. On y va PAR LA NAVIGATION, comme un exploitant.
ctx = await demarrer();
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(ctx.base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('tbody a');
await page.click('nav a[href="#/serveurs"]');
await page.waitForSelector('#titre-serveurs', { timeout: 8000 });
await page.screenshot({ path: join(SORTIE, '44-serveurs.png') });
console.log('  44-serveurs.png');

// La modale d'ajout, ouverte AU CLAVIER, sur le genre « alias » qui est celui
// que le §22.4 bis vient d'introduire.
await page.focus('[data-ouvre="serveur"]');
await page.keyboard.press('Enter');
await page.waitForSelector('dialog.modale[open] #serveur-nom', { timeout: 4000 });
await page.fill('#serveur-nom', 'bastion');
await page.selectOption('#serveur-genre', 'alias');
await page.waitForSelector('#serveur-alias', { timeout: 4000 });
await page.fill('#serveur-alias', 'spark-bastion');
await page.screenshot({ path: join(SORTIE, '45-serveurs-ajout.png') });
console.log('  45-serveurs-ajout.png');
// La MODIFICATION d'une entrée existante : le nom y est en lecture seule.
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.querySelector('dialog.modale[open]'),
                           { timeout: 4000 });
await page.click('[data-modifie-serveur="recette"]');
await page.waitForSelector('dialog.modale[open] #serveur-nom', { timeout: 4000 });
await page.screenshot({ path: join(SORTIE, '47-serveurs-modifier.png') });
console.log('  47-serveurs-modifier.png');
ctx.server.close();

// L'état « aucun serveur enregistré », que la DoD nomme.
ctx = await demarrer({ sansServeur: true });
await page.setViewportSize({ width: 1440, height: 700 });
await page.goto(`${ctx.base}/#/serveurs`, { waitUntil: 'domcontentloaded' });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#titre-serveurs', { timeout: 8000 });
await page.screenshot({ path: join(SORTIE, '46-serveurs-aucun.png') });
console.log('  46-serveurs-aucun.png');
ctx.server.close();

// --- L'onglet de supervision du journal (SPK-39) --------------------------
// docs/DAT.md §36.8. On y va PAR LA NAVIGATION : accueil, Forge, onglet Journal.
ctx = await demarrer();
await page.setViewportSize({ width: 1440, height: 1000 });
await page.goto(ctx.base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('tbody a');
await page.click('nav a[href="#/forge"]');
await page.waitForSelector('#titre-pools', { timeout: 8000 });
await page.click('.onglet[href="#/forge/journal"]');
await page.waitForSelector('#titre-journal-forge', { timeout: 8000 });
await page.screenshot({ path: join(SORTIE, '40-journal-supervision.png') });
console.log('  40-journal-supervision.png');

// Le relevé, déclenché AU CLAVIER depuis le bouton.
await page.focus('[data-action="verifier-chaine"]');
await page.keyboard.press('Enter');
await page.waitForFunction(
  () => document.body.innerText.includes('Chaîne intacte'), { timeout: 8000 });
await page.screenshot({ path: join(SORTIE, '41-journal-integrite.png') });
console.log('  41-journal-integrite.png');

await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: join(SORTIE, '42-journal-mobile.png'), fullPage: true });
console.log('  42-journal-mobile.png');
ctx.server.close();

// La CHAÎNE ROMPUE : l'écran doit désigner la ligne exacte et dire ce qui s'est
// passé. C'est l'état pour lequel tout ce dispositif existe.
ctx = await demarrer({ chaineRompue: true });
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${ctx.base}/#/forge/journal`, { waitUntil: 'domcontentloaded' });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#titre-integrite', { timeout: 8000 });
await page.click('[data-action="verifier-chaine"]');
await page.waitForFunction(
  () => document.body.innerText.includes('Chaîne rompue'), { timeout: 8000 });
await page.screenshot({ path: join(SORTIE, '43-journal-chaine-rompue.png') });
console.log('  43-journal-chaine-rompue.png');
ctx.server.close();

// L'ANCRE QUI ALERTE (SPK-38, docs/DAT.md §36.1, §36.9.6). C'est le cas le plus
// important du dispositif : la chaîne est INTACTE, et pourtant il manque des
// entrées. Un écran qui résumerait les deux en un seul indicateur dirait « tout
// va bien » alors que le journal a été amputé.
ctx = await demarrer({ ancreEnAlerte: true });
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(ctx.base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('tbody a');
await page.click('nav a[href="#/forge"]');
await page.waitForSelector('#titre-pools', { timeout: 8000 });
await page.click('.onglet[href="#/forge/journal"]');
await page.waitForSelector('#titre-journal-forge', { timeout: 8000 });
await page.focus('[data-action="verifier-chaine"]');
await page.keyboard.press('Enter');
await page.waitForFunction(
  () => document.body.innerText.includes('Le journal a raccourci'), { timeout: 8000 });
await page.screenshot({ path: join(SORTIE, '44-journal-ancre-alerte.png') });
console.log('  44-journal-ancre-alerte.png');

// L'alerte introduit un PANNEAU là où il n'y avait que deux paragraphes : c'est
// exactement le genre de changement qui déborde au mobile (§8.1, §13.1).
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: join(SORTIE, '45-journal-ancre-mobile.png'), fullPage: true });
console.log('  45-journal-ancre-mobile.png');
ctx.server.close();

// --- L'ONGLET DOCKER (SPK-44, §37.6) --------------------------------------
// L'inventaire, et surtout les DEUX absences qui se confondent à l'œil : Docker
// qui manque, et Docker dont le moteur ne répond pas.
{
  const inventaire = [
    { id: 'abc', name: 'crm-web-1', state: 'running', status: 'Up 3 hours',
      image: 'nginx:alpine', ports: '0.0.0.0:8080->80/tcp, :::8080->80/tcp',
      cpu: '0.03%', memory: '12.3MiB / 2GiB', memoryPercent: '0.60%' },
    { id: 'def', name: 'crm-base-1', state: 'running', status: 'Up 3 hours',
      image: 'postgres:16', ports: '',
      cpu: '1.42%', memory: '184.6MiB / 2GiB', memoryPercent: '9.01%' },
    { id: 'ghi', name: 'crm-migration-1', state: 'exited',
      status: 'Exited (0) 2 hours ago', image: 'crm/migrations:1.4', ports: '' },
  ];
  const etats = [
    ['93-docker-inventaire', { state: 'ok', containers: inventaire }],
    ['94-docker-absent', { state: 'docker_absent', containers: [],
      titre: 'Docker n’est pas installé dans ce Spark',
      detail: 'L’image de base n’en embarque pas. L’amorçage, sur l’onglet Infos, '
        + 'le pose et rend la cellule capable de faire tourner une pile Compose.' }],
    ['95-docker-moteur-muet', { state: 'moteur_muet', containers: [],
      titre: 'Docker est installé, mais son moteur ne répond pas',
      detail: 'La commande existe et le démon ne répond pas. Ce n’est pas une '
        + 'installation qui manque : c’est un service à redémarrer dans le Spark.' }],
    ['96-docker-sans-conteneur', { state: 'sans_conteneur', containers: [],
      titre: 'Aucun conteneur',
      detail: 'Docker tourne dans ce Spark, et rien n’y est lancé. '
        + 'C’est un état normal — une cellule fraîchement amorcée, ou une pile arrêtée.' }],
  ];
  for (const [nom, releve] of etats) {
    ctx = await demarrer({ dockerReleve: releve });
    await ouvrirDetail(ctx.base, { facette: 'docker', hauteur: 800 });
    await page.waitForSelector('#titre-docker', { timeout: 8000 });
    await page.waitForFunction(
      () => !document.body.innerText.includes('Lecture de ce qui tourne'),
      { timeout: 8000 });
    await page.screenshot({ path: join(SORTIE, `${nom}.png`) });
    console.log(`  ${nom}.png`);
    ctx.server.close();
  }

  // --- Le conteneur OUVERT (§37.6 ter) --------------------------------------
  //
  // Trois écrans, parce qu'ils appellent trois gestes différents : un conteneur
  // qui tourne et qu'on inspecte, un conteneur ARRÊTÉ dont on cherche pourquoi,
  // et un conteneur DISPARU pendant qu'on le regardait.
  const ligne = (i) => ({
    at: `2026-08-20T18:5${i % 6}:${String(i % 60).padStart(2, '0')}.284913001Z`,
    text: i % 7 === 0
      ? `10.77.0.1 - - [20/Aug/2026:18:52:${String(i % 60).padStart(2, '0')} +0000] `
        + `"GET /api/clients?page=${i} HTTP/1.1" 200 4213 "-" "Mozilla/5.0"`
      : `[info] requête ${i} servie en ${8 + (i % 40)} ms`,
  });
  const ouverts = [
    ['98-docker-conteneur',
     { name: 'crm-web-1', state: 'running', exitCode: null, image: 'nginx:alpine',
       startedAt: '2026-08-20T15:41:07.118Z', finishedAt: null, restarts: 0,
       networks: [{ name: 'crm_default', address: '172.18.0.3' },
                  { name: 'crm_public', address: '172.19.0.2' }],
       mounts: [{ type: 'bind', source: '/srv/crm/nginx.conf',
                  destination: '/etc/nginx/conf.d/default.conf', mode: 'ro' },
                { type: 'volume', source: 'crm_static',
                  destination: '/usr/share/nginx/html', mode: 'rw' }] },
     { lines: Array.from({ length: 200 }, (_, i) => ligne(i + 1)),
       truncated: true, tail: 200 }],
    ['99-docker-conteneur-arrete',
     { name: 'crm-migration-1', state: 'exited', exitCode: 137,
       image: 'crm/migrations:1.4', startedAt: '2026-08-20T16:02:11.004Z',
       finishedAt: '2026-08-20T16:09:48.771Z', restarts: 2,
       networks: [], mounts: [] },
     { lines: [{ at: '2026-08-20T16:09:47.220Z', text: 'appliquant 0031_ajout_index…' },
               { at: '2026-08-20T16:09:48.766Z',
                 text: 'Killed — la migration a dépassé la mémoire allouée' }],
       truncated: false, tail: 200 }],
    ['100-docker-conteneur-disparu',
     { state: 'conteneur_inconnu', titre: 'Ce conteneur a disparu',
       detail: 'Il n’existe plus sur ce Spark. Le locataire a pu le supprimer '
         + 'depuis le dernier relevé — c’est un état normal, pas une panne.' },
     { state: 'conteneur_inconnu', lines: [], truncated: false, tail: 200 }],
  ];
  for (const [nom, conteneur, journaux] of ouverts) {
    ctx = await demarrer({ dockerReleve: { state: 'ok', containers: inventaire },
                           dockerConteneur: conteneur, dockerJournaux: journaux });
    await ouvrirDetail(ctx.base, { facette: 'docker', hauteur: 1000 });
    await page.waitForSelector('tbody tr', { timeout: 8000 });
    await page.click(`button[data-conteneur="${conteneur.name ?? 'crm-web-1'}"]`);
    await page.waitForSelector('#titre-conteneur', { timeout: 8000 });
    await page.waitForFunction(
      () => !document.body.innerText.includes('Inspection en cours'),
      { timeout: 8000 });
    await page.screenshot({ path: join(SORTIE, `${nom}.png`) });
    console.log(`  ${nom}.png`);
    ctx.server.close();
  }

  // --- SPK-45 · LES GESTES SUR UN CONTENEUR (§37.7) -------------------------
  //
  // Trois écrans qui décident : la confirmation d'un geste DESTRUCTIF, le
  // succès constaté, et le refus sous gel — celui qui doit apprendre comment
  // avancer plutôt que seulement interdire.
  ctx = await demarrer({ dockerReleve: { state: 'ok', containers: inventaire },
                         dockerConteneur: ouverts[0][1], dockerJournaux: ouverts[0][2] });
  await ouvrirDetail(ctx.base, { facette: 'docker', hauteur: 1000 });
  await page.waitForSelector('tbody tr', { timeout: 8000 });
  await page.click('button[data-conteneur="crm-web-1"]');
  await page.waitForSelector('button[data-geste="kill"]', { timeout: 8000 });
  await page.click('button[data-geste="kill"]');
  await page.waitForSelector('.confirmation', { timeout: 8000 });
  await page.screenshot({ path: join(SORTIE, '102-geste-confirmation-tuer.png') });
  console.log('  102-geste-confirmation-tuer.png');
  ctx.server.close();

  // Le succès : vert, et il est le SEUL à l'être (SPK-DS-08).
  ctx = await demarrer({
    dockerReleve: { state: 'ok', containers: inventaire },
    dockerConteneur: ouverts[0][1], dockerJournaux: ouverts[0][2],
    gesteRendu: { state: 'abouti', titre: 'Arrêter : c’est fait',
                  detail: 'Le geste a abouti sur « crm-web-1 ».' },
    // Ce que la relecture rend VRAIMENT après un arrêt réussi (§37.7.2).
    dockerConteneurApres: { ...ouverts[0][1], state: 'exited', exitCode: 0,
                            finishedAt: '2026-08-20T21:44:02.310Z' } });
  await ouvrirDetail(ctx.base, { facette: 'docker', hauteur: 1000 });
  await page.waitForSelector('tbody tr', { timeout: 8000 });
  await page.click('button[data-conteneur="crm-web-1"]');
  await page.waitForSelector('button[data-geste="stop"]', { timeout: 8000 });
  await page.click('button[data-geste="stop"]');
  await page.click('[data-geste-confirme="stop"]');
  await page.waitForSelector('.succes', { timeout: 8000 });
  await page.screenshot({ path: join(SORTIE, '103-geste-abouti.png') });
  console.log('  103-geste-abouti.png');
  ctx.server.close();

  // Le gel : les gestes PRÉSENTS, désactivés et expliqués, la lecture entière.
  ctx = await demarrer({ sparks: SPARKS.map((s) => s.name === DETAIL
                           ? { ...s, protected: true,
                               protected_at: '2026-08-19T10:00:00',
                               allowed_commands: [] }
                           : s),
                         dockerReleve: { state: 'ok', containers: inventaire },
                         dockerConteneur: ouverts[0][1], dockerJournaux: ouverts[0][2] });
  await ouvrirDetail(ctx.base, { facette: 'docker', hauteur: 1000 });
  await page.waitForSelector('tbody tr', { timeout: 8000 });
  await page.click('button[data-conteneur="crm-web-1"]');
  await page.waitForSelector('button[data-geste="stop"]', { timeout: 8000 });
  await page.screenshot({ path: join(SORTIE, '104-geste-gele.png') });
  console.log('  104-geste-gele.png');
  ctx.server.close();

  // --- LE TERMINAL DANS UN CONTENEUR (SPK-45 tranche 2, §37.4.7) ------------
  // Deux écrans, atteints par le VRAI parcours — on ouvre le conteneur puis on
  // clique. La bannière doit NOMMER le conteneur : sans elle on croit piloter le
  // Spark, et une commande tapée là n'a pas les mêmes effets.
  {
    const terminaux = new SessionManager({
      spawn: (commande, args) => {
        const e = new EventEmitter();
        e.stdout = new EventEmitter(); e.stderr = new EventEmitter();
        e.stdin = { write() {} }; e.kill = () => {};
        e.commande = commande; e.args = args;
        return e;
      },
    });
    ctx = await demarrer({
      terminaux,
      dockerReleve: { state: 'ok', containers: inventaire },
      dockerConteneur: ouverts[0][1], dockerJournaux: ouverts[0][2],
      probeShell: async () => ({ state: 'shell_trouve', shell: '/bin/bash' }) });
    await ouvrirDetail(ctx.base, { facette: 'docker', hauteur: 900 });
    await page.waitForSelector('tbody tr', { timeout: 8000 });
    await page.click('button[data-conteneur="crm-web-1"]');
    await page.waitForSelector('[data-docker="terminal"]', { timeout: 8000 });
    await page.click('[data-docker="terminal"]');
    await page.waitForSelector('.bandeau-terminal .badge--accent', { timeout: 8000 });
    await page.screenshot({ path: join(SORTIE, '105-terminal-conteneur.png') });
    console.log('  105-terminal-conteneur.png');
    ctx.server.close();
  }

  // Le conteneur SANS SHELL : le refus le plus important de cette tranche. Une
  // image « distroless » n'en embarque aucun, et c'est un choix de sécurité du
  // locataire — pas une panne, donc pas de rouge.
  {
    ctx = await demarrer({
      terminaux: new SessionManager({ spawn: () => {
        const e = new EventEmitter();
        e.stdout = new EventEmitter(); e.stderr = new EventEmitter();
        e.stdin = { write() {} }; e.kill = () => {};
        return e;
      } }),
      dockerReleve: { state: 'ok', containers: inventaire },
      dockerConteneur: ouverts[0][1], dockerJournaux: ouverts[0][2],
      probeShell: async () => ({
        state: 'sans_shell', shell: null,
        titre: 'Ce conteneur n’a pas de shell',
        detail: 'Son image n’en embarque aucun — ni « bash », ni « sh ». C’est le '
          + 'cas des images « distroless », et c’est un choix de sécurité délibéré, '
          + 'pas une panne. Il n’y a rien où entrer.' }) });
    await ouvrirDetail(ctx.base, { facette: 'docker', hauteur: 900 });
    await page.waitForSelector('tbody tr', { timeout: 8000 });
    await page.click('button[data-conteneur="crm-web-1"]');
    await page.waitForSelector('[data-docker="terminal"]', { timeout: 8000 });
    await page.click('[data-docker="terminal"]');
    await page.waitForSelector('.avertissement', { timeout: 8000 });
    await page.screenshot({ path: join(SORTIE, '106-terminal-conteneur-sans-shell.png') });
    console.log('  106-terminal-conteneur-sans-shell.png');
    ctx.server.close();
  }

  // Un conteneur ouvert sur 390 px : les journaux ne doivent pas faire déborder
  // la PAGE, ils défilent dans leur propre bloc (§8.1).
  ctx = await demarrer({ dockerReleve: { state: 'ok', containers: inventaire },
                         dockerConteneur: ouverts[0][1], dockerJournaux: ouverts[0][2] });
  await ouvrirDetail(ctx.base, { facette: 'docker', hauteur: 1000 });
  await page.waitForSelector('tbody tr', { timeout: 8000 });
  await page.click('button[data-conteneur="crm-web-1"]');
  await page.waitForSelector('pre.terminal', { timeout: 8000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(SORTIE, '101-docker-conteneur-mobile.png') });
  console.log('  101-docker-conteneur-mobile.png');
  ctx.server.close();

  // Le format étroit : cinq colonnes ne tiennent pas sur 390 px, le tableau doit
  // défiler dans SON conteneur et la page ne doit pas déborder (§8.1).
  ctx = await demarrer({ dockerReleve: { state: 'ok', containers: inventaire } });
  await ouvrirDetail(ctx.base, { facette: 'docker', hauteur: 800 });
  await page.waitForSelector('tbody tr', { timeout: 8000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(SORTIE, '97-docker-mobile.png'), fullPage: true });
  console.log('  97-docker-mobile.png');
  ctx.server.close();
}

// --- LE CODE DÉPLOYÉ (SPK-53, §40.3) --------------------------------------
// Les deux états qui décident : une Forge EN RETARD, qui appelle un geste, et
// une build NON ESTAMPILLÉE, qui ne se confond pas avec « à jour ».
{
  const tete = execFileSync('git', ['rev-parse', 'HEAD'],
                            { cwd: join(SORTIE, '..', '..'), encoding: 'utf8' }).trim();
  const ancien = execFileSync('git', ['rev-parse', 'HEAD~4'],
                              { cwd: join(SORTIE, '..', '..'), encoding: 'utf8' }).trim();

  ctx = await demarrer({ buildCommit: ancien });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(ctx.base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tbody a');
  await page.click('nav a[href="#/forge"]');
  await page.waitForFunction(
    () => document.body.innerText.includes('commits d’écart'), { timeout: 8000 });
  await page.screenshot({ path: join(SORTIE, '90-forge-build-en-retard.png'), fullPage: true });
  console.log('  90-forge-build-en-retard.png');
  ctx.server.close();

  // À JOUR : la seule situation où la console affirme que tout va bien.
  ctx = await demarrer({ buildCommit: tete });
  await page.goto(ctx.base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tbody a');
  await page.click('nav a[href="#/forge"]');
  await page.waitForFunction(
    () => document.body.innerText.includes('À jour'), { timeout: 8000 });
  await page.screenshot({ path: join(SORTIE, '91-forge-build-a-jour.png'), fullPage: true });
  console.log('  91-forge-build-a-jour.png');
  ctx.server.close();

  // NON ESTAMPILLÉE : « inconnue » est une réponse, pas « à jour » (§40.2).
  ctx = await demarrer();
  await page.goto(ctx.base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tbody a');
  await page.click('nav a[href="#/forge"]');
  await page.waitForFunction(
    () => document.body.innerText.includes('non estampillée'), { timeout: 8000 });
  await page.screenshot({ path: join(SORTIE, '92-forge-build-inconnue.png'), fullPage: true });
  console.log('  92-forge-build-inconnue.png');
  ctx.server.close();
}

// --- L'AMORÇAGE (SPK-54, §41, §42) ----------------------------------------
// Les trois états qui décident : pas encore relevé, un docker.io À CORRIGER, et
// la confirmation qui nomme le pouvoir employé.
ctx = await demarrer();
await ouvrirDetail(ctx.base, { hauteur: 1300 });
await page.screenshot({ path: join(SORTIE, '85-amorcage-non-releve.png'), fullPage: true });
console.log('  85-amorcage-non-releve.png');
await page.click('[data-amorcage="amorcer"]');
await page.waitForSelector('[data-amorcage="engager"]', { timeout: 8000 });
await page.screenshot({ path: join(SORTIE, '86-amorcage-confirmation.png'), fullPage: true });
console.log('  86-amorcage-confirmation.png');

// SPK-54 · §42.2 : l'option rootless ÉNONCE ses trois coûts au lieu de les
// vendre. C'est ce qui doit se voir : une case seule, ou accompagnée d'un
// « plus sûr », ferait cocher sans savoir ce qu'on accepte.
await page.check('#amorcage-rootless');
await page.screenshot({ path: join(SORTIE, '89-amorcage-rootless.png'), fullPage: true });
console.log('  89-amorcage-rootless.png');
await page.uncheck('#amorcage-rootless');

// Le compte rendu ligne à ligne, et son format étroit : cinq lignes portant
// chacune un état, un nom et un détail ne tiennent pas sur 390 px (§8.1).
await page.click('[data-amorcage="engager"]');
await page.waitForSelector('.liste-amorcage', { timeout: 8000 });
await page.setViewportSize({ width: 1440, height: 1300 });
await page.screenshot({ path: join(SORTIE, '87-amorcage-compte-rendu.png'), fullPage: true });
console.log('  87-amorcage-compte-rendu.png');
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: join(SORTIE, '88-amorcage-mobile.png'), fullPage: true });
console.log('  88-amorcage-mobile.png');
ctx.server.close();

// --- Le TERMINAL DE DÉPANNAGE (SPK-43, §37.3) -----------------------------
// Les quatre conditions du §37.3 se voient ou ne se voient pas : la
// confirmation qui nomme le pouvoir employé, et la bannière qui tient.
{
  const enfants = [];
  const terminaux = new SessionManager({
    spawn: (commande, args) => {
      const e = new EventEmitter();
      e.stdout = new EventEmitter(); e.stderr = new EventEmitter();
      e.stdin = { write() {} }; e.kill = () => {};
      e.commande = commande; e.args = args; enfants.push(e);
      return e;
    },
  });
  ctx = await demarrer({ terminaux, sondageSshd: { repond: false, motif: 'sshd_muet' } });
  await ouvrirDetail(ctx.base, { facette: 'terminal', hauteur: 900 });
  await page.screenshot({ path: join(SORTIE, '78-terminal-ferme.png') });
  console.log('  78-terminal-ferme.png');

  // La CONFIRMATION. C'est elle qui doit nommer le pouvoir employé.
  await page.click('[data-terminal="depanner"]');
  await page.waitForSelector('[data-terminal="depanner-confirme"]', { timeout: 8000 });
  await page.screenshot({ path: join(SORTIE, '79-terminal-depannage-confirmation.png') });
  console.log('  79-terminal-depannage-confirmation.png');

  // La BANNIÈRE, une fois la session ouverte.
  await page.click('[data-terminal="depanner-confirme"]');
  await page.waitForSelector('[data-terminal="fermer"]', { timeout: 8000 });
  await page.screenshot({ path: join(SORTIE, '80-terminal-depannage-banniere.png') });
  console.log('  80-terminal-depannage-banniere.png');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(SORTIE, '81-terminal-depannage-mobile.png'),
                          fullPage: true });
  console.log('  81-terminal-depannage-mobile.png');
  ctx.server.close();
}

// Le SSHD MUET (§37.2) : l'écran doit NOMMER ce qui manque, et proposer la
// suite. C'est le cas pour lequel le chemin de dépannage existe.
{
  const enfants = [];
  const terminaux = new SessionManager({
    spawn: () => {
      const e = new EventEmitter();
      e.stdout = new EventEmitter(); e.stderr = new EventEmitter();
      e.stdin = { write() {} }; e.kill = () => {};
      enfants.push(e);
      return e;
    },
  });
  ctx = await demarrer({ terminaux, sondageSshd: { repond: false, motif: 'sshd_muet' } });
  await ouvrirDetail(ctx.base, { facette: 'terminal', hauteur: 900 });
  await page.click('[data-terminal="ouvrir"]');
  await page.waitForSelector('[data-terminal="fermer"]', { timeout: 8000 });
  // Le distant meurt de lui-même, comme le fait `ssh` face à un port fermé.
  enfants[0].emit('exit', 255);
  await page.waitForFunction(
    () => document.body.innerText.includes('Aucun serveur SSH ne répond'),
    { timeout: 8000 });
  await page.screenshot({ path: join(SORTIE, '83-terminal-sshd-muet.png') });
  console.log('  83-terminal-sshd-muet.png');
  ctx.server.close();
}

// La clé REFUSÉE : la panne ressemble à la précédente et n'appelle pas le même
// geste. L'écran doit renvoyer aux clés, pas au dépannage (§37.3.1).
{
  const enfants = [];
  const terminaux = new SessionManager({
    spawn: () => {
      const e = new EventEmitter();
      e.stdout = new EventEmitter(); e.stderr = new EventEmitter();
      e.stdin = { write() {} }; e.kill = () => {};
      enfants.push(e);
      return e;
    },
  });
  ctx = await demarrer({ terminaux, sondageSshd: { repond: true, motif: 'cle_refusee' } });
  await ouvrirDetail(ctx.base, { facette: 'terminal', hauteur: 900 });
  await page.click('[data-terminal="ouvrir"]');
  await page.waitForSelector('[data-terminal="fermer"]', { timeout: 8000 });
  enfants[0].emit('exit', 255);
  await page.waitForFunction(
    () => document.body.innerText.includes('il refuse la clé'), { timeout: 8000 });
  await page.screenshot({ path: join(SORTIE, '84-terminal-cle-refusee.png') });
  console.log('  84-terminal-cle-refusee.png');
  ctx.server.close();
}

// Le REFUS du dépannage : le chemin normal reste offert, l'écran ne se ferme pas.
{
  const terminaux = new SessionManager({ spawn: () => {
    const e = new EventEmitter();
    e.stdout = new EventEmitter(); e.stderr = new EventEmitter();
    e.stdin = { write() {} }; e.kill = () => {};
    return e;
  } });
  ctx = await demarrer({ terminaux, sondageSshd: { repond: true, motif: null } });
  await ouvrirDetail(ctx.base, { facette: 'terminal', hauteur: 900 });
  await page.click('[data-terminal="depanner"]');
  await page.waitForSelector('[data-terminal="depanner-confirme"]', { timeout: 8000 });
  await page.click('[data-terminal="depanner-confirme"]');
  await page.waitForFunction(
    () => document.body.innerText.includes('Dépannage refusé'), { timeout: 8000 });
  await page.screenshot({ path: join(SORTIE, '82-terminal-depannage-refuse.png') });
  console.log('  82-terminal-depannage-refuse.png');
  ctx.server.close();
}

// --- Le journal et son auteur (SPK-37) ------------------------------------
// docs/DAT.md §21.6, §36.4. La facette Journal doit montrer que les deux classes
// ne se confondent pas.
ctx = await demarrer();
await ouvrirDetail(ctx.base, { facette: 'journal', hauteur: 700 });
await page.screenshot({ path: join(SORTIE, '39-journal-auteur.png') });
console.log('  39-journal-auteur.png');
ctx.server.close();

// --- Les Sparks protégés (SPK-34) -----------------------------------------
// docs/DAT.md §35. On ouvre le Spark PAR SON LIEN dans la liste, comme un
// exploitant, et on ouvre sa modale au clavier.
ctx = await demarrer();
await page.setViewportSize({ width: 1440, height: 1000 });
await page.goto(ctx.base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('tbody a');
await page.screenshot({ path: join(SORTIE, '36-liste-protege.png') });
console.log('  36-liste-protege.png');

await page.click('tbody a:has-text("analytics")');
await page.waitForSelector('#titre-protection', { timeout: 8000 });
await page.screenshot({ path: join(SORTIE, '37-fenetre-protegee.png') });
console.log('  37-fenetre-protegee.png');

await page.focus('[data-ouvre="protection"]');
await page.keyboard.press('Enter');
await page.waitForSelector('dialog.modale[open] #protection-mot', { timeout: 4000 });
await page.screenshot({ path: join(SORTIE, '38-protection-modale.png') });
console.log('  38-protection-modale.png');
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
