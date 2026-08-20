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
    //
    // « site-vitrine » porte le cas du §37.2 : son chemin NORMAL meurt aussitôt
    // — c'est ce que produit un `sshd` muet — tandis que son DÉPANNAGE
    // fonctionne, puisqu'il passe par la Forge et non par le `sshd`. C'est la
    // situation réelle, et c'est toute la raison d'être du §37.3.
    // SPK-44 · §37.4.2 bis : le doublon du relevé Docker. La pile n'a pas de
    // `sshd` dans ses Sparks — son pilote est factice —, donc sans lui aucun
    // parcours ne pourrait lire un inventaire. Il remplace la COMMANDE lancée,
    // pas le mécanisme : le découpage, le classement et l'écran sont ceux de la
    // production.
    //
    // « printf » plutôt qu'un fichier : la sortie est celle qu'un vrai
    // `docker ps --format` produirait, tabulée, avec un conteneur en marche et
    // un arrêté — le second étant justement ce qu'on vient chercher.
    // Le doublon répond PAR GESTE (§37.6 ter) : inspecter et lire les journaux
    // ne rendent pas la même chose, et « parti » échoue en 1 comme le vrai
    // Docker le fait pour un conteneur supprimé entre deux relevés.
    // Le doublon répond PAR GESTE (§37.6 ter) : inspecter et lire les journaux
    // ne rendent pas la même chose. La vraie commande arrive en « $0 », ce qui
    // permet de distinguer un conteneur présent, un conteneur muet et un
    // conteneur DISPARU — qui échoue en 1, comme le vrai Docker.
    // Le doublon répond PAR GESTE (§37.6 ter) : inspecter et lire les journaux
    // ne rendent pas la même chose. La vraie commande arrive en « $0 », ce qui
    // permet de distinguer un conteneur présent, un conteneur MUET et un
    // conteneur DISPARU — qui échoue en 1, comme le vrai Docker.
    //
    // `%b` et non `%s` : les tabulations sont écrites dans les arguments, et
    // `%s` les rendrait littéralement — les lignes ne se découperaient plus.
    SPARK_DOCKER_COMMAND: JSON.stringify({
      ps: "printf '%b\\n'"
        + " 'abc123\\thelo-web-1\\trunning\\tUp 2 minutes\\tnginx:alpine\\t0.0.0.0:8080->80/tcp'"
        + " 'def456\\thelo-base-1\\texited\\tExited (0)\\tpostgres:16\\t'",
      stats: "printf '%b\\n' 'helo-web-1\\t0.03%\\t12.3MiB / 2GiB\\t0.60%'",
      // L'ordre compte : les listes se reconnaissent à leur gabarit, le
      // conteneur à son nom, et le nom seul viendrait avant le gabarit.
      inspect: 'case "$0" in'
        + " *parti*) echo 'Error: No such object: parti' >&2; exit 1 ;;"
        + " *NetworkSettings*) printf '%b\\n' 'helo_default\\t172.18.0.2' ;;"
        + " *Mounts*) printf '%b\\n'"
        + " 'volume\\thelo_data\\t/var/lib/postgresql/data\\trw' ;;"
        + " *helo-base-1*) printf '%b\\n' '/helo-base-1\\texited\\t137"
        + "\\t2026-08-20T18:52:01Z\\t2026-08-20T18:52:18Z\\t2\\tpostgres:16' ;;"
        + " *) printf '%b\\n' '/helo-web-1\\trunning\\t0"
        + "\\t2026-08-20T18:52:01Z\\t\\t0\\tnginx:alpine' ;;"
        + ' esac',
      // SPK-45 · §37.7.1 : les quatre gestes, avec les codes MESURÉS sur un vrai
      // Docker. « helo-base-1 » est arrêté, donc le tuer rend 1 avec « is not
      // running » — le seul geste non idempotent. « parti » a disparu.
      start: "case \"$0\" in"
        + " *parti*) echo 'Error response from daemon: No such container: parti' >&2;"
        + ' exit 1 ;;'
        + " *) printf '%b\\n' \"${0##* }\" ;;"
        + ' esac',
      stop: "case \"$0\" in"
        + " *parti*) echo 'Error response from daemon: No such container: parti' >&2;"
        + ' exit 1 ;;'
        + " *) printf '%b\\n' \"${0##* }\" ;;"
        + ' esac',
      restart: "case \"$0\" in"
        + " *parti*) echo 'Error response from daemon: No such container: parti' >&2;"
        + ' exit 1 ;;'
        + " *) printf '%b\\n' \"${0##* }\" ;;"
        + ' esac',
      kill: "case \"$0\" in"
        + " *parti*) echo 'Error response from daemon: cannot kill container:"
        + " parti: No such container' >&2; exit 1 ;;"
        + " *helo-base-1*) echo 'Error response from daemon: cannot kill"
        + " container: helo-base-1: container helo-base-1 is not running' >&2;"
        + ' exit 1 ;;'
        + " *) printf '%b\\n' \"${0##* }\" ;;"
        + ' esac',
      // Deux cents lignes PILE pour « helo-web-1 » : la borne du §37.6 ter est
      // atteinte, donc l'écran doit annoncer une troncature. « helo-base-1 »
      // n'écrit rien, ce qui n'est pas la même chose qu'un conteneur disparu.
      //
      // La DEUXIÈME lecture de « helo-web-1 » échoue en 1. C'est la course du
      // §37.6 ter, et c'est le seul moyen de l'éprouver au clavier : le
      // locataire a supprimé son conteneur pendant qu'on le regardait, et
      // « Relire les journaux » tombe alors sur un conteneur disparu. Un témoin
      // dans le dossier de la pile la rend déterministe et reproductible.
      logs: 'case "$0" in'
        + " *parti*) echo 'Error: No such container: parti' >&2; exit 1 ;;"
        + ' *helo-web-1*)'
        + ` if [ -f ${JSON.stringify(join(dossier, 'logs-vus'))} ]; then`
        + " echo 'Error: No such container: helo-web-1' >&2; exit 1; fi;"
        + ` touch ${JSON.stringify(join(dossier, 'logs-vus'))};`
        + " i=1; while [ $i -le 200 ]; do"
        + " printf '2026-08-20T18:52:%02d.000000000Z ligne %d\\n'"
        + ' "$((i % 60))" "$i"; i=$((i + 1)); done ;;'
        + ' *helo-base-1*) : ;;'
        + ' *) : ;;'
        + ' esac',
    }),    SPARK_TERMINAL_COMMAND: JSON.stringify({
      '*': 'cat',
      'site-vitrine': { ssh: 'false', rescue: 'cat' },
    }),
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
     * Écrit sur `sparkd` en CONTOURNANT l'interface (`CLAUDE.md` §10).
     *
     * À ne pas confondre avec `lireSparkd`, qui constate un effet. Ici on agit,
     * ce que le §29.3 interdit pour ATTEINDRE un écran ou accomplir un geste.
     * L'unique usage admis est celui que le `CLAUDE.md` §10 exige : « toute
     * règle d'accès doit être vérifiée par une requête directe qui contourne
     * l'interface ». Masquer un bouton n'est qu'une aide ; la requête, elle,
     * reste formable à la main, et c'est cela qu'on éprouve.
     */
    async ecrireSparkd(chemin, corps = null) {
      const r = await fetch(`http://127.0.0.1:${portSparkd}${chemin}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(corps ?? {}),
      });
      return { status: r.status, corps: await r.json().catch(() => null) };
    },
    /**
     * Rend au doublon Docker sa mémoire vierge (SPK-44, §37.6 ter).
     *
     * Le témoin qui fait échouer la DEUXIÈME lecture des journaux vit aussi
     * longtemps que la pile. Sans remise à zéro, le premier parcours qui ouvre
     * « helo-web-1 » condamnerait tous les suivants à ne plus jamais lire de
     * journaux — et leur échec ne dirait pas pourquoi.
     */
    async oublierLecturesDocker() {
      await rm(join(dossier, 'logs-vus'), { force: true });
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
