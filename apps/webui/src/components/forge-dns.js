/**
 * L'inventaire DNS de la Forge : ce qui pointe vers elle, et ce qui s'est perdu.
 *
 * @spec docs/BACKLOG.md#SPK-83 · docs/DAT.md §38.8.5 bis (affecter plutôt que
 *       retirer, et affecter n'écrit rien dans la zone) · §18.3 bis (les bornes
 *       d'un domaine et la préséance du plus spécifique), §18.4 (l'unicité est
 *       portée par la base), §35 (la protection) ·
 *       docs/DESIGN_SYSTEM.md §1.5 bis (laisser tenter, montrer le refus réel)
 * @spec docs/BACKLOG.md#SPK-77 · docs/DAT.md §38.8 (l'inventaire),
 *       §38.8.1 (le périmètre étroit), §38.8.2 (les deux verdicts et la prudence
 *       du second), §38.8.3 (les quatre conditions d'une suppression),
 *       §38.8.5 (pourquoi la page vit sous la Forge), §38.1.1 (trois états d'un
 *       relevé vide) · docs/DESIGN_SYSTEM.md §6.13 (états systématiques),
 *       §6.14 (tableau de données), §6.22 (une confirmation reste dans le flux),
 *       §14.5 (une absence utile est NOMMÉE) · docs/DESIGN_SYSTEM_APP.md
 *
 * Une section de la Forge, jamais une facette d'un Spark : elle couvre tous les
 * Sparks, et surtout les noms qui n'appartiennent à aucun — qui sont l'objet
 * même de la page (§38.8.5).
 */

import { renderModale } from './modale.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** État initial. `configured` vaut `null` tant qu'on n'a pas demandé : « pas
 *  encore su » n'est pas « pas configuré » (§38.1.1). */
export const FORGE_DNS_VIDE = {
  chargement: false,
  configured: null,
  reason: null,
  refus: null,
  forge: null,
  entries: [],
  // Les entrées DÉSIGNÉES pour le retrait, par leur clé `zone|name|type`. La
  // sélection se fait entrée par entrée : le §38.8.3 interdit un « tout
  // nettoyer » qui ne montrerait qu'un compte.
  selection: [],
  confirmation: false,
  busy: false,
  // SPK-83 · §38.8.5 bis : l'entrée qu'on AFFECTE, et ce que la déclaration
  // exige et ne devine pas — le Spark, le port interne, le TLS.
  affectation: null,
  sparks: [],
  valeurs: { spark: '', port: 8080, tls: true },
  refusAffectation: null,
  // Le sort de CHAQUE ligne, jamais un verdict global : un nettoyage peut
  // retirer deux entrées et s'en faire refuser une troisième, et on ne défait
  // pas une suppression DNS (même règle qu'au §38.6.3).
  resultat: null,
};

/** Clé stable d'une entrée. Le trio identifie l'enregistrement chez le
 *  fournisseur, exactement comme `id_fields` (§38.2). */
export function cleEntree(e) {
  return `${e.zone}|${e.name ?? ''}|${e.type}`;
}

/** Les entrées désignées, dans l'ordre où elles sont affichées. */
export function choisies(etat) {
  const cles = new Set(etat.selection ?? []);
  return (etat.entries ?? []).filter((e) => !e.served && cles.has(cleEntree(e)));
}

/**
 * Le verdict d'une entrée, en toutes lettres (§38.8.2).
 *
 * « Aucune route ne le sert » et non « inutile » : le produit ignore si
 * l'exploitant sert ce nom sur la Forge autrement, et l'affirmer ferait
 * supprimer ce qui marchait.
 */
function renderVerdict(e) {
  if (e.served) {
    return `<span class="badge badge--success">Servi</span> `
      + `<span class="technique">${echapper(e.route)}</span> → `
      + `<a class="lien-spark" href="#/sparks/${encodeURIComponent(e.spark)}"`
      + `>${echapper(e.spark)}</a>`;
  }
  return `<span class="badge badge--accent">Aucune route ne le sert</span>`;
}

function renderLigne(e, etat) {
  const cle = cleEntree(e);
  const designee = (etat.selection ?? []).includes(cle);
  const choix = e.served
    // Une entrée servie n'est pas désignable : le serveur la refuserait de toute
    // façon (§38.8.3), et offrir la case ferait espérer un geste impossible.
    ? ''
    : `<input type="checkbox" data-dns-entree="${echapper(cle)}"
              id="dns-e-${echapper(cle)}"${designee ? ' checked' : ''}
              aria-label="Désigner ${echapper(e.fqdn)} pour le retrait">`;
  // §38.8.5 bis : une entrée sans route porte DEUX issues, et l'écran ne les
  // hiérarchise pas. Une entrée servie n'en porte aucune : il n'y a rien à
  // terminer, et rien à retirer.
  const affecter = e.served ? '' :
    `<button type="button" class="bouton bouton--compact"
      data-dns-affecter="${echapper(cle)}">Affecter</button>`;
  return `<tr>
    <td>${choix}</td>
    <td class="cellule-nom"><label for="dns-e-${echapper(cle)}"
      class="technique">${echapper(e.fqdn)}</label>${
      e.apex ? ' <span class="note">domaine nu</span>' : ''}</td>
    <td><span class="technique">${echapper(e.type)}</span></td>
    <td class="colonne-secondaire"><span class="technique">${echapper(e.zone)}</span></td>
    <td>${renderVerdict(e)}</td>
    <td class="aligne-droite">${affecter}</td>
  </tr>`;
}

/**
 * Le sort de chaque entrée du lot (§38.6.3, appliqué au nettoyage).
 *
 * Un nettoyage n'est pas atomique : chaque retrait est une requête, chacune est
 * revérifiée, et on ne défait pas une suppression DNS. Présenter un refus seul
 * cacherait ce qui est DÉJÀ parti — et la liste affichée serait périmée.
 *
 * Il ne promet jamais que le nom ne répond plus : un résolveur sert encore
 * l'ancienne réponse pendant la durée du TTL (§38.4).
 */
function renderResultat(etat) {
  const fait = etat.resultat;
  if (!fait) return '';
  const partiel = fait.refus.length > 0;
  return `<div class="${partiel ? 'avertissement' : 'note-transitoire'}"
               role="status" id="dns-resultat">
    <p><strong>${fait.retires.length} retirée(s)</strong>${
      partiel ? `, ${fait.refus.length} refusée(s)` : ''}.</p>
    <ul class="liste-simple">${[
      ...fait.retires.map((r) =>
        `<li><span class="technique">${echapper(r.type)} ${echapper(r.fqdn)}</span> retirée</li>`),
      ...fait.refus.map((r) =>
        `<li><span class="technique">${echapper(r.fqdn)}</span> — <strong>refusée</strong> :
         ${echapper(r.message)}</li>`),
    ].join('')}</ul>
    ${fait.retires.length
      ? `<p class="note">Un résolveur peut encore servir l’ancienne réponse
         pendant la durée de son TTL.</p>`
      : ''}</div>`;
}

/**
 * La confirmation ÉNUMÈRE ce qui va partir (§38.8.3).
 *
 * Un compte — « 3 entrées » — ne permet pas de vérifier. C'est la liste, nom et
 * valeur, qui rend le geste relisable avant de l'engager.
 */
function renderConfirmation(etat) {
  const partantes = choisies(etat);
  return renderModale({
    ouverte: Boolean(etat.confirmation) && partantes.length > 0,
    id: 'dns-nettoyage',
    titre: 'Retirer les entrées désignées',
    engagement: `Retirer ${partantes.length} entrée${partantes.length > 1 ? 's' : ''}`,
    refus: etat.refus,
    occupee: etat.busy,
    corps: `
      <p>Ces enregistrements pointent vers cette Forge et aucune route ne les
      sert. Ils vont être retirés de la zone :</p>
      <ul class="liste-simple">${partantes.map((e) => `
        <li><span class="technique">${echapper(e.fqdn)} ${echapper(e.type)} →
        ${echapper(e.data)}</span>${e.apex
          // L'avertissement prend sa propre ligne : replié en fin de valeur, il
          // commençait une ligne par « : », et se lisait comme une coquille.
          ? '<br><strong>Domaine nu</strong> — c’est le domaine ENTIER qui cesse'
            + ' de pointer ici.'
          : ''}</li>`).join('')}</ul>
      <p class="champ__aide">Rien d’autre n’est touché dans la zone : le retrait
      vise le nom ET le type exacts. La condition « aucune route ne le sert » est
      revérifiée par la Forge au moment du retrait.</p>`,
  });
}

/**
 * La modale d'affectation (§38.8.5 bis).
 *
 * @spec docs/BACKLOG.md#SPK-83 · docs/DAT.md §38.8.5 bis, §26.3 (le port est
 *       celui du Spark, pas celui de la Forge) · docs/DESIGN_SYSTEM.md §6.27,
 *       §1.5 bis
 *
 * Elle dit d'emblée ce qu'elle NE FAIT PAS : l'enregistrement pointe déjà vers
 * la Forge, et rien ne sera écrit chez le fournisseur. Sur une page dont le
 * sujet est le DNS, on peut légitimement croire l'inverse.
 *
 * La liste des Sparks n'écarte personne : un Spark protégé refusera l'écriture,
 * et c'est ce refus RÉEL qu'il faut montrer, pas une case grisée qui devine.
 */
function renderAffectation(etat) {
  const entree = etat.affectation;
  if (!entree) return renderModale({ ouverte: false });
  const v = etat.valeurs ?? {};
  return renderModale({
    ouverte: true, id: 'dns-affectation',
    titre: 'Affecter ce domaine à un Spark',
    engagement: 'Déclarer la route',
    refus: etat.refusAffectation,
    occupee: etat.busy,
    corps: `
      <div class="champ">
        <label for="affect-domaine">Domaine</label>
        <input class="controle technique" id="affect-domaine" type="text" readonly
               value="${echapper(entree.fqdn)}">
        <p class="champ__aide">Il vient de l’enregistrement relevé : il pointe
        déjà vers cette Forge. <strong>Rien ne sera écrit dans la zone</strong> —
        ce geste déclare une route, et rien d’autre.</p>
      </div>
      <div class="champ">
        <label for="affect-spark">Spark</label>
        <select class="controle" id="affect-spark" name="spark"${
          etat.sparks.length ? '' : ' aria-describedby="affect-sans-spark"'}>
          <option value="">— choisir un Spark —</option>
          ${etat.sparks.map((s) =>
            `<option value="${echapper(s.name)}"${v.spark === s.name ? ' selected' : ''}>`
            + `${echapper(s.name)}${s.protected ? ' (protégé)' : ''}</option>`).join('')}
        </select>
        ${etat.sparks.length ? '' : `<p class="champ__aide" id="affect-sans-spark">Cette
        Forge ne porte aucun Spark : il n’y a rien à quoi affecter ce domaine.</p>`}
      </div>
      <div class="champ">
        <label for="affect-port">Port du Spark</label>
        <input class="controle" id="affect-port" name="port" type="number"
               min="1" max="65535" value="${echapper(v.port)}">
        <p class="champ__aide">Le port sur lequel écoute la pile DANS le Spark,
        pas celui de la Forge. Aucun enregistrement DNS ne le dit.</p>
      </div>
      <div class="champ">
        <label for="affect-tls">
          <input id="affect-tls" name="tls" type="checkbox"${v.tls ? ' checked' : ''}>
          Certificat TLS automatique
        </label>
      </div>`,
  });
}

/** Le corps de la page, selon l'état (§6.13). */
function renderCorps(etat) {
  if (etat.chargement && !etat.entries.length) {
    return '<p class="absence" aria-busy="true">Relevé des zones du compte…</p>';
  }
  if (etat.configured === false) {
    return `<p class="absence">${echapper(etat.reason ?? '')}</p>
      <p class="champ__aide">Le jeton vit sur ce poste, jamais sur la Forge : un
      jeton déposé sur la Forge serait lisible par qui y détient
      l’administration.</p>`;
  }
  if (etat.refus && !etat.confirmation) {
    return `<p class="refus" id="dns-inventaire-refus">${echapper(etat.refus)}</p>`;
  }
  if (etat.reason) return `<p class="absence">${echapper(etat.reason)}</p>`;
  if (!etat.entries.length) {
    return `<p class="absence" id="dns-inventaire-vide">Aucun enregistrement des
      zones du compte ne pointe vers cette Forge.</p>`;
  }
  const perdues = etat.entries.filter((e) => !e.served).length;
  return `
  <div class="tableau-enveloppe">
    <table>
      <caption class="sr-only">Enregistrements DNS pointant vers cette Forge,
      avec le Spark qui les sert ou l’absence de route.</caption>
      <thead><tr>
        <th scope="col"><span class="sr-only">Désigner</span></th>
        <th scope="col">Nom</th><th scope="col">Type</th>
        <th scope="col" class="colonne-secondaire">Zone</th>
        <th scope="col">Verdict</th>
        <th scope="col"><span class="sr-only">Affecter</span></th>
      </tr></thead>
      <tbody>${etat.entries.map((e) => renderLigne(e, etat)).join('')}</tbody>
    </table>
  </div>
  <p class="tableau-indice">Le tableau défile horizontalement pour révéler les
  colonnes suivantes.</p>
  ${perdues === 0
    ? '<p class="note">Chaque nom qui pointe ici est servi par une route.</p>'
    : `<p class="formulaire__actions">
         <button type="button" class="bouton" data-dns-nettoyer
           ${choisies(etat).length ? '' : 'disabled'}>Retirer les entrées désignées</button>
         <span class="note">${choisies(etat).length} désignée(s) sur ${perdues}
         sans route.</span>
       </p>`}`;
}

/** La page entière. */
export function renderForgeDns(etat = FORGE_DNS_VIDE) {
  const adresse = etat.forge?.adresse;
  return `
<div class="titre-vue">
  <h1 id="titre-dns">DNS de la Forge</h1>
  ${adresse
    ? `<p class="titre-vue__compte">Ce qui pointe vers
       <span class="technique">${echapper(adresse)}</span></p>`
    : ''}
</div>
<div class="carte bloc">
  <p class="champ__aide">Cette page ne montre que les enregistrements
  <span class="technique">A</span> et <span class="technique">AAAA</span> dont la
  valeur est exactement l’adresse de cette Forge. Les autres enregistrements des
  zones du compte — messagerie, vérifications, services tiers — ne la concernent
  pas et ne sont jamais touchés.</p>
  ${renderResultat(etat)}
  ${renderCorps(etat)}
</div>
${renderConfirmation(etat)}
${renderAffectation(etat)}`;
}
