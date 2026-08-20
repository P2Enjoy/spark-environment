/**
 * Le terminal d'un Spark : une surface d'interaction continue.
 *
 * @spec docs/BACKLOG.md#SPK-43 · docs/DAT.md §37.1 (la console parle au Spark),
 *       §37.2 (le chemin normal, et ce qu'il suppose : un `sshd` DANS le Spark),
 *       §37.4 (le contrat), §37.4.1 (le transport), §37.4.3 (la limite du
 *       redimensionnement) · docs/DESIGN_SYSTEM_APP.md SPK-DS-04 ·
 *       docs/DESIGN_SYSTEM.md §6.13 (les états d'une vue), §14.7
 *
 * SPK-DS-04 : ce n'est ni une section ni une modale. Pas de point d'engagement,
 * donc pas de modale ; pas de paires terme/valeur, donc pas de section. C'est
 * une DESTINATION, et l'état protégé comme le chemin employé restent affichés
 * pendant toute la session, pas seulement à l'ouverture.
 */

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** État de l'écran. Les octets ne vivent PAS ici : voir `TERMINAL_VIDE.lignes`. */
export const TERMINAL_VIDE = {
  status: 'ferme',      // 'ferme' | 'ouverture' | 'ouvert' | 'refus'
  session: null,        // { id, path }
  refus: null,          // { error, message }
  avertissement: null,  // l'avis d'inactivité (§37.4.2)
  fin: null,            // le motif de fermeture
  lecteurEcran: false,  // SPK-DS-04 : activable, et son réglage persiste
};

/**
 * Ce que la console garde à l'écran : les octets reçus, et rien de plus.
 *
 * Ils vivent dans le DOM du terminal, pas dans l'état — un tampon d'historique
 * dans l'état serait sérialisé, et le §37.5 interdit qu'un octet de session
 * quitte l'écran.
 */
export const CHAMP_TERMINAL = 'terminal-sortie';

/** Les motifs de fermeture, dits en français (§14.7). */
const FINS = {
  sortie: 'Session fermée.',
  inactivite: "Session fermée faute d'activité.",
  flux_ferme: 'Session fermée : la connexion a été interrompue.',
  distant_termine: 'Le shell distant s’est terminé.',
};

export function renderTerminal(spark, etat = TERMINAL_VIDE) {
  if (!spark) return '';

  // §37.2 : un Spark sans adresse n'a rien où se connecter. L'écran NOMME ce qui
  // manque — il n'affiche ni onglet vide, ni erreur technique.
  const refus = etat.status === 'refus' && etat.refus
    ? `<div class="carte bloc">
         <h2 id="titre-terminal">Terminal</h2>
         <p class="refus">${echapper(etat.refus.message)}</p>
         ${etat.refus.error === 'spark_not_reachable'
           ? `<p class="note">Un Spark doit être <strong>créé</strong> avant qu’on
              puisse y entrer. Ses ressources sont déjà réservées et son adresse
              attribuée, mais aucune cellule ne tourne encore.</p>`
           : ''}
       </div>`
    : '';
  if (refus) return refus;

  // SPK-DS-04 : l'état protégé et le chemin employé restent affichés PENDANT
  // toute la session. Les montrer à l'ouverture seulement laisserait oublier par
  // quel chemin on est entré.
  const bandeau = `<p class="bandeau-terminal">
      <span class="badge badge--neutral">${echapper(etat.session?.path ?? 'ssh')}</span>
      ${spark.protected
        ? '<span class="badge badge--accent"><span class="badge__point" aria-hidden="true"></span>Spark protégé</span>'
        : ''}
      <span class="note">Quitter cet onglet <strong>termine</strong> la session.</span>
    </p>`;

  const commandes = etat.status === 'ouvert'
    ? `<p class="formulaire__actions">
         <button type="button" class="bouton" data-terminal="fermer">Fermer la session</button>
         <label class="note" for="terminal-lecteur">
           <input type="checkbox" id="terminal-lecteur" data-terminal="lecteur"
                  ${etat.lecteurEcran ? 'checked' : ''}>
           Mode lecteur d’écran
         </label>
       </p>`
    : `<p class="formulaire__actions">
         <button type="button" class="bouton bouton--primaire" data-terminal="ouvrir"
                 ${etat.status === 'ouverture' ? 'disabled' : ''}>
           ${etat.status === 'ouverture' ? 'Ouverture…' : 'Ouvrir un terminal'}
         </button>
       </p>`;

  const avis = etat.avertissement
    ? `<p class="avertissement" role="status">${echapper(etat.avertissement)}</p>`
    : '';
  const fin = etat.fin
    ? `<p class="note-transitoire" role="status">${echapper(FINS[etat.fin] ?? etat.fin)}</p>`
    : '';

  // Le mode lecteur d'écran fait du terminal une région annoncée : sans lui, la
  // sortie défile sans qu'aucune synthèse vocale ne la lise (SPK-DS-04).
  const region = etat.lecteurEcran
    ? ' role="log" aria-live="polite" aria-label="Sortie du terminal"'
    : ' role="region" aria-label="Sortie du terminal"';

  return `
<section class="carte bloc" aria-labelledby="titre-terminal">
  <h2 id="titre-terminal">Terminal</h2>
  ${bandeau}
  ${avis}${fin}
  <pre class="terminal" id="${CHAMP_TERMINAL}" tabindex="0"${region}></pre>
  <label class="sr-only" for="terminal-entree">Saisie du terminal</label>
  <input class="controle technique" id="terminal-entree" type="text" autocomplete="off"
         spellcheck="false" placeholder="Tapez une commande, Entrée pour l’envoyer"
         ${etat.status === 'ouvert' ? '' : 'disabled'}>
  <p class="champ__aide">Redimensionner la fenêtre propage la taille au Spark.
  Un programme plein écran <strong>déjà lancé</strong> ne s’en apercevra pas : il
  faut le relancer.</p>
  ${commandes}
</section>`;
}
