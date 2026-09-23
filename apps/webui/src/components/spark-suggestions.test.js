/**
 * @verifies docs/BACKLOG.md#SPK-105 · docs/DAT.md §55.3.1 (la grammaire des
 * routes), §55.5 (consulter ne consomme pas, accepter vide), §55.8 (l'analyse
 * vit dans la console), §55.9 · docs/BACKLOG.md#SPK-107 · docs/DAT.md §55.3.3
 * (le vide est une DEMANDE), §55.9.1 (le champ, le bouton désactivé, ce qui
 * survit au repli) · docs/DESIGN_SYSTEM.md §14.5, §14.6, §1.3, §9.9 ·
 * docs/DESIGN_SYSTEM_APP.md SPK-DS-23, SPK-DS-28
 * @verifies docs/BACKLOG.md#SPK-112 · docs/DAT.md §55.9.2 (la relecture d'une
 * route porte sa case TLS, et une ligne proposée sans TLS le dit) ·
 * docs/DESIGN_SYSTEM_APP.md SPK-DS-31
 *
 * Ce que ces preuves gardent : l'écran montre CE QU'IL A COMPRIS — pas le texte
 * brut —, une ligne illisible est nommée sans que la proposition soit perdue, et
 * le chemin du fichier décide de la nature proposée sans décider à la place du
 * propriétaire.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROPOSITIONS_VIDE, analyserRoutes, comprendre, enAttente, estDemande,
         entreesAppliquees, estTls, renderPropositions, valeurAppliquee }
  from './spark-suggestions.js';

const SUGG = (champs = {}) => ({
  kind: 'variables', nature: 'entrees', present: true,
  title: 'Variables d’environnement souhaitées', expected: '…',
  path: '/etc/spark/env.?', target: '/etc/spark/env',
  body: 'REDIS_URL=redis://cache:6379\nLOG_LEVEL=debug',
  sha256: 'abc123', ...champs,
});

const ui = (champs = {}) => ({
  ...PROPOSITIONS_VIDE, status: 'pret', cellLue: true,
  items: [SUGG()], ...champs,
});

// --- la grammaire des routes (§55.3.1) --------------------------------------

test('une route se lit « domaine port [tls|clair] », et TLS est le défaut', () => {
  const { entrees, refus } = analyserRoutes(
    '# un commentaire\nsso.exemple.fr 8080\napi.exemple.fr 3000 clair\n');
  assert.equal(refus.length, 0);
  assert.deepEqual(entrees.map((e) => [e.domaine, e.port, e.tls]), [
    ['sso.exemple.fr', 8080, true],
    ['api.exemple.fr', 3000, false],
  ]);
});

test('une ligne fautive est NOMMÉE avec son numéro, et n’emporte pas les autres', () => {
  const { entrees, refus } = analyserRoutes(
    'bon.exemple.fr 8080\npasdeport.exemple.fr\nmauvais 1234\nx.exemple.fr 99999\n'
    + 'y.exemple.fr 80 peutetre\n');
  assert.equal(entrees.length, 1, 'la ligne valide survit aux quatre autres');
  assert.deepEqual(refus.map((r) => r.ligne), [2, 3, 4, 5]);
  assert.match(refus[0].raison, /domaine, un port/);
  assert.match(refus[1].raison, /ne ressemble pas à un nom de domaine/);
  assert.match(refus[2].raison, /entre 1 et 65535/);
  assert.match(refus[3].raison, /ni « tls » ni « clair »/);
});

test('un joker est accepté : le §18.3 bis en fait un domaine légitime', () => {
  const { entrees, refus } = analyserRoutes('*.exemple.fr 8080\n');
  assert.equal(refus.length, 0);
  assert.equal(entrees[0].domaine, '*.exemple.fr');
});

// --- le chemin dit la nature, l'écran laisse le dernier mot (§55.3) ---------

test('ce qui vient de secrets.? est PRÉ-COCHÉ secret, pas décidé', () => {
  const secrets = comprendre(SUGG({ kind: 'secrets', body: 'TOKEN=abc' }));
  assert.equal(secrets.entrees[0].secret, true);

  const variables = comprendre(SUGG({ body: 'TOKEN=abc' }));
  assert.equal(variables.entrees[0].secret, false);
});

test('une proposition ABSENTE ne s’analyse pas et ne rend rien', () => {
  assert.deepEqual(comprendre(SUGG({ present: false })), { entrees: [], refus: [] });
  assert.equal(renderPropositions(ui({
    items: [SUGG({ present: false })] }), ['variables']), '');
});

// --- ce que la facette montre (§55.9) ---------------------------------------

test('chaque facette ne montre QUE les natures qui lui appartiennent', () => {
  const etat = ui({ items: [SUGG(), SUGG({ kind: 'routes', body: 'a.exemple.fr 80' })] });
  const env = renderPropositions(etat, ['variables', 'secrets']);
  assert.match(env, /Variables proposées/);
  assert.doesNotMatch(env, /Routes proposées/);

  const routes = renderPropositions(etat, ['routes']);
  assert.match(routes, /Routes proposées/);
  assert.doesNotMatch(routes, /Variables proposées/);
});

test('la bannière compte, nomme le fichier, et dit que lire ne consomme pas', () => {
  const rendu = renderPropositions(ui(), ['variables']);
  assert.match(rendu, /2 variable\(s\) proposée\(s\)/);
  assert.match(rendu, /\/etc\/spark\/env\.\?/);
  assert.match(rendu, /la lire ne l’efface pas/);
  // Le produit ne les a pas vérifiées : l'écran le dit avant de les montrer.
  assert.match(rendu, /n’a pas vérifié ces valeurs/);
});

test('rien n’est rendu quand aucune proposition n’attend', () => {
  assert.equal(renderPropositions(ui({ items: [] }), ['variables']), '');
  assert.equal(renderPropositions(PROPOSITIONS_VIDE, ['variables']), '');
});

test('le compte rendu SURVIT à la proposition qu’il décrit (§1.3, §6.11)', () => {
  // Vu à l'écran : une fois la proposition appliquée, son bloc disparaît — et
  // le compte rendu avec lui. L'exploitant venait d'agir et n'avait aucune
  // confirmation.
  const rendu = renderPropositions(ui({
    items: [SUGG({ present: false })],
    issue: { kind: 'variables', ok: true,
             message: 'Proposition appliquée, et le fichier de la cellule est vidé.' },
  }), ['variables']);
  assert.match(rendu, /class="succes"[^>]*role="status"/);
  assert.match(rendu, /Proposition appliquée/);
  // Et rien de ce qui ne sert plus : ni relecture, ni boutons.
  assert.doesNotMatch(rendu, /data-sugg-appliquer/);
  assert.doesNotMatch(rendu, /data-sugg-ouvrir/);
});

test('un compte rendu ne s’affiche PAS sur la facette d’une autre nature', () => {
  const rendu = renderPropositions(ui({
    items: [SUGG({ present: false })],
    issue: { kind: 'variables', ok: true, message: 'Appliquée.' },
  }), ['routes']);
  assert.equal(rendu, '');
});

// --- la relecture (§43.10.2, SPK-DS-23) -------------------------------------

test('la relecture montre CE QUI A ÉTÉ COMPRIS, pas le texte brut', () => {
  const rendu = renderPropositions(ui({ ouvert: 'variables' }), ['variables']);
  assert.match(rendu, /<div class="tableau-defilant">/);
  // §14.2 : ce qui sort de l'écran est ANNONCÉ, pas seulement ombré — depuis
  // SPK-107, ce peut être un champ que le geste attend.
  assert.match(rendu, /class="tableau-indice">Le tableau défile/);
  assert.match(rendu, /REDIS_URL/);
  assert.match(rendu, /redis:\/\/cache:6379/);
  // Une case par ligne, et une case « secret » par ligne (§43.10.2).
  assert.match(rendu, /data-sugg-garder="variables" data-ligne="1"/);
  assert.match(rendu, /data-sugg-secret="variables" data-ligne="1"/);
});

test('une ligne ÉCARTÉE se décoche et le bouton compte les retenues', () => {
  const rendu = renderPropositions(ui({
    ouvert: 'variables', exclues: { variables: new Set([2]) } }), ['variables']);
  assert.match(rendu, /Ajouter les 1 retenue\(s\)/);
  assert.match(rendu, /data-ligne="2"(?![^>]*checked)/);
});

test('tout écarter DÉSACTIVE l’ajout mais laisse le refus (§9.9)', () => {
  const rendu = renderPropositions(ui({
    ouvert: 'variables', exclues: { variables: new Set([1, 2]) } }), ['variables']);
  assert.match(rendu, /data-sugg-appliquer="variables"[^>]*disabled/);
  assert.doesNotMatch(rendu, /data-sugg-refuser="variables"[^>]*disabled/);
});

test('une ligne illisible est nommée, et ne fait pas perdre les bonnes', () => {
  const rendu = renderPropositions(ui({
    ouvert: 'variables',
    items: [SUGG({ body: 'BON=1\nsans_egal\n' })] }), ['variables']);
  assert.match(rendu, /BON/);
  assert.match(rendu, /1 ligne\(s\) refusée\(s\)/);
  assert.match(rendu, /ligne 2/);
  // §55.5 : le refus du produit ne consomme pas — l'écran le dit, sinon on
  // refuserait la proposition entière pour corriger une ligne.
  assert.match(rendu, /le refuser ici l’effacerait/);
});

test('une proposition ENTIÈREMENT illisible le dit au lieu d’un tableau vide', () => {
  const rendu = renderPropositions(ui({
    ouvert: 'variables', items: [SUGG({ body: 'n’importe quoi\n' })] }), ['variables']);
  assert.match(rendu, /Rien de lisible dans cette proposition/);
  assert.match(rendu, /data-sugg-appliquer="variables"[^>]*disabled/);
});

test('l’écran dit que trancher VIDE le fichier, et pourquoi', () => {
  const rendu = renderPropositions(ui({ ouvert: 'variables' }), ['variables']);
  assert.match(rendu, /le fichier de la cellule\s*\n?\s*est vidé/);
  assert.match(rendu, /refusé, pas ajourné/);
  assert.match(rendu, /son auteur apprend qu’une décision a été prise/);
});

test('le compte rendu d’un refus du produit est un REFUS (§1.3)', () => {
  const rendu = renderPropositions(ui({
    issue: { kind: 'variables', ok: false,
             message: '« pris.exemple.fr » est déjà routé.' } }), ['variables']);
  assert.match(rendu, /class="refus"[^>]*role="alert"/);
  assert.match(rendu, /déjà routé/);
});

test('rien de ce qui vient de la cellule n’est injecté sans échappement', () => {
  const rendu = renderPropositions(ui({
    ouvert: 'variables',
    items: [SUGG({ body: 'X=<script>alert(1)</script>' })] }), ['variables']);
  assert.doesNotMatch(rendu, /<script>alert/);
  assert.match(rendu, /&lt;script&gt;/);
});

// --- une valeur DEMANDÉE (SPK-107, §55.3.3, §55.9.1) -------------------------

const DEMANDE = () => SUGG({
  body: '#Commentaire pour la variable à saisir\nVAR=\n'
      + '\n#C’est le nombre max de concurrence\nMAXPOOL=5\n',
});
const ouverte = (champs = {}) => ui({
  ouvert: 'variables', items: [DEMANDE()], ...champs });

test('une valeur vide se rend en CHAMP, et le dit ; une valeur pleine non', () => {
  const rendu = renderPropositions(ouverte(), ['variables']);
  assert.match(rendu, /data-sugg-valeur="variables" data-ligne="2"/);
  // La phrase ne se repeint pas sous les doigts (§14.3) : elle reste donc VRAIE
  // une fois le champ rempli — « à saisir » se démentait dès la première touche.
  assert.match(rendu, /valeur demandée : son auteur ne la connaît pas/);
  // §14.6 : la ligne qui porte une valeur n'ouvre AUCUN champ.
  assert.doesNotMatch(rendu, /data-sugg-valeur="variables" data-ligne="5"/);
  assert.match(rendu, /<span class="technique">5<\/span>/);
});

test('l’étiquette se lit sous le nom et est RATTACHÉE au champ', () => {
  const rendu = renderPropositions(ouverte(), ['variables']);
  assert.match(rendu, /id="sugg-note-variables-2">Commentaire pour la variable à saisir/);
  assert.match(rendu, /aria-describedby="sugg-note-variables-2"/);
  // Au clavier, on entend ce qu'il faut taper EN ENTRANT dans le champ.
  const champ = /<input type="text"[^>]*data-ligne="2"[^>]*>/.exec(rendu)[0];
  assert.match(champ, /aria-describedby/);
});

test('une ligne retenue qui attend sa valeur DÉSACTIVE l’ajout, avec sa raison', () => {
  const rendu = renderPropositions(ouverte(), ['variables']);
  assert.match(rendu, /data-sugg-appliquer="variables"[^>]*disabled/);
  assert.match(rendu, /1 valeur\(s\) demandée\(s\) encore vide\(s\)\s+: VAR/);
  // §9.9 : l'action reste VISIBLE, et le refus global reste offert.
  assert.match(rendu, /Ajouter les 2 retenue\(s\)/);
  assert.doesNotMatch(rendu, /data-sugg-refuser="variables"[^>]*disabled/);
});

test('ÉCARTER la demande lève la retenue : aucune autre sortie n’est nécessaire', () => {
  const rendu = renderPropositions(
    ouverte({ exclues: { variables: new Set([2]) } }), ['variables']);
  assert.doesNotMatch(rendu, /data-sugg-appliquer="variables"[^>]*disabled/);
  assert.match(rendu, /Ajouter les 1 retenue\(s\)/);
  assert.match(rendu, /data-sugg-attente="variables"><\/p>/,
    'plus rien n’attend : l’indication ne laisse pas un fait périmé à l’écran');
});

test('la valeur SAISIE survit à la repeinture, et débloque l’ajout', () => {
  const etat = ouverte({ valeurs: { variables: new Map([[2, 'p@ss w0rd']]) } });
  const rendu = renderPropositions(etat, ['variables']);
  assert.match(rendu, /value="p@ss w0rd"/);
  assert.doesNotMatch(rendu, /data-sugg-appliquer="variables"[^>]*disabled/);
  assert.equal(enAttente('variables', comprendre(DEMANDE()).entrees, etat).length, 0);
});

test('un BLANC seul ne remplit pas une demande', () => {
  const etat = ouverte({ valeurs: { variables: new Map([[2, '   ']]) } });
  assert.equal(enAttente('variables', comprendre(DEMANDE()).entrees, etat).length, 1);
  assert.match(renderPropositions(etat, ['variables']),
               /data-sugg-appliquer="variables"[^>]*disabled/);
});

test('c’est la valeur SAISIE qui part au serveur, jamais le vide', () => {
  const etat = ouverte({ valeurs: { variables: new Map([[2, 'secret-tapé']]) } });
  const [demande, pleine] = comprendre(DEMANDE()).entrees;
  assert.equal(valeurAppliquee(etat, 'variables', demande), 'secret-tapé');
  // Ce qui n'est pas une demande n'est pas touché : on applique ce qui a été relu.
  assert.equal(valeurAppliquee(etat, 'variables', pleine), '5');

  const envoyees = entreesAppliquees(etat, 'variables',
                                     comprendre(DEMANDE()).entrees);
  assert.deepEqual(envoyees, [
    { name: 'VAR', value: 'secret-tapé', secret: false },
    { name: 'MAXPOOL', value: '5', secret: false },
  ]);
  // L'étiquette n'entre JAMAIS au registre : elle explique la demande, elle ne
  // fait pas partie de la valeur (§55.3.3).
  assert.ok(!JSON.stringify(envoyees).includes('Commentaire'));
});

test('une ligne ÉCARTÉE ne part pas, et une case cochée décide du secret', () => {
  const etat = ouverte({ exclues: { variables: new Set([5]) },
                         secrets: { variables: new Set([2]) },
                         valeurs: { variables: new Map([[2, 'v']]) } });
  assert.deepEqual(entreesAppliquees(etat, 'variables', comprendre(DEMANDE()).entrees),
                   [{ name: 'VAR', value: 'v', secret: true }]);
});

test('une ROUTE incomplète n’ouvre aucun champ : elle est refusée (§55.3.1)', () => {
  const routes = SUGG({ kind: 'routes', body: 'a.exemple.fr 80\nsansport.exemple.fr\n' });
  assert.equal(estDemande('routes', { valeur: '' }), false);
  const rendu = renderPropositions(
    ui({ ouvert: 'routes', items: [routes] }), ['routes']);
  assert.doesNotMatch(rendu, /data-sugg-valeur/);
  assert.match(rendu, /1 ligne\(s\) refusée\(s\)/);
});

test('un secret DEMANDÉ se saisit comme une variable, en clair (§43.10.2)', () => {
  const etat = ui({ ouvert: 'secrets',
                    items: [SUGG({ kind: 'secrets', path: '/run/spark/secrets.?',
                                   body: '#Le mot de passe SMTP\nSMTP_PASSWORD=\n' })],
                    valeurs: { secrets: new Map([[2, 'en-clair']]) } });
  const rendu = renderPropositions(etat, ['secrets']);
  assert.match(rendu, /<input type="text"[^>]*data-sugg-valeur="secrets"/,
    'la masquer empêcherait de vérifier sa frappe sans rien protéger');
  assert.match(rendu, /value="en-clair"/);
  // Et elle reste PRÉ-COCHÉE secrète, parce que le chemin le déclare (§55.3).
  assert.match(rendu, /data-sugg-secret="secrets" data-ligne="2"\s+checked/);
});

// --- la case TLS d'une route (SPK-112, §55.9.2) -----------------------------

const ROUTES_MIXTES = () => SUGG({
  kind: 'routes', path: '/etc/spark/routes.?', target: '/etc/spark/routes',
  body: 'crm.exemple.fr 8080 clair\napi.exemple.fr 3000\n',
});

test('chaque route porte une case TLS, PRÉ-COCHÉE d’après la proposition', () => {
  const rendu = renderPropositions(
    ui({ ouvert: 'routes', items: [ROUTES_MIXTES()] }), ['routes']);
  // `clair` : décochée ; sans dernier mot : cochée (le défaut est `tls`).
  assert.match(rendu, /data-sugg-tls="routes" data-ligne="1"\s+aria-label/);
  assert.match(rendu, /data-sugg-tls="routes" data-ligne="2"\s+checked/);
  assert.match(rendu, /aria-label="Servir crm\.exemple\.fr en TLS"/);
  // La colonne ne dit plus seulement « en clair » : elle se coche.
  assert.doesNotMatch(rendu, /<td>en clair<\/td>/);
});

test('une route proposée SANS TLS le dit sous sa case, et l’avertissement la compte', () => {
  const rendu = renderPropositions(
    ui({ ouvert: 'routes', items: [ROUTES_MIXTES()] }), ['routes']);
  assert.match(rendu, /id="sugg-tls-note-routes-1">proposée sans TLS : http:\/\/, sans\s+certificat/);
  // La mention est RATTACHÉE à la case : au clavier, on l'entend en y entrant.
  assert.match(rendu, /data-ligne="1"\s+aria-label="[^"]*" aria-describedby="sugg-tls-note-routes-1"/);
  assert.doesNotMatch(rendu, /sugg-tls-note-routes-2/, 'une ligne en TLS ne porte rien');
  assert.match(rendu, /<p class="avertissement" role="status"><strong>1 route\(s\)\s+proposée\(s\) sans TLS<\/strong> : crm\.exemple\.fr\./);
});

test('cocher TLS ne change NI la mention NI l’avertissement : ils disent la demande', () => {
  // §14.3 : rien ne se repeint au clic. Une phrase qui suivrait la case se
  // démentirait sous les doigts — celle-ci reste vraie après le geste.
  const coche = renderPropositions(ui({ ouvert: 'routes', items: [ROUTES_MIXTES()],
                                        tls: { routes: new Set([1, 2]) } }), ['routes']);
  assert.match(coche, /data-sugg-tls="routes" data-ligne="1"\s+checked/);
  assert.match(coche, /proposée sans TLS/);
  assert.match(coche, /1 route\(s\)\s+proposée\(s\) sans TLS/);
});

test('aucun avertissement TLS quand toutes les routes le demandent, ni ailleurs', () => {
  const tout = SUGG({ kind: 'routes', body: 'a.exemple.fr 8080\nb.exemple.fr 80 tls\n' });
  assert.doesNotMatch(renderPropositions(ui({ ouvert: 'routes', items: [tout] }), ['routes']),
                      /sans TLS/);
  // Les variables n'ont pas de TLS.
  assert.doesNotMatch(renderPropositions(ui({ ouvert: 'variables' }), ['variables']),
                      /data-sugg-tls/);
});

test('c’est la case TELLE QU’ELLE EST COCHÉE qui part au serveur', () => {
  const { entrees } = comprendre(ROUTES_MIXTES());
  // Personne n'a touché : la proposition fait foi.
  assert.deepEqual(entreesAppliquees(ui(), 'routes', entrees), [
    { domain: 'crm.exemple.fr', port: 8080, tls: false },
    { domain: 'api.exemple.fr', port: 3000, tls: true },
  ]);
  // Le propriétaire coche TLS sur la première, et le retire de la seconde.
  assert.deepEqual(entreesAppliquees(ui({ tls: { routes: new Set([1]) } }), 'routes', entrees), [
    { domain: 'crm.exemple.fr', port: 8080, tls: true },
    { domain: 'api.exemple.fr', port: 3000, tls: false },
  ]);
  assert.equal(estTls(ui(), 'routes', 1, false), false);
  assert.equal(estTls(ui({ tls: { routes: new Set([1]) } }), 'routes', 1, false), true);
});
