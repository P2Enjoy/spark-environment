/**
 * @spec docs/BACKLOG.md#SPK-154 · docs/DAT.md §44.9.8
 * @verifies docs/BACKLOG.md#SPK-154 · docs/DAT.md §44.9.8 (le bloc « Se
 *           connecter en SSH ») · docs/DESIGN_SYSTEM_APP.md SPK-DS-42 (une
 *           commande d'une ligne se montre, son bouton nomme le compte, « copiée »
 *           sous la seule ligne copiée), SPK-DS-21 et SPK-DS-24 (l'absence de
 *           seconde porte se nomme) · docs/DESIGN_SYSTEM.md §1.3, §1.4, §14.5,
 *           §14.6
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderConnexionSsh } from './spark-acces.js';
import { renderSparkDetail } from './spark-detail.js';
import { DOSSIER_VIDE } from './spark-dossier.js';

const SPARK = {
  id: 's1', name: 'boutique', state: 'running', incus_name: 'spark-boutique',
  ipv4_address: '10.77.0.16', image: 'images:debian/13', docker_enabled: 1,
  allowed_commands: [], protected: 0,
};

const ROOT = { user: 'root', role: 'administrer la cellule',
               detail: 'installer des paquets', command: 'ssh -J ops@forge.test:2222 root@10.77.0.16' };
const DOCKER = { user: 'spark-docker', role: 'faire tourner la pile',
                 detail: '`docker` y répond', command: 'ssh -J ops@forge.test:2222 spark-docker@10.77.0.16' };

const pret = (extra = {}) => ({ ...DOSSIER_VIDE, status: 'pret', texte: '# Dossier',
                                ssh: [ROOT, DOCKER], modeDocker: 'rootless', ...extra });

test('en rootless, une ligne par porte, root d’abord, chaque commande VISIBLE', () => {
  const html = renderConnexionSsh(SPARK, pret());
  assert.match(html, /Se connecter en SSH/);
  const iRoot = html.indexOf('ssh -J ops@forge.test:2222 root@10.77.0.16');
  const iDocker = html.indexOf('ssh -J ops@forge.test:2222 spark-docker@10.77.0.16');
  assert.ok(iRoot > 0 && iDocker > iRoot, 'root d’abord, puis spark-docker');
  // SPK-DS-42 : la commande se montre, elle n'est pas repliée dans un details.
  assert.doesNotMatch(html, /<details/);
  // Chaque porte DIT à quoi elle sert (SPK-DS-21), en court.
  assert.match(html, /administrer la cellule/);
  assert.match(html, /faire tourner la pile/);
  // La commande est sélectionnable au clavier, en chasse fixe.
  assert.match(html, /<pre class="fragment technique commande-ssh__ligne" tabindex="0"/);
  // Aucune phrase d'absence : il y a deux portes.
  assert.doesNotMatch(html, /qu’une porte|jamais été relevé/);
});

test('chaque bouton NOMME le compte qu’il copie', () => {
  const html = renderConnexionSsh(SPARK, pret());
  assert.match(html, /data-ssh-copie="root"[^>]*aria-label="Copier la commande SSH de root"/);
  assert.match(html, /data-ssh-copie="spark-docker"[^>]*aria-label="Copier la commande SSH de spark-docker"/);
});

test('« copiée » s’écrit sous la SEULE ligne copiée, et le refus renvoie à la sélection', () => {
  const ok = renderConnexionSsh(SPARK, pret({
    copieSsh: { user: 'spark-docker', ok: true, message: 'Commande de spark-docker copiée.' } }));
  assert.equal(ok.match(/role="status"/g)?.length, 1);
  const ligneDocker = ok.slice(ok.indexOf('data-ssh-copie="spark-docker"'));
  assert.match(ligneDocker, /class="succes" role="status">Commande de spark-docker copiée/);
  const ligneRoot = ok.slice(0, ok.indexOf('data-ssh-copie="spark-docker"'));
  assert.doesNotMatch(ligneRoot, /copiée/);

  const refus = renderConnexionSsh(SPARK, pret({
    copieSsh: { user: 'root', ok: false, message: 'Copie refusée : sélectionnez la commande.' } }));
  assert.match(refus, /class="avertissement" role="status">Copie refusée/);
});

test('une seule porte : l’absence de la seconde se NOMME, avec les mots du terminal', () => {
  const enracine = renderConnexionSsh(SPARK, pret({ ssh: [ROOT], modeDocker: 'enracine' }));
  assert.match(enracine, /amorcé en mode <strong>enraciné<\/strong>/);
  assert.equal(enracine.match(/data-ssh-copie=/g)?.length, 1);

  const jamais = renderConnexionSsh(SPARK, pret({ ssh: [ROOT], modeDocker: null }));
  assert.match(jamais, /n’a jamais été relevé\. Amorcez-le/);

  const sansDocker = renderConnexionSsh({ ...SPARK, docker_enabled: 0 },
                                        pret({ ssh: [ROOT], modeDocker: null }));
  assert.match(sansDocker, /c’est définitif/);
  assert.doesNotMatch(sansDocker, /Amorcez-le/);
});

test('sans commande composable, une phrase dit pourquoi — aucun bouton qui ne copierait rien', () => {
  const html = renderConnexionSsh(SPARK, pret({
    ssh: [{ ...ROOT, command: null }, { ...DOCKER, command: null }] }));
  assert.doesNotMatch(html, /data-ssh-copie/);
  assert.doesNotMatch(html, /<pre/);
  assert.match(html, /n’a pas pu être composée/);
  assert.match(html, /onglet <em>Clés<\/em>/);
});

test('trois états avant la réponse : en cours, sans cellule, lecture échouée (§14.6)', () => {
  const enCours = renderConnexionSsh(SPARK, { ...DOSSIER_VIDE, status: 'chargement' });
  assert.match(enCours, /Composition des commandes…/);
  assert.match(enCours, /aria-busy="true"/);

  const absent = renderConnexionSsh({ ...SPARK, incus_name: null, ipv4_address: null },
                                    { ...DOSSIER_VIDE, status: 'absent' });
  assert.match(absent, /pas encore de cellule/);

  const erreur = renderConnexionSsh(SPARK, { ...DOSSIER_VIDE, status: 'erreur',
                                             message: 'sparkd injoignable' });
  assert.match(erreur, /role="alert"/);
  assert.match(erreur, /sparkd injoignable/);
  for (const html of [enCours, absent, erreur]) {
    assert.doesNotMatch(html, /data-ssh-copie/);
  }
});

test('une valeur venue du serveur est ÉCHAPPÉE', () => {
  const html = renderConnexionSsh(SPARK, pret({
    ssh: [{ ...ROOT, role: '<img src=x>', command: 'ssh root@<b>' }] }));
  assert.doesNotMatch(html, /<img src=x>|<b>/);
  assert.match(html, /&lt;img src=x&gt;/);
});

test('le bloc vit dans la section Accès de la facette Infos, sous l’adresse', () => {
  const html = renderSparkDetail({ status: 'ready', spark: SPARK, facette: '',
                                   dossier: pret() });
  const acces = html.slice(html.indexOf('id="titre-acces"'));
  const fin = acces.indexOf('</section>');
  const section = acces.slice(0, fin);
  assert.ok(section.indexOf('Adresse privée') < section.indexOf('Se connecter en SSH'));
  assert.match(section, /data-ssh-copie="spark-docker"/);
  assert.match(section, /href="#\/manuel\/M6"/);
});
