/**
 * @verifies docs/BACKLOG.md#SPK-171 · docs/DAT.md §70.5 (chaque état de
 *           l'onglet ; lecture seule ; le relevé de démonstration se voit) ·
 *           §70.6 (les pools à mettre à niveau renvoient à l'installation) ·
 *           docs/DESIGN_SYSTEM.md §6.13, §14.5, §14.6 · docs/DESIGN_SYSTEM_APP.md SPK-DS-46
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderMisesAJour, SYSTEME_VIDE } from './forge-systeme.js';
import { ONGLETS_FORGE } from './forge-images.js';

const A_JOUR = {
  source: 'hote', releve_a: '2026-11-18T10:30:00+00:00', os: 'Ubuntu 26.04.1 LTS',
  noyau: '7.0.0-43-generic',
  mises_a_jour: { total: 0, securite: 0, paquets: [], paquets_rendus: 0, liste_relue_a: null },
  redemarrage: { requis: false, paquets: [] },
  version: { connue: true, disponible: null },
  zfs: { a_niveau: [] },
};

const EN_ATTENTE = {
  ...A_JOUR, source: 'fake',
  mises_a_jour: { total: 3, securite: 1, paquets_rendus: 2, liste_relue_a: '2026-11-18T07:34:00+00:00',
    paquets: [
      { nom: 'openssl', installee: '3.5.2-1', proposee: '3.5.2-1.1', suite: 'resolute-security', securite: true },
      { nom: 'incus', installee: '1:7.6', proposee: '1:7.7', suite: 'resolute', securite: false },
    ] },
  redemarrage: { requis: true, paquets: ['linux-image-7.0.0-44-generic'] },
  version: { connue: true, disponible: '26.10' },
  zfs: { a_niveau: [{ pool: 'spark', fonctionnalites: ['fast_dedup', 'longname'], manuelles: [] }] },
};

const pret = (donnees) => renderMisesAJour({ ...SYSTEME_VIDE, status: 'pret', donnees });

test('l’onglet existe dans les sections de la Forge, après Supervision', () => {
  const hrefs = ONGLETS_FORGE.map(([h]) => h);
  assert.ok(hrefs.includes('#/forge/mises-a-jour'));
  assert.equal(hrefs.indexOf('#/forge/mises-a-jour'), hrefs.indexOf('#/forge/supervision') + 1);
});

test('le chargement et l’erreur sont des états nommés, sans bouton Relire dans l’en-tête', () => {
  const chargement = renderMisesAJour(SYSTEME_VIDE);
  assert.match(chargement, /aria-busy="true"/);
  assert.match(chargement, /Lecture de l’état du système/);
  const erreur = renderMisesAJour({ status: 'erreur', error: 'tunnel <rompu>', donnees: null });
  assert.match(erreur, /role="alert"/);
  assert.match(erreur, /tunnel &lt;rompu&gt;/);
  assert.match(erreur, /Réessayer/);
});

test('une Forge à jour le dit, et nomme la date de liste inconnue', () => {
  const html = pret(A_JOUR);
  assert.match(html, /Aucune mise à jour en attente/);
  assert.match(html, /badge--success/);
  assert.match(html, /Date de la liste des paquets inconnue/);
  assert.match(html, /Relevé le <span class="technique">2026-11-18 10:30<\/span>/);
  assert.match(html, /non requis/);
  assert.match(html, /Aucun pool n’a de fonctionnalité à activer/);
  assert.doesNotMatch(html, /démonstration/);
  assert.match(html, /data-action="relire-systeme"/);
});

test('des mises à jour en attente : résumé, sécurité en badge, partiel dit, commande donnée', () => {
  const html = pret(EN_ATTENTE);
  assert.match(html, /3 mises à jour en attente, dont 1 de sécurité/);
  assert.match(html, /badge--danger/);
  assert.match(html, /Les 2 premiers paquets sur 3/);
  assert.match(html, /sudo apt upgrade/);
  assert.match(html, /<td class="technique">openssl<\/td>/);
  assert.ok(html.indexOf('openssl') < html.indexOf('>incus<'), 'la sécurité en tête');
  assert.match(html, /redémarrage requis/);
  assert.match(html, /linux-image-7\.0\.0-44-generic/);
  assert.match(html, /Ubuntu 26\.10 disponible/);
  assert.match(html, /2 fonctionnalités à activer/);
  assert.match(html, /href="#\/forge"/, 'renvoi à l’installation');
});

test('un relevé de démonstration se VOIT', () => {
  assert.match(pret(EN_ATTENTE), /relevé de démonstration/);
});

test('une source absente est nommée, jamais rendue « undefined »', () => {
  const html = pret({ ...A_JOUR, os: null, noyau: null, version: { connue: false, disponible: null },
                      mises_a_jour: { ...A_JOUR.mises_a_jour, total: 4, securite: null, paquets: [] } });
  assert.match(html, /non relevée/);
  assert.match(html, /non relevé/);
  assert.match(html, /part de sécurité non relevée/);
  assert.match(html, /seul le nombre est connu/);
  assert.doesNotMatch(html, /undefined|null/);
});
