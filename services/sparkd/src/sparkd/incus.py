"""Client de l'API Incus, sur la socket Unix.

@spec docs/BACKLOG.md#SPK-07 · docs/DAT.md §5.1 (Acces a Incus), §5.2 (ce qui
      est lu, et ou) · docs/BACKLOG.md#SPK-60 · docs/DAT.md §44.3 (versions
      observées à l'amorçage)

On ne lance jamais le binaire « incus » : sa sortie est un format d'affichage,
qui change sans preavis et se parse mal — la commande n'accepte meme aucun
« --format ». L'API rend des types.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import base64
import hashlib
import json
import math
import platform
import re
import time

import httpx


class InstanceAbsente(RuntimeError):
    """Le pilote RAPPORTE que l'instance n'existe pas.

    @spec docs/BACKLOG.md#SPK-52 · docs/DAT.md §14.5 (une instance déjà absente
          vaut suppression réussie), §33.3 (ne pas savoir n'est pas savoir que
          ce n'est pas là)

    Distincte d'`IncusError` À DESSEIN. Le §14.5 fait de l'absence une raison de
    réussir la suppression — mais d'une absence RAPPORTÉE, jamais d'un pilote
    injoignable. Confondre les deux ferait effacer une ligne du registre parce
    qu'on n'a pas pu poser la question, et l'instance continuerait de consommer
    sans être comptée.

    Elle N'hérite PAS d'`IncusError` : les appelants qui rattrapent `IncusError`
    pour conclure à une panne ne doivent pas l'attraper par mégarde. Ceux que
    l'absence intéresse la nomment.

    Le prix de ce choix, mesuré sur la Forge de validation le 2026-08-21 : un
    appelant qui OUBLIE de la nommer ne rend pas une panne propre, il rend un
    500. Sur la route du cycle de vie, où l'état transitoire est posé AVANT
    l'appel au pilote, cela laissait le Spark coincé sans aucune commande
    possible (SPK-36). Ce n'est pas une raison de rétablir l'héritage — cela
    ramènerait la confusion que le §33.3 interdit —, c'en est une de nommer
    l'absence partout où elle peut se produire.
    """


class IncusError(RuntimeError):
    """Incus est injoignable, ou a refuse la requete."""


def _raison(erreur: httpx.HTTPError) -> str:
    """Ce qu'Incus a DIT, plutôt que ce que `httpx` en pense (§5.3).

    @spec docs/BACKLOG.md#SPK-90 · docs/DAT.md §5.3

    Signalé le 2026-09-02 : supprimer un Spark rendait « Client error '400 Bad
    Request' … For more information check https://developer.mozilla.org/… »,
    quand le corps de la réponse portait `{"error":"Instance is running"}`.

    Le corps d'Incus fait autorité sur la CAUSE ; le statut HTTP ne dit que la
    catégorie. Renvoyer l'exception donnait à l'exploitant un lien vers MDN là
    où le serveur avait écrit la raison en trois mots.

    Rend le texte de l'exception quand le corps ne porte rien d'exploitable : ne
    pas savoir n'autorise pas à inventer une cause.
    """
    reponse = getattr(erreur, "response", None)
    if reponse is not None:
        try:
            corps = reponse.json()
        except (ValueError, TypeError):
            corps = None
        if isinstance(corps, dict) and corps.get("error"):
            return str(corps["error"])
    return str(erreur)


class IncusClient(Protocol):
    """Contrat minimal attendu par l'inventaire.

    Le declarer permet au pilote factice de tenir la meme promesse que le vrai,
    et aux tests d'eprouver la traduction sans hote Incus.
    """

    def resources(self) -> dict[str, Any]: ...

    def storage_pool_resources(self, pool: str) -> dict[str, Any]: ...

    def server_info(self) -> dict[str, Any]: ...

    def instances(self) -> list[dict[str, Any]]: ...

    def create_instance(self, payload: dict[str, Any]) -> None: ...

    def set_instance_state(self, name: str, action: str) -> None: ...

    def delete_instance(self, name: str) -> None: ...

    def update_instance_config(self, name: str, config: dict[str, str]) -> None: ...

    def set_publication_devices(
        self, name: str, devices: dict[str, dict[str, str]]) -> None: ...

    def update_root_size(self, name: str, size: str) -> None: ...

    def push_file(self, name: str, path: str, content: str, mode: str = "0600") -> None: ...

    def exec_command(self, name: str, command: list[str]) -> None: ...

    def exec_capture(
        self, name: str, command: list[str]) -> tuple[int, str, str]: ...

    def create_snapshot(self, name: str, snapshot: str) -> None: ...

    def restore_snapshot(self, name: str, snapshot: str, force: bool = False) -> None: ...

    def delete_snapshot(self, name: str, snapshot: str) -> None: ...

    def snapshots(self, name: str) -> list[dict[str, Any]]: ...

    def instance_state(self, name: str) -> dict[str, Any]: ...


@dataclass
class UnixSocketIncus:
    """Client reel, parlant HTTP sur la socket Unix d'Incus."""

    socket_path: str
    timeout: float = 10.0

    def _get(self, path: str) -> dict[str, Any]:
        transport = httpx.HTTPTransport(uds=self.socket_path)
        try:
            with httpx.Client(transport=transport, timeout=self.timeout) as client:
                response = client.get(f"http://incus{path}")
                response.raise_for_status()
                body = response.json()
        except httpx.HTTPStatusError as error:
            # §12.1.2 : le 404 se lit PAREIL sur les trois transports. Il ne le
            # faisait pas — `_request` distinguait l'absence, `_get` la noyait —
            # de sorte que « la cellule a disparu » était dicible pour un geste
            # et indicible pour une lecture, sans qu'aucun appelant puisse
            # savoir lequel il tenait.
            if error.response.status_code == 404:
                raise InstanceAbsente(f"Incus ne connaît pas {path}.") from error
            raise IncusError(
                f"Incus a refusé {path} : {_raison(error)}"
            ) from error
        except httpx.HTTPError as error:
            raise IncusError(
                f"Incus injoignable sur {self.socket_path} ({path}) : {error}"
            ) from error

        if body.get("error_code") == 404:
            raise InstanceAbsente(f"Incus ne connaît pas {path}.")
        if body.get("error_code"):
            raise IncusError(f"Incus a refuse {path} : {body.get('error')}")
        metadata = body.get("metadata")
        if metadata is None:
            raise IncusError(f"Reponse d'Incus sans metadata pour {path}.")
        return metadata

    def _request(self, method: str, path: str, body: dict[str, Any] | None) -> dict[str, Any]:
        """Envoie une commande et ATTEND son aboutissement.

        Incus rend une operation asynchrone : sans l'attendre, on conclurait au
        succes avant que quoi que ce soit ne soit fait, et le registre
        divergerait de la machine.
        """
        transport = httpx.HTTPTransport(uds=self.socket_path)
        try:
            with httpx.Client(transport=transport, timeout=120.0) as client:
                response = client.request(method, f"http://incus{path}", json=body)
                response.raise_for_status()
                envelope = response.json()
        except httpx.HTTPStatusError as error:
            # §14.5 : un 404 est une absence RAPPORTÉE, pas une panne. C'est la
            # seule réponse d'Incus qui autorise à conclure que la chose n'est
            # pas là ; toutes les autres disent qu'on n'a pas pu savoir.
            if error.response.status_code == 404:
                raise InstanceAbsente(
                    f"Incus ne connaît pas {path}.") from error
            raise IncusError(
                f"Incus a refusé {method} {path} : {_raison(error)}") from error
        except httpx.HTTPError as error:
            raise IncusError(f"Incus a refusé {method} {path} : {error}") from error

        if envelope.get("error_code") == 404:
            raise InstanceAbsente(f"Incus ne connaît pas {path}.")
        if envelope.get("error_code"):
            raise IncusError(f"Incus a refuse {method} {path} : {envelope.get('error')}")

        if envelope.get("type") == "async":
            operation = envelope.get("operation", "")
            with httpx.Client(transport=transport, timeout=180.0) as client:
                attente = client.get(f"http://incus{operation}/wait")
                attente.raise_for_status()
                resultat = attente.json().get("metadata") or {}
            if resultat.get("status_code", 200) >= 400 or resultat.get("err"):
                raise IncusError(
                    f"Operation Incus en echec ({method} {path}) : "
                    f"{resultat.get('err') or resultat.get('status')}"
                )
            return resultat
        return envelope.get("metadata") or {}

    def resources(self) -> dict[str, Any]:
        return self._get("/1.0/resources")

    def storage_pool_resources(self, pool: str) -> dict[str, Any]:
        return self._get(f"/1.0/storage-pools/{pool}/resources")

    def server_info(self) -> dict[str, Any]:
        return self._get("/1.0")

    def instances(self) -> list[dict[str, Any]]:
        return self._get("/1.0/instances?recursion=1")

    def create_instance(self, payload: dict[str, Any]) -> None:
        self._request("POST", "/1.0/instances", payload)

    def set_instance_state(self, name: str, action: str) -> None:
        self._request(
            "PUT", f"/1.0/instances/{name}/state",
            {"action": action, "timeout": 60, "force": action == "stop"},
        )

    def delete_instance(self, name: str) -> None:
        """Arrête la cellule, puis la détruit (docs/DAT.md §5.4).

        @spec docs/BACKLOG.md#SPK-90 · docs/DAT.md §5.4

        Incus REFUSE `DELETE` sur une instance en marche — « Instance is
        running », mesuré le 2026-09-02. Sans cet arrêt, supprimer un Spark
        démarré échouait donc toujours, ce qui est le cas ordinaire et non un cas
        limite.

        L'arrêt est FORCÉ : une cellule qui refuse de s'arrêter proprement ne
        doit pas bloquer une suppression que l'exploitant a déjà confirmée. On
        détruit la cellule ; l'arrêter n'ajoute aucune perte.

        Une cellule DÉJÀ arrêtée ne fait pas échouer la suppression : l'arrêt est
        un moyen, pas une condition. Incus refuse alors l'arrêt, et ce refus-là
        n'a pas à remonter.
        """
        try:
            self.set_instance_state(name, "stop")
        except InstanceAbsente:
            # §14.5 : l'instance n'est plus là. La suppression a donc abouti, et
            # l'appelant le lira au `DELETE` qui suit.
            raise
        except IncusError:
            # Déjà arrêtée, ou un arrêt qu'Incus n'a pas voulu : on ne renonce
            # pas pour autant. Si la cellule tourne encore, le `DELETE` le dira
            # avec les mots d'Incus (§5.3) — bien mieux que ce refus-ci.
            pass
        self._request("DELETE", f"/1.0/instances/{name}", None)

    def update_instance_config(self, name: str, config: dict[str, str]) -> None:
        """Fusionne des cles de configuration, sans toucher au reste.

        PATCH et non PUT : un PUT remplacerait la configuration entiere et
        effacerait tout ce qu'on ne renvoie pas.
        """
        self._request("PATCH", f"/1.0/instances/{name}", {"config": config})

    def set_publication_devices(
        self, name: str, devices: dict[str, dict[str, str]]) -> None:
        """Remplace TOUS les devices de publication de l'instance.

        @spec docs/BACKLOG.md#SPK-49 · docs/DAT.md §39.4

        Lecture-modification-écriture, et non `PATCH` : `PATCH` fusionne et ne
        sait donc pas RETIRER un device. Un retrait rapiécé laisserait un port
        ouvert vers un service qui n'est plus là (§39.2).

        Seuls les devices « pub-* » sont touchés : la carte, l'interface réseau
        et le disque racine de l'instance sont relus puis réécrits tels quels.
        Les remplacer serait détruire l'instance par mégarde.
        """
        actuelle = self._get(f"/1.0/instances/{name}")
        metadata = actuelle.get("metadata") or actuelle
        conservees = {
            nom: valeurs
            for nom, valeurs in (metadata.get("devices") or {}).items()
            if not nom.startswith("pub-")
        }
        metadata = dict(metadata)
        metadata["devices"] = {**conservees, **devices}
        self._request("PUT", f"/1.0/instances/{name}", metadata)

    def update_root_size(self, name: str, size: str) -> None:
        """Pose la taille du disque racine (SPK-57, docs/DAT.md §49.2).

        MESURÉ sur la Forge de validation le 2026-08-21 : la taille du disque ne
        vit PAS dans la configuration de l'instance mais dans son **device**
        `root`. Poser la seule configuration laissait donc le registre à 12 Gio
        et Incus à 10 — exactement le pire des cas que la Definition of Done de
        SPK-57 nomme, et la route répondait pourtant `applied: true`.

        Le device est RELU puis réécrit complet : envoyer la seule clé `size`
        ferait perdre `type`, `path` et `pool` sur les pilotes qui remplacent le
        device au lieu de le fusionner.
        """
        actuelle = self._get(f"/1.0/instances/{name}")
        metadata = actuelle.get("metadata") or actuelle
        racine = dict((metadata.get("devices") or {}).get("root") or {})
        if not racine:
            raise IncusError(
                f"L'instance « {name} » n'a pas de device « root » : "
                "la taille de son disque ne peut pas être posée.")
        racine["size"] = size
        self._request("PATCH", f"/1.0/instances/{name}", {"devices": {"root": racine}})

    def push_file(self, name: str, path: str, content: str, mode: str = "0600") -> None:
        """Écrit un fichier dans l'instance, en créant son répertoire parent."""
        parent = path.rsplit("/", 1)[0]
        if parent:
            self._raw_push(name, parent, b"", "0700", "directory")
        self._raw_push(name, path, content.encode("utf-8"), mode, "file")

    def _raw_push(self, name: str, path: str, body: bytes, mode: str, kind: str) -> None:
        transport = httpx.HTTPTransport(uds=self.socket_path)
        entetes = {
            "X-Incus-uid": "0", "X-Incus-gid": "0",
            "X-Incus-mode": mode, "X-Incus-type": kind,
        }
        try:
            with httpx.Client(transport=transport, timeout=self.timeout) as client:
                reponse = client.post(
                    f"http://incus/1.0/instances/{name}/files",
                    params={"path": path}, content=body, headers=entetes,
                )
                if kind == "directory" and reponse.status_code in (400, 409, 500):
                    return  # le repertoire existe deja : ce n'est pas une erreur
                reponse.raise_for_status()
        except httpx.HTTPStatusError as error:
            # §12.1.2 : troisième transport, même règle. Sans elle, poser une clé
            # dans une cellule disparue se lisait comme un refus d'écriture.
            if error.response.status_code == 404:
                raise InstanceAbsente(
                    f"Incus ne connaît pas l'instance « {name} ».") from error
            raise IncusError(
                f"Écriture de {path} dans « {name} » refusée : {_raison(error)}"
            ) from error
        except httpx.HTTPError as error:
            raise IncusError(
                f"Écriture de {path} dans « {name} » refusée : {error}"
            ) from error

    def exec_command(self, name: str, command: list[str]) -> None:
        self._request(
            "POST", f"/1.0/instances/{name}/exec",
            {"command": command, "wait-for-websocket": False,
             "interactive": False, "record-output": False},
        )

    def exec_capture(self, name: str, command: list[str]) -> tuple[int, str, str]:
        """Exécute et REND le code de sortie et les deux flux (docs/DAT.md §42.5).

        @spec docs/BACKLOG.md#SPK-54 · docs/DAT.md §42.5, §42.6

        `exec_command` ci-dessus poste la commande et n'en rend rien : cela suffit
        pour ordonner un geste, pas pour DÉTECTER, qui est le principe du §42.1.

        Le point qui décide : **un code de sortie non nul n'est pas une erreur du
        pilote**. `command -v sshd` qui rend 1 est une réponse — « absent » —, pas
        une panne. Seule une opération qu'Incus refuse lève. Confondre les deux
        ferait échouer l'amorçage sur ce qu'il est précisément venu constater.
        """
        resultat = self._request(
            "POST", f"/1.0/instances/{name}/exec",
            {"command": command, "wait-for-websocket": False,
             "interactive": False, "record-output": True},
        )
        interne = resultat.get("metadata") or {}
        sorties = interne.get("output") or {}
        return (
            int(interne.get("return", 0)),
            self._lire_sortie(sorties.get("1")),
            self._lire_sortie(sorties.get("2")),
        )

    def _lire_sortie(self, chemin: str | None) -> str:
        """Récupère un flux enregistré par une exécution.

        Ces fichiers ne sont PAS du JSON : `_get` les rejetterait. Une sortie
        illisible rend la chaîne vide plutôt que de lever — la détection saura
        conclure « absent » d'une réponse muette, alors qu'une exception ferait
        échouer le relevé entier pour un flux d'erreur qu'on ne lisait que par
        acquit de conscience.
        """
        if not chemin:
            return ""
        transport = httpx.HTTPTransport(uds=self.socket_path)
        try:
            with httpx.Client(transport=transport, timeout=self.timeout) as client:
                reponse = client.get(f"http://incus{chemin}")
                reponse.raise_for_status()
                return reponse.text
        except httpx.HTTPError:
            return ""

    def create_snapshot(self, name: str, snapshot: str) -> None:
        # `stateful` reste faux : la capture memoire echoue sur cet hote, CRIU
        # etant construit sans le support de nftables (docs/DAT.md §19.3).
        self._request(
            "POST", f"/1.0/instances/{name}/snapshots",
            {"name": snapshot, "stateful": False},
        )

    def restore_snapshot(self, name: str, snapshot: str, force: bool = False) -> None:
        """Restaure. `force` autorise la destruction des instantanés plus récents.

        ZFS rembobine le jeu de données : Incus refuse tant que
        `zfs.remove_snapshots` n'est pas posé sur le volume. Ce refus est le
        défaut voulu (docs/DAT.md §19.1) ; on ne lève la garde que le temps de
        l'opération, et on la repose ensuite.
        """
        if not force:
            self._request("PUT", f"/1.0/instances/{name}", {"restore": snapshot})
            return
        self.update_instance_config(name, {"volatile.spark.restoring": "true"})
        try:
            self._request(
                "PATCH", f"/1.0/instances/{name}",
                {"devices": {"root": {"type": "disk", "path": "/",
                                      "zfs.remove_snapshots": "true"}}},
            )
            self._request("PUT", f"/1.0/instances/{name}", {"restore": snapshot})
        finally:
            self._request(
                "PATCH", f"/1.0/instances/{name}",
                {"devices": {"root": {"type": "disk", "path": "/",
                                      "zfs.remove_snapshots": "false"}}},
            )

    def delete_snapshot(self, name: str, snapshot: str) -> None:
        self._request("DELETE", f"/1.0/instances/{name}/snapshots/{snapshot}", None)

    def snapshots(self, name: str) -> list[dict[str, Any]]:
        return self._get(f"/1.0/instances/{name}/snapshots?recursion=1")

    def instance_state(self, name: str) -> dict[str, Any]:
        return self._get(f"/1.0/instances/{name}/state")


#: SPK-76 · §42.9 : ce que le doublon répond à `/etc/os-release`, par image du
#: catalogue (§33). Alpine y figure DÉLIBÉRÉMENT : c'est la cellule que
#: l'amorçage doit refuser, et une preuve du refus exige de pouvoir la monter.
#: SPK-85 · §44.9.2 : `arch` accompagne la distribution. Le doublon rend celle du
#: poste qui l'exécute — une valeur inventée ferait éprouver le dossier contre
#: une architecture que rien ne porte.
_OS_PAR_ALIAS = {
    "debian/13": {"os_id": "debian", "os_suite": "trixie", "os_like": "",
                  "arch": platform.machine()},
    "debian/12": {"os_id": "debian", "os_suite": "bookworm", "os_like": "",
                  "arch": platform.machine()},
    "ubuntu/24.04": {"os_id": "ubuntu", "os_suite": "noble", "os_like": "debian",
                     "arch": platform.machine()},
    "alpine/3.21": {"os_id": "alpine", "os_suite": "", "os_like": "",
                    "arch": platform.machine()},
}

#: Une image inconnue du doublon est traitée comme la Debian 13 par défaut du
#: catalogue : le doublon ne doit pas rendre inamorçable ce que la Forge amorce.
_OS_DEFAUT = _OS_PAR_ALIAS["debian/13"]


def _os_de_alias(alias: str) -> dict[str, str]:
    return dict(_OS_PAR_ALIAS.get(alias, _OS_DEFAUT))


def _faux_ed25519(graine: str) -> str:
    """Corps de cle ed25519 STRUCTURELLEMENT valide, pour le doublon (§28.4).

    `sshkeys.parse` verifie le base64 ET que le blob annonce bien son type. Une
    chaine quelconque serait refusee, et les preuves d'identite passeraient a
    cote de l'analyseur qu'elles doivent exercer.
    """
    brut = hashlib.sha256(graine.encode()).digest()
    blob = (len("ssh-ed25519").to_bytes(4, "big") + b"ssh-ed25519"
            + (32).to_bytes(4, "big") + brut)
    return base64.b64encode(blob).decode()


#: SPK-93 · docs/DAT.md §52.10 — le doublon rendait `cpu.usage` CONSTANT, et ses
#: compteurs reseau aussi. Sur un releve isole la divergence est invisible : le
#: §20 rend `null` au premier point. Sur une SERIE elle devient structurante —
#: quatre lignes plates, et ni le re-echantillonnage du §52.6, ni la distinction
#: burst du SPK-DS-02, ni la mise a l'echelle d'un axe ne sont eprouvables.
#:
#: Un compteur qui n'avance pas n'est pas un compteur : le §12.1.3 impose au
#: doublon la meme FORME de reponse que le vrai pour la meme condition.
#:
#: Le profil est DETERMINISTE : aucun tirage aleatoire, une fonction pure de
#: (nom, secondes ecoulees). Meme Spark, meme duree ecoulee, meme serie — sans
#: quoi les captures du §30.1 cesseraient d'etre reproductibles.
#:
#: Il ne mesure RIEN. Il donne a la supervision une FORME a eprouver, jamais une
#: consommation a croire : la borne du §12 est inchangee.
_PROFIL_PERIODE = 900.0
#: Origine du temps du profil : un instant FIXE, et non le demarrage du
#: processus.
#:
#: MESURE le 2026-09-07 : ancree sur le demarrage, l'origine faisait repartir le
#: disque de sa base a chaque lancement. L'historique constitue par le seed et
#: les releves qui le suivaient formaient alors une MARCHE, visible a l'ecran,
#: que rien n'avait produite. Un doublon qui se contredit d'un processus a
#: l'autre n'imite plus rien (§12.1.3).
#:
#: 2026-01-01T00:00:00Z, en secondes depuis l'epoque Unix.
_PROFIL_ORIGINE = 1_767_225_600.0


def _profil(name: str) -> dict[str, float]:
    """Signature stable d'une instance, tiree de son nom. Sans hasard."""
    graine = int(hashlib.sha256(name.encode()).hexdigest()[:12], 16)
    return {
        # Part de CPU moyenne : de 0,03 a 0,42 coeur.
        "cpu": 0.03 + (graine % 40) / 100.0,
        # Amplitude de la respiration, de 0,25 a 0,80 de la moyenne.
        "amplitude": 0.25 + (graine // 41 % 56) / 100.0,
        # Dephasage, pour que deux Sparks ne montent pas ensemble.
        "phase": (graine // 977 % 360) * math.pi / 180.0,
        # Octets par seconde : de 6 ko/s a ~500 ko/s en entree.
        "rx": 6_000.0 + (graine // 13 % 500_000),
        "tx": 3_000.0 + (graine // 17 % 250_000),
        # Memoire de base : de 96 a 608 Mio.
        "memoire": (96 + (graine // 23 % 512)) * 1024.0 ** 2,
        # Disque de base : de 300 a 1200 Mio, sous le plus petit quota vendu.
        "disque": (300 + (graine // 29 % 900)) * 1024.0 ** 2,
    }


#: Rapport de la seconde harmonique a la premiere. Irrationnel a dessein : une
#: seule periode dessinerait quatre bosses IDENTIQUES par heure, forme qu'aucun
#: systeme reel ne produit et qui n'eprouve ni la mise a l'echelle ni l'oeil.
_HARMONIQUE = 3.7
#: Les deux amplitudes somment a 0,85 x amplitude au pire : le facteur reste
#: strictement positif, donc le compteur reste croissant (§52.10).
_POIDS = (0.60, 0.25)


def _module(secondes: float, profil: dict[str, float]) -> float:
    """Facteur de modulation a l'instant donne. Strictement positif."""
    omega = 2 * math.pi / _PROFIL_PERIODE
    return (1.0
            + _POIDS[0] * profil["amplitude"] * math.sin(omega * secondes + profil["phase"])
            + _POIDS[1] * profil["amplitude"] * math.sin(
                _HARMONIQUE * omega * secondes + 2 * profil["phase"]))


def _integrale(secondes: float, profil: dict[str, float]) -> float:
    """Primitive de la modulation, pour que le COMPTEUR soit l'integrale du taux.

    Un compteur n'est pas un taux echantillonne : c'est son cumul. Poser
    `compteur = taux x t` donnerait un taux constant a la derivee, donc les
    memes lignes plates qu'avant. On integre donc la modulation :

        taux(t)     = c (1 + a sin(w t + p))
        compteur(t) = c (t - (a/w) cos(w t + p))
    """
    omega = 2 * math.pi / _PROFIL_PERIODE
    return (secondes
            - (_POIDS[0] * profil["amplitude"] / omega)
            * math.cos(omega * secondes + profil["phase"])
            - (_POIDS[1] * profil["amplitude"] / (_HARMONIQUE * omega))
            * math.cos(_HARMONIQUE * omega * secondes + 2 * profil["phase"]))


def etat_simule(name: str, secondes: float) -> dict[str, Any]:
    """Etat plausible d'une cellule apres `secondes` de fonctionnement.

    @spec docs/BACKLOG.md#SPK-93 · docs/DAT.md §52.10, §12.1.3

    Publique et pure : le seed de developpement la rejoue a des instants passes
    pour constituer un historique par le VRAI ecrivain de l'historien, plutot
    que d'inventer des lignes a la main (CLAUDE.md §8).
    """
    profil = _profil(name)
    cumul = _integrale(secondes, profil) - _integrale(0.0, profil)
    return {
        "status": "Running",
        "cpu": {"usage": int(profil["cpu"] * cumul * 1e9)},
        "memory": {
            "usage": int(profil["memoire"] * _module(secondes, profil)),
            "total": 2 * 1024 ** 3,
        },
        "disk": {"root": {
            "total": 10 * 1024 ** 3,
            # Le disque DERIVE lentement, il ne croit pas sans fin.
            #
            # MESURE le 2026-09-07 : une croissance monotone de quelques kio par
            # seconde, rapportee a une origine fixe vieille de huit mois, portait
            # l'occupation a 93 Gio SOUS UN QUOTA DE 10 Gio. Un doublon qui
            # depasse la limite qu'il est cense respecter ne montre plus rien de
            # ce que le produit refuse (§49.3).
            #
            # Une derive lente est aussi plus juste qu'une croissance pure : un
            # disque reel monte ET descend, les journaux tournent et les images
            # se purgent.
            "usage": int(profil["disque"] * (1 + 0.06 * math.sin(
                2 * math.pi * secondes / (6 * _PROFIL_PERIODE)
                + profil["phase"]))),
        }},
        "network": {
            "eth0": {"counters": {
                "bytes_received": int(profil["rx"] * cumul),
                "bytes_sent": int(profil["tx"] * cumul),
            }},
            # docs/DAT.md §20.2 : le vrai releve enumere AUSSI les bridges que
            # Docker cree dans le Spark. Le doublon les rend, sans quoi la regle
            # « seule eth0 compte » ne serait eprouvee contre rien.
            "docker0": {"counters": {
                "bytes_received": int(profil["rx"] * cumul * 12),
                "bytes_sent": int(profil["tx"] * cumul * 12),
            }},
        },
    }


@dataclass
class FakeIncus:
    """Pilote factice, pour les tests et le developpement local.

    Il rend la meme FORME que l'hote reel — structure relevee le 2026-08-18 —
    afin que la traduction eprouvee ici soit celle qui tournera en production.
    Il ne prouve jamais qu'un quota est applique : cela exige un hote reel
    (docs/DAT.md §12).

    `state_path` rend le pilote PERSISTANT, ce qu'exige la pile de developpement
    (docs/DAT.md §28.4). Sans lui, les instances vivent en memoire : un Spark
    seede « en marche » survit au redemarrage de sparkd — le registre est un
    fichier — mais « Arreter » echoue ensuite sur « instance absente ». La pile
    parait fonctionnelle jusqu'au premier geste, ce qui est pire qu'une panne
    franche.

    Les tests n'en passent pas : sans chemin, le comportement est celui d'avant.

    CE QU'IL IMITE FIDÈLEMENT, et que le §12.1.3 lui impose : la même exception
    que le vrai pilote pour la même condition, méthode par méthode ; l'aveu
    plutôt que la réponse inventée quand Incus ne répondrait pas ; la simulation
    d'un pilote injoignable sur CHAQUE méthode, sans quoi la borne du §33.3 y
    serait inéprouvable ; et la relecture de son état à chaque opération,
    puisque le vrai pilote n'a aucun cache.

    CE QU'IL N'IMITE PAS, écrit ici parce qu'une divergence non écrite est un
    piège pour la session suivante (§12.1.3) :

    - **l'application effective d'un quota.** Il enregistre la configuration
      traduite, il ne la fait appliquer par aucun noyau. Une preuve verte ici ne
      dit RIEN de ce qu'une Forge appliquera (§12) ;
    - **les délais et les états intermédiaires.** Une opération d'Incus est
      asynchrone et passe par des états que le doublon saute : il conclut
      immédiatement. Une course entre deux gestes ne s'éprouve donc pas contre
      lui ;
    - **le noyau, AppArmor et le cgroup.** Rien de ce qui relève du confinement
      réel n'a d'équivalent ici.

    Chacune de ces trois limites est de NATURE, pas une dette : la combler
    demanderait un vrai Incus, auquel cas le doublon n'aurait plus de raison
    d'être.
    """

    payload: dict[str, Any] | None = None
    pool_payload: dict[str, Any] | None = None
    created: dict[str, dict[str, Any]] = field(default_factory=dict)
    state_path: Path | None = None
    #: Panne a injecter, consommee une fois : {operation: message}.
    #: Elle sert a EXECUTER REELLEMENT le chemin d'erreur du produit, pas a
    #: fabriquer sa trace (CLAUDE.md §8, §15). Le seed s'en sert pour qu'un Spark
    #: atteigne l'etat `error` par la meme route que celle qui echouerait en
    #: production.
    fail_next: dict[str, str] = field(default_factory=dict)

    def _maybe_fail(self, operation: str) -> None:
        message = self.fail_next.pop(operation, None)
        if message is not None:
            raise IncusError(message)

    def __post_init__(self) -> None:
        if self.state_path is not None and self.state_path.exists():
            self.created = json.loads(self.state_path.read_text(encoding="utf-8"))

    def _recharger(self) -> None:
        """Relit l'état persisté AVANT chaque opération (docs/DAT.md §12.1.3).

        Le vrai pilote n'a AUCUN cache : il interroge Incus à chaque appel. Le
        doublon chargeait le sien une fois pour toutes, si bien qu'une cellule
        disparue hors du produit lui restait invisible tant que le service
        tournait — c'est-à-dire que l'évènement instruit par
        `docs/CONTINGENCE.md` §4 était injouable contre la pile de développement
        sans redémarrer `sparkd`.

        Un état ILLISIBLE ne lève pas : `_persist` écrit de façon atomique, mais
        rien n'interdit qu'un autre processus soit en train d'écrire. On garde
        alors ce qu'on a plutôt que de faire échouer une opération pour une
        course de lecture.
        """
        if self.state_path is None or not self.state_path.exists():
            return
        try:
            self.created = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass

    def _vivante(self, name: str) -> dict[str, Any]:
        """L'instance, ou l'absence RAPPORTÉE (docs/DAT.md §12.1.2).

        Un seul endroit pour cette réponse : c'est parce qu'elle était réécrite
        à chaque méthode que six d'entre elles ont divergé du vrai pilote sans
        que rien ne rougisse.
        """
        self._recharger()
        if name not in self.created:
            raise InstanceAbsente(f"Instance « {name} » absente.")
        return self.created[name]

    def _persist(self) -> None:
        if self.state_path is None:
            return
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        # Ecriture atomique : une pile interrompue en plein enregistrement
        # laisserait sinon un fichier tronque, et le demarrage suivant
        # echouerait sur un JSON invalide sans rapport avec sa cause.
        provisoire = self.state_path.with_suffix(".tmp")
        provisoire.write_text(json.dumps(self.created), encoding="utf-8")
        provisoire.replace(self.state_path)

    def resources(self) -> dict[str, Any]:
        self._maybe_fail("resources")
        return self.payload if self.payload is not None else _EXEMPLE_HOTE

    def storage_pool_resources(self, pool: str) -> dict[str, Any]:
        self._maybe_fail("storage_pool_resources")
        if self.pool_payload is not None:
            return self.pool_payload
        return {"space": {"total": 207_030_845_440, "used": 739_906_560}}

    def server_info(self) -> dict[str, Any]:
        self._maybe_fail("server_info")
        return {"environment": {"server_name": "spark-experiment", "server_version": "7.3"}}

    def instances(self) -> list[dict[str, Any]]:
        self._maybe_fail("instances")
        return list(self.created.values())

    def set_publication_devices(
        self, name: str, devices: dict[str, dict[str, str]]) -> None:
        """@spec docs/BACKLOG.md#SPK-49 · docs/DAT.md §39.4

        Même sémantique que le pilote réel : les devices « pub-* » sont
        REMPLACÉS, les autres sont conservés. C'est ce qui permet d'éprouver
        qu'un retrait fait bien disparaître le device — et donc que le port se
        referme (§39.2).
        """
        self._maybe_fail("set_publication_devices")
        instance = self._vivante(name)
        conservees = {
            nom: valeurs for nom, valeurs in (instance.get("devices") or {}).items()
            if not nom.startswith("pub-")
        }
        instance["devices"] = {**conservees, **devices}

    def update_root_size(self, name: str, size: str) -> None:
        """Meme semantique que le pilote reel : le device `root` porte la taille.

        Le doublon la garde dans `devices`, la ou le vrai Incus la garde — sans
        quoi une preuve verte ici ne dirait rien de la Forge (SPK-57, §49.2).
        """
        self._maybe_fail("update_root_size")
        instance = self._vivante(name)
        devices = dict(instance.get("devices") or {})
        racine = dict(devices.get("root") or {"type": "disk", "path": "/"})
        racine["size"] = size
        devices["root"] = racine
        instance["devices"] = devices
        self._persist()

    def create_instance(self, payload: dict[str, Any]) -> None:
        self._maybe_fail("create_instance")
        nom = payload["name"]
        if nom in self.created:
            raise IncusError(f"Instance « {nom} » deja presente.")
        # SPK-76 · §42.9 : le doublon retient l'ALIAS de l'image. La famille de
        # la cellule décide désormais de tout l'amorçage ; sans elle ici, une
        # preuve verte ne dirait rien d'une Forge où les images diffèrent, et le
        # refus d'une Alpine serait inéprouvable.
        self.created[nom] = {"name": nom, "status": "Stopped",
                             "config": payload.get("config", {}),
                             "alias": (payload.get("source") or {}).get("alias", "")}
        self._persist()

    def set_instance_state(self, name: str, action: str) -> None:
        # SPK-36 · §14.5, puis SPK-67 · §12.1 : le VRAI pilote lève
        # `InstanceAbsente` sur tout 404, donc ici aussi — et par l'aide
        # commune, qui RELIT l'état avant de conclure (§12.1.3, point 3).
        self._maybe_fail("set_instance_state")
        self._vivante(name)["status"] = "Running" if action == "start" else "Stopped"
        self._persist()

    def delete_instance(self, name: str) -> None:
        # §14.5 : une absence RAPPORTÉE porte son propre type. Le pilote factice
        # doit la rendre comme le vrai, sans quoi la règle serait éprouvée sur
        # une forme qui ne tournera jamais en production.
        self._maybe_fail("delete_instance")
        self._vivante(name)
        del self.created[name]
        self._persist()

    def update_instance_config(self, name: str, config: dict[str, Any]) -> None:
        self._maybe_fail("update_instance_config")
        self._vivante(name).setdefault("config", {}).update(config)
        self._persist()

    def push_file(self, name: str, path: str, content: str, mode: str = "0600") -> None:
        self._maybe_fail("push_file")
        instance = self._vivante(name)
        instance.setdefault("files", {})[path] = content
        # SPK-60 · §44.8 : la permission fait partie de la projection. Ne pas
        # la retenir dans le doublon laisserait une preuve verte sur 0644 alors
        # que le vrai pilote reçoit 0600.
        instance.setdefault("file_modes", {})[path] = mode
        # Écrire `authorized_keys` change ce que le relevé du §42.6 y lira : sur
        # une vraie cellule, `sha256sum` suit le fichier. Sans cela, l'amorçage
        # réécrirait les clés à chaque passage et ne serait jamais idempotent —
        # or c'est le point de la DoD (SPK-54, §42.1).
        if path.endswith("/authorized_keys"):
            import hashlib

            # SPK-95 · §42.2 quater : deux portes, deux empreintes. Les confondre
            # ferait passer une seconde porte vide pour une premiere en ordre.
            cle = "cles_rootless" if "/home/" in path else "cles"
            self.created[name].setdefault("runtime", {})[cle] = (
                hashlib.sha256(content.encode("utf-8")).hexdigest()[:64]
            )
        self._persist()

    def exec_command(self, name: str, command: list[str]) -> None:
        self._maybe_fail("exec_command")
        self._vivante(name).setdefault("commands", []).append(command)
        self._persist()

    def exec_capture(self, name: str, command: list[str]) -> tuple[int, str, str]:
        """Doublon d'`exec_capture` (docs/DAT.md §28.4, §42.5).

        La cellule factice porte un état de RUNTIME — ce qui y est installé — que
        les scénarios posent dans `runtime`. Sans lui, la détection du §42.6
        n'aurait rien à observer et l'amorçage ne pourrait être éprouvé que sur
        une cellule vierge, c'est-à-dire jamais sur le cas qui compte : celle qui
        est déjà complète.
        """
        self._maybe_fail("exec_capture")
        self._vivante(name).setdefault("commands", []).append(command)
        script = command[-1] if command else ""
        runtime = self.created[name].setdefault("runtime", {})
        runtime.update(_os_de_alias(self.created[name].get("alias", "")))
        # SPK-94 · §42.2 quater : une image de distribution ARRIVE avec ses
        # scripts `/etc/update-motd.d`. Les poser par defaut est ce qui rend le
        # silence eprouvable : un doublon nait sans bandeau n'aurait jamais fait
        # passer le geste qui le tait.
        runtime.setdefault("motd_distro", "present")
        if "chmod -x /etc/update-motd.d" in script:
            runtime["motd_distro"] = "absent"

        # SPK-74 · §17.5 : le doublon porte l'EFFET de la creation d'identite,
        # pas seulement son passage. Sans lui, un second appel retrouverait la
        # cellule vierge et le refus d'ecrasement — qui est le point de la DoD —
        # serait ineprouvable. La reconnaissance porte sur la COMMANDE entiere :
        # l'identite passe son script en `sh -c <script> sh <commentaire> <oui>`,
        # donc le dernier argument n'est pas le script.
        entier = " ".join(command)
        if "ssh-keygen -t ed25519" in entier:
            remplacer = command[-1] == "oui"
            if runtime.get("identity") and not remplacer:
                return (3, "", "")
            comment = command[-2] if len(command) >= 2 else "spark"
            graine = f"{name}:{comment}:{len(runtime.get('identity_history', []))}"
            runtime["identity"] = f"ssh-ed25519 {_faux_ed25519(graine)} {comment}"
            runtime.setdefault("identity_history", []).append(runtime["identity"])
            self._persist()
            return (0, runtime["identity"] + "\n", "")
        if "id_ed25519.pub" in entier:
            if not runtime.get("identity"):
                return (4, "", "")
            return (0, runtime["identity"] + "\n", "")

        # Le doublon représente l'EFFET de la commande, pas seulement son
        # passage. Sans cela, un second amorçage retrouverait la cellule vierge
        # et réinstallerait tout — l'idempotence, qui est le point de la DoD,
        # serait alors inéprouvable de bout en bout (§28.4, §42.1).
        # Les marqueurs portent sur ce qui INSTALLE, jamais sur ce qui interroge.
        # Mesuré : le relevé du §42.6 contient « docker-ce » dans son
        # `dpkg-query`, et un marqueur posé sur ce mot faisait déclarer Docker
        # installé par la commande même qui venait constater son absence.
        installe = "apt-get install" in script
        if installe and "openssh-server" in script:
            runtime["sshd"] = "active"
            runtime["openssh_version"] = "1:9.8p1-1"
        # SPK-76 · §42.9.3 : le doublon retient CE QUE le dépôt nomme, pas le
        # fait qu'il existe. Un `depot=present` opaque rendait le défaut du
        # §42.9.3 — un dépôt qui pointe une autre distribution — inéprouvable.
        marque = re.search(r"download\.docker\.com/linux/([a-z]+) (\S+) stable", script)
        if marque and "> /etc/apt/sources.list.d/docker.list" in script:
            runtime["depot_distro"], runtime["depot_suite"] = marque.groups()
        if installe and "docker-ce" in script:
            runtime["docker"] = "Docker version 29.7.2"
            # §42.9.4 : la version PORTE l'origine du paquet, et c'est ce qui
            # permet de voir un `docker-ce` venu du mauvais dépôt.
            suite = runtime.get("depot_suite") or runtime.get("os_suite") or "trixie"
            distro = runtime.get("depot_distro") or runtime.get("os_id") or "debian"
            runtime["docker_version"] = f"5:29.7.2-1~{distro}.1~{suite}"
            runtime["origine"] = "docker-ce"
            # §42.2 bis : le mode que la cellule PORTE après l'installation. Sans
            # lui, un second amorçage ne verrait aucun mode en place et le refus
            # de bascule ne pourrait pas être éprouvé.
            runtime["mode"] = ("rootless"
                               if "dockerd-rootless-setuptool" in script
                               else "enracine")
            # SPK-94 · §42.2 ter : le releve rend l'identite NUMERIQUE du compte
            # rootless, et seulement dans ce mode. Le doublon la pose ici pour
            # la meme raison qu'il pose le mode : sans elle, l'ouverture des
            # fichiers au compte serait ineprouvable de bout en bout.
            if runtime["mode"] == "rootless":
                runtime["rootless_uid"] = "1001"
                runtime["rootless_gid"] = "1001"
            else:
                runtime.pop("rootless_uid", None)
                runtime.pop("rootless_gid", None)
        if installe and "docker-compose-plugin" in script:
            runtime["compose"] = "Docker Compose version v2.40.0"
            runtime["compose_version"] = "2.40.0-1"
        self._persist()

        # L'identite n'est pas un element du releve du §42.6 : la recracher en
        # ligne `cle=valeur` la ferait apparaitre dans l'amorcage.
        lignes = "".join(f"{cle}={valeur}\n" for cle, valeur in runtime.items()
                         if not cle.startswith("identity"))
        return (0, lignes, "")

    def create_snapshot(self, name: str, snapshot: str) -> None:
        self._maybe_fail("create_snapshot")
        self._vivante(name).setdefault("snapshots", []).append(
            {"name": snapshot, "stateful": False, "size": 0}
        )
        self._persist()

    def restore_snapshot(self, name: str, snapshot: str, force: bool = False) -> None:
        self._maybe_fail("restore_snapshot")
        pris = [s["name"] for s in self._vivante(name).get("snapshots", [])]
        if snapshot not in pris:
            raise IncusError(f"Instantané « {snapshot} » absent.")
        if not force and pris[-1] != snapshot:
            raise IncusError("Instantanés plus récents présents.")
        self.created[name]["snapshots"] = [
            s for s in self.created[name]["snapshots"]
            if pris.index(s["name"]) <= pris.index(snapshot)
        ]
        self.created[name]["restored"] = snapshot
        self._persist()

    def delete_snapshot(self, name: str, snapshot: str) -> None:
        self._maybe_fail("delete_snapshot")
        instance = self._vivante(name)
        instance["snapshots"] = [
            s for s in instance.get("snapshots", []) if s["name"] != snapshot
        ]
        self._persist()

    def snapshots(self, name: str) -> list[dict[str, Any]]:
        """Rend `[]` sur une instance absente, et c'est FIDÈLE.

        MESURÉ sur la Forge de validation le 2026-08-21, contre un vrai Incus :
        `GET /1.0/instances/<inconnue>/snapshots` rend **200** et `metadata: []`
        — exactement ce qu'il rend pour une instance qui existe et n'a aucun
        instantané. Tous les autres points du contrat rendent 404 ; celui-ci est
        un angle mort de l'API d'Incus.

        Le doublon le REPRODUIT au lieu de le corriger. Lever ici rendrait vertes
        des preuves reposant sur une distinction que le produit ne peut pas faire
        en production — c'est-à-dire le défaut même que cette unité traite, à
        l'envers (§12.1.2).
        """
        self._maybe_fail("snapshots")
        self._recharger()
        return list(self.created.get(name, {}).get("snapshots", []))

    def instance_state(self, name: str) -> dict[str, Any]:
        self._maybe_fail("instance_state")
        instance = self._vivante(name)
        if instance.get("state"):
            return instance["state"]
        # SPK-93 · §52.10 : les compteurs AVANCENT, comme ceux du vrai pilote.
        # Le temps ecoule depuis le demarrage du processus fait la duree : deux
        # lectures separees d'une cadence rendent donc un taux, et non `null`
        # a l'infini.
        etat = etat_simule(name, time.time() - _PROFIL_ORIGINE)
        etat["status"] = instance.get("status", "Running")
        return etat


# Releve reel de l'hote de validation, 2026-08-18 : Dell R320, Xeon E5-1410 v2,
# 4 coeurs / 8 threads, freres SMT (0,4) (1,5) (2,6) (3,7).
_EXEMPLE_HOTE: dict[str, Any] = {
    "cpu": {
        "architecture": "x86_64",
        "total": 8,
        "sockets": [
            {
                "socket": 0,
                "name": "Intel(R) Xeon(R) CPU E5-1410 v2 @ 2.80GHz",
                "cores": [
                    {
                        "core": noyau,
                        "die": 0,
                        "threads": [
                            {"id": noyau, "thread": 0, "numa_node": 0, "online": True, "isolated": False},
                            {"id": noyau + 4, "thread": 1, "numa_node": 0, "online": True, "isolated": False},
                        ],
                    }
                    for noyau in range(4)
                ],
            }
        ],
    },
    "memory": {"total": 105_226_698_752, "used": 6_367_989_760},
    "network": {
        "cards": [
            {"ports": [{"id": "eno1", "link_speed": 1000, "link_detected": True}]},
            {"ports": [{"id": "eno2", "link_speed": None, "link_detected": False}]},
        ]
    },
    # `/1.0/resources` ne porte AUCUN nom d'hote : sa clé « system » decrit le
    # materiel — chassis, firmware, carte mere, numeros de serie. Le nom vient
    # de `/1.0` → `environment.server_name`. Les numeros de serie ne sont ni
    # stockes ni journalises : ils identifient la machine sans servir au produit.
}
