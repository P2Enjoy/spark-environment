/**
 * Pile jetable pour les parcours E2E.
 *
 * @spec docs/BACKLOG.md#SPK-24 · docs/DAT.md §29.2 (le harnais monte sa propre
 *       pile), §28 (la pile de développement et le seed)
 *
 * Le harnais démarre `sparkd` et l'hôte console lui-même, sur des ports libres,
 * avec un registre jetable seedé. S'appuyer sur une pile déjà lancée ferait
 * dépendre le verdict de son état : un Spark ajouté à la main rendrait la suite
 * verte alors qu'elle ne devrait pas l'être.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON = join(RACINE, 'services', 'sparkd', '.venv', 'bin', 'python');

/** Demande un port libre au système. */
function portLibre() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function attendre(url, { tentatives = 60, delaiMs = 250, quoi }) {
  for (let i = 0; i < tentatives; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* pas encore là */ }
    await new Promise((r) => setTimeout(r, delaiMs));
  }
  throw new Error(`${quoi} n'a pas répondu sur ${url} après ${tentatives * delaiMs} ms.`);
}

function lancer(commande, args, env, journal) {
  const enfant = spawn(commande, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const garder = (bloc) => { journal.push(String(bloc)); };
  enfant.stdout.on('data', garder);
  enfant.stderr.on('data', garder);
  return enfant;
}

/**
 * Monte une pile complète et rend de quoi la piloter et la démonter.
 *
 * Le seed est appliqué AVANT le démarrage de `sparkd` : le pilote factice tient
 * son état dans un fichier voisin du registre (docs/DAT.md §28.4), et peupler
 * après coup laisserait le processif servir un registre qu'il n'a pas relu.
 */
export async function monterPile({ dns = null } = {}) {
  const dossier = await mkdtemp(join(tmpdir(), 'spark-e2e-'));
  const registre = join(dossier, 'spark.db');
  const inventaire = join(dossier, 'servers.json');
  const portSparkd = await portLibre();
  const portConsole = await portLibre();
  const journal = [];

  const envSparkd = {
    SPARKD_DB: registre,
    SPARKD_DRIVER: 'fake',
    SPARKD_BIND: `127.0.0.1:${portSparkd}`,
    PYTHONPATH: join(RACINE, 'services', 'sparkd', 'src'),
  };

  // 1. Le seed, par la commande du dépôt, sur ce registre jetable.
  await new Promise((resolve, reject) => {
    const seed = lancer(PYTHON, ['-m', 'sparkd.seed'], envSparkd, journal);
    seed.on('exit', (code) => (code === 0
      ? resolve()
      : reject(new Error(`seed sorti en ${code} :\n${journal.join('')}`))));
  });

  // 2. `sparkd`, sur son port libre.
  const sparkd = lancer(PYTHON, ['-m', 'sparkd'], envSparkd, journal);
  await attendre(`http://127.0.0.1:${portSparkd}/healthz`, { quoi: 'sparkd' });

  // 3. L'inventaire de la console pointe sur CE sparkd (docs/DAT.md §28.2).
  await writeFile(inventaire, JSON.stringify([
    { name: 'local', kind: 'local', host: '127.0.0.1', port: portSparkd },
  ]));

  // 4. L'hôte console.
  //
  // `SPARK_ENV_FILE` pointe sur un fichier du dossier JETABLE, et il est posé
  // même quand aucun DNS n'est demandé : sans lui, la Forge lirait le `.env` du
  // poste et un parcours automatique parlerait au VRAI fournisseur, donc à des
  // zones en exploitation (SPK-47, docs/DAT.md §38.1).
  const envConsole = join(dossier, '.env');
  await writeFile(envConsole, dns
    ? [`SCW_SECRET_KEY=jeton-de-doublon`,
       `SCW_DEFAULT_ORGANIZATION_ID=organisation-de-doublon`,
       `SPARK_DNS_BASE_URL=${dns.baseUrl}`,
       ...(dns.motif ? [`SPARK_DNS_ALLOW_PATTERN=${dns.motif}`] : [])].join('\n')
    : '');

  const consoleHost = lancer('node', [join(RACINE, 'apps', 'webui', 'host', 'main.js')], {
    SPARK_CONSOLE_PORT: String(portConsole),
    SPARK_CONSOLE_STATE: inventaire,
    SPARK_ENV_FILE: envConsole,
    // SPK-43 · §37.4.2 bis : le doublon du transport. La pile n'a pas de `sshd`
    // dans ses Sparks — son pilote est factice —, et sans lui aucun parcours ne
    // pourrait éprouver le flux, la saisie et la fermeture qui tue.
    SPARK_TERMINAL_COMMAND: 'cat',
    // Le `.env` du poste ne doit pas se réintroduire par l'environnement hérité.
    SCW_SECRET_KEY: '', SCW_DEFAULT_ORGANIZATION_ID: '', SPARK_DNS_ALLOW_PATTERN: '',
    SPARK_DNS_BASE_URL: '',
  }, journal);
  await attendre(`http://127.0.0.1:${portConsole}/api/servers`, { quoi: "l'hôte console" });

  const base = `http://127.0.0.1:${portConsole}`;

  return {
    base,
    portSparkd,
    /** Lecture directe de `sparkd`, pour CONSTATER un effet (docs/DAT.md §29.3).
     *  Jamais pour atteindre un écran ni pour accomplir un geste. */
    async lireSparkd(chemin) {
      const r = await fetch(`http://127.0.0.1:${portSparkd}${chemin}`);
      return { status: r.status, corps: await r.json().catch(() => null) };
    },
    /**
     * Altère le registre HORS DU PRODUIT (SPK-38, docs/DAT.md §36.1).
     *
     * Aucun geste de l'interface ne peut couper la fin du journal : c'est
     * précisément le propos de l'ancre. Prouver qu'elle voit la troncature
     * exige donc d'écrire dans la base par un autre chemin que l'application,
     * comme le ferait qui aurait pris la main sur la Forge. Ce levier n'existe
     * que pour cela, et il n'atteint que le registre JETABLE de la pile.
     */
    async alterer(sql) {
      await new Promise((resolve, reject) => {
        const script = lancer(PYTHON, ['-c',
          'import sqlite3,sys\n'
          + 'c=sqlite3.connect(sys.argv[1])\n'
          + 'c.executescript(sys.argv[2])\n'
          + 'c.commit()\n'
          + 'c.close()\n',
          registre, sql], {}, journal);
        script.on('exit', (code) => (code === 0
          ? resolve()
          : reject(new Error(`altération sortie en ${code} :\n${journal.join('')}`))));
      });
    },
    journal,
    async demonter() {
      sparkd.kill('SIGTERM');
      consoleHost.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 150));
      await rm(dossier, { recursive: true, force: true });
    },
  };
}
