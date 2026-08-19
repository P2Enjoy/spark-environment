# Manuel — Spark Environment

Ce manuel s'adresse au responsable d'un serveur Spark. Il explique **comment se
servir du produit**. Il ne justifie pas les choix d'architecture : quand une
explication demande de comprendre une décision, il en donne la conséquence
pratique et renvoie au [dossier d'architecture](../DAT.md).

Il ne contient ni secret, ni clé, ni adresse réelle. Les noms de variables
d'environnement y figurent ; jamais leurs valeurs.

Les illustrations sont **produites depuis l'application** par `make manuel`, et
non collectées à la main : une capture ne peut donc pas montrer un écran qui
n'existe plus. Voir [DAT §30](../DAT.md).

## Sommaire

| Chapitre | Sujet |
|---|---|
| [M1 · Comprendre un Spark](M1-comprendre.md) | ce qu'est une cellule, et ce qu'elle n'est pas |
| [M2 · Installer le serveur](M2-installer.md) | vérifier le serveur, déployer `sparkd`, relever la topologie |
| [M3 · Ouvrir la console](M3-console.md) | lancer la console, choisir un serveur, lire l'état du tunnel |
| [M4 · Lire les pools de ressources](M4-pools.md) | capacité, réserve, surengagement |
| [M5 · Créer un Spark](M5-creer.md) | le formulaire, les modes CPU, la lecture d'un refus |
| [M6 · Accéder à un Spark](M6-acces.md) | clés SSH, rebond, déploiement de la pile Compose |
| [M7 · Exposer un domaine](M7-domaine.md) | déclarer une route, la réappliquer, la retirer |
| [M8 · Exploiter au quotidien](M8-exploiter.md) | démarrer, arrêter, lire les mesures, comprendre une erreur |
| [M9 · Instantanés et sauvegarde](M9-instantanes.md) | ce qu'un instantané protège, et ce qu'il ne protège pas |
| [M10 · Supprimer un Spark](M10-supprimer.md) | ce qui est libéré, ce qui est irréversible |
| [M11 · Sécurité et limites](M11-securite.md) | surface d'exposition, ce qui n'est pas garanti |
| [M12 · Annexes](M12-annexes.md) | variables d'environnement, journal d'audit, messages courants |

## Essayer sans serveur

Le produit se lance en local, sans Incus ni serveur distant :

```
make seed      # crée un registre de démonstration
make runDev    # démarre le runtime et la console
```

La console est alors sur `http://127.0.0.1:5173`. Les Sparks qu'elle affiche sont
des données de démonstration : **aucun conteneur ne tourne réellement**, aucun
quota n'est appliqué. Cette pile sert à apprendre l'interface et à éprouver les
parcours, jamais à conclure sur l'isolation.
