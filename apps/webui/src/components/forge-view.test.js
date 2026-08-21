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
  renderBuild, renderNotify,
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
  reservation_guarantee: 'floor_under_contention',
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
  assert.ok(rendu.includes('prochain relevé'));
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

test('l’absence de surengagement sur le disque est NOMMÉE, pas laissée en blanc', () => {
  // REVISE par SPK-56 (DESIGN_SYSTEM.md §1.5 bis) : l'écran nomme le fait, le
  // manuel explique pourquoi (M4). Ce que la preuve établit — la case n'est pas
  // un blanc inexpliqué — est inchangé.
  const rendu = renderForgeView({ status: 'ready', host: HOTE });
  assert.ok(rendu.includes('Aucun surengagement'));
  assert.ok(!rendu.includes('panne dure'),
            'le POURQUOI appartient au manuel, pas à l’écran');
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
  // REVISE par SPK-56 : le fait reste à l'écran, le raisonnement part au manuel.
  assert.ok(rendu.includes('sort du pool commun'));
  assert.ok(rendu.includes('cœurs physiques'), 'le SMT n’ajoute pas de capacité');
  assert.ok(rendu.includes('Manuel M4'), 'le renvoi remplace le paragraphe');
});

test('sans relevé des cœurs, la carte ne rend rien', () => {
  assert.equal(renderCores(null), '');
});

// --- LA RÉSERVATION N'EST PAS UNE GARANTIE (§27.6) --------------------------

test('la portée de la réservation est LUE dans la réponse, pas écrite en dur', () => {
  const proportionnelle = renderForgeView({ status: 'ready', host: HOTE });
  assert.ok(proportionnelle.includes('garantie sous contention totale'));

  // Le jour où SPK-29 est livrée, le runtime change cette valeur et l'écran suit.
  const absolue = renderForgeView({ status: 'ready',
    host: { ...HOTE, reservation_guarantee: 'absolute' } });
  assert.ok(absolue.includes('garantie sous contention'));
  assert.ok(!absolue.includes('dépassée sinon'));
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
    error: { message: 'La Forge n’a jamais été relevé.' } });
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
  // La MESURE reste à l'écran : elle change à chaque relevé, donc elle est de
  // l'écran (§1.5 bis). C'est le cours sur ZFS qui part au manuel.
  assert.ok(rendu.includes('consomme'));
  assert.ok(rendu.includes('8,0 Gio'));
  assert.ok(rendu.includes('50 %'), 'la part du plafond situe la mesure');
  assert.ok(!rendu.includes('reprendra sous les Sparks'),
            'le POURQUOI de la réserve appartient au manuel');
});

test("un ARC non mesurable le DIT, il ne s'affiche pas a zero", () => {
  // REVISE par SPK-42 : la machine est une FORGE (§1 bis). Le libelle suit ; ce
  // que la preuve etablit — un ARC dont on ignore la taille n'est pas un ARC
  // vide — est inchange.
  // §14.6 : un ARC dont on ignore la taille n'est pas un ARC vide. Les confondre
  // ferait croire la reserve inutile.
  assert.equal(describeArcUsage(null, 16 * GIO), 'consommation non mesurée');
  assert.equal(describeArcUsage(undefined, 16 * GIO), 'consommation non mesurée');
  const rendu = renderMemoryBreakdown({
    ...HOTE, reserves: { ...HOTE.reserves, arc_used_bytes: null },
  });
  assert.ok(rendu.includes('non mesurée'));
  assert.ok(!rendu.includes('consomme 0'));
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

// --- SPK-53 · QUEL CODE CETTE FORGE EXÉCUTE (§40.3) -------------------------

test('sans comparaison, l’écran ne dit PAS « à jour »', () => {
  // §14.6 : « pas encore comparé » n'est ni à jour, ni une panne. C'est le cœur
  // du §40.3 — une console qui afficherait « à jour » faute de savoir comparer
  // mentirait exactement au moment où l'on a besoin d'elle.
  const rendu = renderBuild(null);
  assert.match(rendu, /n’a pas encore comparé/);
  assert.ok(!/à jour/i.test(rendu));
});

test('la comparaison EN COURS ne se confond pas avec son résultat', () => {
  const rendu = renderBuild('en-cours');
  assert.match(rendu, /Comparaison en cours/);
  assert.match(rendu, /aria-busy="true"/);
  assert.ok(!/à jour/i.test(rendu));
});

test('une Forge à jour le dit, en vert, et sans chiffre d’écart', () => {
  const rendu = renderBuild({
    verdict: 'a_jour', titre: 'À jour', detail: 'Même commit.', behind: 0,
    forge: { version: '0.0.0+abc123' }, local: { head: 'abc123def456', branch: 'main' } });
  assert.match(rendu, /badge--success/);
  assert.match(rendu, /À jour/);
  assert.ok(!/commit d’écart/.test(rendu));
  assert.ok(!/role="alert"/.test(rendu), 'une bonne nouvelle n’est pas une alerte');
});

test('une Forge en retard CHIFFRE son écart, et c’est une alerte', () => {
  const rendu = renderBuild({
    verdict: 'forge_en_retard', titre: 'En retard', detail: 'Des commits manquent.',
    behind: 3, forge: { version: '0.0.0+aaa' }, local: { head: 'bbb', branch: 'main' } });
  assert.match(rendu, /3 commits d’écart/);
  assert.match(rendu, /badge--danger/);
  assert.match(rendu, /role="alert"/, '§9.7 : ce qui appelle un geste est annoncé');
});

test('un seul commit d’écart se dit au SINGULIER', () => {
  const rendu = renderBuild({ verdict: 'forge_en_retard', titre: 'En retard',
                              detail: 'x', behind: 1 });
  assert.match(rendu, /1 commit d’écart/);
  assert.ok(!/1 commits/.test(rendu));
});

test('quand c’est le POSTE qui est en retard, ce n’est pas une alerte', () => {
  // Le cas qui trompe : traité comme un défaut de la Forge, il enverrait
  // redéployer une version PLUS ANCIENNE.
  const rendu = renderBuild({
    verdict: 'poste_en_retard', titre: 'C’est ce poste qui est en retard',
    detail: 'Récupérez avant de conclure.', ahead: 2 });
  assert.match(rendu, /ce poste qui est en retard/);
  assert.match(rendu, /2 commits d’avance sur ce poste/);
  assert.ok(!/role="alert"/.test(rendu));
  assert.ok(!/badge--danger/.test(rendu));
});

test('une build étrangère dit qu’on ne sait pas, et ne conclut rien', () => {
  const rendu = renderBuild({
    verdict: 'etrangere', titre: 'Build étrangère à ce dépôt',
    detail: 'Aucune comparaison n’est possible — ce n’est pas « à jour ».' });
  assert.match(rendu, /Build étrangère/);
  assert.match(rendu, /n’est pas « à jour »/);
});

test('une build non estampillée est une ALERTE, et dit quoi faire', () => {
  const rendu = renderBuild({
    verdict: 'non_estampillee', titre: 'Build non estampillée',
    detail: 'Réinstallez-la pour le savoir.' });
  assert.match(rendu, /role="alert"/);
  assert.match(rendu, /Réinstallez/);
});

test('un arbre MODIFIÉ se voit à côté de la version', () => {
  // §40.2 : déployer un arbre modifié est licite, le taire ne l'est pas.
  const rendu = renderBuild({
    verdict: 'a_jour', titre: 'À jour', detail: 'x',
    forge: { version: '0.0.0+abc123.sale', dirty: true } });
  assert.match(rendu, /arbre modifié/);
  assert.match(rendu, /badge--accent/);
});

test('la tête du dépôt local est TRONQUÉE et en chasse fixe', () => {
  // §3.1 : une donnée qui se compare caractère par caractère est en monospace ;
  // quarante caractères d'empreinte n'apprennent rien de plus que douze.
  const rendu = renderBuild({
    verdict: 'a_jour', titre: 'À jour', detail: 'x',
    local: { head: '0123456789abcdef0123456789abcdef01234567', branch: 'main' } });
  assert.match(rendu, /technique">0123456789ab</);
  assert.ok(!rendu.includes('0123456789abcdef0123456789abcdef01234567'));
});

test('la section vit sur l’écran de la Forge, et le bouton de comparaison aussi', () => {
  const rendu = renderForgeView({
    status: 'ready', host: HOTE, cores: null,
    build: { verdict: 'a_jour', titre: 'À jour', detail: 'x' } });
  assert.match(rendu, /id="titre-build"/);
  assert.match(rendu, /data-action="comparer-build"/);
});

/* --- L'alerte hors bande (SPK-62, docs/DAT.md §47.6) ---------------------- */

test('sans canal configure, l ecran DIT que rien n est surveille', () => {
  // §14.6 : les compteurs valent alors zero, et zero ressemble a « tout va
  // bien ». Il faut dire l'inverse en toutes lettres.
  const html = renderNotify({ configured: false, sent: 0, failed: 0, dropped: 0 });
  assert.match(html, /Aucun canal n’est configuré/);
  assert.match(html, /rien\s+n’est surveillé/);
  // §47.3 : ce n'est pas une panne, et l'ecran ne doit pas le peindre comme tel.
  assert.ok(!html.includes('role="alert"'));
  assert.ok(!html.includes('refus'));
});

test('des envois en echec sont dits, SANS laisser croire a un refus', () => {
  // §25.1 : le rouge est reserve au refus du serveur. Ici la Forge n'a rien
  // refuse — les gestes ont abouti, seule la detection manque.
  const html = renderNotify({ configured: true, sent: 4, failed: 3, dropped: 1,
                              last_error: 'connexion refusée' });
  assert.match(html, /4 alerte\(s\)\s+ne sont pas parties/);
  assert.match(html, /ont abouti/);
  assert.match(html, /connexion refusée/);
  assert.match(html, /avertissement/);
  assert.ok(!html.includes('badge--danger'));
});

test('un canal qui va bien le dit en VERT, et seulement lui', () => {
  const html = renderNotify({ configured: true, sent: 12, failed: 0, dropped: 0 });
  assert.match(html, /succes/);
  assert.match(html, /Toutes les alertes sont parties/);
  assert.ok(!html.includes('avertissement'));
});

test('les compteurs disent leur PORTEE : depuis le dernier demarrage', () => {
  // §47.6 : ils ne survivent pas a un redemarrage, et l'ecran ne pretend pas le
  // contraire.
  const html = renderNotify({ configured: true, sent: 1, failed: 0, dropped: 0 });
  assert.match(html, /repartent de zéro à chaque redémarrage/);
});

test('une Forge qui ne rend pas encore ce champ n est pas une Forge SANS canal', () => {
  // §14.5 : ne rien affirmer vaut mieux qu'affirmer faux.
  assert.equal(renderNotify(undefined), '');
  assert.equal(renderNotify(null), '');
});

test('le bloc est rendu dans la vue de la Forge', () => {
  const html = renderForgeView({
    status: 'ready',
    host: { hostname: 'f', pools: {}, addresses: { capacity: 1, used: 0, free: 1 },
            reserves: {}, topology_synced_at: 't',
            notify: { configured: false, sent: 0, failed: 0, dropped: 0 } },
  });
  assert.match(html, /titre-notify/);
});
