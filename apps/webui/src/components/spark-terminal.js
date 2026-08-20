/**
 * Le terminal d'un Spark : une surface d'interaction continue.
 *
 * @spec docs/BACKLOG.md#SPK-43 · docs/DAT.md §37.1 (la console parle au Spark),
 *       §37.2 (le chemin normal, et ce qu'il suppose : un `sshd` DANS le Spark),
 *       §37.3 (le dépannage : borné, confirmé, nommé, journalisé à part),
 *       §37.4 (le contrat), §37.4.1 (le transport), §37.4.3 (la limite du
 *       redimensionnement) · docs/DESIGN_SYSTEM_APP.md SPK-DS-04 ·
 *       docs/DESIGN_SYSTEM.md §6.13 (les états d'une vue), §6.22 (confirmation
 *       dans le flux), §6.23 (une action sensible se confirme), §9.8 (jamais la
 *       couleur seule), §14.7, §14.9 (le backend est l'autorité)
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
  session: null,        // { id, path, rescueReason }
  refus: null,          // { error, reason, message }
  avertissement: null,  // l'avis d'inactivité (§37.4.2)
  fin: null,            // le motif de fermeture
  lecteurEcran: false,  // SPK-DS-04 : activable, et son réglage persiste
  // §37.3 : le dépannage se CONFIRME, et la confirmation nomme le pouvoir
  // employé. Elle est rendue dans le flux (§6.22) : une modale imposerait un
  // voile et un piège de focus pour afficher trois lignes et deux boutons.
  confirmeDepannage: false,
  // §37.2 : quand le chemin normal n'aboutit pas, l'écran doit DIRE ce qui
  // manque. Il ne peut pas le lire dans la sortie — la console n'en retient rien
  // (§37.5) —, alors il le fait MESURER. Trois valeurs, et elles ne se
  // confondent pas (§6.13, §14.6) : `null` = pas de mesure demandée,
  // `'en-cours'` = mesure lancée, objet = verdict rendu.
  diagnostic: null,
};

/**
 * Les deux chemins d'entrée, tels que l'écran les nomme (§37.2, §37.3).
 *
 * Le libellé de la PASTILLE est court, et le pouvoir employé est nommé à côté
 * d'elle, en prose. Ce découpage n'est pas cosmétique : une pastille est
 * `white-space: nowrap` (§6.8), et une phrase entière y débordait de sa carte
 * sous 390 px — MESURÉ, capture `81-terminal-depannage-mobile.png` du
 * 2026-08-20. Le §37.3 veut le chemin lisible pendant toute la session ; un
 * libellé coupé au tiers ne l'est pas, et le §8.1 interdit par ailleurs que la
 * page déborde horizontalement.
 */
export const CHEMINS = {
  ssh: { pastille: 'SSH', token: 'neutral', nomme: null },
  rescue: {
    pastille: 'Dépannage', token: 'danger',
    nomme: 'exécution en root dans la cellule, depuis le plan de contrôle',
  },
  // SPK-45 · §37.4.7 : on n'est plus dans la cellule mais DANS un conteneur du
  // locataire. Le taire ferait croire qu'on pilote le Spark, et une commande
  // tapée là ne produit pas les mêmes effets — ni sur les mêmes fichiers.
  container: {
    pastille: 'Conteneur', token: 'accent',
    nomme: 'shell dans un conteneur, pas dans le Spark',
  },
};

/** Pourquoi le dépannage a été ouvert. Il entre au journal, et se lit ici. */
const MOTIFS_DEPANNAGE = {
  spark_en_erreur: 'ce Spark est en erreur',
  sshd_muet: 'rien ne répond sur son port 22',
};

/**
 * Ce que le diagnostic a constaté, dit à l'exploitant (§37.2, §37.3.1).
 *
 * Chaque cas porte ce qui a été mesuré ET le geste qui y répond. Nommer la panne
 * sans dire quoi faire laisserait l'exploitant exactement où il était.
 */
const DIAGNOSTICS = {
  sshd_muet: {
    titre: 'Aucun serveur SSH ne répond dans ce Spark.',
    detail: 'Rien n’écoute sur son port 22. L’image de base n’embarque pas de '
      + '« sshd » : sur un Spark où personne ne l’a installé, le chemin normal '
      + 'ne peut pas aboutir.',
  },
  spark_en_erreur: {
    titre: 'Ce Spark est en erreur.',
    detail: 'Le chemin normal ne peut pas être supposé disponible tant que la '
      + 'cellule n’est pas repartie.',
  },
  cle_refusee: {
    titre: 'Le serveur SSH répond, mais il refuse la clé.',
    detail: 'Ce n’est pas une panne du Spark : c’est un problème d’accès. '
      + 'Réaccordez la clé depuis l’onglet Clés — le dépannage n’est pas la '
      + 'réponse, et il vous sera refusé.',
  },
  ssh_disponible: {
    titre: 'Le serveur SSH de ce Spark répond.',
    detail: 'Le shell distant s’est donc terminé pour une autre raison — une '
      + 'commande qui rend la main, ou une déconnexion. Rouvrir devrait marcher.',
  },
  sans_cellule: {
    titre: 'Ce Spark n’a pas encore de cellule.',
    detail: 'Il est déclaré et ses ressources sont réservées, mais rien ne tourne.',
  },
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
  // §14.9 : le backend est l'autorité. Un refus de DÉPANNAGE n'est pas une
  // impasse — le chemin normal, lui, reste disponible —, donc il s'affiche DANS
  // l'écran plutôt qu'à sa place. Le rendre bloquant enfermerait l'exploitant
  // hors d'un Spark parfaitement joignable.
  const refusDepannage = etat.refus?.error === 'rescue_refused'
    ? `<div class="refus" role="alert">
         <p><strong>Dépannage refusé.</strong> ${echapper(etat.refus.message)}</p>
       </div>`
    : '';

  const refus = etat.status === 'refus' && etat.refus
      && etat.refus.error !== 'rescue_refused'
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
  // §37.3 : « la bannière reste visible pendant toute la session : on ne doit pas
  // oublier par quel chemin on est entré ». Elle porte donc le chemin RÉEL de la
  // session, pas une constante, et le §9.8 interdit que la couleur seule le
  // distingue — le libellé nomme le pouvoir employé en toutes lettres.
  const chemin = CHEMINS[etat.session?.path] ?? CHEMINS.ssh;
  const motif = etat.session?.rescueReason
    ? ` <span class="note">Ouvert parce que ${
        echapper(MOTIFS_DEPANNAGE[etat.session.rescueReason] ?? etat.session.rescueReason)}.</span>`
    : '';
  // §37.4.7 : la bannière NOMME le conteneur. Deux conteneurs d'une même pile se
  // ressemblent, et taper la mauvaise commande dans le mauvais est l'erreur que
  // cette ligne existe pour empêcher.
  const dansConteneur = etat.session?.container
    ? ` <strong>« ${echapper(etat.session.container)} »</strong>
        <span class="technique">${echapper(etat.session.shell ?? '')}</span>`
    : '';
  const bandeau = `<p class="bandeau-terminal">
      <span class="badge badge--${chemin.token}"><span class="badge__point" aria-hidden="true"></span>${
        echapper(chemin.pastille)}</span>
      ${chemin.nomme ? `<strong>${echapper(chemin.nomme)}</strong>` : ''}${dansConteneur}
      ${spark.protected
        ? '<span class="badge badge--accent"><span class="badge__point" aria-hidden="true"></span>Spark protégé</span>'
        : ''}${motif}
      <span class="note">Quitter cet onglet <strong>termine</strong> la session.</span>
    </p>`;

  // §37.3 : la confirmation NOMME le pouvoir employé, et ne dit pas « confirmer ».
  // Rendue dans le FLUX (§6.22) : une modale imposerait un voile, un piège de
  // focus et une restitution, pour trois lignes et deux boutons. Le bouton
  // d'engagement est destructif (§6.23) — ce geste donne au plan de contrôle
  // l'exécution en root chez le locataire.
  const confirmation = etat.confirmeDepannage
    ? `<div class="confirmation" role="group" aria-labelledby="titre-depannage">
         <p id="titre-depannage"><strong>Ouvrir un terminal de dépannage ?</strong></p>
         <p>Le plan de contrôle va <strong>exécuter un shell root dans la cellule
         de « ${echapper(spark.name)} »</strong>, sans passer par son « sshd ».
         C’est un pouvoir que la console n’emploie nulle part ailleurs.</p>
         <p class="note">Cette ouverture est inscrite au journal sous une action
         distincte, pour que l’on puisse compter combien de fois cette voie a servi.
         Elle n’est acceptée que si ce Spark est en erreur ou si rien ne répond sur
         son port 22 — c’est le serveur qui en décide, pas cet écran.</p>
         <p class="confirmation__actions">
           <button type="button" class="bouton bouton--destructif" data-terminal="depanner-confirme">
             Exécuter en root dans la cellule
           </button>
           <button type="button" class="bouton" data-terminal="depanner-annule">Annuler</button>
         </p>
       </div>`
    : '';

  // §1.4 et §14.9 : le dépannage EXISTE, donc sa commande s'affiche. Elle n'est
  // pas désactivée d'après ce que l'écran croit savoir de l'état du « sshd » —
  // il ne le sait pas, et c'est le serveur qui mesure puis refuse en le disant.
  const boutonDepannage = etat.confirmeDepannage
    ? ''
    : `<button type="button" class="bouton" data-terminal="depanner"
               ${etat.status === 'ouverture' ? 'disabled' : ''}>
         Terminal de dépannage
       </button>`;

  const commandes = etat.status === 'ouvert'
    ? `<p class="formulaire__actions">
         <button type="button" class="bouton" data-terminal="fermer">Fermer la session</button>
         <label class="note" for="terminal-lecteur">
           <input type="checkbox" id="terminal-lecteur" data-terminal="lecteur"
                  ${etat.lecteurEcran ? 'checked' : ''}>
           Mode lecteur d’écran
         </label>
       </p>`
    : `${confirmation}
       <p class="formulaire__actions">
         <button type="button" class="bouton bouton--primaire" data-terminal="ouvrir"
                 ${etat.status === 'ouverture' ? 'disabled' : ''}>
           ${etat.status === 'ouverture' ? 'Ouverture…' : 'Ouvrir un terminal'}
         </button>
         ${boutonDepannage}
       </p>`;

  const avis = etat.avertissement
    ? `<p class="avertissement" role="status">${echapper(etat.avertissement)}</p>`
    : '';
  const fin = etat.fin
    ? `<p class="note-transitoire" role="status">${echapper(FINS[etat.fin] ?? etat.fin)}</p>`
    : '';

  // §37.2 : quand le chemin normal n'aboutit pas, l'écran NOMME ce qui manque.
  // Les trois états ne se confondent pas (§6.13, §14.6) : mesure en cours,
  // mesure rendue, mesure impossible. Un blanc laisserait croire que tout va
  // bien là où l'on vient justement d'échouer à entrer.
  const diagnostic = etat.diagnostic === 'en-cours'
    ? `<p class="note" role="status" aria-busy="true">Vérification du serveur SSH
       de ce Spark…</p>`
    : etat.diagnostic === 'impossible'
      ? `<p class="note" role="status">La console n’a pas pu vérifier le serveur
         SSH de ce Spark. La cause de l’échec n’est donc pas établie.</p>`
      : etat.diagnostic
        ? (() => {
            const cas = DIAGNOSTICS[etat.diagnostic.motif];
            if (!cas) return '';
            // Une panne qui ouvre le dépannage est une ALERTE : c'est elle qui
            // justifie d'employer un pouvoir d'exception, et le §9.7 veut
            // qu'elle soit annoncée. Un Spark joignable ne l'est pas.
            const grave = etat.diagnostic.ouvert || etat.diagnostic.motif === 'cle_refusee';
            return `<div class="${grave ? 'refus' : 'note'}"${grave ? ' role="alert"' : ' role="status"'}>
                      <p><strong>${echapper(cas.titre)}</strong></p>
                      <p>${echapper(cas.detail)}</p>
                    </div>`;
          })()
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
  ${refusDepannage}
  ${avis}${fin}${diagnostic}
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
