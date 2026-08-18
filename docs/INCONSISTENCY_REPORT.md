# Rapport d'incohérences

Contradictions et références manquantes relevées lors du travail, **laissées en
l'état**, en attente d'arbitrage du responsable. Aucune n'a été résolue
implicitement.

---

## INC-01 · `docs/CloudWorker.md` désigne un autre dépôt

`docs/CloudWorker.md` est le prompt de la tâche planifiée horaire de ce dépôt, et
`docs/.routine` en fait la seule source de vérité de cette tâche. Or son texte
commence par :

> Tu travailles sur le dépôt "p2enjoy-crm".

et décrit ensuite une pile applicative, un seed et des preuves qui appartiennent à
ce projet CRM, pas à Spark Environment.

**Impact.** Toute exécution automatique du CloudWorker sur ce dépôt suit des
consignes écrites pour un autre produit : recherche d'une pile inexistante,
exécution d'un seed absent, campagne de preuves sans objet.

**Non résolu.** Adapter ce fichier revient à réécrire le contrat d'une tâche
planifiée que le responsable a lui-même rédigée. Décision attendue : soit
l'adapter à Spark Environment, soit désactiver la tâche sur ce dépôt tant que la
pile n'existe pas.

Signalé le 2026-08-18.

---

## INC-02 · `README.md` héritait d'un autre projet

`README.md` décrivait `ollama.cpp` — « remplacer Ollama par llama-server sans
casser les clients » — sans aucun rapport avec ce dépôt.

**Traité**, et non laissé en l'état : un dépôt dont le README décrit un autre
produit n'a pas de lecture ambiguë possible, c'est un résidu de gabarit. Le
contenu a été remplacé, la substitution est tracée dans le `CHANGELOG.md`.

Signalé et corrigé le 2026-08-18.

---

## INC-03 · `cloud-init.ssh-keys` absent de la référence Incus

La conversation fondatrice indique que les clés SSH sont injectées « via
cloud-init, que Incus prend en charge pour l'initialisation d'instance ». La page
de référence des options d'instance d'Incus `main` documente
`cloud-init.user-data` et `cloud-init.vendor-data`, mais **pas** de clé
`cloud-init.ssh-keys`.

**Impact.** Faible. L'injection par `cloud-init.user-data` couvre le besoin.

**Non résolu.** À trancher par mesure sur l'hôte cible lors de SPK-11, une fois
la version d'Incus réellement installée connue.

Signalé le 2026-08-18.
