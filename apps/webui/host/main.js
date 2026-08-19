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

import { load, save, validate, InventoryError } from './inventory.js';
import { TunnelManager, TunnelError, READY } from './tunnel.js';

const PORT = Number(process.env.SPARK_CONSOLE_PORT ?? 5173);

export function createConsoleHost(options = {}) {
  const tunnels = options.tunnels ?? new TunnelManager();
  const inventoryPath = options.inventoryPath;
  const fetchFn = options.fetch ?? fetch;

  const routes = {
    'GET /api/servers': async () => ({
      status: 200,
      body: {
        servers: await load(inventoryPath),
        tunnels: tunnels.list(),
      },
    }),

    'POST /api/servers': async (corps) => {
      const serveur = validate(corps);
      const existants = (await load(inventoryPath)).filter((s) => s.name !== serveur.name);
      await save([...existants, serveur], inventoryPath);
      return { status: 201, body: serveur };
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
    headers: { 'content-type': requete.headers['content-type'] ?? 'application/json' },
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
