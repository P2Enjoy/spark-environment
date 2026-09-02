/**
 * @verifies docs/BACKLOG.md#SPK-20 · docs/DAT.md §25 ·
 *           docs/DESIGN_SYSTEM.md §6.9, §7.1, §14.9
 * @verifies docs/BACKLOG.md#SPK-59 · docs/DESIGN_SYSTEM.md §6.9 bis ·
 *           docs/DESIGN_SYSTEM_APP.md SPK-DS-07 — pour la section « curseur ».
 *
 * Le coeur de l'unite : l'ecran MONTRE la capacite restante et ne DECIDE
 * jamais a la place de sparkd.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderSparkCreate, validateShape, estimate, demandOf, describeShortfall, DEFAUTS, renderChoixImage,
  borneHaute, formatQuota, renderAvertissement, QUOTAS, CRANS_MAX,
} from './spark-create.js';
import { formatBytes } from './tokens.js';

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
  assert.match(renderSparkCreate({ pools: null }), /Capacité de la Forge inconnue/);
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

// --- l'image se choisit dans une LISTE (docs/DAT.md §33.5) ------------------

test("le champ Image n'est plus une saisie libre", () => {
  // Une saisie libre pouvait produire une reference inexistante, dont le refus
  // n'arrivait qu'a l'application — apres que la ligne eut ete ecrite et la
  // ressource comptee.
  const rendu = renderSparkCreate({ images: [
    { reference: 'images:debian/13', label: 'Debian 13', is_default: 1, state: 'verified' },
  ] });
  assert.ok(!/<input[^>]*id="image"/.test(rendu), 'plus de champ texte');
  assert.ok(/<select[^>]*id="image"/.test(rendu));
});

test('la liste montre le libelle ET la reference', () => {
  const rendu = renderChoixImage('images:debian/13', [
    { reference: 'images:debian/13', label: 'Debian 13 « trixie »', is_default: 1 },
  ]);
  assert.ok(rendu.includes('Debian 13 « trixie »'));
  assert.ok(rendu.includes('images:debian/13'));
});

test('la valeur courante est preselectionnee', () => {
  const rendu = renderChoixImage('images:debian/12', [
    { reference: 'images:debian/13', label: 'Debian 13', is_default: 1 },
    { reference: 'images:debian/12', label: 'Debian 12', is_default: 0 },
  ]);
  assert.match(rendu, /value="images:debian\/12" selected/);
  assert.ok(!/value="images:debian\/13" selected/.test(rendu));
});

test('un catalogue vide NOMME son absence et ne laisse pas choisir', () => {
  // §14.6 : un catalogue vide n'est pas un catalogue qu'on ignore — c'est un
  // releve qui n'a pas eu lieu.
  const rendu = renderChoixImage('images:debian/13', []);
  assert.ok(rendu.includes('Relever le catalogue'));
  assert.ok(rendu.includes('disabled'));
  assert.ok(!/<option value=/.test(rendu), 'aucune option proposable');
});

test("l'aide dit d'ou vient la liste", () => {
  const rendu = renderChoixImage('images:debian/13', [
    { reference: 'images:debian/13', label: 'Debian 13', is_default: 1 },
  ]);
  assert.ok(rendu.includes('dernier relevé du catalogue'));
});

test('les valeurs du catalogue sont echappees', () => {
  const rendu = renderChoixImage('x', [
    { reference: '<script>x</script>', label: '<img onerror=1>', is_default: 0 },
  ]);
  assert.ok(!rendu.includes('<script>'));
  assert.ok(!rendu.includes('<img onerror'));
});

// --- LE CURSEUR (SPK-59, DESIGN_SYSTEM.md §6.9 bis) -------------------------

const CONTEXTE = { pools: POOLS, cores: 4 };

test('un quota se regle au CURSEUR des que la capacite est connue', () => {
  const html = renderSparkCreate({ values: { ...DEFAUTS, name: 'ok' }, ...CONTEXTE });
  assert.match(html, /<input type="range"[^>]*id="memory_gib"/);
  assert.match(html, /<input type="range"[^>]*id="storage_gib"/);
  assert.match(html, /<input type="range"[^>]*id="network_mbit"/);
  assert.match(html, /<input type="range"[^>]*id="cpu_reservation"/);
});

test('la borne haute est la CAPACITE, jamais le disponible', () => {
  // C'est le point qui decide de l'unite. Borner sur le disponible ferait
  // decider l'ecran a la place de sparkd (docs/DAT.md §25.1) et rendrait le
  // refus d'admission inatteignable depuis le parcours canonique.
  assert.equal(borneHaute('memory_gib', CONTEXTE), 76);   // capacite, pas les 4 libres
  assert.equal(borneHaute('storage_gib', CONTEXTE), 190); // capacite, pas les 20 libres
  assert.equal(borneHaute('network_mbit', CONTEXTE), 1000);
  assert.equal(borneHaute('cpu_reservation', CONTEXTE), 4);
});

test('le curseur laisse donc demander plus que ce qui reste libre', () => {
  const html = renderSparkCreate({ values: { ...DEFAUTS, name: 'ok' }, ...CONTEXTE });
  const max = /id="memory_gib"[^>]*max="(\d+)"/.exec(html);
  assert.ok(max, 'le curseur porte une borne haute');
  assert.ok(Number(max[1]) * 1024 ** 3 > POOLS.memory.available,
    'sans cela, un refus du serveur ne serait plus atteignable par l’ecran');
});

test('les coeurs sont bornes par les coeurs PHYSIQUES, pas par le pool CPU', () => {
  // Le pool CPU compte des parts ; un cœur n'est pas une part.
  assert.equal(borneHaute('cpu_cores', CONTEXTE), 4);
  assert.equal(borneHaute('cpu_cores', { pools: POOLS, cores: null }), null);
});

test('sans capacite connue, le quota redevient une SAISIE', () => {
  // §6.9 bis condition 1 : pas de bornes, pas de curseur. L'ecran n'invente
  // pas une borne pour garder le curseur.
  const html = renderSparkCreate({ values: { ...DEFAUTS, name: 'ok' }, pools: null });
  assert.equal(/<input type="range"/.test(html), false);
  assert.match(html, /<input type="number"[^>]*id="memory_gib"/);
  assert.equal(borneHaute('memory_gib', { pools: null }), null);
});

test('une plage trop longue pour un pointeur redevient une SAISIE', () => {
  // §6.9 bis condition 2 et 3, mesurees sur la Forge de validation : deux
  // disques de 6 To en RAID1 donnent plus de 5 000 Gio. Au pas de 1 Gio le
  // curseur compterait cinq mille crans ; le pas qui les ramenerait sous 400
  // rendrait le quota courant de 10 Gio inatteignable.
  const enorme = { ...POOLS, storage: { capacity: 5.5 * 1024 ** 4, available: 1e12 } };
  assert.equal(borneHaute('storage_gib', { pools: enorme, cores: 4 }), null);
  const html = renderSparkCreate({ values: { ...DEFAUTS, name: 'ok' }, pools: enorme, cores: 4 });
  assert.match(html, /<input type="number"[^>]*id="storage_gib"/);
  // ... pendant que la memoire, elle, reste un curseur. La regle est locale au champ.
  assert.match(html, /<input type="range"[^>]*id="memory_gib"/);
});

test('le seuil de crans est CALCULE, pas declare', () => {
  // 400 crans = 28 rem (448 px) de contrôle : au-dela, un cran est plus etroit
  // qu'un pixel. Eprouve sur le disque, dont le pas vaut 1 Gio : la borne juste
  // sous le seuil passe, celle juste au-dessus non.
  const gio = (n) => ({ ...POOLS, storage: { capacity: n * GIO, available: 0 } });
  assert.equal(borneHaute('storage_gib', { pools: gio(CRANS_MAX + 1) }), CRANS_MAX + 1);
  assert.equal(borneHaute('storage_gib', { pools: gio(CRANS_MAX + 2) }), null);
});

test('le seuil s applique AU PAS du quota, pas a son unite', () => {
  // La memoire avance de 256 Mio : 400 crans y valent 100 Gio et non 400. Un
  // pool plus gros retombe donc en saisie, et c'est la regle qui fonctionne.
  const gio = (n) => ({ ...POOLS, memory: { capacity: n * GIO, available: 0 } });
  assert.equal(borneHaute('memory_gib', { pools: gio(100.25) }), 100.25);
  assert.equal(borneHaute('memory_gib', { pools: gio(100.5) }), null);
});

test('la memoire avance par pas de 256 Mio', () => {
  // Decision du responsable (SPK-DS-07). Le gibioctet rendait inatteignables
  // les 512 Mio que le SEED emploie pour quatre de ses Sparks.
  assert.equal(QUOTAS.memory_gib.pas, 0.25);
  assert.equal(QUOTAS.memory_gib.min, 0.25);
  const html = renderSparkCreate({ values: { ...DEFAUTS, name: 'ok' }, ...CONTEXTE });
  assert.match(html, /id="memory_gib"[^>]*step="0.25"/);
  assert.match(html, /id="memory_gib"[^>]*min="0.25"/);
  // La valeur du seed est sur un cran, donc atteignable au curseur.
  assert.equal(formatQuota('memory_gib', 0.5), '512 Mio');
});

test('la reservation et le plafond CPU avancent par pas de 0,25 CPU', () => {
  // Decision du responsable (SPK-DS-07) : 0,25 CPU est la plus petite part que
  // le produit partage. Un pas de 0,05 offrait quatre crans intermediaires
  // qu'aucune part vendable n'occupe, et posait la borne basse a 0,05 CPU.
  assert.equal(QUOTAS.cpu_reservation.pas, 0.25);
  assert.equal(QUOTAS.cpu_reservation.min, 0.25);
  assert.equal(QUOTAS.cpu_max.pas, 0.25);
  assert.equal(QUOTAS.cpu_max.min, 0.25);
  const partage = renderSparkCreate({ values: { ...DEFAUTS, name: 'ok' }, ...CONTEXTE });
  assert.match(partage, /id="cpu_reservation"[^>]*step="0.25"/);
  assert.match(partage, /id="cpu_reservation"[^>]*min="0.25"/);
  const plafonne = renderSparkCreate(
    { values: { ...DEFAUTS, name: 'ok', cpu_mode: 'capped' }, ...CONTEXTE });
  assert.match(plafonne, /id="cpu_max"[^>]*step="0.25"/);
  assert.match(plafonne, /id="cpu_max"[^>]*min="0.25"/);
});

test('les parts du SEED restent atteignables au curseur', () => {
  // 0,25 et 0,5 CPU : ce que le seed pose. Une grille qui les manquerait
  // renverrait l'ecran a la saisie sur ses propres donnees de demonstration.
  const max = borneHaute('cpu_reservation', CONTEXTE);
  for (const part of [0.25, 0.5, 1]) {
    const html = renderSparkCreate(
      { values: { ...DEFAUTS, name: 'ok', cpu_reservation: part }, ...CONTEXTE });
    assert.match(html, new RegExp(`<input type="range"[^>]*id="cpu_reservation"`),
      `${part} CPU doit tomber sur un cran (borne haute ${max})`);
  }
});

test('la valeur affichee est EXACTE sur la grille, jamais arrondie', () => {
  // §6.9 bis : un curseur qui affiche « 10 Gio » pour 10,25 ment sur ce qu'il
  // envoie, et trois crans sur quatre deviennent invisibles.
  assert.equal(formatQuota('memory_gib', 1.25), '1,25 Gio');
  assert.equal(formatQuota('memory_gib', 10.25), '10,25 Gio');
  assert.equal(formatQuota('memory_gib', 2), '2 Gio');
  // Ce que le format des MESURES aurait rendu, et qui serait faux ici.
  assert.equal(formatBytes(10.25 * GIO), '10 Gio');
  assert.equal(formatBytes(1.25 * GIO), '1,3 Gio');
});

test('les deux quotas en octets s ecrivent de la MEME facon', () => {
  // Deux valeurs de meme unite sur le meme ecran ne peuvent pas s'ecrire l'une
  // « 1 Gio » et l'autre « 1,0 Gio ».
  assert.equal(formatQuota('memory_gib', 1), formatQuota('storage_gib', 1));
});

test('ce qu on DEMANDE s ecrit exactement, ce qui RESTE est une mesure', () => {
  const risques = estimate({ ...DEFAUTS, memory_gib: 10.25 }, POOLS);
  assert.equal(risques[0].requested, '10,25 Gio');
  assert.equal(risques[0].available, '4,0 Gio');
});

test('le curseur porte sa valeur EN CLAIR et dans aria-valuetext', () => {
  // Une poignee ne dit pas ou elle est, et la synthese annoncerait « 2 » la ou
  // l'ecran montre « 2,0 Gio ».
  const html = renderSparkCreate({ values: { ...DEFAUTS, name: 'ok' }, ...CONTEXTE });
  assert.match(html, /id="memory_gib"[\s\S]*?aria-valuetext="2 Gio"/);
  assert.match(html, /data-valeur-de="memory_gib" aria-hidden="true">2 Gio</);
});

test('le doublon visible de la valeur est cache a la synthese', () => {
  // Un <output> serait une region vive et parlerait a chaque cran d'un
  // glissement ; le curseur annonce deja sa valeur.
  const html = renderSparkCreate({ values: { ...DEFAUTS, name: 'ok' }, ...CONTEXTE });
  assert.equal(/<output/.test(html), false);
  assert.match(html, /class="curseur__valeur"[^>]*aria-hidden="true"/);
});

test('les deux bornes sont ecrites sous la piste', () => {
  const html = renderSparkCreate({ values: { ...DEFAUTS, name: 'ok' }, ...CONTEXTE });
  assert.match(html, /class="curseur__bornes"/);
  assert.match(html, /256 Mio[\s\S]*?76 Gio/);
});

test('l ecran dit D OU VIENT la borne haute', () => {
  // Un curseur qui va a 76 Gio a cote d'un panneau annoncant 4 Gio libres se
  // lirait autrement comme une contradiction.
  const html = renderSparkCreate({ values: { ...DEFAUTS, name: 'ok' }, ...CONTEXTE });
  assert.match(html, /Les curseurs vont donc jusqu’à ce que la Forge possède/);
  assert.match(html, /non jusqu’à ce qui reste libre/);
  // Sans curseur, la phrase n'a pas lieu d'etre.
  assert.equal(/Les curseurs vont donc/.test(
    renderSparkCreate({ values: { ...DEFAUTS, name: 'ok' }, pools: null })), false);
});

test('la borne basse ne produit jamais une valeur que le formulaire refuse', () => {
  // §1.4 : un curseur ne doit pas pouvoir produire une valeur invalide.
  for (const [nom, q] of Object.entries(QUOTAS)) {
    const valeurs = { ...DEFAUTS, name: 'ok', [nom]: q.min };
    assert.deepEqual(validateShape({ ...valeurs, cpu_mode: 'shared-pinned' })[nom], undefined,
      `la borne basse de ${nom} est refusee par le controle local`);
  }
});

test('le libelle porte l unite pour une SAISIE, pas pour un curseur', () => {
  // Le curseur montre deja « 2,0 Gio » ; « Mémoire (Gio) » y repeterait ce que
  // la valeur dit mieux. Une saisie, elle, ne dit pas dans quelle unite taper.
  assert.match(renderSparkCreate({ values: { ...DEFAUTS, name: 'ok' }, pools: null }),
               /<label for="memory_gib">Mémoire \(Gio\)<\/label>/);
  assert.match(renderSparkCreate({ values: { ...DEFAUTS, name: 'ok' }, ...CONTEXTE }),
               /<label for="memory_gib">Mémoire<\/label>/);
});

test('une valeur hors plage ou hors cran retombe sur la SAISIE', () => {
  // Le navigateur l'arrondirait SILENCIEUSEMENT, et l'ecran afficherait autre
  // chose que ce qui sera envoye.
  const horsPlage = renderSparkCreate({ values: { ...DEFAUTS, name: 'ok', memory_gib: 999 }, ...CONTEXTE });
  assert.match(horsPlage, /<input type="number"[^>]*id="memory_gib"[^>]*value="999"/);
  const horsCran = renderSparkCreate({ values: { ...DEFAUTS, name: 'ok', network_mbit: 33 }, ...CONTEXTE });
  assert.match(horsCran, /<input type="number"[^>]*id="network_mbit"[^>]*value="33"/);
});

test('un quota est FORMATE, jamais rendu brut', () => {
  assert.equal(formatQuota('memory_gib', 16), '16 Gio');
  assert.equal(formatQuota('network_mbit', 100), '100 Mbit/s');
  assert.equal(formatQuota('cpu_reservation', 0.5), '0,50 CPU');
  assert.equal(formatQuota('cpu_cores', 1), '1 cœur');
  assert.equal(formatQuota('cpu_cores', 2), '2 cœurs');
});

// --- L'avertissement se rafraichit sans repeindre ---------------------------

test('la zone d avertissement existe TOUJOURS, meme vide', () => {
  // Elle est le point d'ancrage du rafraichissement : sans elle il faudrait
  // repeindre le formulaire, ce qui arracherait la poignee en cours de
  // glissement et ferait perdre le focus (§14.3).
  const html = renderSparkCreate({ values: { ...DEFAUTS, name: 'ok' }, ...CONTEXTE });
  assert.match(html, /<div class="zone-avertissement">/);
});

test('l avertissement se rend SEUL, a partir des memes valeurs', () => {
  assert.equal(renderAvertissement({ ...DEFAUTS, name: 'ok' }, POOLS), '');
  const alerte = renderAvertissement({ ...DEFAUTS, memory_gib: 76 }, POOLS);
  assert.match(alerte, /class="avertissement"/);
  assert.match(alerte, /mémoire/);
  assert.match(alerte, /c’est le serveur qui décide/);
});

test('un refus du serveur fait taire l estimation locale, la aussi', () => {
  assert.equal(renderAvertissement({ ...DEFAUTS, memory_gib: 76 }, POOLS,
                                   { shortfalls: [] }), '');
});

// --- SPK-76 · le catalogue dit ce que l'amorçage sait servir ---------------
//
// @verifies docs/BACKLOG.md#SPK-76 · docs/DAT.md §42.9.6

test('une image que l’amorçage ne sert pas est SIGNALÉE dans la liste', () => {
  // §42.9.6 : le §33 proposait une image que le §42 ne savait pas équiper, et
  // rien ne le disait avant l'échec. C'est ce silence qui a produit `alpine-demo`.
  const rendu = renderChoixImage('images:debian/13', [
    { reference: 'images:debian/13', label: 'Debian 13', bootstrappable: true },
    { reference: 'images:alpine/3.21', label: 'Alpine 3.21', bootstrappable: false },
  ]);
  assert.match(rendu, /Alpine 3\.21 — images:alpine\/3\.21 \(amorçage non pris en charge\)/);
  assert.match(rendu, /famille Debian/);
});

test('une image non amorçable reste CHOISISSABLE', () => {
  // §42.9.6 : ce n'est pas un filtre. Le produit sert des cellules, pas
  // seulement des cellules amorçables — la retirer déciderait à la place du
  // locataire (§25, montrer sans décider).
  const rendu = renderChoixImage('images:debian/13', [
    { reference: 'images:alpine/3.21', label: 'Alpine 3.21', bootstrappable: false },
  ]);
  assert.match(rendu, /<option value="images:alpine\/3\.21"/);
  assert.ok(!/disabled/.test(rendu));
});

test('sans catalogue non amorçable, l’aide ne parle pas d’amorçage', () => {
  // Une aide qui énonce une restriction inexistante fait chercher un problème
  // qui n'est pas là.
  const rendu = renderChoixImage('images:debian/13', [
    { reference: 'images:debian/13', label: 'Debian 13', bootstrappable: true },
  ]);
  assert.ok(!/famille Debian/.test(rendu));
});
