/**
 * Comparer le texte actuel à la version proposée, ligne à ligne, AVANT
 * d'accepter un remplacement — la vue « côte à côte » d'une revue de code.
 *
 * @spec docs/BACKLOG.md#SPK-131 · docs/DAT.md §55.9.3 (ce qui est comparé,
 *       comment les textes s'alignent, la borne, ce que l'écran montre, les
 *       quatre états nommés) · docs/DESIGN_SYSTEM.md §6.29 (comparer deux
 *       versions d'un texte), §1.5 (jamais la couleur seule), §6.14 (tableau),
 *       §8.1 (une colonne sous 768 px), §14.3 (le focus ne se perd pas), §14.5,
 *       §14.6 (les états se nomment) · docs/DESIGN_SYSTEM_APP.md SPK-DS-27,
 *       SPK-DS-18 (les lignes longues se replient)
 *
 * **Le calcul vit dans la console** : c'est une présentation, et le §55.8 garde
 * le serveur hors de la présentation. Ce que la console NE fait PAS, en
 * revanche, c'est décider du texte de droite : c'est `sparkd` qui dit ce que
 * l'acceptation écrirait (`replacement`), et ce module compare ce qu'on lui
 * donne.
 *
 * **Myers, écrit ici, plutôt qu'une bibliothèque** : la console est servie
 * telle quelle, sans build ; une bibliothèque demanderait de servir un paquet de
 * `node_modules` à la page, pour une centaine de lignes que leurs preuves
 * tiennent (journal du 2026-09-30).
 */

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * §55.9.3 : au-delà de mille différences, on n'aligne plus. Une note fait au
 * plus 64 Kio (§54.9) ; la borne ne sert qu'à ce qu'un texte entièrement réécrit
 * n'immobilise pas l'onglet — le calcul et sa trace croissent comme son carré.
 */
export const BORNE = 1000;

/** §55.9.3 : trois lignes identiques restent visibles autour d'un changement. */
export const CONTEXTE = 3;

/** Un repli qui cacherait moins de quatre lignes coûterait plus qu'il ne cache. */
export const REPLI_MIN = 4;

/**
 * Les lignes d'un texte. Un texte vide n'en a AUCUNE : le compter pour une
 * ligne vide ferait « retirer » une ligne d'une note que personne n'a écrite.
 */
export function lignes(texte) {
  const brut = String(texte ?? '');
  return brut === '' ? [] : brut.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * Le plus court script d'édition de `a` vers `b` (Myers, 1986), ou `null`
 * au-delà de `borne` différences.
 *
 * On ne garde, à chaque profondeur, que les diagonales que la remontée relira
 * — de `-d-1` à `d+1` — plutôt que tout le tableau : la trace croît alors comme
 * `d²`, et non comme `d × (n + m)`.
 */
function scriptMyers(a, b, borne) {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, borne);
  const decalage = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice(decalage - d - 1, decalage + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[decalage + k - 1] < v[decalage + k + 1]))
        ? v[decalage + k + 1]
        : v[decalage + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[decalage + k] = x;
      if (x >= n && y >= m) return remonter(trace, n, m);
    }
  }
  return null;
}

/** La remontée : de la dernière profondeur à la première, un pas à la fois. */
function remonter(trace, n, m) {
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const v = trace[d];
    const lire = (k) => v[k + d + 1];
    const k = x - y;
    const kPrec = (k === -d || (k !== d && lire(k - 1) < lire(k + 1))) ? k + 1 : k - 1;
    const xPrec = lire(kPrec);
    const yPrec = xPrec - kPrec;
    while (x > xPrec && y > yPrec) {
      ops.push({ type: 'egal', a: x - 1, b: y - 1 });
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      ops.push(x === xPrec ? { type: 'ajoute', b: y - 1 } : { type: 'retire', a: x - 1 });
    }
    x = xPrec;
    y = yPrec;
  }
  return ops.reverse();
}

/**
 * Aligne deux suites : `{ ops, depasse }`.
 *
 * Le début et la fin communs sont retirés AVANT Myers : c'est le cas ordinaire
 * — un agent change trois lignes au milieu d'un README —, et la borne ne compte
 * alors que ce qui diffère vraiment.
 *
 * Au-delà de la borne, le script rendu reste JUSTE — tout le milieu retiré, puis
 * tout le milieu ajouté —, mais n'est plus le plus court, et `depasse` le dit :
 * l'écran ne le présente pas comme un alignement (§55.9.3).
 */
export function aligner(a, b, borne = BORNE) {
  let debut = 0;
  while (debut < a.length && debut < b.length && a[debut] === b[debut]) debut += 1;
  let finA = a.length;
  let finB = b.length;
  while (finA > debut && finB > debut && a[finA - 1] === b[finB - 1]) {
    finA -= 1;
    finB -= 1;
  }
  const milieu = scriptMyers(a.slice(debut, finA), b.slice(debut, finB), borne);
  const ops = [];
  for (let i = 0; i < debut; i += 1) ops.push({ type: 'egal', a: i, b: i });
  if (milieu) {
    for (const op of milieu) {
      if (op.type === 'egal') ops.push({ type: 'egal', a: op.a + debut, b: op.b + debut });
      else if (op.type === 'retire') ops.push({ type: 'retire', a: op.a + debut });
      else ops.push({ type: 'ajoute', b: op.b + debut });
    }
  } else {
    for (let i = debut; i < finA; i += 1) ops.push({ type: 'retire', a: i });
    for (let j = debut; j < finB; j += 1) ops.push({ type: 'ajoute', b: j });
  }
  for (let i = finA, j = finB; i < a.length; i += 1, j += 1) {
    ops.push({ type: 'egal', a: i, b: j });
  }
  return { ops, depasse: milieu === null };
}

/**
 * Les rangées de la vue côte à côte.
 *
 * Dans un même bloc de changement, la n-ième ligne retirée fait face à la
 * n-ième ligne ajoutée — une rangée `modifie` ; le surplus d'un côté fait face à
 * une case vide. C'est l'appariement d'une revue de code, et c'est lui qui
 * permet de marquer ce qui change DANS la ligne.
 */
export function apparier(ops, a, b) {
  const rangs = [];
  let retires = [];
  let ajoutes = [];
  const vider = () => {
    for (let i = 0; i < Math.max(retires.length, ajoutes.length); i += 1) {
      const g = retires[i];
      const d = ajoutes[i];
      rangs.push({
        nature: g === undefined ? 'ajoute' : (d === undefined ? 'retire' : 'modifie'),
        gauche: g === undefined ? null : { numero: g + 1, texte: a[g] },
        droite: d === undefined ? null : { numero: d + 1, texte: b[d] },
      });
    }
    retires = [];
    ajoutes = [];
  };
  for (const op of ops) {
    if (op.type === 'retire') retires.push(op.a);
    else if (op.type === 'ajoute') ajoutes.push(op.b);
    else {
      vider();
      rangs.push({ nature: 'egal',
                   gauche: { numero: op.a + 1, texte: a[op.a] },
                   droite: { numero: op.b + 1, texte: b[op.b] } });
    }
  }
  vider();
  return rangs;
}

/** Des mots, des blancs, et chaque signe de ponctuation pour lui-même. */
const JETONS = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

/**
 * Ce qui change DANS une ligne remplacée : `{ gauche, droite }`, deux suites de
 * morceaux `{ texte, change }`, ou `null` quand marquer n'apprendrait rien.
 *
 * Une note est de la prose, et un paragraphe tient souvent sur une ligne : sans
 * ces marques, on cherche une adresse corrigée dans deux lignes de trois cents
 * caractères. Deux lignes qui ne partagent AUCUN mot — seulement des blancs —
 * ne se marquent pas : tout y a changé, et la rangée le dit déjà.
 */
export function marquerMots(avant, apres, borne = BORNE) {
  const a = String(avant ?? '').match(JETONS) ?? [];
  const b = String(apres ?? '').match(JETONS) ?? [];
  const { ops, depasse } = aligner(a, b, borne);
  if (depasse || !ops.some((op) => op.type === 'egal' && a[op.a].trim())) return null;
  const gauche = [];
  const droite = [];
  const pousser = (liste, texte, change) => {
    const dernier = liste[liste.length - 1];
    if (dernier && dernier.change === change) dernier.texte += texte;
    else liste.push({ texte, change });
  };
  for (const op of ops) {
    if (op.type === 'egal') {
      pousser(gauche, a[op.a], false);
      pousser(droite, b[op.b], false);
    } else if (op.type === 'retire') {
      pousser(gauche, a[op.a], true);
    } else {
      pousser(droite, b[op.b], true);
    }
  }
  return { gauche, droite };
}

/**
 * Replie les lignes identiques au-delà du contexte : une suite de blocs
 * `{ type: 'rangs', rangs }` et `{ type: 'pli', index, rangs }`.
 *
 * Trois lignes restent de chaque côté d'un changement ; en tête et en queue du
 * texte, seulement du côté du changement. Un texte identique en entier n'a
 * aucun changement à entourer : il se replie tout entier, et l'écran le dit.
 */
export function plier(rangs, contexte = CONTEXTE, minimum = REPLI_MIN) {
  const blocs = [];
  let index = 0;
  const montrer = (liste) => {
    if (!liste.length) return;
    const dernier = blocs[blocs.length - 1];
    if (dernier?.type === 'rangs') dernier.rangs.push(...liste);
    else blocs.push({ type: 'rangs', rangs: [...liste] });
  };
  let i = 0;
  while (i < rangs.length) {
    if (rangs[i].nature !== 'egal') {
      montrer([rangs[i]]);
      i += 1;
      continue;
    }
    let j = i;
    while (j < rangs.length && rangs[j].nature === 'egal') j += 1;
    const suite = rangs.slice(i, j);
    const tete = i > 0 ? contexte : 0;
    const queue = j < rangs.length ? contexte : 0;
    if (suite.length - tete - queue >= minimum) {
      montrer(suite.slice(0, tete));
      blocs.push({ type: 'pli', index, rangs: suite.slice(tete, suite.length - queue) });
      index += 1;
      montrer(suite.slice(suite.length - queue));
    } else {
      montrer(suite);
    }
    i = j;
  }
  return blocs;
}

/**
 * Le modèle entier d'une comparaison : les rangées, les blocs, le compte, et
 * les états que l'écran doit NOMMER plutôt que laisser deviner (§55.9.3).
 */
export function comparer(avant, apres, { borne = BORNE } = {}) {
  const a = lignes(avant);
  const b = lignes(apres);
  const { ops, depasse } = aligner(a, b, borne);
  const rangs = apparier(ops, a, b);
  if (!depasse) {
    for (const rang of rangs) {
      if (rang.nature === 'modifie') {
        rang.mots = marquerMots(rang.gauche.texte, rang.droite.texte, borne);
      }
    }
  }
  const compte = {
    retirees: rangs.filter((r) => r.nature !== 'egal' && r.gauche).length,
    ajoutees: rangs.filter((r) => r.nature !== 'egal' && r.droite).length,
    identiques: rangs.filter((r) => r.nature === 'egal').length,
  };
  return {
    rangs, blocs: plier(rangs), compte, depasse,
    identique: compte.retirees === 0 && compte.ajoutees === 0,
    avantVide: a.length === 0,
    apresVide: b.length === 0,
  };
}

/** « 1 ligne retirée, 5 ajoutées, 31 identiques » — accordé, jamais « (s) ». */
export function phraseCompte({ retirees, ajoutees, identiques }) {
  const accord = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;
  return `${accord(retirees, 'ligne retirée', 'lignes retirées')}, ${
    accord(ajoutees, 'ajoutée', 'ajoutées')}, ${
    accord(identiques, 'identique', 'identiques')}`;
}

/**
 * Le libellé d'un repli : il COMPTE et SITUE ce qu'il cache
 * (`DESIGN_SYSTEM.md` §6.29). Les numéros sont ceux des deux textes quand ils
 * diffèrent — une ligne ajoutée plus haut décale la suite.
 */
export function libellePli(pli, deplie) {
  const premier = pli.rangs[0];
  const dernier = pli.rangs[pli.rangs.length - 1];
  const actuel = `${premier.gauche.numero} à ${dernier.gauche.numero}`;
  const propose = `${premier.droite.numero} à ${dernier.droite.numero}`;
  const ou = actuel === propose
    ? `lignes ${actuel}`
    : `lignes ${actuel}, ${propose} dans la version proposée`;
  return `${deplie ? 'Masquer' : 'Afficher'} ${pli.rangs.length} lignes identiques (${ou})`;
}

/** Le texte d'une ligne, ses mots changés marqués par `del` ou `ins`. */
function contenu(texte, morceaux, balise) {
  if (!morceaux) return echapper(texte);
  return morceaux.map((m) => (m.change
    ? `<${balise}>${echapper(m.texte)}</${balise}>` : echapper(m.texte))).join('');
}

// Chaque cellule est écrite en toutes lettres, classes comprises : la preuve
// `classes.test.js` ne lit que les attributs sans interpolation, et une classe
// composée à la volée échapperait au contrôle du §12.3.
//
// Le contenu d'une cellule de texte tient sur UNE ligne de source : la cellule
// est en `pre-wrap`, et un retour à la ligne du gabarit s'y peindrait.

function numeroRetire(numero) {
  return `<td class="comparaison__num comparaison__num--retire">${numero ?? ''}</td>`;
}
function numeroAjoute(numero) {
  return `<td class="comparaison__num comparaison__num--ajoute">${numero ?? ''}</td>`;
}
function texteRetire(cote, morceaux) {
  return `<td class="comparaison__texte comparaison__texte--retire"><span class="comparaison__signe" aria-hidden="true">−</span><span class="sr-only">retirée : </span>${contenu(cote.texte, morceaux, 'del')}</td>`;
}
function texteAjoute(cote, morceaux) {
  return `<td class="comparaison__texte comparaison__texte--ajoute"><span class="comparaison__signe" aria-hidden="true">+</span><span class="sr-only">ajoutée : </span>${contenu(cote.texte, morceaux, 'ins')}</td>`;
}
function numeroEgal(numero) {
  return `<td class="comparaison__num">${numero}</td>`;
}
function texteEgal(cote) {
  return `<td class="comparaison__texte"><span class="comparaison__signe" aria-hidden="true"> </span>${echapper(cote.texte)}</td>`;
}
const CASE_VIDE = '<td class="comparaison__num comparaison__vide"></td><td class="comparaison__texte comparaison__vide"></td>';

/** Une rangée de la vue en deux colonnes. */
function rangDeux(rang) {
  if (rang.nature === 'egal') {
    return `<tr>${numeroEgal(rang.gauche.numero)}${texteEgal(rang.gauche)}${
      numeroEgal(rang.droite.numero)}${texteEgal(rang.droite)}</tr>`;
  }
  const gauche = rang.gauche
    ? numeroRetire(rang.gauche.numero) + texteRetire(rang.gauche, rang.mots?.gauche)
    : CASE_VIDE;
  const droite = rang.droite
    ? numeroAjoute(rang.droite.numero) + texteAjoute(rang.droite, rang.mots?.droite)
    : CASE_VIDE;
  return `<tr>${gauche}${droite}</tr>`;
}

/**
 * Une rangée de la vue en une colonne : la ligne retirée AU-DESSUS de celle qui
 * la remplace, chacune avec ses deux numéros — celui qu'elle n'a pas reste vide.
 */
function rangUne(rang) {
  if (rang.nature === 'egal') {
    return `<tr>${numeroEgal(rang.gauche.numero)}${numeroEgal(rang.droite.numero)}${
      texteEgal(rang.droite)}</tr>`;
  }
  return (rang.gauche
    ? `<tr>${numeroRetire(rang.gauche.numero)}${numeroRetire(null)}${
      texteRetire(rang.gauche, rang.mots?.gauche)}</tr>` : '')
    + (rang.droite
      ? `<tr>${numeroAjoute(null)}${numeroAjoute(rang.droite.numero)}${
        texteAjoute(rang.droite, rang.mots?.droite)}</tr>` : '');
}

/**
 * Les blocs d'une vue. Un repli est un `tbody` qui ne porte que son bouton,
 * suivi du `tbody` des lignes qu'il cache : le bouton RESTE en place une fois
 * déplié, et devient « Masquer » — le focus ne se perd pas (§14.3).
 */
function corps(blocs, { vue, id, colonnes, deplies, rang }) {
  return blocs.map((bloc) => {
    if (bloc.type === 'rangs') return `<tbody>${bloc.rangs.map(rang).join('')}</tbody>`;
    const deplie = deplies.has(bloc.index);
    const cible = `comparaison-${echapper(id)}-${vue}-pli-${bloc.index}`;
    return `<tbody class="comparaison__pli"><tr><td colspan="${colonnes}">
        <button type="button" class="bouton bouton--compact"
          data-comparaison-pli="${bloc.index}" aria-expanded="${deplie}"
          aria-controls="${cible}"
          data-libelle-afficher="${echapper(libellePli(bloc, false))}"
          data-libelle-masquer="${echapper(libellePli(bloc, true))}">${
            echapper(libellePli(bloc, deplie))}</button></td></tr></tbody>
      <tbody id="${cible}" data-comparaison-lignes="${bloc.index}"${
        deplie ? '' : ' hidden'}>${bloc.rangs.map(rang).join('')}</tbody>`;
  }).join('');
}

/**
 * La comparaison rendue : le compte, les états nommés, puis la MÊME comparaison
 * en deux colonnes et en une. La feuille de style n'en montre qu'une selon la
 * largeur (`display: none` sur l'autre, qui la retire aussi à la synthèse
 * vocale) : sous 768 px, deux colonnes de vingt caractères ne se lisent pas, et
 * un défilement horizontal cacherait l'une des deux versions (§55.9.3).
 *
 * - `id` : un identifiant sûr pour les attributs `id` (l'identifiant de note) ;
 * - `cle` : ce qui identifie CETTE comparaison — la note, sa révision, et
 *   l'empreinte de la proposition. Les replis dépliés y sont rattachés : une
 *   autre proposition, ou un texte actuel qui a changé, se replient à neuf ;
 * - `avantAbsent` : la phrase qui nomme un texte actuel qui n'existe pas encore.
 */
export function renderComparaison({
  id, cle, sujet, avant, apres, titreAvant, titreApres,
  avantAbsent = null, deplies = new Set(),
}) {
  const modele = comparer(avant, apres);
  const compteId = `comparaison-${echapper(id)}-compte`;
  const etats = [];
  if (modele.avantVide && avantAbsent) {
    etats.push(`<p class="absence">${echapper(avantAbsent)}</p>`);
  }
  if (modele.apresVide && !modele.avantVide) {
    etats.push(`<p class="avertissement"><strong>La version proposée est vide</strong> :
      l’accepter effacerait ce texte.</p>`);
  } else if (modele.identique && !modele.avantVide) {
    etats.push(`<p class="note">La version proposée est <strong>identique</strong> au
      texte actuel : l’accepter ne changerait pas le texte.</p>`);
  }
  if (modele.depasse) {
    etats.push(`<p class="note">Les deux textes diffèrent trop pour être alignés
      ligne à ligne : le texte actuel est montré retiré en entier, et la version
      proposée ajoutée en entier.</p>`);
  }
  const titre = `${echapper(sujet)} : ${echapper(titreAvant)} et ${echapper(titreApres)}`;
  return `<div class="comparaison" data-comparaison="${echapper(id)}"
      data-comparaison-cle="${echapper(cle)}">
    <p class="comparaison__compte" id="${compteId}">${phraseCompte(modele.compte)}</p>
    ${etats.join('')}
    <table class="comparaison__table comparaison__deux" aria-describedby="${compteId}">
      <caption class="sr-only">${titre}, côte à côte</caption>
      <colgroup><col class="comparaison__col-num"><col><col class="comparaison__col-num"><col></colgroup>
      <thead><tr><th scope="col" colspan="2">${echapper(titreAvant)}</th>
        <th scope="col" colspan="2">${echapper(titreApres)}</th></tr></thead>
      ${corps(modele.blocs, { vue: 'deux', id, colonnes: 4, deplies, rang: rangDeux })}
    </table>
    <table class="comparaison__table comparaison__une" aria-describedby="${compteId}">
      <caption class="sr-only">${titre}, en une colonne</caption>
      <colgroup><col class="comparaison__col-num"><col class="comparaison__col-num"><col></colgroup>
      <thead><tr><th scope="col"><span class="sr-only">Ligne du texte actuel</span></th>
        <th scope="col"><span class="sr-only">Ligne de la version proposée</span></th>
        <th scope="col"><span aria-hidden="true">− </span>${echapper(titreAvant)}<br>
          <span aria-hidden="true">+ </span>${echapper(titreApres)}</th></tr></thead>
      ${corps(modele.blocs, { vue: 'une', id, colonnes: 3, deplies, rang: rangUne })}
    </table>
  </div>`;
}
