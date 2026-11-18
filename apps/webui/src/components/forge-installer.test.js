/** @verifies docs/BACKLOG.md#SPK-68 · docs/DAT.md §50.1, §50.3
 *  @verifies docs/BACKLOG.md#SPK-148 · docs/DAT.md §50.1 bis (le panneau d'une
 *            Forge en service dit la vérité ; noms en <code>) */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderForgeInstaller, observedValues, poolReutilise, INSTALLER_VIDE } from './forge-installer.js';

const INSTALLER_VIDE_VALUES = INSTALLER_VIDE.values;

test('le panneau explique le diagnostic sans promettre une installation', () => {
  const html = renderForgeInstaller();
  assert.match(html, /Diagnostiquer la Forge/);
  assert.match(html, /aucune écriture distante/i);
  assert.ok(!/data-action="installer-forge"/.test(html));
});

test('SSH établi et sparkd absent ont leurs deux lignes distinctes', () => {
  const html = renderForgeInstaller({ status: 'ready', result: {
    report: { system: { os: 'ubuntu 24.04', architecture: 'x86_64', rootAvailableBytes: 5000 },
              access: { sudo: 'racine' }, runtimes: { sparkd: null, incus: null, caddy: null },
              services: { sparkd: null }, blocks: [] },
    storage: { supports: [], nativeMirror: { eligible: false, devices: [], refusal: 'aucun support libre' },
               filePool: { availableBytes: 5000 } },
  } });
  assert.match(html, /SSH établi/);
  assert.match(html, /sans réponse ou non installé/);
  assert.match(html, /n’est pas une Forge\s+installable/);
  assert.match(html, /aucun support libre/);
  assert.match(html, /Vérifier et composer le plan/);
});

test('un support exclu reste affiché avec sa nature et son motif', () => {
  const html = renderForgeInstaller({ status: 'ready', result: {
    report: { system: {}, access: {}, runtimes: {}, services: {}, blocks: [] },
    storage: { supports: [
      { name: 'sda', type: 'disk', sizeBytes: 1000, reasons: ['porte la racine'] },
      { name: 'sda5', type: 'part', sizeBytes: 900, reasons: [] },
    ], nativeMirror: { eligible: false, devices: [], refusal: 'un seul support libre' },
      filePool: {} },
  } });
  assert.match(html, /\/dev\/sda/);
  assert.match(html, /porte la racine/);
  // Une PARTITION libre est visible et nommée comme telle : c'est sur elle que
  // le pool se pose sur un serveur partitionné à la commande (§8.6).
  assert.match(html, /\/dev\/sda5/);
  assert.match(html, /partition/);
  assert.match(html, /support libre à confirmer/);
  // Le refus du miroir nomme sa cause au lieu de basculer en silence.
  assert.match(html, /un seul support libre/);
});

test('la paire proposée nomme les deux supports et les deux disques', () => {
  const html = renderForgeInstaller({ status: 'ready', result: {
    report: { system: {}, access: {}, runtimes: {}, services: {}, blocks: [] },
    storage: { supports: [
      { name: 'sda5', type: 'part', sizeBytes: 900, reasons: [] },
      { name: 'sdb5', type: 'part', sizeBytes: 900, reasons: [] },
    ], nativeMirror: { eligible: true, devices: ['sda5', 'sdb5'], refusal: null },
      filePool: { availableBytes: 1000 } },
  } });
  assert.match(html, /disques physiques distincts/);
  assert.match(html, /\/dev\/sda5, \/dev\/sdb5/);
  // Il n'y a plus de choix à faire : l'écran ANNONCE ce qui sera créé.
  assert.match(html, /Le miroir sera créé sur \/dev\/sda5 et \/dev\/sdb5/);
  assert.ok(!/type="radio"/.test(html), 'aucune disposition de rechange à choisir');
  assert.ok(!/n’est pas une Forge/.test(html));
});

const PLAN = {
  storage: { kind: 'file', poolName: 'spark', path: '/var/lib/incus/disks/spark.img',
    sizeGib: 4, reserveGib: 1 },
  phases: ['access', 'dependencies', 'storage', 'foundation', 'control', 'verification']
    .map((id) => ({ id, label: id, status: id === 'access' ? 'done' : 'pending' })),
};

test('le miroir exige deux confirmations distinctes et exactes', () => {
  const plan = { ...PLAN, storage: { kind: 'native', poolName: 'spark', driver: 'zfs',
    devices: ['/dev/sda5', '/dev/sdb5'], destructive: true } };
  const html = renderForgeInstaller({ status: 'planned', result: CONFORME, plan,
    accepted: false, confirmation: '' });
  assert.match(html, /EFFACER \/dev\/sda5 \/dev\/sdb5/);
  assert.match(html, /data-installation-accepted/);
  assert.match(html, /data-action="executer-installation-forge"[^>]* disabled/);
  // Les deux engagements concordent : le bouton s'ouvre.
  const pret = renderForgeInstaller({ status: 'planned', result: CONFORME, plan,
    accepted: true, confirmation: 'EFFACER /dev/sda5 /dev/sdb5' });
  assert.ok(!/data-action="executer-installation-forge"[^>]* disabled/.test(pret));
});

test('adopter un zpool n’est PAS une écriture destructive', () => {
  const plan = { ...PLAN, storage: { kind: 'adopt', poolName: 'spark', driver: 'zfs',
    zpool: 'spark', imported: false, destructive: false } };
  const html = renderForgeInstaller({ status: 'planned', result: CONFORME, plan,
    accepted: true, confirmation: '' });
  assert.match(html, /adopter le zpool « spark » déjà présent, après l’avoir importé/);
  assert.match(html, /aucune donnée n’est touchée/);
  assert.ok(!/EFFACER|CREER/.test(html), 'aucune confirmation destructive');
  assert.ok(!/data-action="executer-installation-forge"[^>]* disabled/.test(html));
});

test('le journal rend les statuts et les mesures sans sortie terminal brute', () => {
  const html = renderForgeInstaller({ status: 'idle', execution: {
    status: 'interrupted', currentPhase: 'storage', plan: PLAN,
    error: 'Connexion interrompue.', events: [
      { phase: 'access', status: 'done', message: 'Plan concordant', result: {} },
      { phase: 'storage', status: 'interrupted', message: 'Connexion interrompue' },
    ],
  } });
  assert.match(html, /Installation interrompue/);
  assert.match(html, /Reprendre le diagnostic/);
  assert.match(html, /terminée/);
  assert.match(html, /interrompue/);
});

test('l amorcage garde sa ligne quand le plan produit ensuite un evenement access', () => {
  const html = renderForgeInstaller({ status: 'idle', execution: {
    status: 'done', plan: PLAN, events: [
      { phase: 'access', status: 'done',
        message: 'Paquet d’installation déjà conforme à la build publiée',
        result: { changed: false, commit: 'a9705e5ea0dc' } },
      { phase: 'access', status: 'done', message: 'Plan version 1 et Forge concordants' },
    ],
  } });
  assert.match(html, /<strong>Paquet d’installation<\/strong>/);
  assert.match(html, /déjà conforme à la build publiée/);
  assert.match(html, /aucun écart appliqué/);
  assert.match(html, /Plan version 1 et Forge concordants/);
});

test('un journal terminé n’empêche pas de recomposer un plan idempotent', () => {
  const html = renderForgeInstaller({ status: 'ready', result: {
    report: { system: {}, access: {}, runtimes: {}, services: {}, blocks: [] },
    storage: { supports: [], nativeMirror: { eligible: false, devices: [], refusal: 'aucun support libre' }, filePool: {} },
  }, execution: { status: 'done', plan: PLAN, events: [] } });
  assert.match(html, /id="formulaire-plan-forge"/);
  assert.match(html, /Forge prête — recette finale mesurée/);
});

/** Le résultat que l'hôte rend pour une Forge réellement installée. */
const CONFORME = {
  report: {
    system: { os: 'ubuntu 26.04', architecture: 'x86_64', rootAvailableBytes: 193670443008 },
    access: { sudo: 'oui' },
    runtimes: { incus: 'Client version: 7.4', caddy: '2.6.2', python: 'Python 3.14.4',
                sparkd: '0.post1.dev674+g5d1906e79' },
    services: { sparkd: 'active', sparkdEnabled: 'enabled', caddy: 'active' },
    api: { healthz: 200, readyz: 200 },
    pools: ['spark,zfs,,1,CREATED'],
    networks: [{ name: 'sparkbr0', type: 'bridge', managed: true }],
    config: { poolName: 'spark', bridgeName: 'sparkbr0', cpuReserve: 0.5,
              memoryReserveGib: 2, reservedPorts: [], arcMaxGib: 16 },
    blocks: [],
  },
  storage: { supports: [], nativeMirror: { eligible: false, devices: [], refusal: 'aucun support libre' },
             filePool: { availableBytes: 193670443008 } },
  conformity: { checks: [
    { id: 'pool', label: 'Pool ZFS « spark »', ok: true, detail: 'spark' },
    { id: 'healthz', label: '/healthz mesuré', ok: true, detail: '200' },
  ], missing: [], installed: true, ready: true },
};

test('une Forge déjà installée est DITE conforme, contrôle par contrôle', () => {
  const html = renderForgeInstaller({ status: 'ready', result: CONFORME });
  assert.match(html, /Conformité constatée/);
  assert.match(html, /Pool ZFS « spark »/);
  assert.match(html, /Forge prête — \/healthz et \/readyz mesurés/);
  assert.match(html, /contrôles sont verts/);
  // Le relevé montre la configuration RÉELLE, pas les défauts du contrat.
  assert.match(html, /Pool déclaré par la Forge/);
  assert.match(html, /Bridge déclaré par la Forge/);
  assert.match(html, /16 Gio/);
  assert.match(html, /installée et prête/);
});

test('« Forge prête » n’est jamais écrit sans les deux codes mesurés', () => {
  const html = renderForgeInstaller({ status: 'ready', result: { ...CONFORME,
    conformity: { ...CONFORME.conformity,
      checks: [{ id: 'readyz', label: '/readyz mesuré', ok: false, detail: 'sans réponse' }],
      missing: ['readyz'], installed: true, ready: false } } });
  assert.ok(!/Forge prête/.test(html));
  assert.match(html, /installé, API à vérifier/);
  assert.match(html, /Le socle est en place/);
  // SPK-DS-12 : « SSH établi » garde sa ligne distincte, jamais confondue.
  assert.match(html, /SSH établi/);
});

test('la configuration relevée devient la valeur de départ du formulaire', () => {
  assert.deepEqual(observedValues(CONFORME.report), {
    poolName: 'spark', bridgeName: 'sparkbr0', cpuReserve: '0.5',
    memoryReserveGib: '2', arcMaxGib: '16',
  });
  // Une Forge nue ne déclare rien : le contrat de déploiement reste le défaut.
  assert.deepEqual(observedValues({ config: null }), {});
});

test('un pool conservé ne se voit pas proposer une disposition de rechange', () => {
  // La décision n'est plus un booléen : elle NOMME le geste non destructif.
  assert.deepEqual(poolReutilise(CONFORME.report, 'spark'),
    { kind: 'reuse', zpool: 'spark' });
  assert.equal(poolReutilise(CONFORME.report, 'tank'), null);
  assert.deepEqual(
    poolReutilise({ ...CONFORME.report, pools: [], zpools: [{ name: 'tank' }] }, 'tank'),
    { kind: 'adopt', zpool: 'tank', imported: true });
  assert.deepEqual(
    poolReutilise({ ...CONFORME.report, pools: [], zpools: [], importableZpools: ['tank'] }, 'tank'),
    { kind: 'adopt', zpool: 'tank', imported: false });
  const html = renderForgeInstaller({ status: 'ready', result: CONFORME });
  assert.match(html, /Le pool existant est conservé/);
  assert.ok(!/type="radio"/.test(html), 'aucune disposition de rechange à choisir');
  // Le formulaire n'annonce plus le contrat quand la Forge déclare sa config.
  assert.match(html, /celles que la Forge déclare aujourd’hui/);
});

test('une Forge muette retombe sur le contrat, et le DIT', () => {
  const nue = { ...CONFORME, report: { ...CONFORME.report, pools: [], config: null },
                conformity: { checks: [], missing: ['pool'], installed: false, ready: false } };
  const html = renderForgeInstaller({ status: 'ready', result: nue });
  assert.match(html, /ne déclare encore aucune configuration/);
  // §8.5 révisé : plus aucun repli n'est offert, le refus est nommé.
  assert.match(html, /n’est pas une Forge\s+installable/);
  assert.ok(!/pool fichier|sur fichier/i.test(html));
});


// --- SPK-148 · §50.1 bis : la phrase dit ce qu'on sait de `sparkd` ------------

test('Forge EN SERVICE : le diagnostic reste, et la phrase dit qu’elle est en service', () => {
  const html = renderForgeInstaller(undefined, { sparkd: true });
  assert.match(html, /Forge en service : le diagnostic relit sa conformité, sans rien écrire\./);
  assert.doesNotMatch(html, /sans encore porter/);
  assert.match(html, /data-action="diagnostiquer-forge"/, 'le geste du manuel M2 reste');
});

test('sparkd ne répond pas : la phrase d’une machine nue, le nom en <code>', () => {
  const html = renderForgeInstaller(undefined, { sparkd: false });
  assert.match(html, /sans encore porter <code>sparkd<\/code>/);
  assert.doesNotMatch(html, /`/, 'aucun accent grave brut à l’écran');
});

test('pas encore su : rien n’est affirmé avant le relevé', () => {
  const html = renderForgeInstaller(undefined, { sparkd: null });
  assert.doesNotMatch(html, /sans encore porter|Forge en service/);
  assert.match(html, /data-action="diagnostiquer-forge"/);
});

// --- SPK-176 · §70.6 : la case de mise à niveau ZFS --------------------------
// @verifies docs/BACKLOG.md#SPK-176 · docs/DAT.md §70.6 · docs/DESIGN_SYSTEM.md
//           §6.10 · docs/DESIGN_SYSTEM_APP.md SPK-DS-47

const A_NIVEAU = { ...CONFORME, report: { ...CONFORME.report,
  zfsUpgradable: [{ pool: 'spark', features: ['fast_dedup', 'longname'], manual: ['dynamic_gang_header'] }] } };

test('la case n’apparaît que si le relevé montre des fonctionnalités à activer', () => {
  assert.doesNotMatch(renderForgeInstaller({ status: 'ready', result: CONFORME }),
                      /installation-zfs-upgrade/);
  const html = renderForgeInstaller({ status: 'ready', result: A_NIVEAU });
  assert.match(html, /<label class="case" for="installation-zfs-upgrade">/);
  assert.match(html, /Activer les fonctionnalités ZFS disponibles/);
  assert.match(html, /Irréversible/);
  assert.match(html, /fast_dedup, longname/);
  assert.doesNotMatch(html, /dynamic_gang_header/, 'une fonctionnalité (*) n’est pas promise');
  assert.match(html, /aria-describedby="installation-zfs-upgrade-aide"/);
});

test('la case est DÉCOCHÉE par défaut, et cochée seulement si on l’a demandé', () => {
  const defaut = renderForgeInstaller({ status: 'ready', result: A_NIVEAU });
  assert.doesNotMatch(defaut, /name="zfsUpgrade"[^>]*checked/);
  const coche = renderForgeInstaller({ status: 'ready', result: A_NIVEAU,
    values: { ...INSTALLER_VIDE_VALUES, zfsUpgrade: true } });
  assert.match(coche, /name="zfsUpgrade"[\s\S]*?checked>/);
});

test('le plan relu redit la mise à niveau et son irréversibilité', () => {
  const plan = { ...PLAN, storage: { kind: 'reuse', poolName: 'spark', driver: 'zfs',
    destructive: false, zfsUpgrade: true } };
  const html = renderForgeInstaller({ status: 'planned', result: A_NIVEAU, plan });
  assert.match(html, /activer les fonctionnalités ZFS disponibles — irréversible/);
});


// --- un échec ANTÉRIEUR à un relevé qui ne voit plus d'écart n'est pas une erreur courante -------------------
//
// @verifies docs/BACKLOG.md#SPK-68 · docs/DAT.md §50.4 (une vue rouverte retrouve le journal, puis relit la
//           machine — et le journal d'un échec que ce relevé dépasse ne reste pas un encadré d'erreur)
//
// Vu le 2026-11-19 sur spark-experiment : « Installation arrêtée sur un échec » restait en rouge, avec « Reprendre
// le diagnostic », alors que le relevé du même écran disait la Forge installée et prête.

const ECHEC = {
  status: 'failed', plan: PLAN, startedAt: '2026-11-18T12:00:00.000Z', updatedAt: '2026-11-18T12:05:00.000Z',
  error: 'L’installateur distant s’est arrêté avec le code 2.',
  events: [
    { phase: 'access', status: 'done', message: 'Plan version 1 et Forge concordants' },
    { phase: 'storage', status: 'failed',
      message: 'le zpool « spark » a encore des fonctionnalités à activer après zpool upgrade' },
  ],
};
const PRET = { ...CONFORME, conformity: { ready: true, installed: true, missing: [], checks: [] } };
const PAS_PRET = { ...CONFORME, conformity: { ready: false, installed: true, missing: ['readyz'], checks: [] } };

test('un échec que le relevé POSTÉRIEUR dépasse n’est plus un encadré d’erreur', () => {
  const html = renderForgeInstaller({ status: 'ready', result: PRET, releveA: '2026-11-19T08:00:00.000Z',
    execution: ECHEC });
  assert.match(html, /Dernière tentative d’installation/);
  assert.match(html, /ne trouve plus aucun écart/);
  assert.doesNotMatch(html, /class="refus"/, 'plus de rouge : rien n’est refusé maintenant');
  assert.doesNotMatch(html, /Installation arrêtée sur un échec/);
  assert.doesNotMatch(html, /data-action="diagnostiquer-forge">Reprendre le diagnostic/,
    'le relevé vient d’avoir lieu : « reprendre » n’a plus d’objet');
});

test('le journal du vieil échec RESTE consultable, replié — on ne l’efface pas', () => {
  const html = renderForgeInstaller({ status: 'ready', result: PRET, releveA: '2026-11-19T08:00:00.000Z',
    execution: ECHEC });
  assert.match(html, /<details[^>]*class="installation__journal"/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /fonctionnalités à activer après zpool upgrade/, 'la cause reste lisible');
  assert.match(html, /L’installateur distant s’est arrêté avec le code 2/);
});

test('un relevé qui N’est PAS prêt laisse l’échec en rouge, comme avant', () => {
  const html = renderForgeInstaller({ status: 'ready', result: PAS_PRET, releveA: '2026-11-19T08:00:00.000Z',
    execution: ECHEC });
  assert.match(html, /Installation arrêtée sur un échec/);
  assert.match(html, /class="refus"/);
});

test('un relevé ANTÉRIEUR à l’échec ne le dépasse pas : l’échec reste le fait le plus récent', () => {
  const html = renderForgeInstaller({ status: 'ready', result: PRET, releveA: '2026-11-18T11:00:00.000Z',
    execution: ECHEC });
  assert.match(html, /Installation arrêtée sur un échec/);
  assert.match(html, /class="refus"/);
});

test('sans date de relevé, on ne conclut RIEN : l’échec reste affiché', () => {
  const html = renderForgeInstaller({ status: 'ready', result: PRET, execution: ECHEC });
  assert.match(html, /Installation arrêtée sur un échec/);
});

test('une installation INTERROMPUE dépassée par un relevé prêt est traitée de la même façon', () => {
  const html = renderForgeInstaller({ status: 'ready', result: PRET, releveA: '2026-11-19T08:00:00.000Z',
    execution: { ...ECHEC, status: 'interrupted', error: 'Connexion interrompue.' } });
  assert.match(html, /Dernière tentative d’installation/);
  assert.doesNotMatch(html, /Installation interrompue/);
});

test('une installation RÉUSSIE ou EN COURS n’est jamais repliée par ce mécanisme', () => {
  const fait = renderForgeInstaller({ status: 'ready', result: PRET, releveA: '2026-11-19T08:00:00.000Z',
    execution: { ...ECHEC, status: 'done', error: null } });
  assert.match(fait, /Forge prête — recette finale mesurée/);
  const encours = renderForgeInstaller({ status: 'ready', result: PRET, releveA: '2026-11-19T08:00:00.000Z',
    execution: { ...ECHEC, status: 'running', error: null } });
  assert.match(encours, /Installation réelle en cours/);
});
