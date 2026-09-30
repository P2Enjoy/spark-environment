/**
 * Banc de REDÉMARRAGE : une Forge montée par le cloud-init du dépôt, dans une
 * machine virtuelle du poste, redémarrée pour de vrai.
 *
 * @verifies docs/BACKLOG.md#SPK-129 · docs/DAT.md §51.5 (ce qui doit reprendre
 *           seul ; la preuve est un redémarrage réel, et le banc dit ses écarts)
 *           · README.md (amorçage par cloud-init) · CLAUDE.md §15, §15 bis
 * @verifies docs/BACKLOG.md#SPK-135 · docs/DAT.md §5.3 bis (`--carte virtio` :
 *           une carte qui n'annonce aucun débit, et le débit déclaré retenu)
 * @verifies docs/BACKLOG.md#SPK-137 · docs/DAT.md §51.6 (la machine gardée, la
 *           console branchée sur elle, les épreuves jouées dans ce processus)
 * @verifies docs/BACKLOG.md#SPK-133 · docs/DAT.md §43.5.3 (le fichier des
 *           secrets reposé après *Redémarrer*, après un `reboot` dans la
 *           cellule, après le redémarrage de la Forge ; la ligne du journal)
 *
 * Ce que le banc établit, et que rien d'autre n'établit :
 *
 *   1. `deploy/cloud-init/` monte une Forge qui fonctionne — préflight vert,
 *      `sparkd` prêt — sur une Ubuntu 26.04 neuve, à deux disques ;
 *   2. un Spark créé PAR L'API, une route déclarée PAR L'API, servent une page ;
 *   3. le fichier des secrets d'un Spark (`/run/spark/secrets`, un tmpfs) est
 *      là après *Redémarrer* par l'API, et revient seul après un `reboot` tapé
 *      dans la cellule (SPK-133) ;
 *   4. après `systemctl reboot`, et SANS AUCUN GESTE, tout reprend : la route
 *      sert la même page, le Spark est en marche, son fichier des secrets est
 *      reposé, le pare-feu est posé, le préflight est vert.
 *
 * Il s'écarte du cloud-init réel en quatre points, et en ceux-là seulement —
 * il les imprime avant de démarrer :
 *   - il crée le zpool avant l'amorce : l'hébergeur le livre (docs/DAT.md §8.2) ;
 *   - il installe `sparkd` depuis une roue construite sur CE poste, et non depuis
 *     `main` : c'est une build qu'on veut éprouver avant de la publier ;
 *   - il ramène le plafond de l'ARC à 1 Gio : la machine en a 6 ;
 *   - il dépose une clé SSH jetable, pour s'y connecter.
 *
 *   make forge-vm                          # roue construite depuis l'arbre de travail
 *   make forge-vm ARGS="--roue <x.whl>"    # une roue donnée : la preuve ROUGE d'avant
 *   make forge-vm ARGS="--carte virtio"    # SPK-135 : une carte qui n'annonce aucun
 *                                          # débit, et `NET_MBIT` déclaré dans l'amorce
 *   make forge-vm ARGS="--garder"          # SPK-137 : garde la machine, lance une console
 *                                          # branchée sur elle, attend Ctrl-C
 *   make forge-vm ARGS="--epreuve <a,b>"   # SPK-137 : joue e2e/forge-vm/epreuves/<a>.mjs,
 *                                          # puis <b>.mjs, contre cette console, puis démonte
 *   … --port-ssh <n>                       # port SSH de la machine gardée (2222 par défaut)
 *
 * Avec --garder ou --epreuve, trois écarts de plus, imprimés eux aussi : la
 * machine reçoit les clés publiques du poste (celles que la console emploie), une
 * clé d'hôte FIXE de banc (gardée dans le cache), et le known_hosts du poste
 * apprend une fois l'empreinte de [127.0.0.1]:<port>. La console est à part : son
 * inventaire ne contient QUE la machine, jamais la Forge de production.
 *
 * L'image Ubuntu (≈ 850 Mo) est gardée dans ~/.cache/spark-environment/vm/.
 * Le reste vit dans un répertoire jetable, retiré en sortant ; la console série
 * de la machine est copiée dans e2e/captures/echecs/ si le banc échoue.
 */
// CLAUDE.md §15 bis · docs/DAT.md §29.8 : une machine virtuelle de 6 Gio est une
// épreuve lourde. Le verrou est pris ICI, à l'import, avant la moindre allocation.
import { prendreLeVerrou } from '../verrou.mjs';

prendreLeVerrou();

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
         rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const RACINE = new URL('../../', import.meta.url).pathname;
const IMAGE_URL = 'https://cloud-images.ubuntu.com/resolute/current/resolute-server-cloudimg-amd64.img';
const CACHE = join(homedir(), '.cache', 'spark-environment', 'vm');
const IMAGE = join(CACHE, basename(IMAGE_URL));
const MEMOIRE_MIO = 6144;
const DOMAINE = 'temoin.banc.test';
const PAGE = 'TEMOIN-SPK129';
// SPK-133 : un secret de banc, sans valeur réelle. Seule sa PRÉSENCE est lue.
const SECRET = 'TEMOIN_SECRET';
const ECHECS = join(RACINE, 'e2e', 'captures', 'echecs');

// --- arguments nommés -------------------------------------------------------
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
}
const iRoue = args.indexOf('--roue');
const roueDonnee = iRoue >= 0 ? args[iRoue + 1] : null;
if (iRoue >= 0 && !roueDonnee) throw new Error('--roue attend le chemin d’une roue .whl');
// SPK-135 · docs/DAT.md §5.3 bis : `e1000e` annonce son débit comme une carte
// physique ; `virtio` n'en annonce aucun, et éprouve le débit DÉCLARÉ.
const iCarte = args.indexOf('--carte');
const carte = iCarte >= 0 ? args[iCarte + 1] : 'e1000e';
if (!['e1000e', 'virtio'].includes(carte)) throw new Error('--carte attend e1000e ou virtio');
// SPK-137 · docs/DAT.md §51.6 : garder la machine, et brancher une console dessus.
const garder = args.includes('--garder');
const iEpreuve = args.indexOf('--epreuve');
const epreuves = iEpreuve >= 0 ? String(args[iEpreuve + 1] ?? '').split(',').filter(Boolean) : [];
if (iEpreuve >= 0 && !epreuves.length) throw new Error('--epreuve attend un nom, ou plusieurs séparés par des virgules');
for (const nom of epreuves) {
  if (!/^[a-z0-9-]+$/.test(nom) || !existsSync(new URL(`./epreuves/${nom}.mjs`, import.meta.url))) {
    throw new Error(`épreuve inconnue : ${nom} (e2e/forge-vm/epreuves/)`);
  }
}
const brancher = garder || epreuves.length > 0;
const iPortSsh = args.indexOf('--port-ssh');
const portSshFixe = iPortSsh >= 0 ? Number(args[iPortSsh + 1]) : 2222;
if (!Number.isInteger(portSshFixe) || portSshFixe < 1024 || portSshFixe > 65535) {
  throw new Error('--port-ssh attend un port entre 1024 et 65535');
}
const valeurs = new Set([iRoue + 1, iCarte + 1, iEpreuve + 1, iPortSsh + 1].filter((i) => i > 0));
const inconnus = args.filter((a, i) => a.startsWith('--')
  && !['--roue', '--carte', '--garder', '--epreuve', '--port-ssh'].includes(a) && !valeurs.has(i));
if (inconnus.length) throw new Error(`arguments inconnus : ${inconnus.join(' ')} (voir --help)`);

// --- outillage --------------------------------------------------------------
const debut = Date.now();
const t = () => `${String(Math.round((Date.now() - debut) / 1000)).padStart(5)} s`;
const dire = (m) => console.log(`[${t()}] ${m}`);
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const verdicts = [];
function verdict(libelle, ok, releve) {
  verdicts.push({ libelle, ok });
  console.log(`[${t()}]   ${ok ? 'ok    ' : 'ÉCHEC '} ${libelle} : ${releve}`);
}
function executer(commande, argv, options = {}) {
  const r = spawnSync(commande, argv, { encoding: 'utf8', ...options });
  if (r.status !== 0) {
    throw new Error(`${commande} ${argv.join(' ')} → ${r.status}\n${r.stderr || r.stdout}`);
  }
  return r.stdout;
}
function portLibre(voulu = 0) {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', () => reject(new Error(`le port ${voulu} du poste est déjà pris`)));
    s.listen(voulu, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const travail = mkdtempSync(join(tmpdir(), 'spark-vm-'));
let qemu = null;
let serveur = null;
let consoleVm = null;
function nettoyer() {
  for (const enfant of [consoleVm, qemu, serveur]) {
    if (enfant && enfant.exitCode === null) enfant.kill('SIGKILL');
  }
  rmSync(travail, { recursive: true, force: true });
}
process.on('exit', nettoyer);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(130));

// --- 1. l'image, la roue, la clé -----------------------------------------------
mkdirSync(CACHE, { recursive: true });
if (!existsSync(IMAGE)) {
  dire(`image absente du cache : téléchargement de ${IMAGE_URL}`);
  executer('curl', ['-fsSL', '--retry', '3', '-o', `${IMAGE}.part`, IMAGE_URL], { stdio: 'inherit' });
  executer('mv', [`${IMAGE}.part`, IMAGE]);
}
let roue;
if (roueDonnee) {
  roue = join(travail, basename(roueDonnee));
  copyFileSync(roueDonnee, roue);
} else {
  const python = join(RACINE, 'services', 'sparkd', '.venv', 'bin', 'python');
  executer(python, ['-m', 'pip', 'wheel', '-q', '--no-deps', '-w', travail,
                    join(RACINE, 'services', 'sparkd')]);
  roue = join(travail, readdirSync(travail).find((f) => f.endsWith('.whl')));
}
dire(`roue éprouvée : ${basename(roue)}`);
executer('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(travail, 'cle')]);
const clePublique = readFileSync(join(travail, 'cle.pub'), 'utf8').trim();

// SPK-137 · docs/DAT.md §51.6 : la console du poste doit pouvoir entrer, avec SA
// clé et sans « clé d'hôte changée » à chaque machine neuve.
let clesDuPoste = [];
let hote = null;
if (brancher) {
  // Les clés que la console présente : celles de l'agent, sinon ~/.ssh/id_*.pub.
  const agent = spawnSync('ssh-add', ['-L'], { encoding: 'utf8' });
  clesDuPoste = agent.status === 0 ? agent.stdout.split('\n').filter((l) => l.startsWith('ssh-')) : [];
  if (!clesDuPoste.length) {
    const dossier = join(homedir(), '.ssh');
    clesDuPoste = existsSync(dossier) ? readdirSync(dossier)
      .filter((f) => /^id_[a-z0-9_]+\.pub$/.test(f))
      .map((f) => readFileSync(join(dossier, f), 'utf8').trim()) : [];
  }
  if (!clesDuPoste.length) throw new Error('aucune clé publique du poste à déposer : ni agent SSH, ni ~/.ssh/id_*.pub');
  // Une clé d'hôte FIXE, créée une fois : chaque machine neuve présente la même.
  const cheminHote = join(CACHE, 'hote_ed25519');
  if (!existsSync(cheminHote)) {
    mkdirSync(CACHE, { recursive: true });
    executer('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'banc-forge-vm', '-f', cheminHote]);
  }
  hote = { privee: readFileSync(cheminHote, 'utf8'),
           publique: readFileSync(`${cheminHote}.pub`, 'utf8').trim() };
  // Le known_hosts du poste apprend l'empreinte UNE fois, et le banc le dit.
  const cle = hote.publique.split(' ').slice(0, 2).join(' ');
  const nom = `[127.0.0.1]:${portSshFixe}`;
  const connus = join(homedir(), '.ssh', 'known_hosts');
  const trouve = spawnSync('ssh-keygen', ['-F', nom, '-f', connus], { encoding: 'utf8' });
  const deja = (trouve.stdout || '').split('\n').some((l) => l.includes(cle));
  if (!deja) {
    if (trouve.status === 0) executer('ssh-keygen', ['-R', nom, '-f', connus]);
    mkdirSync(join(homedir(), '.ssh'), { recursive: true });
    writeFileSync(connus, `${nom} ${cle}\n`, { flag: 'a' });
    console.log(`  écart du banc — known_hosts du poste : ${nom} → clé d’hôte fixe de banc`
      + (trouve.status === 0 ? ' (ancienne entrée de ce port remplacée)' : ''));
  }
}

// --- 2. le cloud-init du dépôt, et ses quatre écarts --------------------------
const portSeed = await portLibre();
const gabarit = readFileSync(join(RACINE, 'deploy', 'cloud-init', 'user-data.yaml'), 'utf8');
let amorce = readFileSync(join(RACINE, 'deploy', 'cloud-init', 'spark-amorce.sh'), 'utf8');
function remplacer(texte, avant, apres, ecart) {
  if (!texte.includes(avant)) {
    throw new Error(`le cloud-init a changé, l'écart « ${ecart} » ne s'applique plus : ${avant}`);
  }
  console.log(`  écart du banc — ${ecart}`);
  return texte.replace(avant, apres);
}
console.log('Écarts du banc au cloud-init réel (docs/DAT.md §51.5) :');
amorce = remplacer(amorce,
  '"git+https://github.com/P2Enjoy/spark-environment.git@main#subdirectory=services/sparkd"',
  `"http://10.0.2.2:${portSeed}/${basename(roue)}"`,
  `sparkd installé depuis ${basename(roue)}, pas depuis main`);
amorce = remplacer(amorce, 'ARC_GIB=16 ', 'ARC_GIB=1  ', 'plafond ARC ramené à 1 Gio');
if (carte === 'virtio') {
  amorce = remplacer(amorce, 'NET_MBIT=""  ', 'NET_MBIT="1000"',
    'carte virtio, qui n’annonce aucun débit : NET_MBIT=1000 déclaré (SPK-135)');
}
const MARQUE = '      # <<< contenu integral de deploy/cloud-init/spark-amorce.sh, indente ici >>>';
let userData = remplacer(gabarit, MARQUE,
  amorce.split('\n').map((l) => (l ? `      ${l}` : '')).join('\n'),
  'amorce insérée dans le gabarit, telle quelle hors des deux écarts ci-dessus');
userData = remplacer(userData, "runcmd:\n  - '/opt/spark-amorce.sh'",
  "runcmd:\n  - [sh, -c, 'apt-get update -q && apt-get install -y zfsutils-linux"
  + " && zpool create -f spark mirror /dev/vdb /dev/vdc && zpool export spark']\n"
  + "  - '/opt/spark-amorce.sh'",
  'zpool « spark » créé en miroir sur vdb et vdc avant l’amorce, comme l’hébergeur le livre');
userData = remplacer(userData, '\nwrite_files:',
  `\nssh_authorized_keys:\n${[clePublique, ...clesDuPoste].map((c) => `  - ${c}`).join('\n')}`
  + `${hote ? `\n\nssh_keys:\n  ed25519_private: |\n${hote.privee.trimEnd().split('\n')
      .map((l) => `    ${l}`).join('\n')}\n  ed25519_public: ${hote.publique}` : ''}`
  + '\n\nwrite_files:',
  brancher ? 'clé jetable, clés du poste et clé d’hôte fixe de banc déposées (SPK-137)'
           : 'clé SSH jetable déposée');

// --- 3. la source NoCloud, servie au poste --------------------------------------
// Par un PROCESSUS à part : les attentes du banc passent par `spawnSync`, qui
// bloque la boucle de Node. Un serveur dans ce processus cessait de répondre
// pendant le cloud-init — mesuré : `pip` n'obtenait jamais la roue.
// Un sous-répertoire, et lui seul : la clé privée jetable reste hors de portée.
const seed = join(travail, 'seed');
mkdirSync(seed);
writeFileSync(join(seed, 'user-data'), userData);
writeFileSync(join(seed, 'meta-data'),
              `instance-id: forge-vm-${Date.now()}\nlocal-hostname: forge-vm\n`);
writeFileSync(join(seed, 'vendor-data'), '');
copyFileSync(roue, join(seed, basename(roue)));
serveur = spawn('python3', ['-m', 'http.server', String(portSeed), '--bind', '127.0.0.1',
                            '--directory', seed], { stdio: 'ignore' });

// --- 4. la machine ----------------------------------------------------------------
// SPK-137 : un port FIXE quand la console doit entrer — le known_hosts du poste
// connaît [127.0.0.1]:<port>, pas un port tiré au hasard.
const portSsh = await portLibre(brancher ? portSshFixe : 0);
const portHttp = await portLibre();
executer('qemu-img', ['create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', IMAGE,
                      join(travail, 'racine.qcow2'), '30G']);
for (const d of ['d1', 'd2']) {
  executer('qemu-img', ['create', '-q', '-f', 'qcow2', join(travail, `${d}.qcow2`), '8G']);
}
const console_ = join(travail, 'console.log');
qemu = spawn('qemu-system-x86_64', [
  '-enable-kvm', '-cpu', 'host', '-smp', '4', '-m', String(MEMOIRE_MIO), '-machine', 'q35',
  '-drive', `if=virtio,format=qcow2,file=${join(travail, 'racine.qcow2')}`,
  '-drive', `if=virtio,format=qcow2,file=${join(travail, 'd1.qcow2')}`,
  '-drive', `if=virtio,format=qcow2,file=${join(travail, 'd2.qcow2')}`,
  '-netdev', `user,id=n0,hostfwd=tcp:127.0.0.1:${portSsh}-:22,hostfwd=tcp:127.0.0.1:${portHttp}-:80`,
  // Par défaut, une carte qui ANNONCE son débit, comme la carte physique d'une
  // Forge. `--carte virtio` n'en annonce aucun : sans débit déclaré, le relevé
  // refuse — à dessein — une capacité nulle (mesuré le 2026-09-30).
  '-device', carte === 'virtio' ? 'virtio-net-pci,netdev=n0' : 'e1000e,netdev=n0',
  '-smbios', `type=1,serial=ds=nocloud;s=http://10.0.2.2:${portSeed}/`,
  '-display', 'none', '-serial', `file:${console_}`,
], { stdio: 'ignore' });
dire(`machine démarrée — ssh 127.0.0.1:${portSsh}, http 127.0.0.1:${portHttp}, carte ${carte}`);

const ssh = (commande, { tolerer = false, delai = 120 } = {}) => {
  const r = spawnSync('ssh', ['-i', join(travail, 'cle'), '-p', String(portSsh),
    '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes',
    'ubuntu@127.0.0.1', commande], { encoding: 'utf8', timeout: delai * 1000 });
  if (r.status !== 0 && !tolerer) throw new Error(`ssh « ${commande} » → ${r.status}\n${r.stderr}`);
  return { code: r.status, sortie: (r.stdout || '').trim() };
};
async function jusqua(libelle, essai, { delai = 600, pas = 5 } = {}) {
  const fin = Date.now() + delai * 1000;
  for (;;) {
    const r = await essai();
    if (r) return r;
    if (Date.now() > fin) throw new Error(`délai dépassé : ${libelle}`);
    await attendre(pas * 1000);
  }
}
const api = (methode, chemin, corps) => {
  const donnees = corps ? Buffer.from(JSON.stringify(corps)).toString('base64') : null;
  const commande = donnees
    ? `echo ${donnees} | base64 -d | curl -s -X ${methode} -H 'content-type: application/json' --data-binary @- http://127.0.0.1:9876${chemin}`
    : `curl -s -X ${methode} http://127.0.0.1:9876${chemin}`;
  const { sortie } = ssh(commande, { tolerer: true, delai: 900 });
  try { return JSON.parse(sortie); } catch { return { brut: sortie }; }
};
const page = () => {
  const r = spawnSync('curl', ['-s', '-m', '5', '-D', '-', '-H', `Host: ${DOMAINE}`,
                               `http://127.0.0.1:${portHttp}/`], { encoding: 'utf8' });
  return r.stdout || '';
};

let reussi = false;
try {
  await jusqua('SSH de la machine', () => ssh('true', { tolerer: true, delai: 10 }).code === 0,
               { delai: 600 });
  dire('SSH joignable ; attente de la fin du cloud-init (apt, Incus, sparkd, préflight)');
  const init = ssh('cloud-init status --wait --long', { tolerer: true, delai: 3600 });
  if (!/status: done/.test(init.sortie)) {
    // Relevé AVANT de démonter : la machine disparaît avec le banc, et un
    // échec sans sa cause obligerait à tout rejouer à la main.
    const lire = (c) => ssh(c, { tolerer: true, delai: 180 }).sortie;
    const journal = lire("sudo grep -v -E '^[|+]|randomart|fingerprint|identification|public key|Generating|SHA256' /var/log/cloud-init-output.log | tail -25");
    const sparkd = lire('sudo journalctl -u sparkd --no-pager -n 40 -o cat');
    const sync = lire("curl -s -m 120 -w '\\n→ HTTP %{http_code} en %{time_total} s' -X POST http://127.0.0.1:9876/v1/forge/sync | tail -c 1500");
    throw new Error(`le cloud-init n'a pas abouti :\n${init.sortie}\n--- cloud-init-output.log\n${journal}`
      + `\n--- journalctl -u sparkd\n${sparkd}\n--- POST /v1/forge/sync, rejoué\n${sync}`);
  }
  verdict('le cloud-init du dépôt monte la Forge', true, 'status: done');
  // SPK-135 · §5.3 bis : sur carte virtio, la capacité retenue est la DÉCLARÉE.
  // Relevé seulement dans ce mode : une roue d'avant SPK-135 ne rend pas la
  // source, et la preuve rouge d'une autre unité ne doit rougir que pour elle.
  if (carte === 'virtio') {
    const reseau = api('GET', '/v1/forge').network ?? {};
    verdict('la capacité réseau est déclarée, faute de débit annoncé',
            reseau.source === 'declared' && reseau.total_bps === 1_000_000_000,
            `${reseau.total_bps ?? '?'} bit/s, ${reseau.source ?? 'source non rendue'}`);
  }

  // --- 5. un Spark et une route, par l'API ------------------------------------
  // Une Forge neuve n'a jamais relevé son catalogue, et refuse — à raison —
  // une image « unknown » (docs/DAT.md §33.3). Le geste de l'exploitant d'abord.
  const catalogue = api('POST', '/v1/images/verify');
  if (catalogue.detail) throw new Error(`relevé du catalogue refusé : ${JSON.stringify(catalogue)}`);
  const cree = api('POST', '/v1/sparks', {
    name: 'temoin', image: 'images:ubuntu/24.04', cpu_mode: 'shared', cpu_reservation: 0.5,
    memory_bytes: 512 * 1024 ** 2, network_bps: 50_000_000, storage_bytes: 4 * 1024 ** 3 });
  if (cree.name !== 'temoin') throw new Error(`création refusée : ${JSON.stringify(cree)}`);
  for (const action of ['apply', 'start']) {
    const r = api('POST', `/v1/sparks/temoin/${action}`);
    if (r.detail) throw new Error(`${action} refusé : ${JSON.stringify(r)}`);
  }
  dire('Spark « temoin » créé et démarré par l’API ; pose de sa pile (un serveur HTTP)');
  // Ce que le locataire ferait : une pile qui redémarre avec sa cellule.
  ssh(`sudo incus exec temoin -- sh -c 'command -v python3 >/dev/null || (apt-get update -q && apt-get install -y -q python3-minimal); mkdir -p /srv/temoin && echo ${PAGE} > /srv/temoin/index.html && printf "[Unit]\\nDescription=pile temoin\\n[Service]\\nExecStart=/usr/bin/python3 -m http.server 8080 --directory /srv/temoin\\n[Install]\\nWantedBy=multi-user.target\\n" > /etc/systemd/system/temoin.service && systemctl enable --now temoin'`,
      { delai: 900 });
  const route = api('POST', '/v1/ingress', { spark: 'temoin', domain: DOMAINE, port: 8080, tls: false });
  if (route.domain !== DOMAINE) throw new Error(`route refusée : ${JSON.stringify(route)}`);

  // --- 5 bis. SPK-133 : le fichier des secrets, à chaque démarrage -------------
  // `/run` est un tmpfs dans la cellule (docs/DAT.md §43.5.2) : chaque démarrage
  // l'efface, et quelque chose doit le reposer. On n'en lit que la PRÉSENCE.
  const pose = api('PUT', `/v1/sparks/temoin/env/${SECRET}`,
                   { value: `banc-${Date.now()}`, secret: true });
  if (pose.detail) throw new Error(`secret refusé : ${JSON.stringify(pose)}`);
  const secretsPresents = () => ssh(
    `sudo incus exec temoin -- grep -c '^${SECRET}=' /run/spark/secrets`,
    { tolerer: true }).sortie === '1';
  const pidInit = () => {
    const { sortie } = ssh('sudo incus query /1.0/instances/temoin/state', { tolerer: true });
    try { return JSON.parse(sortie).pid; } catch { return null; }
  };
  verdict('le fichier des secrets est posé', secretsPresents(), '/run/spark/secrets');
  const relance = api('POST', '/v1/sparks/temoin/restart');
  if (relance.detail) throw new Error(`restart refusé : ${JSON.stringify(relance)}`);
  verdict('après Redémarrer : le fichier des secrets est reposé', secretsPresents(),
          secretsPresents() ? 'présent' : 'absent');
  // Un `reboot` tapé DANS la cellule : `sparkd` ne l'a pas commandé. Le veilleur
  // passe toutes les 15 s ; on lui en laisse 60 avant de conclure.
  const pidAvant = pidInit();
  ssh('sudo incus exec temoin -- systemctl reboot', { tolerer: true, delai: 30 });
  await jusqua('la cellule redémarrée', () => {
    const pid = pidInit();
    return pid && pid !== pidAvant ? pid : null;
  }, { delai: 180, pas: 2 });
  let repose = false;
  try { repose = await jusqua('le fichier des secrets reposé', secretsPresents, { delai: 60, pas: 3 }); }
  catch { repose = false; }
  verdict('après un reboot dans la cellule : le fichier des secrets revient seul', repose,
          repose ? 'présent' : 'absent après 60 s');
  // Ce démarrage, `sparkd` ne l'a pas commandé : le journal doit le dire, une fois.
  const demarrages = () => (api('GET', '/v1/audit?action=spark.cell_started').entries ?? [])
    .filter((e) => e.actor_class === 'runtime');
  const horsProduit = demarrages().length;
  verdict('après un reboot dans la cellule : le journal le dit, en ligne automatique',
          horsProduit === 1, `${horsProduit} ligne(s) spark.cell_started`);

  // --- 6. avant le redémarrage ---------------------------------------------------
  const avant = await jusqua('la route sert la pile',
    () => (page().includes(PAGE) ? page() : null), { delai: 120 });
  verdict('avant : la route sert la pile', true, avant.split('\r\n')[0]);

  // --- 7. le redémarrage, puis AUCUN geste -----------------------------------------
  dire('redémarrage de la machine — à partir d’ici, le banc ne fait que LIRE');
  ssh('sudo systemctl reboot', { tolerer: true, delai: 15 });
  await jusqua('arrêt de la machine', () => ssh('true', { tolerer: true, delai: 5 }).code !== 0,
               { delai: 180, pas: 2 });
  await jusqua('SSH après redémarrage', () => ssh('true', { tolerer: true, delai: 10 }).code === 0,
               { delai: 600 });
  const sante = await jusqua('sparkd prêt', () => {
    const r = api('GET', '/healthz');
    return r.status === 'ok' ? r : null;
  }, { delai: 300 });
  verdict('après : sparkd prêt', true, sante.version);

  // Une route que Caddy porte répond dès que la pile a démarré dans sa cellule.
  // On laisse à la cellule le temps de démarrer ; au-delà, c'est un échec.
  let apres = '';
  try {
    apres = await jusqua('la route sert la pile', () => {
      const p = page();
      return p.includes(PAGE) ? p : null;
    }, { delai: 180 });
  } catch { apres = page(); }
  verdict('après : la route sert la pile, sans aucun geste', apres.includes(PAGE),
          apres.split('\r\n')[0] || 'aucune réponse');
  const spark = api('GET', '/v1/sparks/temoin');
  verdict('après : le Spark est en marche', spark.state === 'running', spark.state);
  let reposeForge = false;
  try { reposeForge = await jusqua('le fichier des secrets reposé', secretsPresents, { delai: 60, pas: 3 }); }
  catch { reposeForge = false; }
  verdict('après : le fichier des secrets est reposé, sans aucun geste', reposeForge,
          reposeForge ? 'présent' : 'absent après 60 s');
  // `sparkd` a redémarré avec la Forge : il ne sait pas qui a relancé la
  // cellule, et ne l'écrit pas (docs/DAT.md §43.5.3).
  const apresForge = demarrages().length;
  verdict('après : aucune ligne hors du produit inventée', apresForge === horsProduit,
          `${apresForge} ligne(s) spark.cell_started`);
  // `systemctl show` sépare deux unités par une ligne VIDE : on relit mot à mot.
  const unites = ssh('systemctl show -p UnitFileState --value caddy.service caddy-api.service'
    + ' ; systemctl is-active caddy-api.service', { tolerer: true }).sortie
    .split(/\s+/).filter(Boolean).join(' ');
  verdict('après : Caddy porté par caddy-api.service, caddy.service masqué',
          unites === 'masked enabled active', unites);
  const pareFeu = ssh('sudo nft list table inet spark_filter >/dev/null && echo posé',
                      { tolerer: true }).sortie;
  verdict('après : le pare-feu du bridge est posé', pareFeu === 'posé', pareFeu || 'absent');
  const pool = ssh('sudo zpool list -H -o health spark', { tolerer: true }).sortie;
  verdict('après : le pool est en ligne', pool === 'ONLINE', pool || 'absent');
  const pf = ssh('sudo /opt/sparkd/venv/bin/python -m sparkd.preflight', { tolerer: true, delai: 120 });
  const rouges = (pf.sortie.match(/^\[ECHEC \] \S+/gm) || []).map((l) => l.split(/\s+/).pop());
  verdict('après : le préflight est vert', pf.code === 0,
          rouges.length ? `bloquants : ${rouges.join(', ')}` : pf.sortie.split('\n').pop());

  reussi = verdicts.every((v) => v.ok);
} catch (erreur) {
  verdict('le banc est allé au bout', false, erreur.message);
} finally {
  if (!reussi && existsSync(console_)) {
    mkdirSync(ECHECS, { recursive: true });
    copyFileSync(console_, join(ECHECS, 'forge-vm-console.log'));
    console.log(`console série : ${join(ECHECS, 'forge-vm-console.log')}`);
  }
}
console.log(reussi
  ? `VERT en ${t().trim()} : la Forge du cloud-init reprend seule après un redémarrage.`
  : `ROUGE en ${t().trim()} : ${verdicts.filter((v) => !v.ok).length} écart(s).`);

// --- 8. SPK-137 · §51.6 : la console branchée sur la machine --------------------
/**
 * Une console À PART, depuis l'arbre de travail : son inventaire ne contient que
 * la machine, et vit dans le répertoire jetable. La console d'exploitation, son
 * inventaire et ses ancres ne sont pas touchés.
 */
async function lancerLaConsole() {
  const dossier = join(travail, 'console');
  mkdirSync(dossier, { recursive: true });
  const inventaire = join(dossier, 'servers.json');
  writeFileSync(inventaire, JSON.stringify({
    version: 1, current: 'forge-vm', anchors: {},
    servers: [{ name: 'forge-vm', kind: 'ssh', host: '127.0.0.1', user: 'ubuntu',
                port: portSsh, remotePort: 9876 }],
  }, null, 2));
  const port = await portLibre();
  // Ni interrupteur d'épreuve, ni doublon : c'est la console d'exploitation.
  const env = { ...process.env, SPARK_CONSOLE_PORT: String(port), SPARK_CONSOLE_STATE: inventaire };
  delete env.SPARK_EPREUVE;
  consoleVm = spawn(process.execPath, ['host/main.js'],
                    { cwd: join(RACINE, 'apps', 'webui'), env, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}/`;
  await jusqua('la console répond', async () => {
    try { return (await fetch(url)).ok; } catch { return false; }
  }, { delai: 60, pas: 1 });
  return url;
}

if (brancher && (reussi || garder)) {
  const url = await lancerLaConsole();
  dire(`console de la machine : ${url} — inventaire à part, la seule Forge est la VM`);
  if (epreuves.length) {
    for (const nom of epreuves) {
      dire(`épreuve « ${nom} »`);
      const { default: jouer } = await import(`./epreuves/${nom}.mjs`);
      try {
        await jouer({ console: url, carte, verdict, dire, ssh, api, jusqua, attendre });
      } catch (erreur) {
        verdict(`l’épreuve « ${nom} » est allée au bout`, false, erreur.message);
      }
    }
    reussi = verdicts.every((v) => v.ok);
    console.log(reussi ? `VERT en ${t().trim()} : épreuves comprises.`
      : `ROUGE en ${t().trim()} : ${verdicts.filter((v) => !v.ok).length} écart(s), épreuves comprises.`);
  }
  if (garder) {
    dire('machine GARDÉE : Ctrl-C pour tout démonter (machine, console, verrou)');
    await new Promise(() => {});
  }
} else if (brancher) {
  dire('banc ROUGE : les épreuves ne se jouent pas sur une machine qui ne tient pas');
}
// SORTIR, explicitement. Un enfant vivant — la machine, le serveur de la source
// NoCloud — garde la boucle de Node ouverte : mesuré le 2026-09-30, un premier
// banc a rendu son verdict puis gardé 20 minutes une VM de 6 Gio et le verrou.
nettoyer();
process.exit(reussi ? 0 : 1);
