# Exploration — un serveur MCP sur un Spark

**Statut : exploratoire. Non planifié, non retenu pour réalisation.**
Arbitrage du responsable du 2026-09-02.

Ce document n'est ni une spécification, ni un contrat. Il conserve une piste
étudiée le 2026-09-02 et les raisons qui l'ont façonnée, pour que la réflexion
ne soit pas à refaire si le sujet revient. **Rien ici n'est mesuré, rien n'est
implémenté, et aucun code du dépôt n'y renvoie.**

Il ne figure donc pas dans `docs/DAT.md`, qui décrit l'architecture réelle, ni
dans `docs/SCHEMA.md`, qui décrit le registre réel, ni dans `docs/BACKLOG.md`,
qui décrit ce qui est à faire.

Les identifiants `SPK-79`, `SPK-80` et `SPK-81` ont été attribués à ce sujet le
2026-09-02, puis **rendus** le même jour. Une unité future qui reprendrait cette
piste prendra des identifiants neufs : ces trois-là ont paru dans un message de
commit poussé, et les réemployer pour autre chose rendrait l'historique
trompeur.

---

## 1. Le besoin d'origine

Attacher à un Spark une surface par laquelle un agent conduit *cette cellule-là* :
décrire le Spark, lire sa chaîne de connexion SSH, poser des variables, amorcer
sa cellule, router un domaine, prendre et restaurer des instantanés — avec une
clé d'API à durée de vie.

Ce ne serait pas une nouvelle API, mais un **rétrécissement** de l'API existante
à un seul objet, plus une identité qui la porte. Ce que la console ne peut pas
faire, un agent ne le pourrait pas davantage.

## 2. Ce que le produit offre déjà, et qu'il ne faudrait pas réinventer

- le **briefing** (SPK-60) est déjà un modèle écrit pour être lu par un agent, et
  le §44.6 le pose comme « donnée et non consigne » ;
- la **protection** (SPK-34) refuse cinq gestes nommés *côté runtime*, avec une
  justification qui décrit exactement un agent : « une protection que seule
  l'interface respecterait ne protégerait pas du cas le plus fréquent — le
  script, pas l'humain » ;
- la **chaîne d'audit** (SPK-38) donne la traçabilité ;
- la **signature SSHSIG** (SPK-40) et son fichier `allowed_signers` (§36.10.5)
  donnent une primitive de vérification déjà écrite.

## 3. Décisions prises pendant l'exploration

### 3.1 Un démon distinct, un seul pour la Forge

Pas un module chargé dans `sparkd` : une seconde unité systemd, son propre port
de bouclage, son propre compte non privilégié, aucune poignée sur le registre.
Trois raisons :

- `sparkd` **refuse de démarrer sur une adresse routable** (§11). Comme Caddy
  tourne sur la Forge, une route vers `127.0.0.1:9876` rendrait cette garantie
  cosmétique — le port ne serait pas routable, le service le serait ;
- `sparkd` tourne en `root` pour la socket Incus ; un processus exposé
  publiquement ne doit pas être celui qui la détient ;
- la chaîne d'audit du §9.2 n'admet **qu'un seul écrivain** : deux processus
  tenant chacun une poignée SQLite se disputeraient l'ordre des `prev_hash`.

Un seul démon sert la Forge ; « le serveur MCP d'un Spark » est une vue, pas un
processus. C'est la clé présentée qui désigne le Spark.

### 3.2 Le démon serait un adaptateur, jamais une autorité

Il parlerait le protocole — session, cadrage, flux, ressources — et traduirait
en appels au plan de contrôle. Toute autorisation resterait dans `sparkd` :
empreinte, échéance, opérations accordées, protection du §35, refus de
restauration. Un contrôle dans l'adaptateur ne serait qu'une aide d'interface
(`CLAUDE.md` §10).

### 3.3 Le cloisonnement doit être une frontière, pas une discipline

Question posée par le responsable, et elle est juste : rien n'empêche un
adaptateur mal écrit d'appeler `/v1` en direct et d'ignorer les octrois.

Trois mécanismes y répondraient, dont deux appliqués par le noyau :

- `RestrictAddressFamilies=AF_UNIX` sur l'unité du démon : il devient
  **incapable** d'ouvrir une connexion TCP. Caddy l'atteindrait par
  `"dial": "unix//run/spark/mcp.sock"`, et lui atteindrait `sparkd` par une
  seconde socket UNIX ;
- la porte à clé ne serait montée **que** sur cette socket UNIX, et `/v1` ne le
  serait pas — deux conditions indépendantes ;
- `SO_PEERCRED` donnerait à `sparkd` l'UID réel de l'appelant, vérifié par le
  noyau.

Ce que cela n'empêcherait pas, et qu'il faudrait écrire tel quel : un adaptateur
compromis peut abuser des clés qu'on lui présente, dans la limite de leurs
octrois et de leur échéance ; et `root` sur la Forge défait tout, comme le dit
déjà le §35.1.

Sans contrôle, `RestrictAddressFamilies` n'est qu'un commentaire dans un fichier.
SPK-72 a donné la leçon sur un autre sujet : le préflight lirait l'unité
**effective**, et un test tenterait depuis le cgroup du démon une connexion TCP
vers `9876` en exigeant qu'elle échoue.

### 3.4 Aucune écriture par défaut, cochée une par une

Arbitrage du responsable. Une clé porterait un seul Spark, une échéance
obligatoire vérifiée à chaque appel, et **aucune opération d'écriture** tant
qu'elle n'a pas été explicitement cochée à la création. Des portées larges —
« configuration », « instantanés » — donneraient à un agent chargé de poser deux
variables le droit de redimensionner la cellule.

La valeur ne serait montrée qu'une fois, et jamais persistée côté client
(`CLAUDE.md` §11).

### 3.5 Le DNS resterait un geste humain

Arbitrage du responsable. L'agent consulterait les routes d'ingress et les ports
qui servent son Spark, et résoudrait le nom pour le comparer à l'adresse de la
Forge — une observation du monde, sans secret. Il n'écrirait jamais chez le
fournisseur : le jeton vit sur le poste (§38.1) et n'a rien à faire sur la Forge.

### 3.6 Le point de retour avant restauration

Une restauration serait refusée tant que l'**état courant** n'a pas son propre
instantané. Ce n'est pas le refus existant du §19.1, qui protège les instantanés
**plus récents** que la cible : celui-ci protège ce qui n'a **jamais** été
capturé.

Refuser plutôt que prendre l'instantané d'office : un instantané automatique
consomme en silence le quota disque, or le quota *est* le contrat du produit.

### 3.7 Ce qu'aucune clé n'atteindrait

Supprimer le Spark ; lever la protection ; créer, prolonger ou élargir une clé ;
écrire au DNS ; toucher au plan Forge. Ces interdits n'auraient pas de case.

### 3.8 Une troisième classe d'acteur

Le §21.6.1 ne connaît que `human` et `runtime`. Un geste d'agent n'est ni l'un ni
l'autre : le classer `human` **fabriquerait** une attribution, ce que le §21.6.1
dit être bien pire que d'en perdre une. Il faudrait une valeur `agent`.

### 3.9 Opérations longues

Amorcer, restaurer et redimensionner dépassent la durée d'un appel : identifiant
d'opération rendu immédiatement, registre **persisté**, outil d'état, et reprise
au démarrage selon le §14.3. Un appel bloquant idempotent ferait voir un échec là
où l'opération réussit.

## 4. Esquisse de registre, si le sujet revenait

Aucune migration n'est écrite et aucun numéro n'est réservé.

- `mcp_key` — `spark_id`, `label`, empreinte `scrypt` et ses paramètres de coût
  écrits à côté (modèle du §35.3), `expires_at` **non nullable**, `revoked_at`,
  `last_used_at` ;
- `mcp_key_grant` — `(key_id, operation)`, une ligne par écriture accordée. Une
  table et non une colonne de portées : l'absence de ligne est la réponse, pas
  une donnée manquante ;
- `mcp_operation` — `id`, `spark_id`, `key_id`, `operation`, `state` dont
  `interrompue` pour le §14.3, `started_at`, `ended_at`, `detail`.

## 5. Ce que l'exploration a fait apparaître, et qui ne dépend PAS de MCP

Ce point est noté à part parce qu'il vaut indépendamment : il est né de cette
piste, il ne meurt pas avec elle.

`sparkd` n'a **aucune authentification** : il écoute sur `127.0.0.1:9876` et la
confiance vient d'être sur la machine. Le §21.6.2 en tire la conséquence et
l'assume — `X-Spark-Actor` est déclaratif, « qui atteint `sparkd` écrit ce qu'il
veut dedans ».

Piste étudiée : authentifier **toutes** les routes, la console négociant son
accès avec la clé SSH qu'elle détient déjà.

- La console **ne peut pas** être authentifiée par son tunnel : un `-L` est
  anonyme à l'arrivée. Le §46.1 le mesure pour une autre raison — `-L` et `-W`
  sont des canaux `direct-tcpip`, **pas des sessions**.
- En revanche elle peut **signer un défi** émis par la Forge, avec la primitive
  SSHSIG déjà écrite (`signature.py`), vérifiée contre `allowed_signers`, puis
  recevoir un jeton court. Signer une fois et non à chaque appel : une clé
  matérielle `sk-` demande un toucher par signature.
- **Un digest stable ne suffirait pas** : il serait un porteur rejouable, égal à
  la clé. Il faut un défi frais.
- **Un second espace de noms est obligatoire.** `signature.py` le dit lui-même :
  sans espace de noms, une signature produite pour un autre usage serait
  rejouable ici. `spark-audit` atteste l'intention et ses octets sont conservés
  en clair au journal ; les réemployer pour l'authentification les rendrait
  rejouables en identifiants de session.
- **`allowed_signers` plutôt qu'`authorized_keys`** : le second dit qui peut
  ouvrir une session, pas qui peut conduire le plan de contrôle ; une clé de
  sauvegarde y gagnerait silencieusement la Forge entière. Conséquence
  d'exploitation : la clé restreinte de SPK-61 devrait y figurer.
- **Risque de verrouillage, sérieux.** Le §36.10.5 pose aujourd'hui « fichier
  absent ou vide → la fonction se désactive », ce qui convient à une attestation
  facultative. En authentification, la première installation qui exigerait un
  porteur sans avoir peuplé le fichier enfermerait l'exploitant dehors. Il
  faudrait ensemble : l'installation qui peuple, un préflight qui refuse le
  fichier vide, et un chemin de récupération local en `root` par socket UNIX.
- **Ce que cela prouverait, et pas plus.** `signature.py` pose la doctrine :
  « ce n'est pas de l'authentification : la clé volée signe » (SPK-35, §45.4).
  Une signature n'établit pas la personne, seulement la détention de la clé —
  ce qui est exactement ce que SSH établit déjà. On alignerait l'API sur le
  plafond du produit, sans élever aucune prétention, et il faudrait l'écrire
  ainsi pour que « authentifié » ne se lise jamais « identité humaine prouvée ».
- **Deux bénéfices de bord**, si cette piste était reprise : le mode local du
  §28.2 cesserait d'être un cas particulier, puisque la signature ne demande pas
  de tunnel ; et le relevé d'empreinte du §21.6.3 — 81 lignes de `DEBUG1` et son
  piège d'ancrage documenté — deviendrait inutile.
