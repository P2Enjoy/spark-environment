/**
 * Modale limitée à une section.
 *
 * @spec docs/BACKLOG.md#SPK-33 · docs/DESIGN_SYSTEM.md §6.27 (fenêtre, sections,
 *       et modale limitée à une section), §5.4 (ce qu'on affiche et ce qu'on
 *       saisit ne partagent pas la même surface), §6.22 (une confirmation reste
 *       dans le flux), §9.1 (clavier) · docs/DAT.md §34.2
 *
 * Une fenêtre **montre** ; une modale **recueille**. Un écran qui mélange les
 * deux ne dit plus ce qui fait foi.
 *
 * Une modale est chère — voile, piège de focus, `Échap`, restitution du focus.
 * Ce prix se paie pour recueillir une saisie, jamais pour afficher une
 * information. Le composant est donc **unique** : ce qui était trois exceptions
 * à écrire devient une seule surface, et son contrat est tenu à un seul endroit.
 */

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Rend la modale, ou rien.
 *
 * `titre` est le **titre de la section** : c'est le nom accessible qu'exige le
 * §6.27, et c'est ce qui borne la portée — une modale ouverte depuis « Routes »
 * ne touche que les routes.
 *
 * `engagement` nomme l'action. Un bouton « Enregistrer » ne dit pas ce qu'il
 * couvre ; « Déclarer la route » le dit.
 */
export function renderModale({ ouverte = false, id = 'modale', titre = '',
                               corps = '', engagement = 'Enregistrer',
                               refus = null, occupee = false } = {}) {
  if (!ouverte) return '';
  return `
<dialog class="modale" id="${echapper(id)}" aria-labelledby="${echapper(id)}-titre">
  <form method="dialog" class="modale__cadre" data-modale="${echapper(id)}">
    <h2 class="modale__titre" id="${echapper(id)}-titre">${echapper(titre)}</h2>
    <div class="modale__corps">${corps}</div>
    ${refus
      // Un refus s'affiche DANS la modale, près du bouton d'engagement. Une
      // modale qui se refermerait sur un refus ferait perdre la saisie et
      // cacherait la raison.
      ? `<div class="refus" role="alert"><p><strong>${echapper(refus)}</strong></p></div>`
      : ''}
    <p class="modale__actions">
      <button type="submit" class="bouton bouton--primaire" data-engage="${echapper(id)}"
        ${occupee ? 'disabled' : ''}>${echapper(occupee ? 'Envoi…' : engagement)}</button>
      <button type="button" class="bouton" data-annule-modale="${echapper(id)}">Annuler</button>
    </p>
  </form>
</dialog>`;
}

/**
 * Applique le contrat du §6.27 à la modale présente dans `racine`.
 *
 * Le contrat n'est pas décoratif : sans piège de focus, la tabulation sort de la
 * modale et l'utilisateur se retrouve à saisir dans une surface qu'il croit
 * inerte. `dialog.showModal()` fournit nativement le piège, l'inertie de
 * l'arrière-plan et `Échap` ; ce qui reste à notre charge est ce que le natif ne
 * fait pas : entrer le focus dans le premier contrôle, et le rendre au
 * déclencheur à la fermeture.
 *
 * Le déclencheur est retrouvé par son **identifiant**, jamais par
 * `document.activeElement` : la fermeture repeint la surface, et l'élément qui
 * avait le focus est alors détaché du document. Mesuré — le focus retombait sur
 * `body` et le contrat du §6.27 n'était pas tenu.
 *
 * Rend une fonction de nettoyage, ou `null` s'il n'y a pas de modale.
 */
export function brancherModale(racine, { onFermer } = {}) {
  const dialogue = racine.querySelector('dialog.modale');
  if (!dialogue) return null;
  const id = dialogue.id;

  if (!dialogue.open) {
    if (typeof dialogue.showModal === 'function') dialogue.showModal();
    else {
      // Repli si `dialog` n'est pas gréé : la sémantique doit tenir quand même.
      dialogue.setAttribute('role', 'dialog');
      dialogue.setAttribute('aria-modal', 'true');
      dialogue.setAttribute('open', '');
    }
  }

  // Le focus entre dans le premier contrôle MODIFIABLE, pas sur le bouton
  // d'engagement : ouvrir une modale, c'est commencer à saisir.
  //
  // Les contrôles en lecture seule sont sautés. Mesuré sur la modale de
  // modification d'un serveur, dont le premier champ est le nom, non
  // modifiable (docs/DAT.md §22.4.7 ter) : le curseur y entrait, et la saisie
  // commençait donc là où elle est impossible.
  const premier = dialogue.querySelector(
    'input:not([readonly]):not([disabled]), select:not([disabled]),'
    + ' textarea:not([readonly]):not([disabled])');
  (premier ?? dialogue.querySelector('button'))?.focus();

  // `Échap` ferme, et la fermeture ÉQUIVAUT À UNE ANNULATION (§6.27).
  const fermer = () => {
    if (dialogue.open && typeof dialogue.close === 'function') dialogue.close();
    // La surface est repeinte, PUIS le focus est rendu : l'inverse le poserait
    // sur un élément que le rendu suivant remplace.
    onFermer?.(id);
    racine.querySelector(`[data-ouvre="${id}"]`)?.focus();
  };
  const surCancel = (evenement) => { evenement.preventDefault(); fermer(); };
  dialogue.addEventListener('cancel', surCancel);

  const surAnnule = () => fermer();
  dialogue.querySelector('[data-annule-modale]')?.addEventListener('click', surAnnule);

  return () => {
    dialogue.removeEventListener('cancel', surCancel);
  };
}
