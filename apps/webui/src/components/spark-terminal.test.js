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
  assert.match(rendu, /bouton--danger/, 'le point d’engagement est destructif');
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
