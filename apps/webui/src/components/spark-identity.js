/**
 * L'identité SSH que le Spark PRÉSENTE, et sa clé publique copiable.
 *
 * @spec docs/BACKLOG.md#SPK-74 · docs/DAT.md §17.5 (l'identité présentée),
 *       §17.2 (aucune clé privée) · docs/DESIGN_SYSTEM.md §3.1 (données
 *       techniques en monospace), §14.6 (zéro, en cours et indisponible sont
 *       trois états), §6.23 « Frapper le nom », §9.9 (état désactivé),
 *       §1.3 (pas de succès simulé), §1.5 (jamais la couleur seule)
 *
 * C'est le sens INVERSE des clés de SPK-11, et la section le dit dès sa première
 * phrase : celles-là laissent entrer, celle-ci laisse sortir. Un exploitant qui
 * confondrait les deux collerait la clé du Spark dans `authorized_keys` — ce qui
 * donnerait au dépôt distant un accès à la cellule.
 */

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** État initial. `status` vaut « vide » tant que la facette n'a rien demandé. */
export const IDENTITE_VIDE = {
  status: 'vide', releve: null, erreur: null,
  busy: false, confirming: null, frappe: '', copie: null,
};

/**
 * Le bloc de clé publique, en monospace et SÉLECTIONNABLE.
 *
 * Sélectionnable est une exigence, pas un confort : `navigator.clipboard`
 * n'existe pas hors contexte sûr et peut être refusée. Sans repli manuel, le
 * bouton de copie serait une impasse le jour où il échoue (§1.3).
 */
function bloc(cle) {
  return `<pre class="technique bloc-cle" tabindex="0"
  aria-label="Clé publique du Spark">${echapper(cle)}</pre>`;
}

/**
 * La section « Identité », dans la facette des clés.
 *
 * Les quatre états ont chacun leur texte (§14.6). « Aucune identité » appelle à
 * créer ; « indisponible » appelle à démarrer le Spark. Les fondre ferait créer
 * une seconde identité en croyant réparer la première, ce qui invaliderait la
 * clé déjà posée chez le tiers.
 */
export function renderIdentityPanel(spark, ui = IDENTITE_VIDE) {
  const nom = spark?.name ?? '';
  const releve = ui.releve;
  const entete = `<h2>Identité du Spark</h2>
    <p class="section__aide">Ce que ce Spark <strong>présente</strong> quand il sort —
    à GitHub par exemple, en clé de déploiement, pour cloner un dépôt privé.
    C’est l’inverse des clés autorisées ci-dessus, qui laissent entrer.
    La clé <strong>privée</strong> reste dans la cellule et n’en sort jamais.</p>`;

  if (ui.status === 'chargement' || ui.status === 'vide') {
    return `<section class="carte bloc" aria-busy="true">${entete}
      <p class="absence" role="status">Lecture de l’identité…</p></section>`;
  }

  if (ui.status === 'erreur') {
    return `<section class="carte bloc">${entete}
      <div class="refus" role="alert"><p><strong>${echapper(ui.erreur)}</strong></p></div>
      <p class="section__actions"><button type="button" class="bouton"
        data-identite-relire>Réessayer</button></p></section>`;
  }

  if (releve?.state === 'indisponible') {
    // §14.6 : ce n'est PAS « aucune identité ». Le geste attendu est de démarrer
    // le Spark, pas d'en créer une seconde.
    return `<section class="carte bloc">${entete}
      <p class="absence" role="status">Identité <strong>illisible</strong> : la cellule
      ne répond pas. Un Spark arrêté ne peut pas montrer sa clé — ce n’est pas la
      preuve qu’il n’en a pas. Démarrez-le pour la lire.</p></section>`;
  }

  if (releve?.state === 'absente') {
    return `<section class="carte bloc">${entete}
      <p class="absence">Aucune identité : ce Spark ne peut pas s’authentifier
      auprès d’un dépôt privé.</p>
      <p class="section__actions"><button type="button" class="bouton bouton--primaire"
        data-identite-creer ${ui.busy ? 'disabled' : ''}>${
        ui.busy ? 'Création…' : 'Créer l’identité'}</button></p>
      ${ui.erreur ? `<div class="refus" role="alert"><p><strong>${
        echapper(ui.erreur)}</strong></p></div>` : ''}</section>`;
  }

  // Présente. §6.23 « Frapper le nom » : remplacer réunit les trois conditions —
  // irréversible, objet confondable avec les autres Sparks, nom court et visible.
  const correspond = ui.frappe === nom;
  const remplacement = ui.confirming === 'identite'
    ? `<div class="confirmation" role="group" aria-label="Confirmer le remplacement">
         <p><strong>Remplacer l’identité de « ${echapper(nom)} » ?</strong></p>
         <p class="confirmation__consequence">La clé actuelle cesse d’être valide.
         Tout dépôt où elle est posée en clé de déploiement refusera ce Spark
         jusqu’à ce que la nouvelle clé y soit ajoutée.</p>
         <div class="champ">
           <label for="identite-nom">Frappez <strong>${echapper(nom)}</strong> pour confirmer</label>
           <input class="controle" id="identite-nom" type="text" autocomplete="off"
                  spellcheck="false" data-frappe-identite value="${echapper(ui.frappe)}">
           <p class="champ__aide" id="identite-aide" role="status">${correspond
             ? 'Le nom correspond.'
             : 'Le nom n’est pas encore celui du Spark : le remplacement n’est pas engageable.'}</p>
         </div>
         <p class="confirmation__actions">
           <button type="button" class="bouton bouton--destructif" data-identite-remplace
                   aria-describedby="identite-aide"
                   ${correspond && !ui.busy ? '' : 'disabled'}>${
             ui.busy ? 'Remplacement…' : 'Remplacer l’identité'}</button>
           <button type="button" class="bouton" data-identite-annule>Annuler</button>
         </p>
       </div>`
    : '';

  return `<section class="carte bloc">${entete}
    ${bloc(releve.public_key)}
    <dl class="paires">
      <dt>Empreinte</dt><dd class="technique">${echapper(releve.fingerprint)}</dd>
      <dt>Dans la cellule</dt><dd class="technique">${echapper(releve.path)}</dd>
    </dl>
    <p class="section__actions">
      <button type="button" class="bouton bouton--primaire" data-identite-copie>Copier la clé publique</button>
      <button type="button" class="bouton" data-identite-remplacer>Remplacer…</button>
    </p>
    ${ui.copie
      // §1.3 : « Copié » ne s'affiche qu'APRÈS que le presse-papier a confirmé.
      // Un refus le dit et renvoie au repli manuel plutôt que de mentir.
      ? `<p class="${ui.copie.ok ? 'succes' : 'avertissement'}" role="status">${
          echapper(ui.copie.message)}</p>`
      : ''}
    ${ui.erreur ? `<div class="refus" role="alert"><p><strong>${
      echapper(ui.erreur)}</strong></p></div>` : ''}
    ${remplacement}
    <p class="section__aide">Ajoutez cette clé au dépôt GitHub concerné, en
    <em>Deploy key</em> — en lecture seule si le Spark n’a qu’à cloner.</p>
  </section>`;
}
