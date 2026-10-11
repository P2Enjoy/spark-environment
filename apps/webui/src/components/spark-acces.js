/**
 * Les commandes SSH d'un Spark, prêtes à copier, dans la section Accès.
 *
 * @spec docs/BACKLOG.md#SPK-154 · docs/DAT.md §44.9.8 (le bloc « Se connecter en
 *       SSH », la propriété `ssh_commands`), §42.2 quater (les portes) ·
 *       docs/DESIGN_SYSTEM_APP.md SPK-DS-42 (une commande d'une ligne se montre,
 *       avec son bouton), SPK-DS-21, SPK-DS-24 (l'absence de seconde porte se
 *       nomme), SPK-DS-19 (la copie) · docs/DESIGN_SYSTEM.md §1.3 (pas de succès
 *       simulé), §1.4 (pas de commande morte), §1.5 bis (le manuel explique),
 *       §6.19 (une liste plate), §14.5, §14.6 (les états avant la réponse)
 *
 * La console **ne compose pas** ces lignes : sparkd les rend toutes faites avec
 * le dossier (§44.8), et cet écran les montre et les copie. Une ligne composée
 * ici à partir des comptes serait une troisième vérité, et la commande copiée
 * depuis l'écran pourrait différer de celle que reçoit l'agent.
 */

import { phrasePorteUnique } from './spark-terminal.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const TITRE = '<h3 id="titre-connexion-ssh">Se connecter en SSH</h3>';

/** §1.5 bis : la clé à accorder, le rebond et le choix de la porte vivent au
 *  manuel. L'écran nomme ; le renvoi remplace le paragraphe. */
const RENVOI = `<p class="note">Il faut une clé autorisée dans l’onglet
  <em>Clés</em>. <a href="#/manuel/M6">Manuel M6 — Se connecter</a></p>`;

/** Une porte : son compte, son rôle court, sa commande et le bouton qui la copie. */
function lignePorte(porte, copie) {
  const user = echapper(porte.user);
  // SPK-DS-42 : « copiée » sous la ligne copiée SEULEMENT. Deux messages à
  // l'écran mentiraient sur l'une des deux lignes.
  const message = copie && copie.user === porte.user
    ? `<p class="${copie.ok ? 'succes' : 'avertissement'}" role="status">${
        echapper(copie.message)}</p>`
    : '';
  return `<li class="commande-ssh">
    <p class="commande-ssh__porte"><strong class="technique">${user}</strong> — ${
      echapper(porte.role)}</p>
    <pre class="fragment technique commande-ssh__ligne" tabindex="0"
      aria-label="Commande SSH de ${user}">${echapper(porte.command)}</pre>
    <button type="button" class="bouton bouton--compact" data-ssh-copie="${user}"
      aria-label="Copier la commande SSH de ${user}">Copier</button>
    ${message}
  </li>`;
}

/**
 * Le bloc « Se connecter en SSH », d'après la réponse du dossier (§44.9.8).
 *
 * `dossier` est l'état de `spark-dossier.js` : le bloc lit la MÊME réponse,
 * déjà chargée avec le détail — aucune requête de plus, et la copie reste dans
 * l'activation du geste.
 */
export function renderConnexionSsh(spark, dossier) {
  const etat = dossier ?? {};
  if (etat.status === 'vide' || etat.status === 'chargement') {
    return `<div class="connexion-ssh" aria-busy="true">${TITRE}
      <p class="absence" role="status">Composition des commandes…</p></div>`;
  }
  if (etat.status === 'absent') {
    return `<div class="connexion-ssh">${TITRE}
      <p class="absence">Ce Spark n’a pas encore de cellule : il n’y a pas encore
      de porte où entrer.</p></div>`;
  }
  const portes = Array.isArray(etat.ssh) ? etat.ssh : [];
  if (etat.status === 'erreur' || !portes.length) {
    return `<div class="connexion-ssh">${TITRE}
      <div class="refus" role="alert"><p>${echapper(etat.message
        || 'Les commandes SSH n’ont pas pu être lues.')}</p></div></div>`;
  }

  const composees = portes.filter((porte) => porte.command);
  // §1.4 : sans commande, pas de ligne vide ni de bouton qui copierait rien.
  // La phrase dit pourquoi, et renvoie au fragment qui reste valable.
  const corps = composees.length
    ? `<ul class="liste-administrable commandes-ssh"
         aria-labelledby="titre-connexion-ssh">${
         composees.map((porte) => lignePorte(porte, etat.copieSsh)).join('')}</ul>`
    : `<p class="avertissement">La commande n’a pas pu être composée : la console
       ne sait pas par où sauter vers cette Forge, ou ce Spark n’a pas encore
       d’adresse. Le fragment de l’onglet <em>Clés</em> reste valable une fois
       l’alias de rebond défini sur votre poste.</p>`;

  // SPK-DS-21, SPK-DS-24 : l'absence de seconde porte se nomme UNE fois, avec
  // les mots du terminal — la même fonction les rend aux deux endroits.
  const porteUnique = portes.length === 1
    ? `<p class="note">${phrasePorteUnique(spark, etat.modeDocker)}</p>`
    : '';

  return `<div class="connexion-ssh">${TITRE}${corps}${porteUnique}${RENVOI}</div>`;
}
