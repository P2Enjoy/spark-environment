/**
 * La facette « Notes » d'un Spark : trois textes, et ce qu'on en propose.
 *
 * @spec docs/BACKLOG.md#SPK-104 · docs/DAT.md §54.2 (trois destinataires),
 *       §54.4 (le registre écrit, la cellule propose), §54.6 (la garde des
 *       secrets), §54.9 (la surface d'API), §54.10 (ce que la console en fait) ·
 *       docs/BACKLOG.md#SPK-105 · docs/DAT.md §55.5 (consulter ne consomme pas),
 *       §55.9 (là où le geste se conclut) ·
 *       docs/DESIGN_SYSTEM.md §6.27 (une destination, pas un encart), §14.5
 *       (l'absence se nomme), §14.6 (les états ne se confondent pas), §1.3 (pas
 *       de succès simulé), §1.5 bis (un refus n'efface pas la saisie), §6.9
 *       (champ), §9.9 (désactivé mais visible)
 *
 * **Le produit ne vérifie pas ces textes, il les transporte.** L'écran le dit en
 * toutes lettres : une note périmée est un défaut de documentation, pas un
 * défaut du produit — et c'est précisément pourquoi les faits du briefing et les
 * notes ne se mélangent jamais (§54.11).
 */

const echapper = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * L'état de la facette.
 *
 * `brouillons` garde la saisie en cours PAR NOTE : une repeinture — un refus,
 * une autre note enregistrée — ne doit pas effacer ce qu'on était en train
 * d'écrire (§1.5 bis, §14.3).
 *
 * `conflit` porte le texte courant rendu par un `409`. Il vit à côté du
 * brouillon, jamais à sa place : le §54.10 veut qu'on voie les DEUX avant de
 * trancher.
 */
export const NOTES_VIDE = {
  status: 'vide',        // 'vide' | 'chargement' | 'pret' | 'erreur'
  items: [],             // ce que rend GET /notes
  erreur: null,
  brouillons: {},        // { [id]: texte }
  busy: null,            // l'identifiant en cours d'enregistrement
  issue: null,           // { id, ok, message }
  conflit: null,         // { id, note } — le texte courant, rendu par le 409
  // SPK-105 · §55.9 : les propositions de note, lues dans la cellule. Elles
  // s'acceptent ICI, sur la facette qui porte l'objet.
  propositions: [],
  cellLue: false,
  compare: null,         // l'identifiant de la proposition dépliée
};

/** Les trois origines possibles, dites en français (§14.7). */
const ORIGINES = {
  console: 'écrite depuis la console',
  suggestion: 'écrite depuis une proposition acceptée',
};

/**
 * L'en-tête de la facette. Il dit ce que ces textes SONT avant de les montrer :
 * sans cette phrase, on les lit comme des faits relevés par le produit, et on
 * leur fait confiance au même titre qu'au briefing.
 */
function entete() {
  return `<div class="carte bloc">
    <h2>Notes de ce Spark</h2>
    <p class="note">Trois textes libres, écrits par ceux qui connaissent
    l’application. <strong>Le produit ne les vérifie pas : il les transporte.</strong>
    Ils sont posés dans la cellule sous <span class="technique">/etc/spark/notes/</span>
    et recopiés en entier dans le texte que <em>Copier pour un LLM</em> met dans
    votre presse-papier — c’est là qu’ils servent le plus.</p>
    <p class="note"><strong>N’y écrivez aucun secret.</strong> Ce texte est fait
    pour être collé dans une conversation avec un service tiers. Le produit refuse
    un texte qui porte la valeur d’un secret de ce Spark, mais il ne connaît que
    les siens.</p>
  </div>`;
}

/** La ligne d'état d'une note : trois cas, et ils ne se confondent pas (§14.6). */
function etatDe(note) {
  if (!note.written) {
    return `<p class="absence">Personne n’a encore écrit cette note.</p>`;
  }
  const origine = ORIGINES[note.origin] ?? note.origin ?? 'écrite';
  return `<p class="note">Révision ${note.revision}, ${echapper(origine)}
    ${note.updated_at
      ? `le <span class="technique">${echapper(note.updated_at)}</span>` : ''}.</p>`;
}

/**
 * La proposition en attente pour CETTE note, s'il y en a une (§55.9).
 *
 * Elle est montrée **à côté** du texte courant, jamais à sa place : accepter un
 * remplacement intégral sans voir ce qu'on remplace serait décider à l'aveugle.
 */
function proposition(note, ui) {
  const p = (ui.propositions ?? []).find((x) => x.kind === note.id && x.present);
  if (!p) return '';
  const ouvert = ui.compare === note.id;
  return `<div class="proposition" data-proposition="${echapper(note.id)}">
    <p class="avertissement" role="status"><strong>Une version est proposée depuis
    la cellule.</strong> Elle <strong>remplacerait ce texte en entier</strong>.
    Tant que vous n’avez pas tranché, elle reste en place — la lire ne l’efface pas.</p>
    <details class="repli"${ouvert ? ' open' : ''}>
      <summary>Lire la version proposée</summary>
      <pre class="fragment technique" tabindex="0"
        aria-label="Version proposée depuis la cellule">${echapper(p.body)}</pre>
    </details>
    <p class="formulaire__actions">
      <button type="button" class="bouton bouton--primaire"
        data-note-accepter="${echapper(note.id)}"
        data-sha="${echapper(p.sha256)}">Accepter cette version</button>
      <button type="button" class="bouton"
        data-note-refuser="${echapper(note.id)}"
        data-sha="${echapper(p.sha256)}">Refuser</button>
    </p>
    <p class="note">Accepter ou refuser <strong>vide le fichier</strong> dans la
    cellule : c’est ainsi que son auteur apprend qu’une décision a été prise.</p>
  </div>`;
}

/** Le refus de révision : les DEUX textes, côte à côte (§54.10). */
function conflit(note, ui) {
  if (ui.conflit?.id !== note.id) return '';
  return `<div class="refus" role="alert">
    <p><strong>Ce texte a changé depuis que vous l’avez ouvert.</strong> Rien n’a
    été écrit — votre saisie est intacte au-dessus.</p>
    <details class="repli" open>
      <summary>Ce que le registre porte aujourd’hui (révision
        ${echapper(ui.conflit.note.revision)})</summary>
      <pre class="fragment technique" tabindex="0"
        aria-label="Texte courant de la note">${echapper(ui.conflit.note.body)}</pre>
    </details>
    <p class="formulaire__actions">
      <button type="button" class="bouton" data-note-reprendre="${echapper(note.id)}"
        >Repartir de cette version</button>
    </p>
  </div>`;
}

/** Une note : ce qu'on attend d'elle, son état, sa saisie, son bouton. */
function carte(note, ui) {
  const brouillon = ui.brouillons?.[note.id];
  const valeur = brouillon === undefined ? note.body : brouillon;
  const modifie = valeur !== note.body;
  const enCours = ui.busy === note.id;
  const enConflit = ui.conflit?.id === note.id;
  // §6.11 : « deux états contradictoires ne sont jamais affichés
  // simultanément ». Le bloc de conflit PORTE déjà le refus, avec son
  // `role="alert"` et les deux textes ; répéter le message du serveur au-dessous
  // ferait lire deux fois la même mauvaise nouvelle.
  const issue = (ui.issue?.id === note.id && !enConflit) ? ui.issue : null;
  const champ = `note-${note.id}`;
  return `<section class="carte bloc note-carte" aria-labelledby="titre-${champ}">
    <h2 id="titre-${champ}" class="technique">${echapper(note.file)}</h2>
    <p class="note">${echapper(note.expected)}</p>
    <p class="note">Dans la cellule :
      <span class="technique">${echapper(note.path)}</span></p>
    ${etatDe(note)}
    ${proposition(note, ui)}
    <div class="champ">
      <label for="${champ}">Texte de la note</label>
      <textarea id="${champ}" rows="10" data-note-saisie="${echapper(note.id)}"
        spellcheck="false">${echapper(valeur)}</textarea>
    </div>
    ${conflit(note, ui)}
    ${issue
      // §1.3 : le succès ne s'affiche qu'APRÈS la réponse du serveur, et le
      // refus est un refus, pas un avertissement décoratif.
      ? `<p class="${issue.ok ? 'succes' : 'refus'}" role="${issue.ok ? 'status' : 'alert'}"
          >${echapper(issue.message)}</p>`
      : ''}
    <p class="formulaire__actions">
      <button type="button" class="bouton bouton--primaire"
        data-note-enregistrer="${echapper(note.id)}"
        data-revision="${echapper(note.revision)}"
        ${enCours || !modifie ? 'disabled' : ''}>${
          enCours ? 'Enregistrement…' : 'Enregistrer'}</button>
      ${modifie && !enCours
        ? `<button type="button" class="bouton" data-note-annuler="${echapper(note.id)}"
            >Annuler mes changements</button>`
        : ''}
    </p>
  </section>`;
}

/**
 * La facette entière.
 *
 * `cellLue` est rendu explicitement : une proposition ne peut pas s'afficher si
 * la cellule n'a pas répondu, et le taire ferait lire « aucune proposition » là
 * où la vraie réponse est « on n'a pas pu regarder » (§14.6).
 */
export function renderNotes(spark, ui = NOTES_VIDE) {
  if (ui.status === 'vide' || ui.status === 'chargement') {
    return `${entete()}<div class="carte bloc" aria-busy="true">
      <p class="absence" role="status">Lecture des notes…</p></div>`;
  }
  if (ui.status === 'erreur') {
    return `${entete()}<div class="carte bloc"><div class="refus" role="alert">
      <p>${echapper(ui.erreur || 'Les notes n’ont pas pu être lues.')}</p></div>
      <p class="formulaire__actions"><button type="button" class="bouton"
        data-notes-relire>Réessayer</button></p></div>`;
  }
  const cellule = ui.cellLue
    ? ''
    : `<div class="carte bloc"><p class="avertissement" role="status">
       <strong>La cellule n’a pas été consultée.</strong> Les textes ci-dessous
       viennent du registre, qui fait foi ; en revanche, une version proposée
       depuis la cellule ne serait pas visible ici. Un Spark arrêté ou sans
       cellule est dans ce cas.</p></div>`;
  return entete() + cellule
    + (ui.items ?? []).map((note) => carte(note, ui)).join('');
}
