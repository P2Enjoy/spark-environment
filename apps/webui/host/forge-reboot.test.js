/**
 * @verifies docs/BACKLOG.md#SPK-87 · docs/DAT.md §51.1 (ce que le geste REFUSE),
 *           §51.2 (le relevé), §51.4 (par où il passe)
 *
 * Ce que ces preuves gardent : le refus. Un redémarrage vers un noyau dépourvu
 * de module ZFS laisse le pool indisponible, donc tous les Sparks du locataire à
 * terre — et cela ne se voit qu'après, quand la console a perdu le contact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  lireReleve, rebootSshArgs, executerSurLaForge, RELEVE_SCRIPT, REBOOT_SCRIPT,
  ForgeRebootError,
} from './forge-reboot.js';

const SAIN = 'courant=7.0.0-15-generic\ncible=7.0.0-30-generic\nzfs=present\nrequis=oui\n';

test('un noyau SANS module ZFS interdit le redémarrage', () => {
  // §51.1 : la seule condition de refus, et elle ne se clique pas.
  const vu = lireReleve(
    'courant=7.0.0-15-generic\ncible=7.0.0-31-generic\nzfs=absent\nrequis=oui\n');
  assert.equal(vu.autorise, false);
  assert.equal(vu.refus.code, 'zfs_absent');
  assert.match(vu.refus.message, /7\.0\.0-31-generic/, 'le refus NOMME le noyau en cause');
  assert.match(vu.refus.message, /pool/, 'et dit ce que cela coûterait');
});

test('un relevé MUET refuse aussi : on ne redémarre pas sur un doute', () => {
  // §31.2 appliqué ici : « pas mesuré » n'est pas « mesuré sain ». Conclure au
  // succès d'une absence de réponse coûterait le pool.
  for (const brut of ['', 'courant=7.0.0-15\n', null]) {
    const vu = lireReleve(brut);
    assert.equal(vu.autorise, false, `« ${brut} » ne doit pas autoriser`);
    assert.equal(vu.refus.code, 'zfs_absent');
  }
});

test('le relevé rend les TROIS lignes qui décident (§51.2)', () => {
  const vu = lireReleve(SAIN);
  assert.equal(vu.noyauCourant, '7.0.0-15-generic');
  assert.equal(vu.noyauCible, '7.0.0-30-generic');
  assert.equal(vu.redemarrageRequis, true);
  assert.equal(vu.autorise, true);
  assert.equal(vu.refus, null);
});

test('un redémarrage NON requis reste autorisé, et se distingue', () => {
  // Ce n'est pas un refus : c'est une conséquence qu'on accepte ou non.
  const vu = lireReleve(
    'courant=7.0.0-30-generic\ncible=7.0.0-30-generic\nzfs=present\nrequis=non\n');
  assert.equal(vu.autorise, true);
  assert.equal(vu.redemarrageRequis, false);
});

test('le noyau visé est le plus RÉCENT installé, pas celui qui tourne', () => {
  // Vérifier le module ZFS du noyau courant rassurerait sur exactement le cas
  // qu'on veut attraper : c'est l'AUTRE qui va démarrer.
  assert.match(RELEVE_SCRIPT, /ls -1 \/lib\/modules/);
  assert.match(RELEVE_SCRIPT, /sort -V \| tail -1/);
  assert.match(RELEVE_SCRIPT, /modinfo -k "\$cible" zfs/);
});

test('une Forge LOCALE n’est pas redémarrable par la console', () => {
  // Redémarrer la machine qui fait tourner la console couperait la console.
  assert.throws(() => rebootSshArgs({ kind: 'local' }),
                (e) => e instanceof ForgeRebootError && e.code === 'local_server');
});

test('la commande passe par SSH, en sudo, sans secret sur la ligne', () => {
  const args = rebootSshArgs({ kind: 'ssh', host: '10.0.0.1', user: 'ubuntu', port: 22 });
  assert.ok(args.includes('BatchMode=yes'), 'jamais d’invite interactive');
  assert.deepEqual(args.slice(-3), ['sudo', 'sh', '-s'],
                   'le script arrive par stdin, pas sur la ligne de commande');
  assert.ok(args.includes('ubuntu@10.0.0.1'));
});

test('un alias ssh_config est passé TEL QUEL, sans -p ni user@', () => {
  // §22.4 bis : ajouter port et utilisateur écraserait ce que le fichier déclare.
  const args = rebootSshArgs({ kind: 'alias', sshHost: 'spark-recette' });
  assert.ok(args.includes('spark-recette'));
  assert.ok(!args.includes('-p'));
});

test('le redémarrage ne BLOQUE pas sur une connexion qui va mourir', () => {
  // `systemctl reboot` ne rend pas la main : attendre ferait conclure à l'échec
  // d'un redémarrage qui a parfaitement eu lieu.
  assert.match(REBOOT_SCRIPT, /--no-block/);
});

test('un échec de démarrage d’OpenSSH est NOMMÉ, pas confondu avec un refus', async () => {
  const faux = () => { throw new Error('ssh introuvable'); };
  await assert.rejects(
    executerSurLaForge({ kind: 'ssh', host: 'h', user: 'u', port: 22 },
                       RELEVE_SCRIPT, { spawnFn: faux }),
    (e) => e instanceof ForgeRebootError && e.code === 'ssh_start_failed');
});
