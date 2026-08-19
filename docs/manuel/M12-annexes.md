# M12 · Annexes

## Variables d'environnement

Les **noms** figurent ici ; leurs valeurs n'apparaissent jamais dans la
documentation.

### Runtime serveur

| Variable | Rôle | Requis |
|---|---|---|
| `SPARKD_BIND` | adresse d'écoute — refuse toute adresse routable | non |
| `SPARKD_DB` | fichier du registre | non |
| `SPARKD_INCUS_SOCKET` | socket du gestionnaire de conteneurs | non |
| `SPARKD_CADDY_ADMIN` | API d'administration du proxy | non |
| `SPARKD_DRIVER` | pilote d'exécution : réel ou factice | non |
| `SPARKD_STORAGE_POOL` | pool de stockage dont la capacité fait foi | non |
| `SPARKD_MEMORY_RESERVE` | mémoire soustraite du pool pour l'hôte, hors ARC | non |
| `SPARKD_LOG_LEVEL` | niveau de journalisation | non |

### Console

| Variable | Rôle | Requis |
|---|---|---|
| `SPARK_CONSOLE_PORT` | port local de la console | non |
| `SPARK_CONSOLE_STATE` | fichier d'inventaire des serveurs | non |

## Journal d'audit

Toute opération qui modifie l'état est tracée, avec son résultat :

| Résultat | Sens |
|---|---|
| réussi | l'opération a abouti |
| refusé | le serveur a refusé — capacité, état, unicité |
| erreur | l'opération a échoué en cours d'exécution |

Les valeurs sensibles y sont caviardées : le corps d'une clé n'y entre jamais.

## Messages courants

| Message | Ce qu'il veut dire | Que faire |
|---|---|---|
| « Aucun tunnel ouvert vers … » | la console n'a pas pu joindre le serveur | vérifier l'accès SSH et le nom du serveur dans l'inventaire |
| « Capacité insuffisante — … il manque … » | l'admission a refusé : la ressource nommée manque | réduire la demande, supprimer un Spark, ou consulter [M4](M4-pools.md) |
| « Ce Spark n'a pas encore d'adresse » | le Spark est déclaré mais pas appliqué | l'appliquer depuis son écran détail |
| « Restauration de … refusée : … plus récents seraient détruits » | des instantanés postérieurs bloquent | les supprimer, ou accepter explicitement leur perte ([M9](M9-instantanes.md)) |
| « La topologie de cet hôte n'a pas encore été relevée » | le registre ignore la capacité de la machine | cliquer sur **Relever la topologie** ([M4](M4-pools.md)) |
| « Pas encore appliqué — rien à mesurer » | le Spark n'a jamais tourné | ce n'est pas une erreur |

## Où lire la suite

- l'architecture et les mesures : [DAT](../DAT.md) ;
- l'état réel de chaque fonctionnalité : [backlog](../BACKLOG.md) ;
- les incohérences connues et non résolues : [registre](../INCONSISTENCY_REPORT.md).
