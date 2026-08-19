/**
 * Hôte console : serveur local, inventaire et proxy vers les tunnels.
 *
 * @spec docs/BACKLOG.md#SPK-16 · docs/DAT.md §6, §22.3 (une panne se signale)
 *
 * Le navigateur ne sait rien de SSH. Il parle à ce processus, qui porte les
 * tunnels — parce qu'un navigateur ne peut pas et ne doit pas le faire.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

import {
  load, loadFile, save, saveFile, validate, InventoryError,
} from './inventory.js';
import { sshHosts, probeServer } from './discovery.js';
import { TunnelManager, TunnelError, READY } from './tunnel.js';
import { load as loadAnchors, save as saveAnchors, confronter as confronterAncre }
  from './anchor.js';

const PORT = Number(process.env.SPARK_CONSOLE_PORT ?? 5173);

export function createConsoleHost(options = {}) {
  const tunnels = options.tunnels ?? new TunnelManager();
  const inventoryPath = options.inventoryPath;
  const anchorPath = options.anchorPath;
  const fetchFn = options.fetch ?? fetch;

  const routes = {
    'GET /api/servers': async () => {
      const fichier = await loadFile(inventoryPath);
      return {
        status: 200,
        body: {
          servers: fichier.servers,
          tunnels: tunnels.list(),
          // Le serveur courant est PERSISTÉ (§22.4.5). La console prenait
          // `servers[0]`, ce qui rendait le choix implicite et dépendant de
          // l'ordre d'écriture : ajouter un serveur changeait celui qu'on
          // regardait.
          current: fichier.current ?? fichier.servers[0]?.name ?? null,
        },
      };
    },

    'POST /api/servers': async (corps) => {
      const serveur = validate(corps);
      const fichier = await loadFile(inventoryPath);
      const existants = fichier.servers.filter((s) => s.name !== serveur.name);
      await saveFile({
        servers: [...existants, serveur],
        // Un premier serveur devient courant : sans cela, la console aurait un
        // inventaire et aucun contexte.
        current: fichier.current ?? serveur.name,
        anchors: fichier.anchors,
      }, inventoryPath);
      return { status: 201, body: serveur };
    },

    /**
     * Retire une entrée (§22.4.3).
     *
     * Le tunnel est fermé AVANT l'effacement : laisser un `ssh` vivant vers une
     * machine qu'on vient de retirer de l'inventaire, c'est exactement le genre
     * de processus qu'on ne retrouve plus.
     */
    'DELETE /api/servers': async (corps) => {
      const nom = String(corps?.name ?? '');
      const fichier = await loadFile(inventoryPath);
      if (!fichier.servers.some((s) => s.name === nom)) {
        return { status: 404,
                 body: { error: 'unknown_server', message: `Aucun serveur « ${nom} ».` } };
      }
      tunnels.close(nom);
      const restants = fichier.servers.filter((s) => s.name !== nom);
      // Retirer le COURANT ne laisse pas la console sans contexte : le suivant
      // prend la place, ou aucun si la liste est vide — et l'écran le dit alors,
      // au lieu d'afficher une liste vide qui ferait croire à un serveur sans
      // Sparks.
      const courant = fichier.current === nom
        ? (restants[0]?.name ?? null)
        : fichier.current;
      await saveFile({ servers: restants, current: courant, anchors: fichier.anchors },
                     inventoryPath);
      return { status: 200, body: { removed: nom, current: courant } };
    },

    'POST /api/servers/current': async (corps) => {
      const nom = String(corps?.name ?? '');
      const fichier = await loadFile(inventoryPath);
      const serveur = fichier.servers.find((s) => s.name === nom);
      if (!serveur) {
        return { status: 404,
                 body: { error: 'unknown_server', message: `Aucun serveur « ${nom} ».` } };
      }
      await saveFile({ servers: fichier.servers, current: nom, anchors: fichier.anchors },
                     inventoryPath);
      // Changer de serveur courant ouvre SON tunnel. On ne ferme pas celui de
      // l'ancien : il peut encore servir, et il se ferme explicitement (§22.4.5).
      const tunnel = await tunnels.open(serveur).catch(() => null);
      return { status: 200,
               body: { current: nom, tunnel: tunnel?.describe() ?? null } };
    },

    /**
     * Candidats du `~/.ssh/config`. On PROPOSE, on n'ajoute jamais d'office :
     * un poste de développeur en contient des dizaines qui n'ont rien à voir
     * avec le produit (§22.4 bis).
     */
    'GET /api/ssh-hosts': async () => ({ status: 200, body: { hosts: await sshHosts() } }),

    /**
     * Épreuve avant enregistrement (§22.4.4). Elle INFORME, elle ne décide pas :
     * son résultat n'est pas une condition d'enregistrement, la machine pouvant
     * être éteinte.
     */
    'POST /api/servers/probe': async (corps) => {
      let serveur;
      try {
        serveur = validate(corps);
      } catch (erreur) {
        return { status: 422, body: { error: 'invalid_server', message: erreur.message } };
      }
      return { status: 200, body: await probeServer(serveur, { tunnels, fetch: fetchFn }) };
    },

    'POST /api/tunnels': async (corps) => {
      const serveurs = await load(inventoryPath);
      const serveur = serveurs.find((s) => s.name === corps?.name);
      if (!serveur) {
        return {
          status: 404,
          body: { error: 'unknown_server', message: `Aucun serveur « ${corps?.name} ».` },
        };
      }
      const tunnel = await tunnels.open(serveur);
      // On rend l'état RÉEL, y compris « broken » : annoncer un succès parce
      // que la commande a été lancée serait un succès simulé.
      return { status: tunnel.state === READY ? 200 : 502, body: tunnel.describe() };
    },

    /**
     * L'ancre : la console confronte ce que le serveur annonce à ce qu'elle
     * avait vu (SPK-38, docs/DAT.md §36.2, §36.9.6).
     *
     * C'est ICI que la troncature et le remplacement se voient — la chaîne
     * seule ne les détecte pas, et le serveur n'a pas à être cru sur parole :
     * une longueur en recul suffit à alerter sans lui demander son avis.
     */
    'POST /api/anchor': async (corps) => {
      const nom = String(corps?.name ?? '');
      let tunnel;
      try {
        tunnel = tunnels.require(nom);
      } catch (erreur) {
        return { status: 502, body: { error: 'tunnel_unavailable', message: erreur.message } };
      }
      const amont = await fetchFn(
        `http://127.0.0.1:${tunnel.localPort}/v1/audit/verify`,
        { headers: { 'x-spark-actor': tunnel.actorHeader } },
      );
      if (!amont.ok) {
        return { status: 502, body: { error: 'verify_failed', message: `HTTP ${amont.status}` } };
      }
      const releve = await amont.json();

      const ancres = await loadAnchors(anchorPath);
      // La tête retenue est-elle encore DANS l'histoire annoncée ? Seul le
      // serveur peut répondre — et c'est assumé : un hôte hostile ment, ce qui
      // est précisément pourquoi le recul de longueur se juge sans lui.
      const connue = ancres[nom]?.head ?? null;
      let contient = false;
      if (connue) {
        const recherche = await fetchFn(
          `http://127.0.0.1:${tunnel.localPort}/v1/audit?limit=100000`,
          { headers: { 'x-spark-actor': tunnel.actorHeader } },
        );
        if (recherche.ok) {
          const { entries = [] } = await recherche.json();
          contient = entries.some((e) => e.entry_hash === connue);
        }
      }

      const bilan = confronterAncre(ancres, nom, releve, contient);
      await saveAnchors(bilan.anchors, anchorPath);
      return {
        status: 200,
        body: {
          server: nom, chain: releve,
          verdict: bilan.verdict, explanation: bilan.explanation,
          alert: bilan.alert, known: bilan.known, announced: bilan.announced,
        },
      };
    },

    'DELETE /api/tunnels': async (corps) => {
      tunnels.close(corps?.name);
      return { status: 200, body: { closed: corps?.name } };
    },
  };

  const server = createServer(async (requete, reponse) => {
    try {
      const url = new URL(requete.url, 'http://127.0.0.1');
      const cle = `${requete.method} ${url.pathname}`;

      if (routes[cle]) {
        const corps = await lireCorps(requete);
        const { status, body } = await routes[cle](corps);
        return repondre(reponse, status, body);
      }

      // Tout le reste est relayé au sparkd du serveur choisi.
      if (url.pathname.startsWith('/api/v1/')) {
        return await relayer(url, requete, reponse, tunnels, fetchFn);
      }

      // Fichiers de la console. Servis uniquement depuis ce dossier : un
      // chemin remontant serait une lecture arbitraire du disque.
      return await servirStatique(url.pathname, reponse);
    } catch (erreur) {
      const status = erreur instanceof InventoryError ? 422 : erreur instanceof TunnelError ? 502 : 500;
      repondre(reponse, status, { error: erreur.constructor.name, message: erreur.message });
    }
  });

  server.on('close', () => tunnels.closeAll());
  return { server, tunnels };
}

/**
 * Relaie une requête vers `sparkd`, à travers le tunnel du serveur nommé.
 *
 * Le refus d'un tunnel rompu remonte tel quel : la console doit voir la panne,
 * pas un `502` anonyme (docs/DAT.md §22.3).
 */
async function relayer(url, requete, reponse, tunnels, fetchFn) {
  const nom = url.searchParams.get('server');
  if (!nom) {
    return repondre(reponse, 400, {
      error: 'missing_server',
      message: "Préciser le serveur visé : ?server=<nom>.",
    });
  }

  let tunnel;
  try {
    tunnel = tunnels.require(nom);
  } catch (erreur) {
    const etat = tunnels.get(nom)?.describe() ?? null;
    return repondre(reponse, 502, {
      error: 'tunnel_unavailable',
      message: erreur.message,
      tunnel: etat,
      // La console ne doit JAMAIS présenter des données antérieures comme
      // actuelles : une valeur périmée prise pour vraie fait décider sur un
      // état qui n'existe plus (docs/DAT.md §22.3).
      stale_data_warning: 'Ne pas afficher de données antérieures comme actuelles.',
    });
  }

  const cible = new URL(url.pathname.replace('/api', ''), `http://127.0.0.1:${tunnel.localPort}`);
  for (const [cle, valeur] of url.searchParams) if (cle !== 'server') cible.searchParams.set(cle, valeur);

  const corps = await lireCorpsBrut(requete);
  const amont = await fetchFn(cible.toString(), {
    method: requete.method,
    headers: {
      'content-type': requete.headers['content-type'] ?? 'application/json',
      // SPK-37 · docs/DAT.md §21.6.2 : l'hôte console DÉCLARE qui agit. Le
      // navigateur ne pose pas cet en-tête et ne pourrait pas : il ne sait rien
      // du tunnel ni de la clé qui l'a ouvert. C'est ici qu'on le sait.
      //
      // Un en-tête arrivant du navigateur serait ÉCRASÉ, et c'est voulu :
      // laisser une page choisir son identité au journal la rendrait
      // triviale à falsifier depuis le poste lui-même.
      'x-spark-actor': tunnel.actorHeader,
    },
    body: ['GET', 'HEAD'].includes(requete.method) ? undefined : corps,
  });
  const texte = await amont.text();
  reponse.writeHead(amont.status, { 'content-type': 'application/json; charset=utf-8' });
  reponse.end(texte);
}

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.svg': 'image/svg+xml', '.json': 'application/json' };

async function servirStatique(chemin, reponse) {
  const relatif = normalize(chemin === '/' ? '/index.html' : chemin).replace(/^(\.\.[/\\])+/, '');
  const fichier = join(RACINE, relatif);
  if (!fichier.startsWith(RACINE)) {
    return repondre(reponse, 403, { error: 'forbidden', message: 'Chemin refusé.' });
  }
  try {
    const contenu = await readFile(fichier);
    const extension = relatif.slice(relatif.lastIndexOf('.'));
    reponse.writeHead(200, { 'content-type': `${TYPES[extension] ?? 'application/octet-stream'}; charset=utf-8` });
    return reponse.end(contenu);
  } catch {
    return repondre(reponse, 404, { error: 'not_found', message: `Rien sur ${chemin}.` });
  }
}

function repondre(reponse, status, body) {
  reponse.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  reponse.end(JSON.stringify(body));
}

async function lireCorpsBrut(requete) {
  const morceaux = [];
  for await (const bloc of requete) morceaux.push(bloc);
  return morceaux.length ? Buffer.concat(morceaux) : undefined;
}

async function lireCorps(requete) {
  const brut = await lireCorpsBrut(requete);
  if (!brut?.length) return {};
  try {
    return JSON.parse(brut.toString('utf8'));
  } catch {
    throw new InventoryError('Corps de requête illisible : JSON attendu.');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { server } = createConsoleHost();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Console Spark : http://127.0.0.1:${PORT}`);
    console.log("Aucun port n'est ouvert vers l'extérieur.");
  });
}
