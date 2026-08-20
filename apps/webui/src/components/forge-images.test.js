/**
 * @verifies docs/BACKLOG.md#SPK-32, docs/BACKLOG.md#SPK-33 ·
 *           docs/DAT.md §33.2, §33.3 (les trois états, la date), §33.4,
 *           §34.1 (l'onglet Images), §26.2 (la saisie passe par une modale) ·
 *           docs/DESIGN_SYSTEM.md §6.14, §6.24, §6.27 (modale limitée à une
 *           section), §5.4 (afficher et saisir ne partagent pas la même
 *           surface), §14.6, §14.7
 *
 * Le catalogue existait sans écran : ni la date, ni « absente », ni « non
 * relevée » n'étaient visibles. Un exploitant ne pouvait pas voir qu'une image
 * avait disparu de son dépôt.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderCatalogue, renderOngletsForge, dernierReleve, etatOf, ETATS, CATALOGUE_VIDE,
} from './forge-images.js';

const IMAGES = [
  { reference: 'images:debian/13', label: 'Debian 13', state: 'verified',
    verified_at: '2026-08-19T09:45:00', detail: 'relevé sur 272 produits publiés',
    is_default: 1 },
  { reference: 'images:debian/31', label: 'Inexistante', state: 'missing',
    verified_at: '2026-08-19T09:45:00', detail: 'absent des 272 produits publiés',
    is_default: 0 },
  { reference: 'images:fedora/41', label: 'Fedora 41', state: 'unknown',
    verified_at: null, detail: '', is_default: 0 },
];

const ui = (o = {}) => ({ ...CATALOGUE_VIDE, ...o,
                          values: { ...CATALOGUE_VIDE.values, ...(o.values ?? {}) } });

// --- les trois etats, jamais confondus (§33.3, §14.6) -----------------------

test('les trois etats portent des libelles et des couleurs DISTINCTS', () => {
  const labels = Object.values(ETATS).map((e) => e.label);
  assert.equal(new Set(labels).size, 3);
  const tokens = Object.values(ETATS).map((e) => e.token);
  assert.equal(new Set(tokens).size, 3);
});

test('« non relevee » n’est PAS rendu comme une panne', () => {
  // Ce n'est pas une image retiree du depot : c'est un releve qui n'a pas eu
  // lieu. Les confondre ferait conclure a une disparition (§14.6).
  assert.equal(etatOf('unknown').token, 'accent');
  assert.equal(etatOf('missing').token, 'danger');
  assert.notEqual(etatOf('unknown').token, etatOf('missing').token);
});

test('un etat inconnu du composant reste visible plutot que masque', () => {
  assert.equal(etatOf('quelque-chose-de-neuf').label, 'quelque-chose-de-neuf');
});

test('les trois etats apparaissent a l’ecran', () => {
  const rendu = renderCatalogue({ status: 'ready', images: IMAGES });
  assert.ok(rendu.includes('Vérifiée'));
  assert.ok(rendu.includes('Absente'));
  assert.ok(rendu.includes('Non relevée'));
});

// --- la date du releve (§33.3, meme regle qu'au §27.8) ----------------------

test('l’ecran affiche la date du dernier releve', () => {
  const rendu = renderCatalogue({ status: 'ready', images: IMAGES });
  assert.ok(rendu.includes('2026-08-19 09:45'));
  assert.ok(rendu.includes('ne sont pas revérifiées à chaque ouverture'));
});

test('sans aucun releve, l’ecran le DIT au lieu d’inventer une date', () => {
  const jamais = IMAGES.map((i) => ({ ...i, verified_at: null }));
  const rendu = renderCatalogue({ status: 'ready', images: jamais });
  assert.ok(rendu.includes('Aucun relevé n’a encore eu lieu'));
});

test('dernierReleve prend la date la plus recente', () => {
  assert.equal(dernierReleve(IMAGES), '2026-08-19T09:45:00');
  assert.equal(dernierReleve([{ verified_at: null }]), null);
  assert.equal(dernierReleve([]), null);
});

// --- une entree non proposable reste VISIBLE (§33.3) ------------------------

test('les entrees absentes restent affichees, et l’ecran dit pourquoi', () => {
  const rendu = renderCatalogue({ status: 'ready', images: IMAGES });
  assert.ok(rendu.includes('images:debian/31'), 'l’entree absente reste listee');
  assert.ok(rendu.includes('ferait croire qu’elles'), 'l’ecran justifie leur presence');
});

test('sans entree douteuse, aucun avertissement n’est affiche', () => {
  const rendu = renderCatalogue({ status: 'ready', images: [IMAGES[0]] });
  assert.ok(!rendu.includes('ne sont pas proposées à la création'));
});

// --- le releve ne demande pas de confirmation (§6.24) -----------------------

test('relever ne detruit rien : aucune confirmation', () => {
  const rendu = renderCatalogue({ status: 'ready', images: IMAGES });
  assert.ok(rendu.includes('data-action="relever-images"'));
  assert.ok(!rendu.includes('confirmation'));
});

test('pendant le releve, le bouton est desactive et le dit', () => {
  const rendu = renderCatalogue({ status: 'ready', images: IMAGES, ui: ui({ syncing: true }) });
  assert.ok(rendu.includes('disabled'));
  assert.ok(rendu.includes('Relevé…'));
});

// --- ajouter est un geste EXPLICITE (§33.2) ---------------------------------

test('le formulaire d’ajout dit que l’entree nait NON relevee', () => {
  const rendu = renderCatalogue({ status: 'ready', images: IMAGES, ui: ui({ open: true }) });
  assert.ok(rendu.includes('L’entrée naît non relevée'));
});

test('la saisie est recueillie par une MODALE, pas dans le flux du catalogue', () => {
  // §5.4 point 1 : la section « Catalogue » affiche un tableau ; elle ne peut pas
  // recueillir une saisie sur la même surface.
  const ferme = renderCatalogue({ status: 'ready', images: IMAGES, ui: ui({}) });
  assert.ok(ferme.includes('data-ouvre="image"'), 'la section porte sa commande');
  assert.ok(!ferme.includes('<dialog'), 'aucune modale tant qu’on n’a rien demandé');

  const ouvert = renderCatalogue({ status: 'ready', images: IMAGES, ui: ui({ open: true }) });
  assert.ok(ouvert.includes('<dialog class="modale" id="image"'));
  // Le nom accessible est le TITRE DE LA SECTION : c'est ce qui borne la portée.
  assert.ok(ouvert.includes('aria-labelledby="image-titre"'));
  assert.match(ouvert, /id="image-titre">Catalogue</);
  // Un point d'engagement, qui NOMME l'action (§6.27).
  assert.match(ouvert, /data-engage="image"[^>]*>Ajouter au catalogue</s);
  // Le déclencheur reste visible : c'est lui qui recevra le focus à la fermeture.
  assert.ok(ouvert.includes('data-ouvre="image"'));
  // Une seule modale à la fois.
  assert.equal(ouvert.match(/<dialog/g).length, 1);
});

test('un refus du serveur est montre et n’efface pas la saisie', () => {
  const rendu = renderCatalogue({ status: 'ready', images: IMAGES,
    ui: ui({ open: true, refusal: 'déjà au catalogue',
             values: { reference: 'images:debian/13', label: 'Doublon' } }) });
  assert.ok(rendu.includes('déjà au catalogue'));
  assert.ok(rendu.includes('value="images:debian/13"'));
  assert.ok(rendu.includes('value="Doublon"'));
});

// --- etats de la vue (§6.13) et perimetre (§33.4) ---------------------------

test('les etats chargement et erreur sont traites', () => {
  assert.ok(renderCatalogue({ status: 'loading' }).includes('aria-busy'));
  const erreur = renderCatalogue({ status: 'error', error: { message: 'tunnel rompu' } });
  assert.ok(erreur.includes('etat-vue--erreur') && erreur.includes('tunnel rompu'));
});

test('un catalogue vide dit ce qu’il implique', () => {
  const rendu = renderCatalogue({ status: 'ready', images: [] });
  assert.ok(rendu.includes('aucun Spark ne peut être créé'));
});

test('l’ecran DISTINGUE le catalogue d’un registre d’images', () => {
  // RÉVISÉE le 2026-08-20 par SPK-56 (§1.5 bis). La preuve exigeait le
  // paragraphe entier. La confusion qu'il dissipe est réelle — les deux se
  // disent « images » —, donc la DISTINCTION reste à l'écran : c'est le mot qui
  // qualifie, pas du raisonnement.
  //
  // Ce qui part au manuel M5, « Ce catalogue n'est pas un registre d'images » :
  // le développement — ce qu'il ne stocke ni ne construit ni ne publie, d'où
  // les images d'une pile sont réellement tirées, et pourquoi le produit n'a
  // aucun registre à vendre. Le chapitre a été ÉCRIT avant que l'écran cesse de
  // le dire : il ne l'avait pas.
  const rendu = renderCatalogue({ status: 'ready', images: IMAGES });
  assert.match(rendu, /images <strong>système<\/strong>/);
  assert.match(rendu, /pas un registre/);
  assert.match(rendu, /pas les images Docker de vos piles/);
  assert.match(rendu, /href="#\/manuel\/M5"/, 'le renvoi mène au développement');
});

test('les valeurs venues du serveur sont echappees', () => {
  const rendu = renderCatalogue({ status: 'ready', images: [
    { ...IMAGES[0], label: '<script>x</script>' }] });
  assert.ok(!rendu.includes('<script>'));
});

// --- les onglets sont des DESTINATIONS (§34.1) ------------------------------

test('les onglets du second degre sont des liens, pas un tablist', () => {
  const rendu = renderOngletsForge('#/forge/images');
  assert.ok(rendu.includes('<a href="#/forge/images"'));
  assert.ok(!rendu.includes('role="tab"'), 'on doit pouvoir recharger la page');
  assert.ok(rendu.includes('aria-label'));
});

test('l’onglet courant se signale, et lui seul', () => {
  const rendu = renderOngletsForge('#/forge/images');
  assert.equal((rendu.match(/aria-current="page"/g) || []).length, 1);
  assert.match(rendu, /href="#\/forge\/images"[^>]*aria-current="page"/);
});
