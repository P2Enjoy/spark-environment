/**
 * Découverte des `Host` du `~/.ssh/config`, et épreuve d'un serveur.
 *
 * @spec docs/BACKLOG.md#SPK-41 · docs/DAT.md §22.4 bis (ce que le catalogue
 *       délègue à OpenSSH), §22.4.3, §22.4.4 (l'épreuve informe, elle ne décide
 *       pas), §25.1
 *
 * Deux gestes qui ont la même règle : ils RENSEIGNENT. La découverte propose des
 * candidats sans en ajouter aucun, l'épreuve dit ce qu'elle a vu sans conditionner
 * l'enregistrement. Un produit qui déciderait à partir de l'un ou l'autre se
 * tromperait dès que la machine visée est simplement éteinte.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SSH_CONFIG =
  process.env.SPARK_SSH_CONFIG ?? join(homedir(), '.ssh', 'config');

/**
 * Les `Host` déclarés, sans les motifs.
 *
 * Un `Host *` ou `Host *.interne` ne désigne aucune machine : ce sont des
 * réglages par défaut, et les proposer comme serveurs ferait choisir un candidat
 * qui ne se connecte à rien.
 *
 * Une lecture impossible rend une liste vide, jamais une erreur : le
 * `~/.ssh/config` est facultatif, et refuser d'afficher le formulaire d'ajout
 * parce qu'il manque serait absurde.
 */
export async function parseSshConfig(texte) {
  const hotes = [];
  for (const ligne of String(texte ?? '').split('\n')) {
    const trouve = /^\s*Host\s+(.+?)\s*$/i.exec(ligne);
    if (!trouve) continue;
    for (const nom of trouve[1].split(/\s+/)) {
      if (!nom || nom.includes('*') || nom.includes('?') || nom.startsWith('!')) continue;
      if (!hotes.includes(nom)) hotes.push(nom);
    }
  }
  return hotes;
}

export async function sshHosts(path = SSH_CONFIG) {
  try {
    return await parseSshConfig(await readFile(path, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Ouvre un tunnel TEMPORAIRE, appelle `/healthz` puis `/readyz` À TRAVERS LUI,
 * et referme (§22.4.4).
 *
 * Le tunnel est refermé dans TOUS les cas, y compris en échec : une épreuve qui
 * laisserait un `ssh` derrière elle transformerait un diagnostic en fuite de
 * processus.
 *
 * Le nom employé est préfixé et ne peut pas entrer en collision avec un tunnel
 * réel : éprouver un serveur ne doit pas fermer celui qu'on regarde.
 */
export async function probeServer(serveur, { tunnels, fetch: fetchFn = fetch } = {}) {
  const nom = `probe:${serveur.name}`;
  const bilan = { reachable: false, healthz: null, readyz: null, error: null };
  let tunnel = null;
  try {
    tunnel = await tunnels.open({ ...serveur, name: nom });
    const base = `http://127.0.0.1:${tunnel.localPort}`;
    for (const sonde of ['healthz', 'readyz']) {
      const reponse = await fetchFn(`${base}/${sonde}`);
      bilan[sonde] = { status: reponse.status,
                       body: await reponse.json().catch(() => null) };
    }
    // « Joignable » veut dire que `sparkd` a répondu, pas qu'il est prêt : un
    // `readyz` dégradé reste une réponse, et la distinguer d'un silence est
    // exactement ce que l'exploitant vient chercher.
    bilan.reachable = bilan.healthz?.status === 200;
  } catch (erreur) {
    bilan.error = erreur.message;
  } finally {
    tunnels.close(nom);
  }
  return bilan;
}
