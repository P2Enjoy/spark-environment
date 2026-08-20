/**
 * Écran « créer un Spark ».
 *
 * @spec docs/BACKLOG.md#SPK-20, docs/BACKLOG.md#SPK-32 ·
 * @spec docs/BACKLOG.md#SPK-59 · docs/DESIGN_SYSTEM.md §6.9 bis (curseur ou
 *       saisie numérique) · docs/DESIGN_SYSTEM_APP.md SPK-DS-07 (la borne haute
 *       d'un quota est la capacité TOTALE de la Forge) — pour `QUOTAS`,
 *       `borneHaute`, `curseur` et `champQuota`.
 *       docs/DAT.md §25 (montrer sans décider), §33.5 (l'image se choisit dans
 *       une liste alimentée par le catalogue),
 *       §25.2 (un refus n'efface pas la saisie), §25.3 (ce qui reste local) ·
 *       docs/DESIGN_SYSTEM.md §6.9, §6.12, §7.1, §14.9
 *
 * Cet écran montre la capacité restante ; il ne décide jamais à la place de
 * `sparkd`. Le bouton n'est pas désactivé parce que l'estimation locale juge la
 * demande trop grande : cette estimation est une photographie qui peut être
 * périmée, et dans le sens favorable.
 */

import { formatBytes, formatBps, formatCpu, formatOctetsExact } from './tokens.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const GIO = 1024 ** 3;
const MBIT = 1e6;

export const DEFAUTS = {
  name: '', image: 'images:debian/13', cpu_mode: 'shared',
  cpu_reservation: 0.5, cpu_max: 0.5, cpu_cores: 1,
  memory_gib: 2, storage_gib: 10, network_mbit: 100,
};

/** Noms de ressources rendus en français. Une valeur technique brute ne doit
 *  pas atteindre l'écran (docs/DESIGN_SYSTEM.md §14.7). */
export const RESSOURCES = {
  cpu: { nom: 'processeur', format: (v) => `${formatCpu(v)} CPU` },
  memory: { nom: 'mémoire', format: formatBytes },
  storage: { nom: 'disque', format: formatBytes },
  network: { nom: 'réseau', format: formatBps },
};

export function describeShortfall(manque) {
  const info = RESSOURCES[manque.resource];
  const nom = info?.nom ?? manque.resource;
  const quantite = info ? info.format(manque.missing) : String(manque.missing);
  return `${nom} : il manque ${quantite}`;
}

export const MODES = {
  shared: 'Partagé — part du pool, burst autorisé',
  capped: 'Plafonné — jamais au-delà du plafond',
  dedicated: 'Dédié — cœurs physiques exclusifs',
  'shared-pinned': 'Épinglé partagé — cœurs imposés, non exclusifs',
};

/**
 * Contrôles LOCAUX. Ils portent sur la forme, jamais sur la capacité
 * (docs/DAT.md §25.3), et le runtime les double.
 */
export function validateShape(valeurs) {
  const erreurs = {};
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(valeurs.name ?? '')) {
    erreurs.name = valeurs.name
      ? 'Minuscules, chiffres et tirets, sans tiret aux extrémités.'
      : 'Requis pour créer un Spark.';
  }
  if (valeurs.cpu_mode === 'capped' && !(valeurs.cpu_max > 0))
    erreurs.cpu_max = 'Le mode plafonné demande un plafond.';
  if (['dedicated', 'shared-pinned'].includes(valeurs.cpu_mode) && !(valeurs.cpu_cores >= 1))
    erreurs.cpu_cores = 'Ce mode demande au moins un cœur.';
  if (['shared', 'shared-pinned'].includes(valeurs.cpu_mode) && !(valeurs.cpu_reservation > 0))
    erreurs.cpu_reservation = 'Ce mode demande une réservation.';
  for (const [champ, libelle] of [['memory_gib', 'La mémoire'], ['storage_gib', 'Le disque'],
                                  ['network_mbit', 'Le débit']]) {
    if (!(valeurs[champ] > 0)) erreurs[champ] = `${libelle} doit être supérieur à zéro.`;
  }
  return erreurs;
}

/** Ce que la demande prendrait au pool, selon les mêmes règles que le runtime. */
export function demandOf(valeurs) {
  const cpu = valeurs.cpu_mode === 'capped' ? valeurs.cpu_max
    : valeurs.cpu_mode === 'dedicated' ? 0
    : valeurs.cpu_reservation;
  return {
    cpu: Number(cpu) || 0,
    cores: valeurs.cpu_mode === 'dedicated' ? Number(valeurs.cpu_cores) || 0 : 0,
    memory: (Number(valeurs.memory_gib) || 0) * GIO,
    storage: (Number(valeurs.storage_gib) || 0) * GIO,
    network: (Number(valeurs.network_mbit) || 0) * 1e6,
  };
}

/**
 * Estimation locale. Rend les ressources qui **risquent** de manquer.
 *
 * Le mot « risquent » est important : cette photographie peut être périmée, et
 * l'écran n'en tire jamais un refus (docs/DAT.md §25.1).
 */
export function estimate(valeurs, pools) {
  if (!pools) return [];
  const demande = demandOf(valeurs);
  const cpu = (v) => `${formatCpu(v)} CPU`;
  // Deux formats par ligne, et ce n'est pas une coquetterie : ce qu'on DEMANDE
  // est la valeur réglée au curseur, elle doit s'écrire exactement comme lui
  // (§6.9 bis) ; ce qui RESTE est une mesure, que l'arrondi sert mieux.
  const paires = [
    ['cpu', demande.cpu, pools.cpu?.available, cpu, cpu],
    ['mémoire', demande.memory, pools.memory?.available, formatOctetsExact, formatBytes],
    ['disque', demande.storage, pools.storage?.available, formatOctetsExact, formatBytes],
    ['réseau', demande.network, pools.network?.available, formatBps, formatBps],
  ];
  return paires
    .filter(([, veut, reste]) => reste !== undefined && reste !== null && veut > reste)
    .map(([nom, veut, reste, exact, mesure]) =>
      ({ resource: nom, requested: exact(veut), available: mesure(reste) }));
}

function champ({ id, libelle, aide, erreur, controle }) {
  return `<div class="champ">
  <label for="${id}">${echapper(libelle)}</label>
  ${controle}
  ${aide ? `<p class="champ__aide" id="${id}-aide">${echapper(aide)}</p>` : ''}
  ${erreur ? `<p class="champ__erreur" id="${id}-erreur" role="alert">${echapper(erreur)}</p>` : ''}
</div>`;
}

function nombre(id, valeur, pas, erreur, aide) {
  const decrits = [aide ? `${id}-aide` : '', erreur ? `${id}-erreur` : ''].filter(Boolean).join(' ');
  return `<input type="number" id="${id}" name="${id}" value="${echapper(valeur)}" step="${pas}" min="0"
    class="controle${erreur ? ' controle--erreur' : ''}"${decrits ? ` aria-describedby="${decrits}"` : ''}${erreur ? ' aria-invalid="true"' : ''} />`;
}

/**
 * Les quotas, et ce qu'il faut savoir d'eux pour les rendre.
 *
 * @spec docs/BACKLOG.md#SPK-59 · docs/DESIGN_SYSTEM.md §6.9 bis ·
 *       docs/DESIGN_SYSTEM_APP.md SPK-DS-07
 *
 * `borne` rend la CAPACITÉ TOTALE de la Forge pour cette ressource, et jamais ce
 * qui reste libre. Ce point décide de tout le reste : le disponible est une
 * photographie qui se périme dans le sens favorable (docs/DAT.md §25.1), un
 * curseur qui s'y arrêterait serait un refus déguisé en contrôle, et le refus
 * d'admission deviendrait inatteignable depuis le parcours canonique.
 */
export const QUOTAS = {
  cpu_reservation: { pas: 0.05, min: 0.05,
                     borne: (c) => c.pools?.cpu?.capacity,
                     format: (v) => `${formatCpu(v)} CPU` },
  cpu_max:         { pas: 0.05, min: 0.05,
                     borne: (c) => c.pools?.cpu?.capacity,
                     format: (v) => `${formatCpu(v)} CPU` },
  cpu_cores:       { pas: 1, min: 1,
                     borne: (c) => c.cores,
                     format: (v) => `${v} cœur${v > 1 ? 's' : ''}` },
  // 256 Mio, décision du responsable (SPK-DS-07) : le gibioctet rendait
  // inatteignables les 512 Mio que le seed emploie, et n'offrait que cinq crans
  // sur le pool de 5,4 Gio de la pile de validation. Le format est EXACT et non
  // arrondi : `formatBytes` rendrait « 10 Gio » pour 10,25 (§6.9 bis).
  memory_gib:      { pas: 0.25, min: 0.25,
                     borne: (c) => (c.pools ? c.pools.memory?.capacity / GIO : null),
                     format: (v) => formatOctetsExact(v * GIO) },
  // Format exact lui aussi : deux quotas de la même unité sur le même écran ne
  // peuvent pas s'écrire l'un « 256 Mio » et l'autre « 1,0 Gio ».
  storage_gib:     { pas: 1, min: 1,
                     borne: (c) => (c.pools ? c.pools.storage?.capacity / GIO : null),
                     format: (v) => formatOctetsExact(v * GIO) },
  network_mbit:    { pas: 10, min: 10,
                     borne: (c) => (c.pools ? c.pools.network?.capacity / MBIT : null),
                     format: (v) => formatBps(v * MBIT) },
};

/**
 * Nombre maximal de crans d'un curseur (docs/DESIGN_SYSTEM.md §6.9 bis,
 * condition 2).
 *
 * Ce n'est pas un chiffre choisi : `.controle` mesure au plus 28 rem, soit
 * 448 px. Au-delà de cette valeur, un cran devient plus étroit qu'un pixel et
 * cesse d'être atteignable au pointeur.
 */
export const CRANS_MAX = 400;

/** La valeur d'un quota, formatée avec son unité. Un seul endroit (§12.5). */
export function formatQuota(nom, valeur) {
  const q = QUOTAS[nom];
  const v = Number(valeur);
  return q && Number.isFinite(v) ? q.format(v) : String(valeur ?? '');
}

/**
 * La borne haute du curseur, ou `null` s'il ne faut pas de curseur.
 *
 * Rend `null` dans les cas du §6.9 bis : capacité inconnue (condition 1), plage
 * trop longue pour être visée au pointeur (condition 2), plage qui ne contient
 * même pas la borne basse. Le repli en saisie numérique n'est pas un pis-aller —
 * c'est la règle qui s'applique.
 */
export function borneHaute(nom, contexte = {}) {
  const q = QUOTAS[nom];
  if (!q) return null;
  const brut = q.borne(contexte);
  if (!Number.isFinite(brut) || brut <= 0) return null;
  // La borne tombe sur un cran : « Fin » doit donner une valeur ronde, pas un
  // reste de division flottante.
  const max = Number((Math.floor(brut / q.pas) * q.pas).toFixed(4));
  if (max < q.min) return null;
  if ((max - q.min) / q.pas > CRANS_MAX) return null;
  return max;
}

/** Une valeur tombe-t-elle sur un cran ? Sinon le navigateur l'arrondirait
 *  SILENCIEUSEMENT, et l'écran afficherait autre chose que ce qui sera envoyé. */
function surLeCran(valeur, q, max) {
  const v = Number(valeur);
  if (!Number.isFinite(v) || v < q.min || v > max) return false;
  const crans = (v - q.min) / q.pas;
  return Math.abs(crans - Math.round(crans)) < 1e-6;
}

/**
 * Le curseur : piste, valeur en clair, et ses deux bornes (§6.9 bis).
 *
 * La valeur est répétée en clair parce qu'une poignée ne dit pas où elle est, et
 * portée par `aria-valuetext` parce que la synthèse annoncerait « 16 » là où
 * l'écran montre « 16 Gio ». Le doublon visible est `aria-hidden` : le curseur
 * annonce déjà sa valeur, et un `<output>` — région vive — parlerait à chaque
 * cran d'un glissement.
 */
function curseur(id, valeur, max, erreur, aide) {
  const q = QUOTAS[id];
  const decrits = [aide ? `${id}-aide` : '', erreur ? `${id}-erreur` : ''].filter(Boolean).join(' ');
  const texte = formatQuota(id, valeur);
  return `<div class="curseur">
    <input type="range" class="curseur__piste" id="${id}" name="${id}"
      min="${q.min}" max="${max}" step="${q.pas}" value="${echapper(valeur)}"
      aria-valuetext="${echapper(texte)}"${decrits ? ` aria-describedby="${decrits}"` : ''}${erreur ? ' aria-invalid="true"' : ''} />
    <span class="curseur__valeur" data-valeur-de="${id}" aria-hidden="true">${echapper(texte)}</span>
  </div>
  <p class="curseur__bornes" aria-hidden="true">
    <span>${echapper(formatQuota(id, q.min))}</span>
    <span>${echapper(formatQuota(id, max))}</span>
  </p>`;
}

/**
 * Un quota : curseur quand les conditions du §6.9 bis tiennent, saisie sinon.
 *
 * `unite` n'apparaît dans le libellé que pour la SAISIE. Un curseur porte déjà
 * son unité à côté de la poignée ; « Mémoire (Gio) » y répéterait ce que la
 * valeur dit mieux. Une saisie, elle, ne dit pas dans quelle unité taper.
 */
function champQuota(nom, { libelle, unite = null, aide, erreur, valeur, contexte }) {
  const q = QUOTAS[nom];
  const max = borneHaute(nom, contexte);
  const auCurseur = max !== null && surLeCran(valeur, q, max);
  return champ({
    id: nom, aide, erreur,
    libelle: auCurseur || !unite ? libelle : `${libelle} (${unite})`,
    controle: auCurseur
      ? curseur(nom, valeur, max, erreur, Boolean(aide))
      : nombre(nom, valeur, String(q.pas), erreur, Boolean(aide)),
  });
}

/** Y a-t-il au moins un curseur à l'écran ? Le panneau de capacité doit alors
 *  dire d'où vient la borne haute (§6.9 bis). */
function auMoinsUnCurseur(valeurs, contexte) {
  return Object.keys(QUOTAS).some((nom) => {
    const max = borneHaute(nom, contexte);
    return max !== null && surLeCran(valeurs[nom], QUOTAS[nom], max);
  });
}

/** Capacité restante, affichée pour dimensionner — pas pour interdire. */
function renderPools(pools) {
  if (!pools) return '<p class="absence">Capacité de la Forge inconnue.</p>';
  const lignes = [
    ['CPU', pools.cpu, (v) => `${formatCpu(v)} CPU`],
    ['Mémoire', pools.memory, formatBytes],
    ['Disque', pools.storage, formatBytes],
    ['Réseau', pools.network, formatBps],
  ].map(([nom, pool, f]) =>
    `<div class="def"><dt>${nom}</dt><dd class="technique">${echapper(f(pool.available))} libres sur ${echapper(f(pool.capacity))}</dd></div>`,
  ).join('');
  return `<dl class="definitions">${lignes}</dl>`;
}

/**
 * Choix de l'image : une LISTE, plus un champ libre (docs/DAT.md §33.5).
 *
 * Une saisie libre pouvait produire une référence inexistante. Le refus ne
 * venait alors qu'à l'application, après que la ligne du registre eut été
 * écrite et la ressource comptée : une faute de frappe coûtait un Spark en
 * erreur dont les quotas restaient engagés.
 *
 * Cela ne contredit pas le §25.1. Celui-ci interdit de bloquer sur une
 * ESTIMATION PÉRIMÉE de la capacité, qui change entre l'ouverture de l'écran et
 * la soumission. L'existence d'un alias ne se périme pas dans le même
 * intervalle : la contrainte est ici de forme, comme celle du nom (§25.3).
 */
export function renderChoixImage(courante, images = []) {
  if (!images.length) {
    // §14.6 : une absence qui informe est NOMMÉE. Un catalogue vide n'est pas
    // un catalogue qu'on ignore — c'est un relevé qui n'a pas eu lieu.
    return champ({
      id: 'image', libelle: 'Image',
      aide: 'Aucune image vérifiée au catalogue. Relever le catalogue avant de '
        + 'créer un Spark.',
      controle: `<select id="image" name="image" class="controle" disabled>
        <option>— catalogue vide —</option></select>`,
    });
  }
  const options = images.map((i) =>
    `<option value="${echapper(i.reference)}"${i.reference === courante ? ' selected' : ''}>` +
    `${echapper(i.label)} — ${echapper(i.reference)}</option>`).join('');
  return champ({
    id: 'image', libelle: 'Image',
    aide: 'Les images proposées sont celles que le dernier relevé du catalogue a '
      + 'trouvées chez leur dépôt.',
    controle: `<select id="image" name="image" class="controle">${options}</select>`,
  });
}

/**
 * L'avertissement d'estimation, rendu SEUL pour pouvoir se rafraîchir sans
 * repeindre le formulaire.
 *
 * @spec docs/BACKLOG.md#SPK-59 · docs/DAT.md §25.1 · docs/DESIGN_SYSTEM.md §6.9 bis
 *
 * Il ne se rafraîchissait pas du tout : seul un changement de mode CPU
 * provoquait un repeint, si bien qu'on pouvait demander 64 Gio devant un panneau
 * en annonçant 64 de libres sans qu'un mot bouge. Le curseur rend ce silence
 * intenable — on tire la poignée au-delà du disponible et rien ne réagit. Et
 * repeindre le formulaire n'est pas une option : cela arracherait la poignée en
 * cours de glissement et perdrait le focus (§14.3).
 */
export function renderAvertissement(valeurs, pools, refusal = null) {
  const risques = estimate({ ...DEFAUTS, ...valeurs }, pools);
  // Une fois que le serveur a tranché, l'estimation locale n'est plus qu'un
  // doublon bruyant : c'est le refus qui fait autorité (docs/DAT.md §25.1).
  if (!risques.length || refusal) return '';
  return `<p class="avertissement" role="status">D’après la capacité relevée à l’ouverture,
       ${echapper(risques.map((r) => `${r.resource} (${r.requested} demandés, ${r.available} libres)`).join(', '))}
       pourrai${risques.length > 1 ? 'ent' : 't'} manquer. La création reste possible :
       c’est le serveur qui décide.</p>`;
}

export function renderSparkCreate({ values = DEFAUTS, pools = null, errors = {},
                                    refusal = null, submitting = false,
                                    images = [], cores = null } = {}) {
  const v = { ...DEFAUTS, ...values };
  // Ce dont dépendent les bornes des curseurs : la capacité TOTALE de la Forge,
  // et le nombre de cœurs physiques (SPK-DS-07).
  const contexte = { pools, cores };
  const avertissement = `<div class="zone-avertissement">${renderAvertissement(v, pools, refusal)}</div>`;

  // §7.1 et §25.2 : le refus est près de l'action, et la saisie est intacte.
  const refus = refusal
    ? `<div class="refus" role="alert">
         <p><strong>Le serveur a refusé cette création.</strong></p>
         ${(refusal.shortfalls ?? []).length
           ? `<ul class="liste-simple">${refusal.shortfalls.map((s) =>
               `<li>${echapper(describeShortfall(s))}</li>`).join('')}</ul>`
           : ''}
       </div>`
    : '';

  const modeOptions = Object.entries(MODES).map(([cle, libelle]) =>
    `<option value="${cle}"${v.cpu_mode === cle ? ' selected' : ''}>${echapper(libelle)}</option>`).join('');

  const champsCpu = [
    ['shared', 'shared-pinned'].includes(v.cpu_mode)
      ? champQuota('cpu_reservation', { libelle: 'Réservation CPU', contexte,
                aide: 'Droit d’ordonnancement sous contention, pas un plafond.',
                valeur: v.cpu_reservation, erreur: errors.cpu_reservation })
      : '',
    v.cpu_mode === 'capped'
      ? champQuota('cpu_max', { libelle: 'Plafond CPU', contexte,
                aide: 'Jamais dépassé. Pas de burst.',
                valeur: v.cpu_max, erreur: errors.cpu_max })
      : '',
    ['dedicated', 'shared-pinned'].includes(v.cpu_mode)
      ? champQuota('cpu_cores', { libelle: 'Cœurs', contexte,
                aide: 'Cœurs physiques entiers, frères SMT compris.',
                valeur: v.cpu_cores, erreur: errors.cpu_cores })
      : '',
  ].join('');

  return `
<p><a class="lien-spark" href="#/sparks">← Tous les Sparks</a></p>
<div class="titre-vue"><h1>Créer un Spark</h1></div>
<div class="detail">
  <div class="detail__principal">
    <form class="carte bloc" id="formulaire-spark" novalidate>
      ${champ({ id: 'name', libelle: 'Nom', erreur: errors.name,
                aide: 'Minuscules, chiffres et tirets.',
                controle: `<input type="text" id="name" name="name" value="${echapper(v.name)}"
                  class="controle${errors.name ? ' controle--erreur' : ''}" aria-describedby="name-aide${errors.name ? ' name-erreur' : ''}"${errors.name ? ' aria-invalid="true"' : ''} />` })}
      ${renderChoixImage(v.image, images)}
      ${champ({ id: 'cpu_mode', libelle: 'Mode CPU', controle:
        `<select id="cpu_mode" name="cpu_mode" class="controle">${modeOptions}</select>` })}
      ${champsCpu}
      ${champQuota('memory_gib', { libelle: 'Mémoire', unite: 'Gio', contexte,
                valeur: v.memory_gib, erreur: errors.memory_gib })}
      ${champQuota('storage_gib', { libelle: 'Disque', unite: 'Gio', contexte,
                valeur: v.storage_gib, erreur: errors.storage_gib })}
      ${champQuota('network_mbit', { libelle: 'Débit', unite: 'Mbit/s', contexte,
                aide: 'Sert à la comptabilité ; seul le plafond est appliqué par le noyau.',
                valeur: v.network_mbit, erreur: errors.network_mbit })}
      ${avertissement}
      ${refus}
      <p class="formulaire__actions">
        <button type="submit" class="bouton bouton--primaire"${submitting ? ' disabled' : ''}>
          ${submitting ? 'Création…' : 'Créer le Spark'}</button>
        <a class="bouton" href="#/sparks">Annuler</a>
      </p>
    </form>
  </div>
  <div class="detail__secondaire">
    <section class="carte bloc" aria-labelledby="titre-capacite">
      <h2 id="titre-capacite">Capacité restante</h2>
      ${renderPools(pools)}
      <p class="note">Relevée à l’ouverture de cet écran. Elle peut avoir changé
      depuis : c’est le serveur qui tranche à la création.${auMoinsUnCurseur(v, contexte)
        ? ` Les curseurs vont donc jusqu’à ce que la Forge possède <strong>en
        tout</strong>, et non jusqu’à ce qui reste libre.` : ''}</p>
    </section>
  </div>
</div>`;
}
