/**
 * @verifies docs/BACKLOG.md#SPK-43 · docs/DAT.md §37.2 (un Spark sans `sshd`),
 *           §37.4 (le contrat), §37.4.3 (la limite du redimensionnement) ·
 *           docs/DESIGN_SYSTEM_APP.md SPK-DS-04 · docs/DESIGN_SYSTEM.md §6.13
 *
 * SPK-DS-04 : l'état protégé et le chemin employé restent affichés PENDANT toute
 * la session. Les montrer à l'ouverture seulement laisserait oublier par quel
 * chemin on est entré.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderTerminal, TERMINAL_VIDE, CHAMP_TERMINAL } from './spark-terminal.js';

const SPARK = { name: 'crm', ipv4_address: '10.77.0.16', protected: 0 };
const etat = (surcharge = {}) => ({ ...TERMINAL_VIDE, ...surcharge });

test('fermé, l’écran propose d’OUVRIR et la saisie est désactivée', () => {
  const rendu = renderTerminal(SPARK);
  assert.ok(rendu.includes('Ouvrir un terminal'));
  assert.match(rendu, /id="terminal-entree"[^>]*disabled/);
});

test('pendant l’ouverture, le bouton le DIT et ne se re-clique pas', () => {
  const rendu = renderTerminal(SPARK, etat({ status: 'ouverture' }));
  assert.ok(rendu.includes('Ouverture…'));
  assert.match(rendu, /data-terminal="ouvrir"[^>]*disabled/);
});

test('ouvert, la saisie est active et la session peut se fermer', () => {
  const rendu = renderTerminal(SPARK, etat({
    status: 'ouvert', session: { id: 'a', path: 'ssh' } }));
  assert.ok(!/id="terminal-entree"[^>]*disabled/.test(rendu));
  assert.ok(rendu.includes('Fermer la session'));
});

// --- SPK-DS-04 : ce qui reste affiché PENDANT toute la session --------------

test('le CHEMIN employé est affiché en permanence, pas seulement à l’ouverture', () => {
  // RÉVISÉE le 2026-08-20, tranche 4 de SPK-43. Elle cherchait « >ssh< », le
  // JETON de l'API. Le §37.3 ajoute un second chemin, et le §14.7 interdit
  // qu'une valeur technique brute tienne lieu de libellé : la bannière NOMME
  // désormais le chemin. Ce qu'elle garde est intact — on ne doit pas oublier
  // par quel chemin on est entré —, elle le vérifie sur ce que l'écran montre.
  const rendu = renderTerminal(SPARK, etat({
    status: 'ouvert', session: { id: 'a', path: 'ssh' } }));
  assert.match(rendu, /badge--neutral[^>]*>[\s\S]*?SSH/,
    'on ne doit pas oublier par quel chemin on est entré');
});

test('un Spark PROTÉGÉ le dit pendant toute la session', () => {
  const rendu = renderTerminal({ ...SPARK, protected: 1 }, etat({ status: 'ouvert' }));
  assert.ok(rendu.includes('Spark protégé'));
  assert.ok(rendu.includes('badge--accent'), 'un gel est un accent, pas un danger');
});

test('l’écran PRÉVIENT que quitter l’onglet termine la session', () => {
  // §37.4 : une session qui survivrait à son écran serait un shell root
  // abandonné dont personne ne se souvient.
  assert.ok(renderTerminal(SPARK, etat({ status: 'ouvert' }))
    .includes('termine</strong> la session'));
});

test('le terminal ne porte AUCUN bouton d’action Docker', () => {
  // SPK-DS-04 : ces gestes appartiennent à l'onglet Docker, où ils sont nommés
  // et confirmés. Un bouton posé à côté d'un shell laisserait croire que les
  // deux font la même chose de deux façons.
  const rendu = renderTerminal(SPARK, etat({ status: 'ouvert' }));
  assert.ok(!/docker/i.test(rendu));
  assert.ok(!/démarrer|arrêter|redémarrer/i.test(rendu));
});

// --- les états à traiter (§6.13, §37.2) -------------------------------------

test('un Spark SANS cellule est nommé, pas rendu par une erreur technique', () => {
  // RÉVISÉ : la preuve parlait d'ADRESSE. Mesuré depuis, l'adresse est attribuée
  // dès l'écriture au registre (§15.1) — un Spark « pending » porte déjà la
  // sienne. Le signal est la CELLULE. Ce que la preuve établit — l'écran nomme
  // ce qui manque, et n'offre aucune saisie — est inchangé.
  const rendu = renderTerminal(SPARK, etat({
    status: 'refus',
    refus: { error: 'spark_not_reachable',
             message: 'Le Spark « neuf » n’a pas encore de cellule.' } }));
  assert.ok(rendu.includes('pas encore de cellule'));
  assert.ok(rendu.includes('doit être <strong>créé</strong>'));
  assert.ok(!rendu.includes('terminal-entree'), 'aucune saisie n’est offerte');
});

test('un refus quelconque s’affiche SANS le commentaire du Spark non créé', () => {
  const rendu = renderTerminal(SPARK, etat({
    status: 'refus', refus: { error: 'tunnel_unavailable',
                              message: 'Tunnel vers « prod » indisponible.' } }));
  assert.ok(rendu.includes('Tunnel vers'));
  assert.ok(!rendu.includes('doit être créé'));
});

test('l’avis d’inactivité s’affiche en accent, pas en danger', () => {
  // C'est un préavis, pas une panne : la session vit encore (§37.4.2).
  const rendu = renderTerminal(SPARK, etat({
    status: 'ouvert', avertissement: 'Cette session se fermera dans 60 s.' }));
  assert.ok(rendu.includes('Cette session se fermera'));
  assert.ok(rendu.includes('avertissement'));
  assert.ok(!rendu.includes('class="refus"'));
});

test('le motif de fermeture est dit en FRANÇAIS, pas en jeton technique', () => {
  // §14.7 : une valeur technique brute n'atteint pas l'écran.
  // L'écran ÉCHAPPE ce qu'il rend : une apostrophe y devient une entité. On lit
  // donc le texte décodé, sinon la preuve mesurerait l'échappement.
  const lisible = (html) => html.replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  for (const [motif, attendu] of [
    ['inactivite', "faute d'activité"],
    ['distant_termine', 'shell distant'],
    ['flux_ferme', 'connexion a été interrompue'],
  ]) {
    const rendu = lisible(renderTerminal(SPARK, etat({ fin: motif })));
    assert.ok(rendu.includes(attendu), motif);
    assert.ok(!rendu.includes(motif), `« ${motif} » ne doit pas atteindre l’écran`);
  }
});

// --- le mode lecteur d'écran (SPK-DS-04) ------------------------------------

test('le mode lecteur d’écran est ACTIVABLE et son état se voit', () => {
  const eteint = renderTerminal(SPARK, etat({ status: 'ouvert' }));
  assert.ok(eteint.includes('Mode lecteur d’écran'));
  assert.ok(!/data-terminal="lecteur"[^>]*checked/.test(eteint));

  const allume = renderTerminal(SPARK, etat({ status: 'ouvert', lecteurEcran: true }));
  assert.match(allume, /data-terminal="lecteur"[^>]*checked/);
});

test('le mode lecteur d’écran fait du terminal une région ANNONCÉE', () => {
  // Un terminal est utilisable au clavier par construction, mais il n'est pas
  // LISIBLE par défaut : sans cela, la sortie défile sans être lue.
  const allume = renderTerminal(SPARK, etat({ status: 'ouvert', lecteurEcran: true }));
  assert.match(allume, /role="log"/);
  assert.match(allume, /aria-live="polite"/);

  const eteint = renderTerminal(SPARK, etat({ status: 'ouvert' }));
  assert.match(eteint, /role="region"/);
  assert.ok(!eteint.includes('aria-live'));
});

test('la sortie a un conteneur nommé, atteignable au clavier', () => {
  const rendu = renderTerminal(SPARK, etat({ status: 'ouvert' }));
  assert.ok(rendu.includes(`id="${CHAMP_TERMINAL}"`));
  assert.match(rendu, /tabindex="0"/);
  assert.ok(rendu.includes('aria-label="Sortie du terminal"'));
});

test('la limite du redimensionnement est DITE, pas laissée à découvrir', () => {
  // §37.4.3 : « stty » ne réveille pas un programme plein écran déjà en cours.
  const rendu = renderTerminal(SPARK, etat({ status: 'ouvert' }));
  assert.ok(rendu.includes('déjà lancé'));
  assert.ok(rendu.includes('relancer'));
});

test('sans Spark, l’écran ne rend RIEN plutôt qu’un cadre vide', () => {
  assert.equal(renderTerminal(null), '');
});

// --- SPK-43, tranche 4 · LE DÉPANNAGE À L'ÉCRAN (§37.3) ---------------------

test('la bannière du dépannage NOMME le pouvoir employé, et pas « mode dégradé »', () => {
  // §37.3, troisième et quatrième conditions réunies à l'écran : ce n'est pas la
  // couleur qui dit ce qu'on a employé (§9.8), c'est le libellé.
  const rendu = renderTerminal(SPARK, etat({
    status: 'ouvert',
    session: { id: 'a', path: 'rescue', rescueReason: 'sshd_muet' } }));
  assert.match(rendu, /exécution en root dans la cellule, depuis le plan de contrôle/);
  assert.match(rendu, /badge--danger/);
  assert.ok(!/mode dégradé/i.test(rendu));
});

test('la bannière dit POURQUOI le dépannage a été ouvert, en français', () => {
  // §14.7 : « sshd_muet » est un jeton d'API, pas une phrase.
  const rendu = renderTerminal(SPARK, etat({
    status: 'ouvert',
    session: { id: 'a', path: 'rescue', rescueReason: 'sshd_muet' } }));
  assert.match(rendu, /rien ne répond sur son port 22/);
  assert.ok(!rendu.includes('sshd_muet'));
});

test('la bannière de dépannage tient APRÈS la fermeture du shell distant', () => {
  // §37.3 : « la bannière reste visible pendant toute la session ». Le motif de
  // fin ne doit pas la remplacer : c'est justement le moment où l'on oublie par
  // quel chemin on était entré.
  const rendu = renderTerminal(SPARK, etat({
    status: 'ouvert', fin: 'distant_termine',
    session: { id: 'a', path: 'rescue', rescueReason: 'spark_en_erreur' } }));
  assert.match(rendu, /exécution en root dans la cellule/);
  assert.match(rendu, /Le shell distant/);
});

test('la commande de dépannage EXISTE, et n’est pas désactivée par prudence', () => {
  // §1.4 : la fonctionnalité existe, donc la commande s'affiche. §14.9 :
  // l'écran ne sait pas si le « sshd » répond — c'est le serveur qui mesure.
  const rendu = renderTerminal(SPARK, etat({ status: 'ferme' }));
  assert.match(rendu, /data-terminal="depanner"/);
  assert.ok(!/data-terminal="depanner"[^>]*disabled/.test(rendu),
    'désactiver d’après une supposition serait une commande morte déguisée');
});

test('le dépannage se CONFIRME, et la confirmation nomme ce qui va se passer', () => {
  // §6.23 : une action sensible demande une confirmation explicite, et elle
  // nomme la conséquence. « Confirmer » ne dirait rien.
  const rendu = renderTerminal(SPARK, etat({ status: 'ferme', confirmeDepannage: true }));
  assert.match(rendu, /exécuter un shell root dans la cellule/i);
  assert.match(rendu, /« crm »/, 'la confirmation nomme l’objet visé');
  assert.match(rendu, /data-terminal="depanner-confirme"/);
  assert.match(rendu, /bouton--destructif/, 'le point d’engagement est destructif');
  assert.match(rendu, /data-terminal="depanner-annule"/);
  // §6.22 : dans le FLUX, pas dans une seconde surface.
  assert.ok(!/<dialog/.test(rendu), 'une confirmation n’a pas besoin d’une modale');
});

test('la confirmation dit que le SERVEUR tranche, pas l’écran', () => {
  const rendu = renderTerminal(SPARK, etat({ status: 'ferme', confirmeDepannage: true }));
  assert.match(rendu, /c’est le serveur qui en décide, pas cet écran/);
  assert.match(rendu, /action\s+distincte/, 'et que l’emprunt de la voie se compte');
});

test('pendant la confirmation, la commande qui l’a ouverte disparaît', () => {
  // §14.3 : un bouton qui ouvre une autre surface puis reste offert permet de
  // l'ouvrir deux fois.
  const rendu = renderTerminal(SPARK, etat({ status: 'ferme', confirmeDepannage: true }));
  assert.ok(!/data-terminal="depanner"[^-]/.test(rendu));
});

test('un dépannage REFUSÉ s’affiche DANS l’écran, sans fermer le chemin normal', () => {
  // §14.9 : le refus vient du backend et il est réel. Mais il ne doit pas
  // enfermer l'exploitant hors d'un Spark parfaitement joignable — la commande
  // d'ouverture normale reste là.
  const rendu = renderTerminal(SPARK, etat({
    status: 'ferme',
    refus: { error: 'rescue_refused', reason: 'ssh_disponible',
             message: 'Le chemin normal est disponible : le dépannage est réservé au Spark en erreur ou dont le « sshd » ne répond pas.' } }));
  assert.match(rendu, /Dépannage refusé/);
  assert.match(rendu, /role="alert"/);
  assert.match(rendu, /le dépannage est réservé/);
  assert.match(rendu, /data-terminal="ouvrir"/,
    'le chemin normal reste offert : le refus n’est pas une impasse');
});

test('un refus de dépannage n’EFFACE pas l’écran du terminal', () => {
  // Un `status: refus` plein écran ferait disparaître la sortie et la saisie —
  // exactement ce qu'on ne veut pas quand on cherche à réparer.
  const rendu = renderTerminal(SPARK, etat({
    status: 'refus',
    refus: { error: 'rescue_refused', reason: 'cle_refusee',
             message: 'Le « sshd » de ce Spark répond mais refuse la clé.' } }));
  assert.match(rendu, /id="terminal-entree"/, 'la surface du terminal survit');
  assert.match(rendu, /refuse la clé/);
});

test('un Spark sans cellule reste un refus PLEIN ÉCRAN, lui', () => {
  // Là, il n'y a réellement rien à montrer : ni chemin normal, ni dépannage.
  const rendu = renderTerminal(SPARK, etat({
    status: 'refus',
    refus: { error: 'spark_not_reachable', message: 'pas encore de cellule' } }));
  assert.ok(!rendu.includes('id="terminal-entree"'));
  assert.match(rendu, /doit être <strong>créé<\/strong>/);
});

test('la PASTILLE du chemin reste courte, le pouvoir est nommé à côté', () => {
  // MESURÉ le 2026-08-20 : une pastille est `white-space: nowrap` (§6.8), et
  // une phrase entière y débordait de sa carte sous 390 px, coupant le libellé
  // au tiers. Le §37.3 veut le chemin LISIBLE toute la session, le §8.1 interdit
  // le débordement horizontal — les deux exigent ce découpage.
  const rendu = renderTerminal(SPARK, etat({
    status: 'ouvert', session: { id: 'a', path: 'rescue', rescueReason: 'sshd_muet' } }));
  const pastille = rendu.match(/<span class="badge badge--danger">[\s\S]*?<\/span>[^<]*<\/span>/);
  assert.ok(pastille, 'la pastille existe');
  assert.ok(pastille[0].length < 160, 'et elle est courte');
  assert.ok(!pastille[0].includes('plan de contrôle'),
    'le pouvoir employé n’est pas DANS la pastille');
  // …mais il reste nommé, et en dehors d'elle.
  assert.match(rendu, /<strong>exécution en root dans la cellule, depuis le plan de contrôle<\/strong>/);
});

// --- SPK-43 · L'ÉCRAN NOMME CE QUI MANQUE (§37.2, §37.3.1) ------------------

test('un sshd MUET est nommé, avec ce qui manque et pourquoi', () => {
  // §37.2 : « l'écran le dit en toutes lettres, avec ce qu'il manque — il
  // n'affiche ni onglet vide, ni erreur technique ».
  const rendu = renderTerminal(SPARK, etat({
    status: 'ferme', fin: 'distant_termine',
    diagnostic: { motif: 'sshd_muet', ouvert: true } }));
  assert.match(rendu, /Aucun serveur SSH ne répond dans ce Spark/);
  assert.match(rendu, /L’image de base n’embarque pas/);
  assert.match(rendu, /role="alert"/, 'la panne qui ouvre un pouvoir d’exception est annoncée');
  // …et la commande qui y répond est là, juste à côté.
  assert.match(rendu, /data-terminal="depanner"/);
});

test('une clé refusée est nommée AUTREMENT, et renvoie ailleurs', () => {
  // Le point du §37.3.1 : les deux pannes se ressemblent et n'appellent pas le
  // même geste. Les dire pareil ferait employer le dépannage pour un problème
  // de clé, qu'il ne réglerait pas.
  const rendu = renderTerminal(SPARK, etat({
    status: 'ferme', fin: 'distant_termine',
    diagnostic: { motif: 'cle_refusee', ouvert: false } }));
  assert.match(rendu, /il refuse la clé/);
  assert.match(rendu, /onglet Clés/);
  assert.match(rendu, /le dépannage n’est pas la réponse/);
  assert.ok(!/Aucun serveur SSH ne répond/.test(rendu));
});

test("une clé d’hôte changée est nommée sans jamais proposer de l’accepter", () => {
  const rendu = renderTerminal(SPARK, etat({
    status: 'ferme', fin: 'distant_termine',
    diagnostic: { motif: 'cle_hote_changee', ouvert: false } }));
  assert.match(rendu, /clé d’hôte SSH de ce Spark a changé/);
  assert.match(rendu, /Aucune commande n’a été envoyée/);
  assert.match(rendu, /ne l’accepte ni ne l’efface/);
  assert.match(rendu, /role="alert"/);
});

test('un sshd qui RÉPOND ne déclenche aucune alerte', () => {
  // Une région d'alerte sur un Spark joignable userait le signal.
  const rendu = renderTerminal(SPARK, etat({
    status: 'ferme', fin: 'distant_termine',
    diagnostic: { motif: 'ssh_disponible', ouvert: false } }));
  assert.match(rendu, /Le serveur SSH de ce Spark répond/);
  assert.match(rendu, /Rouvrir devrait marcher/);
  assert.ok(!/role="alert"/.test(rendu));
});

test('la mesure EN COURS se distingue de son résultat', () => {
  // §6.13 et §14.6 : « calcul en cours » n'est ni zéro, ni un verdict.
  const rendu = renderTerminal(SPARK, etat({
    status: 'ferme', fin: 'distant_termine', diagnostic: 'en-cours' }));
  assert.match(rendu, /Vérification du serveur SSH/);
  assert.match(rendu, /aria-busy="true"/);
  assert.ok(!/Aucun serveur SSH ne répond/.test(rendu));
});

test('une mesure IMPOSSIBLE le dit, au lieu de laisser un blanc', () => {
  // §14.6 : « calcul impossible » n'est pas « tout va bien ». Un blanc, ici,
  // laisserait croire que la cause a été établie alors qu'on l'ignore.
  const rendu = renderTerminal(SPARK, etat({
    status: 'ferme', fin: 'distant_termine', diagnostic: 'impossible' }));
  assert.match(rendu, /n’a pas pu vérifier/);
  assert.match(rendu, /La cause de l’échec n’est donc pas établie/);
});

test('sans mesure demandée, l’écran n’invente aucun verdict', () => {
  const rendu = renderTerminal(SPARK, etat({ status: 'ferme', fin: 'sortie' }));
  assert.ok(!/serveur SSH/.test(rendu));
  assert.ok(!/Vérification/.test(rendu));
});

test('un motif de diagnostic INCONNU ne rend rien plutôt qu’un jeton brut', () => {
  // §14.7 : une valeur technique inconnue ne doit jamais atteindre l'écran.
  const rendu = renderTerminal(SPARK, etat({
    status: 'ferme', fin: 'distant_termine',
    diagnostic: { motif: 'quelque_chose_de_neuf', ouvert: false } }));
  assert.ok(!rendu.includes('quelque_chose_de_neuf'));
});

// --- SPK-45 tranche 2 · LE TERMINAL DANS UN CONTENEUR (§37.4.7) ------------

test('la bannière NOMME le conteneur et son shell, et le dit en toutes lettres', () => {
  // §9.8 : la couleur seule ne distingue pas. Deux conteneurs d'une même pile
  // se ressemblent, et taper la mauvaise commande dans le mauvais est l'erreur
  // que cette ligne existe pour empêcher.
  const rendu = renderTerminal(SPARK, { ...TERMINAL_VIDE, status: 'ouvert',
    session: { id: 'a', path: 'container', container: 'crm-web-1',
               shell: '/bin/bash' } });
  assert.match(rendu, /Conteneur/);
  assert.match(rendu, /pas dans le Spark/);
  assert.match(rendu, /crm-web-1/);
  assert.match(rendu, /\/bin\/bash/);
});

test('un terminal de SPARK ne parle d’aucun conteneur', () => {
  const rendu = renderTerminal(SPARK, { ...TERMINAL_VIDE, status: 'ouvert',
    session: { id: 'a', path: 'ssh', container: null, shell: null } });
  assert.match(rendu, />SSH</);
  assert.ok(!/Conteneur/.test(rendu));
});

test('un shell ABSENT est un avertissement, pas un refus rouge', () => {
  // §25.1 : le rouge est réservé au refus du serveur. Une image « distroless »
  // sans shell est un choix de sécurité du locataire, pas une panne.
  const rendu = renderTerminal(SPARK, { ...TERMINAL_VIDE, status: 'ferme',
    refus: { error: 'container_shell_unavailable', reason: 'sans_shell',
             titre: 'Ce conteneur n’a pas de shell',
             detail: 'Son image n’en embarque aucun — ni « bash », ni « sh ».' } });
  assert.match(rendu, /pas de shell/);
  assert.match(rendu, /class="avertissement"/);
  assert.ok(!/class="refus"/.test(rendu));
  // …et l'écran n'est PAS bloqué : le terminal du Spark reste offert.
  assert.match(rendu, /data-terminal="ouvrir"/);
});

test('l’aide du redimensionnement nomme la BONNE destination', () => {
  // Vue sur la capture 105 : l'écran disait « propage la taille au Spark » alors
  // qu'on était dans un conteneur. Le `stty` part au shell distant, qui est
  // celui du conteneur — dire « au Spark » désigne le mauvais destinataire.
  const conteneur = renderTerminal(SPARK, { ...TERMINAL_VIDE, status: 'ouvert',
    session: { id: 'a', path: 'container', container: 'crm-web-1',
               shell: '/bin/sh' } });
  assert.match(conteneur, /propage la taille au conteneur/);

  const spark = renderTerminal(SPARK, { ...TERMINAL_VIDE, status: 'ouvert',
    session: { id: 'a', path: 'ssh', container: null, shell: null } });
  assert.match(spark, /propage la taille au Spark/);
});
