/**
 * Épreuve sur la VM du banc : une capacité réseau déclarée se DIT déclarée.
 *
 * @verifies docs/BACKLOG.md#SPK-135 · docs/DAT.md §5.3 bis (la source du débit,
 *           dite par l'onglet Forge) · manuel M4 · CLAUDE.md §16
 *
 * N'a de sens que sur une carte `virtio`, qui n'annonce aucun débit : le banc la
 * joue alors avec `NET_MBIT` déclaré dans l'amorce. Sur une carte `e1000e`, la
 * capacité est mesurée, et l'écran ne doit RIEN dire de plus.
 */
import { accueil, capturer, ouvrirNavigateur } from './commun.mjs';

export default async function jouer({ console: url, carte, verdict }) {
  const { navigateur, page, bruits } = await ouvrirNavigateur();
  try {
    await accueil(page, url);
    await page.click('nav a[href="#/forge"]');
    await page.waitForSelector('#titre-pools', { timeout: 30000 });
    const pools = await page.innerText('section[aria-labelledby="titre-pools"]');
    const dit = /Capacité déclarée par\s+SPARKD_NETWORK_CAPACITY_MBIT/.test(pools);
    await capturer(page, `spk135-vm-forge-${carte}`);
    if (carte === 'virtio') {
      verdict('SPK-135 : l’onglet Forge dit la capacité réseau DÉCLARÉE', dit,
              dit ? 'mention présente' : 'mention absente');
    } else {
      verdict('SPK-135 : une capacité MESURÉE ne se dit pas déclarée', !dit,
              dit ? 'mention présente à tort' : 'aucune mention');
    }
    verdict('la console n’a rien écrit d’anormal', bruits.length === 0, bruits.join(' | ') || 'rien');
  } finally {
    await navigateur.close();
  }
}
