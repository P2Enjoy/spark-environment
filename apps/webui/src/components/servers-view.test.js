/**
 * @verifies docs/BACKLOG.md#SPK-41 · docs/DAT.md §22.4 (aucun secret),
 *           §22.4 bis (ce qu'on délègue à OpenSSH), §22.4.4 (l'épreuve informe,
 *           elle ne décide pas), §22.4.7 bis, §22.4.7 ter (l'ordre des champs) ·
 *           docs/DESIGN_SYSTEM.md §6.13, §6.14, §6.23, §6.27
 *
 * Ce que ces preuves protègent : le produit ne doit jamais AFFICHER ce qu'il ne
 * connaît pas. Une entrée par alias n'a ni utilisateur ni port, et les inventer
 * à l'écran serait pire que de ne rien montrer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderServeurs, renderEpreuve, designation, GENRES, CATALOGUE_SERVEURS_VIDE,
} from './servers-view.js';

const SSH = { name: 'prod', kind: 'ssh', host: '203.0.113.10', user: 'ubuntu',
              port: 22, remotePort: 9876 };
const ALIAS = { name: 'recette', kind: 'alias', sshHost: 'spark-recette', remotePort: 9876 };
const LOCAL = { name: 'dev', kind: 'local', host: '127.0.0.1', port: 9876 };

const ui = (surcharge = {}) => ({
  ...CATALOGUE_SERVEURS_VIDE, ...surcharge,
  values: { ...CATALOGUE_SERVEURS_VIDE.values, ...(surcharge.values ?? {}) },
});
const pret = (surcharge = {}) => renderServeurs({
  status: 'ready', servers: [SSH, ALIAS, LOCAL], current: 'prod',
  tunnels: [{ name: 'prod', state: 'ready' }], ui: ui(), ...surcharge });

// --- ce que l'écran MONTRE, et ce qu'il n'invente pas -----------------------

test('une entrée par ALIAS n’affiche ni utilisateur ni port de connexion', () => {
  // Le produit ne les connaît pas (§22.4 bis) : les afficher serait mentir.
  assert.equal(designation(ALIAS), 'Host « spark-recette »');
  assert.ok(!designation(ALIAS).includes('@'));
  assert.equal(designation(SSH), 'ubuntu@203.0.113.10:22');
  assert.equal(designation(LOCAL), '127.0.0.1:9876');
});

test('les trois genres sont nommés en français, pas en jargon', () => {
  assert.deepEqual(Object.keys(GENRES).sort(), ['alias', 'local', 'ssh']);
  const html = pret();
  for (const { label } of Object.values(GENRES)) assert.ok(html.includes(label));
});

test('le serveur COURANT est signalé, et n’a pas de bouton pour y basculer', () => {
  // Sans repérage on bascule vers celui qu'on regarde déjà, ou l'on retire
  // celui qu'on croit inactif.
  const html = pret();
  assert.match(html, /ligne--courante/);
  assert.match(html, /badge--neutral">courant/);
  assert.ok(!html.includes('data-bascule="prod"'), 'basculer vers le courant ne ferait rien');
  assert.match(html, /data-bascule="recette"/);
});

test('les serveurs sont dans un VRAI tableau', () => {
  const html = pret();
  for (const balise of ['<table>', '<thead>', '<tbody>', '<th scope="col">'])
    assert.ok(html.includes(balise), `${balise} attendu (§6.14)`);
});

// --- les états de vue (§6.13) -----------------------------------------------

test('chargement, erreur et vide sont traités explicitement', () => {
  assert.match(renderServeurs({ status: 'loading' }), /aria-busy/);
  assert.match(renderServeurs({ status: 'error', error: { message: 'inventaire illisible' } }),
               /etat-vue--erreur[\s\S]*inventaire illisible/);
  assert.match(renderServeurs({ status: 'ready', servers: [] }),
               /Aucun serveur enregistré/);
});

test('l’état VIDE propose l’ajout, parce que c’est ici que l’action existe', () => {
  // §6.13 : une action n'est proposée que si elle est pertinente. Elle l'est ici
  // — c'est le seul écran d'où l'on peut déclarer un serveur.
  const vide = renderServeurs({ status: 'ready', servers: [], ui: ui() });
  assert.match(vide, /data-ouvre="serveur"/);
  assert.match(vide, /La console n’a rien à administrer/);
});

// --- la modale et l'ordre des champs (§6.27, §22.4.7 ter) -------------------

test('la saisie passe par la MODALE de la section', () => {
  // RÉVISÉ par la modification (§22.4.7 ter) : `open` ne vaut plus un booléen
  // mais « ajout » ou le NOM du serveur édité — c'est ce qui distingue les deux
  // usages de la même modale. Ce que la preuve établit est inchangé.
  assert.ok(!pret().includes('<dialog'), 'rien tant qu’on n’a rien demandé');
  const ouvert = pret({ ui: ui({ open: 'ajout' }) });
  assert.match(ouvert, /<dialog class="modale" id="serveur"/);
  assert.match(ouvert, /id="serveur-titre">Serveurs</);
  assert.match(ouvert, /data-engage="serveur"[^>]*>Enregistrer ce serveur</s);
});

test('les champs SUIVENT le genre choisi', () => {
  // Afficher les champs des trois genres à la fois ferait remplir des champs
  // que le produit ignorera (§22.4.7 ter).
  const parAlias = pret({ ui: ui({ open: 'ajout', values: { kind: 'alias' } }) });
  assert.match(parAlias, /id="serveur-alias"/);
  assert.ok(!parAlias.includes('id="serveur-utilisateur"'), 'un alias n’a pas d’utilisateur');
  assert.ok(!parAlias.includes('id="serveur-hote"'));

  const parSsh = pret({ ui: ui({ open: 'ajout', values: { kind: 'ssh' } }) });
  assert.match(parSsh, /id="serveur-utilisateur"/);
  assert.ok(!parSsh.includes('id="serveur-alias"'));

  const enLocal = pret({ ui: ui({ open: 'ajout', values: { kind: 'local' } }) });
  assert.match(enLocal, /id="serveur-port-local"/);
  assert.ok(!enLocal.includes('id="serveur-utilisateur"'));
});

test('un alias porte quand même le port de sparkd, et dit pourquoi', () => {
  const html = pret({ ui: ui({ open: 'ajout', values: { kind: 'alias' } }) });
  assert.match(html, /id="serveur-sparkd"/);
  assert.match(html, /OpenSSH ne le connaît pas/);
});

test('les candidats du ssh_config sont PROPOSÉS, pas imposés', () => {
  // Un Host peut vivre dans un fichier inclus que la console ne lit pas.
  const avec = pret({ ui: ui({ open: 'ajout', values: { kind: 'alias' },
                               hosts: ['spark-prod', 'bastion'] }) });
  assert.match(avec, /<datalist id="serveur-hosts">/);
  assert.match(avec, /value="spark-prod"/);
  assert.match(avec, /vous pouvez aussi en saisir un autre/i);

  // Sans ssh_config lisible, le formulaire reste utilisable.
  const sans = pret({ ui: ui({ open: 'ajout', values: { kind: 'alias' }, hosts: [] }) });
  assert.ok(!sans.includes('<datalist'));
  assert.match(sans, /saisissez le nom du Host/);
});

// --- l'épreuve informe, elle ne décide pas (§22.4.4) ------------------------

test('un serveur SANS RÉPONSE peut être enregistré quand même', () => {
  // §25.1 : la machine peut être éteinte. Le dire, et ne pas bloquer.
  const html = renderEpreuve({ reachable: false, error: 'connexion refusée' });
  assert.match(html, /Sans réponse/);
  assert.match(html, /connexion refusée/);
  assert.match(html, /Vous pouvez l’enregistrer quand même/);

  const modale = pret({ ui: ui({ open: 'ajout', probe: { reachable: false, error: 'x' } }) });
  assert.ok(!/data-engage="serveur"[^>]*disabled/s.test(modale),
    'le bouton d’engagement reste ACTIF : l’épreuve informe, elle ne décide pas');
});

test('un serveur joignable mais NON PRÊT ne se confond pas avec un serveur muet', () => {
  const html = renderEpreuve({ reachable: true, healthz: { status: 200 },
                               readyz: { status: 503 } });
  assert.match(html, /Joignable/);
  assert.match(html, /« prêt » rend 503/);
});

test('sans épreuve lancée, rien n’est affiché — pas un verdict par défaut', () => {
  assert.equal(renderEpreuve(null), '');
  assert.equal(renderEpreuve(undefined), '');
});

// --- le retrait se confirme (§6.23) -----------------------------------------

test('le retrait NOMME le serveur et dit ce qui n’est PAS touché', () => {
  const html = pret({ ui: ui({ confirming: 'recette' }) });
  assert.match(html, /Retirer « recette » de la console/);
  assert.match(html, /Le serveur lui-même n’est pas touché/);
  assert.match(html, /bouton--destructif/);
  assert.match(html, /data-confirme-serveur="recette"/);
});

test('aucune confirmation n’est ouverte tant qu’on ne l’a pas demandée', () => {
  assert.ok(!pret().includes('data-confirme-serveur'));
});

test('l’écran rappelle qu’aucun secret ne vit dans le catalogue', () => {
  assert.match(pret(), /aucun secret/);
});


// --- la MODIFICATION d'une entrée existante (§22.4.7 ter) ------------------

test('chaque ligne porte son bouton de modification', () => {
  const html = pret();
  assert.match(html, /data-modifie-serveur="prod"/);
  assert.match(html, /data-modifie-serveur="recette"/);
});

test('en modification, le NOM est en lecture seule, et dit pourquoi', () => {
  // POST remplace par le nom : le changer ne renommerait rien, cela créerait une
  // seconde entrée en laissant la première — un doublon que personne n'a demandé.
  const html = pret({ ui: ui({ open: 'recette',
                               values: { name: 'recette', kind: 'alias',
                                         sshHost: 'spark-recette' } }) });
  assert.match(html, /id="serveur-nom"[^>]*readonly/s);
  assert.match(html, /renommer, c’est retirer puis redéclarer/);
});

test('en AJOUT, le nom reste saisissable', () => {
  const html = pret({ ui: ui({ open: 'ajout' }) });
  assert.ok(!/id="serveur-nom"[^>]*readonly/s.test(html));
  assert.match(html, /Minuscules, chiffres et tirets/);
});

test('la modification NOMME le serveur sur son bouton d’engagement', () => {
  // « Enregistrer ce serveur » ne dirait pas lequel, alors que la modale a été
  // ouverte depuis une ligne parmi d’autres.
  const html = pret({ ui: ui({ open: 'recette', values: { name: 'recette' } }) });
  assert.match(html, /data-engage="serveur"[^>]*>Enregistrer « recette »</s);
});

test('le GENRE reste modifiable, lui', () => {
  // Passer un serveur de ssh à alias est exactement ce qu’on veut pouvoir faire
  // quand la connexion se complique, et le nom ne change pas.
  const html = pret({ ui: ui({ open: 'prod', values: { name: 'prod', kind: 'ssh' } }) });
  assert.match(html, /id="serveur-genre"/);
  assert.ok(!/id="serveur-genre"[^>]*(readonly|disabled)/s.test(html));
});

// --- un port n'est PAS un curseur (SPK-59, DESIGN_SYSTEM.md §6.9 bis) -------

test('un port de connexion reste une SAISIE, jamais un curseur', () => {
  // C'est le contre-exemple qui fixe la regle : les bornes sont pourtant
  // connues, 1 a 65 535, mais la plage compte 65 534 crans a l'unite et aucun
  // arrondi n'est possible — un port voisin n'est pas presque le bon port.
  const html = pret({ ui: ui({ open: 'ajout' }) });
  assert.equal(/<input[^>]*type="range"/.test(html), false,
    'le §6.9 bis ne s’applique pas a un port');
  assert.match(html, /<input[^>]*type="number"[^>]*max="65535"/);
});

/* --- La clé de signature (SPK-40, docs/DAT.md §36.10.8) ------------------- */

test('le formulaire porte la cle de signature, quel que soit le GENRE', () => {
  // Signer et atteindre la Forge sont deux choses : la cle ne depend pas du
  // genre. Sans ce champ, elle ne se declarerait qu'en editant un fichier a la
  // main — exactement le defaut que SPK-41 existe pour supprimer.
  for (const kind of ['ssh', 'alias', 'local']) {
    const html = renderServeurs({
      status: 'ready', servers: [], tunnels: [],
      ui: { ...CATALOGUE_SERVEURS_VIDE, open: 'ajout',
            values: { ...CATALOGUE_SERVEURS_VIDE.values, kind } },
    });
    assert.match(html, /name="signingKey"/, kind);
    assert.match(html, /Clé de signature/, kind);
  }
});

test('l aide dit que la cle est PUBLIQUE et que le vide est normal', () => {
  // CLAUDE.md §11 : aucun secret n'entre dans l'inventaire. §14.5 : une absence
  // se nomme, pour qu'on ne cherche pas un defaut la ou il n'y en a pas.
  const html = renderServeurs({
    status: 'ready', servers: [], tunnels: [],
    ui: { ...CATALOGUE_SERVEURS_VIDE, open: 'ajout' },
  });
  assert.match(html, /<strong>publique<\/strong>/);
  assert.match(html, /la clé privée ne quitte jamais/);
  assert.match(html, /état\s+normal, pas une panne/);
});

test('la valeur deja declaree revient dans le champ en MODIFICATION', () => {
  // §22.4.7 ter : la modale de modification est PRE-REMPLIE. Un champ vide y
  // ferait effacer la cle a chaque enregistrement.
  const html = renderServeurs({
    status: 'ready', servers: [], tunnels: [],
    ui: { ...CATALOGUE_SERVEURS_VIDE, open: 'prod',
          values: { ...CATALOGUE_SERVEURS_VIDE.values, name: 'prod',
                    signingKey: '/home/x/.ssh/id_ed25519.pub' } },
  });
  assert.match(html, /value="\/home\/x\/\.ssh\/id_ed25519\.pub"/);
});
