/**
 * Point d'entrée de la console dans le navigateur.
 *
 * @spec docs/BACKLOG.md#SPK-18, docs/BACKLOG.md#SPK-21, docs/BACKLOG.md#SPK-64 ·
 *       docs/DAT.md §26 (les trois panneaux d'administration, §26.2 le contrat
 *       d'interaction, §26.5 l'ordre refus-puis-acceptation) ·
 *       docs/BACKLOG.md#SPK-22 · docs/DAT.md §27 (l'écran des pools) ·
 *       docs/DAT.md §43.6 révisé (la Forge propose, le Spark choisit) ·
 *       docs/DESIGN_SYSTEM.md §5.1, §6.13, §6.22, §9.1, §9.7
 */

import { renderSparksView } from './components/sparks-view.js';
import { renderSparkDetail, AMORCAGE_VIDE, QUOTAS_VIDE } from './components/spark-detail.js';
import { ENV_VIDE } from './components/spark-env.js';
import { CATALOGUE_VIDE as CATALOGUE_ENV_VIDE, renderForgeEnv } from './components/forge-env.js';
import { DOCKER_VIDE } from './components/spark-docker.js';
import { TERMINAL_VIDE, CHAMP_TERMINAL } from './components/spark-terminal.js';
import { renderSessionRegistry } from './components/session-registry.js';
import { renderSparkCreate, renderAvertissement, formatQuota, validateShape, DEFAUTS }
  from './components/spark-create.js';
import { ADMIN_VIDE, apercu, renderEffet, renderRecetteApercu, zonePour }
  from './components/spark-admin.js';
import { renderForgeView } from './components/forge-view.js';
import { INSTALLER_VIDE } from './components/forge-installer.js';
import { renderCatalogue, renderOngletsForge, renderOnglets, CATALOGUE_VIDE } from './components/forge-images.js';
import { renderJournalForgePage, FILTRES_VIDES } from './components/forge-journal.js';
import { renderManuel } from './components/manuel-view.js';
import { renderServeurs, CATALOGUE_SERVEURS_VIDE } from './components/servers-view.js';
import { brancherModale } from './components/modale.js';
import { tunnelOf, signatureMotifOf } from './components/tokens.js';

const racine = document.getElementById('racine');
const etat = { status: 'loading', sparks: [], usage: {}, error: null,
               sort: { key: 'name', dir: 'asc' }, tunnel: null, server: null,
               route: 'liste', spark: null, detail: {}, confirming: null,
               // SPK-63 · §6.23 : ce qui a été frappé pour confirmer une
               // suppression. Vide tant qu'on n'a rien tapé.
               frappe: '',
               // SPK-40 · §36.10.9 : ce que le DERNIER geste relayé n'a pas pu
               // signer. `null` tant que rien n'a échoué — et il redevient
               // `null` dès qu'un geste repart signé.
               signature: null,
               // SPK-65 · §40.5 : l'hôte dit si CE processus Node a démarré
               // avant le code du poste. Cela ne dépend d'aucune Forge.
               consoleBuild: null,
               // SPK-57 · §49 : la modale de redimensionnement. Fermée tant
               // qu'on ne l'a pas ouverte, et ses valeurs sont celles du Spark
               // AU MOMENT DE L'OUVERTURE — pas des champs vides qui feraient
               // saisir de mémoire ce qui est déjà à l'écran.
               quotas: { ...QUOTAS_VIDE, values: { ...QUOTAS_VIDE.values } },
               // SPK-58 · §43 : l'état de la facette Environnement.
               envUi: { ...ENV_VIDE, values: { ...ENV_VIDE.values } },
               creation: { values: { ...DEFAUTS }, errors: {}, refusal: null,
                           pools: null, cores: null, submitting: false, images: [] },
               admin: { ...ADMIN_VIDE, values: { ...ADMIN_VIDE.values } },
               forge: { status: 'loading', host: null, cores: null,
                       sparkNames: {}, error: null, syncing: false,
                       // SPK-53 · §40.3 : quel code cette Forge exécute, et
                       // comment il se situe. `null` tant qu'on n'a pas comparé
                       // — « pas encore su » n'est ni « à jour », ni une panne.
                       build: null,
                       installer: { ...INSTALLER_VIDE } },
               facette: '',
               // SPK-43 · §37.4 : la session de terminal. Les OCTETS n'y sont
               // pas — ils vont directement au DOM (§37.5).
               terminal: {
                 ...TERMINAL_VIDE,
                 // §11 : la préférence d'affichage est limitée à la SESSION.
                 lecteurEcran: (() => {
                   try {
                     return sessionStorage.getItem('spark.terminal.lecteur') === 'true';
                   } catch { return false; }
                 })(),
               },
               // SPK-70 : seulement les métadonnées que l'hôte décrit. Aucun
               // octet de terminal n'entre dans l'état de la SPA.
               sessions: { items: [], confirmation: null, tiroirOuvert: false },
               servers: [],
               catalogueServeurs: { status: 'loading', servers: [], tunnels: [],
                                    current: null, error: null,
                                    ui: { ...CATALOGUE_SERVEURS_VIDE,
                                          values: { ...CATALOGUE_SERVEURS_VIDE.values } } },
               journal: { status: 'loading', entries: [], error: null,
                          filtres: { ...FILTRES_VIDES },
                          chain: null, anchor: null, checking: false },
               catalogue: { status: 'loading', images: [], error: null,
                            ui: { ...CATALOGUE_VIDE, values: { ...CATALOGUE_VIDE.values } } },
               // SPK-64 · §43.6 : le catalogue de la Forge est une destination
               // propre. Il ne se mélange pas au catalogue d'images, qui a un
               // autre sujet et un autre contrat de saisie.
               catalogueEnv: { status: 'loading', entrees: [], error: null,
                               ui: { ...CATALOGUE_ENV_VIDE,
                                     values: { ...CATALOGUE_ENV_VIDE.values } } },
               // SPK-54 · §42 : l'amorçage. Vide tant qu'on n'a rien demandé —
               // le relevé exécute une commande dans la cellule du locataire.
               amorcage: { ...AMORCAGE_VIDE },
               // SPK-44 · §37.6 : ce qui tourne dans le Spark. Relevé tant que
               // l'onglet est ouvert, et ARRÊTÉ dès qu'il est quitté.
               docker: { ...DOCKER_VIDE } };

/**
 * L'indicateur de page courante SUIT la route.
 *
 * Il était écrit en dur sur « Sparks » : sur l'écran de la Forge, un lecteur
 * d'écran annonçait donc la mauvaise page courante (docs/DESIGN_SYSTEM.md §5.1,
 * §9.7). Un indicateur qui ment est pire qu'un indicateur absent.
 */
function marquerNavigation() {
  // Le premier degré reste « Sparks » quand on est dans une section de la Forge :
  // les onglets du second degré portent leur propre `aria-current` (§34.1).
  const courant = etat.route === 'serveurs' ? '#/serveurs'
    : etat.route === 'manuel' ? '#/manuel'
    : ['forge', 'images', 'environnement', 'journal'].includes(etat.route) ? '#/forge' : '#/sparks';
  for (const lien of racine.querySelectorAll('nav a')) {
    if (lien.getAttribute('href') === courant) lien.setAttribute('aria-current', 'page');
    else lien.removeAttribute('aria-current');
  }
}

/** État de l'écran du manuel (SPK-56). */
const manuel = { status: 'loading', chapters: [], current: null, markdown: '', error: null };

function peindre() {
  marquerNavigation();
  racine.querySelector('.principal').innerHTML =
    etat.route === 'manuel'
      ? renderManuel(manuel)
      : etat.route === 'creation' && etat.status === 'loading'
      ? '<div class="carte bloc" aria-busy="true"><p class="sr-only" role="status">Chargement…</p></div>'
      : etat.route === 'images'
      ? renderOngletsForge('#/forge/images') + renderCatalogue(etat.catalogue)
      : etat.route === 'environnement'
      ? renderForgeEnv(etat.catalogueEnv)
      : etat.route === 'journal'
      ? renderJournalForgePage(etat.journal)
      : etat.route === 'serveurs'
      ? renderServeurs(etat.catalogueServeurs)
      : etat.route === 'forge'
      ? renderOngletsForge('#/forge') + renderForgeView(etat.forge)
      : etat.route === 'creation'
      ? renderSparkCreate(etat.creation)
      : etat.route === 'detail'
      ? renderSparkDetail({ status: etat.status, spark: etat.spark, error: etat.error,
                            confirming: etat.confirming, frappe: etat.frappe,
                            admin: etat.admin, quotas: etat.quotas,
                            envUi: etat.envUi,
                            facette: etat.facette, terminal: etat.terminal,
                            amorcage: etat.amorcage, docker: etat.docker,
                            ...etat.detail })
      : renderOnglets([['#/sparks', 'Instances']], '#/sparks', 'Sections des Sparks')
        + renderSparksView(etat);
  brancher();
  peindreRegistreSessions();
}

/**
 * Ce qu'une valeur de quota change à l'écran, SANS repeindre le formulaire.
 *
 * @spec docs/BACKLOG.md#SPK-59 · docs/DESIGN_SYSTEM.md §6.9 bis (le curseur
 *       porte sa valeur en clair et dans `aria-valuetext`), §14.3 (le focus ne
 *       se perd pas) · docs/DAT.md §25.1 (l'avertissement est un risque)
 *
 * Repeindre serait plus simple et serait faux : `innerHTML` reconstruit le
 * formulaire, ce qui arrache la poignée en cours de glissement et fait perdre le
 * focus au clavier. Seuls les deux éléments qui dépendent de la valeur sont
 * réécrits.
 */
function rafraichirQuota(formulaire, controle) {
  if (controle.type === 'range') {
    const texte = formatQuota(controle.name, controle.value);
    controle.setAttribute('aria-valuetext', texte);
    const vue = formulaire.querySelector(`[data-valeur-de="${controle.name}"]`);
    if (vue) vue.textContent = texte;
  }
  const zone = formulaire.querySelector('.zone-avertissement');
  if (zone) {
    zone.innerHTML = renderAvertissement(etat.creation.values, etat.creation.pools,
                                         etat.creation.refusal);
  }
}

/** §9.1 : toute fonction est utilisable sans souris. Le tri est un bouton. */
function brancher() {
  for (const bouton of racine.querySelectorAll('[data-tri]')) {
    bouton.addEventListener('click', () => {
      const cle = bouton.dataset.tri;
      etat.sort = { key: cle, dir: etat.sort.key === cle && etat.sort.dir === 'asc' ? 'desc' : 'asc' };
      peindre();
      // §14.3 : le focus ne doit pas se perdre quand le contrôle est reconstruit.
      racine.querySelector(`[data-tri="${cle}"]`)?.focus();
    });
  }
  racine.querySelector('[data-action="reessayer"]')?.addEventListener('click', router);
  // §27.8 : le relevé ne détruit rien et n'a aucun paramètre — pas de confirmation.
  racine.querySelector('[data-action="relever"]')?.addEventListener('click', relever);
  racine.querySelector('[data-action="comparer-build"]')
    ?.addEventListener('click', () => comparerBuild());
  racine.querySelector('[data-action="diagnostiquer-forge"]')
    ?.addEventListener('click', diagnostiquerForge);
  racine.querySelector('[data-action="relever-images"]')?.addEventListener('click', releverImages);
  brancherCatalogue();
  brancherCatalogueEnv();
  brancherJournal();
  brancherServeurs();

  const formulaire = racine.querySelector('#formulaire-spark');
  if (formulaire) {
    // Les valeurs vivent dans l'état : un refus ne doit rien effacer (§25.2).
    for (const controle of formulaire.querySelectorAll('input, select')) {
      controle.addEventListener('input', () => {
        const brut = controle.value;
        etat.creation.values[controle.name] =
          ['number', 'range'].includes(controle.type) ? Number(brut) : brut;
        if (controle.name === 'cpu_mode') { peindre(); return; }   // les champs suivent le mode
        rafraichirQuota(formulaire, controle);
      });
    }
    formulaire.addEventListener('submit', (evenement) => {
      evenement.preventDefault();
      creer();
    });
  }

  racine.querySelector('.etat-vue .bouton--primaire')?.addEventListener('click', () => {
    location.hash = '#/creer';
  });

  for (const bouton of racine.querySelectorAll('[data-commande]')) {
    bouton.addEventListener('click', () => {
      const commande = bouton.dataset.commande;
      // Seule la suppression passe par une confirmation (docs/DAT.md §24.2).
      if (commande === 'delete') {
        etat.confirming = 'delete';
        // La frappe repart à VIDE : garder celle d'une confirmation annulée
        // rendrait la suivante engageable sans avoir rien lu (§6.23).
        etat.frappe = '';
        peindre();
        // §6.22 : le focus entre dans la confirmation. Il va au CHAMP, pas au
        // bouton : celui-ci est désactivé tant que rien n'est frappé, et un
        // focus sur un contrôle inerte laisse croire qu'on est bloqué (§14.3).
        racine.querySelector('[data-frappe="delete"]')?.focus();
        return;
      }
      lancer(commande);
    });
  }
  brancherPanneaux();
  brancherTerminal();
  brancherAmorcage();
  // §6.27 : le contrat de la modale est tenu à UN SEUL endroit — focus entrant,
  // focus retenu, Échap qui vaut annulation, focus rendu au déclencheur.
  brancherModale(racine, {
    onFermer: () => {
      etat.admin.open = null;
      etat.admin.refusal = null;
      etat.catalogue.ui.open = false;
      etat.catalogue.ui.refusal = null;
      etat.catalogueEnv.ui.open = false;
      etat.catalogueEnv.ui.refusal = null;
      etat.catalogueServeurs.ui.open = false;
      etat.catalogueServeurs.ui.refusal = null;
      etat.catalogueServeurs.ui.probe = null;
      // SPK-57 : la modale des quotas suit le MÊME contrat. L'oublier ici la
      // laisserait ouverte après une fermeture par « Échap », et l'écran
      // afficherait une surface que l'utilisateur croit avoir refermée.
      etat.quotas.open = false;
      etat.quotas.refusal = null;
      // SPK-58 : la facette Environnement suit le MÊME contrat, et l'oublier
      // ici RÉOUVRAIT la modale — MESURÉ par le parcours E2E du refus :
      // `close()` s'exécutait, puis la repeinte trouvait `open` encore vrai et
      // rappelait `showModal()`. « Échap » paraissait sans effet.
      etat.envUi.open = null;
      etat.envUi.refusal = null;
      peindre();
    },
  });
  // SPK-63 : la frappe n'appelle PAS `peindre()`. Le §6.9 bis a déjà enseigné la
  // leçon pour les curseurs — `innerHTML` reconstruit la surface, ce qui arrache
  // le contrôle en cours d'usage et fait perdre le focus au clavier. Seuls les
  // deux éléments qui dépendent de la valeur sont réécrits.
  const champFrappe = racine.querySelector('[data-frappe="delete"]');
  champFrappe?.addEventListener('input', () => {
    etat.frappe = champFrappe.value;
    const correspond = etat.frappe === (etat.spark?.name ?? '');
    const engagement = racine.querySelector('[data-confirme="delete"]');
    if (engagement) engagement.disabled = !correspond;
    const aide = racine.querySelector('#suppression-aide');
    // §9.7 : le changement est ANNONCÉ. Sans cela, qui n'a pas l'écran sous les
    // yeux ne sait pas que le bouton vient de s'activer.
    if (aide) {
      aide.textContent = correspond
        ? 'Le nom correspond.'
        : 'Le nom n’est pas encore celui du Spark : la suppression n’est pas engageable.';
    }
  });
  racine.querySelector('[data-confirme]')?.addEventListener('click', () => lancer('delete'));
  racine.querySelector('[data-annule]')?.addEventListener('click', () => {
    etat.confirming = null;
    etat.frappe = '';
    peindre();
    // §6.22 : l'annulation rend le focus au déclencheur.
    racine.querySelector('[data-commande="delete"]')?.focus();
  });
}

/**
 * Gestes des trois panneaux (docs/DAT.md §26).
 *
 * Le contrat d'interaction du §26.2 vaut pour les trois : le focus entre dans le
 * formulaire à l'ouverture, l'annulation le rend au déclencheur, et un refus du
 * serveur ne touche pas à la saisie.
 */
/* ----------------------------------------------------- registre des sessions */

let sessionAReprendre = null;
let minuterieSessions = null;

function peindreRegistreSessions() {
  const panneau = racine.querySelector('.registre-sessions');
  const contenu = racine.querySelector('#contenu-registre-sessions');
  const bascule = racine.querySelector('[data-registre="basculer"]');
  if (!panneau || !contenu || !bascule) return;
  panneau.classList.toggle('registre-sessions--ouvert', etat.sessions.tiroirOuvert);
  bascule.setAttribute('aria-expanded', String(etat.sessions.tiroirOuvert));
  bascule.textContent = etat.sessions.tiroirOuvert ? 'Masquer' : 'Afficher';
  contenu.innerHTML = renderSessionRegistry({
    sessions: etat.sessions.items, confirmation: etat.sessions.confirmation,
  });
  brancherRegistreSessions();
}

async function releverSessions() {
  try {
    const reponse = await fetch('/api/terminal/sessions');
    const corps = await reponse.json();
    if (!reponse.ok) throw new Error(corps?.message ?? `HTTP ${reponse.status}`);
    etat.sessions.items = corps.sessions ?? [];
    if (!etat.sessions.items.some((session) => session.id === etat.sessions.confirmation)) {
      etat.sessions.confirmation = null;
    }
  } catch {
    // Le registre est une aide locale : une erreur de rafraîchissement ne doit
    // ni inventer une ligne, ni fermer une session dont le sort est inconnu.
  }
  peindreRegistreSessions();
}

function programmerReleveSessions() {
  clearTimeout(minuterieSessions);
  // La liste est locale et minuscule ; cette cadence garde l'inactivité et une
  // fin distante visibles sans sonder un Spark ni toucher à son contenu.
  minuterieSessions = setTimeout(async () => {
    await releverSessions();
    programmerReleveSessions();
  }, 3000);
}

async function selectionnerSession(id) {
  const session = etat.sessions.items.find((candidate) => candidate.id === id);
  if (!session) return;
  if (etat.terminal.session && etat.terminal.session.id !== id) {
    // Une fenêtre ne peut présenter qu'une grille à la fois. La quitter garde
    // le contrat historique : elle tue SON shell avant d'en suivre un autre.
    await fermerTerminal('sortie');
  }
  // Une session appartient à sa Forge. Le contexte est basculé avant la route,
  // sinon on afficherait un homonyme d'un autre serveur sous le mauvais shell.
  if (session.forge && session.forge !== etat.server) await changerDeServeur(session.forge);
  sessionAReprendre = session;
  const cible = `#/sparks/${encodeURIComponent(session.spark)}/terminal`;
  if (location.hash === cible) await router();
  else location.hash = cible;
}

function brancherRegistreSessions() {
  const bascule = racine.querySelector('[data-registre="basculer"]');
  // Le bouton vit dans la coquille, contrairement au contenu qu'on remplace à
  // chaque relevé. Ne l'abonner qu'une fois : plusieurs écouteurs inverseraient
  // le tiroir autant de fois et le laisseraient fermé après un rafraîchissement.
  if (bascule && !bascule.dataset.registreBranche) {
    bascule.dataset.registreBranche = 'true';
    bascule.addEventListener('click', () => {
      etat.sessions.tiroirOuvert = !etat.sessions.tiroirOuvert;
      peindreRegistreSessions();
      if (etat.sessions.tiroirOuvert) racine.querySelector('[data-session-select]')?.focus();
    });
  }
  for (const bouton of racine.querySelectorAll('[data-session-select]')) {
    bouton.addEventListener('click', () => selectionnerSession(bouton.dataset.sessionSelect));
  }
  for (const bouton of racine.querySelectorAll('[data-session-close]')) {
    bouton.addEventListener('click', () => {
      etat.sessions.confirmation = bouton.dataset.sessionClose;
      peindreRegistreSessions();
      racine.querySelector('[data-session-close-confirm]')?.focus();
    });
  }
  racine.querySelector('[data-session-close-cancel]')?.addEventListener('click', () => {
    etat.sessions.confirmation = null;
    peindreRegistreSessions();
  });
  for (const bouton of racine.querySelectorAll('[data-session-close-confirm]')) {
    bouton.addEventListener('click', async () => {
      const id = bouton.dataset.sessionCloseConfirm;
      etat.sessions.confirmation = null;
      await fetch(`/api/terminal?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
      if (etat.terminal.session?.id === id) await fermerTerminal(null);
      await releverSessions();
    });
  }
}

/* ------------------------------------------------------------- le terminal */

/**
 * Le flux d'évènements en cours. Il vit HORS de l'état : c'est une ressource
 * ouverte, pas une donnée d'écran, et la peindre n'aurait aucun sens.
 */
let fluxTerminal = null;

// SPK-70 : l'émulateur vit hors de l'état comme le flux. Garder son tampon dans
// `etat` le sérialiserait avec les autres données d'écran et créerait un
// historique de session ; il est détruit dès que la session quitte sa surface.
let emulateurTerminal = null;
let ajusteurTerminal = null;
let observateurTerminal = null;
let chargementEmulateur = null;
// Une fermeture demandée par cette surface laisse le flux ouvert le temps que
// DELETE atteigne l'hôte. Son évènement `fin` ne doit pas démonter la grille
// avant que cette fonction ait achevé la fermeture explicitement demandée.
let fermetureLocaleTerminal = null;

async function modulesTerminal() {
  chargementEmulateur ??= Promise.all([
    import('/vendor/xterm/xterm.mjs'),
    import('/vendor/xterm/addon-fit.mjs'),
  ]).then(([xterm, fit]) => ({ Terminal: xterm.Terminal, FitAddon: fit.FitAddon }));
  return chargementEmulateur;
}

function detruireEmulateurTerminal() {
  observateurTerminal?.disconnect();
  observateurTerminal = null;
  ajusteurTerminal?.dispose?.();
  ajusteurTerminal = null;
  emulateurTerminal?.dispose?.();
  emulateurTerminal = null;
}

/** Monte xterm dans la grille actuellement rendue, sans jamais garder ses octets. */
async function monterEmulateurTerminal({ focus = false } = {}) {
  const cible = racine.querySelector(`#${CHAMP_TERMINAL}`);
  if (!cible) return false;
  if (emulateurTerminal?.element === cible) {
    if (focus) emulateurTerminal.focus();
    return true;
  }
  detruireEmulateurTerminal();
  const { Terminal, FitAddon } = await modulesTerminal();
  // Une navigation peut avoir remplacé la surface pendant le chargement du
  // module : ne montons jamais un terminal détaché dans une ancienne vue.
  const courant = racine.querySelector(`#${CHAMP_TERMINAL}`);
  if (!courant || courant !== cible) return false;
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: getComputedStyle(courant).fontFamily || 'monospace',
    // Le lecteur d'écran est le tampon ACCESSIBLE de xterm : il reçoit le texte
    // déjà interprété, jamais les séquences ANSI brutes.
    screenReaderMode: Boolean(etat.terminal.lecteurEcran),
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(courant);
  terminal.onData((octets) => envoyerAuTerminal(octets));
  terminal.onResize(({ rows, cols }) => propagerTaille(rows, cols));
  emulateurTerminal = terminal;
  ajusteurTerminal = fit;
  observateurTerminal = new ResizeObserver(() => {
    if (emulateurTerminal === terminal) fit.fit();
  });
  observateurTerminal.observe(courant);
  fit.fit();
  if (focus) terminal.focus();
  return true;
}

/**
 * Les octets en attente d'envoi (SPK-43, §37.4.1).
 *
 * Le flux est unidirectionnel : chaque saisie est un envoi distinct, avec sa
 * latence. Pour un collage de plusieurs kilo-octets, on GROUPE ce qui attend et
 * on n'envoie qu'une requête — sans quoi coller un script produirait une requête
 * par ligne.
 */
let enAttente = '';
let envoiPlanifie = null;

/** La sortie va DIRECTEMENT au DOM : l'état n'en garde aucune trace (§37.5). */
function ecrireSortie(texte) {
  emulateurTerminal?.write(texte);
}

/** Met à jour l'avis sans repeindre la grille, donc sans perdre son écran. */
function rendreAvertissementTerminal(texte) {
  const zone = racine.querySelector('#terminal-evenements');
  if (!zone) return;
  const avis = document.createElement('p');
  avis.className = 'avertissement';
  avis.setAttribute('role', 'status');
  avis.textContent = texte;
  zone.replaceChildren(avis);
}

/**
 * L'amorçage d'un Spark (SPK-54, docs/DAT.md §42).
 *
 * Le relevé comme l'amorçage sont des gestes DEMANDÉS : ni l'un ni l'autre ne
 * part de lui-même, parce que les deux exécutent une commande dans la cellule du
 * locataire. Un relevé automatique à l'ouverture de l'écran ferait entrer la
 * console chez lui à chaque coup d'œil.
 */
function brancherAmorcage() {
  const a = etat.amorcage;

  racine.querySelector('[data-amorcage="relever"]')
    ?.addEventListener('click', () => amorcageAppel('GET'));

  racine.querySelector('[data-amorcage="amorcer"]')
    ?.addEventListener('click', () => {
      // §6.23 : une action sensible se confirme, et la confirmation nomme le
      // pouvoir employé. Elle est rendue dans le flux (§6.22).
      a.confirme = true;
      peindre();
      racine.querySelector('[data-amorcage="engager"]')?.focus();
    });

  racine.querySelector('[data-amorcage="annuler"]')
    ?.addEventListener('click', () => {
      a.confirme = false;
      peindre();
      // §14.3 : le focus revient au déclencheur, qui vient de réapparaître.
      racine.querySelector('[data-amorcage="amorcer"]')?.focus();
    });

  // §42.2 : l'option est OFFERTE, jamais imposée. Elle vaut pour ce geste-ci.
  racine.querySelector('[data-amorcage="rootless"]')
    ?.addEventListener('change', (evenement) => {
      a.rootless = evenement.target.checked;
    });

  racine.querySelector('[data-amorcage="engager"]')
    ?.addEventListener('click', () => {
      a.confirme = false;
      amorcageAppel('POST');
    });
}

async function amorcageAppel(methode) {
  const a = etat.amorcage;
  a.erreur = null;
  a.busy = true;
  if (methode === 'GET') {
    // §14.6 : « mesure en cours » ne se confond ni avec un verdict, ni avec
    // l'absence de mesure. Le compte rendu précédent s'efface : il portait sur
    // un état qu'on est en train de remesurer.
    a.releve = 'en-cours';
    a.resultat = null;
  }
  peindre();
  const chemin = `/api/v1/sparks/${encodeURIComponent(etat.spark.name)}/bootstrap`
    + `?server=${encodeURIComponent(etat.server)}`;
  try {
    const reponse = await relais(chemin, methode === 'GET' ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootless: a.rootless }),
    });
    const corps = await reponse.json();
    if (!reponse.ok) {
      // Le runtime NOMME ses refus (§42.7) : « pas de cellule », « à l'arrêt »,
      // « protégé ». Les remplacer par un code HTTP ferait deviner.
      throw new Error(corps?.detail?.message ?? corps?.message ?? `HTTP ${reponse.status}`);
    }
    a.releve = { items: corps.items, complete: corps.complete };
    // Le compte rendu n'existe qu'après un amorçage : un relevé seul ne dit pas
    // ce qui a été fait, il dit ce qui est.
    if (methode !== 'GET') {
      a.resultat = corps;
      // Le choix vaut pour CE geste (§42.2 bis). Le garder coché ferait amorcer
      // le prochain Spark en rootless sans qu'on l'ait redemandé.
      a.rootless = false;
    }
  } catch (erreur) {
    a.erreur = erreur?.message ?? String(erreur);
    if (methode === 'GET') a.releve = null;
  }
  a.busy = false;
  peindre();
}

function brancherTerminal() {
  const etatT = etat.terminal;

  racine.querySelector('[data-terminal="ouvrir"]')
    ?.addEventListener('click', () => ouvrirTerminal());
  racine.querySelector('[data-terminal="fermer"]')
    ?.addEventListener('click', () => fermerTerminal('sortie'));

  // §37.3 : le dépannage passe par une confirmation qui NOMME le pouvoir
  // employé. Elle est rendue dans le flux (§6.22), donc c'est un simple état.
  racine.querySelector('[data-terminal="depanner"]')
    ?.addEventListener('click', () => {
      etatT.confirmeDepannage = true;
      peindre();
      // §14.3 : la commande qui l'a ouverte disparaît. Sans ce déplacement, le
      // focus resterait sur un bouton retiré du document.
      racine.querySelector('[data-terminal="depanner-confirme"]')?.focus();
    });
  racine.querySelector('[data-terminal="depanner-annule"]')
    ?.addEventListener('click', () => {
      etatT.confirmeDepannage = false;
      peindre();
      racine.querySelector('[data-terminal="depanner"]')?.focus();
    });
  racine.querySelector('[data-terminal="depanner-confirme"]')
    ?.addEventListener('click', () => {
      etatT.confirmeDepannage = false;
      ouvrirTerminal('rescue');
    });

  const lecteur = racine.querySelector('[data-terminal="lecteur"]');
  lecteur?.addEventListener('change', () => {
    etatT.lecteurEcran = lecteur.checked;
    // §11 de CLAUDE.md : une préférence d'interface qui peut rester limitée à la
    // session emploie `sessionStorage`. Rien ici ne justifie de la persister sur
    // l'appareil au-delà.
    try {
      sessionStorage.setItem('spark.terminal.lecteur', String(lecteur.checked));
    } catch { /* stockage refusé : la préférence vaut pour cet écran seulement */ }
    // xterm fournit sa propre restitution accessible. Changer cette option ne
    // repeint pas la page : un rerendu détruirait l'écran courant du shell.
    if (emulateurTerminal) emulateurTerminal.options.screenReaderMode = lecteur.checked;
  });
}

/** Groupe les octets et n'envoie qu'une requête (§37.4.1). */
function envoyerAuTerminal(data) {
  if (!etat.terminal.session) return;
  enAttente += data;
  if (envoiPlanifie) return;
  envoiPlanifie = setTimeout(async () => {
    const charge = enAttente;
    enAttente = '';
    envoiPlanifie = null;
    if (!charge || !etat.terminal.session) return;
    await fetch(`/api/terminal/entree?id=${encodeURIComponent(etat.terminal.session.id)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: charge }),
    }).catch(() => {});
  }, 16);
}

/**
 * Ouvre la session, puis branche le flux de sortie (§37.4.1, §37.4.4).
 *
 * L'ordre compte : le flux ne peut s'abonner qu'à une session existante, et
 * l'ouvrir d'abord garantit qu'aucun octet n'est perdu entre les deux.
 */
/**
 * Pourquoi le chemin normal n'a pas abouti (§37.2, §37.3.1).
 *
 * La console ne retient AUCUN octet de la session (§37.5) : elle ne peut donc
 * pas déduire la cause de ce qui s'est affiché. Elle la fait mesurer.
 */
async function diagnostiquerTerminal() {
  const t = etat.terminal;
  t.diagnostic = 'en-cours';
  peindre();
  try {
    const reponse = await fetch(
      `/api/terminal/diagnostic?server=${encodeURIComponent(etat.server)}`
      + `&spark=${encodeURIComponent(etat.spark.name)}`);
    if (!reponse.ok) throw new Error(`HTTP ${reponse.status}`);
    const corps = await reponse.json();
    t.diagnostic = { motif: corps.rescue?.motif ?? null,
                     ouvert: Boolean(corps.rescue?.ouvert) };
  } catch {
    // §14.6 : « mesure impossible » n'est pas « tout va bien ». Taire l'échec
    // du diagnostic laisserait croire que la cause a été établie.
    t.diagnostic = 'impossible';
  }
  peindre();
}

/**
 * Ouvre une session de terminal.
 *
 * @param chemin    'ssh' | 'rescue' (§37.3)
 * @param conteneur le conteneur où entrer (§37.4.7). Il PRIME sur le chemin :
 *                  le serveur choisit alors « container ».
 */
async function ouvrirTerminal(chemin = 'ssh', conteneur = null) {
  // L'ouverture depuis un conteneur change d'abord la facette. Attendre la
  // grille rend ce passage déterministe : sans cela la requête pouvait partir
  // avant que le routeur ait rendu « Terminal », et l'émulateur refusait une
  // surface qui allait apparaître à l'image suivante.
  const limite = Date.now() + 3000;
  while (!racine.querySelector(`#${CHAMP_TERMINAL}`) && Date.now() < limite) {
    await new Promise((resoudre) => requestAnimationFrame(resoudre));
  }
  if (!racine.querySelector(`#${CHAMP_TERMINAL}`)) {
    etat.terminal.status = 'refus';
    etat.terminal.refus = { error: 'emulator_unavailable',
                            message: 'La surface du terminal n’a pas pu être rendue.' };
    return peindre();
  }
  const t = etat.terminal;
  t.status = 'ouverture';
  t.refus = null;
  t.fin = null;
  t.avertissement = null;
  // Le verdict portait sur la session PRÉCÉDENTE : le garder afficherait un
  // diagnostic périmé à côté d'une session neuve.
  t.diagnostic = null;
  t.session = null;
  peindre();

  try {
    if (!await monterEmulateurTerminal()) throw new Error('Surface du terminal absente.');
  } catch (erreur) {
    t.status = 'refus';
    t.refus = { error: 'emulator_unavailable',
                message: `L’émulateur de terminal n’a pas pu être chargé : ${erreur.message}` };
    return peindre();
  }

  let corps;
  try {
    const reponse = await fetch('/api/terminal', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server: etat.server, spark: etat.spark.name,
                             path: chemin,
                             ...(conteneur ? { container: conteneur } : {}) }),
    });
    corps = await reponse.json();
    if (!reponse.ok) {
      // Un dépannage refusé n'est PAS une impasse : le chemin normal reste
      // disponible, et le §14.9 veut que le refus RÉEL du serveur s'affiche
      // sans fermer l'écran. Fermer ici enfermerait l'exploitant hors d'un
      // Spark parfaitement joignable.
      // §37.4.7 : un shell absent n'est PAS une impasse non plus. Le conteneur
      // existe peut-être parfaitement ; c'est son image qui n'a pas de shell.
      t.status = corps?.error === 'rescue_refused'
        || corps?.error === 'container_shell_unavailable' ? 'ferme' : 'refus';
      t.refus = corps;
      detruireEmulateurTerminal();
      return peindre();
    }
  } catch (erreur) {
    t.status = 'refus';
    t.refus = { error: 'console_unreachable', message: erreur.message };
    detruireEmulateurTerminal();
    return peindre();
  }

  await suivreSessionTerminal(corps);
}

/** Attache la grille à une session ouverte par cette fenêtre ou le registre. */
async function suivreSessionTerminal(session) {
  const t = etat.terminal;
  t.session = session;
  t.status = 'ouvert';
  t.refus = null;
  t.fin = null;
  t.avertissement = null;
  peindre();
  await monterEmulateurTerminal({ focus: true });

  fluxTerminal?.close();
  fluxTerminal = new EventSource(
    `/api/terminal/flux?id=${encodeURIComponent(session.id)}`);
  fluxTerminal.addEventListener('sortie', (e) => ecrireSortie(JSON.parse(e.data)));
  fluxTerminal.addEventListener('avertissement', (e) => {
    etat.terminal.avertissement = JSON.parse(e.data);
    rendreAvertissementTerminal(etat.terminal.avertissement);
  });
  fluxTerminal.addEventListener('fin', (e) => {
    const motif = JSON.parse(e.data);
    const finie = etat.terminal.session;
    if (fermetureLocaleTerminal === finie?.id) return;
    etat.terminal.fin = motif;
    etat.terminal.status = 'ferme';
    // La session est CONSERVÉE à l'affichage : le §37.3 veut qu'on n'oublie pas
    // par quel chemin on est entré, et l'oublier au moment même où l'on lit le
    // message de fermeture serait le pire moment. Elle est effacée à la
    // prochaine ouverture, pas ici.
    fluxTerminal?.close();
    fluxTerminal = null;
    detruireEmulateurTerminal();
    peindre();

    // §37.2 : un shell distant qui MEURT sur le chemin normal appelle une
    // explication. « sortie » est un départ volontaire et n'en appelle aucune.
    if (motif === 'distant_termine' && finie?.path !== 'rescue') diagnostiquerTerminal();
  });
  releverSessions();
}

/** Propage la géométrie exacte de xterm au vrai pseudo-terminal (§37.4.3). */
async function propagerTaille(rows, cols) {
  const t = etat.terminal;
  if (!t.session || !Number.isInteger(rows) || !Number.isInteger(cols)) return;
  await fetch(`/api/terminal/taille?id=${encodeURIComponent(t.session.id)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rows, cols }),
  }).catch(() => {});
}

/** Ferme la session, et TUE le distant (§37.4). */
async function fermerTerminal(motif = 'sortie') {
  const t = etat.terminal;
  const session = t.session;
  // Le DELETE doit partir AVANT de couper EventSource : fermer ce dernier
  // faisait auparavant gagner `flux_ferme` à la course contre la fermeture
  // explicitement demandée, et perdait le motif exact au journal.
  if (session && motif) {
    fermetureLocaleTerminal = session.id;
    await fetch(`/api/terminal?id=${encodeURIComponent(session.id)}`,
                { method: 'DELETE' }).catch(() => {});
  }
  fluxTerminal?.close();
  fluxTerminal = null;
  detruireEmulateurTerminal();
  t.session = null;
  t.status = 'ferme';
  t.avertissement = null;
  if (motif) t.fin = motif;
  peindre();
  if (fermetureLocaleTerminal === session?.id) fermetureLocaleTerminal = null;
  releverSessions();
}

/**
 * Le relevé Docker d'un Spark (SPK-44, docs/DAT.md §37.6).
 *
 * Rafraîchi toutes les CINQ secondes tant que l'onglet est ouvert, et **arrêté**
 * dès qu'il est quitté. Le motif est au §37.6 : une console qui interroge en
 * permanence un Spark qu'on ne regarde plus consomme le quota du locataire pour
 * rien. C'est la même règle que la session de terminal, qui meurt avec son
 * onglet.
 */
const DOCKER_CADENCE_MS = 5000;
let minuterieDocker = null;

function arreterDocker() {
  clearTimeout(minuterieDocker);
  minuterieDocker = null;
}

async function releverDocker({ premier = false } = {}) {
  const d = etat.docker;
  if (premier) { d.status = 'chargement'; d.erreur = null; peindre(); }
  try {
    const reponse = await fetch(
      `/api/spark/docker?server=${encodeURIComponent(etat.server)}`
      + `&spark=${encodeURIComponent(etat.spark.name)}`);
    const corps = await reponse.json();
    if (!reponse.ok) throw new Error(corps?.message ?? `HTTP ${reponse.status}`);
    d.releve = corps;
    d.status = 'pret';
    d.erreur = null;
  } catch (erreur) {
    // §14.6 : ne pas avoir pu lire n'est pas « rien ne tourne ». On le dit, et
    // on n'efface pas le relevé précédent — il porte encore une information
    // datée, là où un écran vidé n'en porterait aucune.
    d.status = d.releve ? 'pret' : 'erreur';
    d.erreur = erreur?.message ?? String(erreur);
  }
  peindre();
  // La minuterie se rearme APRÈS la réponse, jamais à intervalle fixe : sur un
  // Spark lent, un intervalle fixe empilerait les requêtes.
  //
  // Elle ne se rearme PAS quand un conteneur est ouvert : la liste a cédé la
  // place, et continuer à la relever consommerait le quota du locataire pour un
  // écran que personne ne regarde — le motif même du §37.6.
  if (etat.facette === 'docker' && etat.route === 'detail' && !etat.docker.ouvert) {
    minuterieDocker = setTimeout(() => releverDocker(), DOCKER_CADENCE_MS);
  }
}

/**
 * Ouvrir un conteneur : son inspection et ses journaux (SPK-44, §37.6 ter).
 *
 * DEMANDÉS, jamais collectés d'office. Les deux lectures partent ENSEMBLE et
 * s'affichent chacune dès qu'elle revient : un journal lourd ne doit pas retenir
 * l'identité du conteneur, qui est souvent ce qu'on venait chercher.
 */
async function ouvrirConteneur(nom) {
  const d = etat.docker;
  arreterDocker();
  d.ouvert = nom;
  d.detail = 'en-cours';
  d.journaux = 'en-cours';
  // Une confirmation ou une issue qui survivrait à l'ouverture porterait sur le
  // conteneur PRÉCÉDENT — et se lirait comme si elle portait sur celui-ci.
  d.confirme = null;
  d.enCours = null;
  d.issue = null;
  peindre();
  lireDetail(nom);
  lireJournauxConteneur(nom);
}

/** Une lecture demandée, et son refus dit à la place du texte attendu. */
async function lireConteneur(chemin, nom, extra = '') {
  const reponse = await fetch(
    `${chemin}?server=${encodeURIComponent(etat.server)}`
    + `&spark=${encodeURIComponent(etat.spark.name)}`
    + `&name=${encodeURIComponent(nom)}${extra}`);
  const corps = await reponse.json();
  if (!reponse.ok) throw new Error(corps?.message ?? `HTTP ${reponse.status}`);
  return corps;
}

async function lireDetail(nom) {
  const d = etat.docker;
  try {
    const vu = await lireConteneur('/api/spark/container', nom);
    if (d.ouvert === nom) d.detail = vu;
  } catch (erreur) {
    // §14.6 : ne pas avoir pu lire n'est pas « ce conteneur n'existe pas ».
    if (d.ouvert === nom) {
      d.detail = { titre: 'Inspection impossible',
                   detail: erreur?.message ?? String(erreur) };
    }
  }
  peindre();
}

async function lireJournauxConteneur(nom) {
  const d = etat.docker;
  try {
    const vu = await lireConteneur('/api/spark/logs', nom);
    if (d.ouvert === nom) d.journaux = vu;
  } catch (erreur) {
    if (d.ouvert === nom) {
      d.journaux = { lines: [], truncated: false, tail: 200,
                     state: 'conteneur_inconnu' };
      d.detail = typeof d.detail === 'object' && d.detail
        ? d.detail
        : { titre: 'Journaux illisibles',
            detail: erreur?.message ?? String(erreur) };
    }
  }
  peindre();
}

/** Refermer le conteneur, et reprendre le relevé de la liste. */
function fermerConteneur() {
  const d = etat.docker;
  d.ouvert = null;
  d.detail = null;
  d.journaux = null;
  d.confirme = null;
  d.enCours = null;
  d.issue = null;
  peindre();
  if (etat.facette === 'docker' && etat.route === 'detail') {
    releverDocker({ premier: !d.releve });
  }
}

/**
 * Un geste sur le conteneur ouvert (SPK-45, §37.7.2).
 *
 * Après le geste, la console RELIT l'inventaire immédiatement au lieu d'attendre
 * la cadence de cinq secondes : un écran qui montrerait encore « en marche »
 * quatre secondes après un arrêt réussi ferait douter du geste et inviterait à
 * le rejouer.
 *
 * L'écran n'écrit jamais l'état qu'il SUPPOSE atteint. Il écrit ce que
 * l'inspection relue lui rend (§14.9).
 */
async function porterGeste(nom, geste) {
  const d = etat.docker;
  d.confirme = null;
  d.enCours = geste;
  d.issue = null;
  peindre();
  try {
    const reponse = await fetch('/api/spark/container/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server: etat.server, spark: etat.spark.name,
                             name: nom, action: geste }),
    });
    const corps = await reponse.json();
    // Un 423 porte un REFUS, pas une panne : son corps est celui qu'on affiche.
    d.issue = reponse.ok || reponse.status === 423
      ? corps
      : { state: 'echec', refus: 'route',
          titre: 'Le geste n’est pas parti',
          detail: corps?.message ?? `HTTP ${reponse.status}` };
  } catch (erreur) {
    // §14.6 : ne pas avoir pu joindre la console n'est pas « le geste a échoué
    // sur le Spark ». On ne sait pas ce qui s'est passé, et on le dit.
    d.issue = { state: 'echec', refus: 'reseau',
                titre: 'La console n’a pas répondu',
                detail: `${erreur?.message ?? erreur}. L’état du conteneur est `
                  + `inconnu : relisez-le avant de rejouer le geste.` };
  }
  d.enCours = null;
  peindre();
  // On RELIT, quoi qu'il soit arrivé : même un geste refusé a pu croiser un
  // changement d'état, et c'est la Forge qui fait autorité.
  if (d.ouvert === nom) {
    d.detail = 'en-cours';
    lireDetail(nom);
  }
}

/**
 * Ouvre un terminal DANS un conteneur, depuis sa fiche (SPK-45, §37.4.7).
 *
 * La session vit sur l'onglet Terminal — SPK-DS-04 : le terminal n'est ni une
 * section ni une modale, il a sa surface. En ouvrir une sous l'onglet Docker
 * donnerait deux terminaux à deux endroits.
 */
function entrerDansConteneur(nom) {
  if (!nom) return;
  const base = `#/sparks/${encodeURIComponent(etat.spark.name)}`;
  // On demande la session AVANT de naviguer : le changement de facette remet
  // l'état Docker à zéro, et le nom du conteneur serait perdu en chemin.
  location.hash = `${base}/terminal`;
  ouvrirTerminal('ssh', nom);
}

document.addEventListener('click', (evenement) => {
  const geste = evenement.target.closest?.('[data-geste], [data-geste-confirme], [data-geste-annule]');
  if (!geste) return;
  const d = etat.docker;
  if (geste.dataset.gesteAnnule) {
    // Le déclencheur est relevé AVANT d'effacer l'état : après, on ne saurait
    // plus à quel bouton rendre le focus.
    const declencheur = d.confirme;
    d.confirme = null;
    peindre();
    // §6.22 : l'annulation rend le focus au déclencheur.
    document.querySelector(`[data-geste="${declencheur}"]`)?.focus();
    return;
  }
  if (geste.dataset.gesteConfirme) {
    return void porterGeste(geste.dataset.conteneur, geste.dataset.gesteConfirme);
  }
  d.confirme = geste.dataset.geste;
  d.issue = null;
  peindre();
  // §6.22 : le focus ENTRE dans la confirmation.
  document.querySelector('.confirmation [data-geste-confirme]')?.focus();
});

document.addEventListener('click', (evenement) => {
  const bouton = evenement.target.closest?.('[data-docker]');
  if (!bouton) return;
  const geste = bouton.dataset.docker;
  if (geste === 'ouvrir') return void ouvrirConteneur(bouton.dataset.conteneur);
  if (geste === 'fermer') return void fermerConteneur();
  if (geste === 'relire') {
    etat.docker.journaux = 'en-cours';
    peindre();
    lireJournauxConteneur(bouton.dataset.conteneur);
    return;
  }
  if (geste === 'terminal') {
    // §37.4.7 : on va sur l'onglet Terminal, comme un exploitant le ferait —
    // c'est LÀ que vit une session, et en ouvrir une sous l'onglet Docker
    // donnerait deux terminaux à deux endroits (SPK-DS-04).
    entrerDansConteneur(bouton.dataset.conteneur);
  }
});

// §37.6 : la collecte CESSE quand l'onglet est quitté.
window.addEventListener('hashchange', () => {
  if (location.hash.includes('/docker')) return;
  arreterDocker();
  // Y revenir doit repartir de la LISTE : retrouver un journal figé qu'on n'a
  // pas demandé ferait lire un texte périmé comme s'il était courant.
  Object.assign(etat.docker, { ouvert: null, detail: null, journaux: null,
                               confirme: null, enCours: null, issue: null });
});
window.addEventListener('pagehide', arreterDocker);

// §37.4 : quitter l'onglet TERMINE la session. Sans cela, un shell root
// survivrait à l'écran qui l'a ouvert, et personne ne s'en souviendrait.
window.addEventListener('hashchange', () => {
  if (etat.terminal.session && !location.hash.endsWith('/terminal')) {
    fermerTerminal('sortie');
  }
});
// Fermer l'onglet du navigateur vaut quitter : `sendBeacon` part même quand la
// page se démonte, là où un `fetch` serait abandonné.
window.addEventListener('pagehide', () => {
  const session = etat.terminal.session;
  if (!session) return;
  navigator.sendBeacon?.(
    `/api/terminal/fermeture?id=${encodeURIComponent(session.id)}`, new Blob());
});
// §37.4.3 : le redimensionnement de la fenêtre se propage au Spark.
// Le `ResizeObserver` posé sur la grille xterm couvre aussi les changements de
// largeur qui ne passent pas par `window.resize` (tiroir de sessions, zoom).

function brancherPanneaux() {
  const admin = etat.admin;

  // Les trois panneaux, nommés : `[data-ouvre]` capterait aussi le déclencheur
  // du catalogue, qui vit sur une autre destination et a son propre état.
  for (const bouton of racine.querySelectorAll(
    '[data-ouvre="route"], [data-ouvre="key"], [data-ouvre="snapshot"],'
    + ' [data-ouvre="protection"], [data-ouvre="port"], [data-ouvre="recette"]')) {
    bouton.addEventListener('click', () => {
      admin.open = bouton.dataset.ouvre;
      admin.refusal = null;
      admin.confirming = null;
      peindre();
      // SPK-50 : le catalogue et les zones se lisent à l'OUVERTURE, pas au
      // chargement de l'écran — interroger un fournisseur extérieur à chaque
      // affichage d'un Spark rendrait le détail tributaire d'un service dont il
      // n'a pas besoin.
      if (admin.open === 'recette') chargerRecettes();
      // Le focus entrant appartient à `brancherModale` (§6.27).
    });
  }
  // SPK-57 · §49 : la modale des quotas. Elle a son propre état parce que son
  // SUJET est la section « Ressources » et non les panneaux d'administration —
  // les mêler ferait qu'ouvrir l'une fermerait l'autre (§6.27).
  racine.querySelector('[data-ouvre="quotas"]')?.addEventListener('click', () => {
    const q = etat.quotas;
    q.open = true;
    q.refusal = null;
    // Les valeurs viennent du Spark AFFICHÉ, jamais de champs vides : faire
    // ressaisir de mémoire ce qui est déjà à l'écran invite à se tromper d'ordre
    // de grandeur, et c'est précisément ce qu'un quota ne pardonne pas.
    q.values = {
      memory_gib: String(Math.round(etat.spark.memory_reservation_bytes / 1024 ** 3)),
      storage_gib: String(Math.round(etat.spark.storage_bytes / 1024 ** 3)),
      network_mbps: String(Math.round(etat.spark.network_burst_bps / 1e6)),
      // §49.2 : le mode CPU se redimensionne, et ses réglages DÉPENDENT de lui.
      // On les pré-remplit tous les trois : changer de mode puis revenir ne doit
      // pas avoir effacé ce qu'on n'a pas touché.
      cpu_mode: etat.spark.cpu_mode,
      cpu_reservation: etat.spark.cpu_reservation ?? '',
      cpu_max: etat.spark.cpu_max ?? '',
      cpu_cores: etat.spark.cpu_cores ?? '',
    };
    peindre();
    // Le focus entrant, `Échap` et la restitution du focus sont tenus par
    // `brancherModale` (§6.27).
  });

  // SPK-58 · §43 : les deux sections de la facette Environnement. Elles ont leur
  // propre état, comme les quotas et pour le même motif : leur SUJET est la
  // section, pas les panneaux d'administration (§6.27).
  for (const bouton of racine.querySelectorAll('[data-ouvre-env]')) {
    bouton.addEventListener('click', () => {
      const e = etat.envUi;
      e.open = bouton.dataset.ouvreEnv;
      e.refusal = null;
      // Champs VIDES, et c'est voulu : on pose une variable neuve, on ne
      // modifie pas celle d'à côté. Pré-remplir ferait croire qu'on édite.
      e.values = { name: '', value: '', secret: false };
      peindre();
    });
  }
  for (const bouton of racine.querySelectorAll('[data-env-retire]')) {
    bouton.addEventListener('click', () => retirerEnv(
      bouton.dataset.envRetire, bouton.dataset.envPortee));
  }
  for (const bouton of racine.querySelectorAll('[data-env-decocher]')) {
    bouton.addEventListener('click', () => changerSelectionEnv(
      bouton.dataset.envDecocher, false));
  }
  for (const caseACocher of racine.querySelectorAll('[data-descend]')) {
    caseACocher.addEventListener('change', () => changerSelectionEnv(
      caseACocher.dataset.descend, caseACocher.checked));
  }
  for (const niveau of ['forge', 'spark']) {
    const formulaire = racine.querySelector(`[data-modale="env-${niveau}"]`);
    if (!formulaire) continue;
    for (const controle of formulaire.querySelectorAll('input')) {
      controle.addEventListener('input', () => {
        // Sans repeindre : `innerHTML` arracherait le focus en cours de frappe
        // (§14.3).
        const champ = { env_name: 'name', env_value: 'value',
                        env_secret: 'secret' }[controle.name];
        if (champ) {
          etat.envUi.values[champ] =
            controle.type === 'checkbox' ? controle.checked : controle.value;
        }
      });
    }
    formulaire.addEventListener('submit', (evenement) => {
      evenement.preventDefault();
      poserEnv(niveau);
    });
  }

  const quotas = racine.querySelector('[data-modale="quotas"]');
  if (quotas) {
    for (const controle of quotas.querySelectorAll('input')) {
      controle.addEventListener('input', () => {
        // On ne repeint PAS à chaque frappe : `innerHTML` reconstruirait la
        // modale et arracherait le focus au clavier (§14.3).
        etat.quotas.values[CLES_QUOTA[controle.name] ?? controle.name] = controle.value;
      });
    }
    // Le MODE, lui, repeint : il décide des champs affichés, et en laisser
    // saisir qui seront ignorés serait un contrôle mort (§1.4). C'est un
    // `select`, donc le focus se replace dessus sans être arraché en cours de
    // frappe — le motif du §14.3 ne s'applique pas ici.
    const modeCpu = quotas.querySelector('[name="cpu_mode"]');
    modeCpu?.addEventListener('change', () => {
      etat.quotas.values.cpu_mode = modeCpu.value;
      peindre();
      racine.querySelector('[name="cpu_mode"]')?.focus();
    });
    quotas.addEventListener('submit', (evenement) => {
      evenement.preventDefault();
      appliquerQuotas();
    });
  }

  // L'annulation et `Échap` sont tenus par `brancherModale` (§6.27) : un seul
  // endroit pour un seul contrat.
  for (const bouton of racine.querySelectorAll('[data-annule]')) {
    bouton.addEventListener('click', () => {
      admin.confirming = null;
      admin.refusal = null;
      peindre();
    });
  }

  const formulaire = racine.querySelector(
    '[data-modale="route"], [data-modale="key"], [data-modale="snapshot"],'
    + ' [data-modale="protection"], [data-modale="dns"], [data-modale="port"],'
    + ' [data-modale="recette"]');
  if (formulaire) {
    for (const controle of formulaire.querySelectorAll('input, select')) {
      controle.addEventListener('input', () => {
        admin.values[controle.name] =
          controle.type === 'checkbox' ? controle.checked
          : controle.type === 'number' ? Number(controle.value)
          : controle.value;
        // SPK-47 · §38.3 : l'aperçu de l'enregistrement suit la saisie. On le
        // met à jour SUR PLACE : repeindre à chaque frappe déplacerait le
        // curseur, et un aperçu figé montrerait une valeur qui ne sera pas
        // écrite. Mesuré par le parcours E2E.
        const vue = racine.querySelector('#dns-apercu');
        if (vue) vue.textContent = apercu(admin.dns.domain, admin.values);
      });
      // Le changement de ZONE vise un autre enregistrement : on relit ce qui est
      // en place. `change` et non `input` — une frappe dans l'adresse ne doit pas
      // déclencher une requête par caractère.
      if (controle.name === 'dns_zone') {
        controle.addEventListener('change', () => lireEffetDns());
      }
      if (controle.name === 'dns_address') {
        controle.addEventListener('change', () => lireEffetDns());
      }
      // SPK-50 : changer de recette, de zone ou d'un paramètre relit l'aperçu.
      if (['recette', 'recette_zone'].includes(controle.name)) {
        controle.addEventListener('change', () => { peindre(); lireApercuRecette(); });
      }
    }
    formulaire.addEventListener('submit', (evenement) => {
      evenement.preventDefault();
      const quoi = formulaire.dataset.modale;
      if (quoi === 'route') return declarerRoute();
      if (quoi === 'key') return autoriserCle();
      if (quoi === 'snapshot') return prendreInstantane();
      if (quoi === 'protection') return basculerProtection();
      if (quoi === 'dns') return poserEnregistrementDns();
      if (quoi === 'port') return publierPort();
      if (quoi === 'recette') return ecrireRecette();
    });
  }

  // Demandes de confirmation : elles n'appellent rien, elles ouvrent le bloc.
  const demande = (attribut, kind) => {
    for (const bouton of racine.querySelectorAll(`[data-${attribut}]`)) {
      bouton.addEventListener('click', () => {
        admin.confirming = { kind, id: bouton.getAttribute(`data-${attribut}`) };
        admin.refusal = null;
        peindre();
        // §6.22 : le focus entre dans la confirmation.
        racine.querySelector('.confirmation .bouton--destructif')?.focus();
      });
    }
  };
  // SPK-47 · §38 : « DNS » ouvre une modale portant sur CETTE route. Le domaine
  // n'est pas saisi, il est repris de la route ; l'adresse est pré-remplie avec
  // celle du serveur courant, qui EST la Forge.
  // SPK-50 · §38.6 : les paramètres d'une recette sont DYNAMIQUES — ils
  // dépendent de la recette choisie —, d'où `data-param` plutôt qu'un `name`
  // fixe. Sans ces écoutes, l'aperçu restait sur « Aucun domaine fourni » quoi
  // qu'on saisisse. Mesuré par le parcours E2E.
  for (const controle of racine.querySelectorAll('[data-param]')) {
    controle.addEventListener('input', () => {
      admin.values.recette_params = { ...admin.values.recette_params,
                                      [controle.dataset.param]: controle.value };
    });
    controle.addEventListener('change', () => lireApercuRecette());
  }

  for (const bouton of racine.querySelectorAll('[data-dns-route]')) {
    bouton.addEventListener('click', () => ouvrirDns(bouton.dataset.dnsRoute));
  }

  demande('retire-route', 'route');
  demande('retire-port', 'port');
  demande('restaure', 'snapshot-restore');
  demande('supprime-instantane', 'snapshot-delete');

  const geste = (attribut, action) => {
    for (const bouton of racine.querySelectorAll(`[data-${attribut}]`)) {
      bouton.addEventListener('click', () => action(bouton.getAttribute(`data-${attribut}`)));
    }
  };
  geste('confirme-route', (domaine) =>
    agir('route', () => appel('DELETE', `/v1/ingress/${encodeURIComponent(domaine)}`)));
  geste('reapplique', () =>
    agir('route', () => appel('POST', '/v1/ingress/reconcile')));
  // §35.2 : révoquer n'est jamais refusé par la protection. Le premier appel
  // peut rendre la liste NOMMÉE des Sparks protégés touchés ; le second porte
  // l'acceptation. Aucun mot de passe, et aucune protection levée.
  const revoquer = (label, accepte) => agir('key', () => appel(
    'DELETE',
    `/v1/sparks/${encodeURIComponent(etat.spark.name)}/ssh-keys/${encodeURIComponent(label)}`,
    accepte ? { accept_protected: true } : null,
  )).then((resultat) => {
    if (!resultat.ok && etat.admin.refusal?.protected_sparks) {
      // L'étiquette n'est pas dans la réponse : le bouton d'acceptation doit
      // pourtant savoir QUELLE clé il révoque.
      etat.admin.refusal.label = label;
      peindre();
    }
    return resultat;
  });
  geste('revoque', (label) => revoquer(label, false));
  // L'acceptation n'est atteignable qu'APRÈS le refus, comme au §26.5.
  geste('accepte-protege', (label) => revoquer(label, true));
  geste('confirme-suppression', (nom) =>
    agir('snapshot', () => appel('DELETE',
      `/v1/sparks/${encodeURIComponent(etat.spark.name)}/snapshots/${encodeURIComponent(nom)}`)));
  geste('confirme-port', (port) =>
    agir('port', () => appel('DELETE', `/v1/ports/${encodeURIComponent(port)}`)));
  geste('confirme-restauration', (nom) => restaurer(nom, false));
  // §26.5 : l'acceptation de la perte n'est atteignable qu'APRÈS le refus.
  geste('accepte-perte', (nom) => restaurer(nom, true));
}

/**
 * Un geste RELAYÉ vers la Forge, dont on retient s'il est parti SIGNÉ.
 *
 * @spec docs/BACKLOG.md#SPK-40 · docs/DAT.md §36.10.9 (l'échec de signature se
 *       dit dans la coquille), §36.10.1 (le geste passe quand même) ·
 *       docs/DESIGN_SYSTEM.md §25.1 (le rouge est réservé au refus du serveur)
 *
 * Tout ce qui MUTE la Forge passe par ici, et par ici seulement : sept appels
 * dispersés qui liraient chacun l'en-tête finiraient par en oublier un, et
 * l'échec y serait tu — exactement ce que le §36.10.8 interdit.
 *
 * La réponse est rendue INTACTE : l'appelant en fait ce qu'il faisait déjà, et
 * un `catch` posé derrière continue de fonctionner.
 */
async function relais(chemin, options = {}) {
  const reponse = await fetch(chemin, options);
  noterSignature(reponse);
  return reponse;
}

/**
 * Retient — ou efface — l'avertissement de signature du dernier geste.
 *
 * Il s'EFFACE de lui-même dès qu'un geste repart signé : un avertissement qui
 * survivrait à sa cause mentirait dans l'autre sens, et l'on désapprendrait à le
 * lire. Rien n'est repeint quand rien n'a changé — `peindre()` reconstruit
 * `.principal`, ce qui arracherait le focus au clavier (§14.3).
 */
function noterSignature(reponse) {
  const phrase = signatureMotifOf(reponse?.headers?.get?.('x-spark-signature-motif'));
  if (phrase === etat.signature) return;
  etat.signature = phrase;
  peindreSignature();
}

/** Du nom d'un champ de la modale vers sa clé d'état (SPK-57). Les unités font
 *  partie du nom d'état : « memory_gib » dit ce qu'on y met, « memory » non. */
const CLES_QUOTA = {
  memory: 'memory_gib', storage: 'storage_gib', network: 'network_mbps',
};

/**
 * Applique les nouveaux quotas d'un Spark (SPK-57, docs/DAT.md §49).
 *
 * @spec docs/BACKLOG.md#SPK-57 · docs/DAT.md §49.2 (registre puis cellule),
 *       §49.3 (un refus de rétrécissement n'est pas un refus d'admission) ·
 *       docs/DESIGN_SYSTEM.md §6.27 (le refus s'affiche DANS la modale et
 *       n'efface aucune saisie), §1.3 (pas de succès simulé)
 *
 * **Le refus reste dans la modale**, avec la saisie intacte : une modale qui se
 * refermerait sur un refus ferait perdre le travail ET cacherait la raison.
 */
/**
 * Pose une variable d'environnement (SPK-58, docs/DAT.md §43.9.5).
 *
 * Le refus reste DANS la modale, sans effacer la saisie (§6.27) : une modale qui
 * se refermerait ferait perdre le travail ET cacherait la raison.
 */
async function poserEnv(niveau) {
  const e = etat.envUi;
  e.busy = true;
  e.refusal = null;
  peindre();

  const nom = String(e.values.name || '').trim();
  const chemin = niveau === 'forge'
    ? `/v1/env/${encodeURIComponent(nom)}`
    : `/v1/sparks/${encodeURIComponent(etat.spark.name)}/env/${encodeURIComponent(nom)}`;

  // §18 : un échec ne se PERD pas. Sans ce filet, une promesse qui rejette —
  // réseau coupé, relais absent, corps illisible — laisserait la modale sur
  // « Envoi… » indéfiniment : le geste paraîtrait en cours alors que plus rien
  // ne court. Le gestionnaire de submit n'attend pas cette promesse, donc rien
  // d'autre ne rattraperait le rejet.
  let vu;
  try {
    vu = await appel('PUT', chemin,
                     { value: e.values.value, secret: Boolean(e.values.secret) });
  } catch (erreur) {
    e.busy = false;
    e.refusal = { niveau, message: `La requête n’a pas abouti : ${erreur.message}` };
    return peindre();
  }
  e.busy = false;

  if (!vu.ok) {
    e.refusal = { niveau,
                  message: vu.corps?.detail?.message ?? 'Le serveur a refusé cette variable.' };
    return peindre();
  }
  // §1.3 : rien n'est présenté comme réussi avant que la Forge ne l'ait rendu.
  e.open = false;
  await router();
}

/** Retire une entrée. Le geste est réversible : on la repose (§6.24). */
async function retirerEnv(nom, portee) {
  const chemin = portee === 'forge'
    ? `/v1/env/${encodeURIComponent(nom)}`
    : `/v1/sparks/${encodeURIComponent(etat.spark.name)}/env/${encodeURIComponent(nom)}`;
  let vu;
  try {
    vu = await appel('DELETE', chemin);
  } catch (erreur) {
    etat.envUi.refusal = { niveau: portee,
                           message: `La requête n’a pas abouti : ${erreur.message}` };
    return peindre();
  }
  if (!vu.ok) {
    etat.envUi.refusal = { niveau: portee,
                           message: vu.corps?.detail?.message ?? 'Le serveur a refusé ce retrait.' };
    return peindre();
  }
  await router();
}

/**
 * Coche ou décoche une entrée du catalogue pour CE Spark (SPK-64, §43.6).
 *
 * La case ne décide rien seule : le registre applique la sélection puis réécrit
 * les fichiers de la cellule (§43.2). Après sa réponse, on relit donc le détail
 * complet, plutôt que de conserver une coche optimiste qui pourrait mentir.
 */
async function changerSelectionEnv(nom, coche) {
  const chemin = `/v1/sparks/${encodeURIComponent(etat.spark.name)}`
    + `/env/selection/${encodeURIComponent(nom)}`;
  let vu;
  try {
    vu = await appel(coche ? 'POST' : 'DELETE', chemin);
  } catch (erreur) {
    etat.envUi.refusal = { niveau: 'selection',
                           message: `La requête n’a pas abouti : ${erreur.message}` };
    return peindre();
  }
  if (!vu.ok) {
    etat.envUi.refusal = { niveau: 'selection',
                           message: vu.corps?.detail?.message
                             ?? 'Le serveur a refusé cette sélection.' };
    return peindre();
  }
  etat.envUi.refusal = null;
  await chargerDetail(etat.spark.name, etat.facette);
}

async function appliquerQuotas() {
  const q = etat.quotas;
  q.busy = true;
  q.refusal = null;
  peindre();

  // §49.2 : on n'envoie QUE les réglages CPU du mode retenu. Envoyer les trois
  // ferait porter au registre une réservation sur un Spark plafonné — une valeur
  // que rien n'emploie, et que le prochain lecteur croirait vraie.
  const mode = q.values.cpu_mode || etat.spark.cpu_mode;
  const cpu = ['shared', 'shared-pinned'].includes(mode)
      ? { cpu_reservation: Number(q.values.cpu_reservation), cpu_max: null,
          cpu_cores: mode === 'shared-pinned' ? Number(q.values.cpu_cores) : null }
    : mode === 'capped'
      ? { cpu_max: Number(q.values.cpu_max), cpu_reservation: null, cpu_cores: null }
    : { cpu_cores: Number(q.values.cpu_cores), cpu_reservation: null, cpu_max: null };

  const corps = {
    cpu_mode: mode,
    ...cpu,
    memory_reservation_bytes: Math.round(Number(q.values.memory_gib) * 1024 ** 3),
    storage_bytes: Math.round(Number(q.values.storage_gib) * 1024 ** 3),
    network_reservation_bps: Math.round(Number(q.values.network_mbps) * 1e6),
  };

  const vu = await appel('PATCH', `/v1/sparks/${encodeURIComponent(etat.spark.name)}`, corps);
  q.busy = false;

  if (!vu.ok) {
    // Le runtime NOMME ses refus : « pas la place » et « ce que vous retirez est
    // utilisé » ne se disent pas pareil (§49.3). Les remplacer par un code HTTP
    // ferait deviner lequel des deux on a reçu.
    q.refusal = vu.corps?.detail?.message ?? vu.corps?.message
      ?? 'Le serveur a refusé ces quotas.';
    return peindre();
  }

  // §1.3 : rien n'est présenté comme réussi avant que la Forge ne l'ait rendu.
  // Le champ `applied` distingue « en vigueur » de « promis » (§49.2) ; on relit
  // donc l'état RÉEL plutôt que d'afficher ce qu'on a envoyé.
  q.open = false;
  await router();
}

/** Appel d'écriture. Rend toujours `{ ok, corps }` : un refus est une réponse,
 *  pas une exception à faire remonter jusqu'à l'écran d'erreur global. */
async function appel(methode, chemin, corps = null) {
  const reponse = await relais(
    `/api${chemin}${chemin.includes('?') ? '&' : '?'}server=${encodeURIComponent(etat.server)}`,
    { method: methode, ...(corps ? { headers: { 'content-type': 'application/json' },
                                     body: JSON.stringify(corps) } : {}) });
  let rendu = null;
  try { rendu = await reponse.json(); } catch { /* corps vide */ }
  return { ok: reponse.ok, corps: rendu };
}

/**
 * Exécute un geste, puis RELIT l'état (§26.6). Aucun optimisme d'interface :
 * ces gestes touchent au réseau et au disque, et un état relu vaut mieux qu'un
 * état deviné.
 */
async function agir(panneau, operation, { ferme = true } = {}) {
  etat.admin.busy = true;
  peindre();
  let resultat;
  try {
    resultat = await operation();
  } catch (erreur) {
    resultat = { ok: false, corps: { detail: { message: erreur.message } } };
  }
  etat.admin.busy = false;
  if (!resultat.ok) {
    const detail = resultat.corps?.detail ?? resultat.corps ?? {};
    etat.admin.refusal = {
      panel: panneau,
      message: detail.message ?? 'Le serveur a refusé ce geste.',
      // §35.2 : la liste NOMMÉE des Sparks protégés voyage avec le refus, sinon
      // la confirmation ne pourrait que les compter.
      ...(detail.protected_sparks ? { protected_sparks: detail.protected_sparks } : {}),
    };
    etat.admin.confirming = null;
    peindre();
    return resultat;
  }
  etat.admin.confirming = null;
  etat.admin.refusal = null;
  if (ferme) etat.admin.open = null;
  await chargerDetail(etat.spark.name, etat.facette);
  return resultat;
}

/**
 * Arme ou lève la protection (SPK-34, docs/DAT.md §35.5).
 *
 * Une seule modale pour les deux sens : ce qui change est le titre du bouton et
 * la méthode, jamais la surface. Lever DÉSARME durablement — il n'y a pas de
 * fenêtre de temps à surveiller (§35.4).
 */
async function basculerProtection() {
  const arme = Boolean(etat.spark?.protected);
  const mot = etat.admin.values.password;
  const resultat = await agir('protection', () =>
    appel(arme ? 'DELETE' : 'POST',
          `/v1/sparks/${encodeURIComponent(etat.spark.name)}/protection`,
          { password: mot }));
  // Le mot de passe ne SURVIT PAS au geste, réussi ou refusé : le garder en
  // mémoire de l'écran le laisserait dans un champ que la modale suivante
  // rouvrirait pré-rempli.
  etat.admin.values.password = '';
  return resultat;
}

async function declarerRoute() {
  const v = etat.admin.values;
  // §26.3 : aucun contrôle d'unicité ici. Le domaine est UNIQUE en base.
  const resultat = await agir('route', () => appel('POST', '/v1/ingress', {
    spark: etat.spark.name, domain: v.domain, port: Number(v.port), tls: Boolean(v.tls),
  }));
  if (resultat?.ok) {
    etat.admin.values = { ...ADMIN_VIDE.values };
    // SPK-48 · §18.3 bis : la déclaration a réussi ET elle a détourné une
    // adresse. Le serveur le dit ; l'écran doit le répéter, sinon personne ne
    // le saura. `agir` a déjà repeint, d'où ce second passage.
    etat.admin.supersedes = resultat.corps?.supersedes ?? null;
    if (etat.admin.supersedes) peindre();
  }
}

/**
 * Ouvre « Pointer le domaine » et LIT les zones du compte (SPK-47, §38.2).
 *
 * La lecture a lieu à l'ouverture, pas au chargement de l'écran : interroger un
 * fournisseur extérieur à chaque affichage d'un Spark rendrait le détail
 * tributaire d'un service dont il n'a pas besoin.
 */
async function ouvrirDns(domaine) {
  const admin = etat.admin;
  admin.open = 'dns';
  admin.refusal = null;
  admin.confirming = null;
  admin.dns = { ...ADMIN_VIDE.dns, domain: domaine, loading: true };
  // L'adresse par défaut est celle du serveur courant : c'est la Forge, et la
  // retaper de mémoire est le meilleur moyen de se tromper d'un chiffre.
  admin.values.dns_address =
    etat.servers.find((s) => s.name === etat.server)?.host ?? '';
  peindre();

  let corps;
  try {
    corps = await (await fetch('/api/dns/zones')).json();
  } catch (erreur) {
    corps = { configured: false, reason: `Fournisseur DNS injoignable : ${erreur.message}` };
  }
  admin.dns = {
    ...admin.dns, loading: false,
    configured: corps.configured ?? false,
    reason: corps.reason ?? corps.message ?? null,
    zones: corps.zones ?? [],
  };
  // La zone la plus spécifique est PRÉ-CHOISIE, jamais imposée : on peut la
  // changer, et rien n'est écrit avant l'engagement.
  admin.values.dns_zone = zonePour(domaine, admin.dns.zones);
  peindre();
  await lireEffetDns();
}

/**
 * Demande ce que l'écriture ferait, SANS l'écrire (SPK-47 révisé, §38.5.2).
 *
 * C'est ce qui remplace le refus d'écrire à l'apex. On relit à chaque changement
 * de ZONE, parce que le même domaine dans une autre zone vise un autre
 * enregistrement — mais pas à chaque frappe dans l'adresse : une requête par
 * caractère saturerait le fournisseur pour ne rien apprendre de plus.
 */
async function lireEffetDns() {
  const admin = etat.admin;
  const { domain } = admin.dns;
  const v = admin.values;

  // On remplace le bloc SUR PLACE. Repeindre reconstruirait le formulaire sous
  // les doigts : le focus repartirait au premier champ, et le bouton
  // d'engagement se détacherait sous le clic. Mesuré par le parcours E2E.
  const montrer = () => {
    const bloc = racine.querySelector('#dns-effet');
    if (bloc) bloc.innerHTML = renderEffet(admin.dns);
  };

  if (!domain || !v.dns_zone || !v.dns_address) {
    admin.dns = { ...admin.dns, apercu: null, apercuEnCours: false, lu: null };
    return montrer();
  }
  // Relire des valeurs IDENTIQUES n'apprend rien et coûte une requête au
  // fournisseur. Surtout, `change` se déclenche AUSSI à la perte du focus —
  // donc au moment même où l'on clique sur le bouton d'engagement.
  const cle = `${domain}|${v.dns_zone}|${v.dns_address}`;
  if (admin.dns.lu === cle) return;

  admin.dns = { ...admin.dns, apercuEnCours: true, lu: cle };
  montrer();

  let vu = null;
  try {
    const reponse = await fetch('/api/dns/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain, zone: v.dns_zone, address: v.dns_address }),
    });
    vu = reponse.ok ? await reponse.json() : null;
  } catch {
    // Ne pas avoir pu LIRE n'est pas « rien n'est là » : on n'affiche alors
    // aucun effet, plutôt qu'un « sera posé » qui pourrait être faux (§33.3).
    vu = null;
  }
  // Une réponse ARRIVÉE n'est pas forcément la réponse ATTENDUE : une première
  // lecture lente peut revenir après une seconde, et écraser un résultat plus
  // récent par un plus ancien. Mesuré contre le vrai fournisseur — l'écran
  // annonçait le remplacement de l'adresse pré-remplie, pas de celle saisie.
  if (admin.dns.lu !== cle) return;
  admin.dns = { ...admin.dns, apercu: vu, apercuEnCours: false };
  montrer();
}

/**
 * Pose l'enregistrement d'ingress (SPK-47, §38.3).
 *
 * Le résultat annonce ce qui est ÉCRIT et le délai de propagation, jamais un
 * domaine « prêt » (§38.4).
 */
async function poserEnregistrementDns() {
  const v = etat.admin.values;
  const domaine = etat.admin.dns.domain;
  const resultat = await agir('dns', async () => {
    const reponse = await fetch('/api/dns/record', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: domaine, zone: v.dns_zone, address: v.dns_address }),
    });
    const corps = await reponse.json().catch(() => null);
    // `agir` lit le refus dans `detail` : l'hôte console, lui, rend `message` à
    // plat. On l'y remet plutôt que d'apprendre deux formes à `agir`.
    return { ok: reponse.ok,
             corps: reponse.ok ? corps : { detail: { message: corps?.message ?? 'Refus du fournisseur DNS.' } } };
  });
  if (resultat?.ok) {
    etat.admin.dns = { ...etat.admin.dns, written: resultat.corps };
    // `agir` a déjà repeint en fermant la modale : sans ce second passage, ce
    // qui a été écrit ne s'afficherait qu'au prochain rendu, donc jamais.
    peindre();
  }
}

/**
 * Publie un port de la Forge vers ce Spark (SPK-49, §39).
 *
 * Aucun contrôle d'unicité ici : le port public est UNIQUE en base, et une
 * vérification d'interface ne protégerait de rien face à deux consoles.
 */
async function publierPort() {
  const v = etat.admin.values;
  const resultat = await agir('port', () => appel('POST', '/v1/ports', {
    spark: etat.spark.name,
    public_port: Number(v.public_port), target_port: Number(v.target_port),
    protocol: v.protocol || 'tcp', note: v.port_note ?? '',
  }));
  if (resultat?.ok) etat.admin.values = { ...ADMIN_VIDE.values };
}

/** Lit le catalogue et les zones (SPK-50, §38.6.5). */
async function chargerRecettes() {
  const admin = etat.admin;
  admin.recettes = { ...ADMIN_VIDE.recettes, chargement: true };
  peindre();
  try {
    const [catalogue, zones] = await Promise.all([
      fetch('/api/dns/recipes').then((r) => r.json()),
      fetch('/api/dns/zones').then((r) => r.json()),
    ]);
    admin.recettes = { ...ADMIN_VIDE.recettes,
                       catalogue: catalogue.recipes ?? [],
                       zones: zones.zones ?? [],
                       erreur: zones.configured === false ? zones.reason : null };
  } catch (erreur) {
    admin.recettes = { ...ADMIN_VIDE.recettes, erreur: erreur.message };
  }
  peindre();
}

/**
 * Demande ce que la recette écrirait, SANS l'écrire (§38.6.3).
 *
 * Remplacé sur place, comme l'effet du §38.5.2 : repeindre reconstruirait le
 * formulaire sous les doigts et déroberait le bouton d'engagement.
 */
async function lireApercuRecette() {
  const admin = etat.admin;
  const v = admin.values;
  const montrer = () => {
    const bloc = racine.querySelector('#recette-apercu');
    if (bloc) bloc.innerHTML = renderRecetteApercu(admin.recettes);
  };
  // Même garde qu'au §38.5.2, et pour la même raison mesurée : plusieurs
  // lectures se chevauchent — un changement de recette, de zone, puis chaque
  // paramètre —, et la dernière ARRIVÉE n'est pas la dernière DEMANDÉE. Sans
  // cette clé, un refus immédiat « Aucun domaine fourni » écrasait l'aperçu
  // complet obtenu après un aller-retour réseau.
  const cle = `${v.recette}|${v.recette_zone}|${JSON.stringify(v.recette_params ?? {})}`;
  // Relire des valeurs IDENTIQUES n'apprend rien et coûte une requête. Surtout,
  // `change` se déclenche à la perte du focus — donc au moment du clic sur le
  // bouton d'engagement (§38.5.2, même mesure).
  if (admin.recettes.lu === cle) return;
  if (!v.recette || !v.recette_zone) {
    admin.recettes = { ...admin.recettes, apercu: null, erreur: null, lu: cle };
    return montrer();
  }
  admin.recettes = { ...admin.recettes, chargement: true, erreur: null, lu: cle };
  montrer();
  try {
    const reponse = await fetch('/api/dns/recipe/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recipe: v.recette, zone: v.recette_zone,
                             params: v.recette_params ?? {} }),
    });
    const corps = await reponse.json();
    if (admin.recettes.lu !== cle) return;
    admin.recettes = reponse.ok
      ? { ...admin.recettes, apercu: corps, chargement: false, erreur: null }
      : { ...admin.recettes, apercu: null, chargement: false,
          erreur: corps.message ?? 'Aperçu impossible.' };
  } catch (erreur) {
    if (admin.recettes.lu !== cle) return;
    admin.recettes = { ...admin.recettes, apercu: null, chargement: false,
                       erreur: erreur.message };
  }
  montrer();
}

/** Écrit la recette, et rend le sort de chaque ligne (§38.6.3). */
async function ecrireRecette() {
  const v = etat.admin.values;
  const resultat = await agir('recette', async () => {
    const reponse = await fetch('/api/dns/recipe', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recipe: v.recette, zone: v.recette_zone,
                             params: v.recette_params ?? {} }),
    });
    const corps = await reponse.json().catch(() => null);
    return { ok: reponse.ok,
             corps: reponse.ok ? corps
               : { detail: { message: corps?.message ?? 'Refus du fournisseur DNS.' } } };
  });
  if (resultat?.ok) {
    etat.admin.recettes = { ...etat.admin.recettes, resultat: resultat.corps };
    peindre();
  }
}

async function autoriserCle() {
  const v = etat.admin.values;
  const nom = etat.spark.name;
  const resultat = await agir('key', async () => {
    // Enregistrer puis accorder restent DEUX effets (§26.4) : la console les
    // enchaîne, elle ne les confond pas.
    if (v.new_label && v.public_key) {
      const inscrit = await appel('POST', '/v1/ssh-keys',
                                  { label: v.new_label, public_key: v.public_key });
      if (!inscrit.ok) return inscrit;
      return appel('POST', `/v1/sparks/${encodeURIComponent(nom)}/ssh-keys/${encodeURIComponent(v.new_label)}`);
    }
    if (!v.key_label) {
      return { ok: false, corps: { detail: {
        message: 'Choisissez une clé du registre, ou saisissez un libellé et une clé publique.' } } };
    }
    return appel('POST', `/v1/sparks/${encodeURIComponent(nom)}/ssh-keys/${encodeURIComponent(v.key_label)}`);
  });
  if (resultat?.ok) etat.admin.values = { ...ADMIN_VIDE.values };
}

async function prendreInstantane() {
  const resultat = await agir('snapshot', () => appel(
    'POST', `/v1/sparks/${encodeURIComponent(etat.spark.name)}/snapshots`,
    { name: etat.admin.values.snapshot }));
  if (resultat?.ok) etat.admin.values = { ...ADMIN_VIDE.values };
}

/**
 * Restaure. Un refus « des instantanés plus récents bloquent » n'est pas une
 * erreur générique : il porte la liste de ce qui serait détruit, et c'est cette
 * liste qui rend la perte visible avant qu'on l'accepte (§26.5).
 */
async function restaurer(nom, accepteLaPerte) {
  const resultat = await agir('snapshot', () => appel(
    'POST', `/v1/sparks/${encodeURIComponent(etat.spark.name)}/snapshots/${encodeURIComponent(nom)}/restore`,
    accepteLaPerte ? { accept_losing_newer: true } : {}));
  const detail = resultat?.corps?.detail;
  if (!resultat?.ok && detail?.error === 'blocked_by_newer_snapshots') {
    etat.admin.refusal = { panel: 'snapshot', snapshot: nom,
                           message: detail.message, blocking: detail.blocking ?? [] };
    peindre();
    racine.querySelector('[data-accepte-perte]')?.focus();
  }
}

async function lancer(commande) {
  etat.confirming = null;
  etat.status = 'loading';
  peindre();
  try {
    await relais(`/api/v1/sparks/${encodeURIComponent(etat.spark.name)}/${commande}?server=${encodeURIComponent(etat.server)}`,
                 { method: 'POST' });
  } catch { /* l'état réel sera relu ci-dessous */ }
  if (commande === 'delete') { location.hash = '#/sparks'; return router(); }
  await router();
}

async function api(chemin) {
  const reponse = await fetch(`/api${chemin}${chemin.includes('?') ? '&' : '?'}server=${encodeURIComponent(etat.server)}`);
  const corps = await reponse.json();
  if (!reponse.ok) {
    const erreur = new Error(corps?.detail?.message ?? corps?.message ?? `HTTP ${reponse.status}`);
    erreur.tunnel = corps?.tunnel ?? null;
    // Le runtime nomme ses refus ; l'appelant en a besoin pour distinguer un
    // état nommé d'une panne (docs/DAT.md §27.8).
    erreur.code = corps?.detail?.error ?? null;
    throw erreur;
  }
  return corps;
}

async function chargerCreation() {
  etat.route = 'creation';
  // Le formulaire n'est peint QU'UNE FOIS, une fois les données là.
  //
  // Il l'était deux fois : une fois vide, puis une fois les pools reçus. Une
  // saisie faite entre les deux était effacée par le second rendu, qui repeint
  // depuis `etat.creation.values` avant que les écouteurs de la première peinture
  // n'aient pu y écrire. Trouvé par le parcours E2E, la fenêtre s'étant élargie
  // quand le catalogue a ajouté une seconde requête.
  etat.status = 'loading';
  peindre();
  try {
    // Le catalogue alimente la liste : seules les images que le dernier relevé
    // a trouvées sont proposées (docs/DAT.md §33.5).
    const catalogue = await api('/v1/images').catch(() => ({ images: [] }));
    etat.creation.images = (catalogue.images ?? []).filter((i) => i.state === 'verified');
    if (etat.creation.images.length && !etat.creation.images
        .some((i) => i.reference === etat.creation.values.image)) {
      const defaut = etat.creation.images.find((i) => i.is_default) ?? etat.creation.images[0];
      etat.creation.values.image = defaut.reference;
    }
    const forge = await api('/v1/forge');
    etat.creation.pools = forge.pools;
    // Les cœurs physiques bornent le curseur du mode dédié (SPK-DS-07). Ils ne
    // vivent pas dans les pools : le pool CPU compte des parts, pas des cœurs.
    etat.creation.cores = forge.cpu?.cores_total ?? null;
  } catch {
    // Capacité inconnue : l'écran le dit plutôt que d'inventer des chiffres.
    // Sans bornes, pas de curseur — les quotas redeviennent des saisies (§6.9 bis).
    etat.creation.pools = null;
    etat.creation.cores = null;
  }
  etat.status = 'ready';
  peindre();
}

async function creer() {
  // Contrôles de FORME seulement. La capacité, c'est sparkd qui tranche (§25.3).
  etat.creation.errors = validateShape(etat.creation.values);
  etat.creation.refusal = null;
  if (Object.keys(etat.creation.errors).length > 0) {
    peindre();
    // §6.12 : amener le premier champ concerné et y déplacer le focus.
    const premier = Object.keys(etat.creation.errors)[0];
    racine.querySelector(`#${premier}`)?.focus();
    return;
  }

  etat.creation.submitting = true;
  peindre();
  const v = etat.creation.values;
  const corps = {
    name: v.name, image: v.image, cpu_mode: v.cpu_mode,
    memory_bytes: Math.round(v.memory_gib * 1024 ** 3),
    network_bps: Math.round(v.network_mbit * 1e6),
    storage_bytes: Math.round(v.storage_gib * 1024 ** 3),
    ...(['shared', 'shared-pinned'].includes(v.cpu_mode) ? { cpu_reservation: v.cpu_reservation } : {}),
    ...(v.cpu_mode === 'capped' ? { cpu_max: v.cpu_max } : {}),
    ...(['dedicated', 'shared-pinned'].includes(v.cpu_mode) ? { cpu_cores: v.cpu_cores } : {}),
  };
  try {
    const reponse = await relais(`/api/v1/sparks?server=${encodeURIComponent(etat.server)}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corps) });
    const rendu = await reponse.json();
    if (!reponse.ok) {
      // Le refus vient du serveur, et la saisie reste intacte (§25.2).
      etat.creation.refusal = rendu?.detail ?? { message: rendu?.message ?? `HTTP ${reponse.status}` };
      etat.creation.submitting = false;
      peindre();
      racine.querySelector('.refus')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    etat.creation.values = { ...DEFAUTS };
    etat.creation.submitting = false;
    location.hash = `#/sparks/${encodeURIComponent(rendu.name)}`;
  } catch (erreur) {
    etat.creation.refusal = { message: erreur.message };
    etat.creation.submitting = false;
    peindre();
  }
}

async function chargerDetail(nom, facette = '') {
  etat.route = 'detail';
  etat.facette = facette;
  etat.status = 'loading';
  etat.error = null;
  // §37.6 : la collecte ne survit pas au changement de facette. Un relevé lancé
  // pour un Spark continuerait sinon à interroger l'ancien depuis l'écran du
  // suivant.
  arreterDocker();
  if (facette !== 'docker') etat.docker = { ...DOCKER_VIDE };
  // Le conteneur ouvert appartient à l'écran qui l'a demandé. Le garder en
  // changeant de Spark afficherait le conteneur de l'un sous le nom de l'autre.
  else Object.assign(etat.docker, { ouvert: null, detail: null, journaux: null,
                                    confirme: null, enCours: null, issue: null });
  peindre();
  try {
    etat.spark = await api(`/v1/sparks/${encodeURIComponent(nom)}`);
    const [usage, routes, sshConfig, registry, snapshots, audit, publies,
           env, catalogue] = await Promise.all([
      api(`/v1/sparks/${encodeURIComponent(nom)}/usage`).catch(() => null),
      api('/v1/ingress').then((r) => r.routes.filter((x) => x.spark_name === nom)).catch(() => []),
      api(`/v1/sparks/${encodeURIComponent(nom)}/ssh-config`).catch(() => null),
      api('/v1/ssh-keys').then((r) => r.keys).catch(() => []),
      api(`/v1/sparks/${encodeURIComponent(nom)}/snapshots`).then((s) => s.snapshots).catch(() => []),
      api('/v1/audit?limit=200').then((a) => a.entries.filter((e) => e.target_id === etat.spark.id)).catch(() => []),
      // SPK-49 · §39.2 : la liste est celle de la FORGE ; on ne garde que les
      // ports qui mènent à CE Spark, mais les réservés valent pour la machine.
      api('/v1/ports').catch(() => ({ ports: [], reserved: [] })),
      // SPK-58 · §43.9.4 : le jeu RÉSOLU, avec l'origine de chaque valeur. On
      // le demande au serveur plutôt que de croiser deux listes ici : la
      // surcharge est une règle métier, et l'écran n'en est pas l'autorité
      // (DESIGN_SYSTEM.md §1.2).
      api(`/v1/sparks/${encodeURIComponent(nom)}/env`).then((r) => r.env).catch(() => []),
      // SPK-64 · §43.6 révisé : le CATALOGUE de la Forge, pour que la facette
      // puisse offrir une case par entrée. Il est demandé même quand rien n'est
      // coché — c'est justement l'écran qui doit montrer ce qui NE descend pas.
      api('/v1/env').then((r) => r.env).catch(() => []),
    ]);
    etat.detail = { usage, routes, keys: sshConfig?.keys ?? [], registry, sshConfig,
                    snapshots, audit,
                    ports: (publies.ports ?? []).filter((p) => p.spark_id === etat.spark.id),
                    reservedPorts: publies.reserved ?? [], env, catalogue };
    etat.status = 'ready';
  } catch (erreur) {
    etat.status = 'error';
    etat.error = erreur;
  }
  peindre();
  const reprise = sessionAReprendre;
  if (reprise && etat.status === 'ready' && facette === 'terminal'
      && reprise.spark === etat.spark?.name && (!reprise.forge || reprise.forge === etat.server)) {
    sessionAReprendre = null;
    await suivreSessionTerminal(reprise);
  }
  // SPK-44 · §37.6 : la collecte commence à l'OUVERTURE de l'onglet, pas avant.
  // Un Spark dont on ne regarde pas le Docker n'est jamais interrogé.
  if (etat.facette === 'docker' && etat.status === 'ready') {
    releverDocker({ premier: true });
  }
}

/**
 * Écran des pools (docs/DAT.md §27).
 *
 * Une topologie jamais relevée répond `409 forge_not_synced` : ce n'est pas une
 * panne mais une machine qu'on n'a pas encore interrogée, et l'écran présente
 * son remède comme une action (§27.8).
 */
async function chargerHote() {
  etat.route = 'forge';
  etat.forge.status = 'loading';
  etat.forge.error = null;
  peindre();
  try {
    etat.forge.host = await api('/v1/forge');
    const [cores, sparks] = await Promise.all([
      api('/v1/forge/cores').catch(() => null),
      api('/v1/sparks').then((r) => r.sparks).catch(() => []),
    ]);
    etat.forge.cores = cores;
    // La carte des cœurs porte des identifiants de Sparks ; l'écran affiche des
    // NOMS. Un identifiant interne sans intérêt ne doit pas atteindre l'écran
    // (docs/DESIGN_SYSTEM.md §3.1).
    etat.forge.sparkNames = Object.fromEntries(sparks.map((s) => [s.id, s.name]));
    etat.forge.status = 'ready';
  } catch (erreur) {
    etat.forge.error = erreur;
    etat.forge.status = erreur.code === 'forge_not_synced' ? 'not-synced' : 'error';
  }
  peindre();
  // SPK-53 · §40.3 : la comparaison suit l'écran, sans le retenir. Elle ne coûte
  // qu'une lecture de `/v1/forge` et un `git` sur CE poste — rien n'est exécuté
  // sur la Forge, contrairement au relevé de topologie.
  if (etat.forge.status === 'ready') comparerBuild();
}

/**
 * Confronte le code déployé sur la Forge à celui de ce poste (SPK-53, §40.3).
 *
 * Ne conclut jamais à la place du serveur : les six verdicts viennent de l'hôte
 * console, qui a le tunnel ET le dépôt.
 */
async function comparerBuild() {
  const f = etat.forge;
  f.build = 'en-cours';
  peindre();
  try {
    const reponse = await fetch(
      `/api/forge/build?server=${encodeURIComponent(etat.server)}`);
    const corps = await reponse.json();
    if (!reponse.ok) throw new Error(corps?.message ?? `HTTP ${reponse.status}`);
    // Les libellés viennent du SERVEUR : ils sont le contrat du §40.3, pas une
    // formulation d'écran. Les recopier ici en ferait une seconde vérité — et
    // le module qui les porte importe `node:child_process`, donc il n'a rien à
    // faire dans un navigateur.
    f.build = corps;
  } catch (erreur) {
    // §14.6 : ne pas avoir pu comparer n'est pas « à jour ». On le DIT.
    f.build = { verdict: 'indisponible', titre: 'Comparaison impossible',
                detail: erreur?.message ?? String(erreur) };
  }
  peindre();
}

async function relever() {
  etat.forge.syncing = true;
  peindre();
  try {
    await relais(`/api/v1/forge/sync?server=${encodeURIComponent(etat.server)}`, { method: 'POST' });
  } catch { /* l'état réel sera relu ci-dessous */ }
  etat.forge.syncing = false;
  await chargerHote();
}

/**
 * SPK-68 · §50.2 : cet appel cible l'hôte console, pas le relais sparkd. Il
 * reste donc utilisable précisément lorsqu'une Forge neuve n'a pas d'API.
 */
async function diagnostiquerForge() {
  const installer = etat.forge.installer;
  installer.status = 'running';
  installer.error = null;
  peindre();
  try {
    const reponse = await fetch('/api/forge/diagnostic', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server: etat.server }),
    });
    const corps = await reponse.json();
    if (!reponse.ok) throw new Error(corps?.message ?? `HTTP ${reponse.status}`);
    installer.status = 'ready';
    installer.result = corps;
  } catch (erreur) {
    // Une erreur de transport ou de clé d'hôte n'est pas un refus de Forge :
    // le panneau l'annonce sans rouge et sans prétendre que l'installation a
    // commencé (§14.5, SPK-DS-12).
    installer.status = 'error';
    installer.error = erreur?.message ?? String(erreur);
    installer.result = null;
  }
  peindre();
}

/** Catalogue d'images (docs/DAT.md §33, §34.1). */
async function chargerCatalogue() {
  etat.route = 'images';
  etat.catalogue.status = 'loading';
  etat.catalogue.error = null;
  peindre();
  try {
    etat.catalogue.images = (await api('/v1/images')).images;
    etat.catalogue.status = 'ready';
  } catch (erreur) {
    etat.catalogue.error = erreur;
    etat.catalogue.status = 'error';
  }
  peindre();
}

/** Catalogue d'environnement de la Forge (SPK-64, docs/DAT.md §43.6). */
async function chargerCatalogueEnv() {
  etat.route = 'environnement';
  etat.catalogueEnv.status = 'loading';
  etat.catalogueEnv.error = null;
  peindre();
  try {
    etat.catalogueEnv.entrees = (await api('/v1/env')).env;
    etat.catalogueEnv.status = 'ready';
  } catch (erreur) {
    etat.catalogueEnv.error = erreur;
    etat.catalogueEnv.status = 'error';
  }
  peindre();
}

/** La première réponse sur un Spark protégé demande une acceptation explicite. */
async function ecrireCatalogueEnv(methode, nom, corps = {}, accepter = false) {
  const ui = etat.catalogueEnv.ui;
  ui.busy = true;
  ui.refusal = null;
  peindre();
  let vu;
  try {
    vu = await appel(methode, `/v1/env/${encodeURIComponent(nom)}`,
                     { ...corps, ...(accepter ? { accept_protected: true } : {}) });
  } catch (erreur) {
    ui.busy = false;
    ui.refusal = `La requête n’a pas abouti : ${erreur.message}`;
    return peindre();
  }
  ui.busy = false;
  const detail = vu.corps?.detail;
  if (!vu.ok && detail?.error === 'protected_sparks_affected') {
    ui.confirming = { methode, nom, corps, message: detail.message,
                      protected_sparks: detail.protected_sparks ?? [] };
    return peindre();
  }
  if (!vu.ok) {
    ui.refusal = detail?.message ?? 'Le serveur a refusé cette écriture.';
    return peindre();
  }
  ui.confirming = null;
  ui.open = false;
  ui.values = { ...CATALOGUE_ENV_VIDE.values };
  await chargerCatalogueEnv();
}

function brancherCatalogueEnv() {
  const ui = etat.catalogueEnv.ui;
  racine.querySelector('[data-ouvre="catalogue-env"]')?.addEventListener('click', () => {
    ui.open = true;
    ui.refusal = null;
    ui.confirming = null;
    ui.values = { ...CATALOGUE_ENV_VIDE.values };
    peindre();
  });
  for (const bouton of racine.querySelectorAll('[data-retire-catalogue]')) {
    bouton.addEventListener('click', () => ecrireCatalogueEnv(
      'DELETE', bouton.dataset.retireCatalogue));
  }
  racine.querySelector('[data-annule-catalogue]')?.addEventListener('click', () => {
    ui.confirming = null;
    peindre();
  });
  racine.querySelector('[data-accepte-catalogue]')?.addEventListener('click', () => {
    const c = ui.confirming;
    if (c) ecrireCatalogueEnv(c.methode, c.nom, c.corps, true);
  });

  const formulaire = racine.querySelector('[data-modale="catalogue-env"]');
  if (!formulaire) return;
  for (const controle of formulaire.querySelectorAll('input')) {
    controle.addEventListener('input', () => {
      ui.values[controle.name] = controle.type === 'checkbox'
        ? controle.checked : controle.value;
    });
  }
  formulaire.addEventListener('submit', (evenement) => {
    evenement.preventDefault();
    ecrireCatalogueEnv('PUT', String(ui.values.name ?? '').trim(), {
      value: ui.values.value, secret: Boolean(ui.values.secret),
    });
  });
}

/** Relevé explicite (§33.3). Il ne détruit rien : aucune confirmation (§6.24). */
async function releverImages() {
  etat.catalogue.ui.syncing = true;
  peindre();
  try {
    await relais(`/api/v1/images/verify?server=${encodeURIComponent(etat.server)}`,
                 { method: 'POST' });
  } catch { /* l'état réel sera relu ci-dessous */ }
  etat.catalogue.ui.syncing = false;
  await chargerCatalogue();
}

/**
 * Catalogue des serveurs (SPK-41, docs/DAT.md §22.4 ter, §22.4.7 bis).
 *
 * Cet écran appelle l'hôte console — `/api/servers` —, jamais `sparkd` : c'est
 * un état de CE poste, et il reste lisible quand tous les tunnels sont rompus.
 * Le lire à travers un tunnel serait le rendre inaccessible précisément quand
 * on en a besoin pour en déclarer un autre.
 */
async function chargerServeurs() {
  etat.route = 'serveurs';
  etat.catalogueServeurs.status = 'loading';
  etat.catalogueServeurs.error = null;
  peindre();
  try {
    const corps = await (await fetch('/api/servers')).json();
    etat.catalogueServeurs.servers = corps.servers ?? [];
    etat.catalogueServeurs.tunnels = corps.tunnels ?? [];
    etat.catalogueServeurs.current = corps.current ?? null;
    etat.catalogueServeurs.status = 'ready';
  } catch (erreur) {
    etat.catalogueServeurs.error = erreur;
    etat.catalogueServeurs.status = 'error';
  }
  peindre();
}

/** L'épreuve du §22.4.4. Elle INFORME : son verdict ne bloque rien. */
async function eprouverServeur() {
  const ui = etat.catalogueServeurs.ui;
  ui.probing = true;
  ui.probe = null;
  peindre();
  try {
    const reponse = await fetch('/api/servers/probe', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ui.values),
    });
    const corps = await reponse.json();
    ui.probe = reponse.ok ? corps
      : { reachable: false, error: corps.message ?? 'Entrée refusée.' };
  } catch (erreur) {
    ui.probe = { reachable: false, error: erreur.message };
  }
  ui.probing = false;
  peindre();
}

async function enregistrerServeur() {
  const ui = etat.catalogueServeurs.ui;
  ui.busy = true;
  ui.refusal = null;
  peindre();
  let reponse;
  try {
    reponse = await fetch('/api/servers', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ui.values),
    });
  } catch (erreur) {
    reponse = { ok: false, json: async () => ({ message: erreur.message }) };
  }
  ui.busy = false;
  if (!reponse.ok) {
    // Le refus vient du serveur — un secret, un nom invalide — et la saisie
    // reste intacte (§25.2).
    const corps = await reponse.json().catch(() => ({}));
    ui.refusal = corps.message ?? 'Le serveur a refusé cet enregistrement.';
    return peindre();
  }
  ui.open = false;
  ui.probe = null;
  ui.values = { ...CATALOGUE_SERVEURS_VIDE.values };
  await chargerServeurs();
  // La liste des serveurs du sélecteur a changé : elle vit dans l'en-tête, et
  // la laisser périmée ferait basculer vers un serveur qu'on vient de retirer.
  await rafraichirContexte();
}

async function retirerServeur(nom) {
  const ui = etat.catalogueServeurs.ui;
  ui.confirming = null;
  await fetch('/api/servers', {
    method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: nom }),
  }).catch(() => null);
  await chargerServeurs();
  await rafraichirContexte();
}

/** Relit l'inventaire pour l'en-tête, sans toucher à la vue courante. */
async function rafraichirContexte() {
  try {
    const corps = await (await fetch('/api/servers')).json();
    etat.servers = corps.servers ?? [];
    if (corps.current && corps.current !== etat.server) {
      etat.server = corps.current;
      etat.tunnel = (corps.tunnels ?? []).find((t) => t.name === corps.current) ?? null;
    }
    peindreContexte();
  } catch { /* l'en-tête garde ce qu'il montrait : rien n'est inventé */ }
}

function brancherServeurs() {
  const ui = etat.catalogueServeurs.ui;
  /** Ouvre la modale, en AJOUT ou en MODIFICATION (§22.4.7 ter). */
  const ouvrirModale = (serveur = null) => {
    ui.open = serveur ? serveur.name : 'ajout';
    ui.refusal = null;
    ui.probe = null;
    ui.values = serveur
      // Pré-remplie depuis l'entrée RÉELLE, jamais depuis ce que l'écran
      // affichait : un alias n'a ni utilisateur ni port, et les defaults
      // rempliraient des champs que le produit ne connaît pas.
      ? { ...CATALOGUE_SERVEURS_VIDE.values, ...serveur }
      : { ...CATALOGUE_SERVEURS_VIDE.values };
    peindre();
    // Les candidats du ssh_config sont PROPOSÉS, jamais imposés (§22.4 bis).
    fetch('/api/ssh-hosts').then((r) => r.json()).then(({ hosts = [] }) => {
      ui.hosts = hosts;
      if (ui.open) peindre();
    }).catch(() => { /* le formulaire reste utilisable sans candidats */ });
  };

  racine.querySelector('[data-ouvre="serveur"]')?.addEventListener('click', () => ouvrirModale());
  for (const bouton of racine.querySelectorAll('[data-modifie-serveur]')) {
    bouton.addEventListener('click', () => {
      const serveur = etat.catalogueServeurs.servers
        .find((s) => s.name === bouton.dataset.modifieServeur);
      if (serveur) ouvrirModale(serveur);
    });
  }

  const formulaire = racine.querySelector('[data-modale="serveur"]');
  if (formulaire) {
    for (const controle of formulaire.querySelectorAll('input, select')) {
      controle.addEventListener('input', () => {
        ui.values[controle.name] =
          controle.type === 'number' ? Number(controle.value) : controle.value;
        // Le GENRE décide des champs : en changer repeint le formulaire, sinon
        // on saisirait des champs que le produit ignorera (§22.4.7 ter).
        if (controle.name === 'kind') peindre();
      });
    }
    formulaire.addEventListener('submit', (evenement) => {
      evenement.preventDefault();
      enregistrerServeur();
    });
  }
  racine.querySelector('[data-action="eprouver"]')?.addEventListener('click', eprouverServeur);

  for (const bouton of racine.querySelectorAll('[data-bascule]')) {
    bouton.addEventListener('click', () => changerDeServeur(bouton.dataset.bascule));
  }
  for (const bouton of racine.querySelectorAll('[data-retire-serveur]')) {
    bouton.addEventListener('click', () => {
      // §6.23 : retirer ferme un tunnel et efface une déclaration. On confirme,
      // et la confirmation NOMME le serveur.
      ui.confirming = bouton.dataset.retireServeur;
      peindre();
      racine.querySelector('.confirmation .bouton--destructif')?.focus();
    });
  }
  racine.querySelector('[data-annule-serveur]')?.addEventListener('click', () => {
    ui.confirming = null;
    peindre();
  });
  for (const bouton of racine.querySelectorAll('[data-confirme-serveur]')) {
    bouton.addEventListener('click', () => retirerServeur(bouton.dataset.confirmeServeur));
  }
}

/** Journal de tout le serveur (docs/DAT.md §36.8). */
async function chargerJournal() {
  etat.route = 'journal';
  etat.journal.status = 'loading';
  etat.journal.error = null;
  peindre();
  const parametres = new URLSearchParams({ limit: '200' });
  for (const [cle, valeur] of Object.entries(etat.journal.filtres)) {
    if (valeur) parametres.set(cle, valeur);
  }
  try {
    etat.journal.entries = (await api(`/v1/audit?${parametres}`)).entries;
    etat.journal.status = 'ready';
  } catch (erreur) {
    etat.journal.error = erreur;
    etat.journal.status = 'error';
  }
  peindre();
}

/**
 * Relevé EXPLICITE de la chaîne, et comparaison à l'ancre (§36.8.3).
 *
 * Jamais rejoué à l'affichage : vérifier parcourt tout le journal, et le faire à
 * chaque ouverture d'onglet en ferait un coût permanent pour une information qui
 * ne change qu'à l'écriture.
 */
async function verifierChaine() {
  etat.journal.checking = true;
  peindre();
  try {
    etat.journal.chain = await api('/v1/audit/verify');
    // L'ancre vit sur CETTE machine : c'est l'hôte console qui la tient, et
    // c'est précisément ce qui lui permet de voir ce que la chaîne ne voit pas.
    const reponse = await fetch('/api/anchor', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: etat.server }),
    });
    etat.journal.anchor = reponse.ok ? await reponse.json() : null;
  } catch (erreur) {
    etat.journal.error = erreur;
  }
  etat.journal.checking = false;
  peindre();
}

function brancherJournal() {
  const formulaire = racine.querySelector('[data-filtres="journal"]');
  if (formulaire) {
    formulaire.addEventListener('submit', (evenement) => {
      evenement.preventDefault();
      for (const controle of formulaire.querySelectorAll('input, select')) {
        etat.journal.filtres[controle.name] = controle.value;
      }
      chargerJournal();
    });
  }
  racine.querySelector('[data-action="filtres-vides"]')?.addEventListener('click', () => {
    etat.journal.filtres = { ...FILTRES_VIDES };
    chargerJournal();
  });
  racine.querySelector('[data-action="verifier-chaine"]')
    ?.addEventListener('click', verifierChaine);
}

function brancherCatalogue() {
  const ui = etat.catalogue.ui;
  racine.querySelector('[data-ouvre="image"]')?.addEventListener('click', () => {
    ui.open = true; ui.refusal = null;
    peindre();
    // Le focus entrant, `Échap` et la restitution du focus sont tenus par
    // `brancherModale` (§6.27) : un seul endroit pour un seul contrat.
  });
  const formulaire = racine.querySelector('[data-modale="image"]');
  if (!formulaire) return;
  for (const controle of formulaire.querySelectorAll('input')) {
    controle.addEventListener('input', () => { ui.values[controle.name] = controle.value; });
  }
  formulaire.addEventListener('submit', async (evenement) => {
    evenement.preventDefault();
    ui.busy = true; ui.refusal = null;
    peindre();
    const reponse = await relais(`/api/v1/images?server=${encodeURIComponent(etat.server)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reference: ui.values.reference, label: ui.values.label }),
    }).catch((e) => ({ ok: false, json: async () => ({ detail: { message: e.message } }) }));
    ui.busy = false;
    if (!reponse.ok) {
      // Le refus vient du serveur, et la saisie reste intacte.
      const rendu = await reponse.json().catch(() => ({}));
      ui.refusal = rendu?.detail?.message ?? 'Le serveur a refusé cet ajout.';
      return peindre();
    }
    ui.open = false;
    ui.values = { ...CATALOGUE_VIDE.values };
    await chargerCatalogue();
  });
}

/**
 * Le manuel (SPK-56 · DESIGN_SYSTEM.md §1.5 bis).
 *
 * Les écrans renvoient au manuel plutôt que de porter le raisonnement. Le
 * chapitre est désigné par son NUMÉRO : le slug du fichier est un détail
 * d'écriture, et un renvoi qui en dépendrait casserait au premier renommage.
 */
async function chargerManuel(chapitre) {
  etat.route = 'manuel';
  manuel.status = manuel.chapters.length ? 'ready' : 'loading';
  manuel.current = chapitre || manuel.current;
  peindre();
  try {
    if (!manuel.chapters.length) {
      const liste = await (await fetch('/api/manuel')).json();
      manuel.chapters = liste.chapters ?? [];
    }
    const vise = manuel.current || manuel.chapters[0]?.id;
    if (vise) {
      const reponse = await fetch(`/api/manuel/chapitre?id=${encodeURIComponent(vise)}`);
      const rendu = await reponse.json();
      if (!reponse.ok) throw new Error(rendu?.message ?? 'Chapitre introuvable.');
      manuel.markdown = rendu.markdown;
      manuel.current = rendu.id;
    }
    manuel.status = 'ready';
  } catch (erreur) {
    manuel.status = 'error';
    manuel.error = erreur;
  }
  peindre();
}

function router() {
  const chapitre = location.hash.match(/^#\/manuel(?:\/([A-Za-z0-9-]+))?/);
  if (chapitre) return chargerManuel(chapitre[1] ?? null);
  if (location.hash === '#/serveurs') return chargerServeurs();
  if (location.hash === '#/forge/journal') return chargerJournal();
  if (location.hash === '#/forge/environnement') return chargerCatalogueEnv();
  if (location.hash === '#/forge/images') return chargerCatalogue();
  if (location.hash === '#/forge') return chargerHote();
  if (location.hash === '#/creer') return chargerCreation();
  // Chaque facette d'un Spark est une véritable destination : on doit pouvoir
  // recharger la page sur « Instantanés » (DESIGN_SYSTEM.md §5.4, §6.27).
  // SPK-43 · SPK-DS-04 : le terminal est une DESTINATION, avec sa propre
  // adresse. L'omettre ici le rendait inatteignable au rechargement — et
  // l'onglet menait à la facette « Infos ». Mesuré.
  const detail = location.hash.match(
    /^#\/sparks\/([^/]+)(?:\/(routes|cles|instantanes|environnement|terminal|docker|journal))?$/);
  if (detail) return chargerDetail(decodeURIComponent(detail[1]), detail[2] ?? '');
  etat.route = 'liste';
  etat.spark = null;
  return charger();
}

window.addEventListener('hashchange', router);

async function charger() {
  etat.route = 'liste';
  etat.status = 'loading';
  etat.error = null;
  peindre();
  try {
    const { sparks } = await api('/v1/sparks');
    etat.sparks = sparks;
    etat.usage = {};
    // L'usage est demandé Spark par Spark : une mesure manquante n'empêche pas
    // d'afficher les autres.
    await Promise.all(sparks.map(async (s) => {
      try { etat.usage[s.name] = await api(`/v1/sparks/${encodeURIComponent(s.name)}/usage`); }
      catch { /* la vue nommera l'absence plutôt que d'inventer une valeur */ }
    }));
    etat.status = 'ready';
  } catch (erreur) {
    etat.status = 'error';
    etat.error = erreur;
    etat.tunnel = erreur.tunnel;
  }
  peindre();
}

/**
 * En-tête de contexte : le serveur courant, son tunnel, et de quoi en changer.
 *
 * @spec docs/BACKLOG.md#SPK-41 · docs/DAT.md §22.4.5 (le serveur courant est un
 *       choix), §22.4.6 (la reconnexion est un geste) ·
 *       docs/DESIGN_SYSTEM_APP.md §1 (le serveur est le CONTEXTE de toutes les
 *       destinations, pas une destination)
 */
function peindreContexte() {
  // Le vocabulaire vit dans `tokens.js`, à un seul endroit : le bandeau du
  // §22.3 le partage (docs/DESIGN_SYSTEM.md §14.7).
  const { label, token } = tunnelOf(etat.tunnel?.state ?? 'closed');
  const rompu = etat.tunnel?.state === 'broken';
  const connexion = etat.tunnel?.state === 'connecting';

  // Un SÉLECTEUR dès qu'il y a le choix. Un select à une seule option serait un
  // contrôle mort : avec un seul serveur, son nom suffit.
  const choix = etat.servers.length > 1
    ? `<label class="sr-only" for="selecteur-serveur">Serveur</label>
       <select class="controle controle--compact" id="selecteur-serveur">${
         etat.servers.map((s) =>
           `<option value="${echapperTexte(s.name)}"${
             s.name === etat.server ? ' selected' : ''}>${echapperTexte(s.name)}</option>`).join('')}
       </select>`
    : `<span class="technique">${echapperTexte(etat.server)}</span>`;

  // §22.4.6 : un tunnel rompu porte SA commande. La seule issue était de
  // recharger la console, ce qui n'est pas un remède mais une superstition.
  const reconnexion = rompu
    ? `<button type="button" class="bouton bouton--compact" data-action="reconnecter">Reconnecter</button>`
    : '';

  racine.querySelector('.entete__contexte').innerHTML =
    choix +
    `<span class="badge badge--${token}"${connexion ? ' aria-live="polite"' : ''}>` +
    `<span class="badge__point" aria-hidden="true"></span>Tunnel ${label}</span>` +
    reconnexion;

  racine.querySelector('#selecteur-serveur')?.addEventListener('change', (evenement) => {
    changerDeServeur(evenement.target.value);
  });
  racine.querySelector('[data-action="reconnecter"]')
    ?.addEventListener('click', () => ouvrirTunnel(etat.server));
}

/**
 * L'avertissement de signature, dans la barre latérale.
 *
 * @spec docs/BACKLOG.md#SPK-40 · docs/DAT.md §36.10.9 (il se dit dans la
 *       coquille, en accent, et s'efface de lui-même), §36.10.1 (le geste a eu
 *       lieu) · docs/DESIGN_SYSTEM.md §25.1 (le rouge est réservé au refus du
 *       serveur), §9.7 (`role="status"`), §9.8 (la couleur n'est jamais seule)
 *
 * **En accent, jamais en rouge** : la Forge a accepté le geste, il n'y a aucun
 * refus. Ce qui est en jeu est la TRACE, pas l'action — et le titre le dit en
 * toutes lettres, pour que la couleur ne porte pas seule l'information.
 */
function peindreSignature() {
  const zone = racine.querySelector('.entete__signature');
  if (!zone) return;
  zone.innerHTML = etat.signature
    ? `<div class="avertissement avertissement--laterale" role="status">
         <p><strong>Geste non signé</strong></p>
         <p>${echapperTexte(etat.signature)}</p>
         <p><a href="#/manuel/M12">Manuel M12 — Qui a fait quoi</a></p>
       </div>`
    : '';
}

/** Avertissement durable de code local périmé (SPK-65, SPK-DS-11). */
function peindreBuildConsole() {
  const zone = racine.querySelector('.entete__console');
  if (!zone) return;
  const vu = etat.consoleBuild;
  zone.innerHTML = vu?.verdict === 'perimee'
    ? `<div class="avertissement avertissement--laterale" role="status">
         <p><strong>${echapperTexte(vu.title)}</strong></p>
         <p>${echapperTexte(vu.detail)}</p>
       </div>`
    : '';
}

const echapperTexte = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Ouvre — ou rouvre — le tunnel d'un serveur, en MONTRANT la tentative.
 *
 * Une reconnexion silencieuse laisserait croire que rien ne se passe : l'état
 * passe par `connecting` et l'en-tête le rend (§22.4.6).
 */
async function ouvrirTunnel(nom) {
  etat.tunnel = { ...(etat.tunnel ?? {}), name: nom, state: 'connecting' };
  peindreContexte();
  try {
    const reponse = await fetch('/api/tunnels', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: nom }),
    });
    // On retient l'état RÉEL, y compris « broken » : la vue doit voir la panne,
    // pas une liste vide qui ferait croire à zéro Spark (§22.3).
    etat.tunnel = await reponse.json();
  } catch (erreur) {
    etat.tunnel = { name: nom, state: 'broken', lastError: erreur.message };
  }
  peindreContexte();
  return etat.tunnel;
}

/** Bascule de serveur courant. Le choix est RETENU côté console (§22.4.5). */
async function changerDeServeur(nom) {
  if (!nom || nom === etat.server) return;
  etat.server = nom;
  etat.tunnel = { name: nom, state: 'connecting' };
  peindreContexte();
  await fetch('/api/servers/current', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: nom }),
  }).catch(() => null);
  await ouvrirTunnel(nom);
  // Tout ce qui était affiché appartenait à l'AUTRE serveur : on relit plutôt
  // que de laisser des données d'un serveur sous le nom d'un autre.
  return router();
}

async function demarrer() {
  // Le message appartient à la coquille : il est chargé indépendamment des
  // serveurs et reste en place quand l'on navigue (SPK-DS-10/11).
  fetch('/api/console/build').then((r) => r.json()).then((corps) => {
    etat.consoleBuild = corps;
    peindreBuildConsole();
  }).catch(() => { /* comparaison indisponible : aucun faux avertissement */ });
  const { servers, tunnels, current } = await (await fetch('/api/servers')).json();
  etat.servers = servers;
  const entete = racine.querySelector('.entete__contexte');
  if (servers.length === 0) {
    entete.innerHTML = '<span class="badge badge--neutral">Aucun serveur enregistré</span>';
    // SPK-41 : on MÈNE au catalogue, on ne se contente pas de le dire. C'est le
    // seul écran d'où l'on peut déclarer un serveur ; y laisser une erreur
    // globale rendait la console inutilisable sans éditeur de texte — exactement
    // le défaut que l'unité nommait. Mesuré : `#/serveurs` était inatteignable.
    location.hash = '#/serveurs';
    return chargerServeurs();
  }
  // §22.4.5 : le serveur courant est PERSISTÉ. Prendre `servers[0]` rendait le
  // choix implicite et dépendant de l'ordre d'écriture — ajouter un serveur
  // changeait celui qu'on regardait.
  etat.server = servers.some((s) => s.name === current) ? current : servers[0].name;
  etat.tunnel = tunnels.find((t) => t.name === etat.server) ?? null;

  // docs/DAT.md §22.6 : la console OUVRE le tunnel du serveur courant. Se
  // contenter de lire son état laissait une console fraîche sur « Tunnel
  // fermé », sans aucun moyen d'y remédier depuis l'interface.
  if (etat.tunnel?.state !== 'ready') await ouvrirTunnel(etat.server);

  peindreContexte();
  await router();
  await releverSessions();
  programmerReleveSessions();
}

demarrer();
