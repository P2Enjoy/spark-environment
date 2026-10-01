# Rapport d'incohérences

Ce fichier n'existe que tant qu'une incohérence relevée n'est pas résolue ; il
est supprimé du dépôt quand il devient vide (CLAUDE.md §5).

## 2026-09-30 · « Les trois degrés s'atteignent au clavier » rouge une fois sur deux campagnes

**Constaté** en rejouant la campagne E2E pendant SPK-132 : rouge à la première
passe (148/149, en 261 ms), vert seul, puis vert à la seconde passe complète
(149/149). La capture d'échec montre `#/forge` dans l'état d'un serveur « qui
peut accepter SSH sans encore porter `sparkd` », comme si la console visait un
autre serveur de l'inventaire que la pile d'épreuve — un état qu'un parcours
antérieur aurait laissé. Le parcours s'exécute AVANT ceux de SPK-132, dont le
code ne touche ni la Forge ni la navigation.

**Arbitré le 2026-10-01** : pas de correction à part — le parcours tourne sur la
pile factice, qui ne valide plus rien (DAT §28.7). Il est absorbé par SPK-138 et
rejoué contre la VM ; l'entrée sort du rapport à ce moment.

## 2026-10-01 · L'aide du gabarit d'alerte nomme huit champs, la Forge en accepte dix

**Constaté** en observant la capture `spk140-vm-refus-garde-la-saisie`, prise
dans la console branchée sur la VM du banc : le refus de la `sparkd` dit
« Champs disponibles : version, ts, forge, action, actor, actor_class,
target_type, target_id, result, message », quand l'aide du champ, sous le
gabarit, n'en nomme que huit — `version` et `actor_class` y manquent
(`apps/webui/src/components/forge-alertes.js`). Le manuel M11 en nomme huit lui
aussi.

**Non résolu ici** : hors du périmètre de SPK-140. À arbitrer par le
responsable : l'aide et le manuel nomment les dix champs, ou la Forge n'en
offre que huit.

## 2026-10-01 · Le panneau « Installer cette Forge » montre des accents graves bruts, sur une Forge installée

**Constaté** sur la capture `spk135-vm-forge-virtio` : en bas de l'onglet
Forge d'une Forge **installée** — tunnel ouvert, code à jour —, le panneau
« Installer cette Forge » dit « Cette destination peut accepter SSH sans encore
porter `sparkd` », et les accents graves s'affichent tels quels
(`apps/webui/src/components/forge-installer.js`). C'est aussi la phrase de la
capture d'échec du parcours clavier instable (entrée ci-dessus).

**Non résolu ici** : hors du périmètre de SPK-135 et de SPK-137. À arbitrer par
le responsable : le panneau n'apparaît que sur une destination qui ne porte pas
`sparkd`, ou sa phrase dit ce qu'elle a relevé ; et le nom s'écrit en `<code>`.

## 2026-10-01 · Monter le débit réseau d'un Spark échoue en `500`, sans raison affichée

**Signalé par le responsable** (capture de la modale « Ressources » : « Le
serveur a refusé ces quotas. ») et **reproduit** sur le doublon : un Spark créé
à 10 Mbit/s, puis `PATCH /v1/sparks/{nom}` avec 100 Mbit/s → `500 Internal
Server Error`, en texte brut.

**Cause, lue dans la trace** : la modale « Plafond réseau » envoie
`network_reservation_bps` — la valeur de **comptabilité** —, et
`sparks.resize` ne touche jamais `network_burst_bps` — le **plafond**, seule
valeur posée sur la carte (DAT §7.6, SCHEMA §2). Monter la réservation au-dessus
du plafond viole la contrainte `network_burst_bps >= network_reservation_bps` ;
l'`IntegrityError` n'est rattrapée nulle part, d'où le `500`, et la console,
qui ne trouve aucun message dans un corps non JSON, dit « Le serveur a refusé
ces quotas. ». La transaction est annulée : le registre n'a pas changé.

Deux écarts de plus, qui viennent avec : quand la modale **réussit** (en
baissant), elle change la comptabilité mais **pas** le plafond appliqué — son
libellé « Plafond réseau » ment ; et la création, elle, pose les deux à la même
valeur (`network_bps`).

**Non résolu ici** : à arbitrer par le responsable — la valeur de la modale
fixe la réservation ET le plafond, comme à la création ; un refus nommé au
lieu d'un `500` ; et la console qui dit le code reçu quand la Forge ne donne pas
de raison.
