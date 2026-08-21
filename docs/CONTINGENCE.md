# Plans de contingence et gestes d'urgence

Ce que faire quand quelque chose casse, écrit **avant** que cela casse.

Un plan qu'on découvre le jour de l'incident se lit sous pression, sans notes, et
c'est le pire moment pour raisonner. Ce document existe pour que ce moment-là ne
soit qu'une exécution.

> **État au 2026-08-20.** Seule la première fiche est écrite et livrée — la
> sauvegarde et la restauration du registre, sur arbitrage du responsable, parce
> que c'est le seul scénario du lot qui se livre en **code vérifiable** plutôt
> qu'en document. Les autres scénarios de SPK-36 sont listés au §3 avec ce qui
> manque à chacun, et ne sont pas prétendus traités.

---

## 1. La frontière : ce que le produit sauvegarde, et ce qu'il ne sauvegarde pas

À écrire une fois, parce que tout le reste en dépend.

| Objet | Sauvegardé par le produit | Par qui, sinon |
|---|---|---|
| **le registre** `spark.db` — Sparks, quotas, routes, clés, journal | **oui** (§2) | — |
| la **cellule** d'un Spark : système, images Docker, volumes | non | instantanés locaux (§19), qui vivent **dans le pool** |
| les **données applicatives** du locataire | non | le locataire, vers un stockage externe |
| la configuration de la **Forge** — Incus, Caddy, systemd | non | reconstruite par `scripts/install-serveur.sh` |

**Ce qu'il faut lire dans ce tableau, et qui est le trou le plus grave** : les
instantanés vivent dans le pool de stockage. Ils protègent d'une erreur *dans* un
Spark ; ils ne protègent **pas** de la perte du pool, puisqu'ils disparaissent
avec lui. Un instantané n'est pas une sauvegarde, et le §19 le dit déjà — ce
document le répète parce que c'est le jour de l'incident qu'on l'oublie.

---

## 2. Perte ou corruption du registre

### 2.1 Ce que le registre porte, et ce qu'on perd sans lui

Un seul fichier, et avec lui toute la correspondance : quel Spark existe, quels
quotas il consomme, quelles routes pointent vers lui, quelles clés y ont accès,
et le journal d'audit avec sa chaîne d'intégrité (§36).

Les cellules, elles, **survivent** : elles vivent dans Incus, pas dans le
registre. Perdre le registre ne détruit donc aucune donnée de locataire — cela
détruit la connaissance que le produit en a. Les Sparks continuent de tourner ;
la console ne sait plus les nommer.

### 2.2 Pourquoi une copie de fichier ne suffit PAS

**Mesuré le 2026-08-20**, sur une base SQLite en mode WAL — celui que le produit
emploie (`db.py`, `PRAGMA journal_mode = WAL`) — pendant qu'une connexion écrit :

```
500 lignes écrites
cp reg.db copie.db     →  la copie se relit sans erreur, et contient 490 lignes
Connection.backup()    →  500 lignes
```

**Dix lignes perdues en silence, et la copie s'ouvre sans se plaindre.** C'est le
pire mode de panne possible pour une sauvegarde : elle restaure, elle ne signale
rien, et il manque ce qu'on venait chercher. Le motif est que les transactions
validées vivent dans le fichier `-wal` tant qu'un point de contrôle n'a pas eu
lieu, et qu'une copie du seul `.db` les laisse derrière.

Le produit emploie donc l'**API de sauvegarde en ligne** de SQLite, qui prend un
instantané cohérent sans arrêter le service.

### 2.3 Sauvegarder

```bash
sudo /opt/sparkd/venv/bin/python -m sparkd.sauvegarde /var/backups/sparkd
```

- N'arrête **rien**. Le service continue de répondre pendant la copie.
- Écrit un fichier daté, `spark-AAAAMMJJ-HHMMSS.db`, dans le répertoire nommé.
- **Vérifie ce qu'elle vient d'écrire** avant de rendre la main :
  `PRAGMA integrity_check`, puis la chaîne d'audit (§36.9). Une sauvegarde qu'on
  n'ouvre pas est une sauvegarde qu'on croit avoir.
- Rend un code de sortie non nul si l'une des deux vérifications échoue. Elle
  **ne remplace pas** une sauvegarde précédente par une copie douteuse.

Mesuré sur le registre de validation : **237 568 octets, 0,005 s**. Le coût n'est
pas un argument pour l'espacer.

### 2.4 Restaurer

```bash
sudo /opt/sparkd/venv/bin/python -m sparkd.sauvegarde --restaurer <fichier> --vers /var/lib/sparkd/spark.db
```

- **Refuse** si `sparkd` tourne encore. Restaurer sous un service actif laisserait
  deux vérités : celle du fichier et celle des connexions ouvertes.
- **Refuse** un fichier dont `integrity_check` ou la chaîne d'audit ne passent
  pas. Restaurer un registre corrompu remplace un problème par un problème plus
  difficile à voir.
- **Déplace l'existant** au lieu de l'écraser — `spark.db.remplace-<horodatage>`.
  Le registre qu'on remplace est parfois moins abîmé qu'on ne le croyait, et on ne
  s'en aperçoit qu'après.
- Les fichiers `-wal` et `-shm` de l'ancien registre sont **écartés avec lui** :
  laissés en place, SQLite les rejouerait par-dessus le registre restauré.

### 2.5 Après une restauration : ce qu'il faut vérifier

1. `sudo /opt/sparkd/venv/bin/python -m sparkd.preflight` — la Forge est en état.
2. La console liste les Sparks, et leur nombre est celui qu'on attendait.
3. **Le journal se vérifie** : `GET /v1/audit/verify` rend `intact: true`.
4. **L'ancre** de la console (§36.9.6) : si la sauvegarde est antérieure à ce que
   la console a déjà vu, elle signalera une troncature. **C'est correct** — la
   chaîne a bien été raccourcie. Ce n'est pas une fausse alerte, et on ne
   l'efface pas sans avoir écrit pourquoi.

### 2.6 Ce qui est perdu, et il faut le chiffrer

Tout ce qui a été écrit **entre la dernière sauvegarde et l'incident**. Il n'y a
ni réplication ni journal continu : le produit ne les a pas, et ne prétend pas
les avoir.

**EXERCICE RÉEL JOUÉ le 2026-08-21** sur la Forge de validation, de bout en bout,
avec les commandes de ce document et aucune autre. Les chiffres ci-dessous sont
**mesurés**, plus espérés :

| Grandeur | Cible | Observé |
|---|---|---|
| taille de la sauvegarde | — | **253 952 octets** |
| temps de sauvegarde | quelques secondes | **0,10 s**, service en marche |
| temps de restauration | quelques minutes | **0,08 s** |
| interruption de service | la durée de l'arrêt | **~20 s**, dominée par l'arrêt et le redémarrage de `sparkd`, pas par la copie |
| données perdues | l'intervalle entre deux sauvegardes | **exactement cela**, démontré |

**Comment la perte a été démontrée, plutôt qu'affirmée** : une variable
`TEMOIN_EXERCICE` a été posée **après** la sauvegarde. Après restauration, elle
n'existe plus, tandis que celles posées avant sont là. La fenêtre de perte est
donc bien l'intervalle entre deux sauvegardes, et rien d'autre.

**Ce que les vérifications du §2.5 ont rendu** :

```
preflight        : 12 controles — 0 bloquant, 0 signale
Sparks           : 2, avec leurs etats reels (running, error)
GET /v1/audit/verify : intact: true, 51 entrees
```

**Ce que l'exercice a confirmé du dispositif lui-même** : la restauration a bien
**refusé** de s'exécuter tant que `sparkd` tournait, et elle a **déplacé**
l'ancien registre au lieu de l'écraser — `spark.db.remplace-<horodatage>`, qui
existe et se relit.

**Ce que l'exercice n'a PAS couvert** : l'ancre de la console (§2.5, point 4).
La signaler exige la console lancée avec son tunnel, ce que l'exercice n'a pas
monté. Le comportement attendu reste écrit, il n'est pas mesuré.

Un plan jamais joué est une fiction ; celui-ci a été joué.

---

## 3. Les scénarios qui restent à instruire

Un seul est traité à ce jour — l'entrée fantôme, au §4. Les autres sont listés
ici pour que l'absence se voie, et non pour laisser croire qu'elle est comblée.

Ce que le premier a appris vaut pour la suite : il a été **joué**, pas écrit, et
c'est en le jouant qu'on a trouvé deux défauts de production que ni les preuves
d'unité, ni les campagnes, ni les captures ne pouvaient voir — parce qu'aucune
d'elles ne détruit une cellule sous le produit. Instruire un scénario sans le
jouer produirait un document rassurant et faux.

| Scénario | Ce qui manque |
|---|---|
| perte du pool de stockage | tout — c'est le plus grave (§1) |
| hôte qui ne redémarre pas | le chemin de reconstruction n'a jamais été joué de bout en bout |
| `spark.slice` absente au démarrage (§32.4) | quel signal, quelle vérification |
| Incus indisponible après mise à jour | SPK-31 a montré qu'une version suffit à tout arrêter |
| saturation d'un pool — disque, mémoire, IPv4 | le signal existe, le geste n'est pas écrit |
| fuite d'une clé SSH | le geste existe (§35.2) ; l'ordre des opérations, non |
| mot de passe de protection perdu (§35.3) | la levée se fait sur l'hôte, la procédure n'est pas écrite |
| Spark compromis de l'intérieur | que fait-on du Spark, de ses routes, de ses instantanés |
| entrée fantôme au registre | **INSTRUIT le 2026-08-21**, voir §4 |


## 4. Entrée fantôme au registre : une ressource comptée pour un Spark disparu

**Premier scénario instruit, et il l'a été sur un cas RÉEL** — pas un cas
fabriqué. La Forge de validation en portait un depuis deux jours sans que
personne ne le sache.

### 4.1 Ce que c'est

Une ligne du registre qui déclare une cellule (`incus_name` renseigné) alors
qu'`incus list` ne la connaît pas. Le Spark est en `error`, et son `last_error`
raconte l'histoire :

```
Incus a refuse DELETE /1.0/instances/mesure-cpu : Client error '404 Not Found'
```

Une suppression a échoué parce que l'instance était **déjà** absente. C'était le
comportement d'avant SPK-52 ; la ligne, elle, est restée.

### 4.2 Ce que cela COÛTE, mesuré

Le fantôme n'est pas inerte : **il consomme de l'allocation réelle**, puisque
l'admission compte ce que le registre déclare.

| | avec le fantôme | après sa suppression |
|---|---|---|
| CPU alloué | 1,5 | **0,5** |
| poids de `spark.slice` | **180** | **43** |

Le second chiffre est le plus coûteux, et il ne saute pas aux yeux. Le poids de
la tranche vaut `H × f / (1 − f)` avec `f = Σr / C` (§32.2) : une réservation
fantôme de 1,0 CPU sur une capacité de 4 faisait peser la tranche **quatre fois
trop**. Les Sparks vivants recevaient donc un plancher calculé sur des
réservations que personne ne détient.

L'écart joue en leur faveur — ils obtiennent plus, jamais moins —, et c'est
précisément pourquoi **rien ne s'en plaint**. Un défaut qui ne lèse personne
immédiatement est un défaut qui dure.

### 4.3 Le geste

**Supprimer le Spark par le produit.** Depuis SPK-52, une instance déjà absente
vaut suppression réussie : le registre se nettoie, l'admission se recalcule, et
la tranche se repondère toute seule. Vérifié sur la Forge — `200`,
`{"deleted": …}`, puis 0,5 CPU alloué et poids 43 sans autre intervention.

Sauvegarder le registre AVANT (§2.3) : la suppression est irréversible, et une
ligne fantôme est parfois moins fantôme qu'on ne le croit.

### 4.4 Le signal qui manquait

Aucun des douze contrôles du préflight ne regardait cette cohérence. La Forge a
donc été mal pondérée pendant deux jours **en rendant « 0 bloquant »**.

Un contrôle est ajouté — `REG-FANTOME` — qui compare ce que le registre déclare
à ce qu'Incus connaît. Il **relève, il ne répare pas** (§48.2) : le geste reste
au responsable, parce que supprimer une ligne de registre détruit une déclaration
d'intention, et que la bonne réponse est parfois de **reconstruire** la cellule
plutôt que d'effacer la ligne.

Ce que le contrôle dit, et ce qu'il ne dit pas :

- il nomme les Sparks concernés, et **ce qu'ils coûtent** — sans le chiffre, on
  ne sait pas s'il faut agir aujourd'hui ou la semaine prochaine ;
- un Spark **sans** `incus_name` — `pending`, jamais appliqué — n'est PAS un
  fantôme : il n'a jamais prétendu avoir de cellule. Les confondre ferait crier
  au défaut sur le déroulement normal d'une création ;
- Incus injoignable rend « non mesuré », jamais « fautif » (§31.2) : conclure
  sur une absence de réponse ferait supprimer des Sparks bien vivants.

### 4.5 Reconstruire plutôt qu'effacer : le chemin, et la porte qui le fermait

Le §4.4 dit que la bonne réponse est **parfois de reconstruire**. Encore
faut-il que ce soit possible. Le scénario a été **joué** sur la Forge de
validation le 2026-08-21, sur un Spark jetable créé pour cela, dont la cellule
a été détruite hors du produit — `helo` n'a pas été touché.

Il l'est aujourd'hui, il ne l'était pas ce matin.

**Ce qu'on a trouvé en jouant le plan.** Sur un Spark dont la cellule a disparu,
demander un démarrage rendait **500**, et laissait le Spark ainsi :

```
etat      : starting
commandes : []
erreur    : null
```

Stable, vérifié à vingt secondes. Un état transitoire dont on ne sort plus,
sans aucune commande offerte et **sans même dire pourquoi**. Depuis la console,
plus rien : ni reconstruire, ni supprimer. Le fantôme du §4.1 devenait un Spark
qu'on ne pouvait plus ni réparer ni retirer.

**La cause, et elle mérite d'être retenue.** Le pilote distingue à dessein deux
choses : « Incus RAPPORTE que la cellule n'est pas là » et « je n'ai pas pu
demander » (§33.3). La première ne se laisse pas attraper par les gardes qui
guettent la seconde — c'est voulu, sans quoi on effacerait des lignes parce
qu'on n'a pas pu poser la question. Mais la route du cycle de vie ne la nommait
pas, et elle s'échappait. L'état transitoire, posé **avant** l'appel au pilote,
ne se refermait jamais.

**Ce que cela apprend, au-delà du défaut.** Le chemin de reconstruction
**existait déjà** : depuis l'état de panne, le produit offre `retry`, qui refait
la cellule, et `delete`, qui rend la place. Ce n'était pas une fonctionnalité
manquante, c'était une porte fermée devant un escalier construit. Un plan de
reprise qu'on relit ne montre pas ce genre de chose ; un plan qu'on joue, si.

**Ce que le produit fait maintenant**, mesuré sur la Forge :

| Geste | Avant | Maintenant |
|---|---|---|
| démarrer une cellule disparue | 500, Spark coincé sans commande | refus nommé, Spark en panne, `retry` et `delete` offerts |
| `retry` depuis la panne | inatteignable | la cellule est **refaite**, le Spark revient à l'arrêt |
| `delete` depuis la panne | inatteignable | la ligne part, la place retourne au pool (§14.5) |

À la différence de la suppression, l'absence ne vaut **pas** réussite ici : la
ligne survit au geste, et un succès de façade laisserait au registre un fantôme
silencieux — précisément ce que le §4 cherche à rendre impossible.

**Une réserve, et elle compte.** Avant ce correctif, un Spark coincé n'était pas
perdu pour autant : la reprise des états transitoires au démarrage du service
(§14.3) le ramenait en panne, donc en état d'être réparé. Vérifié. Mais elle
exige de **redémarrer le démon**, ce qu'un exploitant ne peut pas faire depuis
la console. Un recours qui suppose un accès administrateur à la machine n'est
pas un recours pour la personne qui tient la console. C'est la raison pour
laquelle le défaut a été corrigé plutôt que documenté comme contournable.

Cette même reprise ne renseigne pas `last_error` : elle rétablit un état sain
sans dire ce qui s'était passé. Le geste manuel, lui, laisse la raison lisible
sur la fiche du Spark.
