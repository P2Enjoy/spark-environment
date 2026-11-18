/**
 * Le dépôt GitHub d'un Spark : sa clé posée, vérifiée, retirée depuis la console.
 *
 * @spec docs/BACKLOG.md#SPK-178 · docs/DAT.md §71.1 (un Spark, un dépôt), §71.3 (les
 *       gestes : vérifier, poser, retirer), §71.4 (ce que GitHub répond), §71.7 (la
 *       démonstration)
 * @spec docs/DESIGN_SYSTEM.md §1.3 (pas de succès simulé), §1.4 (pas de commande
 *       morte), §1.5 (jamais la couleur seule), §6.8 (badges, et la pastille qui
 *       porte sa sortie), §6.9 (champs), §6.10 (cases), §6.13 (un état relevé se
 *       date et ne survit pas à son relevé suivant), §6.22 et §6.23 (la
 *       confirmation d'un retrait), §9.7 (régions annoncées), §9.9 (état
 *       désactivé), §14.3 (le focus survit à la repeinture)
 * @spec docs/DESIGN_SYSTEM_APP.md SPK-DS-48 · docs/manuel/M6-acces.md
 *
 * Le composant ne décide de rien : il montre ce que l'hôte console a relevé chez
 * GitHub. Le jeton n'entre jamais ici — il vit sur l'hôte (§71.2) —, et la clé
 * posée est celle que la cellule présente, relue côté serveur : rien de ce que ce
 * formulaire envoie ne la désigne.
 */

/** État initial. `spark` retient de QUEL Spark vient ce qui est affiché. */
export const DEPOT_CLE_VIDE = {
  spark: null, status: 'vide', configured: null, reason: null,
  repository: '', ecriture: false,
  busy: null, confirming: null,
  bilan: null, releveLe: null,
  erreur: null, info: null, journalise: null,
};

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** L'heure du relevé, sans la date : l'écran dit « quand », pas « quel jour ». */
function heure(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const deux = (n) => String(n).padStart(2, '0');
  return `${deux(d.getHours())}:${deux(d.getMinutes())}:${deux(d.getSeconds())}`;
}

/**
 * La pastille d'état de la clé, et le mot qui la porte (§1.5).
 *
 * La couleur dit la NATURE de l'écart : `périmée` est un écart corrigeable
 * (danger : le Spark ne peut plus cloner), `posée en écriture` mérite l'attention
 * sans être une panne (accent), `non posée` est un état qui peut être voulu
 * (neutre).
 */
function pastille(bilan) {
  const faits = {
    non_posee: ['neutral', 'non posée'],
    posee: bilan.access === 'ecriture'
      ? ['accent', 'posée · écriture'] : ['success', 'posée · lecture seule'],
    perimee: ['danger', 'périmée'],
  };
  const [token, libelle] = faits[bilan.state] ?? ['neutral', 'état inconnu'];
  return `<span class="badge badge--${token}"><span class="badge__point"
    aria-hidden="true"></span>${libelle}</span>`;
}

function confirmation(ui, nom) {
  const depot = echapper(ui.repository.trim());
  if (ui.confirming === 'retirer') {
    // §6.23 : retirer une clé réduit l'exposition et se REPOSE à volonté — on
    // confirme, on ne fait pas frapper le nom. SPK-DS-09 : sensible, donc accent
    // et bouton ordinaire.
    return `<div class="confirmation confirmation--sensible" role="group"
        aria-label="Confirmer le retrait de la clé">
      <p><strong>Retirer la clé de « ${echapper(nom)} » du dépôt « ${depot} » ?</strong></p>
      <p class="confirmation__consequence">Ce Spark ne pourra plus cloner ce dépôt. La clé
      peut être reposée à tout moment.</p>
      <p class="confirmation__actions">
        <button type="button" class="bouton" data-depot-retire-confirme>Retirer la clé</button>
        <button type="button" class="bouton" data-depot-annule>Annuler</button>
      </p></div>`;
  }
  if (ui.confirming === 'ecriture') {
    return `<div class="confirmation confirmation--sensible" role="group"
        aria-label="Confirmer l’accès en écriture">
      <p><strong>Poser la clé de « ${echapper(nom)} » en écriture sur « ${depot} » ?</strong></p>
      <p class="confirmation__consequence">Le Spark pourra pousser sur ce dépôt, pas seulement
      le cloner.</p>
      <p class="confirmation__actions">
        <button type="button" class="bouton" data-depot-poser-confirme>Poser en écriture</button>
        <button type="button" class="bouton" data-depot-annule>Annuler</button>
      </p></div>`;
  }
  return '';
}

/**
 * La section « Dépôt GitHub », sous l'identité du Spark.
 *
 * Elle ne se rend QUE si l'identité est présente : sans clé, il n'y a rien à poser,
 * et la section « Identité du Spark » guide déjà vers sa création ou son démarrage.
 */
export function renderDepotPanel(spark, ui = DEPOT_CLE_VIDE, identite = null) {
  if (identite?.state !== 'presente') return '';
  const nom = spark?.name ?? '';
  const entete = `<h2 id="depot-cle-titre">Dépôt GitHub</h2>
    <p class="note">Le dépôt que ce Spark clone. La console y pose, vérifie et retire
    la clé de l’identité ci-dessus, en <em>Deploy key</em>.</p>`;
  const enveloppe = (corps, etendue = '') =>
    `<section class="carte bloc depot-cle" aria-labelledby="depot-cle-titre"${etendue}>
      ${entete}${corps}</section>`;

  if (ui.status === 'chargement' || ui.status === 'vide') {
    return enveloppe('<p class="absence" role="status">Lecture de la configuration…</p>',
                     ' aria-busy="true"');
  }
  if (ui.status === 'erreur') {
    return enveloppe(`<div class="refus" role="alert"><p><strong>${
      echapper(ui.erreur)}</strong></p></div>
      <p class="formulaire__actions"><button type="button" class="bouton"
        data-depot-relire>Réessayer</button></p>`);
  }
  if (!ui.configured) {
    // Le formulaire n'est pas rendu : la fonction existe, mais sans jeton elle ne
    // peut rien faire, et le dire vaut mieux qu'un bouton qui échouerait (§1.4).
    return enveloppe(`<p class="absence" role="status">Aucun jeton GitHub sur ce poste :
      posez <span class="technique">SPARK_GITHUB_DEPLOY_TOKEN</span> dans le
      <span class="technique">.env</span> de la console pour activer ces gestes. En
      attendant, la clé se copie à la main, ci-dessus.</p>`);
  }

  const occupe = ui.busy !== null;
  const bilan = ui.bilan;
  const etat = bilan?.state ?? 'non_posee';
  const relecture = ui.busy === 'verifier';

  // §6.13 : pendant un relevé, l'ancien n'est pas montré comme actuel.
  const releve = relecture
    ? `<p class="absence" role="status" aria-busy="true">Lecture chez GitHub…</p>`
    : bilan
      ? `<p class="releve-cle" role="status">${pastille(bilan)}
          <span class="technique">${echapper(bilan.repository)}</span>
          ${heure(ui.releveLe) ? `<span class="note">Relevé à ${heure(ui.releveLe)}</span>` : ''}
        </p>`
      : '';

  const dis = occupe ? ' disabled' : '';
  const libellePoser = ui.busy === 'poser'
    ? 'Pose en cours…'
    : etat === 'perimee'
      ? 'Remplacer la clé périmée'
      : ui.ecriture ? 'Poser la clé en écriture…' : 'Poser la clé en lecture seule';
  const poser = etat === 'posee' ? '' : `<button type="button"
      class="bouton bouton--primaire" data-depot-poser${dis}>${libellePoser}</button>`;
  const retirer = etat === 'non_posee' ? '' : `<button type="button" class="bouton"
      data-depot-retirer${dis}>${ui.busy === 'retirer' ? 'Retrait en cours…'
        : 'Retirer la clé…'}</button>`;

  return enveloppe(`
    <form class="formulaire" data-depot-form novalidate>
      <div class="champ">
        <label for="depot-cle-champ">Dépôt (propriétaire/dépôt)</label>
        <input class="controle technique" id="depot-cle-champ" type="text"
               autocomplete="off" spellcheck="false" placeholder="p2enjoy/crm"
               data-depot-champ value="${echapper(ui.repository)}"
               aria-describedby="depot-cle-aide"${occupe ? ' readonly' : ''}>
        <p class="champ__aide" id="depot-cle-aide">Un Spark sert un seul dépôt.</p>
      </div>
      <div>
        <label class="case">
          <input type="checkbox" data-depot-ecriture${ui.ecriture ? ' checked' : ''}${dis}
                 aria-describedby="depot-cle-ecriture-aide">
          <span>Autoriser l’écriture</span>
        </label>
        <p class="champ__aide" id="depot-cle-ecriture-aide">Décochée : la clé ne peut que cloner et tirer.</p>
      </div>
      <p class="formulaire__actions">
        <button type="submit" class="bouton" data-depot-verifier${dis}>${
          relecture ? 'Lecture…' : 'Vérifier'}</button>
        ${poser}${retirer}
      </p>
    </form>
    ${releve}
    ${confirmation(ui, nom)}
    ${ui.erreur ? `<div class="refus" role="alert"><p><strong>${
      echapper(ui.erreur)}</strong></p></div>` : ''}
    ${ui.info ? `<p class="succes" role="status">${echapper(ui.info)}</p>` : ''}
    ${ui.info && ui.journalise === false
      ? `<p class="avertissement" role="status">Le geste est fait, mais le journal de la
         Forge n’a pas pu le noter.</p>` : ''}`);
}
