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
import { chapitres as manuelChapitres, chapitre as manuelChapitre,
         image as manuelImage, ManuelError } from './manuel.js';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

import {
  load, loadFile, save, saveFile, validate, InventoryError,
} from './inventory.js';
import { sshHosts, probeServer } from './discovery.js';
import { TunnelManager, TunnelError, READY } from './tunnel.js';
import { load as loadAnchors, save as saveAnchors, confronter as confronterAncre }
  from './anchor.js';
import { DnsError, fournisseurDepuis, preparer, readDotEnv } from './dns.js';
import { catalogue, composer, ValeurManquante } from './recettes.js';
import { SessionManager, TerminalError, FLUX_FERME,
         CHEMIN_SSH, CHEMIN_DEPANNAGE, depannageOuvert, sonderSshd } from './terminal.js';

const PORT = Number(process.env.SPARK_CONSOLE_PORT ?? 5173);

export function createConsoleHost(options = {}) {
  const tunnels = options.tunnels ?? new TunnelManager();
  // SPK-43 · §37.1 : les sessions de terminal vivent ICI, sur le poste. Le plan
  // de contrôle n'est pas dans ce chemin et n'en gagne aucun pouvoir.
  const terminaux = options.terminals ?? new SessionManager({
    // §37.4.2 bis : absente en production, et c'est le cas normal — le produit
    // lance alors `ssh`.
    commande: process.env.SPARK_TERMINAL_COMMAND || null,
  });
  const inventoryPath = options.inventoryPath;
  const anchorPath = options.anchorPath;
  const fetchFn = options.fetch ?? fetch;
  // §37.3 : le sondage du `sshd` lance un vrai `ssh`. Injectable pour que les
  // preuves de cette route éprouvent la RÈGLE sans dépendre d'un réseau — le
  // sondage lui-même a ses propres preuves dans `terminal.test.js`.
  const sonder = options.probeSshd ?? sonderSshd;

  // SPK-47 · §38.1 : le jeton du fournisseur DNS vit dans l'environnement de CE
  // processus. Il est lu UNE fois : le relire à chaque requête ferait dépendre
  // le comportement d'un fichier modifiable pendant qu'un écran l'utilise.
  //
  // `process.env` prime sur le fichier — un export explicite doit gagner sur un
  // `.env` oublié dans un coin du disque.
  const envPath = options.envPath
    ?? process.env.SPARK_ENV_FILE
    ?? join(RACINE_DEPOT, '.env');
  let environnementCache = options.env ?? null;
  async function environnement() {
    if (!environnementCache) {
      // Une variable exportée VIDE n'écrase pas le fichier : elle sert à
      // NEUTRALISER un héritage, et la traiter comme une valeur ferait passer
      // « rien » pour un choix. C'est ce que fait le harnais E2E, qui vide les
      // variables du poste avant de désigner son propre fichier.
      const exportees = Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ''));
      environnementCache = { ...await readDotEnv(envPath), ...exportees };
    }
    return environnementCache;
  }

  /** Rend le fournisseur, ou `null` avec la raison. Un jeton absent n'est PAS une panne. */
  async function fournisseur() {
    return fournisseurDepuis(await environnement(), { fetch: fetchFn });
  }

  /**
   * Déclare un évènement de session au journal de `sparkd` (§37.4.5).
   *
   * **Rien du contenu ne traverse jamais cette frontière** : la charge est
   * construite ici, champ par champ, et ne peut donc pas emporter un octet de
   * la session — c'est la règle du §37.5 rendue impossible à enfreindre plutôt
   * qu'improbable.
   *
   * Un échec ne remonte pas : le §37.4.5 le dit, une panne de journal n'est pas
   * une panne d'exploitation.
   */
  async function declarerAudit(tunnel, action, { spark, path, reason, duration_seconds }) {
    if (!tunnel?.localPort) return false;
    try {
      const reponse = await fetchFn(`http://127.0.0.1:${tunnel.localPort}/v1/audit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json',
                   'x-spark-actor': tunnel.actorHeader },
        body: JSON.stringify({
          action, result: 'ok', target_type: 'spark', target_id: spark,
          message: action === 'spark.terminal_open'
            ? `Session de terminal ouverte sur « ${spark} » par ${path}.`
            // §37.3 : le message NOMME le pouvoir employé, comme la
            // confirmation le fait à l'écran. Un « ouverture de dépannage »
            // laisserait croire à un mode dégradé anodin.
            : action === 'spark.rescue_exec'
              ? `Dépannage ouvert sur « ${spark} » : exécution en root dans la `
                + `cellule, depuis le plan de contrôle (${reason}).`
              : `Session de terminal fermée sur « ${spark} » après `
                + `${duration_seconds} s (${reason}).`,
          payload: { path, ...(reason ? { reason } : {}),
                     ...(duration_seconds == null ? {} : { duration_seconds }) },
        }),
      });
      return reponse.ok;
    } catch {
      return false;
    }
  }

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
        // MÊME règle que la lecture : le courant retenu, sinon le PREMIER de la
        // liste, sinon le nouveau. Sans le repli sur le premier, un fichier en
        // forme historique — où `current` est nul — laissait le second serveur
        // ajouté VOLER le contexte, alors que la lecture, elle, montrait le
        // premier. Mesuré par le parcours E2E du catalogue.
        current: fichier.current ?? existants[0]?.name ?? serveur.name,
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
      // serveur peut répondre — et c'est assumé : une Forge hostile ment, ce qui
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

    /**
     * Zones du compte (§38.2). Lecture SEULE.
     *
     * Un poste sans jeton rend `configured: false` avec sa raison, et un `200` :
     * ne pas avoir configuré de fournisseur est le cas normal, pas une panne, et
     * l'écran doit pouvoir le DIRE au lieu d'afficher une erreur (§38.1).
     */
    'GET /api/dns/zones': async (_corps, url) => {
      const bilan = await fournisseur();
      if (!bilan.configured) {
        return { status: 200,
                 body: { configured: false, reason: bilan.reason, zones: [] } };
      }
      try {
        return { status: 200,
                 body: { configured: true, motif: bilan.motif,
                         zones: await bilan.provider.zones() } };
      } catch (erreur) {
        return { status: 502, body: { error: 'dns_unavailable', message: erreur.message } };
      }
    },

    /** Enregistrements d'une zone (§38.2). Lecture SEULE. */
    'GET /api/dns/records': async (_corps, url) => {
      const zone = url?.searchParams.get('zone') ?? '';
      if (!zone) {
        return { status: 400,
                 body: { error: 'missing_zone', message: 'Préciser la zone : ?zone=<nom>.' } };
      }
      const bilan = await fournisseur();
      if (!bilan.configured) {
        return { status: 409, body: { error: 'dns_not_configured', message: bilan.reason } };
      }
      try {
        return { status: 200, body: { zone, records: await bilan.provider.records(zone) } };
      } catch (erreur) {
        return { status: 502, body: { error: 'dns_unavailable', message: erreur.message } };
      }
    },

    /**
     * Ce que l'écriture ferait, SANS l'écrire (§38.5.2).
     *
     * L'écran le demande à l'ouverture et au changement de zone. C'est ce qui
     * remplace le refus d'écrire à l'apex : on ne retire pas le pouvoir, on
     * montre ce qu'il va faire.
     */
    'POST /api/dns/preview': async (corps) => {
      const bilan = await fournisseur();
      if (!bilan.configured) {
        return { status: 409, body: { error: 'dns_not_configured', message: bilan.reason } };
      }
      let prepare;
      try {
        prepare = preparer({
          domain: corps?.domain, zone: corps?.zone, address: corps?.address,
          motif: bilan.motif,
        });
      } catch (erreur) {
        if (!(erreur instanceof DnsError)) throw erreur;
        return { status: 422, body: { error: 'dns_refused', message: erreur.message } };
      }
      try {
        const actuel = await bilan.provider.existant(prepare);
        return {
          status: 200,
          body: {
            ...prepare,
            current: actuel,
            effet: !actuel ? 'pose'
              : actuel.data === prepare.data ? 'inchange'
              : 'remplace',
          },
        };
      } catch (erreur) {
        return { status: 502, body: { error: 'dns_unavailable', message: erreur.message } };
      }
    },

    /**
     * Pose l'enregistrement d'ingress (§38.3).
     *
     * La garde s'applique AVANT tout appel au fournisseur : un refus doit coûter
     * zéro requête sortante, et surtout ne jamais atteindre une zone réelle pour
     * s'y faire refuser sur place.
     */
    'POST /api/dns/record': async (corps) => {
      const bilan = await fournisseur();
      if (!bilan.configured) {
        return { status: 409, body: { error: 'dns_not_configured', message: bilan.reason } };
      }
      let prepare;
      try {
        prepare = preparer({
          domain: corps?.domain, zone: corps?.zone, address: corps?.address,
          ...(corps?.ttl == null ? {} : { ttl: Number(corps.ttl) }),
          motif: bilan.motif,
        });
      } catch (erreur) {
        if (!(erreur instanceof DnsError)) throw erreur;
        return { status: 422, body: { error: 'dns_refused', message: erreur.message } };
      }
      try {
        const ecrit = await bilan.provider.setRecord(prepare);
        return {
          status: 200,
          body: {
            ...ecrit,
            // §38.4 : on annonce l'enregistrement ÉCRIT, jamais le domaine
            // « prêt ». La propagation prend le temps du TTL, et un cache déjà
            // chaud sert encore l'ancienne réponse.
            // Mesuré à l'écran : la bannière NOMME déjà l'enregistrement écrit,
            // et un « Enregistrement écrit. » de plus s'y répétait mot pour mot.
            // Ce champ ne porte donc que la réserve, qui est son objet.
            propagation: `La résolution peut demander jusqu'à ${prepare.ttl} secondes, `
                         + `davantage si un résolveur a déjà mis l'ancienne réponse `
                         + `en cache.`,
          },
        };
      } catch (erreur) {
        return { status: 502, body: { error: 'dns_unavailable', message: erreur.message } };
      }
    },

    /**
     * Le catalogue des recettes (SPK-50, §38.6.5).
     *
     * Il vient du CODE, jamais d'un stockage : une recette enregistrée
     * divergerait du code dès la première correction, et deux vérités
     * coexisteraient sans qu'on sache laquelle est appliquée (§38.6.1).
     */
    'GET /api/dns/recipes': async () => ({ status: 200, body: { recipes: catalogue() } }),

    /**
     * Ce que la recette ÉCRIRAIT, et l'effet de chaque ligne (§38.6.3).
     *
     * L'écran présente la recette ENTIÈRE avant d'écrire : une recette à moitié
     * posée est pire qu'une recette absente, et on ne s'en aperçoit qu'après.
     */
    'POST /api/dns/recipe/preview': async (corps) => {
      const bilan = await fournisseur();
      if (!bilan.configured) {
        return { status: 409, body: { error: 'dns_not_configured', message: bilan.reason } };
      }
      let compose;
      try {
        compose = composer(corps?.recipe, corps?.params ?? {},
                           { zone: corps?.zone, motif: bilan.motif });
      } catch (erreur) {
        if (erreur instanceof ValeurManquante) {
          return { status: 422, body: { error: 'value_required',
                                        field: erreur.champ, message: erreur.message } };
        }
        if (!(erreur instanceof DnsError)) throw erreur;
        return { status: 422, body: { error: 'dns_refused', message: erreur.message } };
      }
      try {
        const lignes = [];
        for (const record of compose.records) {
          const actuel = await bilan.provider.existant(record);
          lignes.push({
            ...record, current: actuel,
            effet: !actuel ? 'pose'
              : actuel.data === record.data ? 'inchange' : 'remplace',
          });
        }
        return { status: 200, body: { ...compose, records: lignes } };
      } catch (erreur) {
        return { status: 502, body: { error: 'dns_unavailable', message: erreur.message } };
      }
    },

    /**
     * Écrit la recette, ligne à ligne, et rend LE SORT DE CHACUNE (§38.6.3).
     *
     * Ni succès ni échec global : un « succès » sur une recette à moitié posée
     * serait le pire des mensonges possibles ici — un `MX` sans SPF fait
     * recevoir du courrier qu'on ne peut pas renvoyer.
     *
     * On n'annule PAS ce qui est passé : défaire supposerait de connaître la
     * valeur d'avant, que le produit n'a pas retenue, et le §38.2 lui interdit
     * de supprimer ce qu'il n'a pas posé.
     */
    'POST /api/dns/recipe': async (corps) => {
      const bilan = await fournisseur();
      if (!bilan.configured) {
        return { status: 409, body: { error: 'dns_not_configured', message: bilan.reason } };
      }
      let compose;
      try {
        compose = composer(corps?.recipe, corps?.params ?? {},
                           { zone: corps?.zone, motif: bilan.motif });
      } catch (erreur) {
        if (erreur instanceof ValeurManquante) {
          return { status: 422, body: { error: 'value_required',
                                        field: erreur.champ, message: erreur.message } };
        }
        if (!(erreur instanceof DnsError)) throw erreur;
        return { status: 422, body: { error: 'dns_refused', message: erreur.message } };
      }

      const resultats = [];
      for (const record of compose.records) {
        try {
          const ecrit = await bilan.provider.setRecord(record);
          resultats.push({ ...record, written: true, fqdn: ecrit.fqdn });
        } catch (erreur) {
          resultats.push({ ...record, written: false, error: erreur.message });
        }
      }
      const manquants = resultats.filter((r) => !r.written);
      return {
        status: 200,
        body: {
          ...compose,
          records: resultats,
          written: resultats.length - manquants.length,
          failed: manquants.length,
          // Une recette dont UNE seule ligne a échoué est INCOMPLÈTE, et le dit
          // en nommant ce qui manque (§38.6.3).
          incomplete: manquants.length
            ? `Recette incomplète : ${manquants.map((r) => `${r.type} ${r.name || '@'}`)
                .join(', ')} n'a pas été écrit. Ce qui est passé n'est pas défait.`
            : compose.incomplete,
          propagation: `La résolution peut demander jusqu'à `
            + `${compose.records[0]?.ttl ?? 300} secondes, davantage si un `
            + `résolveur a déjà mis l'ancienne réponse en cache.`,
        },
      };
    },

    /**
     * Ouvre une session de terminal vers un Spark (§37.4.4).
     *
     * Le Spark est relu sur `sparkd` pour obtenir son adresse privée : c'est le
     * REGISTRE qui l'attribue (§15.1), et la deviner serait se tromper de Spark.
     */
    /**
     * Le manuel, servi depuis `docs/manuel/` (§1.5 bis du design system).
     *
     * Les écrans renvoient au manuel plutôt que de porter le raisonnement. Un
     * renvoi doit donc aboutir : sans ces trois routes, la règle fabriquerait
     * des commandes mortes (§1.4).
     */
    'GET /api/manuel': async () => ({
      status: 200, body: { chapters: await manuelChapitres(RACINE_MANUEL) },
    }),

    'GET /api/manuel/chapitre': async (_corps, url) => {
      try {
        const id = url?.searchParams.get('id') ?? '';
        return { status: 200,
                 body: { id, markdown: await manuelChapitre(RACINE_MANUEL, id) } };
      } catch (erreur) {
        if (erreur instanceof ManuelError) {
          return { status: 404, body: { error: 'unknown_chapter', message: erreur.message } };
        }
        throw erreur;
      }
    },

    'GET /api/manuel/image': async (_corps, url, reponse) => {
      try {
        const { contenu, type } = await manuelImage(RACINE_MANUEL,
                                                    url?.searchParams.get('nom') ?? '');
        reponse.writeHead(200, { 'content-type': type });
        reponse.end(contenu);
        return null;   // déjà répondu : le corps est binaire, pas du JSON
      } catch (erreur) {
        if (erreur instanceof ManuelError) {
          return { status: 404, body: { error: 'unknown_image', message: erreur.message } };
        }
        throw erreur;
      }
    },

    /**
     * Pourquoi le chemin normal n'a pas abouti (§37.2, §37.3.1).
     *
     * Le §37.2 veut que l'écran DISE ce qui manque, en toutes lettres. Or un
     * Spark dont le `sshd` est muet ne produit rien d'autre qu'une ligne de
     * `ssh` et un shell qui meurt : l'exploitant lit « le shell distant s'est
     * terminé » et doit deviner.
     *
     * Cette route MESURE plutôt que de deviner, et elle mesure du dehors de la
     * session : la console ne retient aucun octet de ce qui a transité (§37.5),
     * donc elle ne peut pas — et ne doit pas — inspecter la sortie pour en
     * déduire la cause. Elle sonde le `sshd`, comme le fait le dépannage.
     *
     * Lecture pure : rien n'est ouvert, rien n'est écrit au journal (§36.7).
     */
    'GET /api/terminal/diagnostic': async (_corps, url) => {
      const nom = String(url?.searchParams.get('server') ?? '');
      const spark = String(url?.searchParams.get('spark') ?? '');
      let tunnel;
      try {
        tunnel = tunnels.require(nom);
      } catch (erreur) {
        return { status: 502, body: { error: 'tunnel_unavailable', message: erreur.message } };
      }
      const amont = await fetchFn(
        `http://127.0.0.1:${tunnel.localPort}/v1/sparks/${encodeURIComponent(spark)}`,
        { headers: { 'x-spark-actor': tunnel.actorHeader } });
      if (!amont.ok) {
        return { status: 404, body: { error: 'unknown_spark',
                                      message: `Aucun Spark « ${spark} » sur ce serveur.` } };
      }
      const decrit = await amont.json();
      // Un Spark en erreur ouvre le dépannage sans sondage : l'état suffit, et
      // sonder ferait attendre cinq secondes pour apprendre ce qu'on sait déjà.
      const sondage = decrit.state === 'error' ? null : await sonder({ tunnel, spark: decrit });
      const verdict = depannageOuvert(decrit, sondage);
      return { status: 200, body: {
        spark: decrit.name,
        // Ce que le sondage a CONSTATÉ, distinct de ce qu'on en conclut.
        sshd: sondage ? { repond: sondage.repond, motif: sondage.motif } : null,
        rescue: { ouvert: verdict.ouvert, motif: verdict.motif,
                  explication: verdict.explication },
      } };
    },

    'POST /api/terminal': async (corps) => {
      const nom = String(corps?.server ?? '');
      const spark = String(corps?.spark ?? '');
      let tunnel;
      try {
        tunnel = tunnels.require(nom);
      } catch (erreur) {
        return { status: 502, body: { error: 'tunnel_unavailable', message: erreur.message } };
      }
      const amont = await fetchFn(
        `http://127.0.0.1:${tunnel.localPort}/v1/sparks/${encodeURIComponent(spark)}`,
        { headers: { 'x-spark-actor': tunnel.actorHeader } });
      if (!amont.ok) {
        return { status: 404, body: { error: 'unknown_spark',
                                      message: `Aucun Spark « ${spark} » sur ce serveur.` } };
      }
      const decrit = await amont.json();
      // §37.2 : l'écran doit NOMMER ce qui manque, pas rendre une erreur
      // technique. Le signal est `incus_name`, renseigné SEULEMENT après une
      // application réussie — comme au §39.4. Ce n'est PAS l'adresse : elle est
      // attribuée dès l'écriture au registre (§15.1), bien avant qu'une cellule
      // existe. Mesuré : un Spark « pending » porte déjà la sienne.
      if (!decrit.incus_name || !decrit.ipv4_address) {
        return { status: 409, body: {
          error: 'spark_not_reachable',
          message: `Le Spark « ${spark} » n'a pas encore de cellule : il est `
                   + 'déclaré, ses ressources sont réservées, mais rien ne tourne '
                   + 'encore. Créez-le avant d’y ouvrir un terminal.' } };
      }
      // §37.3 : le chemin de DÉPANNAGE se contrôle ICI, pas à l'écran. C'est un
      // contrôle d'accès (CLAUDE.md §10) : masquer un bouton n'aurait été
      // qu'une aide d'interface, et la requête reste formable à la main.
      const chemin = corps?.path === CHEMIN_DEPANNAGE ? CHEMIN_DEPANNAGE : CHEMIN_SSH;
      let motifDepannage = null;
      if (chemin === CHEMIN_DEPANNAGE) {
        // Le sondage n'est fait QUE si l'état ne suffit pas : un Spark en
        // erreur ouvre le chemin sans qu'on ait à attendre cinq secondes de
        // plus pour l'apprendre.
        const sondage = decrit.state === 'error'
          ? null
          : await sonder({ tunnel, spark: decrit });
        const verdict = depannageOuvert(decrit, sondage);
        if (!verdict.ouvert) {
          return { status: 409, body: {
            error: 'rescue_refused', reason: verdict.motif,
            message: verdict.explication } };
        }
        motifDepannage = verdict.motif;
      }
      const session = terminaux.ouvrir({ tunnel, spark: decrit, chemin, motifDepannage });
      // §37.4.5 : on DÉCLARE l'ouverture. Si `sparkd` est injoignable, la
      // session s'ouvre quand même — refuser un terminal parce que le journal
      // est indisponible transformerait une panne de traçabilité en panne
      // d'exploitation, au moment précis où l'on cherche à réparer.
      //
      // §37.3 : le dépannage porte une action DISTINCTE, sans quoi un relevé du
      // journal ne pourrait pas dire combien de fois cette voie a servi.
      await declarerAudit(tunnel,
        chemin === CHEMIN_DEPANNAGE ? 'spark.rescue_exec' : 'spark.terminal_open',
        { spark: decrit.name, path: chemin, reason: motifDepannage ?? undefined });
      return { status: 201, body: session.describe() };
    },

    /** Les octets saisis. Ils traversent ; rien ne les retient (§37.5). */
    'POST /api/terminal/entree': async (corps, url) => {
      try {
        terminaux.get(String(url?.searchParams.get('id') ?? '')).ecrire(String(corps?.data ?? ''));
        return { status: 204, body: null };
      } catch (erreur) {
        if (!(erreur instanceof TerminalError)) throw erreur;
        return { status: 409, body: { error: 'session_closed', message: erreur.message } };
      }
    },

    /** Le redimensionnement, avec la limite du §37.4.3. */
    'POST /api/terminal/taille': async (corps, url) => {
      try {
        terminaux.get(String(url?.searchParams.get('id') ?? ''))
          .redimensionner(Number(corps?.rows), Number(corps?.cols));
        return { status: 204, body: null };
      } catch (erreur) {
        if (!(erreur instanceof TerminalError)) throw erreur;
        return { status: 409, body: { error: 'resize_refused', message: erreur.message } };
      }
    },

    /**
     * Fermeture par BALISE, quand la page se démonte (§37.4.2).
     *
     * `navigator.sendBeacon` ne sait que POSTer, et c'est le seul envoi qui
     * parte encore quand l'onglet se ferme — un `fetch` y serait abandonné.
     * Sans cette route, fermer l'onglet du navigateur laisserait un shell root
     * vivant jusqu'au délai d'inactivité.
     */
    'POST /api/terminal/fermeture': async (_corps, url) => {
      const id = String(url?.searchParams.get('id') ?? '');
      const session = terminaux.fermer(id, FLUX_FERME);
      if (!session) return { status: 204, body: null };
      const tunnel = tunnels.get(session.tunnel?.name ?? '') ?? session.tunnel;
      await declarerAudit(tunnel, 'spark.terminal_close', {
        spark: session.spark.name, path: 'ssh',
        reason: session.motif, duration_seconds: session.dureeSecondes() });
      return { status: 204, body: null };
    },

    /** Ferme, et TUE le distant (§37.4). */
    'DELETE /api/terminal': async (_corps, url) => {
      const id = String(url?.searchParams.get('id') ?? '');
      const session = terminaux.fermer(id);
      if (!session) {
        return { status: 404, body: { error: 'unknown_session', message: `Aucune session « ${id} ».` } };
      }
      const tunnel = tunnels.get(session.tunnel?.name ?? '') ?? session.tunnel;
      await declarerAudit(tunnel, 'spark.terminal_close', {
        spark: session.spark.name, path: 'ssh',
        reason: session.motif, duration_seconds: session.dureeSecondes() });
      return { status: 200, body: session.describe() };
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
        // Une route qui rend `null` a DÉJÀ répondu : c'est le cas d'un corps
        // binaire — une illustration du manuel — que `repondre` sérialiserait
        // en JSON.
        const rendu = await routes[cle](corps, url, reponse);
        if (rendu === null) return;
        return repondre(reponse, rendu.status, rendu.body);
      }

      // SPK-43 · §37.4.1 : le flux de sortie tient la connexion ouverte. Il ne
      // peut donc pas passer par `repondre`, qui termine la réponse.
      if (requete.method === 'GET' && url.pathname === '/api/terminal/flux') {
        return servirFlux(url, reponse, terminaux);
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

  // §37.4.2 : aucun shell ne survit à l'hôte console.
  server.on('close', () => { terminaux.fermerToutes(); tunnels.closeAll(); });
  return { server, tunnels, terminals: terminaux };
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

/**
 * Sert la sortie d'une session en flux d'évènements (§37.4.1).
 *
 * La fermeture du flux TUE la session (§37.4.2) : c'est ce qui fait qu'un onglet
 * fermé ne laisse pas un shell root derrière lui.
 */
function servirFlux(url, reponse, terminaux) {
  const id = String(url.searchParams.get('id') ?? '');
  let session;
  try {
    session = terminaux.get(id);
  } catch (erreur) {
    reponse.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    return reponse.end(JSON.stringify({ error: 'unknown_session', message: erreur.message }));
  }
  reponse.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    // Un intermédiaire qui met en tampon retiendrait la sortie du terminal
    // jusqu'à ce qu'il en ait « assez » : sur un shell, cela veut dire jamais.
    'x-accel-buffering': 'no',
  });
  // Node n'ÉMET PAS les en-têtes tant que rien n'est écrit. Sans cette poussée,
  // l'ouverture du flux ne se termine jamais côté client — mesuré : le premier
  // `fetch` restait pendu, et un `EventSource` de navigateur ferait de même.
  reponse.flushHeaders?.();
  // Un commentaire d'amorce : il ne porte aucun évènement, il prouve seulement
  // que le flux est ouvert.
  reponse.write(': ouvert\n\n');

  // MESURÉ le 2026-08-20 : un distant qui meurt AVANT que le flux soit branché
  // diffuse sa fin à zéro abonné, et `fermer()` vide ensuite la liste. L'écran
  // restait alors sur « session ouverte » indéfiniment, pour une session déjà
  // morte. Ce n'est pas un cas de laboratoire : c'est exactement ce que produit
  // un `sshd` muet, où `ssh` sort en quelques millisecondes (§37.2).
  //
  // La fin est donc REJOUÉE à l'abonnement quand elle a déjà eu lieu. Elle n'est
  // pas rediffusée à tous — seul ce flux la reçoit, et il se referme aussitôt.
  if (session.fermeA) {
    reponse.write(`event: fin\ndata: ${JSON.stringify(session.motif)}\n\n`);
    return reponse.end();
  }

  const desabonner = session.abonner((type, data) => {
    reponse.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    if (type === 'fin') reponse.end();
  });
  reponse.on('close', () => {
    desabonner();
    terminaux.fermer(id, FLUX_FERME);
  });
  return reponse;
}

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
// Racine du DÉPÔT, où vit le `.env` du poste (§38.1). Il n'est jamais servi :
// `servirStatique` ne sort pas de `RACINE`, qui est le dossier de la console.
const RACINE_DEPOT = join(RACINE, '..', '..');
// Le manuel est servi depuis sa SOURCE UNIQUE (§30). Le recopier dans la
// console en ferait une seconde version, qui divergerait.
const RACINE_MANUEL = join(RACINE_DEPOT, 'docs', 'manuel');
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
