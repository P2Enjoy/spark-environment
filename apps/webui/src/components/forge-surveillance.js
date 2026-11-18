/**
 * Les onglets « SLA » et « Santé » de la Forge : le tableau de bord de la surveillance de tous les Sparks.
 *
 * @spec docs/BACKLOG.md#SPK-188 · docs/DAT.md §76.2 (un index qui mène, pas un second écran de décision),
 *       §76.3 (les deux lectures de parc), §76.3 bis (la charge de la semaine), §76.4 (ce que la console en
 *       fait), §76.5 (les limites) · docs/DESIGN_SYSTEM_APP.md SPK-DS-54, SPK-DS-32 (le patron de l'index),
 *       SPK-DS-50 et SPK-DS-51 (les mêmes états, les mêmes mots) · docs/DESIGN_SYSTEM.md §1.5 (la couleur ne
 *       porte pas seule), §5.2 (une destination est un lien), §6.13 (états systématiques ; un état relevé se
 *       date), §6.14 (tableau), §8.1 (le défilement se signale), §9.3, §14.5, §14.6
 *
 * Des fonctions pures : des chaînes HTML, sans horloge ni réseau. Aucun geste ici — ni programmer, ni suspendre,
 * ni ajouter une sonde : chaque ligne MÈNE à la facette du Spark qui règle l'objet (DAT §76.2). Les états et
 * leurs mots sont ceux des facettes d'un Spark (`ETATS_SANTE`), jamais une seconde table de correspondance.
 */

import { formatBytes } from './tokens.js';
import { dateUtc, libelleRetention } from './sla-view.js';
import { ETATS_SANTE, renderFrise } from './sante-view.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** `loading` et non vide : « pas encore lu » n'est pas « rien n'est déployé » (DESIGN_SYSTEM §14.6). */
export const SURVEILLANCE_VIDE = Object.freeze({ status: 'loading', donnees: null, error: null, luA: null });

/** Où le Spark s'ouvre sur la facette qui règle l'objet (DAT §76.4). */
export const lienSla = (spark) => `#/sparks/${encodeURIComponent(spark)}/instantanes`;
export const lienSante = (spark) => `#/sparks/${encodeURIComponent(spark)}/sante`;
const lienSpark = (spark) => `#/sparks/${encodeURIComponent(spark)}`;

const pluriel = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;

function pastille(jeton, libelle) {
  return `<span class="badge badge--${jeton}"><span class="badge__point" aria-hidden="true"></span>${
    echapper(libelle)}</span>`;
}

// --- les états -----------------------------------------------------------------------------------------

/** Les états d'un SLA, exclusifs (DAT §76.3) : les mots de la section d'un Spark (SPK-DS-50). */
export const ETATS_SLA = {
  failing: { jeton: 'danger', libelle: 'En échec' },
  active: { jeton: 'success', libelle: 'Actif' },
  suspended: { jeton: 'neutral', libelle: 'Suspendu' },
};

/** Les états d'une sonde au parc : ceux de la machine (§75.6), plus l'état EFFECTIF « suspendue » (§76.3). */
export const ETATS_PARC = { ...ETATS_SANTE, suspended: { jeton: 'neutral', libelle: 'Suspendue' } };

/** Du pire au plus sain : l'ordre de la synthèse comme celui du tableau. */
const ORDRE_SANTE = ['down', 'unstable', 'unknown', 'stopped', 'healthy', 'suspended'];

/** Les libellés de la synthèse, au pluriel — « 2 en panne » se lit, « En panne : 2 » aussi, mais sans accord. */
const LIBELLES_SANTE = {
  down: 'En panne', unstable: 'Instables', unknown: 'Jamais relevées', stopped: 'Arrêtées',
  healthy: 'Saines', suspended: 'Suspendues',
};

// --- le gabarit commun ------------------------------------------------------------------------------------

function carte(id, titre, phrase, corps, ui, bouton) {
  const lecture = ui.luA
    ? `<span class="note">Lu à <span class="technique">${echapper(ui.luA)}</span> (UTC).</span>` : '';
  return `
<section class="carte bloc" aria-labelledby="${id}">
  <h2 id="${id}">${echapper(titre)}</h2>
  <p class="note">${phrase}</p>
  <p class="relecture">
    <button type="button" class="bouton" ${bouton}${ui.status === 'loading' ? ' disabled' : ''}>Relire</button>
    ${lecture}
  </p>
  ${corps}
</section>`;
}

/** Les trois états qui ne montrent pas de données : chargement, erreur, et — par l'appelant — le vide. */
function etatSansDonnees(ui) {
  if (ui.status === 'loading') {
    return '<p class="note" role="status" aria-busy="true">Lecture…</p>';
  }
  if (ui.status === 'error' || !ui.donnees) {
    return `<div class="refus" role="alert"><p><strong>${
      echapper(ui.error ?? 'La Forge n’a pas pu être lue.')}</strong></p></div>`;
  }
  return null;
}

/**
 * La synthèse : des paires terme / valeur (§6.4). Quand un compte porte un état, la PASTILLE est le terme — le mot et
 * la couleur ensemble (§1.5), sans répéter le libellé à côté d'elle.
 */
function synthese(elements) {
  return `<dl class="synthese">${elements.map(({ libelle, valeur, jeton, detail }) => `
    <div class="synthese__item">
      <dt>${jeton ? pastille(jeton, libelle) : echapper(libelle)}</dt>
      <dd><span class="synthese__chiffre technique">${echapper(valeur)}</span>${
        detail ? ` <span class="note">${echapper(detail)}</span>` : ''}</dd>
    </div>`).join('')}</dl>`;
}

function sansEux(noms, lien, phrase) {
  if (!noms.length) return '';
  const liens = noms.map((n) =>
    `<a class="lien-spark technique" href="${lien(n)}" aria-label="${echapper(`${phrase} : ouvrir ${n}`)}">${
      echapper(n)}</a>`).join(', ');
  return `<p class="note" data-sans>${echapper(phrase)} : ${liens}.</p>`;
}

function tableau(titreIndice, entetes, lignes) {
  return `<div class="tableau-defilant">
  <p class="tableau-indice">${echapper(titreIndice)}</p>
  <table>
    <thead><tr>${entetes.map((e) => `<th scope="col">${echapper(e)}</th>`).join('')}</tr></thead>
    <tbody>${lignes.join('')}</tbody>
  </table></div>`;
}

// --- la charge de la semaine ------------------------------------------------------------------------------

const JOURS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const JOURS_COURTS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

/** Géométrie du graphe : une colonne d'UN pixel par tranche, rien d'étiré (SPK-DS-54). */
export const GRAPHE = { largeur: 672, hauteur: 64, total: 78 };

const deuxChiffres = (n) => String(n).padStart(2, '0');

function horaire(minutes) {
  return `${deuxChiffres(Math.floor(minutes / 60) % 24)}:${deuxChiffres(minutes % 60)}`;
}

/** « Mardi 02:00 – 02:15 UTC » : la tranche de ce rang, dite en toutes lettres. */
export function libelleTranche(semaine, index) {
  const pas = semaine.slot_minutes;
  const parJour = (24 * 60) / pas;
  const jour = Math.floor(index / parJour);
  const debut = (index % parJour) * pas;
  return `${JOURS[jour] ?? '?'} ${horaire(debut)} – ${horaire(debut + pas)} UTC`;
}

/** Ce que dit le survol d'une tranche : son horaire, sa charge, ses Sparks. Une tranche vide se dit. */
export function lectureTranche(semaine, index) {
  if (!Number.isInteger(index) || index < 0 || index >= semaine.slots.length) return '';
  const n = semaine.slots[index];
  const quand = libelleTranche(semaine, index);
  if (!n) return `${quand} · aucune prise`;
  const noms = semaine.sparks_by_slot?.[String(index)] ?? [];
  return `${quand} · ${pluriel(n, 'prise', 'prises')}${noms.length ? ` · ${noms.join(', ')}` : ''}`;
}

/** Le rang de la tranche sous un pointeur, à partir de sa position dans le graphe (0 à 1). */
export function trancheSousLePointeur(semaine, fraction) {
  if (!(fraction >= 0 && fraction <= 1)) return null;
  return Math.min(semaine.slots.length - 1, Math.floor(fraction * semaine.slots.length));
}

/**
 * Le graphe : 672 colonnes d'un pixel, du lundi 00:00 au dimanche 23:45 (UTC), une par tranche de 15 minutes, de la
 * hauteur de leur charge rapportée au pic. Une seule série : pas de légende, le titre la nomme (§1.5 : la couleur ne
 * porte rien que le texte ne dise).
 */
export function renderChargeSemaine(semaine) {
  if (!semaine || !semaine.peak) {
    return `<h3>Charge de la semaine</h3>
    <p class="absence">Aucune prise n’est planifiée cette semaine : aucun SLA actif ne prend d’instantané.</p>`;
  }
  const { largeur, hauteur, total } = GRAPHE;
  const colonnes = semaine.slots
    .map((n, i) => (n ? `M${i + 0.5} ${hauteur}V${(hauteur - (n / semaine.peak) * hauteur).toFixed(2)}` : ''))
    .join('');
  const reperes = JOURS_COURTS.map((jour, d) => {
    const x = d * 96;
    return `<path class="graphe__jour" d="M${x + 0.5} 0V${hauteur}"/>`
      + `<text class="graphe__etiquette" x="${x + 3}" y="${total - 3}">${jour}</text>`;
  }).join('');
  const resume = `${pluriel(semaine.busy_slots, 'tranche chargée', 'tranches chargées')} sur ${
    semaine.slots.length}, pic de ${pluriel(semaine.peak, 'prise', 'prises')} : la liste des tranches les plus chargées suit`;
  const plus = semaine.busiest.map((t) => `
      <li><strong>${echapper(libelleTranche(semaine, t.index))}</strong> — ${
        pluriel(t.count, 'prise', 'prises')} · <span class="technique">${echapper(t.sparks.join(', '))}</span></li>`)
    .join('');
  return `<h3>Charge de la semaine</h3>
  <p class="note">Prises d’instantanés prévues par tranche de 15 minutes, du lundi au dimanche, en UTC.
    Pic : ${echapper(pluriel(semaine.peak, 'prise', 'prises'))}.</p>
  <div class="graphe-defilant">
    <p class="tableau-indice">Le graphe défile horizontalement.</p>
    <svg class="graphe-semaine" data-charge-semaine width="${largeur}" height="${total}"
         viewBox="0 0 ${largeur} ${total}" role="img" aria-label="${echapper(resume)}">
      ${reperes}
      <path class="graphe__colonnes" d="${colonnes}"/>
    </svg>
  </div>
  <p class="graphe__lecture note" data-charge-lecture aria-live="polite">Survolez le graphe pour lire une tranche.</p>
  <h4>Tranches les plus chargées</h4>
  <ol class="liste-simple">${plus}
  </ol>`;
}

// --- l'onglet SLA ----------------------------------------------------------------------------------------

function derniere(s) {
  if (!s.last_run_at) return 'Aucune prise pour l’instant.';
  const quand = echapper(dateUtc(s.last_run_at));
  if (s.last_status === 'error') {
    return `${quand}<br><span class="note">Échec : ${echapper(s.last_error ?? 'motif non rendu')}</span>`;
  }
  if (s.last_status === 'skipped') {
    return `${quand}<br><span class="note">Ignorée : ${echapper(s.last_error ?? '')}</span>`;
  }
  return quand;
}

function tenus(s) {
  const n = s.snapshots?.count ?? 0;
  if (!n) return 'Aucun';
  const taille = s.snapshots.size_bytes != null ? ` · ${formatBytes(s.snapshots.size_bytes)}` : ' · taille inconnue';
  return `${pluriel(n, 'instantané', 'instantanés')}${taille}`;
}

function ligneSla(s) {
  const { jeton, libelle } = ETATS_SLA[s.state] ?? ETATS_SLA.suspended;
  return `
      <tr data-sla-ligne="${echapper(s.spark)}">
        <th scope="row" class="nom-cellule"><a class="lien-spark technique" href="${lienSpark(s.spark)}">${
          echapper(s.spark)}</a></th>
        <td>${pastille(jeton, libelle)}</td>
        <td>${echapper(s.description)}<br><span class="technique cadence">${echapper(s.schedule)}</span></td>
        <td>${derniere(s)}</td>
        <td>${s.enabled && s.next_run_at ? echapper(dateUtc(s.next_run_at)) : 'Suspendu : aucune prise prévue.'}</td>
        <td>${echapper(libelleRetention(s.retention_days, s.retention_count))}</td>
        <td>${echapper(tenus(s))}</td>
        <td><a class="lien-spark" href="${lienSla(s.spark)}" data-lien-sla="${echapper(s.spark)}"
               aria-label="${echapper(`Ouvrir les instantanés de ${s.spark}`)}">Ouvrir les instantanés</a></td>
      </tr>`;
}

export function renderSlaForge(ui = SURVEILLANCE_VIDE) {
  const phrase = 'Les SLA d’instantanés programmés sur les Sparks de cette Forge, et le moment où ils prennent. '
    + 'Chaque ligne s’ouvre dans l’onglet Instantanés du Spark, où la politique se règle.';
  const manque = etatSansDonnees(ui);
  let corps;
  if (manque) {
    corps = manque;
  } else {
    const d = ui.donnees;
    const r = d.summary;
    if (!r.configured) {
      corps = `<p class="absence">Aucun SLA n’est programmé sur cette Forge : aucun instantané n’est pris automatiquement.</p>
        ${sansEux(d.without, lienSla, 'Sparks sans SLA')}`;
    } else {
      const taille = r.snapshots_size_bytes == null ? 'taille inconnue' : formatBytes(r.snapshots_size_bytes);
      corps = `
  ${synthese([
    { libelle: 'SLA programmés', valeur: r.configured },
    { libelle: 'En échec', valeur: r.failing, jeton: 'danger' },
    { libelle: 'Actifs', valeur: r.active, jeton: 'success' },
    { libelle: 'Suspendus', valeur: r.suspended, jeton: 'neutral' },
    { libelle: 'Instantanés tenus', valeur: r.snapshots_count, detail: r.snapshots_count ? taille : '' },
  ])}
  ${renderChargeSemaine(d.week)}
  <h3>Les SLA, du plus préoccupant au plus sain</h3>
  ${tableau('Le tableau défile horizontalement.',
    ['Spark', 'État', 'Fréquence', 'Dernière prise', 'Prochaine prise', 'Rétention', 'Tenus par le SLA', 'Réglage'],
    d.sparks.map(ligneSla))}
  ${sansEux(d.without, lienSla, 'Sparks sans SLA')}`;
    }
  }
  return carte('titre-sla-forge', 'SLA des instantanés', phrase, corps, ui, 'data-surveillance-relire="sla"');
}

// --- l'onglet Santé --------------------------------------------------------------------------------------

function echecs(c) {
  const n = c.consecutive_failures;
  if (c.state === 'unstable') return `${pluriel(n, 'échec', 'échecs')} sur ${c.threshold}`;
  if (c.state === 'down') return `${pluriel(n, 'échec consécutif', 'échecs consécutifs')} · seuil ${c.threshold}`;
  return '';
}

function ligneSante(spark, c) {
  // Comme la facette d'un Spark (SPK-DS-51) : l'état que la sonde GARDE, et « Suspendue » en plus. C'est la
  // synthèse, pas la ligne, qui la sort de cet état (DAT §76.3).
  const etat = ETATS_SANTE[c.state] ?? ETATS_SANTE.unknown;
  const detail = echecs(c);
  const releve = c.last_run_at
    ? `${echapper(dateUtc(c.last_run_at))}${c.last_latency_ms != null ? ` · ${c.last_latency_ms} ms` : ''}`
    : 'Aucun relevé pour l’instant.';
  const motif = c.last_detail && c.state !== 'healthy'
    ? `<br><span class="note">Motif : ${echapper(c.last_detail)}</span>` : '';
  const suspendue = c.enabled ? '' : ` ${pastille('neutral', 'Suspendue')}`;
  const pastilleEtat = pastille(etat.jeton, etat.libelle);
  return `
      <tr data-sante-ligne="${echapper(`${spark}:${c.name}`)}">
        <th scope="row" class="nom-cellule"><a class="lien-spark technique" href="${lienSpark(spark)}">${
          echapper(spark)}</a></th>
        <td><span class="technique">${echapper(c.name)}</span> <span class="absence">${
          c.kind === 'http' ? 'HTTPS' : 'Script'}</span></td>
        <td>${pastilleEtat}${suspendue}${detail ? `<br><span class="note">${echapper(detail)}</span>` : ''}</td>
        <td>${releve}${motif}</td>
        <td><span class="frise-ligne">${renderFrise(c.results)}</span></td>
        <td><a class="lien-spark" href="${lienSante(spark)}" data-lien-sante="${echapper(`${spark}:${c.name}`)}"
               aria-label="${echapper(`Ouvrir la santé de ${spark}`)}">Ouvrir la santé</a></td>
      </tr>`;
}

export function renderSanteForge(ui = SURVEILLANCE_VIDE) {
  const phrase = 'Les sondes posées sur les Sparks de cette Forge, du pire état au plus sain, telles que les relevés '
    + 'planifiés les ont laissées. Chaque ligne s’ouvre dans l’onglet Santé du Spark, où la sonde se règle.';
  const manque = etatSansDonnees(ui);
  let corps;
  if (manque) {
    corps = manque;
  } else {
    const d = ui.donnees;
    const r = d.summary;
    if (!r.checks) {
      corps = `<p class="absence">Aucune sonde ne surveille cette Forge : rien ne dit si un Spark répond.</p>
        ${sansEux(d.without, lienSante, 'Sparks sans sonde')}`;
    } else {
      const comptes = ORDRE_SANTE.map((cle) => ({
        libelle: LIBELLES_SANTE[cle], valeur: r[cle], jeton: ETATS_PARC[cle].jeton }));
      corps = `
  ${synthese([
    { libelle: 'Sondes', valeur: r.checks },
    { libelle: 'Sparks surveillés', valeur: `${r.monitored} sur ${r.sparks}` },
    ...comptes,
  ])}
  <h3>Les sondes, de la plus préoccupante à la plus saine</h3>
  ${tableau('Le tableau défile horizontalement.',
    ['Spark', 'Sonde', 'État', 'Dernier relevé', 'Derniers relevés', 'Réglage'],
    d.sparks.flatMap((s) => s.checks.map((c) => ligneSante(s.spark, c))))}
  ${sansEux(d.without, lienSante, 'Sparks sans sonde')}`;
    }
  }
  return carte('titre-sante-forge', 'Santé', phrase, corps, ui, 'data-surveillance-relire="sante"');
}
