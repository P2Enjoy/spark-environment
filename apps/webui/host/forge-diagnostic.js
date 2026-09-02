/**
 * Diagnostic, strictement en lecture seule, d'une Forge joignable par SSH.
 *
 * @spec docs/BACKLOG.md#SPK-68 · docs/DAT.md §50.1 (transport distinct du
 *       plan de contrôle), §50.2 (contrat fermé), §50.3 (stockage sans choix
 *       implicite) · docs/DESIGN_SYSTEM_APP.md#SPK-DS-12
 *
 * Le navigateur ne fournit qu'un NOM de serveur déjà validé par l'inventaire.
 * Il ne fournit ni commande ni argument distant : ce fichier possède le seul
 * script exécuté, et ne fait que le transmettre à `sh -s` sur la Forge.
 */

import { spawn } from 'node:child_process';

export const GIB = 1024 ** 3;
export const DIAGNOSTIC_TIMEOUT_MS = 20_000;
export const MAX_OUTPUT_BYTES = 96 * 1024;

export class ForgeDiagnosticError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Script fermé, versionné avec la console. Il n'écrit rien et ne reçoit aucune
 * interpolation venant du navigateur. Le protocole tabulé limite chaque valeur
 * à une ligne, afin qu'une sortie inhabituelle ne puisse pas devenir du HTML ou
 * une pseudo-commande au retour.
 */
export const DIAGNOSTIC_SCRIPT = String.raw`#!/bin/sh
set -u

nettoie() {
  printf '%s' "__DOLLAR__{1-}" | tr '\r\n\t' '   ' | cut -c1-2048
}

dit() {
  printf '%s\t%s\n' "$1" "$(nettoie "__DOLLAR__{2-}")"
}

commande() {
  cle="$1"
  shift
  if command -v "$1" >/dev/null 2>&1; then
    dit "$cle" "$("$@" 2>&1 | head -n 1 || true)"
  else
    dit "$cle" ""
  fi
}

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  dit os "__DOLLAR__{ID-} __DOLLAR__{VERSION_ID-}"
else
  dit os ""
fi
dit architecture "$(uname -m 2>/dev/null || true)"
dit identite "$(id -un 2>/dev/null || true)"
dit memoire_octets "$(awk '/MemTotal:/ { print $2 * 1024; exit }' /proc/meminfo 2>/dev/null || true)"
dit racine "$(findmnt -n -o SOURCE / 2>/dev/null || true)"
dit espace_racine "$(df -B1 --output=size,avail / 2>/dev/null | awk 'NR == 2 { print $1 ":" $2 }')"

# Le droit d'administration est établi UNE fois, puis réemployé. Un relevé qui
# interrogerait le socle sans lui rendrait le refus du démon, pas l'absence.
if [ "$(id -u 2>/dev/null || printf x)" = 0 ]; then
  administration=racine
  dit sudo "racine"
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  administration=sudo
  dit sudo "oui"
else
  administration=non
  dit sudo "non"
fi

# Lecture qui EXIGE le droit d'administration. Sans ce droit elle n'est pas
# tentée : mieux vaut une absence nommée qu'un message d'erreur promu en valeur.
admin() {
  case "$administration" in
    racine) "$@" ;;
    sudo) sudo -n "$@" ;;
    *) return 127 ;;
  esac
}

commande incus_version incus version
commande caddy_version caddy version
commande python_version python3 --version
if [ -x /opt/sparkd/venv/bin/python ]; then
  dit sparkd_version "$(/opt/sparkd/venv/bin/python -c 'from importlib.metadata import version; print(version("sparkd"))' 2>/dev/null || true)"
else
  commande sparkd_version sparkd --version
fi

if command -v systemctl >/dev/null 2>&1; then
  dit sparkd_actif "$(systemctl is-active sparkd.service 2>/dev/null || true)"
  dit sparkd_active "$(systemctl is-enabled sparkd.service 2>/dev/null || true)"
  dit caddy_actif "$(systemctl is-active caddy.service 2>/dev/null || true)"
else
  dit sparkd_actif ""
  dit sparkd_active ""
  dit caddy_actif ""
fi

# La commande incus parle au démon par une socket réservée au groupe
# d'administration : lancée sans ce droit, elle rend son mode d'emploi, jamais
# la liste. Le pool existant devenait alors invisible, et l'assistant proposait
# d'en créer un second sur une Forge qui en portait déjà un (DAT §50.2 bis).
if command -v incus >/dev/null 2>&1; then
  dit pools "$(admin incus storage list --format csv 2>/dev/null | head -n 32 | tr '\n' ';' || true)"
  # Une ligne par réseau plutôt qu'une valeur jointe : le bridge cherché ne doit
  # pas pouvoir disparaître dans la troncature d'une ligne trop longue.
  admin incus network list --format csv 2>/dev/null | head -n 32 |
    while IFS= read -r ligne; do dit reseau "$ligne"; done
else
  dit pools ""
fi

# Configuration RÉELLE de la Forge, et elle seule : cinq clés nommées une à une.
# Lire le fichier entier ferait remonter SPARKD_NOTIFY_URL et tout secret qu'un
# exploitant y aurait posé (CLAUDE.md §20).
admin sed -n \
  's/^\(SPARKD_\(STORAGE_POOL\|NETWORK_BRIDGE\|CPU_RESERVE\|MEMORY_RESERVE\|RESERVED_PORTS\)=.*\)$/\1/p' \
  /etc/sparkd/sparkd.env 2>/dev/null | head -n 8 |
  while IFS= read -r ligne; do dit configuration "$ligne"; done
dit arc_max "$(cat /sys/module/zfs/parameters/zfs_arc_max 2>/dev/null || true)"

# sparkd refuse toute adresse routable, et son unité livrée écoute
# 127.0.0.1:9876 ; l'exécuteur interroge la même. Ces deux codes sont les seules
# preuves qui autorisent à écrire « prête » (DAT §50.5).
if command -v curl >/dev/null 2>&1; then
  dit healthz "$(curl -sS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:9876/healthz 2>/dev/null || true)"
  dit readyz "$(curl -sS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:9876/readyz 2>/dev/null || true)"
else
  dit healthz ""
  dit readyz ""
fi

if command -v lsblk >/dev/null 2>&1; then
  # --raw et --pairs sont exclusifs. La forme --pairs, compacte et sans
  # tableau JSON à décoder sur la Forge, conserve une ligne structurée par bloc.
  lsblk -b -P -o NAME,TYPE,SIZE,FSTYPE,MOUNTPOINT,PKNAME,PARTTYPE 2>/dev/null |
    while IFS= read -r ligne; do dit bloc "$ligne"; done
fi
`.replaceAll('__DOLLAR__', '$');

/** Arguments OpenSSH, hors tout contrôle du navigateur. */
export function sshArgs(server) {
  const commun = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  if (server.kind === 'alias') return [...commun, server.sshHost, 'sh', '-s'];
  return [...commun, '-p', String(server.port), `${server.user}@${server.host}`, 'sh', '-s'];
}

/** Retire les échappements non utiles de la forme `lsblk -P`. */
export function parseBlock(line) {
  const values = {};
  for (const match of String(line).matchAll(/([A-Z]+)="([^"]*)"/g)) {
    values[match[1].toLowerCase()] = match[2];
  }
  const size = Number(values.size);
  if (!values.name || !values.type || !Number.isFinite(size) || size < 0) return null;
  const device = (value) => String(value ?? '').replace(/^\/dev\//, '');
  return {
    name: device(values.name),
    type: values.type,
    sizeBytes: size,
    filesystem: values.fstype || null,
    mountpoint: values.mountpoint || null,
    parent: values.pkname ? device(values.pkname) : null,
    // GUID de type GPT. Une partition d'amorçage n'a ni système de fichiers ni
    // montage : sans son type, elle passerait pour un support libre.
    partType: values.parttype ? values.parttype.toLowerCase() : null,
  };
}

/**
 * Une ligne de pool n'est retenue que si elle a la FORME d'une ligne CSV
 * d'`incus storage list`. Sans ce filtre, le mode d'emploi rendu par un `incus`
 * sans droit devenait deux « pools » aux noms absurdes (docs/DAT.md §50.2 bis).
 */
const POOL_LINE = /^[a-z0-9][a-z0-9._-]*,[a-z0-9]+(,|$)/i;

/** `nom,type,gere,adresse,...` — les quatre premières colonnes suffisent ici. */
export function parseNetwork(line) {
  const columns = String(line ?? '').split(',');
  const [name, type, managed] = columns.map((value) => value.trim());
  if (!name || !type || columns.length < 3) return null;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return null;
  return { name, type, managed: /^(yes|oui|true)$/i.test(managed) };
}

/**
 * Les cinq clés de `/etc/sparkd/sparkd.env` que le plan possède, et elles
 * seules. Le relevé décrit ainsi la configuration RÉELLE de la Forge au lieu de
 * laisser l'écran reproposer les défauts du contrat de déploiement (§50.4).
 */
export function parseForgeConfig(lines, arcMaxBytes) {
  const brut = {};
  for (const line of lines ?? []) {
    const index = String(line).indexOf('=');
    if (index < 1) continue;
    brut[String(line).slice(0, index).trim()] = String(line).slice(index + 1).trim();
  }
  const gibioctets = (value) => {
    const match = /^([0-9]+(?:\.[0-9]+)?)\s*(Gi?B|Mi?B|Ki?B|B)?$/i.exec(String(value ?? ''));
    if (!match) return null;
    const facteur = { g: GIB, m: 1024 ** 2, k: 1024, b: 1 }[
      String(match[2] ?? 'GiB')[0].toLowerCase()] ?? GIB;
    return Number(match[1]) * facteur / GIB;
  };
  const config = {};
  if (brut.SPARKD_STORAGE_POOL) config.poolName = brut.SPARKD_STORAGE_POOL;
  if (brut.SPARKD_NETWORK_BRIDGE) config.bridgeName = brut.SPARKD_NETWORK_BRIDGE;
  const cpu = Number(brut.SPARKD_CPU_RESERVE);
  if (brut.SPARKD_CPU_RESERVE !== undefined && Number.isFinite(cpu) && cpu >= 0) {
    config.cpuReserve = cpu;
  }
  const memoire = gibioctets(brut.SPARKD_MEMORY_RESERVE);
  if (memoire !== null) config.memoryReserveGib = memoire;
  if (brut.SPARKD_RESERVED_PORTS !== undefined) {
    config.reservedPorts = String(brut.SPARKD_RESERVED_PORTS).split(',')
      .map((port) => Number(port.trim()))
      .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535);
  }
  const arc = numberOrNull(arcMaxBytes);
  if (arc) config.arcMaxGib = arc / GIB;
  return Object.keys(config).length ? config : null;
}

/** Le protocole de DIAGNOSTIC_SCRIPT devient une donnée bornée et typée. */
export function parseDiagnostic(output) {
  const values = {};
  const blocks = [];
  const networks = [];
  const configLines = [];
  for (const line of String(output ?? '').split('\n')) {
    const index = line.indexOf('\t');
    if (index < 1) continue;
    const key = line.slice(0, index);
    const value = line.slice(index + 1).trim();
    if (key === 'bloc') {
      const block = parseBlock(value);
      if (block) blocks.push(block);
    } else if (key === 'reseau') {
      const network = parseNetwork(value);
      if (network) networks.push(network);
    } else if (key === 'configuration') {
      configLines.push(value);
    } else if (/^[a-z_]+$/.test(key)) {
      values[key] = value || null;
    }
  }
  const [rootSize, rootAvailable] = String(values.espace_racine ?? '').split(':').map(Number);
  return {
    system: { os: values.os ?? null, architecture: values.architecture ?? null,
              identity: values.identite ?? null,
              memoryBytes: numberOrNull(values.memoire_octets),
              rootSource: values.racine ?? null,
              rootSizeBytes: numberOrNull(rootSize), rootAvailableBytes: numberOrNull(rootAvailable) },
    access: { sudo: values.sudo ?? null },
    runtimes: { incus: values.incus_version ?? null, caddy: values.caddy_version ?? null,
                python: values.python_version ?? null, sparkd: values.sparkd_version ?? null },
    services: { sparkd: values.sparkd_actif ?? null, sparkdEnabled: values.sparkd_active ?? null,
                caddy: values.caddy_actif ?? null },
    // Deux codes HTTP mesurés, jamais déduits de la présence du paquet.
    api: { healthz: httpCode(values.healthz), readyz: httpCode(values.readyz) },
    pools: (values.pools ? values.pools.split(';') : []).filter((line) => POOL_LINE.test(line)),
    networks,
    config: parseForgeConfig(configLines, values.arc_max),
    blocks,
  };
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
}

/** `000` est le code que `curl` rend quand rien n'a répondu : ce n'est pas 0. */
function httpCode(value) {
  const code = Number(value);
  return Number.isInteger(code) && code >= 100 && code <= 599 ? code : null;
}

/** La version majeure/mineure d'Incus, telle que sa première ligne la donne. */
export function incusVersion(value) {
  const match = /(\d+)\.(\d+)/.exec(String(value ?? ''));
  return match ? [Number(match[1]), Number(match[2])] : null;
}

export const INCUS_MINIMUM = [6, 19];

/**
 * Ce que le relevé PROUVE de l'installation, contrôle par contrôle.
 *
 * §50.4 exige que la reprise saute les invariants « de nouveau constatés
 * conformes » ; encore faut-il les constater. Sans ce verdict, une Forge
 * intégralement installée recevait le même écran qu'une machine nue, et
 * l'exploitant n'avait aucun moyen de lire depuis la console que tout était en
 * place. La conclusion n'est JAMAIS déduite du transport ni de la présence du
 * paquet : `prête` demande les deux codes mesurés de `/healthz` et `/readyz`
 * (§50.5, SPK-DS-12).
 */
export function conformity(report, { poolName, bridgeName } = {}) {
  const pool = poolName ?? report?.config?.poolName ?? null;
  const bridge = bridgeName ?? report?.config?.bridgeName ?? null;
  const pools = (report?.pools ?? []).map((line) => {
    const [name, driver] = String(line).split(',').map((value) => value.trim());
    return { name, driver };
  });
  const incus = incusVersion(report?.runtimes?.incus);
  const admin = ['racine', 'oui'].includes(report?.access?.sudo);
  const checks = [
    { id: 'system', label: 'Système Ubuntu relevé',
      ok: /ubuntu/i.test(report?.system?.os ?? ''), detail: report?.system?.os },
    { id: 'admin', label: 'Administration sans invite',
      ok: admin, detail: report?.access?.sudo },
    { id: 'incus', label: `Incus ≥ ${INCUS_MINIMUM.join('.')}`,
      ok: Boolean(incus) && (incus[0] > INCUS_MINIMUM[0] ||
        (incus[0] === INCUS_MINIMUM[0] && incus[1] >= INCUS_MINIMUM[1])),
      detail: report?.runtimes?.incus },
    { id: 'caddy', label: 'Caddy actif',
      ok: report?.services?.caddy === 'active', detail: report?.services?.caddy },
    { id: 'pool', label: pool ? `Pool ZFS « ${pool} »` : 'Pool ZFS de la Forge',
      // Sans droit d'administration, la liste des pools n'est pas lisible : le
      // contrôle est en défaut, il n'est pas déclaré vert par défaut.
      ok: Boolean(pool) && pools.some((p) => p.name === pool && p.driver === 'zfs'),
      detail: admin ? pools.map((p) => p.name).join(', ') || 'aucun' : 'non lisible' },
    { id: 'bridge', label: bridge ? `Bridge « ${bridge} »` : 'Bridge privé de la Forge',
      ok: Boolean(bridge) && (report?.networks ?? []).some(
        (network) => network.name === bridge && network.managed),
      detail: (report?.networks ?? []).filter((n) => n.managed)
        .map((n) => n.name).join(', ') || 'aucun réseau géré relevé' },
    { id: 'package', label: 'Paquet sparkd installé',
      ok: Boolean(report?.runtimes?.sparkd), detail: report?.runtimes?.sparkd },
    { id: 'unit', label: 'Unité sparkd active et activée au démarrage',
      ok: report?.services?.sparkd === 'active' && report?.services?.sparkdEnabled === 'enabled',
      detail: [report?.services?.sparkd, report?.services?.sparkdEnabled]
        .filter(Boolean).join(' · ') },
    { id: 'healthz', label: '/healthz mesuré',
      ok: report?.api?.healthz === 200,
      detail: report?.api?.healthz === null ? 'sans réponse' : String(report?.api?.healthz) },
    { id: 'readyz', label: '/readyz mesuré',
      ok: report?.api?.readyz === 200,
      detail: report?.api?.readyz === null ? 'sans réponse' : String(report?.api?.readyz) },
  ].map((check) => ({ ...check, detail: check.detail || null }));
  const missing = checks.filter((check) => !check.ok);
  return {
    checks,
    missing: missing.map((check) => check.id),
    // « Installée » décrit le socle ; « prête » ajoute les deux mesures d'API.
    installed: checks.filter((check) => !['healthz', 'readyz'].includes(check.id))
      .every((check) => check.ok),
    ready: missing.length === 0,
  };
}

/**
 * Types GPT d'une partition qui appartient à l'amorçage, jamais au pool.
 *
 * Elles n'ont ni système de fichiers ni montage : sans leur type, une partition
 * `bios_grub` de 537 Mo passerait pour un support libre et pourrait être
 * proposée au miroir.
 */
export const PARTITIONS_SYSTEME = new Map([
  ['21686148-6449-6e6f-744e-656564454649', 'partition d’amorçage BIOS'],
  ['c12a7328-f81f-11d2-ba4b-00a0c93ec93b', 'partition système EFI'],
  ['bc13c2ff-59e6-4262-a352-b275fd6f7172', 'partition d’amorçage étendue'],
]);

/**
 * Classe le stockage sans décider (docs/DAT.md §50.3).
 *
 * **Corrigé le 2026-09-02.** La version précédente ne considérait que des
 * DISQUES ENTIERS, et excluait tout disque portant une partition. Or une Forge
 * n'est jamais vide : elle est soit un serveur dédié partitionné à la commande —
 * dont le schéma réserve précisément `sda5` et `sdb5` au pool (§8.6) —, soit un
 * VPS dont les disques sont montés. Sur le matériel même que le produit vise, le
 * miroir natif n'était donc jamais proposable : les partitions réservées pour lui
 * étaient invisibles, et le pool fichier restait le seul chemin offert.
 *
 * Un support candidat est donc un disque entier libre **ou une partition libre**,
 * y compris sur un disque qui porte le système. L'incertitude reste une
 * exclusion, et chaque support écarté garde son motif (SPK-DS-12).
 */
export function storageProposal(report) {
  const blocks = report?.blocks ?? [];
  // `lsblk -P` répète un `md` sous chacun de ses membres : on indexe par NOM,
  // et un support peut avoir DEUX parents — c'est ce qui fait qu'un miroir
  // logiciel occupe bien ses deux disques, pas seulement le premier.
  const parents = new Map();
  const enfants = new Map();
  const parNom = new Map();
  for (const block of blocks) {
    if (!parNom.has(block.name)) parNom.set(block.name, block);
    if (!parents.has(block.name)) parents.set(block.name, new Set());
    if (!block.parent) continue;
    parents.get(block.name).add(block.parent);
    if (!enfants.has(block.parent)) enfants.set(block.parent, new Set());
    enfants.get(block.parent).add(block.name);
  }

  /** Tout ce qui porte un montage : le support monté et TOUTE son ascendance. */
  const occupe = new Map();
  const remonter = (nom, motif) => {
    if (!nom || occupe.get(nom)?.has(motif)) return;
    occupe.set(nom, (occupe.get(nom) ?? new Set()).add(motif));
    for (const parent of parents.get(nom) ?? []) remonter(parent, motif);
  };
  const rootDevice = String(report?.system?.rootSource ?? '').replace(/^\/dev\//, '');
  remonter(rootDevice, 'porte la racine');
  for (const block of blocks) {
    // Le même mot pour le même fait : « porte / » et « porte la racine »
    // affichés côte à côte se liraient comme deux motifs d'exclusion distincts.
    if (block.mountpoint) {
      remonter(block.name, block.mountpoint === '/' ? 'porte la racine'
        : `porte ${block.mountpoint}`);
    }
  }

  /** Le disque physique auquel un support appartient, en remontant les parents. */
  const disquePhysique = (nom, vus = new Set()) => {
    if (!nom || vus.has(nom)) return null;
    vus.add(nom);
    if (parNom.get(nom)?.type === 'disk') return nom;
    for (const parent of parents.get(nom) ?? []) {
      const disque = disquePhysique(parent, vus);
      if (disque) return disque;
    }
    return null;
  };

  // Seuls un disque entier et une partition peuvent recevoir un pool. Un `md`,
  // un volume logique ou un chiffré n'apparaissent que comme motif d'exclusion.
  const supports = blocks
    .filter((block, index) =>
      ['disk', 'part'].includes(block.type) &&
      blocks.findIndex((autre) => autre.name === block.name) === index)
    .map((block) => {
      const reasons = [...(occupe.get(block.name) ?? [])];
      if (block.mountpoint) reasons.push(`monté sur ${block.mountpoint}`);
      if (block.filesystem) reasons.push(`signature ${block.filesystem}`);
      if ((enfants.get(block.name)?.size ?? 0) > 0) {
        reasons.push(block.type === 'disk' ? 'porte des partitions' : 'porte un volume');
      }
      const systeme = PARTITIONS_SYSTEME.get(block.partType ?? '');
      if (systeme) reasons.push(systeme);
      return { ...block, disk: disquePhysique(block.name) ?? block.name,
               reasons: [...new Set(reasons)] };
    });

  // Deux supports libres portés par DEUX disques physiques distincts. Deux
  // partitions du même disque donneraient un miroir qui ne survit pas à la
  // panne de ce disque : ce serait le mot « miroir » sans ce qu'il promet.
  const libres = supports.filter((support) => support.reasons.length === 0)
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
  const pair = [];
  for (const support of libres) {
    if (!pair.some((retenu) => retenu.disk === support.disk)) pair.push(support);
    if (pair.length === 2) break;
  }
  const eligible = pair.length === 2;
  return {
    supports,
    free: libres.map((support) => support.name),
    nativeMirror: {
      eligible,
      devices: eligible ? pair.map((support) => support.name) : [],
      // §8.5 : un pool natif sans miroir détecte la corruption silencieuse sans
      // la réparer. Le refus est donc NOMMÉ, au lieu de basculer en silence.
      refusal: eligible ? null
        : libres.length === 0 ? 'aucun support libre'
          : libres.length === 1 ? 'un seul support libre'
            : 'tous les supports libres sont sur le même disque physique',
    },
    filePool: {
      possible: Number.isFinite(report?.system?.rootAvailableBytes),
      filesystem: report?.system?.rootSource ?? null,
      availableBytes: report?.system?.rootAvailableBytes ?? null,
      // La taille ne devient pas un défaut déguisé : le responsable la choisit
      // dans le plan et devra la confirmer avant la moindre écriture.
      sizeBytes: null,
    },
  };
}

/** Lance le script fermé, avec durée et volume bornés. */
export function runDiagnostic(server, {
  spawnFn = spawn, timeoutMs = DIAGNOSTIC_TIMEOUT_MS, maxOutputBytes = MAX_OUTPUT_BYTES,
} = {}) {
  if (server.kind === 'local') {
    return Promise.reject(new ForgeDiagnosticError(
      'local_server', 'Le diagnostic d’installation distante ne s’applique pas à cette Forge locale.',
    ));
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn('ssh', sshArgs(server), { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new ForgeDiagnosticError('ssh_start_failed', `OpenSSH n’a pas pu démarrer : ${error.message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let overflow = false;
    const take = (target, chunk) => {
      const next = target + String(chunk);
      if (Buffer.byteLength(next) > maxOutputBytes) { overflow = true; return target; }
      return next;
    };
    child.stdout?.on('data', (chunk) => { stdout = take(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = take(stderr, chunk); });
    child.on('error', (error) => reject(new ForgeDiagnosticError(
      'ssh_start_failed', `OpenSSH n’a pas pu démarrer : ${error.message}`,
    )));
    const timeout = setTimeout(() => {
      child.kill?.('SIGTERM');
      reject(new ForgeDiagnosticError('ssh_timeout', 'Le diagnostic SSH a dépassé 20 secondes.'));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (overflow) return reject(new ForgeDiagnosticError(
        'output_too_large', 'Le diagnostic a produit trop de données et a été arrêté.',
      ));
      if (code !== 0) return reject(new ForgeDiagnosticError(
        'ssh_failed', safeError(stderr) || `OpenSSH s’est arrêté (code ${code}).`,
      ));
      const report = parseDiagnostic(stdout);
      if (!report.system.os && !report.blocks.length) return reject(new ForgeDiagnosticError(
        'invalid_report', 'Le diagnostic distant n’a pas rendu un relevé exploitable.',
      ));
      resolve({ transport: 'established', report, storage: storageProposal(report),
                conformity: conformity(report) });
    });
    child.stdin?.end(DIAGNOSTIC_SCRIPT);
  });
}

function safeError(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2048);
}
