# M4 · Lire les pools de ressources

L'onglet **Hôte** répond à une seule question : *pourquoi cette création
serait-elle refusée, et de combien ?*

![Les quatre pools, la soustraction mémoire et la carte des cœurs](images/m4-pools.png)

## Trois grandeurs, jamais deux

Chaque ressource affiche sa **capacité**, ce qui est **alloué** et ce qui reste
**disponible**. « 4 Gio libres » sans dire sur combien ne permet pas de choisir
entre supprimer un Spark et agrandir la machine.

## Pourquoi la mémoire allouable est inférieure à la mémoire de la machine

L'écran énonce la soustraction terme à terme :

```
mémoire de la machine
  − plafond de l'ARC ZFS        que ZFS peut prendre à tout instant
  − marge d'exploitation        ce que l'hôte consomme pour lui-même
  = mémoire allouable
```

Chaque terme indique le réglage qui le commande : `zfs_arc_max` pour l'ARC,
`SPARKD_MEMORY_RESERVE` pour la marge. Sans cette décomposition, vous sauriez
qu'il manque de la mémoire sans savoir quelle vanne tourner.

Tant que la topologie n'a pas été relevée depuis la migration qui distingue les
deux termes, l'écran affiche la somme sans inventer sa répartition.

## Le surengagement

Une capacité de « 4 cœurs × 2 » n'est pas huit processeurs. Le facteur est donc
affiché à côté de la capacité.

**Le disque n'en a aucun, et c'est délibéré** : un pool CPU saturé se traduit par
de la lenteur, qu'un ordonnanceur lisse ; un pool de disque saturé est une panne
dure que rien ne rattrape.

## La carte des cœurs

Un Spark en mode **dédié** ne consomme pas de réservation : il **retire** ses
cœurs du pool commun, ce qui réduit la capacité de tous les autres. La carte le
montre cœur par cœur, faute de quoi vous verriez le pool rétrécir sans qu'aucune
allocation n'augmente.

La capacité se compte en cœurs **physiques**. Le SMT entrelace l'exécution, il
n'ajoute pas de capacité : compter les threads reviendrait à vendre deux fois la
même chose.

## Le relevé n'est pas continu

La capacité affichée date du dernier relevé, dont la date accompagne toujours les
chiffres. Le bouton **Relever à nouveau** la rafraîchit ; il ne détruit rien et ne
demande donc aucune confirmation.

## Une limite à connaître

La réservation CPU n'est aujourd'hui proportionnelle **qu'entre Sparks** : elle
est arbitrée contre les tranches système de l'hôte et n'est pas une garantie
absolue. L'écran le dit, et le dira autrement le jour où ce sera faux.
