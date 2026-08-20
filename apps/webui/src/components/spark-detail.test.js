/**
 * @verifies docs/BACKLOG.md#SPK-19 · docs/DAT.md §24 ·
 *           docs/DESIGN_SYSTEM.md §6.4, §6.22, §6.23, §14.5, §14.9
 *
 * Le coeur de l'unite : les commandes viennent du RUNTIME. Ces tests verifient
 * que la vue n'en invente aucune et n'en cache aucune.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderSparkDetail, renderCommands, renderDetailNotFound, renderProtection,
  renderAuteur, renderAmorcage, AMORCAGE_VIDE, COMMANDES,
} from './spark-detail.js';

const GIO = 1024 ** 3;
const SPARK = {
  name: 'crm-production', state: 'running', cpu_mode: 'shared', cpu_reservation: 0.5,
  memory_reservation_bytes: 2 * GIO, storage_bytes: 10 * GIO,
  network_burst_bps: 100_000_000, ipv4_address: '10.77.0.16', image: 'images:debian/13',
  allowed_commands: ['delete', 'restart', 'stop'], transient: false, last_error: null,
};

// --- les commandes viennent du runtime (§24.1) ------------------------------

test('seules les commandes publiees par le runtime sont rendues', () => {
  const html = renderCommands(SPARK);
  for (const attendu of ['Arrêter', 'Redémarrer', 'Supprimer'])
    assert.ok(html.includes(attendu), `${attendu} attendu`);
  // « Démarrer » n'est pas dans allowed_commands : il ne doit pas apparaitre,
  // meme desactive (§24.1).
  assert.equal(html.includes('Démarrer'), false);
  assert.equal(html.includes('disabled'), false);
});

test('la vue ne connait pas la machine a etats', () => {
  // Un etat inconnu du frontal, avec des commandes publiees : elles passent.
  const html = renderCommands({ ...SPARK, state: 'etat-futur', allowed_commands: ['delete'] });
  assert.ok(html.includes('Supprimer'));
  assert.equal(html.includes('Arrêter'), false);
});

test('un etat transitoire le DIT au lieu d afficher des boutons morts', () => {
  const html = renderCommands({ ...SPARK, state: 'creating', allowed_commands: [], transient: true });
  assert.match(html, /Une opération est en cours/);
  assert.match(html, /Aucune commande n’est acceptée/);
  assert.equal(html.includes('<button'), false);
  assert.match(html, /role="status"/);
});

test('aucune commande possible hors transitoire est dit aussi', () => {
  const html = renderCommands({ ...SPARK, allowed_commands: [], transient: false });
  assert.match(html, /Aucune commande disponible/);
});

// --- confirmations (§24.2, §6.22, §6.23) ------------------------------------

test('seule la suppression demande une confirmation', () => {
  const confirmantes = Object.entries(COMMANDES).filter(([, c]) => c.confirme).map(([n]) => n);
  assert.deepEqual(confirmantes, ['delete']);
});

test('la confirmation NOMME le Spark et la consequence', () => {
  const html = renderCommands(SPARK, { confirming: 'delete' });
  assert.match(html, /Supprimer « crm-production » \?/);
  assert.match(html, /disque et ses instantanés/);
  assert.match(html, /bouton--destructif/);
  assert.match(html, /Annuler/);
});

test('la confirmation est integree au flux, pas une modale', () => {
  const html = renderCommands(SPARK, { confirming: 'delete' });
  // Pas de voile, pas de dialog : §6.22 evite le piege de focus et l'Echap global.
  assert.equal(/role="dialog"|aria-modal|voile/.test(html), false);
  assert.match(html, /role="group"/);
});

test('sans confirmation en cours, aucun bouton destructif final', () => {
  assert.equal(renderCommands(SPARK).includes('bouton--destructif'), false);
});

// --- l identite d abord (§6.3, §24.3) ---------------------------------------

test('le nom et l etat precedent les ressources', () => {
  // Revise avec SPK-33 : la fenetre repartit ses facettes en onglets (§6.27), et
  // les instantanes ne sont plus sur l'apercu. Ce qui reste verifie — l'identite
  // avant le contenu — est le point du §24.3, et il ne change pas.
  const html = renderSparkDetail({ status: 'ready', spark: SPARK });
  assert.ok(html.indexOf('crm-production') < html.indexOf('Ressources'));
  assert.ok(html.indexOf('crm-production') < html.indexOf('Facettes'),
    'l’identite precede aussi les onglets');
});

test('les paires terme/valeur utilisent dl/dt/dd', () => {
  const html = renderSparkDetail({ status: 'ready', spark: SPARK });
  for (const balise of ['<dl', '<dt>', '<dd']) assert.ok(html.includes(balise));
});

// --- absences nommees (§6.4, §14.5) -----------------------------------------

test('une absence qui informe est NOMMEE', () => {
  // Revise avec SPK-33 : chaque absence se lit desormais dans SA facette. Une
  // surface a un sujet et un seul (§5.4, point 2).
  const rendu = (facette) => renderSparkDetail({
    status: 'ready', spark: SPARK, routes: [], keys: [], snapshots: [], facette });
  assert.match(rendu('routes'), /Aucune route publique/);
  assert.match(rendu('cles'), /Aucune clé n’est autorisée : personne ne peut s’y connecter/);
  assert.match(rendu('instantanes'), /Aucun instantané/);
});

test('une valeur absente n est simplement PAS rendue', () => {
  const html = renderSparkDetail({
    status: 'ready', spark: { ...SPARK, ipv4_address: null, image: null },
  });
  assert.equal(html.includes('Adresse privée'), false);
  assert.equal(/—<\/dd>|N\/A/.test(html), false);
});

test('les trois absences de mesure restent distinctes', () => {
  const arrete = renderSparkDetail({ status: 'ready', spark: { ...SPARK, state: 'stopped' } });
  const attente = renderSparkDetail({ status: 'ready', spark: SPARK, usage: { cpu: { used: null } } });
  assert.match(arrete, /aucune mesure d’exécution/);
  assert.match(attente, /Mesure en cours/);
});

// --- etats de la vue --------------------------------------------------------

test('chargement, erreur et introuvable sont distincts', () => {
  assert.match(renderSparkDetail({ status: 'loading' }), /squelette/);
  assert.match(renderSparkDetail({ status: 'error', error: { message: 'tunnel rompu' } }), /tunnel rompu/);
  assert.match(renderDetailNotFound(), /n’existe pas/);
});

test('la derniere erreur du Spark est montree', () => {
  const html = renderSparkDetail({
    status: 'ready', spark: { ...SPARK, state: 'error', last_error: 'image introuvable',
                              allowed_commands: ['delete', 'retry'] },
  });
  assert.match(html, /Dernière erreur : image introuvable/);
  assert.match(html, /Reprendre/);
});

test('le contenu venant du backend est echappe', () => {
  const html = renderSparkDetail({
    status: 'ready', spark: { ...SPARK, name: '<img src=x onerror=alert(1)>' },
  });
  assert.equal(/<img src=x/.test(html), false);
});

// --- journal : forme distincte (§14.8) --------------------------------------

test('un evenement de journal est une ligne, pas une carte', () => {
  const html = renderSparkDetail({
    status: 'ready', spark: SPARK,
    audit: [{ ts: '2026-08-19T10:00:00', action: 'spark.start', result: 'ok', message: 'démarré' }],
    facette: 'journal',
  });
  assert.match(html, /class="evenement"/);
  assert.equal(/class="carte"[^>]*>\s*<li/.test(html), false);
});


// --- ordre des commandes (defaut trouve en capture) -------------------------

test("l action destructive n est jamais la premiere", () => {
  // Le runtime publie allowed_commands trie alphabetiquement, ce qui placait
  // « Supprimer » en tete : l'action la plus dangereuse etait la plus
  // proeminente et la premiere atteinte au clavier.
  const html = renderCommands(SPARK);
  const positions = ['Arrêter', 'Redémarrer', 'Supprimer'].map((l) => html.indexOf(l));
  assert.equal(Math.max(...positions), html.indexOf('Supprimer'));
});

test("une action reparatrice vient en premier", () => {
  const html = renderCommands({ ...SPARK, state: 'error', allowed_commands: ['delete', 'retry'] });
  assert.ok(html.indexOf('Reprendre') < html.indexOf('Supprimer'));
});

// --- valeurs techniques traduites (§14.7) -----------------------------------

test("le resultat d audit est affiche en francais, pas en brut", () => {
  const html = renderSparkDetail({
    status: 'ready', spark: SPARK,
    audit: [{ ts: '2026-08-19T10:00', action: 'a', result: 'denied', message: 'refus' }],
    facette: 'journal',
  });
  assert.match(html, /refusé/);
  assert.equal(/>denied</.test(html), false);
});

test("un resultat inconnu ne casse pas l affichage", () => {
  const html = renderSparkDetail({
    status: 'ready', spark: SPARK,
    audit: [{ ts: '2026-08-19T10:00', action: 'a', result: 'bizarre', message: 'x' }],
    facette: 'journal',
  });
  assert.match(html, /badge--neutral/);
  assert.equal(/undefined/.test(html), false);
});


// --- la protection (SPK-34, docs/DAT.md §35) --------------------------------

const PROTEGE = { ...SPARK, protected: true, protected_at: '2026-08-19T10:00:00',
                  allowed_commands: [] };

test('un Spark protege ne montre AUCUNE commande, et dit pourquoi', () => {
  // §24.1 : le runtime ne publie plus rien. Sans le cas explicite, l'ecran
  // dirait « aucune commande dans cet etat » — la mauvaise cause.
  const html = renderCommands(PROTEGE);
  for (const absent of ['Arrêter', 'Redémarrer', 'Supprimer'])
    assert.ok(!html.includes(absent), `${absent} ne doit pas etre propose`);
  assert.match(html, /protégé/);
  assert.ok(!html.includes('dans cet état'), 'la cause nommee doit etre la protection');
});

test("la section dit son etat DANS LES DEUX SENS", () => {
  // §35.4 : un Spark desarme le dit aussi clairement, pour que l'oubli de
  // rearmement se voie.
  assert.match(renderProtection(PROTEGE), /Armée/);
  assert.match(renderProtection(SPARK), /Désarmée/);
  assert.match(renderProtection(PROTEGE), /Lever la protection/);
  assert.match(renderProtection(SPARK), /Armer la protection/);
});

test("l'ecran ne presente JAMAIS la protection comme une frontiere de securite", () => {
  // §35.1 : c'est un garde-fou. L'ecran est le premier endroit ou l'on serait
  // tente de laisser croire le contraire.
  //
  // RÉVISÉE le 2026-08-20 par SPK-56 (§1.5 bis). La preuve gardait la règle en
  // exigeant le PARAGRAPHE qui la portait. La règle n'a pas changé ; l'endroit
  // où elle est expliquée, si — le manuel M8 la disait déjà, en plus complet, et
  // une explication écrite deux fois diverge.
  //
  // Ce que l'écran garde, et que cette preuve exige toujours : le mot qui
  // QUALIFIE (« garde-fou, pas un contrôle d'accès ») et le renvoi qui mène à
  // l'explication. Le renvoi remplace le paragraphe, jamais le mot juste.
  //
  // « Retirer un accès n'est jamais bloqué » n'est pas perdu pour autant : la
  // confirmation de révocation NOMME les Sparks protégés au moment où le geste
  // se pose (§35.2, §6.23), ce que `spark-admin.test.js` garde de son côté.
  const html = renderProtection(PROTEGE);
  assert.match(html, /garde-fou/);
  assert.match(html, /pas un contrôle d’accès/);
  assert.match(html, /href="#\/manuel\/M8"/, 'le renvoi remplace le paragraphe');
  // Et l'écran ne prétend toujours nulle part être une barrière.
  assert.ok(!/sécurisé|infranchissable|interdit l’accès/i.test(html));
});

test('la section Protection ne porte plus de raisonnement (§1.5 bis)', () => {
  // Le test du §1.5 bis : une phrase qui reste vraie quand toutes les valeurs de
  // l'écran changent appartient au manuel. Celles-ci y sont parties.
  const html = renderProtection(PROTEGE);
  assert.ok(!/geste accidentel/.test(html));
  assert.ok(!/atteint le serveur atteint le registre/.test(html));
  // …mais l'ÉTAT, lui, reste : c'est une valeur, pas un raisonnement.
  assert.match(html, /Armée/);
  assert.match(html, /Toute écriture visant ce/);
});

test('la saisie du mot de passe passe par la MODALE de la section (§6.27)', () => {
  const ferme = renderProtection(PROTEGE, { open: null, values: {} });
  assert.ok(!ferme.includes('<dialog'), 'rien tant qu’on n’a rien demande');
  const ouvert = renderProtection(PROTEGE,
    { open: 'protection', values: { password: '' } });
  assert.match(ouvert, /<dialog class="modale" id="protection"/);
  assert.match(ouvert, /id="protection-titre">Protection</);
  // Le champ est de type `password` : il ne s'affiche pas en clair a l'ecran.
  assert.match(ouvert, /id="protection-mot"[^>]*type="password"/s);
  assert.match(ouvert, /data-engage="protection"[^>]*>Lever la protection</s);
});

test("l'absence de recuperation est DITE, pas laissee a decouvrir", () => {
  // §35.3 : il n'y a aucune recuperation par l'API. Le taire ferait chercher un
  // mecanisme de secours qui n'existe pas.
  const html = renderProtection(PROTEGE, { open: 'protection', values: {} });
  assert.match(html, /aucune récupération/);
});


// --- qui a produit l'entree du journal (SPK-37, docs/DAT.md §36.4) ---------

test('un evenement du RUNTIME ne se confond pas avec un geste humain', () => {
  // Les afficher pareillement laisserait croire que le second est signe par
  // quelqu'un — il ne l'est par personne.
  const machine = renderAuteur({ actor: 'sparkd', actor_class: 'runtime' });
  const humain = renderAuteur({ actor: 'console/prod', actor_class: 'human' });
  assert.match(machine, /automatique/);
  assert.ok(!machine.includes('sparkd'), 'le nom interne n’apporte rien au lecteur');
  assert.match(humain, /déclaré par console\/prod/);
});

test("l'identite est presentee comme DECLAREE, jamais comme prouvee", () => {
  // §21.6.2 : elle attribue, elle ne prouve pas. Le jour ou la signature
  // existera (SPK-40), le libelle changera — pas avant.
  const html = renderAuteur({ actor: 'console/prod', actor_class: 'human' });
  assert.match(html, /déclarée par la console/);
  assert.ok(!/signé/.test(html), 'rien ne doit laisser croire a une signature');
});

test("une identite absente le DIT, elle ne s'invente pas", () => {
  const html = renderAuteur({ actor: 'inconnu', actor_class: 'human' });
  assert.match(html, /auteur non déclaré/);
  assert.ok(!html.includes('inconnu'), 'la valeur technique ne remonte pas telle quelle');
});

test("le journal d'un Spark porte l'auteur de chaque ligne", () => {
  const html = renderSparkDetail({
    status: 'ready', spark: SPARK, facette: 'journal',
    audit: [{ ts: '2026-08-19T10:00:00', action: 'spark.create', result: 'ok',
              message: 'créé', actor: 'console/prod', actor_class: 'human' },
            { ts: '2026-08-19T10:00:01', action: 'spark.settle', result: 'ok',
              message: 'appliqué', actor: 'sparkd', actor_class: 'runtime' }],
  });
  assert.match(html, /déclaré par console\/prod/);
  assert.match(html, /automatique/);
});

// --- la traduction à l'affichage (SPK-46, docs/DAT.md §21.5 bis) -----------

test('une transition d’etats est TRADUITE dans la facette Journal d’un Spark', () => {
  // La DoD exige la preuve dans les DEUX surfaces : la traduction vit a un seul
  // endroit, mais elle doit etre BRANCHEE aux deux.
  const html = renderSparkDetail({
    status: 'ready', spark: SPARK, facette: 'journal',
    audit: [{ ts: '2026-08-20T10:00:00', action: 'spark.start', result: 'ok',
              message: '« stopped » → « starting ».' }],
  });
  assert.ok(html.includes('« Arrêté » → « Démarrage… »'));
  assert.ok(!html.includes('stopped'));
});

test('un message inconnu traverse INTACT dans la facette Journal', () => {
  const brut = '4 route(s) appliquée(s).';
  const html = renderSparkDetail({
    status: 'ready', spark: SPARK, facette: 'journal',
    audit: [{ ts: '2026-08-20T10:00:00', action: 'ingress.reconcile',
              result: 'ok', message: brut }],
  });
  assert.ok(html.includes(brut));
});

// --- SPK-54 · L'AMORÇAGE (§41, §42) -----------------------------------------

const CELLULE = { ...SPARK, name: 'helo', incus_name: 'helo', state: 'running' };
const amorcage = (partiel = {}) => ({ ...AMORCAGE_VIDE, ...partiel });

test('sans relevé, l’écran ne PRÉTEND rien sur l’état de la cellule', () => {
  // §14.6 : « pas encore relevé » n'est ni « rien à faire », ni « tout va bien ».
  const rendu = renderAmorcage(CELLULE, amorcage());
  assert.match(rendu, /n’a pas encore été relevé/);
  assert.ok(!/complète/.test(rendu));
  assert.ok(!/en place/.test(rendu));
});

test('l’écran DIT que le relevé entre dans la cellule du locataire', () => {
  // C'est ce qui justifie qu'il ne parte pas tout seul. Le taire ferait passer
  // pour gratuit un geste qui ne l'est pas.
  const rendu = renderAmorcage(CELLULE, amorcage());
  assert.match(rendu, /exécute une commande <strong>dans<\/strong> le Spark/);
  assert.match(rendu, /demandé, jamais lancé de lui-même/);
});

test('la mesure EN COURS ne se confond pas avec son résultat', () => {
  const rendu = renderAmorcage(CELLULE, amorcage({ releve: 'en-cours' }));
  assert.match(rendu, /Relevé de la cellule en cours/);
  assert.match(rendu, /aria-busy="true"/);
});

test('un docker.io de distribution s’affiche « à corriger », pas « en place »', () => {
  // LE point de l'unité (§41.2) : il est présent ET inutilisable. L'afficher
  // comme présent ferait croire le Spark prêt alors qu'aucune pile n'y tournera.
  const rendu = renderAmorcage(CELLULE, amorcage({
    releve: { complete: false, items: [
      { key: 'docker', label: 'moteur Docker', state: 'defect',
        detail: 'Docker version 26.1.5 — paquet « docker.io » de la distribution.' },
    ] } }));
  assert.match(rendu, /à corriger/);
  assert.match(rendu, /badge--danger/);
  assert.ok(!/en place/.test(rendu));
  assert.match(rendu, /docker\.io/, 'le détail nomme le paquet fautif');
});

test('les trois états ont chacun leur libellé, et jamais un jeton brut', () => {
  // §14.7 : « defect » est une valeur d'API, pas un mot d'interface.
  const rendu = renderAmorcage(CELLULE, amorcage({
    releve: { complete: false, items: [
      { key: 'sshd', label: 'serveur SSH', state: 'present', detail: 'active' },
      { key: 'depot', label: 'dépôt Docker amont', state: 'absent', detail: 'absent' },
      { key: 'docker', label: 'moteur Docker', state: 'defect', detail: 'x' },
    ] } }));
  assert.match(rendu, /en place/);
  assert.match(rendu, /absent/);
  assert.match(rendu, /à corriger/);
  // « present » et « defect » sont des jetons d'API et ne doivent pas paraître.
  // « absent » est exclu de ce contrôle À DESSEIN : c'est aussi le mot français
  // juste, et le jeton coïncide avec le libellé. Le chercher ferait échouer la
  // preuve sur une bonne traduction.
  for (const jeton of ['>present<', '>defect<']) {
    assert.ok(!rendu.includes(jeton), jeton);
  }
});

test('une cellule COMPLÈTE le dit, et dit ce que cela veut dire', () => {
  const rendu = renderAmorcage(CELLULE, amorcage({
    releve: { complete: true, items: [
      { key: 'sshd', label: 'serveur SSH', state: 'present', detail: 'active' },
    ] } }));
  assert.match(rendu, /joignable\s+en SSH et capable de faire tourner une pile Compose/);
});

test('un amorçage qui ne change RIEN le dit en toutes lettres', () => {
  // §42.1 : c'est là qu'un geste bavard casserait la production du locataire.
  const rendu = renderAmorcage(CELLULE, amorcage({
    resultat: { changed: false, complete: true, items: [
      { key: 'sshd', label: 'serveur SSH', state: 'present',
        detail: 'active', action: 'aucune', outcome: 'inchangé' },
    ] } }));
  assert.match(rendu, /Rien n’a été fait : tout était déjà en place/);
  assert.match(rendu, /inchangé/);
});

test('le compte rendu rend le sort de CHAQUE ligne, jamais un verdict global', () => {
  const rendu = renderAmorcage(CELLULE, amorcage({
    resultat: { changed: true, complete: true, items: [
      { key: 'sshd', label: 'serveur SSH', state: 'present',
        detail: 'active', action: 'aucune', outcome: 'inchangé' },
      { key: 'docker', label: 'moteur Docker', state: 'present',
        detail: 'Docker version 29.7.2', action: 'amorcé', outcome: 'installé' },
    ] } }));
  assert.match(rendu, /serveur SSH/);
  assert.match(rendu, /inchangé/);
  assert.match(rendu, /moteur Docker/);
  assert.match(rendu, /installé/);
});

test('une ligne ÉCHOUÉE se voit, et n’est pas noyée dans un succès', () => {
  const rendu = renderAmorcage(CELLULE, amorcage({
    resultat: { changed: true, complete: false, items: [
      { key: 'docker', label: 'moteur Docker', state: 'absent',
        detail: 'absent', action: 'amorcé', outcome: 'échoué' },
    ] } }));
  assert.match(rendu, /échoué/);
  assert.match(rendu, /badge--danger/);
  assert.ok(!/Cette cellule est complète/.test(rendu));
});

test('l’amorçage se CONFIRME, et la confirmation nomme le pouvoir employé', () => {
  // §6.23 et §42.3. « Confirmer » ne dirait rien de ce qui va se passer.
  const rendu = renderAmorcage(CELLULE, amorcage({ confirme: true }));
  assert.match(rendu, /exécuter des commandes en root dans la\s+cellule/);
  assert.match(rendu, /sans passer par SSH/);
  assert.match(rendu, /« helo »/, 'elle nomme l’objet visé');
  assert.match(rendu, /bouton--destructif/);
  assert.match(rendu, /data-amorcage="annuler"/);
  // §6.22 : dans le flux, pas dans une seconde surface.
  assert.ok(!/<dialog/.test(rendu));
});

test('la confirmation dit que seuls les MANQUES sont installés', () => {
  // RÉVISÉE le 2026-08-20 par SPK-56 (§1.5 bis). La preuve exigeait aussi le
  // « pourquoi » — réinstaller au cas où redémarrerait le moteur Docker. Cette
  // phrase reste vraie quel que soit le relevé : c'est du raisonnement, et il
  // est au manuel M6.
  //
  // Ce que la confirmation doit dire pour qu'on décide reste : ce qu'elle va
  // FAIRE, et qu'elle ne touche pas à ce qui est en place.
  const rendu = renderAmorcage(CELLULE, amorcage({ confirme: true }));
  assert.match(rendu, /Seuls les éléments manquants sont installés/);
  assert.match(rendu, /déjà en place n’est pas touché/);
  assert.match(rendu, /exécuter des commandes en root/);
});

test('pendant la confirmation, la commande qui l’a ouverte disparaît', () => {
  // §14.3 : sinon on l'ouvre deux fois.
  const rendu = renderAmorcage(CELLULE, amorcage({ confirme: true }));
  assert.ok(!/data-amorcage="amorcer"/.test(rendu));
  assert.match(rendu, /data-amorcage="relever"/, 'relever reste possible');
});

test('un Spark SANS CELLULE nomme ce qui manque au lieu d’offrir le geste', () => {
  // §1.4 : une commande qui sera refusée à coup sûr est une commande morte.
  const rendu = renderAmorcage({ ...SPARK, incus_name: null }, amorcage());
  assert.match(rendu, /n’a pas encore de cellule/);
  assert.ok(!/data-amorcage="amorcer"/.test(rendu));
  assert.ok(!/data-amorcage="relever"/.test(rendu));
});

test('un refus du serveur s’affiche, avec le motif qu’il a NOMMÉ', () => {
  const rendu = renderAmorcage(CELLULE, amorcage({
    erreur: '« helo » est protégé : bootstrap y est refusée.' }));
  assert.match(rendu, /est protégé/);
  assert.match(rendu, /role="alert"/);
});

test('la section vit sur la facette d’identité, avec les accès', () => {
  const rendu = renderSparkDetail({ status: 'ready', spark: CELLULE, facette: '' });
  assert.match(rendu, /id="titre-amorcage"/);
  assert.match(rendu, /id="titre-acces"/);
});

test('une absence est nommée UNE fois, pas deux sur la même ligne', () => {
  // §14.5 : le runtime rend « absent » comme détail d'un élément absent, et la
  // pastille le dit déjà. Trouvé en observant `docs/manuel/images/m6-amorcage.png`.
  const rendu = renderAmorcage(CELLULE, amorcage({
    releve: { complete: false, items: [
      { key: 'depot', label: 'dépôt Docker amont', state: 'absent', detail: 'absent' },
    ] } }));
  assert.equal((rendu.match(/absent/g) ?? []).length, 1);
  // …mais un détail qui APPREND quelque chose reste affiché.
  const utile = renderAmorcage(CELLULE, amorcage({
    releve: { complete: false, items: [
      { key: 'sshd', label: 'serveur SSH', state: 'present', detail: 'active' },
    ] } }));
  assert.match(utile, /active/);
});

// --- SPK-54 · LE MODE ROOTLESS À L'ÉCRAN (§42.2, §42.2 bis) -----------------

test('l’option rootless est OFFERTE, et décochée par défaut', () => {
  // §42.2 : « enraciné, avec le rootless offert à qui le demande ». Annoncer
  // l'inverse ferait échouer la promesse centrale du produit sur la moitié des
  // piles Compose existantes.
  const rendu = renderAmorcage(CELLULE, amorcage({ confirme: true }));
  assert.match(rendu, /data-amorcage="rootless"/);
  assert.ok(!/data-amorcage="rootless"[^>]*checked/.test(rendu));
});

test('l’option ÉNONCE ses trois coûts, elle ne se vend pas', () => {
  // Ces trois coûts RESTENT à l'écran, et le §1.5 bis ne les en chasse pas :
  // ils sont la CONSÉQUENCE d'une action sensible et irréversible, et le §6.23
  // exige qu'une confirmation nomme sa conséquence. Le §1.5 bis vise le
  // raisonnement de fond, pas ce qu'une confirmation doit dire pour décider.
  //
  // Ce qui EST parti au manuel (M6, « Le mode rootless »), c'est l'argumentation
  // qui accompagnait chacun : pourquoi reprendre une pile sans la réécrire est
  // ce que le produit vend, pourquoi la seconde couche n'est pas la première.
  const rendu = renderAmorcage(CELLULE, amorcage({ confirme: true }));
  assert.match(rendu, /ports sous 1024/);
  assert.match(rendu, /ne fonctionnent pas telles quelles/);
  assert.match(rendu, /déjà<\/strong> non privilégiée sur la Forge/);
  assert.match(rendu, /ne se reprend\s+pas/, 'l’irréversibilité est dite');
  assert.match(rendu, /href="#\/manuel\/M6"/, 'et le reste est au manuel');
  // …et jamais un argument de vente.
  assert.ok(!/plus sûr|recommandé|conseillé/i.test(rendu));
});

test('quand un mode est DÉJÀ en place, l’option n’est plus offerte', () => {
  // §1.4 : offrir un geste que le serveur refusera à coup sûr est une commande
  // morte. Ce n'est pas le §14.9 : l'écran ne le SUPPOSE pas, il le tient du
  // relevé que le serveur vient de rendre.
  const rendu = renderAmorcage(CELLULE, amorcage({
    confirme: true,
    releve: { complete: true, items: [
      { key: 'docker', label: 'moteur Docker', state: 'present',
        detail: 'Docker version 29.7.2', mode: 'enracine' },
    ] } }));
  assert.ok(!/data-amorcage="rootless"/.test(rendu));
  assert.match(rendu, /fait déjà tourner un Docker/);
  assert.match(rendu, /enraciné/);
  assert.match(rendu, /basculer déplacerait le moteur sous un autre\s+compte/i);
});

test('le mode observé s’affiche sur la ligne Docker, en français', () => {
  const rendu = renderAmorcage(CELLULE, amorcage({
    releve: { complete: true, items: [
      { key: 'docker', label: 'moteur Docker', state: 'present',
        detail: 'Docker version 29.7.2', mode: 'rootless' },
    ] } }));
  assert.match(rendu, />rootless</);
  assert.ok(!rendu.includes('enracine'), 'le jeton brut ne paraît pas');
});

test('un Docker sans mode n’affiche aucun mode', () => {
  // §42.2 bis : un Docker absent ou de distribution n'en a pas, et lui en prêter
  // un ferait croire à un choix là où rien ne tourne.
  const rendu = renderAmorcage(CELLULE, amorcage({
    releve: { complete: false, items: [
      { key: 'docker', label: 'moteur Docker', state: 'defect',
        detail: 'paquet « docker.io » de la distribution', mode: null },
    ] } }));
  assert.ok(!/enraciné|rootless/.test(rendu));
});

test('la section Ressources NOMME ses valeurs et renvoie pour le reste (§1.5 bis)', () => {
  // Les valeurs sont déjà QUALIFIÉES — « réservés », « au plus », « Plafond
  // réseau » —, donc le mot juste est à l'écran. Le paragraphe qui expliquait
  // ce qu'est un droit d'ordonnancement restait vrai quand toutes les valeurs
  // changent : il est au manuel M5, qui le disait déjà en plus complet.
  // Éprouvé par la SURFACE réelle, pas par une fonction interne exportée pour
  // l'occasion : c'est ce que l'exploitant lit qui doit tenir.
  const html = renderSparkDetail({ status: 'ready', spark: SPARK });
  assert.match(html, /CPU réservés/, 'la valeur porte son qualificatif');
  assert.match(html, /Plafond réseau/);
  assert.ok(!/droit d’ordonnancement/.test(html));
  assert.ok(!/consommer davantage quand la machine est libre/.test(html));
  // Le fait qui NE se déduit d'aucune valeur affichée reste, lui, à l'écran.
  assert.match(html, /Seul le plafond réseau est appliqué par le noyau/);
  assert.match(html, /href="#\/manuel\/M5"/);
});
