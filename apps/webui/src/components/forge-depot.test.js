/**
 * @verifies docs/BACKLOG.md#SPK-92 · docs/DAT.md §33.6 (le dépôt se lit en
 *           direct, le catalogue se coche, le repli est obligatoire), §33.7
 *           (retirer une entrée), §33.3 (les doublons que l'alias cache) ·
 *           §42.9.6 (annoncer l'amorçabilité) · docs/DESIGN_SYSTEM.md §6.10
 *           (cases à cocher), §6.13 (états systématiques), §6.22 (confirmation
 *           dans le flux), §6.27 (une seule modale à la fois), §9.9 (une action
 *           indisponible dit pourquoi), §14.4 (pas de contrôle sans objet),
 *           §1.5 (jamais la couleur seule), §6.11 (jamais deux états
 *           contradictoires) · DESIGN_SYSTEM_APP.md SPK-DS-09
 *
 * Le catalogue proposait quatre références écrites en dur devant un dépôt qui en
 * publie près de trois cents, et l'on ne pouvait en ajouter qu'en tapant une
 * référence de mémoire.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderDepotModale, filtrer, libelleEngagement, libelleIndication, DEPOT_VIDE,
} from './forge-depot.js';
import { renderCatalogue, CATALOGUE_VIDE } from './forge-images.js';

const version = (alias, libelle, extra = {}) => ({
  alias, reference: `images:${alias}`, libelle, variante: 'default',
  architectures: ['amd64'], au_catalogue: false, version: alias.split('/')[1] ?? null,
  synonymes: [], variantes: [], ...extra,
});

const LISTING = {
  remote: 'images', produits: 296, alias: 229,
  familles: [
    {
      famille: 'alpine', amorcable: false,
      versions: [version('alpine/3.21', 'Alpine 3.21', { au_catalogue: true })],
    },
    {
      famille: 'debian', amorcable: true,
      versions: [
        version('debian/13', 'Debian 13 « trixie »', {
          synonymes: ['debian/trixie'],
          variantes: [version('debian/13/cloud', 'Debian 13 « trixie » (cloud)',
                              { variante: 'cloud' })],
        }),
        version('debian/12', 'Debian 12 « bookworm »', { synonymes: ['debian/bookworm'] }),
      ],
    },
  ],
};

const ouverte = (extra = {}) => renderDepotModale({
  ...DEPOT_VIDE, open: true, status: 'ready', listing: LISTING, cochees: [], ...extra,
});

// --- ce que la modale propose (§33.6) ---------------------------------------

test('une entree DEJA au catalogue est cochee et inerte', () => {
  const vue = ouverte();
  const ligne = vue.slice(vue.indexOf('images:alpine/3.21'));
  assert.match(ligne.slice(0, 220), /checked/);
  assert.match(ligne.slice(0, 220), /disabled/);
  assert.match(vue, /déjà au catalogue/,
               'la modale ne sert pas à retirer : elle le DIT');
});

test('une variante vit SOUS sa version, pas a cote', () => {
  const vue = ouverte();
  const version13 = vue.indexOf('images:debian/13"');
  const cloud = vue.indexOf('images:debian/13/cloud');
  assert.ok(version13 > 0 && cloud > version13, 'la variante suit sa version');
  assert.match(vue, /liste-cases--variantes/,
               'et elle est en retrait, pas une ligne sœur');
});

test('le synonyme reste LISIBLE, sinon le regroupement cacherait un nom connu', () => {
  assert.match(ouverte(), /aussi publiée sous debian\/trixie/);
});

test('l amorcabilite est annoncee par un MOT, jamais par la seule couleur', () => {
  const vue = ouverte();
  assert.match(vue, /Amorçable/, 'debian');
  assert.match(vue, /Amorçage non pris en charge/, 'alpine');
  assert.match(vue, /images:alpine\/3\.21/,
               'annonce, jamais filtre : l’entrée reste proposée');
});

// --- chercher (§14.4) --------------------------------------------------------

test('la recherche trouve par NOM DE CODE, que l ecran n affiche pas', () => {
  const trouve = filtrer(LISTING.familles, 'trixie');
  assert.equal(trouve.length, 1);
  assert.deepEqual(trouve[0].versions.map((v) => v.alias), ['debian/13']);
});

test('la recherche trouve par famille, et rend toute la famille', () => {
  const trouve = filtrer(LISTING.familles, 'debian');
  assert.equal(trouve[0].versions.length, 2);
});

test('la recherche descend dans les variantes sans remonter la version', () => {
  const trouve = filtrer(LISTING.familles, 'cloud');
  assert.deepEqual(trouve.map((f) => f.famille), ['debian']);
  assert.deepEqual(trouve[0].versions[0].variantes.map((v) => v.alias),
                   ['debian/13/cloud']);
});

test('une recherche sans resultat NOMME l absence', () => {
  const vue = ouverte({ filtre: 'inexistante' });
  assert.match(vue, /Aucune image ne correspond/);
  assert.match(vue, /229 alias/, 'et rappelle ce que le dépôt publie');
});

test('le filtre ne s affiche PAS quand il n y a rien a filtrer', () => {
  const seule = { ...LISTING, familles: [LISTING.familles[0]] };
  assert.doesNotMatch(ouverte({ listing: seule }), /depot-filtre/);
  assert.match(ouverte(), /depot-filtre/, 'mais il est là dès qu’il y a de quoi');
});

// --- l engagement (§9.9, §6.11) ---------------------------------------------

test('l engagement est PRESENT et desactive tant que rien n est coche', () => {
  const vue = ouverte();
  assert.match(vue, /data-engage="depot"[^>]*disabled/,
               'présent et désactivé, jamais absent');
  assert.match(vue, /Cochez au moins une image/);
  assert.match(vue, /aria-describedby="depot-indication"/,
               'la raison est rattachée au bouton');
  assert.doesNotMatch(vue, /class="refus"/,
                      'rien n’a été tenté : ce n’est pas un refus');
});

test('l engagement s active et DIT ce qu il emporte', () => {
  const vue = ouverte({ cochees: ['images:debian/13', 'images:debian/12'] });
  assert.match(vue, /Ajouter 2 images au catalogue/);
  assert.doesNotMatch(vue, /data-engage="depot"[^>]*disabled/);
});

test('l engagement desactive DIT pourquoi dans les TROIS etats (§9.9)', () => {
  const enLecture = renderDepotModale({ ...DEPOT_VIDE, open: true, status: 'loading' });
  assert.match(enLecture, /Lecture du dépôt en cours/);
  assert.match(enLecture, /aria-describedby="depot-indication"/);

  const enPanne = renderDepotModale({ ...DEPOT_VIDE, open: true, status: 'error',
                                      error: { message: 'muet' } });
  assert.match(enPanne, /Rien à cocher/,
               'un bouton grisé sans un mot est un mur muet');
});

test('l indication ne contredit JAMAIS l engagement', () => {
  assert.match(libelleIndication(0), /Cochez/);
  assert.equal(libelleIndication(1), '1 image cochée.');
  assert.equal(libelleIndication(3), '3 images cochées.');
  assert.equal(libelleEngagement(1), 'Ajouter au catalogue');
  assert.equal(libelleEngagement(3), 'Ajouter 3 images au catalogue');
});

// --- les etats de la vue (§6.13) --------------------------------------------

test('la lecture en cours est annoncee, avec des squelettes', () => {
  const vue = renderDepotModale({ ...DEPOT_VIDE, open: true, status: 'loading' });
  assert.match(vue, /aria-busy="true"/);
  assert.match(vue, /role="status"/);
  assert.match(vue, /squelette/);
});

test('LE test du repli : un depot muet NOMME la panne et renvoie a la saisie libre', () => {
  const vue = renderDepotModale({
    ...DEPOT_VIDE, open: true, status: 'error',
    error: { message: 'Le depot d’images n’a pas repondu : connexion refusée' },
  });
  assert.match(vue, /role="alert"/);
  assert.match(vue, /connexion refusée/, 'la cause réelle, pas un message maison');
  assert.match(vue, /Saisir une référence/,
               'la seule voie restante est nommée, sinon l’ajout serait perdu');
  assert.doesNotMatch(vue, /data-ouvre/,
                      'mais elle n’est pas ouverte d’ici : une modale n’en ouvre pas une autre');
});

// --- l ecran du catalogue (§33.7, §6.22) ------------------------------------

const IMAGES = [
  { id: 'aaa', reference: 'images:debian/13', label: 'Debian 13', state: 'verified',
    verified_at: '2026-09-07T10:00:00', detail: 'relevé sur 296 produits publiés',
    is_default: 1 },
  { id: 'bbb', reference: 'images:alpine/3.21', label: 'Alpine 3.21', state: 'verified',
    verified_at: '2026-09-07T10:00:00', detail: 'relevé sur 296 produits publiés',
    is_default: 0 },
];

const ecran = (ui = {}, depot = {}) => renderCatalogue({
  status: 'ready', images: IMAGES,
  ui: { ...CATALOGUE_VIDE, ...ui },
  depot: { ...DEPOT_VIDE, ...depot },
});

test('la section porte les DEUX commandes, qui ne prouvent pas la meme chose', () => {
  const vue = ecran();
  assert.match(vue, /data-ouvre="depot"[\s\S]*?Ajouter depuis le dépôt/);
  assert.match(vue, /data-ouvre="image"[\s\S]*?Saisir une référence/);
});

test('chaque ligne du catalogue porte son retrait, nomme', () => {
  const vue = ecran();
  assert.match(vue, /data-retire="aaa"/);
  assert.match(vue, /aria-label="Retirer Debian 13 du catalogue"/,
               '§10.2 : le nom accessible dit LAQUELLE');
});

test('le retrait se confirme dans le FLUX, en accent et non en rouge', () => {
  const vue = ecran({ retrait: 'bbb' });
  assert.match(vue, /confirmation confirmation--sensible/,
               'SPK-DS-09 : le rouge est réservé à ce qui détruit');
  assert.doesNotMatch(vue, /bouton--destructif/,
                      'une confirmation accent avec un bouton rouge se contredirait');
  assert.match(vue, /Retirer « Alpine 3\.21 » du catalogue/, 'elle NOMME l’objet');
  assert.match(vue, /ne sera plus proposée à la création/, 'et sa conséquence');
});

test('le refus du retrait reste SOUS la ligne, avec sa raison', () => {
  const vue = ecran({ retrait: 'aaa', retraitRefus: 'employée par crm-production' });
  assert.match(vue, /class="refus" role="alert"/);
  assert.match(vue, /crm-production/, 'le refus NOMME les Sparks');
});

test('une seule modale a la fois', () => {
  const deux = ecran({ open: true }, { open: true, status: 'ready', listing: LISTING });
  assert.equal((deux.match(/<dialog/g) ?? []).length, 1);
  assert.match(deux, /id="depot"/, 'celle du dépôt l’emporte quand elle est ouverte');
});
