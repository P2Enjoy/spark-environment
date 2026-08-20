/**
 * @verifies docs/BACKLOG.md#SPK-22, docs/BACKLOG.md#SPK-30 ·
 *           docs/DAT.md §27, §27.2, §27.3, §27.4, §27.5, §27.6, §27.7, §27.8 ·
 *           §7.7, §8.8.2 (la marge de metadonnees est nommee a l'ecran), §16.1 ·
 *           docs/DESIGN_SYSTEM.md §1.5, §6.13, §6.24, §14.6
 *
 * Le coeur de l'unite : l'ecran rend l'admission control observable. Chaque
 * chiffre affiche doit permettre de repondre a « pourquoi cette creation
 * serait-elle refusee, et de combien ? ».
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderForgeView, renderMemoryBreakdown, renderCores, renderNotSynced, renderHostError, renderHostSkeleton, fillRatio, formatDate, GARANTIES, RESSOURCES, describeArcUsage, describeMetadataMargin,
} from './forge-view.js';

const GIO = 1024 ** 3;
const HOTE = {
  hostname: 'spark-experiment',
  cpu: { cores_total: 4, threads_total: 8, cores_dedicated: 1 },
  memory: { total_bytes: 94 * GIO },
  reserves: { memory_bytes: 18 * GIO, arc_bytes: 16 * GIO,
              margin_bytes: 2 * GIO, storage_bytes: 0 },
  pools: {
    cpu: { capacity: 6, allocated: 2.5, available: 3.5, overcommit: 2 },
    memory: { capacity: 76 * GIO, allocated: 12 * GIO, available: 64 * GIO, overcommit: 1 },
    storage: { capacity: 193 * GIO, allocated: 40 * GIO, available: 153 * GIO, overcommit: 1 },
    network: { capacity: 1e9, allocated: 3e8, available: 7e8, overcommit: 1 },
  },
  addresses: { capacity: 200, used: 4, free: 196, dhcp_dynamic_range: '10.77.0.240-10.77.0.254' },
  topology_synced_at: '2026-08-19T14:05:00',
  reservation_guarantee: 'proportional_between_sparks_only',
};
const CORES = {
  physical_cores: 4,
  shared: { cores: [0, 1, 2], cpus: [0, 4, 1, 5, 2, 6], capacity: 6 },
  dedicated: [{ core_id: 3, cpus: [3, 7], spark_id: 'S-postgres' }],
};

// --- LES TROIS GRANDEURS (§27.2) --------------------------------------------

test('chaque ressource montre capacité, alloué ET disponible', () => {
  const rendu = renderForgeView({ status: 'ready', host: HOTE });
  // Compter sur la page entiere surcompterait : le pool d'adresses porte lui
  // aussi un « Capacite ». On mesure DANS le bloc des pools.
  const bloc = rendu.slice(rendu.indexOf('<div class="pools">'),
                           rendu.indexOf('id="titre-memoire"'));
  for (const terme of ['Capacité', 'Alloué', 'Disponible']) {
    const occurrences = bloc.split(`<dt>${terme}</dt>`).length - 1;
    assert.equal(occurrences, 4, `${terme} manque sur au moins un pool`);
  }
});

test('les quatre ressources sont présentes et nommées en français', () => {
  const rendu = renderForgeView({ status: 'ready', host: HOTE });
  for (const { nom } of RESSOURCES) assert.ok(rendu.includes(nom), `${nom} absent`);
  assert.ok(!/\bcpu\b|\bmemory\b|\bstorage\b|\bnetwork\b/.test(
    rendu.replace(/data-[a-z-]+="[^"]*"/g, '')), 'aucun nom technique brut à l’écran');
});

test('un pool absent est nommé, pas laissé vide (§14.6)', () => {
  const rendu = renderForgeView({ status: 'ready', host: { ...HOTE, pools: { cpu: HOTE.pools.cpu } } });
  assert.ok(rendu.includes('Non relevé.'));
});

// --- LA SOUSTRACTION MÉMOIRE (§27.3) ----------------------------------------

test('la soustraction nomme l’ARC et la marge, et aboutit à l’allouable', () => {
  const rendu = renderMemoryBreakdown(HOTE);
  assert.ok(rendu.includes('Mémoire de la machine'));
  assert.ok(rendu.includes('94 Gio'), 'le total de la machine');
  assert.ok(rendu.includes('− plafond de l’ARC ZFS'));
  assert.ok(rendu.includes('16 Gio'));
  assert.ok(rendu.includes('− marge d’exploitation'));
  assert.ok(rendu.includes('2,0 Gio'));
  assert.ok(rendu.includes('= mémoire allouable'));
  assert.ok(rendu.includes('76 Gio'));
});

test('la soustraction dit quelle vanne tourner pour chaque terme', () => {
  const rendu = renderMemoryBreakdown(HOTE);
  assert.ok(rendu.includes('zfs_arc_max'), 'l’ARC se règle par zfs_arc_max');
  assert.ok(rendu.includes('SPARKD_MEMORY_RESERVE'), 'la marge par sa variable');
});

test('sans détail relevé, la somme est affichée SANS inventer sa répartition', () => {
  // Base migrée mais pas encore resynchronisée : les deux termes valent zéro.
  const rendu = renderMemoryBreakdown({
    ...HOTE, reserves: { memory_bytes: 18 * GIO, arc_bytes: 0, margin_bytes: 0 },
  });
  // REVISE par SPK-42 : la machine est une FORGE (§1 bis). Le libelle suit ; ce
  // que la preuve etablit — la somme est affichee SANS inventer sa repartition —
  // est inchange.
  assert.ok(rendu.includes('− réserve de la Forge'));
  assert.ok(rendu.includes('18 Gio'));
  assert.ok(!rendu.includes('ARC ZFS'), 'ne pas nommer un terme qu’on ne connaît pas');
  assert.ok(rendu.includes('prochain relevé de topologie'));
});

test('sans mémoire totale connue, la soustraction ne rend rien plutôt qu’un calcul faux', () => {
  assert.equal(renderMemoryBreakdown({ ...HOTE, memory: null }), '');
  assert.equal(renderMemoryBreakdown(null), '');
});

// --- LE SURENGAGEMENT (§27.5) -----------------------------------------------

test('le facteur de surengagement est affiché à côté de la capacité', () => {
  const rendu = renderForgeView({ status: 'ready', host: HOTE });
  assert.ok(rendu.includes('surengagé ×2'),
    '« 6,00 CPU » sur quatre cœurs promettrait du matériel qui n’existe pas');
});

test('un facteur de 1 n’est pas affiché : il n’apprend rien', () => {
  const rendu = renderForgeView({ status: 'ready', host: {
    ...HOTE, pools: { ...HOTE.pools, cpu: { ...HOTE.pools.cpu, overcommit: 1 } } } });
  assert.ok(!rendu.includes('surengagé'));
});

test('l’absence de surengagement sur le disque est expliquée, pas laissée en blanc', () => {
  const rendu = renderForgeView({ status: 'ready', host: HOTE });
  assert.ok(rendu.includes('Aucun surengagement'));
  assert.ok(rendu.includes('panne dure'));
});

// --- LA CARTE DES CŒURS (§27.4) ---------------------------------------------

test('la carte des cœurs distingue le pool commun des cœurs dédiés', () => {
  const rendu = renderCores(CORES, { 'S-postgres': 'postgres-dedie' });
  assert.ok(rendu.includes('cœur 0'));
  assert.ok(rendu.includes('cœur 3'));
  // Compter « pool commun » brut inclurait la note explicative sous la carte :
  // on compte les LIGNES de la carte.
  assert.equal(rendu.split('coeur__role">pool commun').length - 1, 3);
  assert.ok(rendu.includes('dédié à postgres-dedie'), 'le NOM du Spark, pas son identifiant');
  assert.ok(!rendu.includes('S-postgres'), 'un identifiant interne ne doit pas atteindre l’écran');
});

test('un cœur dédié se distingue autrement que par la couleur seule (§1.5)', () => {
  const rendu = renderCores(CORES, {});
  assert.ok(rendu.includes('coeur--dedie'), 'la teinte');
  assert.ok(rendu.includes('dédié à'), 'et le libellé');
});

test('faute de nom connu, la carte retombe sur l’identifiant plutôt que sur du vide', () => {
  const rendu = renderCores(CORES, {});
  assert.ok(rendu.includes('dédié à S-postgres'));
});

test('la carte énonce qu’un Spark dédié réduit le pool des autres', () => {
  const rendu = renderCores(CORES, {});
  assert.ok(rendu.includes('retire ses cœurs du pool commun'));
  assert.ok(rendu.includes('cœurs physiques'), 'le SMT n’ajoute pas de capacité');
});

test('sans relevé des cœurs, la carte ne rend rien', () => {
  assert.equal(renderCores(null), '');
});

// --- LA RÉSERVATION N'EST PAS UNE GARANTIE (§27.6) --------------------------

test('la portée de la réservation est LUE dans la réponse, pas écrite en dur', () => {
  const proportionnelle = renderForgeView({ status: 'ready', host: HOTE });
  assert.ok(proportionnelle.includes('n’est proportionnelle qu’entre Sparks'));

  // Le jour où SPK-29 est livrée, le runtime change cette valeur et l'écran suit.
  const absolue = renderForgeView({ status: 'ready',
    host: { ...HOTE, reservation_guarantee: 'absolute' } });
  assert.ok(absolue.includes('garantie même sous contention'));
  assert.ok(!absolue.includes('n’est proportionnelle qu’entre Sparks'));
});

test('une portée inconnue n’affiche rien plutôt qu’une phrase inventée', () => {
  const rendu = renderForgeView({ status: 'ready',
    host: { ...HOTE, reservation_guarantee: 'quelque_chose_de_neuf' } });
  for (const phrase of Object.values(GARANTIES)) assert.ok(!rendu.includes(phrase));
});

// --- ADRESSES (§27.7) --------------------------------------------------------

test('le pool d’adresses figure avec les autres', () => {
  const rendu = renderForgeView({ status: 'ready', host: HOTE });
  assert.ok(rendu.includes('Adresses privées'));
  assert.ok(rendu.includes('196'), 'les adresses libres');
  assert.ok(rendu.includes('10.77.0.240-10.77.0.254'), 'la plage DHCP');
});

// --- TOPOLOGIE ET ÉTATS (§27.8, §6.13) --------------------------------------

test('la capacité est toujours accompagnée de sa date de relevé', () => {
  const rendu = renderForgeView({ status: 'ready', host: HOTE });
  assert.ok(rendu.includes('2026-08-19 14:05'));
  assert.ok(rendu.includes('n’est pas rafraîchie à chaque requête'));
});

test('une topologie jamais relevée offre son remède comme une ACTION', () => {
  const rendu = renderForgeView({ status: 'not-synced',
    error: { message: 'L’hôte n’a jamais été relevé.' } });
  assert.ok(rendu.includes('data-action="relever"'));
  assert.ok(rendu.includes('Relever la topologie'));
  assert.ok(!rendu.includes('etat-vue--erreur'), 'ce n’est pas une panne (§27.8)');
});

test('le relevé ne demande aucune confirmation (§6.24)', () => {
  const rendu = renderForgeView({ status: 'ready', host: HOTE });
  assert.ok(rendu.includes('data-action="relever"'));
  assert.ok(!rendu.includes('confirmation'), 'il ne détruit rien et n’a aucun paramètre');
});

test('pendant le relevé, le bouton est désactivé et le dit', () => {
  const rendu = renderForgeView({ status: 'ready', host: HOTE, syncing: true });
  assert.ok(rendu.includes('disabled'));
  assert.ok(rendu.includes('Relevé…'));
});

test('les états chargement et erreur sont traités', () => {
  assert.ok(renderForgeView({ status: 'loading' }).includes('aria-busy'));
  const erreur = renderForgeView({ status: 'error', error: { message: 'tunnel rompu' } });
  assert.ok(erreur.includes('etat-vue--erreur'));
  assert.ok(erreur.includes('tunnel rompu'));
  assert.ok(erreur.includes('data-action="reessayer"'));
});

// --- CALCULS ET ÉCHAPPEMENT --------------------------------------------------

test('la part occupée est bornée et ne divise jamais par zéro', () => {
  assert.equal(fillRatio({ capacity: 4, allocated: 1 }), 25);
  assert.equal(fillRatio({ capacity: 0, allocated: 5 }), 0);
  assert.equal(fillRatio({ capacity: 4, allocated: 9 }), 100);
  assert.equal(fillRatio(null), 0);
});

test('formatDate rend un horodatage lisible, et rien pour une absence', () => {
  assert.equal(formatDate('2026-08-19T14:05:00.123'), '2026-08-19 14:05');
  assert.equal(formatDate(null), '');
});

test('les valeurs venues du serveur sont échappées', () => {
  const rendu = renderForgeView({ status: 'ready',
    host: { ...HOTE, hostname: '<script>x</script>' } });
  assert.ok(!rendu.includes('<script>'));
  assert.ok(rendu.includes('&lt;script&gt;'));
});

test('le squelette annonce le chargement aux lecteurs d’écran', () => {
  assert.ok(renderHostSkeleton().includes('role="status"'));
});

test('l’erreur porte role=alert et le non-relevé non — l’un presse, l’autre pas', () => {
  assert.ok(renderHostError({ message: 'x' }).includes('role="alert"'));
  assert.ok(!renderNotSynced({ message: 'x' }).includes('role="alert"'));
});

// --- la consommation reelle de l'ARC (docs/DAT.md §13.12) -------------------

test("la consommation de l'ARC est affichee face a son plafond", () => {
  const rendu = renderMemoryBreakdown({
    ...HOTE,
    reserves: { ...HOTE.reserves, arc_used_bytes: 8 * GIO },
  });
  assert.ok(rendu.includes('Il en consomme actuellement'));
  assert.ok(rendu.includes('8,0 Gio'));
  assert.ok(rendu.includes('50 %'), 'la part du plafond situe la mesure');
});

test("un ARC non mesurable le DIT, il ne s'affiche pas a zero", () => {
  // REVISE par SPK-42 : la machine est une FORGE (§1 bis). Le libelle suit ; ce
  // que la preuve etablit — un ARC dont on ignore la taille n'est pas un ARC
  // vide — est inchange.
  // §14.6 : un ARC dont on ignore la taille n'est pas un ARC vide. Les confondre
  // ferait croire la reserve inutile.
  assert.equal(describeArcUsage(null, 16 * GIO),
               'Sa consommation n’est pas mesurable sur cette Forge.');
  assert.equal(describeArcUsage(undefined, 16 * GIO),
               'Sa consommation n’est pas mesurable sur cette Forge.');
  const rendu = renderMemoryBreakdown({
    ...HOTE, reserves: { ...HOTE.reserves, arc_used_bytes: null },
  });
  assert.ok(rendu.includes('n’est pas mesurable'));
  assert.ok(!rendu.includes('consomme actuellement 0'));
});

// --- la marge de metadonnees, nommee a l'ecran (SPK-30, §8.8.2) ------------

const MIO = 1024 * 1024;

test("l'ecart entre les tailles vendues et l'alloue est EXPLIQUE a l'ecran", () => {
  // Un exploitant qui additionne cinq Sparks de 10 Gio et lit 50,3 Gio doit
  // trouver l'explication ici, pas dans le code.
  const texte = describeMetadataMargin({
    reserves: { storage_metadata_margin_bytes: 64 * MIO,
                storage_metadata_total_bytes: 320 * MIO },
  });
  assert.match(texte, /64 Mio de métadonnées par Spark/);
  assert.match(texte, /320 Mio au total/);
  // Le remede est nomme : l'exploitant doit savoir quelle vanne tourner (§27.3).
  assert.match(texte, /SPARKD_STORAGE_METADATA_MARGIN/);
});

test('une marge NULLE n’explique rien : il n’y a rien a expliquer', () => {
  assert.equal(describeMetadataMargin({
    reserves: { storage_metadata_margin_bytes: 0, storage_metadata_total_bytes: 0 },
  }), '');
  assert.equal(describeMetadataMargin({}), '');
  assert.equal(describeMetadataMargin(undefined), '');
});

test('le total est LU dans la reponse, jamais recompose par la console', () => {
  // §27.6. Sans total publie, l'ecran dit la marge unitaire et se tait sur le
  // reste — il n'invente pas un nombre de Sparks qu'il ne connait pas.
  const texte = describeMetadataMargin({
    reserves: { storage_metadata_margin_bytes: 64 * MIO },
  });
  assert.match(texte, /64 Mio de métadonnées par Spark/);
  assert.ok(!texte.includes('au total'));
});

test("l'explication est rendue AVEC le pool disque, pas ailleurs", () => {
  const rendu = renderForgeView({
    status: 'ready',
    host: { ...HOTE, reserves: { ...HOTE.reserves,
      storage_metadata_margin_bytes: 64 * MIO,
      storage_metadata_total_bytes: 128 * MIO } },
  });
  const disque = rendu.slice(rendu.indexOf('Disque'));
  const suivant = disque.indexOf('Réseau');
  assert.ok(disque.slice(0, suivant).includes('de métadonnées par Spark'),
            'l’explication doit vivre dans la carte du disque');
});

test("un ARC a zero est une VRAIE valeur, distincte de l'absence de mesure", () => {
  assert.ok(describeArcUsage(0, 16 * GIO).includes('0 o'));
  assert.ok(describeArcUsage(0, 16 * GIO).includes('0 %'));
});

test("l'ARC au plafond s'affiche sans alarme : c'est son fonctionnement normal", () => {
  // Mesure du §13.12 : sous charge il atteint 100 % et n'y depasse pas.
  const texte = describeArcUsage(16 * GIO, 16 * GIO);
  assert.ok(texte.includes('100 %'));
  assert.ok(!/dépass|alerte|erreur/i.test(texte));
});
