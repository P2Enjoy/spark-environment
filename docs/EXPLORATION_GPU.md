# Exploration — un GPU dans un Spark

**Statut : exploratoire. Non planifié, non retenu pour réalisation.**
Étudié le 2026-09-08, à la demande du responsable, et consigné **hors backlog**.

Ce document n'est ni une spécification, ni un contrat. Il conserve une piste
étudiée le 2026-09-08 et les raisons qui l'ont façonnée, pour que la réflexion ne
soit pas à refaire si le sujet revient. **Rien n'est implémenté, aucun code du
dépôt n'y renvoie, et rien n'a été mesuré sur la Forge.**

Il ne figure donc pas dans `docs/DAT.md`, qui décrit l'architecture réelle, ni
dans `docs/SCHEMA.md`, qui décrit le registre réel, ni dans `docs/BACKLOG.md`,
qui décrit ce qui est à faire.

**Aucun identifiant `SPK-` n'est attribué.** Contrairement à
`docs/EXPLORATION_MCP.md`, qui a dû *rendre* trois numéros déjà parus dans un
message de commit poussé, ce sujet n'en a jamais pris. Une unité future qui
reprendrait cette piste prendra un identifiant neuf.

---

## 0. Ce qui est vérifié, et ce qui ne l'est pas

Distinguer les deux compte ici plus qu'ailleurs : le **poste** du responsable
porte deux GPU, et la Forge n'en a **aucun de relevé**. Confondre les deux ferait
lire ce document comme un constat de production.

| Affirmation | Établie par | État |
|---|---|---|
| les cinq `gputype` d'Incus et leur cible | documentation Incus, `reference/devices_gpu` | lue le 2026-09-08 |
| l'absence de champ MIG dans l'API de ressources | code d'Incus, `shared/api/resource.go`, branche `main` | lu le 2026-09-08 |
| la forme du relevé `nvidia-smi` et son code de retour | exécution **sur le poste** (RTX 4070 Laptop) | exécutée le 2026-09-08 |
| ce que porte le bus PCI de la Forge | — | **aucun relevé n'existe** |
| l'empilement des injections NVIDIA (Forge → cellule → Docker) | — | **non essayé** |

Tout ce qui suit et qui ne relève pas des trois premières lignes est un
raisonnement, pas une mesure.

## 1. Le besoin, tel qu'il se poserait

Un locataire dont la pile Compose demande un accélérateur — inférence, encodage,
calcul. Le produit vend « un hôte Docker à soi » et promet de **reprendre une
pile existante sans la réécrire** (§2) ; une pile qui a besoin d'un GPU est
précisément celle qu'on ne peut pas reprendre si le GPU n'entre pas.

Le GPU serait donc une cinquième grandeur, à côté du CPU, de la mémoire, du
réseau et du stockage. Le §4 de ce document explique pourquoi ce n'en est pas
une, et c'est le cœur du sujet.

## 2. Ce qu'Incus sait faire, et ce qu'il en reste ici

| `gputype` | Cible | Ce qu'il fait |
|---|---|---|
| `physical` | conteneurs **et** VM | passe la carte entière |
| `mig` | **conteneurs seulement** | passe une *compute instance* MIG existante |
| `mdev` | VM seulement | crée et passe un GPU virtuel médié |
| `sriov` | VM seulement | passe une fonction virtuelle d'une carte SR-IOV |
| `native-context` | VM seulement | accélère par `virtio-gpu`, sans passthrough |

Le produit n'exécute que des conteneurs (§3). **Trois des cinq types tombent
d'office** : `mdev`, `sriov` et `native-context` ne sont servis qu'aux machines
virtuelles. Ils ne sont pas écartés sur le fond — ils reviendraient si le mode
`vm` évoqué au §11 était un jour servi — mais ils ne sont pas discutables tant
que la cellule est un conteneur.

Restent `physical` et `mig`.

## 3. La chaîne à trois maillons, et celui qui n'est pas mesuré

Le GPU devrait traverser **deux** frontières, pas une, parce que la frontière
d'isolation du produit n'est pas Docker (§2) :

1. **Forge → cellule.** Un device `gpu` sur l'instance, plus `nvidia.runtime=true`
   pour que la partie utilisateur du pilote soit injectée. Cela suppose
   `libnvidia-container` **installé sur la Forge** — que le §31 ne pose pas
   aujourd'hui. Sans injection, il faudrait une image portant exactement la même
   version de pilote que la Forge : un couplage qui casse au premier
   `apt upgrade` de l'hôte, et que le produit ne peut pas tenir.
2. **Cellule → Docker.** `dockerd` dans le Spark ne voit pas la carte parce que
   la cellule la voit : il lui faut le toolkit NVIDIA, et depuis le **dépôt
   amont** NVIDIA. Le §41.2 s'applique mot pour mot, pour la raison exacte qui le
   fait s'appliquer à Docker.
3. **Docker → conteneur du locataire.** `deploy.resources.reservations.devices`
   dans le Compose. Ce maillon-là appartient au locataire, et c'est le seul des
   trois.

Les maillons 1 et 2 empilent **deux injections de la même famille** :
`libnvidia-container` sur la Forge équipe la cellule, puis `libnvidia-container`
dans la cellule équipe le conteneur du locataire. **Rien ici ne dit que cet
empilement fonctionne**, et la question ne se tranche pas sur documentation.
C'est le premier essai à faire si le sujet revient, avant toute écriture de
code : il décide de la faisabilité, tout le reste n'en est que la mise en forme.

## 4. Le point dur : un GPU ne se contingente pas

C'est le vrai sujet, et il n'est pas technique.

Le README tient en une phrase : des cellules « cloisonnées et **contingentées** »,
dont les ressources sont « prélevées sur les pools du serveur, comptabilisées, et
rendues à la suppression ». Le §7.7 en donne la forme exacte : une capacité
allouable par ressource, une somme de réservations, un refus qui nomme la
ressource fautive et ce qui reste.

Un GPU n'entre pas dans ce moule, pour quatre raisons qui ne se compensent pas.

- **`physical` n'est pas exclusif.** Pour un conteneur, ce sont des nœuds de
  périphérique. Rien dans Incus n'empêche de poser la même carte sur cinq
  cellules, et cela **fonctionne** — jusqu'à ce que deux locataires la veuillent
  en même temps.
- **Il n'existe aucun cgroup pour la mémoire vidéo.** Le CPU a `cpu.weight` et
  `cpu.max` (§7.2), la mémoire a `limits.memory`, le stockage a le quota du pool.
  La VRAM n'a rien : ni poids, ni plafond, ni priorité. Un locataire qui alloue
  toute la carte fait échouer l'allocation de tous les autres **sans avoir rien
  violé** — il n'y a pas de règle à faire respecter.
- **Le pool aurait une granularité de 1.** Une carte est un entier. Un « pool »
  de zéro ou une unité n'est pas un pool, c'est une affectation. La formule du
  §7.7 n'en a que faire, et un facteur de surengagement y serait une
  plaisanterie : surengager un GPU, c'est le partager, et on retombe sur le point
  précédent.
- **La surface de noyau s'élargit.** Exposer `/dev/nvidia*` à un locataire lui
  ouvre un chemin d'`ioctl` direct vers un module noyau propriétaire **partagé
  par toute la Forge**. Le §11 pose déjà qu'un *system container* partage le
  noyau et que la réponse aux charges hostiles est le mode `vm`, pas un
  durcissement du mode conteneur. Le GPU pousse ce constat d'un cran, sur du code
  qu'on ne peut pas lire. À porter au §45.1 si le sujet revient.

**Décision de l'exploration, si le sujet revenait : exclusif.** Une carte
appartient à un Spark et à un seul, et cela s'écrit comme une **affectation** —
au sens du §39.2 pour un port publié, « une ressource de la Forge, pas du
Spark » — jamais comme un quota. Le mot « contingenté » du README ne doit pas
être étendu au GPU : il serait faux, et un mot faux dans la promesse coûte plus
cher qu'une fonctionnalité absente.

Ce que ce choix coûte, et qu'il faudrait écrire tel quel : une carte immobilisée
par un Spark qui ne s'en sert pas est perdue pour les autres, et **le produit n'a
aucun moyen de le voir** — l'usage GPU ne figure pas dans les métriques du §20, et
une carte inactive y serait indiscernable d'une carte réservée.

## 5. MIG serait la bonne réponse, et il est hors d'atteinte ici

MIG est le seul mécanisme qui **partitionne réellement** : mémoire et unités de
calcul isolées par le matériel, pas arbitrées par un pilote. C'est le seul qui
rendrait au GPU la propriété que le produit exige de toutes ses autres ressources.

Trois faits l'écartent :

- **Incus ne crée pas les partitions.** `gputype=mig` rattache une instance MIG
  **existante** — `mig.uuid` avec les pilotes 470 et suivants, sinon le couple
  `mig.gi` / `mig.ci`. La créer reste un geste d'administration de l'hôte, hors
  du plan de contrôle : le produit devrait soit exiger un état préparé à la main,
  soit ouvrir sur la Forge un chemin d'exécution qu'il n'a pas (§5.1 : la socket,
  pas la ligne de commande).
- **MIG n'existe que sur une poignée de cartes de centre de données**, à partir
  de la génération Ampere et seulement sur les modèles qui le déclarent. Aucune
  carte grand public ne l'a, quelle que soit son architecture.
- **Le châssis de la Forge ne s'y prête pas.** Le §8.1 décrit un Dell PowerEdge
  R320 : 1U, Xeon E5-1410 v2, connecteurs PCIe demi-hauteur, aucune alimentation
  auxiliaire. La seule classe de carte qu'un tel châssis accepte est celle des
  accélérateurs passifs alimentés par le connecteur, et aucune de ces cartes ne
  porte MIG. **Ceci est un raisonnement sur le matériel, pas un relevé** : rien
  dans le dépôt ne dit ce que porte le bus PCI de la Forge, et un `lspci` y
  répondrait en une seconde.

Conséquence : sur la machine décrite au §8.1, **`physical` serait le seul type
servable**, et la question d'exclusivité du §4 est donc *tout* le sujet.

## 6. Détecter : ce que l'API donne, et ce qu'elle ne donne pas

### Ce que l'API Incus donne

`inventory.py` appelle déjà `client.resources()` et y lit le CPU, la mémoire et
les cartes réseau (§5.2). Les cartes graphiques sont dans la **même réponse** :
aucun nouveau chemin d'accès, aucune permission de plus, le §5.1 reste entier.

Le relevé du code d'Incus donne, par carte : `Driver`, `DriverVersion`, `DRM`,
`PCIAddress`, `NUMANode`, `Vendor` / `VendorID`, `Product` / `ProductID`,
`USBAddress`, un bloc `Nvidia` (`CUDAVersion`, `NVRMVersion`, `Brand`, `Model`,
`UUID`, `Architecture`, `CardName`, `CardDevice`), un bloc `SRIOV` (fonctions
virtuelles configurées et maximum) et une table `Mdev` des profils disponibles.

### Ce qu'elle ne donne pas

**Il n'existe aucun champ MIG.** SR-IOV a le sien, mdev a le sien, MIG n'en a
pas. La capacité MIG d'une carte n'est donc **pas observable par l'API Incus**.
Le seul chemin qui l'expose est une exécution sur la Forge :

```
$ nvidia-smi --query-gpu=index,name,mig.mode.current,mig.mode.pending --format=csv
index, name, mig.mode.current, mig.mode.pending
0, NVIDIA GeForce RTX 4070 Laptop GPU, [N/A], [N/A]

$ nvidia-smi mig -lgip
No MIG-supported devices found.          # code de retour 6
```

Règle de lecture : `[N/A]` signifie **matériel incapable de MIG** ; `Disabled`
signifie capable mais éteint — l'allumer demande `nvidia-smi -mig 1` et une
réinitialisation de la carte, donc l'arrêt de ce qui l'utilise ; `Enabled`
signifie partitionné, et `nvidia-smi -L` liste alors les instances avec les
identifiants `MIG-…` que `mig.uuid` attend.

**Ne jamais déduire MIG de l'architecture ni du nom du modèle.** Le relevé
ci-dessus porte sur une carte Ada, donc postérieure à Ampere, et elle n'a pas
MIG. Une inférence sur le modèle annoncerait une capacité que le matériel n'a
pas — exactement ce que le §33.3 refuse : une présomption n'est pas un relevé.

Il en découle le point d'architecture le plus contraignant de ce document : **le
relevé GPU complet ne tient pas dans le chemin d'accès actuel.** Le produit
atteint la Forge par la socket Incus et n'y exécute rien (§5.1). Servir MIG
supposerait un second chemin — une sonde exécutée sur la Forge — c'est-à-dire une
décision d'architecture bien plus lourde que le device lui-même.

## 7. Ce que cela toucherait, si le sujet revenait

- **§5.2 et §5.3, le relevé** : les cartes arrivent avec le reste. Une carte
  relevée mais non affectée est un fait à écrire, pas un défaut.
- **§7.7, l'admission** : le GPU n'entre pas dans la table de capacité. Ce serait
  une ligne d'une autre nature — une affectation unique — et le refus devrait le
  dire avec ses propres mots, pas avec ceux d'un pool épuisé.
- **Les devices** : `set_publication_devices` (§39.4) est le précédent exact. Il
  remplace **en bloc** les devices d'un préfixe réservé et conserve les autres,
  parce que `PATCH` fusionne et ne sait pas retirer. Un device GPU suivrait la
  même discipline, avec son propre préfixe ; le rapiéçage laisserait une carte
  attachée à une cellule qui ne la porte plus au registre.
- **§11, l'idmap isolé** : chaque Spark a une plage UID/GID disjointe
  (`security.idmap.isolated=true`). Le type `physical` porte pour cela les
  options `uid`, `gid` et `mode`, qui n'existent **que** pour les conteneurs.
  Ce n'est pas un confort : sans elles, le nœud de périphérique se présente en
  `nobody:nogroup` dans la cellule.
- **§19, les instantanés** : les devices vivent dans la configuration de
  l'instance. Restaurer un instantané pris quand la carte était affectée la
  ferait **réapparaître** dans une cellule à qui elle a été reprise — et
  peut-être affectée ailleurs entre-temps. Même famille de piège que le §19.1,
  mais sur une ressource qui, elle, ne peut pas être à deux endroits.
- **§42.14, la table de capacités** (SPK-98) : le GPU **ne s'y range pas**. Cette
  table dit ce que le produit sait faire d'une **famille d'image** ; la
  disponibilité d'une carte dépend de la **Forge**, pas de l'image. L'y ajouter
  mélangerait deux axes et rendrait la table fausse pour l'un des deux.
- **§42.11, l'amorçage par élément** : le toolkit NVIDIA serait un élément de
  plus, avec son échec propre, servi seulement là où une carte est affectée.
- **§21 et §35.2** : affecter ou retirer une carte est une écriture visant le
  Spark. La protection la couvre sans qu'il faille l'étendre, et le journal la
  retient comme les autres.
- **§12.1, §28.5 et §29.3** : le doublon devrait rendre des cartes dans
  `resources()`, et le seed contenir une Forge équipée — faute de quoi le
  parcours ne serait pas cliquable, et le §29.3 interdit d'y arriver par une URL
  profonde ou un appel d'API.

## 8. Ce que cette exploration ne tranche pas

- **Ce que porte la Forge.** Aucun relevé PCI n'existe. Sans carte, tout ce
  document reste théorique.
- **L'empilement des deux injections** (§3). C'est l'essai qui déciderait, et il
  demande une Forge équipée.
- **AMD.** Le poste porte aussi un Radeon 680M. Une carte AMD passerait par le
  même `physical` — ce sont des nœuds DRM —, mais ROCm sur circuit graphique
  intégré est un terrain à part, et rien n'a été vérifié. Ne pas supposer que
  « ça marche pareil ».
- **Le coût d'exploitation.** Un pilote propriétaire sur la Forge doit suivre le
  noyau. Le redémarrage du §51 et la mise à jour du §40 y gagneraient une
  dépendance dont l'exploration n'a pas mesuré le poids.

## 9. Ce qu'elle fait apparaître, et qui ne dépend PAS du GPU

Noté à part parce que cela vaut indépendamment : c'est né de cette piste, cela ne
meurt pas avec elle.

`inventory.py` lit `resources()` et **jette silencieusement tout ce qu'il ne
modélise pas**. Une carte graphique présente sur une Forge n'est pas « absente »
du produit : elle est *invisible*. Or le §5.3 pose que le relevé est explicite, et
le §27.8 a déjà tranché le principe voisin — une topologie non relevée est un
**état nommé**, pas une erreur.

Piste, sans rapport avec la question de savoir si le produit servira un jour des
GPU : relever et **nommer** ce que la Forge porte et que le produit ne gère pas.
Cela ne promet rien, ne consomme aucun quota, et retire « est-ce que cette
machine a une carte ? » de la liste des choses qu'il faut aller vérifier à la
main. C'est bon marché, et c'est vrai pour tout ce que `resources()` contient et
que le registre ignore.
