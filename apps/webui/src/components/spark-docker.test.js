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
 * Et l'unité est en LECTURE : un bouton posé ici laisserait croire que cet
 * onglet peut agir (§1.4). Les gestes sont l'objet de SPK-45.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderDocker, DOCKER_VIDE } from './spark-docker.js';

const SPARK = { name: 'helo', state: 'running', incus_name: 'helo' };
const etat = (partiel = {}) => ({ ...DOCKER_VIDE, ...partiel });

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

test('aucun bouton d’action n’est offert', () => {
  // SPK-44 est en lecture ; les gestes sont SPK-45. Un bouton ici laisserait
  // croire que cet onglet peut agir.
  for (const cas of [
    { status: 'pret', releve: { state: 'ok', containers: [CONTENEUR] } },
    { status: 'pret', releve: { state: 'sans_conteneur', containers: [],
                                titre: 'Aucun conteneur', detail: 'x' } },
  ]) {
    const rendu = renderDocker(SPARK, etat(cas));
    assert.ok(!/<button/.test(rendu), JSON.stringify(cas));
  }
});

test('l’écran DIT que la collecte s’arrête quand on quitte l’onglet', () => {
  // §37.6 : le motif est que la console cesse de consommer le quota du
  // locataire. Le taire ferait croire à une lecture permanente.
  const rendu = renderDocker(SPARK, etat({
    status: 'pret', releve: { state: 'ok', containers: [CONTENEUR] } }));
  assert.match(rendu, /cinq secondes/);
  assert.match(rendu, /arrêté<\/strong> dès que vous le quittez/);
});
