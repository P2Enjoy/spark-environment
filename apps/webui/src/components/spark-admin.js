/**
 * Les trois panneaux d'administration d'un Spark : routes publiques, clés
 * autorisées, instantanés.
 *
 * @spec docs/BACKLOG.md#SPK-21 · docs/DAT.md §26 (les trois surfaces),
 *       §26.2 (un formulaire s'ouvre, il n'occupe pas), §26.3 (routes),
 *       §26.4 (clés), §26.5 (instantanés) · §17, §18, §19 ·
 *       docs/DESIGN_SYSTEM.md §3.1, §6.9, §6.19, §6.22, §6.23, §6.24, §6.27
 *       (la saisie est recueillie par une modale limitée à la section), §14.7 ·
 *       docs/DESIGN_SYSTEM_APP.md
 * @spec docs/BACKLOG.md#SPK-50 · docs/DAT.md §38.6 (les recettes DNS),
 *       §38.6.3 (le compte rendu ligne à ligne) · docs/DESIGN_SYSTEM.md §6.13
 *       (« résultat partiel » est un état à traiter)
 * @spec docs/BACKLOG.md#SPK-49 · docs/DAT.md §39 (les ports publiés),
 *       §39.2 (une ressource de la Forge), §39.3 (ce qu'un port fait perdre,
 *       et que l'écran doit dire)
 * @spec docs/BACKLOG.md#SPK-89 · docs/DAT.md §18.3 ter (la cible d'une route se
 *       corrige : son port et son TLS, jamais son domaine ni son Spark),
 *       §18.5 (l'écart reste visible) · docs/DESIGN_SYSTEM.md §6.27
 * @spec docs/BACKLOG.md#SPK-48 · docs/DAT.md §18.3 bis (le joker, la préséance
 *       du plus spécifique, et la vue depuis le joker) · §18.4
 * @spec docs/BACKLOG.md#SPK-78 · docs/DAT.md §38.9 (une écriture DNS se
 *       vérifie), §38.9.1 (relire plutôt que persister), §38.9.2 (conforme ne
 *       veut pas dire résolu)
 * @spec docs/BACKLOG.md#SPK-47 · docs/DAT.md §38 (le DNS entre dans le
 *       périmètre), §38.1.1 (trois états, pas deux : sans jeton, refusé, sans
 *       zone), §38.3 (ce qu'écrit un enregistrement d'ingress),
 *       §38.4 (poser n'est pas résoudre) — pour le panneau « Pointer le
 *       domaine » de la section des routes publiques.
 *
 * Ce sont des panneaux du détail, pas des écrans (§26.1) : une route publique
 * et un instantané n'existent pas sans leur Spark.
 */

import { formatBytes } from './tokens.js';
import { renderModale } from './modale.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Horodatage lisible. Le registre rend de l'ISO ; l'écran n'en montre que
 *  ce qui se lit (docs/DESIGN_SYSTEM.md §3.1 pour la typographie technique). */
export function formatDate(valeur) {
  return String(valeur ?? '').slice(0, 16).replace('T', ' ');
}

/** État initial des trois panneaux. Les valeurs vivent ici pour qu'un refus du
 *  serveur ne les efface pas (§26.2). */
export const ADMIN_VIDE = {
  open: null,        // 'route' | 'key' | 'snapshot' | 'protection' | 'dns' (§26.2)
  confirming: null,  // { kind, id }
  refusal: null,     // { panel, message, blocking? }
  busy: false,
  // SPK-89 · §18.3 ter : la route qu'on CORRIGE, et sa nouvelle cible.
  editing: null,
  values: { domain: '', port: 8080, tls: true,
            route_port: 8080, route_tls: true,
            key_label: '', new_label: '', public_key: '',
            snapshot: '', password: '',
            // SPK-49 · §39 : la publication d'un port de la Forge.
            public_port: '', target_port: '', protocol: 'tcp', port_note: '',
            // SPK-50 · §38.6 : la recette choisie, sa zone, et ses paramètres.
            recette: '', recette_zone: '', recette_params: {},
            // SPK-47 · §38.3 : ce qui sera écrit dans la zone.
            dns_zone: '', dns_address: '' },
  // SPK-48 · §18.3 bis : la route qu'une déclaration vient de dépasser, et le
  // Spark qui la servait. Nul tant qu'aucune déclaration n'a pris le pas.
  supersedes: null,
  // SPK-50 · §38.6 : le catalogue, l'aperçu ligne à ligne, et le compte rendu.
  recettes: { catalogue: [], zones: [], apercu: null, resultat: null,
              chargement: false, erreur: null,
              // SPK-78 · §38.9.1 : ce que la zone porte MAINTENANT, relu à la
              // demande. Ce n'est pas un souvenir du compte rendu.
              verification: null, verifieEnCours: false,
              verificationErreur: null,
              // §38.1.1 : pourquoi la liste des zones est vide. C'est un état
              // DISTINCT de `erreur`, qui porte le refus d'aperçu et se remet à
              // zéro avant chaque relecture — les confondre effaçait la raison
              // au premier changement de recette.
              zonesRefus: null,
              // La demande en cours, pour qu'une réponse tardive n'écrase pas
              // une réponse plus récente (§38.5.2, même garde).
              lu: null },
  // SPK-78 · §38.9.1 : l'état DNS relevé, route par route. C'est la réponse à
  // « je ne vois plus rien dans les pages du Spark » : le compte rendu d'une
  // écriture est transitoire, mais l'état, lui, se relit.
  dnsRoutes: { chargement: false, configured: null, reason: null,
               etats: {}, erreur: null },
  // SPK-47 · §38.1 : ce que la console SAIT du fournisseur. `configured` vaut
  // `null` tant qu'on n'a pas demandé — « pas encore su » n'est pas « pas
  // configuré », et l'écran ne doit pas annoncer une absence qu'il n'a pas
  // constatée.
  dns: { domain: null, configured: null, reason: null, zones: [],
         loading: false, written: null,
         // §38.1.1 : le fournisseur a REFUSÉ — jeton expiré, permission
         // manquante, service injoignable. Ce n'est ni « pas de jeton » ni
         // « pas de zone », et le geste à faire n'est pas le même.
         refus: null,
         // Ce qui a DÉJÀ été lu, pour ne pas relire à l'identique (§38.5.2).
         lu: null,
         // §38.5.2 : ce qui occupe DÉJÀ le couple nom + type visé. `effet` vaut
         // 'pose' | 'remplace' | 'inchange'. Tant qu'on ne l'a pas demandé, il
         // est nul — et l'écran dit alors qu'il vérifie, pas qu'il n'y a rien.
         apercu: null, apercuEnCours: false },
};

/**
 * Pourquoi les zones n'ont pas pu être listées, ou `null` (§38.1.1).
 *
 * @spec docs/BACKLOG.md#SPK-47 · docs/DAT.md §38.1.1 (trois états, pas deux) ·
 *       docs/DESIGN_SYSTEM.md §6.13 (« vide » et « erreur » sont deux états)
 *
 * Trois réponses arrivent ici et deux seulement portent une raison : le poste
 * sans jeton (`configured: false`), et le refus du fournisseur — un corps
 * `{error, message}` SANS champ `configured`, qu'un simple `configured === false`
 * laissait passer. Le compte qui n'a réellement aucune zone ne dit rien ici : ce
 * n'est pas un refus, et l'écran le nomme autrement.
 */
export function refusZones(corps) {
  if (!corps || typeof corps !== 'object') return null;
  if (corps.configured === false) return corps.reason ?? corps.message ?? null;
  if (corps.error) return corps.message ?? corps.reason ?? null;
  return null;
}

/**
 * Zone la plus SPÉCIFIQUE qui contienne le domaine (§38.5).
 *
 * Un compte peut porter `exemple.tech` ET `staging.exemple.tech` : proposer la
 * première trouvée écrirait `app.staging` dans la zone parente, où la
 * délégation le rendrait invisible. La plus longue gagne.
 */
export function zonePour(domaine, zones = []) {
  const d = String(domaine ?? '').trim().toLowerCase().replace(/\.$/, '');
  return zones
    .map((z) => (typeof z === 'string' ? z : z.zone))
    // Le domaine peut ÊTRE la zone : c'est le cas d'un site sur le domaine nu,
    // `johndalia.com`. Ne retenir que les sous-domaines laissait l'exploitant
    // choisir à la main la seule zone possible, sans lui dire laquelle (§38.5.1).
    .filter((z) => z && (d === z.toLowerCase() || d.endsWith(`.${z.toLowerCase()}`)))
    .sort((a, b) => b.length - a.length)[0] ?? '';
}

/**
 * Bouton qui ouvre un formulaire, ou rien si un autre panneau est déjà ouvert.
 * §26.2 : un seul formulaire à la fois. Deux formulaires ouverts laisseraient
 * croire qu'on prépare deux gestes qui partiraient ensemble.
 */
/**
 * Commande de section. Elle ouvre une modale dont le sujet est CETTE section
 * (§6.27) ; elle ne se remplace plus par un formulaire dans le flux.
 *
 * Elle reste visible pendant la saisie : c'est elle qui reçoit le focus à la
 * fermeture, et un déclencheur disparu n'aurait rien à qui le rendre.
 */
function declencheur(panneau, libelle) {
  return `<p class="formulaire__actions"><button type="button" class="bouton" ` +
    `data-ouvre="${panneau}">${echapper(libelle)}</button></p>`;
}

/** Bloc de refus du serveur, commun aux trois panneaux (§26.3, §26.4). */
function refus(ui, panneau) {
  if (!ui.refusal || ui.refusal.panel !== panneau) return '';
  return `<div class="refus" role="alert">
    <p><strong>${echapper(ui.refusal.message)}</strong></p>
  </div>`;
}

/* ------------------------------------------------------------------ routes */

/**
 * Routes publiques.
 *
 * L'unicité du domaine n'est PAS contrôlée ici : elle appartient à la base
 * (§18.4, §26.3). Un contrôle local ne protégerait de rien face à deux consoles
 * simultanées et donnerait l'illusion inverse.
 */
export function renderRoutesPanel(spark, routes = [], ui = ADMIN_VIDE) {
  const lignes = routes.length
    ? `<ul class="liste-administrable">${routes.map((r) => {
        const attente = r.applied_at
          ? ''
          : ` <span class="badge badge--accent"><span class="badge__point" aria-hidden="true"></span>non appliquée</span>`;
        // §26.3 : « non appliquée » est un retard, pas une panne — accent, pas danger.
        const reappliquer = r.applied_at
          ? ''
          : `<button type="button" class="bouton bouton--compact" data-reapplique="1">Réappliquer</button>`;
        const confirme = ui.confirming?.kind === 'route' && ui.confirming.id === r.domain
          ? `<div class="confirmation" role="group" aria-label="Confirmer le retrait">
               <p><strong>Retirer « ${echapper(r.domain)} » ?</strong></p>
               <p class="confirmation__consequence">Ce domaine cessera de répondre
               immédiatement. Le Spark et ses données ne sont pas touchés.</p>
               <p class="confirmation__actions">
                 <button type="button" class="bouton bouton--destructif" data-confirme-route="${echapper(r.domain)}">Retirer la route</button>
                 <button type="button" class="bouton" data-annule="route">Annuler</button>
               </p>
             </div>`
          : '';
        return `<li><span class="technique">${echapper(r.domain)}</span>` +
          ` → port ${echapper(r.target_port)} du Spark` +
          // SPK-78 · §38.9.1 : l'état DNS RELEVÉ, pas un souvenir d'écriture.
          `${renderEtatDns(ui.dnsRoutes, r.domain)}` +
          `${r.tls ? '' : ' <span class="badge badge--neutral">sans TLS</span>'}${attente}` +
          `<span class="actions-ligne">${reappliquer}` +
          // SPK-47 · §38 : pointer le DNS est un geste de CETTE route, pas de la
          // section — deux routes du même Spark ont deux domaines distincts.
          `<button type="button" class="bouton bouton--compact" data-dns-route="${echapper(r.domain)}">DNS</button>` +
          // SPK-89 · §18.3 ter : un port se CORRIGE. Retirer puis redéclarer
          // couperait le service entre les deux et perdrait l'identité de la
          // route, sa place au journal et ce qu'elle a dépassé.
          `<button type="button" class="bouton bouton--compact" data-modifie-route="${echapper(r.domain)}">Modifier</button>` +
          `<button type="button" class="bouton bouton--compact" data-retire-route="${echapper(r.domain)}">Retirer</button></span>` +
          `${renderSurcharges(r)}${confirme}</li>`;
      }).join('')}</ul>`
    : '<p class="absence">Aucune route publique ne pointe vers ce Spark.</p>';

  // SPK-89 · §18.3 ter : corriger la CIBLE d'une route. Le domaine est montré et
  // non saisissable — le changer ne serait pas une correction mais une autre
  // route (§22.4.7 ter), et déplacer vers un autre Spark doit se voir dans le
  // journal des deux.
  const edition = renderModale({
    ouverte: Boolean(ui.editing), id: 'route-edition',
    titre: 'Corriger la cible de la route',
    engagement: 'Corriger la route',
    refus: ui.refusal?.panel === 'route-edition' ? ui.refusal.message : null,
    occupee: ui.busy,
    corps: `
         <div class="champ">
           <label for="edit-domaine">Domaine</label>
           <input class="controle technique" id="edit-domaine" type="text" readonly
                  value="${echapper(ui.editing ?? '')}">
           <p class="champ__aide">Le domaine identifie la route : il ne se corrige
           pas. Pour servir un autre nom, déclarez-en une et retirez celle-ci.</p>
         </div>
         <div class="champ">
           <label for="edit-port">Port du Spark</label>
           <input class="controle" id="edit-port" name="route_port" type="number"
                  min="1" max="65535" value="${echapper(ui.values.route_port)}">
         </div>
         <div class="champ">
           <label for="edit-tls">
             <input id="edit-tls" name="route_tls" type="checkbox"${
               ui.values.route_tls ? ' checked' : ''}>
             Certificat TLS automatique
           </label>
         </div>
         <p class="champ__aide">La route redevient « non appliquée » le temps que
         le proxy reprenne la configuration : c’est un état réel, et l’écran le
         dit plutôt que d’annoncer un succès qu’il n’a pas constaté.</p>`,
  });

  const modale = renderModale({
    ouverte: ui.open === 'route', id: 'route', titre: 'Routes publiques',
    engagement: 'Déclarer la route', refus: ui.refusal?.panel === 'route' ? ui.refusal.message : null,
    occupee: ui.busy,
    corps: `
         <div class="champ">
           <label for="route-domaine">Domaine</label>
           <input class="controle" id="route-domaine" name="domain" type="text"
                  autocomplete="off" value="${echapper(ui.values.domain)}">
         </div>
         <div class="champ">
           <label for="route-port">Port du Spark</label>
           <input class="controle" id="route-port" name="port" type="number" min="1" max="65535"
                  value="${echapper(ui.values.port)}">
           <p class="champ__aide">Le port sur lequel écoute la pile DANS le Spark,
           pas celui de la Forge.</p>
         </div>
         <div class="champ">
           <label for="route-tls">
             <input id="route-tls" name="tls" type="checkbox" ${ui.values.tls ? 'checked' : ''}>
             Certificat TLS automatique
           </label>
           <p class="champ__aide">L’émission suppose que le domaine résolve déjà vers
           cette Forge. Le bouton « DNS » de la route pose l’enregistrement chez le
           fournisseur ; la résolution reste soumise à la propagation, et un domaine
           mal pointé fait échouer l’émission côté Caddy, pas côté plan de contrôle.</p>
         </div>`,
  });

  return `
<section class="carte bloc" aria-labelledby="titre-routes">
  <h2 id="titre-routes">Routes publiques</h2>
  ${lignes}
  ${renderPriseDePas(ui)}
  ${renderDnsEcrit(ui)}
  ${renderRecetteResultat(ui)}
  <p class="formulaire__actions">
    <button type="button" class="bouton" data-ouvre="route">Ajouter une route</button>
    <button type="button" class="bouton" data-ouvre="recette">Appliquer une recette DNS</button>
  </p>
  ${modale}
  ${edition}
  ${renderDnsModale(ui)}
  ${renderRecetteModale(ui)}
</section>`;
}

/**
 * Une recette DNS : un jeu d'enregistrements posé ENSEMBLE (SPK-50, §38.6).
 *
 * L'écran présente la recette ENTIÈRE avant d'écrire. Une recette à moitié posée
 * est pire qu'une recette absente — un `MX` sans SPF fait recevoir du courrier
 * qu'on ne peut pas renvoyer —, et on ne s'en aperçoit qu'après.
 */
function renderRecetteModale(ui) {
  const etat = ui.recettes ?? ADMIN_VIDE.recettes;
  const choisie = etat.catalogue.find((r) => r.id === ui.values.recette) ?? null;

  const choix = `
    <div class="champ">
      <label for="recette-id">Recette</label>
      <select class="controle" id="recette-id" name="recette">
        <option value="">— choisir une recette —</option>
        ${etat.catalogue.map((r) =>
          `<option value="${echapper(r.id)}"${ui.values.recette === r.id ? ' selected' : ''}>`
          + `${echapper(r.label)}</option>`).join('')}
      </select>
      ${choisie ? `<p class="champ__aide">${echapper(choisie.description)}</p>` : ''}
    </div>
    <div class="champ">
      <label for="recette-zone">Zone</label>
      <select class="controle" id="recette-zone" name="recette_zone"${
        etat.zones.length ? '' : ' aria-describedby="recette-zones-vides"'}>
        <option value="">— choisir une zone —</option>
        ${etat.zones.map((z) =>
          `<option value="${echapper(z.zone)}"`
          + `${ui.values.recette_zone === z.zone ? ' selected' : ''}>`
          + `${echapper(z.zone)}</option>`).join('')}
      </select>
      ${renderZonesVides(etat)}
    </div>`;

  // §38.6.5 : un paramètre `dansLaZone` ne redemande PAS ce que la zone dit
  // déjà. Le champ ne porte que le libellé, la zone est affichée en suffixe, et
  // vide vaut le domaine lui-même. Sans la zone choisie, le suffixe n'a rien à
  // montrer et le champ reste nu.
  const zoneChoisie = ui.values.recette_zone ?? '';
  const parametres = choisie
    ? choisie.parametres.map((p) => {
        const relatif = p.dansLaZone && zoneChoisie;
        // §6.9 bis : un port se SAISIT, avec ses bornes — il ne se fait pas
        // glisser, et une saisie libre laisserait passer « 70000 » jusqu'au
        // refus du serveur.
        const valeur = ui.values.recette_params?.[p.nom] ?? p.defaut ?? '';
        const controle = p.port
          ? `<input class="controle" id="recette-p-${echapper(p.nom)}"
                 data-param="${echapper(p.nom)}" type="number" min="1" max="65535"
                 value="${echapper(valeur)}">`
          : `<input class="controle" id="recette-p-${echapper(p.nom)}"
                 data-param="${echapper(p.nom)}" type="text" autocomplete="off"
                 value="${echapper(valeur)}">`;
        return `
        <div class="champ">
          <label for="recette-p-${echapper(p.nom)}">${echapper(p.label)}${
            p.facultatif ? ' <span class="note">(facultatif)</span>' : ''}</label>
          ${relatif
            ? `<div class="champ-suffixe">${controle}<span class="champ-suffixe__zone"
                 title="${echapper(zoneChoisie)}">.${echapper(zoneChoisie)}</span></div>`
            : controle}
          ${p.aide ? `<p class="champ__aide">${echapper(p.aide)}</p>` : ''}
        </div>`;
      }).join('')
    : '';

  const humaines = choisie?.actionsHumaines?.length
    ? `<div class="avertissement" role="status">
         <p><strong>Ce que cette recette ne peut pas faire :</strong></p>
         <ul class="liste-simple">${choisie.actionsHumaines.map((a) =>
           `<li>${echapper(a)}</li>`).join('')}</ul>
       </div>`
    : '';

  return renderModale({
    ouverte: ui.open === 'recette', id: 'recette', titre: 'Appliquer une recette DNS',
    engagement: 'Écrire la recette',
    refus: ui.refusal?.panel === 'recette' ? ui.refusal.message : null,
    occupee: ui.busy,
    corps: `${choix}${parametres}${humaines}
            <div id="recette-apercu">${renderRecetteApercu(etat)}</div>`,
  });
}

/**
 * La raison du vide, sous le champ « Zone » (§38.1.1).
 *
 * @spec docs/BACKLOG.md#SPK-50 · docs/DAT.md §38.1.1 ·
 *       docs/DESIGN_SYSTEM.md §6.13 (état vide et état d'erreur sont distincts),
 *       §14.5 (une absence utile est NOMMÉE)
 *
 * Un refus du fournisseur prend la couleur du refus ; un compte réellement sans
 * zone est un fait, pas une erreur, et reste une aide de champ. Tant qu'on lit,
 * on ne conclut rien : « pas encore su » n'est pas « pas de zone ».
 */
export function renderZonesVides(etat) {
  if (etat.zones?.length) return '';
  if (etat.zonesRefus) {
    // `champ__erreur` et non `refus` : le refus vit ICI, sous le champ qu'il
    // vide, et non en tête de modale où il se lirait comme un refus de
    // l'écriture (DESIGN_SYSTEM.md §6.12).
    return `<p class="champ__erreur" id="recette-zones-vides">`
           + `${echapper(etat.zonesRefus)}</p>`;
  }
  if (etat.chargement) {
    return '<p class="champ__aide" id="recette-zones-vides" aria-busy="true">'
           + 'Lecture des zones du compte…</p>';
  }
  return '<p class="champ__aide" id="recette-zones-vides">'
         + 'Le compte ne porte aucune zone DNS.</p>';
}

/**
 * Peut-on écrire cette recette ? Rend le refus MOTIVÉ, ou `null` (§38.6.4 bis).
 *
 * @spec docs/BACKLOG.md#SPK-88 · docs/DAT.md §38.6.4 bis (la route AVANT le DNS)
 *
 * Une recette qui pose des routes les prend de l'APERÇU — celui-là même qui a
 * été relu et montré. Sans aperçu, on n'écrirait que le DNS : le nom pointerait
 * vers une Forge qui ne le sert pas, et c'est exactement l'ordre que le
 * §38.6.4 bis refuse. Mieux vaut ne rien faire et le dire.
 */
export function refusEcritureRecette(recettes, values) {
  const choisie = (recettes?.catalogue ?? []).find((r) => r.id === values?.recette);
  if (!choisie) return 'Choisissez une recette.';
  if (!values?.recette_zone) return 'Choisissez une zone.';
  if (choisie.poseDesRoutes && !recettes?.apercu) {
    return "L'aperçu n'a pas pu être lu : cette recette déclare des routes, et "
      + "les écrire sans elles ferait pointer un nom vers une Forge qui ne le "
      + "sert pas. Corrigez les paramètres, puis réessayez.";
  }
  return null;
}

/**
 * Le gabarit d'une ligne de recette (§38.6.4 ter).
 *
 * @spec docs/BACKLOG.md#SPK-88 · docs/DAT.md §38.6.4 ter (trois blocs, un seul
 *       gabarit) · docs/DESIGN_SYSTEM.md §12.3 (une classe qui ne peint rien est
 *       un défaut), §6.14, §14.5
 *
 * Trois blocs disent la même liste à trois moments : ce qui SERA écrit, ce qui A
 * ÉTÉ écrit, et ce que la zone PORTE. Trois gabarits, ce serait trois endroits
 * où la colonne se décale et où un état s'oublie.
 *
 * Une ligne porte quatre choses, toujours aux mêmes places : ce qu'elle vise, ce
 * qui y va, son rôle, et son état. Seul l'état change d'un bloc à l'autre.
 */
const TONS = {
  attendu: 'badge--neutral', change: 'badge--accent',
  fait: 'badge--success', manque: 'badge--danger',
};

export function renderLignesRecette(lignes = []) {
  if (!lignes.length) return '';
  return `<ul class="recette-lignes">${lignes.map((l) => `
    <li class="recette-ligne${l.route ? ' recette-ligne--route' : ''}">
      <span class="recette-ligne__quoi">
        <span class="recette-ligne__cible technique">${echapper(l.cible)}</span>
        <span class="recette-ligne__valeur technique">${echapper(l.valeur)}</span>
      </span>
      <span class="recette-ligne__etat badge ${TONS[l.ton] ?? TONS.attendu}"
        >${echapper(l.etat)}</span>
      <span class="recette-ligne__role">${echapper(l.role ?? '')}</span>
    </li>`).join('')}</ul>`;
}

/** Une ligne DNS : le nom et le type visés, la valeur, le rôle. */
function ligneRecord(r, etat, ton) {
  return { cible: `${r.name || '@'} ${r.type}`, valeur: r.data,
           role: r.role, etat, ton };
}

/** Une ligne de ROUTE. Elle se range comme les autres — même grammaire, et une
 *  marque de plus pour dire qu'il s'agit d'une route et non d'un nom (§38.6.4 ter). */
function ligneRoute(r, etat, ton) {
  return { route: true, cible: `route ${r.domain}`,
           valeur: `→ port ${r.port}`, role: r.role, etat, ton };
}

/** L'aperçu ligne à ligne, remplacé SUR PLACE comme celui du §38.5.2. */
export function renderRecetteApercu(etat) {
  const vu = etat.apercu;
  // Pendant une RELECTURE, on garde ce qui est affiché et on le marque occupé.
  //
  // Mesuré, deux fois : vider le bloc le fait rétrécir, la modale avec, et le
  // bouton d'engagement se dérobe entre l'appui et le relâchement — le clic ne
  // part jamais. `change` se déclenche AUSSI à la perte du focus, donc au moment
  // même où l'on clique. C'est la même correction qu'au §38.5.2.
  // `lu` distingue les deux lectures qui portent le MÊME drapeau `chargement` :
  // celle des zones, au chargement de la modale, et celle de l'aperçu. Sans
  // cette garde, l'écran annonçait « lecture de ce qui est déjà en place »
  // alors qu'aucune zone n'était encore choisie — et le disait EN MÊME TEMPS
  // que le champ « Zone » annonçait sa propre lecture (§38.1.1).
  if (etat.chargement && etat.lu && !vu && !etat.erreur) {
    return '<p class="note" aria-busy="true">Lecture de ce qui est déjà en place…</p>';
  }
  if (etat.erreur) return `<p class="refus">${echapper(etat.erreur)}</p>`;
  if (!vu) return '';
  const occupe = etat.chargement ? ' aria-busy="true"' : '';
  // §38.6.4 bis : la route AVANT le DNS, à l'aperçu comme à l'écriture. L'ordre
  // affiché est l'ordre réel — montrer l'inverse ferait mal lire un échec.
  const lignes = [
    ...(vu.routes ?? []).map((r) => ligneRoute(r, ...etatRoute(r))),
    ...vu.records.map((r) => ligneRecord(r, ...etatApercu(r))),
  ];
  return `<div class="recette-bloc"${occupe}>
    <p class="recette-bloc__titre"><strong>Sera appliqué :</strong></p>
    ${renderLignesRecette(lignes)}
    ${vu.incomplete
      ? `<p class="avertissement" role="status">${echapper(vu.incomplete)}</p>` : ''}
  </div>`;
}

/** L'état d'un enregistrement AVANT écriture (§38.5.2). */
function etatApercu(r) {
  if (r.effet === 'inchange') return ['déjà à cette valeur', 'fait'];
  if (r.effet === 'remplace') return [`remplace ${r.current?.data ?? ''}`, 'change'];
  return ['à poser', 'attendu'];
}

/**
 * L'état d'une route AVANT déclaration (§38.6.4 bis).
 *
 * Une route déjà là vers le MÊME Spark n'est pas un refus : l'état visé est
 * atteint. Vers un autre, c'en est un, et il NOMME ce Spark — l'unicité est
 * portée par la base (§18.4).
 */
function etatRoute(r) {
  if (r.etat === 'deja') return ['déjà en place', 'fait'];
  if (r.etat === 'occupee') return [`tenue par ${r.spark ?? 'un autre Spark'}`, 'manque'];
  return ['à déclarer', 'attendu'];
}


/**
 * Le compte rendu APRÈS écriture (§38.6.3, DESIGN_SYSTEM §6.13 « résultat
 * partiel »).
 *
 * Ni succès ni échec global : la liste, chaque ligne avec son sort. Un
 * « succès » sur une recette à moitié posée serait le pire des mensonges
 * possibles ici.
 */
function renderRecetteResultat(ui) {
  const fait = ui.recettes?.resultat;
  if (!fait) return '';
  const partiel = fait.failed > 0 || (fait.routes ?? []).some((r) => !r.declared);
  // §38.6.4 ter : le MÊME gabarit que l'aperçu et le relevé. Les routes en tête,
  // parce que c'est l'ordre réel de l'écriture (§38.6.4 bis).
  const lignes = [
    ...(fait.routes ?? []).map((r) => ligneRoute(r,
      r.declared ? (r.already ? 'déjà en place' : 'déclarée') : `refusée : ${r.error ?? ''}`,
      r.declared ? 'fait' : 'manque')),
    ...fait.records.map((r) => ligneRecord(r,
      r.written ? 'écrit' : `refusé : ${r.error ?? ''}`, r.written ? 'fait' : 'manque')),
  ];
  return `<div class="recette-bloc ${partiel ? 'avertissement' : 'note-transitoire'}"
               role="status" id="recette-resultat">
    <p class="recette-bloc__titre"><strong>${echapper(fait.label)}</strong> — ${
      echapper(fait.written)} écrit(s)${
      partiel ? `, ${echapper(fait.failed)} en échec` : ''}.</p>
    ${renderLignesRecette(lignes)}
    ${fait.incomplete ? `<p>${echapper(fait.incomplete)}</p>` : ''}
    <p class="note">${echapper(fait.propagation ?? '')}</p>
    <p class="formulaire__actions">
      <button type="button" class="bouton bouton--compact" data-verifier-recette
        ${ui.recettes?.verifieEnCours ? 'disabled' : ''}>Vérifier dans le DNS</button>
    </p>
    <div id="recette-verification">${renderVerification(ui.recettes)}</div>
  </div>`;
}

/**
 * Ce que la zone porte MAINTENANT (SPK-78, §38.9.1).
 *
 * @spec docs/BACKLOG.md#SPK-78 · docs/DAT.md §38.9 (une écriture se vérifie),
 *       §38.9.1 (relire plutôt que persister), §38.9.2 (conforme ≠ résolu) ·
 *       docs/DESIGN_SYSTEM.md §6.13
 *
 * Le compte rendu au-dessus dit ce qui a été ÉCRIT, une fois. Ce bloc-ci dit ce
 * qui EST en place, à l'instant où on le demande. Les deux ne se remplacent pas :
 * le premier vieillit, le second se relit.
 */
export function renderVerification(recettes) {
  if (recettes?.verificationErreur) {
    return `<p class="champ__erreur" id="recette-verification-refus">${
      echapper(recettes.verificationErreur)}</p>`;
  }
  if (recettes?.verifieEnCours && !recettes?.verification) {
    return '<p class="note" aria-busy="true">Relecture de la zone…</p>';
  }
  const vu = recettes?.verification;
  if (!vu) return '';
  const ecart = vu.some((l) => l.etat !== 'conforme');
  // §38.6.4 ter : le même gabarit que l'aperçu et le compte rendu.
  const lignes = vu.map((l) => ligneRecord(
    // La valeur TROUVÉE prend la place de l'attendue : « différent » seul
    // n'apprend pas quoi corriger.
    { ...l, data: l.etat === 'different' ? l.trouve : l.data },
    l.etat === 'conforme' ? 'conforme'
      : l.etat === 'absent' ? 'absent de la zone'
      : 'différent — valeur trouvée',
    l.etat === 'conforme' ? 'fait' : l.etat === 'absent' ? 'manque' : 'change'));
  return `<div class="recette-bloc ${ecart ? 'avertissement' : 'note-transitoire'}"
               role="status">
    <p class="recette-bloc__titre"><strong>Relevé du fournisseur</strong> — ${
      ecart ? 'des écarts subsistent' : 'chaque ligne est en place'}.</p>
    ${renderLignesRecette(lignes)}
    <p class="note">Ce relevé dit ce que le fournisseur PORTE. Un résolveur peut
    encore servir l’ancienne réponse pendant la durée du TTL.</p>
  </div>`;
}

/**
 * Ce que la déclaration vient de détourner (SPK-48, §18.3 bis).
 *
 * La déclaration a RÉUSSI — ce n'est pas un refus, donc accent et non danger.
 * Mais un exploitant qui déclare `admin.monapi.fr` doit savoir qu'il vient de
 * prendre le pas sur une adresse qui partait ailleurs : le silence ici
 * produirait une panne cherchée pendant des heures du mauvais côté.
 */
function renderPriseDePas(ui) {
  const prise = ui.supersedes;
  if (!prise) return '';
  return `<p class="avertissement" role="status" id="prise-de-pas">Cette route prend
    le pas sur <span class="technique">${echapper(prise.domain)}</span>, servi
    par le Spark <strong>${echapper(prise.spark_name)}</strong>. Ce nom ne part
    plus là-bas.</p>`;
}

/**
 * Les noms qu'un joker s'est fait SOUSTRAIRE (SPK-48, §18.3 bis).
 *
 * Dire la surcharge au moment où on la crée ne suffit pas : ce message passe
 * une fois, et l'exploitant du Spark porteur du joker ne l'a peut-être jamais
 * lu. C'est aussi ce qui manque au diagnostic — sans cette liste, on cherche
 * dans la configuration du Spark porteur, où il n'y a rien à trouver.
 *
 * Le repli est l'absence, jamais `undefined` à l'écran (§14.7) : une route
 * exacte ne porte pas cette clé, et un joker sans surcharge porte une liste
 * vide, ce qui n'est pas la même chose.
 */
function renderSurcharges(route) {
  const pris = route.superseded_by;
  if (!Array.isArray(pris) || pris.length === 0) return '';
  // §14.8 : une nature différente se distingue par la STRUCTURE, pas seulement
  // par la couleur — d'où une liste imbriquée SOUS la route, et non un badge.
  //
  // Elle est écrite en FIN de ligne, après les actions : la ligne est un flex
  // qui replie, et l'insérer avant les actions les renvoyait à la ligne
  // suivante. Mesuré sur la capture.
  return `<ul class="surcharges">${pris.map((p) =>
    `<li><span class="technique">${echapper(p.domain)}</span> est servi par le
     Spark <strong>${echapper(p.spark_name)}</strong></li>`).join('')}</ul>`;
}

/**
 * Ce qui a été ÉCRIT, et rien de plus (§38.4).
 *
 * On n'annonce jamais « le domaine est prêt » : la propagation prend le temps du
 * TTL, et un résolveur qui a déjà l'ancienne réponse en cache la sert encore.
 * Annoncer « prêt » ferait chercher la panne ailleurs pendant tout ce temps.
 */
function renderDnsEcrit(ui) {
  const ecrit = ui.dns?.written;
  if (!ecrit) return '';
  // `id` distinct de celui de l'effet : deux blocs de même classe et même rôle
  // coexistent dans cet écran — « sera remplacé » dans la modale, « a été écrit »
  // dans la section —, et les confondre ferait lire un projet pour un fait.
  return `<p class="avertissement" role="status" id="dns-ecrit">Enregistrement
    <span class="technique">${echapper(ecrit.type)} ${echapper(ecrit.fqdn)}
    → ${echapper(ecrit.data)}</span> écrit chez le fournisseur.
    ${echapper(ecrit.propagation ?? '')}</p>`;
}

/**
 * L'état DNS d'une route, relevé chez le fournisseur (SPK-78, §38.9.1).
 *
 * @spec docs/BACKLOG.md#SPK-78 · docs/DAT.md §38.9.1, §38.9.2 ·
 *       docs/DESIGN_SYSTEM.md §14.5 (une absence utile est NOMMÉE)
 *
 * Quatre états, et le dernier compte autant que les autres : un domaine dont
 * aucune zone du compte ne relève n'est pas « sans enregistrement ». Le produit
 * n'en sait rien, et dire « absent » ferait chercher un oubli là où il n'y a
 * rien à voir.
 *
 * Conforme ne veut pas dire résolu (§38.9.2) : le titre le rappelle, parce que
 * le §38.4 reste entier.
 */
export function renderEtatDns(dnsRoutes, domaine) {
  const etat = dnsRoutes?.etats?.[String(domaine ?? '').toLowerCase()];
  if (!etat) return '';
  const badge = (classe, texte, titre) =>
    ` <span class="badge ${classe}" title="${echapper(titre)}">${echapper(texte)}</span>`;
  if (etat.etat === 'ici') {
    return badge('badge--success', 'DNS ici',
      "Le fournisseur porte un enregistrement vers cette Forge. La résolution "
      + "peut demander le temps du TTL.");
  }
  if (etat.etat === 'ailleurs') {
    return badge('badge--danger', `DNS → ${etat.data}`,
      "Ce nom pointe ailleurs que vers cette Forge : le trafic n'arrivera pas ici.");
  }
  if (etat.etat === 'absent') {
    return badge('badge--accent', 'Aucun enregistrement',
      `La zone « ${etat.zone} » ne porte aucun A ou AAAA pour ce nom.`);
  }
  return badge('badge--neutral', 'Zone hors du compte',
    "Aucune zone de ce compte ne contient ce nom : son DNS est tenu ailleurs, "
    + "et le produit n'a rien à en dire.");
}

/**
 * « Pointer le domaine » : modale limitée à la section des routes (§6.27).
 *
 * Le domaine n'est PAS saisissable : il vient de la route qu'on pointe. Le
 * rendre modifiable ici laisserait poser un enregistrement pour un domaine que
 * la Forge ne route pas, c'est-à-dire un domaine qui résoudrait vers un 404.
 */
function renderDnsModale(ui) {
  const dns = ui.dns ?? ADMIN_VIDE.dns;
  const domaine = dns.domain ?? '';

  const corps = dns.loading
    ? '<p class="absence">Lecture des zones du compte…</p>'
    : dns.configured === false
      ? `<p class="absence">${echapper(dns.reason ?? '')}</p>
         <p class="champ__aide">Le jeton vit sur ce poste, jamais sur la Forge :
         un jeton déposé sur la Forge serait lisible par qui y détient
         l’administration.</p>`
      // §38.1.1 : un refus se dit AVANT le vide, et sans l'aide sur la place du
      // jeton — le jeton EST là, c'est le fournisseur qui l'a rejeté, et
      // conseiller d'en poser un enverrait chercher au mauvais endroit.
      : dns.refus
        ? `<p class="refus" id="dns-refus">${echapper(dns.refus)}</p>`
      : dns.zones.length === 0
        ? '<p class="absence">Le compte ne porte aucune zone DNS.</p>'
        : `
         <div class="champ">
           <label for="dns-domaine">Domaine de la route</label>
           <input class="controle technique" id="dns-domaine" type="text" readonly
                  value="${echapper(domaine)}">
           <p class="champ__aide">Il vient de la route publique : la Forge ne
           routerait pas un autre nom.</p>
         </div>
         <div class="champ">
           <label for="dns-zone">Zone</label>
           <select class="controle" id="dns-zone" name="dns_zone">
             <option value="">— choisir une zone —</option>
             ${dns.zones.map((z) =>
               `<option value="${echapper(z.zone)}"` +
               `${ui.values.dns_zone === z.zone ? ' selected' : ''}>` +
               `${echapper(z.zone)}${z.status === 'active' ? '' : ` (${echapper(z.status)})`}` +
               `</option>`).join('')}
           </select>
         </div>
         <div class="champ">
           <label for="dns-adresse">Adresse publique de la Forge</label>
           <input class="controle technique" id="dns-adresse" name="dns_address" type="text"
                  autocomplete="off" value="${echapper(ui.values.dns_address)}">
           <p class="champ__aide">C’est l’adresse de la FORGE, pas celle du Spark :
           un Spark vit sur un réseau privé, et c’est Caddy qui répartit ensuite
           par nom d’hôte.</p>
         </div>
         <p class="note">Sera écrit :
           <span class="technique" id="dns-apercu">${echapper(apercu(domaine, ui.values))}</span>,
           TTL 300 s. Rien d’autre n’est touché dans la zone.</p>
         <div id="dns-effet">${renderEffet(dns)}</div>`;

  return renderModale({
    ouverte: ui.open === 'dns', id: 'dns',
    titre: 'Pointer le domaine',
    engagement: 'Poser l’enregistrement',
    refus: ui.refusal?.panel === 'dns' ? ui.refusal.message : null,
    occupee: ui.busy,
    corps,
  });
}

/**
 * Ce que l'écriture fera à ce qui est DÉJÀ là (§38.5.2).
 *
 * C'est ce qui remplace le refus d'écrire à l'apex : on ne retire pas le
 * pouvoir, on montre ce qu'il va faire. Un écrasement reste le comportement
 * voulu — reposer une route déplacée doit marcher — mais jamais une surprise.
 *
 * Exporté parce que l'écran le remplace SUR PLACE, dans `#dns-effet`, sans
 * repeindre. Mesuré : repeindre la modale pendant la lecture reconstruisait le
 * formulaire sous les doigts — le focus repartait au premier champ, et le bouton
 * d'engagement se détachait sous le clic.
 */
export function renderEffet(dns) {
  const vu = dns.apercu;
  // Pendant une RELECTURE, on garde ce qui est affiché et on le marque occupé.
  //
  // Mesuré : vider le bloc le faisait rétrécir, la modale avec — et le bouton
  // d'engagement se dérobait entre l'appui et le relâchement. Le clic ne partait
  // jamais. Un bloc qui change de hauteur sous le curseur est un piège, pas une
  // information (docs/DESIGN_SYSTEM.md §6.13).
  if (dns.apercuEnCours && !vu) {
    return '<p class="note" aria-busy="true">Lecture de ce qui est déjà en place…</p>';
  }
  if (!vu) return '';
  const occupe = dns.apercuEnCours ? ' aria-busy="true"' : '';

  if (vu.effet === 'inchange') {
    return `<p class="note" role="status"${occupe}>Cet enregistrement porte déjà cette
      valeur : l’écrire ne changera rien.</p>`;
  }
  if (vu.effet === 'remplace') {
    // Accent, pas danger : remplacer est le geste demandé, pas une panne — mais
    // la valeur remplacée doit être LUE avant, pas devinée après.
    return `<p class="avertissement" role="status"${occupe}>Cet enregistrement existe déjà.
      Il sera <strong>remplacé</strong> :
      <span class="technique">${echapper(vu.current?.data ?? '')}</span> →
      <span class="technique">${echapper(vu.data)}</span>.${
      vu.apex ? ' C’est le domaine <strong>nu</strong> : le remplacer déplace tout'
              + ' ce qui répond sur ce domaine, pas seulement un sous-domaine.' : ''}</p>`;
  }
  return `<p class="note" role="status"${occupe}>Rien n’occupe ce nom pour l’instant :
    l’enregistrement sera posé.${
    vu.apex ? ' Il porte sur le domaine <strong>nu</strong>.' : ''}</p>`;
}

/**
 * Aperçu de l'enregistrement, tel qu'il partira.
 *
 * Exporté parce que l'écran le RECALCULE à chaque frappe sans repeindre : un
 * repeint à chaque touche déplacerait le curseur, et un aperçu qui ne suit pas
 * la saisie est pire que pas d'aperçu — il montre une valeur qui ne sera pas
 * écrite. Mesuré par le parcours E2E.
 */
export function apercu(domaine, valeurs = {}) {
  const adresse = String(valeurs.dns_address ?? '').trim();
  const type = adresse.includes(':') ? 'AAAA' : 'A';
  return `${nomAEcrire(domaine, valeurs.dns_zone)} ${type} → ${adresse || '…'}`;
}

/**
 * Nom relatif tel qu'il sera écrit, ou un tiret tant que la zone n'est pas
 * choisie.
 *
 * L'apex s'écrit `@` — la notation des fichiers de zone —, pas un tiret : un
 * tiret se lit « rien » là où il faut lire « le domaine lui-même ».
 */
function nomAEcrire(domaine, zone) {
  if (!zone) return '—';
  const d = String(domaine ?? '').toLowerCase();
  const z = String(zone).toLowerCase();
  if (d === z) return '@';
  return d.endsWith(`.${z}`) ? d.slice(0, -(z.length + 1)) : '—';
}

/* ------------------------------------------------------------ ports publiés */

/**
 * Ports publiés d'un Spark (SPK-49, §39).
 *
 * Il vit sous les routes publiques, et c'est délibéré : le §39.3 veut que
 * l'écran propose le NOM d'abord, et présente le port publié comme un second
 * geste qui annonce ce qu'il coûte. Publier un port pour une application qui
 * parle HTTP est presque toujours une erreur — on perd le certificat
 * automatique sans rien gagner. Le produit ne l'interdit pas ; il le dit.
 */
export function renderPortsPanel(spark, ports = [], ui = ADMIN_VIDE,
                                 reserved = []) {
  const lignes = ports.length
    ? `<ul class="liste-administrable">${ports.map((p) => {
        const attente = p.applied_at
          ? ''
          : ` <span class="badge badge--accent"><span class="badge__point" aria-hidden="true"></span>non appliqué</span>`;
        const confirme = ui.confirming?.kind === 'port' && ui.confirming.id === String(p.public_port)
          ? `<div class="confirmation" role="group" aria-label="Confirmer le retrait">
               <p><strong>Retirer le port ${echapper(p.public_port)} ?</strong></p>
               <p class="confirmation__consequence">Ce port cessera d’être joignable
               depuis l’extérieur immédiatement. Le Spark et ses données ne sont pas
               touchés.</p>
               <p class="confirmation__actions">
                 <button type="button" class="bouton bouton--destructif" data-confirme-port="${echapper(p.public_port)}">Retirer le port</button>
                 <button type="button" class="bouton" data-annule="port">Annuler</button>
               </p>
             </div>`
          : '';
        return `<li><span class="technique">${echapper(p.public_port)}/${echapper(p.protocol)}</span>` +
          ` de la Forge → port ${echapper(p.target_port)} du Spark${attente}` +
          (p.note ? ` <span class="note">${echapper(p.note)}</span>` : '') +
          `<span class="actions-ligne">` +
          `<button type="button" class="bouton bouton--compact" data-retire-port="${echapper(p.public_port)}">Retirer</button></span>` +
          `${confirme}</li>`;
      }).join('')}</ul>`
    : '<p class="absence">Aucun port de la Forge ne mène à ce Spark.</p>';

  const interdits = reserved.length
    ? `<p class="champ__aide">Réservés sur cette Forge : ${reserved.map((r) =>
        `<span class="technique">${echapper(r.port)}</span> (${echapper(r.reason)})`)
        .join(', ')}.</p>`
    : '';

  const modale = renderModale({
    ouverte: ui.open === 'port', id: 'port', titre: 'Publier un port',
    engagement: 'Publier le port',
    refus: ui.refusal?.panel === 'port' ? ui.refusal.message : null,
    occupee: ui.busy,
    corps: `
         <p class="avertissement" role="status">Un port publié <strong>perd le
         certificat automatique</strong> : le proxy ne le voit pas passer. Si
         l’application parle HTTP, déclarez plutôt une <strong>route publique</strong>
         ci-dessus — elle donne le TLS sans rien demander. Ce geste sert à ce qui
         ne parle pas HTTP : messagerie, base de données, SSH.</p>
         <div class="champ">
           <label for="port-public">Port de la Forge</label>
           <input class="controle" id="port-public" name="public_port" type="number"
                  min="1" max="65535" value="${echapper(ui.values.public_port)}">
           <p class="champ__aide">Un port de la Forge appartient à la <strong>machine</strong>,
           pas au Spark : le premier qui le prend le prend.</p>
           ${interdits}
         </div>
         <div class="champ">
           <label for="port-cible">Port du Spark</label>
           <input class="controle" id="port-cible" name="target_port" type="number"
                  min="1" max="65535" value="${echapper(ui.values.target_port)}">
         </div>
         <div class="champ">
           <label for="port-protocole">Protocole</label>
           <select class="controle" id="port-protocole" name="protocol">
             <option value="tcp"${ui.values.protocol === 'udp' ? '' : ' selected'}>TCP</option>
             <option value="udp"${ui.values.protocol === 'udp' ? ' selected' : ''}>UDP</option>
           </select>
         </div>
         <div class="champ">
           <label for="port-note">À quoi il sert</label>
           <input class="controle" id="port-note" name="port_note" type="text"
                  autocomplete="off" placeholder="SMTP entrant"
                  value="${echapper(ui.values.port_note)}">
           <p class="champ__aide">Six mois plus tard, c’est la seule chose qui
           dira pourquoi ce port est ouvert.</p>
         </div>`,
  });

  return `
<section class="carte bloc" aria-labelledby="titre-ports">
  <h2 id="titre-ports">Ports publiés</h2>
  <p class="note">Pour ce qui ne parle pas HTTP. Le reste passe par une route publique.</p>
  ${lignes}
  ${declencheur('port', 'Publier un port')}
  ${modale}
</section>`;
}

/* -------------------------------------------------------------------- clés */

/**
 * Clés autorisées.
 *
 * L'empreinte affichée est celle que le serveur rend, jamais un condensat
 * recalculé ici (§17.2, §26.4).
 */
export function renderKeysPanel(spark, { keys = [], registry = [], sshConfig = null } = {},
                                ui = ADMIN_VIDE) {
  const accordees = new Set(keys.map((k) => k.label));
  const disponibles = registry.filter((k) => !accordees.has(k.label));

  const lignes = keys.length
    ? `<ul class="liste-administrable">${keys.map((k) =>
        `<li>${echapper(k.label)} <span class="technique">${echapper(k.fingerprint)}</span>` +
        `<span class="actions-ligne"><button type="button" class="bouton bouton--compact" ` +
        `data-revoque="${echapper(k.label)}">Révoquer</button></span></li>`).join('')}</ul>`
    : "<p class=\"absence\">Aucune clé n’est autorisée : personne ne peut s’y connecter.</p>";

  // §26.4 : révoquer est réversible et ne confirme pas — mais révoquer la
  // DERNIÈRE clé ferme le Spark à tout le monde, et cela se dit avant le geste.
  const derniere = keys.length === 1
    ? `<p class="avertissement" role="status">C’est la seule clé autorisée :
       la révoquer fermera ce Spark à tout le monde.</p>`
    : '';

  // §35.2 : la révocation qui traverse un Spark protégé le NOMME avant d'aboutir.
  const traverse = ui.refusal?.panel === 'key' && ui.refusal.protected_sparks
    ? renderProtectedRevocation(ui.refusal)
    : '';

  const choixRegistre = disponibles.length
    ? `<div class="champ">
         <label for="cle-registre">Clé déjà enregistrée</label>
         <select class="controle" id="cle-registre" name="key_label">
           <option value="">— choisir une clé —</option>
           ${disponibles.map((k) =>
             `<option value="${echapper(k.label)}"${ui.values.key_label === k.label ? ' selected' : ''}>` +
             `${echapper(k.label)}</option>`).join('')}
         </select>
       </div>`
    : `<p class="absence">Le registre ne contient aucune clé que ce Spark n’ait déjà.</p>`;

  const modale = renderModale({
    ouverte: ui.open === 'key', id: 'key', titre: 'Clés autorisées',
    engagement: 'Autoriser', refus: ui.refusal?.panel === 'key' ? ui.refusal.message : null,
    occupee: ui.busy,
    corps: `
         ${choixRegistre}
         <p class="note">ou enregistrer une clé nouvelle, qui sera accordée dans la foulée :</p>
         <div class="champ">
           <label for="cle-libelle">Libellé</label>
           <input class="controle" id="cle-libelle" name="new_label" type="text"
                  autocomplete="off" value="${echapper(ui.values.new_label)}">
         </div>
         <div class="champ">
           <label for="cle-publique">Clé publique</label>
           <input class="controle technique" id="cle-publique" name="public_key" type="text"
                  autocomplete="off" placeholder="ssh-ed25519 AAAA… poste-de-travail"
                  value="${echapper(ui.values.public_key)}">
           <p class="champ__aide">Seule une clé publique est acceptée. Une clé privée
           collée par erreur est refusée par le registre, pas détectée plus tard.</p>
         </div>`,
  });

  // §17.4 et §26.4 : le fragment vient du serveur, il n'est pas reconstruit ici.
  const fragment = sshConfig?.config
    ? `<h3>Configuration SSH</h3>
       <pre class="fragment technique">${echapper(sshConfig.config)}</pre>
       <p class="note">Un Spark n’expose jamais son port 22 : l’accès passe par
       rebond sur la Forge — c’est ce que porte le fragment ci-dessus.
       <a href="#/manuel/M6">Manuel M6 — Se connecter</a></p>`
    : '';

  return `
<section class="carte bloc" aria-labelledby="titre-cles">
  <h2 id="titre-cles">Clés autorisées</h2>
  ${lignes}
  ${derniere}
  ${traverse}
  ${declencheur('key', 'Autoriser une clé')}
  ${fragment}
  ${modale}
  <p class="note">Retirer une clé du registre commun — donc de tous les Sparks à la
  fois — ne se fait pas depuis cet écran.</p>
</section>`;
}

/* ------------------------------------------------------------- instantanés */

/**
 * Bloc de refus « des instantanés plus récents bloquent la restauration ».
 *
 * §26.5, et c'est la règle à ne pas inverser : l'acceptation de la perte n'est
 * offerte qu'APRÈS ce refus. Une case cochée d'avance le serait par habitude, et
 * ferait perdre des instantanés jamais regardés. Le refus est ce qui rend la
 * perte visible.
 */
/**
 * La révocation d'une clé traverse un Spark protégé, et le NOMME (SPK-34).
 *
 * @spec docs/BACKLOG.md#SPK-34 · docs/DAT.md §35.2 (retirer un accès passe
 *       toujours), §35.5 (l'ordre refus-puis-acceptation) ·
 *       docs/DESIGN_SYSTEM.md §6.23 (une protection ne bloque jamais un geste
 *       qui réduit un risque), §6.22 (la confirmation reste dans le flux)
 *
 * Ce n'est PAS un blocage : c'est la façon dont le runtime dit ce qu'il va
 * toucher. Le §6.23 l'exige mot pour mot — les objets protégés sont **nommés**,
 * pas comptés, et l'action aboutit sans qu'aucune protection soit levée.
 *
 * Le bouton n'est PAS destructif : révoquer un accès réduit un risque. Le §6.23
 * interdit d'employer `danger` parce qu'une action est importante.
 */
export function renderProtectedRevocation(refusal) {
  if (!refusal?.protected_sparks?.length) return '';
  const noms = refusal.protected_sparks;
  const n = noms.length;
  return `<div class="refus" role="alert">
    <p><strong>Révoquer « ${echapper(refusal.label)} » touche ${n} Spark${
      n > 1 ? 's' : ''} protégé${n > 1 ? 's' : ''}.</strong></p>
    <ul class="liste-simple">${noms.map((nom) =>
      `<li><span class="technique">${echapper(nom)}</span></li>`).join('')}</ul>
    <p class="confirmation__consequence">Retirer un accès n’est jamais refusé par
    la protection : elle arrête l’erreur, elle ne retient pas un geste qui réduit
    un risque. <strong>Aucune protection ne sera levée.</strong></p>
    <p class="confirmation__actions">
      <button type="button" class="bouton bouton--primaire" data-accepte-protege="${
        echapper(refusal.label)}">Révoquer quand même</button>
      <button type="button" class="bouton" data-annule="key">Annuler</button>
    </p>
  </div>`;
}

export function renderBlockedRestore(refusal) {
  if (!refusal?.blocking?.length) return '';
  const n = refusal.blocking.length;
  // Le bouton final est destructif : il doit nommer SA cible, pas seulement le
  // nombre de victimes. Trois instantanés portent chacun leur « Restaurer ».
  return `<div class="refus" role="alert">
    <p><strong>Restauration de « ${echapper(refusal.snapshot)} » refusée : ${n} instantané${n > 1 ? 's' : ''} plus récent${n > 1 ? 's' : ''} serai${n > 1 ? 'ent' : 't'} détruit${n > 1 ? 's' : ''}.</strong></p>
    <ul class="liste-simple">${refusal.blocking.map((b) =>
      `<li><span class="technique">${echapper(b)}</span></li>`).join('')}</ul>
    <p class="confirmation__consequence">Revenir à un point antérieur détruit
    définitivement tout ce qui a été capturé depuis.</p>
    <p class="confirmation__actions">
      <button type="button" class="bouton bouton--destructif" data-accepte-perte="${echapper(refusal.snapshot)}">
        Restaurer en perdant ${n > 1 ? `ces ${n} instantanés` : 'cet instantané'}</button>
      <button type="button" class="bouton" data-annule="snapshot">Annuler</button>
    </p>
  </div>`;
}

/** Instantanés. `stateful` n'est pas proposé : il échoue sur cette Forge (§19.3). */
export function renderSnapshotsPanel(spark, snapshots = [], ui = ADMIN_VIDE) {
  const lignes = snapshots.length
    ? `<ul class="liste-administrable">${snapshots.map((s) => {
        const nom = s.incus_name;
        const taille = s.size_bytes != null ? ` — ${formatBytes(s.size_bytes)}` : '';
        const confirmeSuppression = ui.confirming?.kind === 'snapshot-delete' && ui.confirming.id === nom
          ? `<div class="confirmation" role="group" aria-label="Confirmer la suppression">
               <p><strong>Supprimer « ${echapper(nom)} » ?</strong></p>
               <p class="confirmation__consequence">Cet instantané est détruit
               définitivement. Le Spark n’est pas touché.</p>
               <p class="confirmation__actions">
                 <button type="button" class="bouton bouton--destructif" data-confirme-suppression="${echapper(nom)}">Supprimer</button>
                 <button type="button" class="bouton" data-annule="snapshot">Annuler</button>
               </p>
             </div>`
          : '';
        const confirmeRestauration = ui.confirming?.kind === 'snapshot-restore' && ui.confirming.id === nom
          ? `<div class="confirmation" role="group" aria-label="Confirmer la restauration">
               <p><strong>Restaurer « ${echapper(nom)} » ?</strong></p>
               <p class="confirmation__consequence">L’état actuel de la cellule est
               remplacé par celui de cet instantané. Ce qui a été écrit depuis est perdu.</p>
               <p class="confirmation__actions">
                 <button type="button" class="bouton bouton--destructif" data-confirme-restauration="${echapper(nom)}">Restaurer</button>
                 <button type="button" class="bouton" data-annule="snapshot">Annuler</button>
               </p>
             </div>`
          : '';
        const bloque = ui.refusal?.panel === 'snapshot' && ui.refusal.snapshot === nom
          ? renderBlockedRestore(ui.refusal)
          : '';
        return `<li><span class="technique">${echapper(nom)}</span>` +
          `<span class="absence"> — ${echapper(formatDate(s.created_at))}${echapper(taille)}</span>` +
          `<span class="actions-ligne">` +
          `<button type="button" class="bouton bouton--compact" data-restaure="${echapper(nom)}">Restaurer</button>` +
          `<button type="button" class="bouton bouton--compact" data-supprime-instantane="${echapper(nom)}">Supprimer</button>` +
          `</span>${confirmeSuppression}${confirmeRestauration}${bloque}</li>`;
      }).join('')}</ul>`
    : '<p class="absence">Aucun instantané.</p>';

  const modale = renderModale({
    ouverte: ui.open === 'snapshot', id: 'snapshot', titre: 'Instantanés',
    engagement: 'Prendre l’instantané', occupee: ui.busy,
    refus: (ui.refusal?.panel === 'snapshot' && !ui.refusal.blocking && !ui.refusal.snapshot)
      ? ui.refusal.message : null,
    corps: `
         <div class="champ">
           <label for="instantane-nom">Nom de l’instantané</label>
           <input class="controle" id="instantane-nom" name="snapshot" type="text"
                  autocomplete="off" placeholder="avant-deploiement"
                  value="${echapper(ui.values.snapshot)}">
           <p class="champ__aide">Un instantané consomme le quota disque du Spark :
           il coûte d’abord zéro, puis grossit à mesure que le Spark s’en écarte.</p>
         </div>`,
  });

  return `
<section class="carte bloc" aria-labelledby="titre-instantanes">
  <h2 id="titre-instantanes">Instantanés</h2>
  ${lignes}
  ${declencheur('snapshot', 'Prendre un instantané')}
  ${modale}
  <p class="note">Un instantané rend l’état complet de la cellule. Il vit dans le
  même pool que le Spark : il ne protège ni de la perte du pool, ni de celle de la
  machine, et consomme le quota disque.</p>
</section>`;
}
