/**
 * Le dossier de déploiement d'un Spark, à coller à un agent.
 *
 * @spec docs/BACKLOG.md#SPK-85 · docs/DAT.md §44.9 (le dossier), §44.9.5 (ce
 *       que la console en fait), §44.9.3 (ce qu'il ne porte jamais) ·
 *       docs/DESIGN_SYSTEM_APP.md SPK-DS-19 (un texte fait pour être collé),
 *       SPK-DS-18 (une sortie garde ses lignes et se replie) ·
 *       docs/DESIGN_SYSTEM.md §6.27 (l'affichage d'une information mérite une
 *       section, pas une modale), §1.3 (pas de succès simulé), §14.5 (l'absence
 *       se nomme), §14.6 (trois états distincts)
 *
 * La console **ne compose pas** ce texte : le runtime le rend depuis l'unique
 * modèle de briefing (§44.8), et cet écran le montre et le copie. Le fabriquer
 * ici créerait une troisième vérité à côté du JSON et du Markdown posés dans la
 * cellule — exactement ce que le §44.8 interdit entre les deux premières.
 */

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * L'état de la section. `status` vaut « vide » tant que rien n'a été demandé :
 * §14.6 — « pas encore composé » n'est ni « rien à dire » ni « en panne ».
 */
export const DOSSIER_VIDE = {
  status: 'vide',   // 'vide' | 'chargement' | 'pret' | 'absent' | 'erreur'
  texte: null,
  ecritLe: null,
  amorce: false,    // le relevé d'amorçage existe-t-il ?
  message: null,    // le motif, quand il n'y a pas de dossier
  copie: null,      // { ok, message } — jamais avant l'accord du presse-papier
  // Le repli est un état de l'ÉCRAN, pas du texte. Sans lui, chaque repeinture
  // referme ce que l'exploitant venait d'ouvrir — mesuré en capturant la copie :
  // on déplie pour vérifier, on copie, et le texte disparaît (§14.3).
  deplie: false,
};

/** Ce que la section annonce avant qu'on copie (SPK-DS-19). */
const ANNONCE = `Ce texte décrit la cellule telle que le plan de contrôle la
  connaît : accès SSH par rebond, quotas, distribution et architecture relevées,
  moteur Docker, noms des variables et des secrets, ports attendus par les routes
  et pièges connus. <strong>Aucune valeur de secret n’y figure</strong>, ni aucune
  clé privée.`;

/**
 * Par où le poste saute vers la Forge courante (SPK-85, docs/DAT.md §44.9.2).
 *
 * Le plan de contrôle ne le sait PAS : cette information vit dans l'inventaire
 * du poste, et c'est la console qui la lui donne. Trois genres, trois réponses,
 * et aucune n'est devinée :
 *
 * - `ssh` : le compte et l'hôte que la console emploie, avec le port quand il
 *   n'est pas celui par défaut. `-J` accepte exactement cette forme ;
 * - `alias` : le `Host` du `ssh_config`, qui porte déjà tout — le §22.4 bis
 *   interdit précisément de deviner ce qu'il contient ;
 * - `local` : la console est servie SUR la Forge. Il n'y a rien à sauter, et le
 *   dossier rend alors une commande directe.
 */
export function rebondDuServeur(serveur) {
  if (!serveur) return {};
  if (serveur.kind === 'local') return { direct: true };
  if (serveur.kind === 'alias') {
    return serveur.sshHost ? { jump: serveur.sshHost } : {};
  }
  if (!serveur.host) return {};
  const compte = serveur.user ? `${serveur.user}@` : '';
  const port = serveur.port && Number(serveur.port) !== 22 ? `:${serveur.port}` : '';
  return { jump: `${compte}${serveur.host}${port}` };
}

/**
 * La section « Dossier pour un agent ».
 *
 * Quatre états, quatre textes (§6.13, §14.6). L'absence de relevé d'amorçage
 * n'empêche pas le dossier : elle en change le contenu, et le dossier le dit
 * lui-même — la console n'a donc pas à le répéter à sa place.
 */
export function renderDossier(spark, etat = DOSSIER_VIDE) {
  const entete = `<h2 id="titre-dossier">Dossier pour un agent</h2>
    <p class="note">${ANNONCE}
    <a href="#/manuel/M8">Manuel M8 — Exploiter au quotidien</a></p>`;

  if (etat.status === 'vide' || etat.status === 'chargement') {
    return `<section class="carte bloc" aria-labelledby="titre-dossier" aria-busy="true">
      ${entete}
      <p class="absence" role="status">Composition du dossier…</p>
    </section>`;
  }

  if (etat.status === 'absent') {
    // §14.5 : l'absence est un fait, et celui-ci a un remède connu — créer la
    // cellule. Le taire ferait chercher une panne.
    return `<section class="carte bloc" aria-labelledby="titre-dossier">
      ${entete}
      <p class="absence">${echapper(etat.message
        || 'Ce Spark n’a pas encore de cellule : il n’y a pas encore de déploiement à préparer.')}</p>
    </section>`;
  }

  if (etat.status === 'erreur' || !etat.texte) {
    return `<section class="carte bloc" aria-labelledby="titre-dossier">
      ${entete}
      <div class="refus" role="alert"><p>${echapper(etat.message
        || 'Le dossier n’a pas pu être lu.')}</p></div>
    </section>`;
  }

  // §14.6 : un Spark jamais amorcé a un dossier, mais amputé de ce que seul
  // l'amorçage relève. Le dire ICI évite de croire à un relevé silencieux.
  const jamaisAmorce = etat.amorce
    ? ''
    : `<p class="avertissement" role="status">Ce Spark n’a jamais été amorcé : le
       dossier ne porte ni distribution, ni architecture, ni version de Docker.
       Amorcez-le pour que ces relevés y figurent.</p>`;

  return `<section class="carte bloc dossier" aria-labelledby="titre-dossier">
  ${entete}
  ${jamaisAmorce}
  <p class="formulaire__actions">
    <button type="button" class="bouton bouton--primaire" data-dossier-copie>
      Copier pour un LLM</button>
  </p>
  ${etat.copie
    // §1.3 : « Copié » n'apparaît qu'APRÈS l'accord du presse-papier, et le
    // refus renvoie au texte, qui reste sélectionnable juste dessous.
    ? `<p class="${etat.copie.ok ? 'succes' : 'avertissement'}" role="status">${
        echapper(etat.copie.message)}</p>`
    : ''}
  <details class="repli"${etat.deplie ? ' open' : ''}>
    <summary>Lire le texte avant de le coller</summary>
    <pre class="fragment technique dossier__texte" tabindex="0"
      aria-label="Dossier de déploiement de ce Spark">${echapper(etat.texte)}</pre>
  </details>
  ${etat.ecritLe
    ? `<p class="note">Relevé écrit le
       <span class="technique">${echapper(etat.ecritLe)}</span>. Il décrit l’état
       connu du plan de contrôle, pas ce que la cellule est devenue depuis.</p>`
    : ''}
</section>`;
}
