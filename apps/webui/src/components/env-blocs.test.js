/**
 * @verifies docs/BACKLOG.md#SPK-103 · docs/DAT.md §43.11 (deux natures, deux
 *           blocs, une recherche qui porte sur le NOM), §43.3 (la valeur d'un
 *           secret ne sort jamais) · docs/DESIGN_SYSTEM_APP.md SPK-DS-25 ·
 *           docs/DESIGN_SYSTEM.md §14.10, §14.4, §14.5, §14.6, §9.3, §9.7
 *
 * Ce fichier éprouve la LOGIQUE que les deux vues d'environnement partagent.
 * Ce qu'il tient surtout, c'est ce que la recherche NE compare PAS : la preuve
 * d'une absence ne se voit sur aucune capture, et c'est pourtant elle qui
 * empêche l'écran de répondre « aucun résultat » sur un secret qui existe.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  correspondEnv, filtrerEnv, libelleCompte, renderAnnonceRecherche,
  renderBlocEnv, renderRechercheEnv, separer,
} from './env-blocs.js';

const VARIABLE = { name: 'SMTP_HOST', is_secret: false, value: 'relais.interne.example' };
const SECRET = { name: 'SMTP_PASSWORD', is_secret: true, value: null,
                 fingerprint: '07acff4bc411' };

test('la recherche compare le NOM, jamais la valeur', () => {
  // §43.11 : la console n'a JAMAIS la valeur d'un secret. Comparer les valeurs
  // ferait d'un secret une ligne qu'aucune frappe ne trouve — et l'écran
  // répondrait « aucun résultat » sur une entrée qui existe.
  const entrees = [VARIABLE, SECRET];
  assert.deepEqual(filtrerEnv(entrees, 'SMTP'), entrees);
  assert.deepEqual(filtrerEnv(entrees, 'PASSWORD'), [SECRET]);
  // La valeur d'une variable EST à l'écran, et pourtant elle ne sert pas de
  // critère : le critère doit être le même pour les deux natures (§14.10).
  assert.deepEqual(filtrerEnv(entrees, 'relais.interne'), []);
});

test('la recherche ignore la casse et les espaces de bordure', () => {
  assert.deepEqual(filtrerEnv([VARIABLE], '  smtp_h '), [VARIABLE]);
  assert.deepEqual(filtrerEnv([VARIABLE], 'ZZZ'), []);
});

test('une frappe vide ne restreint RIEN', () => {
  const entrees = [VARIABLE, SECRET];
  for (const frappe of ['', '   ', null, undefined]) {
    assert.deepEqual(filtrerEnv(entrees, frappe), entrees);
    assert.equal(correspondEnv('QUOI_QUE_CE_SOIT', frappe), true);
  }
});

test('la nature est celle qui est DÉCLARÉE, jamais devinée du nom', () => {
  // §43.3 : la détection par le nom échoue précisément là où elle importe.
  // `DATABASE_URL` porte un mot de passe neuf fois sur dix et n'est pas déclarée
  // secrète ici : elle DOIT se ranger dans les variables.
  const { variables, secrets } = separer([
    { name: 'DATABASE_URL', is_secret: false },
    { name: 'APP_NAME', is_secret: true },
  ]);
  assert.deepEqual(variables.map((e) => e.name), ['DATABASE_URL']);
  assert.deepEqual(secrets.map((e) => e.name), ['APP_NAME']);
});

test('le compte dit le total, et « x sur y » quand une frappe restreint', () => {
  assert.equal(libelleCompte(3, 3, ''), '3 entrées');
  assert.equal(libelleCompte(1, 1, ''), '1 entrée');
  assert.equal(libelleCompte(1, 3, 'SMTP'), '1 sur 3');
  // §14.5 : un bloc sans aucune entrée nomme son absence en toutes lettres ; un
  // « 0 » au titre serait une mesure là où il faut une phrase.
  assert.equal(libelleCompte(0, 0, ''), '');
});

test('le champ de recherche DIT ce qu’il compare', () => {
  const rendu = renderRechercheEnv({ id: 'env-recherche', total: 4 });
  assert.match(rendu, /id="env-recherche"/);
  assert.match(rendu, /type="search"/);
  assert.match(rendu, /aria-describedby="env-recherche-aide"/);
  assert.match(rendu, /porte sur le\s+<strong>nom<\/strong>/);
  // Le motif, pas seulement le périmètre : sans lui, l'exploitant croit à un
  // oubli et cherche une valeur en vain.
  assert.match(rendu, /valeur d’un secret n’atteint jamais la console/);
});

test('pas de champ de recherche là où il n’y a rien à chercher', () => {
  // §14.4 : un contrôle sans objet est du bruit.
  assert.equal(renderRechercheEnv({ id: 'x', total: 0 }), '');
  assert.equal(renderRechercheEnv({ id: 'x', total: 1 }), '');
  assert.notEqual(renderRechercheEnv({ id: 'x', total: 2 }), '');
});

test('le champ compte ce que la vue PORTE, pas ce qu’elle affiche', () => {
  // L'exception du §14.4 : il reste rendu quand la frappe ne laisse rien, car
  // il est le seul moyen de sortir de l'état vide qu'il a causé.
  const rendu = renderRechercheEnv({ id: 'x', total: 7, valeur: 'INTROUVABLE' });
  assert.match(rendu, /value="INTROUVABLE"/);
});

test('la frappe est ÉCHAPPÉE avant d’atteindre l’écran', () => {
  const rendu = renderRechercheEnv({ id: 'x', total: 2, valeur: '"><script>' });
  assert.doesNotMatch(rendu, /<script>/);
  assert.match(rendu, /&quot;&gt;&lt;script&gt;/);
});

test('un bloc VIDE et un bloc VIDÉ PAR LA FRAPPE ne disent pas la même chose', () => {
  // §14.5, §14.6 : « cette nature manque » n'est pas « la frappe l'exclut ».
  const absence = { vide: 'Aucun secret propre à ce Spark.',
                    filtre: 'Aucun secret ne porte' };
  const vide = renderBlocEnv({ id: 'b', titre: 'Secrets', entrees: [], total: 0, absence,
                               rendu: () => 'TABLEAU' });
  assert.match(vide, /Aucun secret propre à ce Spark\./);

  const filtre = renderBlocEnv({ id: 'b', titre: 'Secrets', entrees: [], total: 3,
                                 recherche: 'SMTP', absence, rendu: () => 'TABLEAU' });
  // La frappe est CITÉE : sans elle, on ne sait pas ce qui exclut.
  assert.match(filtre, /Aucun secret ne porte « SMTP »\./);
  assert.doesNotMatch(filtre, /Aucun secret propre/);
  assert.match(filtre, /0 sur 3/);
});

test('le bloc porte son titre au niveau demandé, et son compte hors du titre', () => {
  // §9.3 : le niveau suit la carte qui porte le bloc. Et le compte reste HORS du
  // titre : « Secrets 3 entrées » serait le nom accessible de la section.
  const rendu = renderBlocEnv({ id: 'titre-x', niveau: 'h2', titre: 'Secrets',
                                entrees: [SECRET], total: 1,
                                absence: { vide: '', filtre: '' },
                                rendu: (e) => `<b>${e.length}</b>` });
  assert.match(rendu, /aria-labelledby="titre-x"/);
  assert.match(rendu, /<h2 id="titre-x">Secrets<\/h2>/);
  assert.match(rendu, /<span class="sous-bloc__compte">1 entrée<\/span>/);
  assert.match(rendu, /<b>1<\/b>/);
});

test('l’annonce ne parle QUE lorsqu’une frappe est en cours', () => {
  // §9.7 : une région vivante qui répète le même nombre à chaque repeinture
  // finit par n'être plus écoutée.
  assert.equal(renderAnnonceRecherche(7, 7, ''), '');
  const rendu = renderAnnonceRecherche(2, 7, 'SMTP');
  assert.match(rendu, /role="status"/);
  assert.match(rendu, /2 entrées affichées sur 7/);
});
