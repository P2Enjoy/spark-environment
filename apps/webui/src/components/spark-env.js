/**
 * Facette *Environnement* d'un Spark : ce que sa pile recevra.
 *
 * @spec docs/BACKLOG.md#SPK-58 · docs/DAT.md §43 (l'environnement d'un Spark),
 *       §43.3 (la différence est DÉCLARÉE), §43.6 (général d'abord, surcharge
 *       ensuite), §43.7 (quand cela prend effet), §43.9.4 (l'origine de chaque
 *       valeur), §43.9.5 (les refus) ·
 *       docs/DESIGN_SYSTEM.md §5.4 (les degrés), §6.27 (fenêtre, sections,
 *       modale), §6.13 (états d'une vue), §6.14 (tableau), §9.9 (désactivé mais
 *       visible), §14.5 (l'absence se nomme), §14.6 (trois états distincts) ·
 *       docs/DESIGN_SYSTEM_APP.md
 *
 * **Deux sections, une par niveau** (§43.6) : ce qui vient de la Forge et ce qui
 * appartient au Spark. Les mélanger ferait perdre l'information la plus
 * difficile à reconstituer — pourquoi une valeur est celle-là et pas une autre.
 */

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
  values: { name: '', value: '', secret: false },
};

/**
 * Ce que l'écran dit de l'origine d'une valeur (§43.9.4).
 *
 * `overridden` mérite sa propre phrase : elle dit qu'une valeur de la Forge est
 * MASQUÉE, donc qu'on la chercherait en vain là où elle est écrite.
 */
export const ORIGINES = {
  forge: { libelle: 'Héritée de la Forge', token: 'neutral' },
  spark: { libelle: 'Propre à ce Spark', token: 'brand' },
  overridden: { libelle: 'Surcharge la Forge', token: 'accent' },
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

function lignes(entrees) {
  return `<div class="table-defilante"><table class="tableau">
  <thead><tr><th scope="col">Nom</th><th scope="col">Valeur</th>
    <th scope="col">Origine</th><th scope="col">Modifiée</th>
    <th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
  <tbody>${entrees.map((e) => {
    const origine = ORIGINES[e.origin] ?? ORIGINES.spark;
    return `<tr>
      <th scope="row" class="technique">${echapper(e.name)}</th>
      ${cellule(e)}
      <td><span class="badge badge--${origine.token}">${echapper(origine.libelle)}</span></td>
      <td class="technique">${echapper((e.updated_at || '').slice(0, 10))}</td>
      <td><span class="actions-ligne"><button type="button" class="bouton bouton--compact"
        data-env-retire="${echapper(e.name)}" data-env-portee="${echapper(e.scope)}"
        >Retirer</button></span></td>
    </tr>`;
  }).join('')}</tbody></table></div>`;
}

/**
 * Une section, un niveau, une modale (§6.27).
 *
 * @param {string} niveau `forge` ou `spark`
 */
function section(niveau, spark, entrees, ui, renderModale) {
  const forge = niveau === 'forge';
  const titre = forge ? 'Variables de la Forge' : 'Variables de ce Spark';
  const id = `titre-env-${niveau}`;
  const propres = entrees.filter((e) => (e.scope === 'forge') === forge);

  // §14.5 : l'absence est un FAIT, et il se nomme. Un tableau vide ne dirait
  // pas si rien n'est posé ou si le relevé a échoué.
  const corps = propres.length ? lignes(propres) : `<p class="absence">${forge
    ? 'Aucune variable commune : chaque Spark ne reçoit que les siennes.'
    : 'Aucune variable propre : ce Spark ne reçoit que celles de la Forge.'}</p>`;

  // §9.9 : sur un Spark protégé, la commande RESTE visible et désactivée, avec
  // sa raison. La faire disparaître ferait croire que le produit ne sait pas
  // poser de variable.
  const gele = !forge && spark.protected;
  const commande = `<p class="formulaire__actions">
    <button type="button" class="bouton" data-ouvre-env="${niveau}"${gele ? ' disabled' : ''}>
      ${forge ? 'Poser une variable commune' : 'Poser une variable'}</button>
    ${gele ? '<span class="note">Ce Spark est protégé : levez la protection d’abord.</span>' : ''}
  </p>`;

  return `
<section class="carte bloc" aria-labelledby="${id}">
  <h2 id="${id}">${titre}</h2>
  <p class="note">${forge
    ? 'Elles descendent dans tous les Sparks. Une variable du même nom posée sur un Spark les remplace, nom par nom.'
    : 'Elles ne concernent que ce Spark, et remplacent celles de la Forge qui portent le même nom.'}</p>
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
                               renderModale = () => '') {
  return section('forge', spark, entrees, ui, renderModale)
       + section('spark', spark, entrees, ui, renderModale);
}
