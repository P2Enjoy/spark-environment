# Plan du manuel utilisateur

Le manuel s'adresse au responsable d'un serveur Spark. Il doit être compréhensible
sans lire le code, et ne contenir ni secret, ni clé, ni adresse interne, ni détail
exploitable sur l'infrastructure réelle. Les noms de variables d'environnement
peuvent y figurer ; jamais leurs valeurs.

Chaque chapitre est cité par les commentaires `@spec` du code des fonctionnalités
visibles correspondantes. Les chapitres sont rédigés au fur et à mesure des unités
du backlog : un chapitre n'est écrit qu'à partir du comportement réellement
observé, jamais de mémoire, et ses captures sont refaites dès que le parcours ou
l'apparence change.

**Le manuel est écrit** : il vit sous [`docs/manuel/`](manuel/). Ce plan reste la
carte des chapitres et de leurs unités ; le contrat de fraîcheur — illustrations
produites, lien vérifié dans les deux sens — est au §30 du [DAT](DAT.md).

**Tous les chapitres sont rédigés (M1 à M12).** M2 l'a été avec SPK-26 ; il
délimite explicitement ce qui n'est pas encore outillé — la mise en place des
prérequis, et le repartitionnement du stockage qui attend un arbitrage (SPK-28).

---

## M1 · Comprendre un Spark

Ce qu'est un Spark et ce qu'il n'est pas. Pourquoi Docker vit *à l'intérieur* et
non autour. Ce qui reste de la responsabilité de l'exploitant : sa pile Compose.

Unités : SPK-01.

## M2 · Installer le serveur

Prérequis matériels, installation d'Incus, du pool de stockage, du bridge privé, de
Caddy et de `sparkd`. Vérifications d'installation.

Unités : SPK-28, SPK-03, SPK-26.

## M3 · Ouvrir la console

Lancement local, ajout d'un serveur à l'inventaire, ouverture du tunnel SSH, et ce
que l'on voit quand le tunnel tombe.

Unités : SPK-16.

## M4 · Lire les pools de ressources

Capacité physique, réserve de l'hôte, capacité allouable, surengagement. Pourquoi
« allouable » est toujours inférieur à « physique ».

Unités : SPK-05, SPK-22.

## M5 · Créer un Spark

Le formulaire, le choix de l'image dans le catalogue, l'aperçu d'admission, et la
lecture d'un refus. Les quatre modes CPU expliqués par leur usage, pas par leur
traduction technique :

- partagé — le défaut, pour presque tout ;
- plafonné — quand on veut interdire le burst ;
- dédié — bases de données, compilation, inférence ;
- épinglé partagé — localité mémoire sans exclusivité.

Ce que « 0,5 CPU » signifie exactement, et ce que cela ne signifie pas.

Unités : SPK-20, SPK-05, SPK-06, SPK-32.

## M6 · Déployer sa pile Compose dans un Spark

Ajout d'une clé SSH, connexion par rebond, `docker compose up`. Le contrat
d'ingress : `domaine → spark → port`, et pourquoi il ne faut pas piloter le proxy
de l'hôte depuis Compose.

Unités : SPK-11, SPK-12.

## M7 · Exposer un domaine

Déclaration d'une route, émission du certificat, vérification, retrait. Que se
passe-t-il lorsqu'un domaine est déjà pris.

Unités : SPK-12.

## M8 · Exploiter au quotidien

Démarrer, arrêter, redimensionner. Lire les métriques d'usage face aux quotas.
Comprendre un Spark en erreur. Protéger un Spark contre la modification
accidentelle, et lever cette protection — en disant clairement ce dont elle
protège, et ce dont elle ne protège pas.

Unités : SPK-09, SPK-14, SPK-34.

## M9 · Sauvegarder et restaurer

La différence entre un instantané et une sauvegarde, et pourquoi elle compte le
jour où le pool de stockage est perdu. Procédure de restauration complète.

Unités : SPK-13.

## M10 · Supprimer un Spark

Ce qui est libéré, ce qui ne l'est pas, ce qui est irréversible.

Unités : SPK-09.

## M11 · Sécurité et limites

Surface d'exposition réelle. Pourquoi aucune API d'administration n'est joignable
depuis le réseau. Ce qu'un *system container* ne protège pas, et quand il faudra
un mode `vm`. La réservation réseau, qui est une comptabilité et non une garantie.

Unités : SPK-15, et §10 du DAT.

## M12 · Annexes

Journal d'audit, variables d'environnement, messages d'erreur courants et leur
diagnostic.
