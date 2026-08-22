/**
 * Relai de terminal brut pour le parcours E2E.
 *
 * `cat` est presque le bon doublon, mais le pilote de terminal canonique
 * réaffiche ESC sous la forme `^[` avant que `cat` ne le relise. Cette petite
 * commande ne fait que relayer les octets reçus, en mode brut, afin que CSI 6n
 * atteigne réellement xterm et que celui-ci puisse produire son rapport DSR.
 *
 * Elle ne fait partie ni de l'hôte console ni du chemin de production : c'est
 * le distant factice lancé à sa place par `SPARK_TERMINAL_COMMAND`.
 */
const entree = process.stdin;
const brut = Boolean(entree.isTTY && typeof entree.setRawMode === 'function');
if (brut) entree.setRawMode(true);
entree.resume();
entree.on('data', (octets) => process.stdout.write(octets));

function finir() {
  if (brut) entree.setRawMode(false);
  process.exit(0);
}

process.once('SIGTERM', finir);
process.once('SIGINT', finir);
