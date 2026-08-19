# M10 · Supprimer un Spark

![La confirmation de suppression](images/m10-suppression.png)

## Ce qui est détruit

La cellule, son disque et **tous ses instantanés**. Les routes publiques qui
pointaient vers elle cessent d'être servies.

## Ce qui est libéré

Le processeur, la mémoire, le disque et le débit qu'elle réservait retournent aux
pools de l'hôte — et son adresse privée redevient attribuable.

La ressource n'est rendue qu'**à la disparition effective** du Spark : un Spark
arrêté continue de consommer ses quotas. C'est voulu : ce qui lui est promis doit
rester disponible quand il redémarrera.

## Ce qui n'est pas concerné

Vos sauvegardes applicatives, si elles sont ailleurs. C'est précisément la raison
pour laquelle un instantané n'en est pas une (voir [M9](M9-instantanes.md)).

## Irréversible

Il n'y a pas de corbeille. La confirmation nomme le Spark et énonce la
conséquence avant que le bouton destructif ne soit atteignable.
