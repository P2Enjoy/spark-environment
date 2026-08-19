/**
 * Point d'entrée de la console dans le navigateur.
 *
 * @spec docs/BACKLOG.md#SPK-18, docs/BACKLOG.md#SPK-21 ·
 *       docs/DAT.md §26 (les trois panneaux d'administration, §26.2 le contrat
 *       d'interaction, §26.5 l'ordre refus-puis-acceptation) ·
 *       docs/BACKLOG.md#SPK-22 · docs/DAT.md §27 (l'écran des pools) ·
 *       docs/DESIGN_SYSTEM.md §5.1, §6.13, §6.22, §9.1, §9.7
 */

import { renderSparksView } from './components/sparks-view.js';
import { renderSparkDetail } from './components/spark-detail.js';
import { renderSparkCreate, validateShape, DEFAUTS } from './components/spark-create.js';
import { ADMIN_VIDE } from './components/spark-admin.js';
import { renderHostView } from './components/host-view.js';
import { renderCatalogue, renderOngletsHote, renderOnglets, CATALOGUE_VIDE } from './components/host-images.js';
import { renderJournalHotePage, FILTRES_VIDES } from './components/host-journal.js';
import { renderServeurs, CATALOGUE_SERVEURS_VIDE } from './components/servers-view.js';
import { brancherModale } from './components/modale.js';
import { tunnelOf } from './components/tokens.js';

const racine = document.getElementById('racine');
const etat = { status: 'loading', sparks: [], usage: {}, error: null,
               sort: { key: 'name', dir: 'asc' }, tunnel: null, server: null,
               route: 'liste', spark: null, detail: {}, confirming: null,
               creation: { values: { ...DEFAUTS }, errors: {}, refusal: null,
                           pools: null, submitting: false, images: [] },
               admin: { ...ADMIN_VIDE, values: { ...ADMIN_VIDE.values } },
               hote: { status: 'loading', host: null, cores: null,
                       sparkNames: {}, error: null, syncing: false },
               facette: '',
               servers: [],
               catalogueServeurs: { status: 'loading', servers: [], tunnels: [],
                                    current: null, error: null,
                                    ui: { ...CATALOGUE_SERVEURS_VIDE,
                                          values: { ...CATALOGUE_SERVEURS_VIDE.values } } },
               journal: { status: 'loading', entries: [], error: null,
                          filtres: { ...FILTRES_VIDES },
                          chain: null, anchor: null, checking: false },
               catalogue: { status: 'loading', images: [], error: null,
                            ui: { ...CATALOGUE_VIDE, values: { ...CATALOGUE_VIDE.values } } } };

/**
 * L'indicateur de page courante SUIT la route.
 *
 * Il était écrit en dur sur « Sparks » : sur l'écran de l'hôte, un lecteur
 * d'écran annonçait donc la mauvaise page courante (docs/DESIGN_SYSTEM.md §5.1,
 * §9.7). Un indicateur qui ment est pire qu'un indicateur absent.
 */
function marquerNavigation() {
  // Le premier degré reste « Sparks » quand on est dans une section de l'hôte :
  // les onglets du second degré portent leur propre `aria-current` (§34.1).
  const courant = etat.route === 'serveurs' ? '#/serveurs'
    : ['hote', 'images', 'journal'].includes(etat.route) ? '#/hote' : '#/sparks';
  for (const lien of racine.querySelectorAll('nav a')) {
    if (lien.getAttribute('href') === courant) lien.setAttribute('aria-current', 'page');
    else lien.removeAttribute('aria-current');
  }
}

function peindre() {
  marquerNavigation();
  racine.querySelector('.principal').innerHTML =
    etat.route === 'creation' && etat.status === 'loading'
      ? '<div class="carte bloc" aria-busy="true"><p class="sr-only" role="status">Chargement…</p></div>'
      : etat.route === 'images'
      ? renderOngletsHote('#/hote/images') + renderCatalogue(etat.catalogue)
      : etat.route === 'journal'
      ? renderJournalHotePage(etat.journal)
      : etat.route === 'serveurs'
      ? renderServeurs(etat.catalogueServeurs)
      : etat.route === 'hote'
      ? renderOngletsHote('#/hote') + renderHostView(etat.hote)
      : etat.route === 'creation'
      ? renderSparkCreate(etat.creation)
      : etat.route === 'detail'
      ? renderSparkDetail({ status: etat.status, spark: etat.spark, error: etat.error,
                            confirming: etat.confirming, admin: etat.admin,
                            facette: etat.facette, ...etat.detail })
      : renderOnglets([['#/sparks', 'Instances']], '#/sparks', 'Sections des Sparks')
        + renderSparksView(etat);
  brancher();
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
  racine.querySelector('[data-action="relever-images"]')?.addEventListener('click', releverImages);
  brancherCatalogue();
  brancherJournal();
  brancherServeurs();

  const formulaire = racine.querySelector('#formulaire-spark');
  if (formulaire) {
    // Les valeurs vivent dans l'état : un refus ne doit rien effacer (§25.2).
    for (const controle of formulaire.querySelectorAll('input, select')) {
      controle.addEventListener('input', () => {
        const brut = controle.value;
        etat.creation.values[controle.name] =
          controle.type === 'number' ? Number(brut) : brut;
        if (controle.name === 'cpu_mode') peindre();   // les champs suivent le mode
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
        peindre();
        // §6.22 : le focus entre dans la confirmation.
        racine.querySelector('[data-confirme]')?.focus();
        return;
      }
      lancer(commande);
    });
  }
  brancherPanneaux();
  // §6.27 : le contrat de la modale est tenu à UN SEUL endroit — focus entrant,
  // focus retenu, Échap qui vaut annulation, focus rendu au déclencheur.
  brancherModale(racine, {
    onFermer: () => {
      etat.admin.open = null;
      etat.admin.refusal = null;
      etat.catalogue.ui.open = false;
      etat.catalogue.ui.refusal = null;
      etat.catalogueServeurs.ui.open = false;
      etat.catalogueServeurs.ui.refusal = null;
      etat.catalogueServeurs.ui.probe = null;
      peindre();
    },
  });
  racine.querySelector('[data-confirme]')?.addEventListener('click', () => lancer('delete'));
  racine.querySelector('[data-annule]')?.addEventListener('click', () => {
    etat.confirming = null;
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
function brancherPanneaux() {
  const admin = etat.admin;

  // Les trois panneaux, nommés : `[data-ouvre]` capterait aussi le déclencheur
  // du catalogue, qui vit sur une autre destination et a son propre état.
  for (const bouton of racine.querySelectorAll(
    '[data-ouvre="route"], [data-ouvre="key"], [data-ouvre="snapshot"],'
    + ' [data-ouvre="protection"]')) {
    bouton.addEventListener('click', () => {
      admin.open = bouton.dataset.ouvre;
      admin.refusal = null;
      admin.confirming = null;
      peindre();
      // Le focus entrant appartient à `brancherModale` (§6.27).
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
    + ' [data-modale="protection"]');
  if (formulaire) {
    for (const controle of formulaire.querySelectorAll('input, select')) {
      controle.addEventListener('input', () => {
        admin.values[controle.name] =
          controle.type === 'checkbox' ? controle.checked
          : controle.type === 'number' ? Number(controle.value)
          : controle.value;
      });
    }
    formulaire.addEventListener('submit', (evenement) => {
      evenement.preventDefault();
      const quoi = formulaire.dataset.modale;
      if (quoi === 'route') return declarerRoute();
      if (quoi === 'key') return autoriserCle();
      if (quoi === 'snapshot') return prendreInstantane();
      if (quoi === 'protection') return basculerProtection();
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
  demande('retire-route', 'route');
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
  geste('confirme-restauration', (nom) => restaurer(nom, false));
  // §26.5 : l'acceptation de la perte n'est atteignable qu'APRÈS le refus.
  geste('accepte-perte', (nom) => restaurer(nom, true));
}

/** Appel d'écriture. Rend toujours `{ ok, corps }` : un refus est une réponse,
 *  pas une exception à faire remonter jusqu'à l'écran d'erreur global. */
async function appel(methode, chemin, corps = null) {
  const reponse = await fetch(
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
  if (resultat?.ok) etat.admin.values = { ...ADMIN_VIDE.values };
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
    await fetch(`/api/v1/sparks/${encodeURIComponent(etat.spark.name)}/${commande}?server=${encodeURIComponent(etat.server)}`,
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
    const hote = await api('/v1/host');
    etat.creation.pools = hote.pools;
  } catch {
    // Capacité inconnue : l'écran le dit plutôt que d'inventer des chiffres.
    etat.creation.pools = null;
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
    const reponse = await fetch(`/api/v1/sparks?server=${encodeURIComponent(etat.server)}`,
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
  peindre();
  try {
    etat.spark = await api(`/v1/sparks/${encodeURIComponent(nom)}`);
    const [usage, routes, sshConfig, registry, snapshots, audit] = await Promise.all([
      api(`/v1/sparks/${encodeURIComponent(nom)}/usage`).catch(() => null),
      api('/v1/ingress').then((r) => r.routes.filter((x) => x.spark_name === nom)).catch(() => []),
      api(`/v1/sparks/${encodeURIComponent(nom)}/ssh-config`).catch(() => null),
      api('/v1/ssh-keys').then((r) => r.keys).catch(() => []),
      api(`/v1/sparks/${encodeURIComponent(nom)}/snapshots`).then((s) => s.snapshots).catch(() => []),
      api('/v1/audit?limit=200').then((a) => a.entries.filter((e) => e.target_id === etat.spark.id)).catch(() => []),
    ]);
    etat.detail = { usage, routes, keys: sshConfig?.keys ?? [], registry, sshConfig,
                    snapshots, audit };
    etat.status = 'ready';
  } catch (erreur) {
    etat.status = 'error';
    etat.error = erreur;
  }
  peindre();
}

/**
 * Écran des pools (docs/DAT.md §27).
 *
 * Une topologie jamais relevée répond `409 host_not_synced` : ce n'est pas une
 * panne mais une machine qu'on n'a pas encore interrogée, et l'écran présente
 * son remède comme une action (§27.8).
 */
async function chargerHote() {
  etat.route = 'hote';
  etat.hote.status = 'loading';
  etat.hote.error = null;
  peindre();
  try {
    etat.hote.host = await api('/v1/host');
    const [cores, sparks] = await Promise.all([
      api('/v1/host/cores').catch(() => null),
      api('/v1/sparks').then((r) => r.sparks).catch(() => []),
    ]);
    etat.hote.cores = cores;
    // La carte des cœurs porte des identifiants de Sparks ; l'écran affiche des
    // NOMS. Un identifiant interne sans intérêt ne doit pas atteindre l'écran
    // (docs/DESIGN_SYSTEM.md §3.1).
    etat.hote.sparkNames = Object.fromEntries(sparks.map((s) => [s.id, s.name]));
    etat.hote.status = 'ready';
  } catch (erreur) {
    etat.hote.error = erreur;
    etat.hote.status = erreur.code === 'host_not_synced' ? 'not-synced' : 'error';
  }
  peindre();
}

async function relever() {
  etat.hote.syncing = true;
  peindre();
  try {
    await fetch(`/api/v1/host/sync?server=${encodeURIComponent(etat.server)}`, { method: 'POST' });
  } catch { /* l'état réel sera relu ci-dessous */ }
  etat.hote.syncing = false;
  await chargerHote();
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

/** Relevé explicite (§33.3). Il ne détruit rien : aucune confirmation (§6.24). */
async function releverImages() {
  etat.catalogue.ui.syncing = true;
  peindre();
  try {
    await fetch(`/api/v1/images/verify?server=${encodeURIComponent(etat.server)}`,
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
    const reponse = await fetch(`/api/v1/images?server=${encodeURIComponent(etat.server)}`, {
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

function router() {
  if (location.hash === '#/serveurs') return chargerServeurs();
  if (location.hash === '#/hote/journal') return chargerJournal();
  if (location.hash === '#/hote/images') return chargerCatalogue();
  if (location.hash === '#/hote') return chargerHote();
  if (location.hash === '#/creer') return chargerCreation();
  // Chaque facette d'un Spark est une véritable destination : on doit pouvoir
  // recharger la page sur « Instantanés » (DESIGN_SYSTEM.md §5.4, §6.27).
  const detail = location.hash.match(/^#\/sparks\/([^/]+)(?:\/(routes|cles|instantanes|journal))?$/);
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
  router();
}

async function demarrer() {
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
}

demarrer();
