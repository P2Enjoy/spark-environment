/**
 * L'interrupteur d'épreuve : ce qu'un doublon exige pour être lu.
 *
 * @spec docs/BACKLOG.md#SPK-100 · docs/DAT.md §53 (aucune option cachée), §53.1
 *       (les quatre cases d'un réglage), §53.3 (l'interrupteur et le bandeau) ·
 *       §37.4.2 bis (le doublon du transport), §37.6 ter (celui de Docker),
 *       §51.1 (celui du redémarrage), §36.10.9 (celui de la signature)
 *
 * Le harnais lance la console comme un **processus séparé** : l'environnement
 * est son seul canal, et aucun tour de passe-passe ne l'en dispense. Ce qui est
 * corrigé ici n'est donc pas l'existence des doublons, c'est qu'ils étaient
 * **sans borne et sans trace** — un `SPARK_DOCKER_COMMAND` exporté dans un shell
 * remplaçait la commande `docker` que la console exécute en exploitation, sans
 * que rien ne le dise nulle part.
 *
 * Deux propriétés, et la seconde compte autant que la première :
 *
 * 1. hors de `SPARK_EPREUVE=1`, les cinq variables sont **ignorées** ;
 * 2. ce qui est ignoré est **dit**, et ce qui est actif se **voit à l'écran**.
 *    Ignorer en silence aurait remplacé une option cachée par un comportement
 *    caché, et un interrupteur qui ne se lirait que dans l'environnement du
 *    processus serait resté invisible à qui regarde la console.
 */

export const INTERRUPTEUR = 'SPARK_EPREUVE';

/** La valeur ACCEPTÉE, et elle seule (§53.3). */
export const ACTIF = '1';

/**
 * Les cinq doublons du produit, et ce que chacun remplace.
 *
 * `remplace` est écrit pour être lu **à l'écran** par quelqu'un qui découvre le
 * bandeau : il nomme la commande réelle, pas le module qui la lance.
 */
export const DOUBLONS = [
  { variable: 'SPARK_TERMINAL_COMMAND',
    remplace: 'la commande du terminal — `ssh` vers un Spark' },
  { variable: 'SPARK_DOCKER_COMMAND',
    remplace: 'la commande `docker` interrogée dans un Spark' },
  { variable: 'SPARK_REBOOT_COMMAND',
    remplace: 'la commande de redémarrage de la Forge' },
  { variable: 'SPARK_SIGN_COMMAND',
    remplace: 'la commande de signature d’un geste' },
  // SPK-82 · §53.3 bis : le seul des cinq qui ne remplace pas une COMMANDE. Il
  // remplace un fait que la pile ne peut pas produire — qu'OpenSSH emploie une
  // clé pour joindre ce serveur —, et sans lequel l'octroi du §42.10 n'a pas de
  // chemin heureux à éprouver.
  { variable: 'SPARK_CONSOLE_IDENTITY',
    remplace: 'la clé qu’OpenSSH emploie pour joindre la Forge' },
];

const posee = (env, variable) => String(env?.[variable] ?? '') !== '';

/**
 * Lit l'interrupteur et rend de quoi s'en servir — et de quoi le montrer.
 *
 * Le relevé est fait **une fois**, au démarrage de l'hôte : relire à chaque
 * requête ferait dépendre le comportement d'un environnement modifiable pendant
 * qu'un écran l'utilise, exactement ce que le §38.1 refuse déjà pour le `.env`.
 *
 * `journal` reçoit le refus. Il est injectable pour que la preuve le lise sans
 * dépendre de la sortie d'erreur du processus de test.
 */
export function lireEpreuve(env = process.env, { journal = console.error } = {}) {
  const actif = String(env?.[INTERRUPTEUR] ?? '') === ACTIF;
  const posees = DOUBLONS.filter((d) => posee(env, d.variable));

  // §53.3 : la variable est VUE, refusée, et le refus est dit. Se taire ici
  // laisserait chercher pendant une heure pourquoi un doublon « ne marche pas ».
  if (!actif && posees.length) {
    journal(
      `[spark] ${posees.length} variable(s) de doublon ignorée(s) : `
      + posees.map((d) => d.variable).join(', ')
      + `. Elles ne sont lues que sous ${INTERRUPTEUR}=${ACTIF} `
      + '(docs/DAT.md §53.3). Les commandes réelles sont employées.');
  }

  return {
    actif,
    /** Ce que la coquille affiche. Vide hors interrupteur, par construction. */
    doublons: actif ? posees.map(({ variable, remplace }) => ({ variable, remplace })) : [],
    /**
     * La valeur d'un doublon, ou `null`.
     *
     * `null` et non la chaîne vide : les appelants testent déjà l'absence, et
     * une chaîne vide passerait pour une commande à lancer.
     */
    commande(variable) {
      if (!actif || !posee(env, variable)) return null;
      return env[variable];
    },
  };
}
