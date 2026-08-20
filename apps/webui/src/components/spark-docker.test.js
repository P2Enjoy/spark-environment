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
 * Et l'unité est en LECTURE : un bouton qui AGIRAIT sur un conteneur laisserait
 * croire que cet onglet peut le démarrer ou l'arrêter (§1.4). Ces gestes sont
 * l'objet de SPK-45.
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

import { renderDocker, renderConteneur, DOCKER_VIDE } from './spark-docker.js';

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

test('aucun geste SUR un conteneur n’est offert', () => {
  // Voir l'en-tête : la règle gardée est « pas de geste sur le conteneur », pas
  // « pas de bouton ». Démarrer, arrêter, redémarrer, supprimer sont SPK-45.
  const interdits = /démarrer|arrêter|redémarrer|supprimer|relancer|tuer|purger/i;
  for (const cas of [
    { status: 'pret', releve: { state: 'ok', containers: [CONTENEUR] } },
    { status: 'pret', releve: { state: 'sans_conteneur', containers: [],
                                titre: 'Aucun conteneur', detail: 'x' } },
    { ouvert: 'helo-web-1', detail: INSPECTION, journaux: JOURNAUX },
  ]) {
    const rendu = renderDocker(SPARK, etat(cas));
    const libelles = [...rendu.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)]
      .map((m) => m[1]);
    for (const libelle of libelles) {
      assert.ok(!interdits.test(libelle), `${libelle} — ${JSON.stringify(cas)}`);
    }
    assert.ok(!/bouton--destructif/.test(rendu), JSON.stringify(cas));
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
  assert.match(nonLues, /Réseaux : non lus/);
  assert.match(nonLues, /Montages : non lus/);

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
  assert.match(rendu, /vient du locataire/);
  assert.match(rendu, /ni caviardé/);
  assert.match(rendu, /secret/);
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

test('un conteneur DISPARU est une alerte, et n’affiche pas de journaux vides', () => {
  const rendu = renderConteneur(etat({
    ouvert: 'parti',
    detail: { state: 'conteneur_inconnu', titre: 'Ce conteneur a disparu',
              detail: 'Il a été supprimé depuis le dernier relevé.' },
    journaux: { state: 'conteneur_inconnu', lines: [] } }));
  assert.match(rendu, /role="alert"/);
  assert.match(rendu, /a disparu/);
  assert.ok(!/rien écrit/.test(rendu), 'ne pas dire « rien écrit » d’un absent');
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
  assert.match(rendu, /<pre class="terminal" tabindex="0"/);
  assert.match(rendu, /aria-label="Journaux de web"/);
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
