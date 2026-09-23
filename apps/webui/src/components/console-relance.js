/**
 * L'avertissement « Console à redémarrer », et le geste qui le corrige.
 *
 * @spec docs/BACKLOG.md#SPK-117 · docs/DAT.md §62.4 (ce que l'écran fait) ·
 *       docs/DESIGN_SYSTEM_APP.md SPK-DS-11 (révisé : le message porte son
 *       bouton), SPK-DS-09 (une confirmation sensible est en accent), SPK-DS-08
 *       (trois blocs d'issue) · docs/DESIGN_SYSTEM.md §6.8 (un écart corrigeable
 *       porte sa sortie), §6.22 (confirmation dans le flux), §1.3 (pas de succès
 *       simulé), §1.4 (pas de commande morte), §9.7 · manuel M3
 * @spec docs/BACKLOG.md#SPK-65 · docs/DAT.md §40.5 (l'avertissement lui-même)
 *
 * Rendu PUR : l'état vient de l'hôte (`GET /api/console/build`) et de la
 * coquille (la phase du geste, les sessions ouvertes). Le branchement vit dans
 * `app.js`.
 */

/**
 * Les phases du geste :
 *
 * - `repos`        — l'avertissement, et son bouton ;
 * - `confirmation` — le bloc qui nomme ce qui va se passer ;
 * - `envoi`        — l'hôte vérifie que le nouveau code se charge ;
 * - `attente`      — accepté : on attend qu'une AUTRE instance réponde ;
 * - `muette`       — aucune autre instance n'a répondu dans le délai.
 *
 * `refus` porte le dernier refus de l'hôte ; il se rend en phase `repos`, à
 * côté du bouton qui reste (SPK-DS-11).
 */
export const RELANCE_VIDE = Object.freeze({ phase: 'repos', refus: null, sessions: [] });

// §62.4 : la page attend une autre instance au plus ce temps-là.
export const ATTENTE_MAX_MS = 30_000;

const echapper = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Le nom d'une session, tel que l'exploitant la reconnaît dans son widget. */
export function nommerSession(session) {
  const parts = [session.spark];
  if (session.container) parts.push(`conteneur ${session.container}`);
  if (session.type === 'rescue') parts.push('dépannage');
  return parts.join(' · ');
}

/** Les sessions VIVANTES : ce sont elles, et elles seules, que le geste ferme. */
export const sessionsOuvertes = (items = []) =>
  items.filter((s) => s && s.state === 'open' && !s.closed);

export function renderBuildConsole(vu, relance = RELANCE_VIDE) {
  if (vu?.verdict !== 'perimee') return '';
  const phase = relance?.phase ?? 'repos';

  if (phase === 'attente') {
    return `<div class="avertissement avertissement--laterale" role="status">
      <p><strong>Redémarrage de la console…</strong></p>
      <p>La page se recharge dès que la nouvelle console répond.</p>
    </div>`;
  }
  if (phase === 'muette') {
    // Un défaut CONSTATÉ, pas un refus : l'accent, et l'alerte (SPK-DS-08).
    return `<div class="avertissement avertissement--laterale" role="alert">
      <p><strong>La console ne répond plus</strong></p>
      <p>Aucune nouvelle console n’a répondu en ${ATTENTE_MAX_MS / 1000} s après
      le redémarrage. Son journal dit pourquoi : la sortie de
      <code>make runProd</code>.</p>
    </div>`;
  }

  // SPK-DS-11 révisé : sans lanceur, le geste n'EXISTE pas — pas de bouton
  // désactivé (§1.4), une phrase qui dit comment faire.
  const geste = !vu.relaunchable
    ? '<p>Lancée sans son lanceur, elle se redémarre à la main.</p>'
    : phase === 'repos'
      ? `<p><button type="button" class="bouton bouton--compact"
           data-relance="ouvrir">Redémarrer la console</button></p>`
      : '';

  return `<div class="avertissement avertissement--laterale" role="status">
      <p><strong>${echapper(vu.title)}</strong></p>
      <p>${echapper(vu.detail)}</p>
      ${geste}
    </div>${vu.relaunchable ? renderSuite(relance) : ''}`;
}

function renderSuite(relance) {
  const phase = relance?.phase ?? 'repos';
  if (phase === 'repos') return relance?.refus ? renderRefus(relance.refus) : '';

  const sessions = relance.sessions ?? [];
  const nommees = sessions.length
    ? `<p>${sessions.length > 1
        ? `Ces ${sessions.length} sessions de terminal seront fermées :`
        : 'Cette session de terminal sera fermée :'}</p>
       <ul>${sessions.map((s) => `<li>${echapper(nommerSession(s))}</li>`).join('')}</ul>`
    : '<p>Aucune session de terminal n’est ouverte.</p>';
  const envoi = phase === 'envoi';

  return `<div class="confirmation confirmation--sensible confirmation--laterale"
      role="group" aria-labelledby="titre-relance-console" data-relance="bloc">
      <p id="titre-relance-console"><strong>Redémarrer la console ?</strong></p>
      <p>Elle s’arrête, puis repart avec le code du dépôt. La page se recharge et
      les tunnels se rouvrent.</p>
      ${nommees}
      ${envoi ? '<p role="status">Vérification que le nouveau code se charge…</p>' : ''}
      <p class="confirmation__actions">
        <button type="button" class="bouton bouton--compact" data-relance="engager"
                ${envoi ? 'disabled' : ''}>Redémarrer</button>
        <button type="button" class="bouton bouton--compact" data-relance="annuler"
                ${envoi ? 'disabled' : ''}>Annuler</button>
      </p>
    </div>`;
}

/** Le refus de l'hôte, rouge (SPK-DS-08), avec la sortie du préflight s'il y en a. */
function renderRefus(refus) {
  return `<div class="refus refus--laterale" role="alert">
      <p>${echapper(refus.message)}</p>
      ${refus.output ? `<pre class="refus__sortie">${echapper(refus.output)}</pre>` : ''}
    </div>`;
}
