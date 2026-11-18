/**
 * La section « SLA des instantanés » et sa modale.
 *
 * @spec docs/BACKLOG.md#SPK-183 · docs/DAT.md §74.10 (ce que la console en fait), §74.3
 *       (la fréquence, UTC), §74.7 (l'aperçu précède l'écriture) ·
 *       docs/DESIGN_SYSTEM_APP.md SPK-DS-50 · docs/DESIGN_SYSTEM.md §1.3 (pas de succès
 *       simulé), §1.5 (la couleur ne porte pas seule), §6.9 (champ), §6.13 (l'absence se
 *       nomme), §6.22 (confirmation dans le flux), §6.23 (action sensible), §6.24
 *       (réparatrice), §6.27 (modale limitée à une section), §14.6 (mesure indisponible)
 *
 * Des fonctions pures : elles rendent des chaînes HTML, sans lire l'horloge ni le réseau,
 * donc éprouvables sans navigateur. La zone d'aperçu (`renderZoneApercu`) et le libellé
 * d'engagement sont séparés du reste PARCE QUE l'écran les met à jour SUR PLACE pendant la
 * frappe : repeindre la modale arracherait le focus au champ en cours de saisie (§14.3).
 */

import { renderModale } from './modale.js';
import { formatBytes } from './tokens.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Les fréquences courantes du DAT §74.3. Le menu n'est qu'une aide : seule la chaîne est stockée. */
export const PRESETS_SLA = [
  { schedule: '0 * * * *', libelle: 'Toutes les heures' },
  { schedule: '0 */6 * * *', libelle: 'Toutes les 6 heures' },
  { schedule: '0 2 * * *', libelle: 'Tous les jours à 02:00 (UTC)' },
  { schedule: '0 2,14 * * *', libelle: 'Deux fois par jour, 02:00 et 14:00 (UTC)' },
  { schedule: '0 2 * * 1-5', libelle: 'Les jours ouvrés à 02:00 (UTC)' },
  { schedule: '0 3 * * 0', libelle: 'Le dimanche à 03:00 (UTC)' },
  { schedule: '0 3 1 * *', libelle: 'Le 1er du mois à 03:00 (UTC)' },
];

/** La valeur du menu quand la chaîne n'est aucune des fréquences courantes. */
export const PERSONNALISEE = '';

/** La fréquence courante qui correspond à cette chaîne (blancs normalisés), ou « Personnalisée ». */
export function presetPour(chaine) {
  const normalisee = String(chaine ?? '').trim().split(/\s+/).join(' ');
  return PRESETS_SLA.find((p) => p.schedule === normalisee)?.schedule ?? PERSONNALISEE;
}

/** L'état de la modale et de ses gestes. `open` est un booléen : une seule modale. */
export const SLA_VIDE = {
  open: false,
  values: { schedule: '0 2 * * *', retention_days: '7', retention_count: '', enabled: true },
  apercu: null,        // la réponse de `POST …/sla/preview`
  erreur: null,        // le refus de la validation, avec sa raison
  chargement: false,   // un aperçu est en cours de calcul
  busy: false,
  refusal: null,       // le refus d'un geste, dit DANS la modale
  confirmingRetrait: false,
  refusGeste: null,    // le refus d'un geste de section (suspendre, reprendre, retirer)
};

/** Les valeurs de la modale, depuis la politique AFFICHÉE : jamais des champs vides. */
export function valeursDe(sla) {
  if (!sla?.configured) return { ...SLA_VIDE.values };
  return {
    schedule: sla.schedule,
    retention_days: sla.retention_days == null ? '' : String(sla.retention_days),
    retention_count: sla.retention_count == null ? '' : String(sla.retention_count),
    enabled: Boolean(sla.enabled),
  };
}

/** Un champ numérique vide vaut « pas de critère » ; un texte non numérique part tel quel (le serveur le refuse). */
const entierOuNull = (texte) => {
  const t = String(texte ?? '').trim();
  if (t === '') return null;
  return /^-?\d+$/.test(t) ? Number(t) : t;
};

/** Le corps de `PUT` / `preview`, depuis les valeurs de la modale. */
export function corpsDe(values, { accepter = false } = {}) {
  return {
    schedule: String(values.schedule ?? '').trim(),
    retention_days: entierOuNull(values.retention_days),
    retention_count: entierOuNull(values.retention_count),
    enabled: Boolean(values.enabled),
    ...(accepter ? { accept_deletion: true } : {}),
  };
}

// --- les dates : UTC d'abord, puis le fuseau du navigateur, jamais l'un sans l'autre -----

/** `2026-11-19T02:00:00+00:00` → `2026-11-19 02:00 UTC`. */
export function dateUtc(iso) {
  if (!iso) return '';
  return `${String(iso).slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * Le même instant dans un fuseau, à titre d'information. Un fuseau inconnu ou une date
 * illisible rendent `''` : on n'invente rien.
 */
export function dateLocale(iso, fuseau) {
  if (!iso) return '';
  try {
    const instant = new Date(iso);
    if (Number.isNaN(instant.getTime())) return '';
    const options = { year: 'numeric', month: '2-digit', day: '2-digit',
                      hour: '2-digit', minute: '2-digit', hour12: false,
                      ...(fuseau ? { timeZone: fuseau } : {}) };
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('fr-FR', options).formatToParts(instant).map((p) => [p.type, p.value]));
    const nom = fuseau ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (${nom})`;
  } catch {
    return '';
  }
}

function dateDouble(iso, fuseau) {
  const utc = dateUtc(iso);
  const locale = dateLocale(iso, fuseau);
  return locale && !locale.includes('(UTC)') ? `${utc}, soit ${locale}` : utc;
}

// --- la rétention ---------------------------------------------------------------------------

export function libelleRetention(jours, nombre) {
  const morceaux = [];
  if (jours != null) morceaux.push(`${jours} jour${jours > 1 ? 's' : ''}`);
  if (nombre != null) morceaux.push(`${nombre} instantané${nombre > 1 ? 's' : ''} au plus`);
  return morceaux.join(' · ') || 'aucune';
}

// --- la zone d'aperçu, mise à jour sur place -----------------------------------------------------

/**
 * Le contenu de `#sla-apercu` : la phrase lisible, les prochaines prises, et — quand
 * l'enregistrement SUPPRIMERAIT — le bloc qui NOMME les instantanés (§6.22, §6.23).
 */
export function renderZoneApercu(ui) {
  if (ui.erreur) {
    return `<p class="refus" role="alert"><strong>${echapper(ui.erreur)}</strong></p>`;
  }
  const a = ui.apercu;
  if (!a) {
    return `<p class="note">${ui.chargement ? 'Calcul de l’aperçu…' : 'Saisissez une fréquence et une rétention.'}</p>`;
  }
  const prises = (a.next_runs ?? []).map((iso) => `<li class="technique">${echapper(dateUtc(iso))}</li>`).join('');
  const suppression = (a.would_delete ?? []).length
    ? `<div class="confirmation" role="group" aria-label="Instantanés qui seraient supprimés">
         <p><strong>Cet enregistrement supprimerait ${a.would_delete.length}
         instantané${a.would_delete.length > 1 ? 's' : ''}.</strong></p>
         <ul class="liste-simple">${a.would_delete.map((d) =>
           `<li><span class="technique">${echapper(d.name)}</span>${
             d.size_bytes != null ? ` — ${echapper(formatBytes(d.size_bytes))}` : ''}</li>`).join('')}</ul>
         <p class="confirmation__consequence">Cette suppression est définitive. Le Spark n’est
         pas touché.</p>
       </div>`
    : '';
  return `<p id="sla-phrase"><strong>${echapper(a.description)}</strong></p>`
    + (prises ? `<p class="note">Prochaines prises :</p><ul class="liste-simple">${prises}</ul>` : '')
    + suppression;
}

/** Le libellé du bouton d'engagement : il NOMME la suppression quand il y en a une (§6.23). */
export function engagementSla(ui) {
  const n = ui.apercu?.would_delete?.length ?? 0;
  return n > 0 ? `Enregistrer et supprimer ${n} instantané${n > 1 ? 's' : ''}` : 'Enregistrer';
}

export const detruit = (ui) => (ui.apercu?.would_delete?.length ?? 0) > 0;

// --- la modale ---------------------------------------------------------------------------------------

function renderModaleSla(ui) {
  const v = ui.values;
  const choisi = presetPour(v.schedule);
  return renderModale({
    ouverte: ui.open, id: 'sla', titre: 'SLA des instantanés',
    engagement: engagementSla(ui), destructif: detruit(ui), occupee: ui.busy,
    desactivee: Boolean(ui.erreur) || !ui.apercu,
    refus: ui.refusal,
    corps: `
      <div class="champ">
        <label for="sla-preset">Fréquence courante</label>
        <select class="controle" id="sla-preset" name="preset">
          ${PRESETS_SLA.map((p) => `<option value="${echapper(p.schedule)}"${
            choisi === p.schedule ? ' selected' : ''}>${echapper(p.libelle)}</option>`).join('')}
          <option value="${PERSONNALISEE}"${choisi === PERSONNALISEE ? ' selected' : ''}>Personnalisée</option>
        </select>
      </div>
      <div class="champ">
        <label for="sla-schedule">Chaîne crontab (UTC)</label>
        <input class="controle technique" id="sla-schedule" name="schedule" type="text"
               autocomplete="off" spellcheck="false" value="${echapper(v.schedule)}"
               aria-describedby="sla-schedule-aide">
        <p class="champ__aide" id="sla-schedule-aide">Cinq champs : minute heure jour mois
        jour-de-la-semaine. Deux prises ne peuvent pas être espacées de moins de 15 minutes.</p>
      </div>
      <div class="champ">
        <label for="sla-days">Conserver pendant … jours</label>
        <input class="controle" id="sla-days" name="retention_days" type="text" inputmode="numeric"
               autocomplete="off" value="${echapper(v.retention_days)}" aria-describedby="sla-retention-aide">
      </div>
      <div class="champ">
        <label for="sla-count">Conserver au plus … instantanés</label>
        <input class="controle" id="sla-count" name="retention_count" type="text" inputmode="numeric"
               autocomplete="off" value="${echapper(v.retention_count)}" aria-describedby="sla-retention-aide">
        <p class="champ__aide" id="sla-retention-aide">Au moins l’un des deux. Si vous remplissez les deux,
        le premier atteint supprime.</p>
      </div>
      <div class="champ champ--case">
        <label for="sla-enabled"><input id="sla-enabled" name="enabled" type="checkbox"${
          v.enabled ? ' checked' : ''}> Actif</label>
      </div>
      <div id="sla-apercu" aria-live="polite">${renderZoneApercu(ui)}</div>`,
  });
}

// --- la section ----------------------------------------------------------------------------------------

function renderEtat(sla) {
  return sla.enabled
    ? '<span class="badge badge--success"><span class="badge__point" aria-hidden="true"></span>Actif</span>'
    : '<span class="badge badge--neutral"><span class="badge__point" aria-hidden="true"></span>Suspendu</span>';
}

function renderDerniere(sla) {
  if (!sla.last_run_at) return 'Aucune prise pour l’instant.';
  const date = echapper(dateUtc(sla.last_run_at));
  if (sla.last_status === 'error') {
    return `<span class="badge badge--danger"><span class="badge__point" aria-hidden="true"></span>Échec</span>
      ${date} — ${echapper(sla.last_error ?? 'motif non rendu')}`;
  }
  if (sla.last_status === 'skipped') {
    return `<span class="badge badge--neutral">Ignorée</span> ${echapper(sla.last_error ?? '')}`;
  }
  return `<span class="badge badge--success"><span class="badge__point" aria-hidden="true"></span>OK</span> ${date}`;
}

/**
 * La section « SLA des instantanés » (SPK-DS-50). `sla` vaut `null` quand sa lecture a échoué :
 * l'écran le dit, il ne montre pas une absence de politique (§14.6).
 */
export function renderSlaSection(sla, ui = SLA_VIDE, { fuseau = null } = {}) {
  let corps;
  if (sla == null) {
    corps = '<p class="absence" role="status">Le SLA n’a pas pu être lu : rien ne dit si une politique existe.</p>';
  } else if (!sla.configured) {
    corps = `<p class="absence">Aucun SLA : aucun instantané n’est pris automatiquement.</p>
      <p><button type="button" class="bouton bouton--compact" data-ouvre="sla">Programmer</button></p>`;
  } else {
    const tenus = sla.snapshots?.count ?? 0;
    const taille = sla.snapshots?.size_bytes != null ? ` · ${formatBytes(sla.snapshots.size_bytes)}` : '';
    const retrait = ui.confirmingRetrait
      ? `<div class="confirmation" role="group" aria-label="Confirmer le retrait du SLA">
           <p><strong>Retirer le SLA de ce Spark ?</strong></p>
           <p class="confirmation__consequence">Plus aucun instantané ne sera pris ni supprimé
           automatiquement. Les ${tenus} instantané${tenus > 1 ? 's' : ''} déjà pris restent.</p>
           <p class="confirmation__actions">
             <button type="button" class="bouton bouton--destructif" data-sla-confirme-retrait>Retirer le SLA</button>
             <button type="button" class="bouton" data-sla-annule-retrait>Annuler</button>
           </p>
         </div>`
      : '';
    corps = `
      <dl class="definitions">
        <div class="def"><dt>État</dt><dd>${renderEtat(sla)}</dd></div>
        <div class="def"><dt>Fréquence</dt><dd>${echapper(sla.description)}
          <span class="champ__aide technique">${echapper(sla.schedule)}</span></dd></div>
        <div class="def"><dt>Prochaine prise</dt><dd>${
          sla.enabled && sla.next_run_at
            ? echapper(dateDouble(sla.next_run_at, fuseau))
            : 'Suspendu : aucune prise prévue.'}</dd></div>
        <div class="def"><dt>Dernière prise</dt><dd>${renderDerniere(sla)}</dd></div>
        <div class="def"><dt>Rétention</dt><dd>${echapper(libelleRetention(sla.retention_days, sla.retention_count))}</dd></div>
        <div class="def"><dt>Tenus par le SLA</dt><dd>${tenus} instantané${tenus > 1 ? 's' : ''}${echapper(taille)}</dd></div>
      </dl>
      ${ui.refusGeste ? `<div class="refus" role="alert"><p><strong>${echapper(ui.refusGeste)}</strong></p></div>` : ''}
      <p class="actions-section">
        <button type="button" class="bouton bouton--compact" data-ouvre="sla">Modifier</button>
        <button type="button" class="bouton bouton--compact" data-sla-bascule="${sla.enabled ? 'suspend' : 'resume'}">${
          sla.enabled ? 'Suspendre' : 'Reprendre'}</button>
        <button type="button" class="bouton bouton--compact" data-sla-retrait>Retirer</button>
      </p>
      ${retrait}`;
  }
  return `
<section class="carte bloc" aria-labelledby="titre-sla">
  <h2 id="titre-sla">SLA des instantanés</h2>
  ${corps}
  ${renderModaleSla(ui)}
</section>`;
}

/** Le badge « SLA » de la liste des instantanés : la provenance se LIT, elle ne se déduit pas d'un nom. */
export function badgeSla(snapshot) {
  return snapshot?.origin === 'sla'
    ? ' <span class="badge badge--brand" title="Pris automatiquement par le SLA">SLA</span>'
    : '';
}
