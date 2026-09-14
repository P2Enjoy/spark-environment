/**
 * Facette *Environnement* d'un Spark : ce que sa pile recevra.
 *
 * @spec docs/BACKLOG.md#SPK-58, docs/BACKLOG.md#SPK-64,
 *       docs/BACKLOG.md#SPK-97 (l'import d'un lot, docs/DAT.md §43.10),
 *       docs/BACKLOG.md#SPK-103 (deux blocs par section, et la recherche) ·
 *       docs/DESIGN_SYSTEM_APP.md SPK-DS-23, SPK-DS-25 · docs/DAT.md §43
 *       (l'environnement d'un Spark), §43.3 (la différence est DÉCLARÉE),
 *       §43.6 révisé (la Forge propose, le Spark choisit), §43.7 (quand cela
 *       prend effet), §43.9.4 (l'origine de chaque valeur), §43.9.5 (les refus),
 *       §43.11 (deux natures, deux blocs, une recherche sur le nom) ·
 *       docs/DESIGN_SYSTEM.md §5.4 (les degrés), §6.27 (fenêtre, sections,
 *       modale), §6.13 (états d'une vue), §6.14 (tableau), §9.3 (les titres ne
 *       sautent pas de niveau), §9.9 (désactivé mais visible), §14.4 (pas de
 *       contrôle sans objet), §14.5 (l'absence se nomme), §14.6 (trois états
 *       distincts), §14.10 (une recherche ne compare que ce que toute entrée
 *       porte)
 *
 * **Deux sections, une par niveau** (§43.6) : ce qui vient de la Forge et ce qui
 * appartient au Spark. Les mélanger ferait perdre l'information la plus
 * difficile à reconstituer — pourquoi une valeur est celle-là et pas une autre.
 *
 * **Deux blocs dans chaque section** (§43.11) : les variables, puis les secrets.
 * La nature se découpe DANS un niveau, jamais à sa place — croiser les deux axes
 * en un seul niveau mettrait dans un même tableau des lignes qu'on DÉCOCHE et
 * des lignes qu'on RETIRE, et perdrait l'origine au passage.
 */

import { IMPORT_VIDE, renderImportEnv } from './env-import.js';
import {
  correspondEnv, filtrerEnv, renderAnnonceRecherche, renderBlocEnv,
  renderRechercheEnv, separer,
} from './env-blocs.js';

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * L'état de la facette. `open` porte le niveau visé par la modale : les deux
 * sections ont leur propre modale (§6.27), et une seule s'ouvre à la fois.
 */
export const ENV_VIDE = {
  open: null,       // 'forge' | 'spark'
  busy: false,
  refusal: null,    // { message, protected_sparks? }
  // SPK-103 : la frappe vit dans l'interface et n'en sort pas — ni dans
  // l'adresse, ni au serveur (§43.11). Rouvrir la facette la rouvre entière.
  recherche: '',
  values: { name: '', value: '', secret: false },
};

/**
 * Ce que l'écran dit de l'origine d'une valeur (§43.9.4).
 *
 * `overridden` mérite sa propre phrase : elle dit qu'une valeur de la Forge est
 * MASQUÉE, donc qu'on la chercherait en vain là où elle est écrite.
 */
export const ORIGINES = {
  // SPK-64 : « héritée » était le mot du défaut. Rien n'est hérité — une entrée
  // du catalogue descend parce qu'on l'a COCHÉE ici, et nulle part ailleurs.
  forge: { libelle: 'Cochée au catalogue', token: 'neutral' },
  spark: { libelle: 'Propre à ce Spark', token: 'brand' },
  overridden: { libelle: 'Masque une entrée cochée', token: 'accent' },
};

/** Une valeur de secret ne s'affiche JAMAIS (§43.3). L'empreinte la compare. */
function cellule(entree) {
  if (!entree.is_secret) {
    return `<td class="technique">${echapper(entree.value)}</td>`;
  }
  // §14.6 : « défini mais masqué » n'est ni « absent » ni « vide ». Un blanc
  // laisserait croire qu'aucun secret n'est posé.
  return `<td><span class="badge badge--neutral">Secret</span>
    <span class="technique">${echapper(entree.fingerprint)}</span></td>`;
}

function lignes(entrees, { selection = false } = {}) {
  // §8.1 et §14.2 : le tableau défile dans son PROPRE conteneur, et le
  // débordement est SIGNALÉ — un débordement muet est un contenu caché.
  return `<div class="tableau-enveloppe">
  <p class="tableau-indice">Le tableau défile horizontalement.</p>
  <table>
  <thead><tr><th scope="col">Nom</th><th scope="col">Valeur</th>
    <th scope="col">Origine</th><th scope="col">Modifiée</th>
    <th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
  <tbody>${entrees.map((e) => {
    const origine = ORIGINES[e.origin] ?? ORIGINES.spark;
    return `<tr>
      <th scope="row" class="technique nom-cellule">${echapper(e.name)}</th>
      ${cellule(e)}
      <td><span class="badge badge--${origine.token}">${echapper(origine.libelle)}</span></td>
      <td class="technique">${echapper((e.updated_at || '').slice(0, 10))}</td>
      <td><span class="actions-ligne">${selection
        ? `<button type="button" class="bouton bouton--compact"
             data-env-decocher="${echapper(e.name)}">Décocher</button>`
        : `<button type="button" class="bouton bouton--compact"
             data-env-retire="${echapper(e.name)}" data-env-portee="${echapper(e.scope)}"
             >Retirer</button>`}</span></td>
    </tr>`;
  }).join('')}</tbody></table></div>`;
}

/**
 * Une section, un niveau, une modale (§6.27).
 *
 * @param {string} niveau `forge` ou `spark`
 */
function section(niveau, spark, entrees, ui, renderModale, recherche = '') {
  const forge = niveau === 'forge';
  // SPK-103 : « Variables propres… » était devenu faux le jour où la section a
  // porté AUSSI des secrets. Elle porte des ENTRÉES ; leur nature se lit un cran
  // plus bas, dans les deux blocs.
  const titre = forge ? 'Entrées du catalogue cochées ici' : 'Entrées propres à ce Spark';
  const id = `titre-env-${niveau}`;
  const propres = entrees.filter((e) => (e.scope === 'forge') === forge);
  const tous = separer(propres);
  const vues = separer(filtrerEnv(propres, recherche));

  // §14.5 : l'absence est un FAIT, et il se nomme. Un tableau vide ne dirait
  // pas si rien n'est posé ou si le relevé a échoué. Elle se dit UNE fois au
  // niveau de la section : deux blocs vides répéteraient la même absence.
  const corps = propres.length
    ? `${renderBlocEnv({
        id: `${id}-variables`, titre: 'Variables',
        entrees: vues.variables, total: tous.variables.length, recherche,
        absence: {
          vide: forge ? 'Aucune variable du catalogue ne descend dans ce Spark.'
                      : 'Aucune variable propre à ce Spark.',
          filtre: 'Aucune variable ne porte',
        },
        rendu: (retenues) => lignes(retenues, { selection: forge }),
      })}
${renderBlocEnv({
        id: `${id}-secrets`, titre: 'Secrets',
        entrees: vues.secrets, total: tous.secrets.length, recherche,
        absence: {
          vide: forge ? 'Aucun secret du catalogue ne descend dans ce Spark.'
                      : 'Aucun secret propre à ce Spark.',
          filtre: 'Aucun secret ne porte',
        },
        rendu: (retenues) => lignes(retenues, { selection: forge }),
      })}`
    : `<p class="absence">${forge
        ? 'Aucune entrée du catalogue ne descend dans ce Spark.'
        : 'Aucune entrée propre : ce Spark ne reçoit que les entrées cochées du catalogue.'}</p>`;

  // §9.9 : sur un Spark protégé, la commande RESTE visible et désactivée, avec
  // sa raison. La faire disparaître ferait croire que le produit ne sait pas
  // poser de variable.
  const gele = spark.protected;
  const commande = forge ? '' : `<p class="formulaire__actions">
    <button type="button" class="bouton" data-ouvre-env="${niveau}"${gele ? ' disabled' : ''}>
      Poser une entrée</button>
    <button type="button" class="bouton" data-ouvre="env-import"${gele ? ' disabled' : ''}>
      Importer un lot</button>
    ${gele ? '<span class="note">Ce Spark est protégé : levez la protection d’abord.</span>' : ''}
  </p>`;

  return `
<section class="carte bloc" aria-labelledby="${id}">
  <h2 id="${id}">${titre}</h2>
  <p class="note">${forge
    ? 'Elles sont définies au catalogue de la Forge, puis cochées pour ce Spark. Décocher les retire de sa cellule.'
    : 'Elles ne concernent que ce Spark et masquent une entrée cochée du même nom, nom par nom.'}</p>
  ${corps}
  ${commande}
  ${renderModale({
    ouverte: ui.open === niveau, id: `env-${niveau}`, titre,
    engagement: 'Poser', refus: ui.refusal?.niveau === niveau ? ui.refusal.message : null,
    occupee: ui.busy,
    corps: `
      <div class="champ">
        <label for="env-nom-${niveau}">Nom</label>
        <input class="controle technique" id="env-nom-${niveau}" name="env_name" type="text"
               autocomplete="off" placeholder="SMTP_HOST"
               value="${echapper(ui.values.name)}">
        <p class="champ__aide">Une lettre ou un souligné, puis des lettres, chiffres
        et soulignés. C’est la grammaire que le shell sait exporter.</p>
      </div>
      <div class="champ">
        <label for="env-valeur-${niveau}">Valeur</label>
        <input class="controle" id="env-valeur-${niveau}" name="env_value" type="text"
               autocomplete="off" value="${echapper(ui.values.value)}">
      </div>
      <div class="champ">
        <label for="env-secret-${niveau}">
          <input type="checkbox" id="env-secret-${niveau}" name="env_secret"
                 ${ui.values.secret ? 'checked' : ''}> Déclarer cette valeur secrète
        </label>
        <p class="champ__aide">Une valeur secrète n’est plus jamais affichée, ni
        rendue par l’API, ni portée au journal. On la remplace ; on ne la relit pas.</p>
      </div>
      <p class="note">La pile du locataire ne lira la nouvelle valeur qu’à son
      prochain démarrage : écrire ici ne redémarre rien.
      <a href="#/manuel/M8">Manuel M8 — Exploiter au quotidien</a></p>`,
  })}
</section>`;
}

/**
 * La facette entière.
 *
 * Le tableau rend le jeu RÉSOLU : ce que la pile recevra vraiment, y compris ce
 * qui vient de la Forge. Montrer les deux jeux séparément sans les résoudre
 * ferait faire le calcul de tête à l'exploitant — et c'est précisément le calcul
 * qu'on se trompe à faire (§43.6).
 */
export function renderEnvPanel(spark, entrees = [], ui = ENV_VIDE,
                               renderModale = () => '', catalogue = [],
                               importUi = IMPORT_VIDE) {
  const refusSelection = ui.refusal?.niveau === 'selection'
    ? `<div class="refus" role="alert"><p>${echapper(ui.refusal.message)}</p></div>` : '';

  // SPK-103 · §43.11 : UN champ pour la facette entière — on cherche un nom sans
  // savoir d'avance s'il vit au catalogue, dans les entrées cochées ou dans les
  // entrées propres.
  const recherche = ui.recherche ?? '';
  // Ce que la facette PORTE, noms confondus : une entrée cochée figure à la fois
  // au catalogue et dans une section. Le champ se décide sur ce total (§14.4) et
  // non sur ce qui reste après la frappe — sans quoi il disparaîtrait au moment
  // précis où il est le seul moyen de revenir en arrière.
  const noms = new Set([...entrees.map((e) => e.name), ...catalogue.map((e) => e.name)]);
  const retenus = [...noms].filter((nom) => correspondEnv(nom, recherche)).length;
  const chercheur = renderRechercheEnv({ id: 'env-recherche', valeur: recherche,
                                         total: noms.size });
  const barre = chercheur
    ? `<section class="carte bloc">${chercheur}${
        renderAnnonceRecherche(retenus, noms.size, recherche)}</section>`
    : '';

  return refusSelection + barre
       + renderCatalogueCases(spark, catalogue, entrees, recherche)
       + section('forge', spark, entrees, ui, renderModale, recherche)
       + section('spark', spark, entrees, ui, renderModale, recherche)
       // SPK-97 : la modale d'import est rendue UNE fois pour la facette, et non
       // dans la section — deux `dialog` ouverts en même temps sortiraient du
       // contrat du §6.27, dont `brancherModale` ne gère qu'une instance.
       + renderImportEnv({
           portee: 'spark', ui: importUi, renderModale,
           existantes: entrees.filter((e) => e.scope === 'spark').map((e) => e.name),
           // Une entrée COCHÉE du catalogue n'est pas remplacée par un import :
           // elle est MASQUÉE, et l'écran le dit avant d'écrire (§43.9.4).
           cochees: entrees.filter((e) => e.origin === 'forge').map((e) => e.name),
         });
}

/**
 * Le catalogue de la Forge, avec une case par entrée (SPK-64 · §43.6 révisé).
 *
 * C'est ICI que se décide ce qui descend. Une entrée du catalogue n'atteint
 * cette cellule que si sa case est cochée — sans quoi un secret défini une fois
 * à la Forge se déposerait en clair dans toutes les cellules, y compris celles
 * qui n'en ont aucun usage (§43.5.1).
 */
export function renderCatalogueCases(spark, catalogue = [], entrees = [], recherche = '') {
  if (!catalogue.length) {
    // §14.5 : l'absence se nomme. Un bloc vide laisserait croire à une panne
    // de chargement là où il n'y a simplement rien à cocher.
    return `<section class="carte bloc" aria-labelledby="titre-catalogue">
      <h2 id="titre-catalogue">Catalogue de la Forge</h2>
      <p class="absence">Le catalogue de la Forge est vide : il n’y a rien à faire
      descendre. Une entrée s’y ajoute depuis
      <a href="#/forge/environnement">l’onglet Environnement de la Forge</a>.</p>
    </section>`;
  }

  // Une entrée COCHÉE peut être masquée par une entrée propre du même nom. Le
  // dire sur la case évite de chercher pourquoi la valeur affichée n'est pas
  // celle du catalogue (§43.6).
  const masques = new Set(entrees.filter((e) => e.origin === 'overridden')
                                 .map((e) => e.name));
  const descend = new Set(entrees.filter((e) => e.origin !== 'spark')
                                 .map((e) => e.name));

  // La recherche traverse AUSSI les cases : c'est ici qu'on va chercher une
  // entrée à faire descendre, et c'est le plus long des trois inventaires
  // (§43.11).
  const retenues = filtrerEnv(catalogue, recherche);
  const frappe = String(recherche).trim();

  const cases = retenues.map((e) => {
    const coche = descend.has(e.name) || masques.has(e.name);
    const id = `descend-${e.name}`;
    return `<li class="case-catalogue">
      <label for="${id}">
        <input type="checkbox" id="${id}" data-descend="${echapper(e.name)}"
               ${coche ? 'checked' : ''}${spark?.protected ? ' disabled' : ''} />
        <span class="technique">${echapper(e.name)}</span>
        ${e.is_secret ? '<span class="badge badge--neutral">Secret</span>' : ''}
      </label>
      ${masques.has(e.name)
        ? '<span class="note">masquée par une entrée propre à ce Spark</span>'
        : ''}
    </li>`;
  }).join('');

  return `<section class="carte bloc" aria-labelledby="titre-catalogue">
  <h2 id="titre-catalogue">Catalogue de la Forge</h2>
  <p class="note">Cocher fait descendre l’entrée dans ce Spark. Décocher la retire
  de sa cellule. <a href="#/manuel/M8">Manuel M8</a></p>
  ${retenues.length
    ? `<ul class="liste-cases">${cases}</ul>`
    // §14.5 : ce que la FRAPPE exclut ne se dit pas comme un catalogue vide.
    : `<p class="absence">Aucune entrée du catalogue ne porte « ${echapper(frappe)} ».</p>`}
  ${spark?.protected ? '<p class="note">Ce Spark est protégé : levez la protection avant de modifier ses sélections.</p>' : ''}
</section>`;
}
