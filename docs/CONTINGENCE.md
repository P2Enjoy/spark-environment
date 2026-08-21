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
python3 -m sparkd.sauvegarde /var/backups/sparkd
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
python3 -m sparkd.sauvegarde --restaurer <fichier> --vers /var/lib/sparkd/spark.db
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

1. `python3 -m sparkd.preflight` — la Forge est en état.
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

Aucun n'est traité. Ils sont listés ici pour que l'absence se voie, et non pour
laisser croire qu'elle est comblée.

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
| entrée fantôme au registre (INC-03) | une ressource comptée pour un Spark disparu |
