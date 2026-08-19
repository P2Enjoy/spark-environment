/**
 * Écran d'administration du catalogue des serveurs.
 *
 * @spec docs/BACKLOG.md#SPK-41 · docs/DAT.md §22.4 (aucun secret), §22.4 bis
 *       (ce qu'on délègue à OpenSSH), §22.4 ter (le contrat), §22.4.7 bis (où
 *       vit cet écran), §22.4.7 ter (l'ordre des champs) ·
 *       docs/DESIGN_SYSTEM.md §5.4, §6.13 (états de vue), §6.14 (tableau),
 *       §6.22, §6.23 (une action destructive se confirme), §6.27 (la saisie
 *       passe par une modale) · docs/DESIGN_SYSTEM_APP.md §1
 *
 * Cette destination gère ce qui est DÉCLARÉ ; le sélecteur au-dessus du premier
 * degré choisit ce qu'on REGARDE. Deux sujets, deux surfaces.
 */

import { renderModale } from './modale.js';
import { tunnelOf } from './tokens.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Les trois genres, et ce qu'ils délèguent (§22.4.1). */
export const GENRES = {
  ssh: { label: 'SSH', aide: 'Hôte, utilisateur et port décrits ici.' },
  alias: { label: 'Alias ssh',
           aide: 'Un « Host » de votre ~/.ssh/config. OpenSSH résout l’hôte, '
               + 'l’utilisateur, le port et le rebond.' },
  local: { label: 'Local', aide: 'sparkd écoute déjà sur cette machine.' },
};

/** Ce qu'une entrée DÉSIGNE, en une ligne, sans inventer ce qu'on ignore. */
export function designation(serveur) {
  if (serveur?.kind === 'alias') return `Host « ${serveur.sshHost} »`;
  if (serveur?.kind === 'local') return `127.0.0.1:${serveur.port}`;
  return `${serveur?.user ?? ''}@${serveur?.host ?? ''}:${serveur?.port ?? ''}`;
}

export const CATALOGUE_SERVEURS_VIDE = {
  open: false, busy: false, refusal: null, confirming: null,
  probe: null, probing: false, hosts: [],
  values: { name: '', kind: 'ssh', host: '', user: 'root', port: 22,
            remotePort: 9876, sshHost: '' },
};

/**
 * Le résultat de l'épreuve, rendu DANS la modale (§22.4.4).
 *
 * Elle informe, elle ne décide pas : le bouton d'enregistrement reste actif quel
 * que soit son verdict. Exiger qu'une machine réponde reviendrait à exiger
 * qu'elle soit allumée pour qu'on note son existence.
 */
export function renderEpreuve(probe) {
  if (!probe) return '';
  if (probe.reachable) {
    return `<p class="epreuve epreuve--ok" role="status">
      <span class="badge badge--success"><span class="badge__point" aria-hidden="true"></span>Joignable</span>
      Le serveur a répondu${probe.readyz?.status === 200
        ? '.' : ` à « santé », mais « prêt » rend ${echapper(probe.readyz?.status ?? '—')}.`}</p>`;
  }
  return `<p class="epreuve epreuve--absent" role="status">
    <span class="badge badge--accent"><span class="badge__point" aria-hidden="true"></span>Sans réponse</span>
    ${echapper(probe.error ?? 'Le serveur n’a pas répondu.')}
    Vous pouvez l’enregistrer quand même : la machine est peut-être éteinte.</p>`;
}

/** Les champs, qui suivent le GENRE choisi (§22.4.7 ter). */
function champs(ui) {
  const v = ui.values;
  const commun = `
    <div class="champ">
      <label for="serveur-nom">Nom</label>
      <input class="controle" id="serveur-nom" name="name" type="text" autocomplete="off"
             value="${echapper(v.name)}">
      <p class="champ__aide">Minuscules, chiffres et tirets. C’est le nom que
      vous verrez dans le sélecteur.</p>
    </div>
    <div class="champ">
      <label for="serveur-genre">Genre</label>
      <select class="controle" id="serveur-genre" name="kind">${
        Object.entries(GENRES).map(([cle, { label }]) =>
          `<option value="${cle}"${v.kind === cle ? ' selected' : ''}>${echapper(label)}</option>`).join('')}
      </select>
      <p class="champ__aide">${echapper(GENRES[v.kind]?.aide ?? '')}</p>
    </div>`;

  if (v.kind === 'alias') {
    return `${commun}
    <div class="champ">
      <label for="serveur-alias">Host du ssh_config</label>
      <input class="controle technique" id="serveur-alias" name="sshHost" type="text"
             autocomplete="off" list="serveur-hosts" value="${echapper(v.sshHost)}">
      ${ui.hosts.length
        // On PROPOSE, on n'impose pas : un Host peut vivre dans un fichier
        // inclus que la console ne lit pas (§22.4.7 ter).
        ? `<datalist id="serveur-hosts">${ui.hosts.map((h) =>
            `<option value="${echapper(h)}"></option>`).join('')}</datalist>`
        : ''}
      <p class="champ__aide">${ui.hosts.length
        ? `${ui.hosts.length} hôte(s) trouvé(s) dans votre ~/.ssh/config. Vous pouvez aussi en saisir un autre.`
        : 'Aucun ~/.ssh/config lisible : saisissez le nom du Host.'}</p>
    </div>
    <div class="champ">
      <label for="serveur-sparkd">Port de sparkd</label>
      <input class="controle" id="serveur-sparkd" name="remotePort" type="number" min="1" max="65535"
             value="${echapper(v.remotePort)}">
      <p class="champ__aide">OpenSSH ne le connaît pas : c’est le produit qui sait
      où sparkd écoute à l’autre bout.</p>
    </div>`;
  }
  if (v.kind === 'local') {
    return `${commun}
    <div class="champ">
      <label for="serveur-port-local">Port de sparkd</label>
      <input class="controle" id="serveur-port-local" name="port" type="number" min="1" max="65535"
             value="${echapper(v.port)}">
    </div>`;
  }
  return `${commun}
    <div class="champ">
      <label for="serveur-hote">Hôte</label>
      <input class="controle technique" id="serveur-hote" name="host" type="text"
             autocomplete="off" value="${echapper(v.host)}">
    </div>
    <div class="champ">
      <label for="serveur-utilisateur">Utilisateur</label>
      <input class="controle" id="serveur-utilisateur" name="user" type="text"
             autocomplete="off" value="${echapper(v.user)}">
    </div>
    <div class="champ">
      <label for="serveur-port">Port SSH</label>
      <input class="controle" id="serveur-port" name="port" type="number" min="1" max="65535"
             value="${echapper(v.port)}">
    </div>
    <div class="champ">
      <label for="serveur-sparkd-ssh">Port de sparkd</label>
      <input class="controle" id="serveur-sparkd-ssh" name="remotePort" type="number" min="1" max="65535"
             value="${echapper(v.remotePort)}">
    </div>`;
}

function ligne(serveur, courant, tunnels, ui) {
  const tunnel = tunnels.find((t) => t.name === serveur.name);
  const { label, token } = tunnelOf(tunnel?.state ?? 'closed');
  const estCourant = serveur.name === courant;

  const confirme = ui.confirming === serveur.name
    ? `<tr><td colspan="5">
       <div class="confirmation" role="group" aria-label="Confirmer le retrait">
         <p><strong>Retirer « ${echapper(serveur.name)} » de la console ?</strong></p>
         <p class="confirmation__consequence">Son tunnel sera fermé et la
         déclaration effacée. Le serveur lui-même n’est pas touché — ni ses
         Sparks, ni ses données.</p>
         <p class="confirmation__actions">
           <button type="button" class="bouton bouton--destructif" data-confirme-serveur="${echapper(serveur.name)}">Retirer de la console</button>
           <button type="button" class="bouton" data-annule-serveur="1">Annuler</button>
         </p>
       </div></td></tr>`
    : '';

  return `<tr${estCourant ? ' class="ligne--courante"' : ''}>
  <td class="cellule-nom">${echapper(serveur.name)}${
    estCourant ? ' <span class="badge badge--neutral">courant</span>' : ''}</td>
  <td>${echapper(GENRES[serveur.kind]?.label ?? serveur.kind)}</td>
  <td class="technique cellule-dense" title="${echapper(designation(serveur))}">${
    echapper(designation(serveur))}</td>
  <td><span class="badge badge--${token}"><span class="badge__point" aria-hidden="true"></span>${echapper(label)}</span></td>
  <td><span class="actions-ligne">${estCourant ? '' :
      `<button type="button" class="bouton bouton--compact" data-bascule="${echapper(serveur.name)}">Regarder</button>`}
    <button type="button" class="bouton bouton--compact" data-retire-serveur="${echapper(serveur.name)}">Retirer</button></span></td>
</tr>${confirme}`;
}

/** Vue complète. §6.13 : chargement, vide et erreur sont traités. */
export function renderServeurs({ status = 'loading', servers = [], tunnels = [],
                                 current = null, error = null,
                                 ui = CATALOGUE_SERVEURS_VIDE } = {}) {
  const entete = `
<header class="entete-entite">
  <div class="entete-entite__identite"><h1>Serveurs</h1></div>
  <p class="note">Les serveurs que cette console sait administrer. La liste vit
  sur ce poste et ne contient <strong>aucun secret</strong> : l’authentification
  appartient à votre configuration SSH.</p>
</header>`;

  if (status === 'loading') {
    return `${entete}<div class="carte bloc" aria-busy="true">
      <p class="sr-only" role="status">Chargement du catalogue…</p>
      ${Array.from({ length: 3 }, (_, i) =>
        `<span class="squelette" style="display:block;width:${70 - i * 9}%;margin-bottom:var(--space-3)"></span>`).join('')}
    </div>`;
  }
  if (status === 'error') {
    return `${entete}<div class="carte"><div class="etat-vue etat-vue--erreur" role="alert">
      <h2>Le catalogue n’a pas pu être lu</h2>
      <p>${echapper(error?.message ?? 'Cause inconnue.')}</p>
    </div></div>`;
  }

  const modale = renderModale({
    ouverte: Boolean(ui.open), id: 'serveur', titre: 'Serveurs',
    engagement: 'Enregistrer ce serveur',
    refus: ui.refusal, occupee: ui.busy,
    corps: `${champs(ui)}
      ${renderEpreuve(ui.probe)}
      <p class="formulaire__actions">
        <button type="button" class="bouton" data-action="eprouver" ${ui.probing ? 'disabled' : ''}>${
          ui.probing ? 'Épreuve…' : 'Éprouver la connexion'}</button>
      </p>`,
  });

  const corps = servers.length
    ? `<div class="tableau-enveloppe">
    <p class="tableau-indice">Le tableau défile horizontalement.</p>
    <table>
      <thead><tr>
        <th scope="col">Nom</th><th scope="col">Genre</th>
        <th scope="col">Ce qu’il désigne</th><th scope="col">Tunnel</th>
        <th scope="col">Actions</th>
      </tr></thead>
      <tbody>${servers.map((s) => ligne(s, current, tunnels, ui)).join('')}</tbody>
    </table>
  </div>`
    // §6.13 : ici l'action EST pertinente — c'est le seul écran d'où l'on peut
    // déclarer un serveur, et sans serveur la console ne montre rien.
    : `<div class="etat-vue">
      <h2>Aucun serveur enregistré</h2>
      <p>La console n’a rien à administrer tant qu’aucun serveur n’est déclaré.</p>
      <p style="margin-top:var(--space-4)"><button type="button" class="bouton bouton--primaire" data-ouvre="serveur">Ajouter un serveur</button></p>
    </div>`;

  return `${entete}
<section class="carte bloc" aria-labelledby="titre-serveurs">
  <h2 id="titre-serveurs">Catalogue</h2>
  ${corps}
  ${servers.length
    ? `<p class="formulaire__actions"><button type="button" class="bouton" data-ouvre="serveur">Ajouter un serveur</button></p>`
    : ''}
  ${modale}
</section>`;
}
