/**
 * Le contexte qui parle au démon Docker d'un Spark.
 *
 * @spec docs/DAT.md §42.2 bis (le socket rootless appartient à son compte),
 *       §37.4.7, §37.6 bis et §37.7.1 (toute commande Docker prend le même
 *       contexte)
 *
 * La console entre en SSH comme `root`, mais un démon rootless n'écoute pas le
 * socket de root. Le contexte est donc décidé DANS le Spark, à chaque commande :
 * un compte resté par une pose interrompue ne suffit pas à le choisir.
 */

export const COMPTE_ROOTLESS = 'spark-docker';

/** Un argument qui traverse le shell distant sans devenir une commande. */
export const quoterShell = (valeur) =>
  `'${String(valeur ?? '').replace(/'/g, "'\\''")}'`;

/**
 * Emballe les arguments Docker dans le contexte effectivement utilisable.
 *
 * `exec` est essentiel : après un `docker info` rootless réussi, le code de
 * sortie de la commande demandée est celui qui ressort. On ne retombe jamais
 * sur Docker root parce qu'un geste rootless a lui-même échoué — le relancer
 * ailleurs serait un second geste, potentiellement destructif.
 */
export function dansContexteDocker(argumentsDocker) {
  // Les modules historiques portent leur commande complète (`docker ps`),
  // tandis que le terminal de conteneur ne porte que ses arguments (`exec`).
  // Les deux arrivent au même point sans jamais produire `docker docker …`.
  const args = String(argumentsDocker ?? '').trim().replace(/^docker(?:\s+|$)/, '');
  return [
    `uid=$(id -u ${COMPTE_ROOTLESS} 2>/dev/null || true)`,
    'socket="/run/user/$uid/docker.sock"',
    'if [ -n "$uid" ] && [ -S "$socket" ] && runuser -u '
      + `${COMPTE_ROOTLESS} -- env XDG_RUNTIME_DIR="/run/user/$uid" `
      + 'DOCKER_HOST="unix://$socket" docker info >/dev/null 2>&1; then',
    `exec runuser -u ${COMPTE_ROOTLESS} -- env XDG_RUNTIME_DIR="/run/user/$uid" `
      + `DOCKER_HOST="unix://$socket" docker ${args}`,
    'fi',
    `exec docker ${args}`,
  ].join('; ');
}
