/**
 * @verifies docs/BACKLOG.md#SPK-44 · docs/DAT.md §37.6, §37.6 bis ·
 *           docs/DESIGN_SYSTEM_APP.md SPK-DS-05 ·
 *           docs/DESIGN_SYSTEM.md §6.13, §6.14, §14.5, §14.6, §14.7, §1.4
 *
 * Ce que ces preuves gardent : **aucune absence n'est rendue par un tableau
 * vide**. Un tableau sans ligne ne dit pas si Docker manque, si son moteur est
 * muet, ou s'il n'y a simplement rien à montrer — et les trois n'appellent pas
 * le même geste.
 *
 * Depuis SPK-45, cet onglet AGIT — mais seulement sur un conteneur ouvert. La
 * liste, elle, n'offre toujours aucun geste : agir depuis une ligne de tableau,
 * c'est agir sans avoir regardé.
 *
 * RÈGLE RÉVISÉE le 2026-08-20, deuxième tranche. La preuve interdisait tout
 * `<button>`. Elle interdisait donc, sans le vouloir, le seul moyen de DEMANDER
 * une lecture — or le §37.6 ter exige précisément que l'inspection et les
 * journaux soient demandés et jamais collectés d'office, parce que les relever
 * pour dix conteneurs toutes les cinq secondes coûterait dix fois le §37.6 au
 * quota du locataire pour un texte que personne ne lit dix fois à la fois.
 *
 * Ce qui était vraiment gardé n'était pas « aucun bouton » mais « aucun geste
 * SUR le conteneur ». La preuve dit désormais cela, et l'éprouve : aucun libellé
 * de démarrage, d'arrêt, de redémarrage ou de suppression, et aucune classe
 * destructive.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderDocker, renderConteneur, DOCKER_VIDE, GESTES }
  from './spark-docker.js';

const SPARK = { name: 'helo', state: 'running', incus_name: 'helo' };
const etat = (partiel = {}) => ({ ...DOCKER_VIDE, ...partiel });

const INSPECTION = {
  name: 'helo-web-1', state: 'running', exitCode: null, image: 'nginx:alpine',
  startedAt: '2026-08-20T18:52:01Z', finishedAt: null, restarts: 0,
  networks: [{ name: 'helo_default', address: '172.18.0.2' }],
  mounts: [{ type: 'volume', source: 'helo_data',
             destination: '/var/lib/postgresql/data', mode: 'rw' }],
};

const JOURNAUX = {
  lines: [{ at: '2026-08-20T18:52:01.555868713Z', text: 'ligne 194' },
          { at: '2026-08-20T18:52:02.100000000Z', text: 'ligne 195' }],
  truncated: false, tail: 200,
};

const CONTENEUR = {
  id: 'abc', name: 'helo-web-1', state: 'running', status: 'Up 2 minutes',
  image: 'nginx:alpine', ports: '0.0.0.0:8080->80/tcp',
  cpu: '0.03%', memory: '12.3MiB / 2GiB', memoryPercent: '0.60%',
};

// --- Aucune absence n'est un tableau vide (§6.13, §14.5) --------------------

test('Docker ABSENT est nommé, et renvoie à l’amorçage', () => {
  const rendu = renderDocker(SPARK, etat({
    status: 'pret',
    releve: { state: 'docker_absent', containers: [],
              titre: 'Docker n’est pas installé dans ce Spark',
              detail: 'L’amorçage, sur l’onglet Infos, le pose.' } }));
  assert.match(rendu, /n’est pas installé/);
  assert.match(rendu, /amorçage/i);
  assert.ok(!/<table/.test(rendu), 'pas de tableau vide');
});

test('un moteur MUET est dit AUTREMENT que Docker absent', () => {
  // Les deux se confondent à l'œil — « Docker ne marche pas » — et n'appellent
  // pas le même geste : l'un s'amorce, l'autre se redémarre.
  const rendu = renderDocker(SPARK, etat({
    status: 'pret',
    releve: { state: 'moteur_muet', containers: [],
              titre: 'Docker est installé, mais son moteur ne répond pas',
              detail: 'C’est un service à redémarrer dans le Spark.' } }));
  assert.match(rendu, /moteur ne répond pas/);
  assert.match(rendu, /redémarrer/);
  assert.ok(!/n’est pas installé/.test(rendu));
});

test('zéro conteneur est présenté comme un état NORMAL', () => {
  const rendu = renderDocker(SPARK, etat({
    status: 'pret',
    releve: { state: 'sans_conteneur', containers: [],
              titre: 'Aucun conteneur',
              detail: 'C’est un état normal — une cellule fraîchement amorcée.' } }));
  assert.match(rendu, /Aucun conteneur/);
  assert.match(rendu, /état normal/);
  assert.ok(!/role="alert"/.test(rendu), 'un état normal n’est pas une alerte');
});

test('un sshd muet renvoie au Terminal, pas à Docker', () => {
  const rendu = renderDocker(SPARK, etat({
    status: 'pret',
    releve: { state: 'sshd_muet', containers: [],
              titre: 'Aucun serveur SSH ne répond dans ce Spark',
              detail: 'Sans « sshd », la console ne peut rien lire — voyez l’onglet Terminal.' } }));
  assert.match(rendu, /serveur SSH/);
  assert.match(rendu, /Terminal/);
});

test('le chargement ne se confond pas avec un Spark vide', () => {
  // §14.6 : « en cours » n'est ni zéro, ni une absence.
  const rendu = renderDocker(SPARK, etat({ status: 'chargement' }));
  assert.match(rendu, /Lecture de ce qui tourne/);
  assert.match(rendu, /aria-busy="true"/);
  assert.ok(!/Aucun conteneur/.test(rendu));
});

test('une lecture impossible est une alerte, et n’affirme rien du Spark', () => {
  const rendu = renderDocker(SPARK, etat({
    status: 'erreur', erreur: 'Aucun tunnel ouvert vers « prod ».' }));
  assert.match(rendu, /role="alert"/);
  assert.match(rendu, /Aucun tunnel/);
  assert.ok(!/Aucun conteneur/.test(rendu));
});

// --- L'inventaire, et ce qu'il écrit à côté des mesures ---------------------

test('un conteneur montre son état en français, jamais le jeton brut', () => {
  const rendu = renderDocker(SPARK, etat({
    status: 'pret', releve: { state: 'ok', containers: [CONTENEUR] } }));
  assert.match(rendu, /en marche/);
  assert.match(rendu, /badge--success/);
  assert.ok(!/>running</.test(rendu));
});

test('un conteneur ARRÊTÉ se lit comme tel', () => {
  const rendu = renderDocker(SPARK, etat({
    status: 'pret',
    releve: { state: 'ok', containers: [{ ...CONTENEUR, state: 'exited',
                                          status: 'Exited (0) 1 hour ago' }] } }));
  assert.match(rendu, /arrêté/);
  assert.match(rendu, /Exited \(0\)/);
});

test('les mesures sont écrites AVEC leur référentiel (SPK-DS-05)', () => {
  // Elles viennent de Docker à l'intérieur de la cellule et se comparent à ce
  // que la cellule voit d'elle-même, jamais aux quotas du Spark.
  const rendu = renderDocker(SPARK, etat({
    status: 'pret', releve: { state: 'ok', containers: [CONTENEUR] } }));
  assert.match(rendu, /depuis l’intérieur<\/strong> de la\s+cellule/);
  assert.match(rendu, /jamais\s+aux quotas du Spark/);
});

test('une mesure ABSENTE se dit, elle ne devient pas zéro', () => {
  // §14.6 : une mesure inventée à 0 % ferait croire à un conteneur au repos.
  const rendu = renderDocker(SPARK, etat({
    status: 'pret',
    releve: { state: 'ok',
              containers: [{ ...CONTENEUR, cpu: undefined, memory: undefined }] } }));
  assert.match(rendu, /non mesuré/);
  assert.ok(!/>0%|0\.00%/.test(rendu));
});

test('un tableau large défile dans SON conteneur (§8.1)', () => {
  const rendu = renderDocker(SPARK, etat({
    status: 'pret', releve: { state: 'ok', containers: [CONTENEUR] } }));
  assert.match(rendu, /class="table-defilante"/);
  assert.match(rendu, /<table>/);
  assert.match(rendu, /<thead>/);
});

// --- L'unité est en LECTURE (§1.4) ------------------------------------------

test('la LISTE n’offre aucun geste : ils vivent sur le conteneur ouvert', () => {
  // RÈGLE RÉVISÉE une seconde fois, le 2026-08-20, par SPK-45 — l'unité qui
  // LIVRE ces gestes. La preuve interdisait tout libellé d'action partout dans
  // l'onglet. Ce qu'elle gardait vraiment tient en deux points, et les deux
  // restent vrais :
  //
  //   1. la LISTE ne porte aucun geste. Agir depuis une ligne de tableau,
  //      c'est agir sans avoir regardé — et un clic de travers y arrête le
  //      conteneur du voisin ;
  //   2. un geste se demande sur un conteneur qu'on a OUVERT, donc dont on lit
  //      l'état, l'image et les journaux au moment où l'on décide.
  //
  // Les gestes eux-mêmes sont éprouvés plus bas, sur le conteneur ouvert.
  const interdits = /démarrer|arrêter|redémarrer|supprimer|relancer|tuer|purger/i;
  for (const cas of [
    { status: 'pret', releve: { state: 'ok', containers: [CONTENEUR] } },
    { status: 'pret', releve: { state: 'sans_conteneur', containers: [],
                                titre: 'Aucun conteneur', detail: 'x' } },
  ]) {
    const rendu = renderDocker(SPARK, etat(cas));
    const libelles = [...rendu.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)]
      .map((m) => m[1]);
    for (const libelle of libelles) {
      assert.ok(!interdits.test(libelle), `${libelle} — ${JSON.stringify(cas)}`);
    }
    assert.ok(!/bouton--destructif/.test(rendu), JSON.stringify(cas));
    assert.ok(!/data-geste=/.test(rendu), JSON.stringify(cas));
  }
});

test('le seul bouton de la LISTE demande une lecture, et nomme son conteneur', () => {
  const rendu = renderDocker(SPARK, etat({
    status: 'pret', releve: { state: 'ok', containers: [CONTENEUR] } }));
  assert.match(rendu, /data-docker="ouvrir"/);
  assert.match(rendu, /data-conteneur="helo-web-1"/);
  assert.match(rendu, /Inspecter/);
});

// --- Le conteneur ouvert (§37.6 ter) ----------------------------------------

test('un conteneur ouvert REMPLACE la liste — une surface, un sujet', () => {
  // Empiler le détail sous la liste laisserait deux sujets à l'écran, sans dire
  // lequel fait foi.
  const rendu = renderDocker(SPARK, etat({
    status: 'pret', releve: { state: 'ok', containers: [CONTENEUR] },
    ouvert: 'helo-web-1', detail: INSPECTION, journaux: JOURNAUX }));
  assert.ok(!/<table/.test(rendu), 'la liste a cédé la place');
  assert.match(rendu, /Revenir à la liste/, 'et le retour est offert');
});

test('le code de sortie ne s’affiche QUE pour un conteneur arrêté', () => {
  // §14.6 : afficher « 0 » pour un conteneur en marche ferait lire qu'il s'est
  // terminé sans erreur.
  const marche = renderConteneur(etat({ ouvert: 'web', detail: INSPECTION,
                                        journaux: JOURNAUX }));
  assert.ok(!/Code de sortie/.test(marche));

  const arrete = renderConteneur(etat({
    ouvert: 'web', journaux: JOURNAUX,
    detail: { ...INSPECTION, state: 'exited', exitCode: 137,
              finishedAt: '2026-08-20T18:52:18Z' } }));
  assert.match(arrete, /Code de sortie/);
  assert.match(arrete, /137/);
  assert.match(arrete, /arrêté/);
});

test('une liste NON LUE se dit, elle ne se rend pas « aucun »', () => {
  // §14.6 : « non lus » et « aucun » sont deux faits différents, et l'un des
  // deux ferait chercher une panne de réseau qui n'existe pas.
  const nonLues = renderConteneur(etat({
    ouvert: 'web', journaux: JOURNAUX,
    detail: { ...INSPECTION, networks: null, mounts: null } }));
  // Deux fois « non lus », une fois par liste, et sous leur propre titre.
  assert.equal((nonLues.match(/Non lus/g) ?? []).length, 2);
  assert.match(nonLues, /<h3>Réseaux<\/h3>/);
  assert.match(nonLues, /<h3>Volumes et montages<\/h3>/);

  const vides = renderConteneur(etat({
    ouvert: 'web', journaux: JOURNAUX,
    detail: { ...INSPECTION, networks: [], mounts: [] } }));
  assert.match(vides, /Aucun réseau attaché/);
  assert.match(vides, /Aucun volume monté/);
});

test('l’écran AVERTIT que les journaux viennent du locataire', () => {
  // §37.6 ter : un journal peut contenir un secret du locataire. L'exploitant
  // doit savoir qu'il lit un texte que personne n'a relu ni caviardé.
  const rendu = renderConteneur(etat({ ouvert: 'web', detail: INSPECTION,
                                       journaux: JOURNAUX }));
  assert.match(rendu, /vient du\s+locataire/);
  assert.match(rendu, /ni caviardé/);
  assert.match(rendu, /secret/);
  // Un RISQUE, pas un refus : accent, jamais rouge (docs/DAT.md §25.1).
  assert.match(rendu, /class="avertissement"/);
  assert.ok(!/class="refus"/.test(rendu));
});

test('une TRONCATURE est annoncée, et le nombre de lignes est dit sinon', () => {
  const tronque = renderConteneur(etat({
    ouvert: 'web', detail: INSPECTION,
    journaux: { ...JOURNAUX, truncated: true, tail: 200 } }));
  assert.match(tronque, /200 dernières lignes/);

  const entier = renderConteneur(etat({ ouvert: 'web', detail: INSPECTION,
                                        journaux: JOURNAUX }));
  assert.match(entier, /2 ligne\(s\)/);
  assert.ok(!/dernières lignes/.test(entier));
});

test('un conteneur qui n’a RIEN écrit le dit', () => {
  const rendu = renderConteneur(etat({
    ouvert: 'web', detail: INSPECTION,
    journaux: { lines: [], truncated: false, tail: 200 } }));
  assert.match(rendu, /n’a rien écrit/);
  assert.ok(!/<pre/.test(rendu));
});

test('un conteneur DISPARU n’est pas un REFUS, et n’affiche pas de journaux vides', () => {
  // RÈGLE RÉVISÉE le 2026-08-20, vue sur la capture : l'écran écrivait « c'est
  // un état normal, pas une panne » sur le fond ROUGE du refus. Il se
  // contredisait à l'œil avant même d'être lu. Le §25.1 réserve le rouge au
  // refus du serveur ; une course perdue est un avertissement.
  const rendu = renderConteneur(etat({
    ouvert: 'parti',
    detail: { state: 'conteneur_inconnu', titre: 'Ce conteneur a disparu',
              detail: 'Il a été supprimé depuis le dernier relevé.' },
    journaux: { state: 'conteneur_inconnu', lines: [] } }));
  assert.match(rendu, /a disparu/);
  assert.match(rendu, /class="avertissement"/);
  assert.ok(!/class="refus"|role="alert"/.test(rendu));
  assert.ok(!/rien écrit/.test(rendu), 'ne pas dire « rien écrit » d’un absent');
});

test('un conteneur disparu ENTRE l’identité et les journaux est quand même dit', () => {
  // Le cas rencontré au parcours : l'inspection avait abouti, les journaux non.
  // L'écran restait MUET et affichait une fiche complète d'un conteneur qui
  // n'existait plus (§14.5).
  const rendu = renderConteneur(etat({
    ouvert: 'web', detail: INSPECTION,
    journaux: { state: 'conteneur_inconnu', lines: [], truncated: false } }));
  assert.match(rendu, /a disparu/);
  assert.match(rendu, /class="avertissement"/);
  assert.ok(!/<pre/.test(rendu));
  assert.ok(!/rien écrit/.test(rendu));
});

test('une lecture qui a VRAIMENT échoué reste, elle, un refus', () => {
  // La nuance ne vaut que si l'autre cas garde sa couleur : un tunnel coupé
  // n'est pas une course perdue, et l'exploitant a quelque chose à y faire.
  const rendu = renderConteneur(etat({
    ouvert: 'web', journaux: 'en-cours',
    detail: { titre: 'Inspection impossible',
              detail: 'Aucun tunnel ouvert vers « validation ».' } }));
  assert.match(rendu, /class="refus"/);
  assert.match(rendu, /role="alert"/);
});

test('l’inspection en cours ne se confond pas avec un conteneur sans réseau', () => {
  const rendu = renderConteneur(etat({ ouvert: 'web', detail: 'en-cours',
                                       journaux: 'en-cours' }));
  assert.match(rendu, /aria-busy="true"/);
  assert.ok(!/Aucun réseau/.test(rendu));
  assert.ok(!/rien écrit/.test(rendu));
});

test('les journaux sont ATTEIGNABLES au clavier (§22)', () => {
  // Un <pre> qui défile sans être focusable est illisible sans souris.
  const rendu = renderConteneur(etat({ ouvert: 'web', detail: INSPECTION,
                                       journaux: JOURNAUX }));
  assert.match(rendu, /<pre class="terminal terminal--journal" tabindex="0"/);
  assert.match(rendu, /aria-label="Journaux de helo-web-1"/,
    'le libellé nomme ce que la Forge a rendu, pas ce qu’on a cliqué');
});

test('les journaux sont ÉCHAPPÉS — ils viennent d’un tiers', () => {
  const rendu = renderConteneur(etat({
    ouvert: 'web', detail: INSPECTION,
    journaux: { lines: [{ at: null, text: '<img src=x onerror=alert(1)>' }],
                truncated: false, tail: 200 } }));
  assert.ok(!/<img/.test(rendu));
  assert.match(rendu, /&lt;img/);
});

test('l’écran DIT que la collecte s’arrête quand on quitte l’onglet', () => {
  // §37.6 : le motif est que la console cesse de consommer le quota du
  // locataire. Le taire ferait croire à une lecture permanente.
  const rendu = renderDocker(SPARK, etat({
    status: 'pret', releve: { state: 'ok', containers: [CONTENEUR] } }));
  assert.match(rendu, /cinq secondes/);
  assert.match(rendu, /arrêté<\/strong> dès que vous le quittez/);
});

test('le titre est celui que la Forge a RENDU, pas celui qu’on a cliqué', () => {
  // §14.9 : la Forge fait autorité. S'ils diffèrent, c'est le nom cliqué qui
  // ment — et on ne saurait pas lequel des deux conteneurs on regarde.
  const rendu = renderConteneur(etat({
    ouvert: 'ce-qu-on-a-clique', detail: INSPECTION, journaux: JOURNAUX }));
  assert.match(rendu, /<h2 id="titre-conteneur">helo-web-1<\/h2>/);

  // Tant que l'inspection n'est pas revenue, le nom cliqué est tout ce qu'on a.
  const attente = renderConteneur(etat({ ouvert: 'helo-web-1', detail: 'en-cours',
                                         journaux: 'en-cours' }));
  assert.match(attente, /<h2 id="titre-conteneur">helo-web-1<\/h2>/);
});

test('les commandes sont EN TÊTE, avant deux cents lignes de journal', () => {
  // Un retour placé en pied oblige à traverser tout le texte pour revenir à la
  // liste — un écran dont on ne sort qu'en défilant est un écran qui retient.
  const rendu = renderConteneur(etat({ ouvert: 'web', detail: INSPECTION,
                                       journaux: JOURNAUX }));
  assert.ok(rendu.indexOf('data-docker="fermer"') < rendu.indexOf('<pre'));
  assert.ok(rendu.indexOf('data-docker="fermer"') < rendu.indexOf('<h3>Réseaux'));
});

test('la disparition est dite UNE FOIS, pas deux', () => {
  // Vue sur la capture : quand l'identité et les journaux la rapportent tous les
  // deux, l'écran affichait deux encarts identiques l'un sous l'autre. Le même
  // fait répété fait douter qu'il s'agisse du même fait.
  const rendu = renderConteneur(etat({
    ouvert: 'parti',
    detail: { state: 'conteneur_inconnu', titre: 'Ce conteneur a disparu',
              detail: 'Il n’existe plus sur ce Spark.' },
    journaux: { state: 'conteneur_inconnu', lines: [] } }));
  assert.equal((rendu.match(/a disparu/g) ?? []).length, 1);
  assert.equal((rendu.match(/class="avertissement"/g) ?? []).length, 1);
});

// --- SPK-45 · LES GESTES SUR UN CONTENEUR (§37.7) --------------------------

const SPARK_GELE = { ...SPARK, protected: true };
const ouvert = (partiel = {}) => etat({ ouvert: 'helo-web-1', detail: INSPECTION,
                                        journaux: JOURNAUX, ...partiel });

test('un conteneur EN MARCHE offre redémarrer, arrêter et tuer — pas démarrer', () => {
  // §1.4 : pas de commande morte. Démarrer ce qui tourne déjà n'apprend rien.
  const rendu = renderConteneur(ouvert(), SPARK);
  for (const attendu of ['Redémarrer', 'Arrêter', 'Tuer']) {
    assert.match(rendu, new RegExp(`>\\s*${attendu}<`), attendu);
  }
  assert.ok(!/data-geste="start"/.test(rendu));
});

test('un conteneur ARRÊTÉ n’offre que démarrer', () => {
  const rendu = renderConteneur(ouvert({
    detail: { ...INSPECTION, state: 'exited', exitCode: 0 } }), SPARK);
  assert.match(rendu, /data-geste="start"/);
  for (const absent of ['stop', 'kill', 'restart']) {
    assert.ok(!new RegExp(`data-geste="${absent}"`).test(rendu), absent);
  }
});

test('« tuer » est le SEUL bouton destructif', () => {
  // Distinguer visuellement « arrêter » de « tuer » est le seul moyen
  // d'empêcher qu'on les confonde au moment où l'on est pressé.
  const rendu = renderConteneur(ouvert(), SPARK);
  const destructifs = [...rendu.matchAll(/<button[^>]*data-geste="(\w+)"[^>]*>/g)]
    .filter((m) => m[0].includes('bouton--destructif')).map((m) => m[1]);
  assert.deepEqual(destructifs, ['kill']);
});

test('sous GEL les gestes sont PRÉSENTS, désactivés et expliqués', () => {
  // §1.4 : un bouton désactivé n'est pas une commande morte — il apprend que le
  // geste existe et pourquoi il ne part pas. Le faire disparaître laisserait
  // croire que le produit ne sait pas arrêter un conteneur.
  const rendu = renderConteneur(ouvert(), SPARK_GELE);
  assert.match(rendu, /data-geste="stop"/, 'le geste reste visible');
  const boutons = [...rendu.matchAll(/<button[^>]*data-geste="[^"]*"[^>]*>/g)];
  assert.ok(boutons.length >= 3);
  for (const b of boutons) assert.match(b[0], /disabled/);
  // Le refus NOMME la levée : un refus qui ne dit pas comment avancer se
  // contourne au jugé.
  assert.match(rendu, /Levez la protection/);
  assert.match(rendu, /Infos/);
  // …et rappelle que la lecture et le terminal restent, eux, disponibles.
  assert.match(rendu, /lecture, elle, reste entière/);
  assert.match(rendu, /terminal/);
});

test('sous gel, la LECTURE reste entière : rien n’est masqué', () => {
  // §37.7 : observer un Spark protégé reste possible. Ne griser QUE les gestes.
  const rendu = renderConteneur(ouvert(), SPARK_GELE);
  assert.match(rendu, /<pre class="terminal terminal--journal"/);
  assert.match(rendu, /helo_default/);
  assert.match(rendu, /Relire les journaux/);
  // Le bouton de relecture n'est PAS désactivé : c'est une lecture.
  const relire = /<button[^>]*data-docker="relire"[^>]*>/.exec(rendu)[0];
  assert.ok(!/disabled/.test(relire));
});

// --- La confirmation (§6.22, §6.23) ----------------------------------------

test('la confirmation NOMME le conteneur et l’effet, jamais « êtes-vous sûr »', () => {
  const rendu = renderConteneur(ouvert({ confirme: 'stop' }), SPARK);
  assert.match(rendu, /Arrêter\s+«\s*helo-web-1\s*»\s*\?/);
  assert.match(rendu, /La production servie par « helo-web-1 » s’interrompt/);
  assert.ok(!/êtes-vous sûr|Êtes-vous sûr/.test(rendu));
  // §6.22 : dans le flux, pas une modale par-dessus.
  assert.match(rendu, /class="confirmation"/);
  assert.ok(!/class="modale/.test(rendu));
  // Elle dit que le geste sera inscrit : ce n'est pas une surprise d'après-coup.
  assert.match(rendu, /inscrit au journal/);
});

test('confirmer « tuer » engage par un bouton DESTRUCTIF', () => {
  const rendu = renderConteneur(ouvert({ confirme: 'kill' }), SPARK);
  assert.match(rendu, /data-geste-confirme="kill"[^>]*/);
  const engagement = /<button[^>]*data-geste-confirme="kill"[^>]*>/.exec(rendu)[0];
  assert.match(engagement, /bouton--destructif/);
  assert.match(rendu, /IMMÉDIATEMENT/);
  assert.match(rendu, /perdu/);
  // Annuler reste offert, et n'est pas destructif.
  assert.match(rendu, /data-geste-annule/);
});

test('confirmer « arrêter » n’engage PAS par un bouton destructif', () => {
  const rendu = renderConteneur(ouvert({ confirme: 'stop' }), SPARK);
  const engagement = /<button[^>]*data-geste-confirme="stop"[^>]*>/.exec(rendu)[0];
  assert.ok(!/bouton--destructif/.test(engagement));
});

test('chaque geste décrit SON effet, et aucun ne décrit celui d’un autre', () => {
  const effets = GESTES.map((g) => g.effet('web'));
  assert.equal(new Set(effets).size, GESTES.length);
  for (const e of effets) assert.match(e, /web/);
});

// --- L'issue : jamais l'état SUPPOSÉ (§14.9) -------------------------------

test('un geste ABOUTI est vert, et il est le SEUL à l’être', () => {
  // SPK-DS-08 : sans ce troisième bloc, on aurait verdi dès que la requête
  // aboutit, ce qui aurait fait lire « c’est fait » sur un geste sans effet.
  const reussi = renderConteneur(ouvert({
    issue: { state: 'abouti', titre: 'Arrêter : c’est fait',
             detail: 'Le geste a abouti sur « helo-web-1 ».' } }), SPARK);
  assert.match(reussi, /class="succes"/);
  assert.match(reussi, /c’est fait/);

  for (const etatIssue of ['conteneur_inconnu', 'deja_arrete', 'sshd_muet']) {
    const rendu = renderConteneur(ouvert({
      issue: { state: etatIssue, titre: 't', detail: 'd' } }), SPARK);
    assert.ok(!/class="succes"/.test(rendu), etatIssue);
    assert.match(rendu, /class="avertissement"/, etatIssue);
  }
});

test('un REFUS est rouge, et lui seul', () => {
  const refus = renderConteneur(ouvert({
    issue: { state: 'echec', refus: 'protege', titre: 'Ce Spark est protégé',
             detail: 'Levez la protection.' } }), SPARK);
  assert.match(refus, /class="refus"/);
  assert.match(refus, /role="alert"/);

  const arrete = renderConteneur(ouvert({
    issue: { state: 'deja_arrete', titre: 'Ce conteneur ne tournait pas',
             detail: 'Il n’y avait rien à tuer.' } }), SPARK);
  assert.ok(!/class="refus"/.test(arrete));
});

test('un geste EN COURS ne se confond pas avec son issue', () => {
  const rendu = renderConteneur(ouvert({ enCours: 'stop' }), SPARK);
  assert.match(rendu, /aria-busy="true"/);
  assert.match(rendu, /Arrêter « helo-web-1 »…/);
  assert.ok(!/c’est fait/.test(rendu));
});

test('un journal MUET est dit à l’écran, pas tu', () => {
  // Le geste a eu lieu ; la console ne peut pas le défaire. Taire l'écart
  // laisserait croire à une trace qui n'existe pas.
  const rendu = renderConteneur(ouvert({
    issue: { state: 'abouti', titre: 'x', detail: 'y', journalise: false } }),
    SPARK);
  assert.match(rendu, /n’a pas pu\s+l’enregistrer/);

  const normal = renderConteneur(ouvert({
    issue: { state: 'abouti', titre: 'x', detail: 'y', journalise: true } }),
    SPARK);
  assert.ok(!/n’a pas pu/.test(normal));
});

test('un conteneur DISPARU n’offre aucun geste', () => {
  // §1.4 : agir sur ce qui n'existe plus n'est pas une commande, c'est un piège.
  const rendu = renderConteneur(ouvert({
    detail: { state: 'conteneur_inconnu', titre: 'Ce conteneur a disparu',
              detail: 'x' } }), SPARK);
  assert.ok(!/data-geste="/.test(rendu));
});

test('tant que l’inspection n’est pas revenue, aucun geste n’est offert', () => {
  // On ne sait pas encore si le conteneur tourne : offrir « arrêter » à un
  // conteneur déjà arrêté serait deviner.
  const rendu = renderConteneur(ouvert({ detail: 'en-cours' }), SPARK);
  assert.ok(!/data-geste="/.test(rendu));
});
