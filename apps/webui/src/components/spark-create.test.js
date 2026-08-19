/**
 * @verifies docs/BACKLOG.md#SPK-20 · docs/DAT.md §25 ·
 *           docs/DESIGN_SYSTEM.md §6.9, §7.1, §14.9
 *
 * Le coeur de l'unite : l'ecran MONTRE la capacite restante et ne DECIDE
 * jamais a la place de sparkd.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderSparkCreate, validateShape, estimate, demandOf, describeShortfall, DEFAUTS,
} from './spark-create.js';

const GIO = 1024 ** 3;
const POOLS = {
  cpu: { capacity: 4, available: 1 },
  memory: { capacity: 76 * GIO, available: 4 * GIO },
  storage: { capacity: 190 * GIO, available: 20 * GIO },
  network: { capacity: 1e9, available: 5e8 },
};

// --- le bouton n'est JAMAIS desactive par l'estimation (§25.1) --------------

test('une demande trop grande n empeche PAS de soumettre', () => {
  // La capacite affichee est une photographie : bloquer dessus refuserait une
  // creation que le serveur aurait acceptee (docs/DAT.md §25.1).
  const html = renderSparkCreate({
    values: { ...DEFAUTS, name: 'trop', memory_gib: 999 }, pools: POOLS,
  });
  assert.match(html, /Créer le Spark/);
  assert.equal(/<button type="submit"[^>]*disabled/.test(html), false);
});

test('elle est signalee comme un RISQUE, pas comme un refus', () => {
  const html = renderSparkCreate({
    values: { ...DEFAUTS, name: 'trop', memory_gib: 999 }, pools: POOLS,
  });
  assert.match(html, /class="avertissement"/);
  assert.match(html, /pourrait manquer|pourraient manquer/);
  assert.match(html, /c’est le serveur qui décide/);
  // accent, jamais danger : le refus rouge est reserve a sparkd.
  assert.equal(/class="refus"/.test(html), false);
});

test('le bouton n est desactive que pendant l envoi', () => {
  const html = renderSparkCreate({ values: { ...DEFAUTS, name: 'ok' }, submitting: true });
  assert.match(html, /disabled/);
  assert.match(html, /Création…/);
});

// --- estimation -------------------------------------------------------------

test('l estimation nomme chaque ressource qui risque de manquer', () => {
  const risques = estimate({ ...DEFAUTS, memory_gib: 999, storage_gib: 999 }, POOLS);
  assert.deepEqual(risques.map((r) => r.resource), ['mémoire', 'disque']);
});

test('une demande qui tient ne declenche aucun avertissement', () => {
  assert.deepEqual(estimate({ ...DEFAUTS, name: 'ok' }, POOLS), []);
  assert.equal(/class="avertissement"/.test(
    renderSparkCreate({ values: { ...DEFAUTS, name: 'ok' }, pools: POOLS })), false);
});

test('sans capacite connue, aucune estimation n est inventee', () => {
  assert.deepEqual(estimate(DEFAUTS, null), []);
  assert.match(renderSparkCreate({ pools: null }), /Capacité de l’hôte inconnue/);
});

test('un mode dedie ne consomme pas de reservation mais des coeurs', () => {
  const d = demandOf({ ...DEFAUTS, cpu_mode: 'dedicated', cpu_cores: 2 });
  assert.equal(d.cpu, 0);
  assert.equal(d.cores, 2);
});

test('un mode plafonne consomme son plafond', () => {
  assert.equal(demandOf({ ...DEFAUTS, cpu_mode: 'capped', cpu_max: 1.5 }).cpu, 1.5);
});

// --- controles LOCAUX : la forme, jamais la capacite (§25.3) ----------------

test('un nom mal forme est signale tout de suite', () => {
  assert.match(validateShape({ ...DEFAUTS, name: 'Majuscule' }).name, /Minuscules/);
  assert.match(validateShape({ ...DEFAUTS, name: '' }).name, /Requis/);
});

test('la coherence du mode CPU est verifiee localement', () => {
  assert.ok(validateShape({ ...DEFAUTS, cpu_mode: 'capped', cpu_max: 0 }).cpu_max);
  assert.ok(validateShape({ ...DEFAUTS, cpu_mode: 'dedicated', cpu_cores: 0 }).cpu_cores);
  assert.ok(validateShape({ ...DEFAUTS, cpu_mode: 'shared', cpu_reservation: 0 }).cpu_reservation);
});

test('aucun controle local ne porte sur la CAPACITE', () => {
  // Une demande enorme mais bien formee ne produit AUCUNE erreur locale.
  const erreurs = validateShape({ ...DEFAUTS, name: 'ok', memory_gib: 99999, storage_gib: 99999 });
  assert.deepEqual(erreurs, {});
});

test('une erreur de champ est associee au controle', () => {
  const html = renderSparkCreate({ values: DEFAUTS, errors: validateShape(DEFAUTS) });
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /aria-describedby="name-aide name-erreur"/);
  assert.match(html, /role="alert"/);
});

test('une contrainte explique son origine, pas un asterisque', () => {
  const html = renderSparkCreate({ values: DEFAUTS, errors: validateShape(DEFAUTS) });
  assert.match(html, /Requis pour créer un Spark/);
  assert.equal(/\*<\/label>/.test(html), false);
});

// --- refus du serveur (§7.1, §25.2) -----------------------------------------

test('le refus de sparkd est rendu avec ce qui manque', () => {
  const html = renderSparkCreate({
    values: { ...DEFAUTS, name: 'trop' },
    refusal: { shortfalls: [{ resource: 'cpu', missing: 5.5 }] },
  });
  assert.match(html, /class="refus"/);
  assert.match(html, /Le serveur a refusé/);
  assert.match(html, /processeur : il manque 5,50 CPU/);
  assert.match(html, /role="alert"/);
});

test("le manque est FORMATE, pas rendu en octets bruts", () => {
  // docs/DESIGN_SYSTEM.md §14.7 : une valeur technique brute ne doit pas
  // atteindre l'ecran. « 64424509440 » ne se lit pas.
  assert.equal(describeShortfall({ resource: 'memory', missing: 64424509440 }),
               'mémoire : il manque 60 Gio');
  assert.equal(describeShortfall({ resource: 'network', missing: 5e8 }),
               'réseau : il manque 500 Mbit/s');
});

test("un nom de ressource inconnu ne casse pas l affichage", () => {
  assert.match(describeShortfall({ resource: 'exotique', missing: 3 }), /exotique : il manque 3/);
});

test("l avertissement estime disparait quand le serveur a tranche", () => {
  // Deux messages disant la meme chose, dont un moins fiable, est du bruit.
  const html = renderSparkCreate({
    values: { ...DEFAUTS, name: 'trop', memory_gib: 999 }, pools: POOLS,
    refusal: { shortfalls: [{ resource: 'memory', missing: 1e9 }] },
  });
  assert.match(html, /class="refus"/);
  assert.equal(/class="avertissement"/.test(html), false);
});

test('un refus CONSERVE la saisie', () => {
  // Perdre dix champs pour 2 Gio de trop pousserait a demander moins que
  // necessaire (docs/DAT.md §25.2).
  const html = renderSparkCreate({
    values: { ...DEFAUTS, name: 'mon-spark', memory_gib: 64, storage_gib: 500 },
    refusal: { message: 'refusé', shortfalls: [] },
  });
  assert.match(html, /value="mon-spark"/);
  assert.match(html, /value="64"/);
  assert.match(html, /value="500"/);
});

// --- champs selon le mode ---------------------------------------------------

test('les champs suivent le mode choisi', () => {
  const partage = renderSparkCreate({ values: { ...DEFAUTS, cpu_mode: 'shared' } });
  assert.match(partage, /id="cpu_reservation"/);
  assert.equal(/id="cpu_max"/.test(partage), false);

  const plafonne = renderSparkCreate({ values: { ...DEFAUTS, cpu_mode: 'capped' } });
  assert.match(plafonne, /id="cpu_max"/);
  assert.equal(/id="cpu_reservation"/.test(plafonne), false);

  const dedie = renderSparkCreate({ values: { ...DEFAUTS, cpu_mode: 'dedicated' } });
  assert.match(dedie, /id="cpu_cores"/);
});

test('le contenu saisi est echappe', () => {
  const html = renderSparkCreate({ values: { ...DEFAUTS, name: '"><script>x</script>' } });
  assert.equal(/<script>x/.test(html), false);
});
