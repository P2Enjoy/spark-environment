# JOURNAL

Trace chronologique des décisions et investigations significatives.

---

## 2026-08-18 — Récupération de l'idée fondatrice et pose du socle

### Problème

Le dépôt `spark-environment` ne contenait que `CLAUDE.md`, un `docs/DESIGN_SYSTEM.md`,
un `docs/CloudWorker.md` recopié d'un autre projet et un `README.md` décrivant
`ollama.cpp`, sans rapport. L'idée du produit n'existait que dans une conversation
ChatGPT partagée par un lien.

### Observations

- Le lien de partage ne rend rien d'exploitable par une simple récupération HTTP :
  la page est une application cliente. Le contenu a été extrait de la charge utile
  turbo-stream embarquée dans la page, puis reconstruit par résolution des
  références d'index. 59 nœuds, 9 messages utiles.
- La conversation contient l'intégralité du modèle produit : la notion de Spark,
  le refus de Docker comme frontière d'isolation, le choix d'Incus, les modes CPU,
  l'ingress Caddy, le plan d'administration par tunnel SSH.

### Décision

Persister la transcription **verbatim** dans `docs/ORIGIN_CONVERSATION.md` avant
toute autre chose. Une idée fondatrice ne doit pas dépendre d'une URL externe qui
peut être révoquée.

Les faits techniques cités dans la conversation ont été **revérifiés directement**
dans la documentation Incus `main` le 2026-08-18, plutôt que repris de confiance :

- `limits.cpu` — « A number or a specific range of CPUs to expose to the instance. »
- `limits.cpu.allowance` — « specify either a percentage (`50%`) for a soft limit
  or a chunk of time (`25ms/100ms`) for a hard limit. »
- `limits.cpu.priority` — entier 0–10, arbitrage sous surengagement.
- `limits.memory.enforce` — `hard` ou `soft`, `soft` autorisant le dépassement
  quand l'hôte a de la mémoire disponible.
- `security.nesting` — bool, modifiable à chaud pour les conteneurs.
- `security.idmap.isolated` — « the idmap used for this instance is unique among
  instances that have this option set », conteneurs non privilégiés.
- NIC : `limits.ingress`, `limits.egress`, `limits.max`, `limits.priority`, en
  bit/s, pris en charge par les NIC `bridged`, `ovn` et `routed`.
- Disque : `size` « only supported for the `rootfs` (`/`) », `limits.read`,
  `limits.write`, `limits.max` en byte/s et/ou IOPS.
- `cloud-init.user-data` pour l'injection à l'initialisation.

Un écart avec la conversation : `cloud-init.ssh-keys` n'apparaît pas dans la page
de référence des options d'instance. L'injection des clés passe donc par
`cloud-init.user-data`, et la question sera retranchée lors de SPK-11.

### Conséquences

- `docs/DAT.md`, `docs/SCHEMA.md`, `docs/BACKLOG.md` écrits et committés avant tout
  code, conformément à `CLAUDE.md` §5.
- Le DAT §12 liste six hypothèses **non vérifiées** qui ne seront pas présentées
  comme acquises tant qu'une mesure sur l'hôte cible ne les aura pas tranchées.

---

## 2026-08-18 — Sémantique de la réservation CPU

### Problème

`limits.cpu.allowance` en pourcentage est une limite *souple* : c'est une part
relative entre instances partageant les mêmes CPU. Un poids relatif ne garantit
rien dans l'absolu. Or le produit vend « 0,5 CPU ».

### Solutions envisagées

1. Quota temporel dur (`50ms/100ms`) pour tous les Sparks. Garantit le plafond,
   mais interdit le burst et gaspille la capacité inutilisée — c'est exactement ce
   que le responsable voulait éviter.
2. Poids relatif seul. Autorise le burst, mais ne garantit rien sous contention.
3. Poids relatif **plus** admission control dans le registre.

### Décision

Option 3. La garantie n'est pas produite par le noyau mais par la comptabilité :

```
Σ réservations(Sparks partagés) ≤ capacité(pool partagé) × facteur_surengagement
```

Sous cet invariant, et avec un poids proportionnel à la réservation, un Spark
obtient au moins sa réservation en contention totale. Le surengagement devient un
réglage explicite au lieu d'un effet de bord.

Le mode `capped` reste disponible pour qui veut un plafond dur sans burst.

### Vérification à faire

La correspondance exacte pourcentage → poids d'ordonnancement dans Incus n'a pas
été lue dans le code source. Elle doit être mesurée par un test de contention
réel sur l'hôte (SPK-27, point 1). Tant que cette mesure n'existe pas,
l'invariant est un raisonnement, pas une preuve.

---

## 2026-08-18 — Réseau : ce qui est garanti et ce qui ne l'est pas

Les primitives NIC d'Incus n'offrent qu'un **plafond** de débit. Il n'existe pas
de réservation garantie de bande passante à ce niveau.

Décision : conserver `network.reservation` comme grandeur de comptabilité pour
l'admission control, et n'appliquer au NIC que `network.burst` via `limits.max`.
La console doit afficher cette différence explicitement plutôt que laisser croire
à une garantie. Toute autre présentation serait un succès simulé.

---

## 2026-08-18 — Langages du monorepo

`CLAUDE.md` §3 fixe Python pour les services backend et React/Vite pour l'interface.
La conversation d'origine suggérait « un très petit démon Go ou Rust » pour `sparkd`.

Décision : suivre la convention maison. Le travail réel de `sparkd` est de
l'orchestration de processus, de la comptabilité SQLite et du HTTP local ; rien
n'y est sensible à la latence au point de justifier l'écart. Le contrat d'API
partagé rend un remplacement ultérieur possible sans toucher à la console.

L'hôte local de la console reste en TypeScript avec la SPA, pour une seule chaîne
d'outillage et une seule commande de lancement côté poste.

---

## 2026-08-18 — Accès au serveur cible : bloqué

Le serveur `51.158.54.202` a été mis à disposition. La connexion échoue :

```
ubuntu@51.158.54.202: Permission denied (publickey).
root@51.158.54.202: Permission denied (publickey).
```

La clé publique du poste n'est pas autorisée sur la machine :

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILklM4dl9E+GCZog4f8+fV4q3fSF4BkFEV5LL5Sl2XoT contact@p2enjoy.studio
```

Conséquence : SPK-02 et tout ce qui en dépend (SPK-03, SPK-06, SPK-27) sont
bloqués par une action humaine. Le travail qui n'en dépend pas se poursuit.
