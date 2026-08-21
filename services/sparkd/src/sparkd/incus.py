"""Client de l'API Incus, sur la socket Unix.

@spec docs/BACKLOG.md#SPK-07 · docs/DAT.md §5.1 (Acces a Incus), §5.2 (ce qui
      est lu, et ou)

On ne lance jamais le binaire « incus » : sa sortie est un format d'affichage,
qui change sans preavis et se parse mal — la commande n'accepte meme aucun
« --format ». L'API rend des types.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import json

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
        except httpx.HTTPError as error:
            raise IncusError(
                f"Incus injoignable sur {self.socket_path} ({path}) : {error}"
            ) from error

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
            raise IncusError(f"Incus a refuse {method} {path} : {error}") from error
        except httpx.HTTPError as error:
            raise IncusError(f"Incus a refuse {method} {path} : {error}") from error

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
        return self.payload if self.payload is not None else _EXEMPLE_HOTE

    def storage_pool_resources(self, pool: str) -> dict[str, Any]:
        if self.pool_payload is not None:
            return self.pool_payload
        return {"space": {"total": 207_030_845_440, "used": 739_906_560}}

    def server_info(self) -> dict[str, Any]:
        return {"environment": {"server_name": "spark-experiment", "server_version": "7.3"}}

    def instances(self) -> list[dict[str, Any]]:
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
        instance = self.created.get(name)
        if instance is None:
            raise IncusError(f"Instance « {name} » absente.")
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
        instance = self.created.get(name)
        if instance is None:
            raise IncusError(f"Instance « {name} » absente.")
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
        self.created[nom] = {"name": nom, "status": "Stopped", "config": payload.get("config", {})}
        self._persist()

    def set_instance_state(self, name: str, action: str) -> None:
        # SPK-36 · §14.5 : le VRAI pilote lève `InstanceAbsente` sur tout 404,
        # donc ici aussi. Le factice rendait `IncusError`, que la route du cycle
        # de vie attrapait : la panne était invisible en preuve et bien réelle
        # sur la Forge. C'est exactement l'écart que le commentaire de
        # `delete_instance`, juste dessous, interdit.
        self._maybe_fail("set_instance_state")
        if name not in self.created:
            raise InstanceAbsente(f"Instance « {name} » absente.")
        self.created[name]["status"] = "Running" if action == "start" else "Stopped"
        self._persist()

    def delete_instance(self, name: str) -> None:
        # §14.5 : une absence RAPPORTÉE porte son propre type. Le pilote factice
        # doit la rendre comme le vrai, sans quoi la règle serait éprouvée sur
        # une forme qui ne tournera jamais en production.
        self._maybe_fail("delete_instance")
        if name not in self.created:
            raise InstanceAbsente(f"Instance « {name} » absente.")
        del self.created[name]
        self._persist()

    def update_instance_config(self, name: str, config: dict[str, Any]) -> None:
        if name not in self.created:
            raise IncusError(f"Instance « {name} » absente.")
        self.created[name].setdefault("config", {}).update(config)
        self._persist()

    def push_file(self, name: str, path: str, content: str, mode: str = "0600") -> None:
        if name not in self.created:
            raise IncusError(f"Instance « {name} » absente.")
        self.created[name].setdefault("files", {})[path] = content
        # Écrire `authorized_keys` change ce que le relevé du §42.6 y lira : sur
        # une vraie cellule, `sha256sum` suit le fichier. Sans cela, l'amorçage
        # réécrirait les clés à chaque passage et ne serait jamais idempotent —
        # or c'est le point de la DoD (SPK-54, §42.1).
        if path.endswith("/authorized_keys"):
            import hashlib

            self.created[name].setdefault("runtime", {})["cles"] = (
                hashlib.sha256(content.encode("utf-8")).hexdigest()[:64]
            )
        self._persist()

    def exec_command(self, name: str, command: list[str]) -> None:
        if name not in self.created:
            raise IncusError(f"Instance « {name} » absente.")
        self.created[name].setdefault("commands", []).append(command)
        self._persist()

    def exec_capture(self, name: str, command: list[str]) -> tuple[int, str, str]:
        """Doublon d'`exec_capture` (docs/DAT.md §28.4, §42.5).

        La cellule factice porte un état de RUNTIME — ce qui y est installé — que
        les scénarios posent dans `runtime`. Sans lui, la détection du §42.6
        n'aurait rien à observer et l'amorçage ne pourrait être éprouvé que sur
        une cellule vierge, c'est-à-dire jamais sur le cas qui compte : celle qui
        est déjà complète.
        """
        if name not in self.created:
            raise IncusError(f"Instance « {name} » absente.")
        self.created[name].setdefault("commands", []).append(command)
        script = command[-1] if command else ""
        runtime = self.created[name].setdefault("runtime", {})

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
        if "> /etc/apt/sources.list.d/docker.list" in script:
            runtime["depot"] = "present"
        if installe and "docker-ce" in script:
            runtime["docker"] = "Docker version 29.7.2"
            runtime["origine"] = "docker-ce"
            # §42.2 bis : le mode que la cellule PORTE après l'installation. Sans
            # lui, un second amorçage ne verrait aucun mode en place et le refus
            # de bascule ne pourrait pas être éprouvé.
            runtime["mode"] = ("rootless"
                               if "dockerd-rootless-setuptool" in script
                               else "enracine")
        if installe and "docker-compose-plugin" in script:
            runtime["compose"] = "Docker Compose version v2.40.0"
        self._persist()

        lignes = "".join(f"{cle}={valeur}\n" for cle, valeur in runtime.items())
        return (0, lignes, "")

    def create_snapshot(self, name: str, snapshot: str) -> None:
        if name not in self.created:
            raise IncusError(f"Instance « {name} » absente.")
        self.created[name].setdefault("snapshots", []).append(
            {"name": snapshot, "stateful": False, "size": 0}
        )
        self._persist()

    def restore_snapshot(self, name: str, snapshot: str, force: bool = False) -> None:
        pris = [s["name"] for s in self.created.get(name, {}).get("snapshots", [])]
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
        instance = self.created.get(name)
        if instance is None:
            raise IncusError(f"Instance « {name} » absente.")
        instance["snapshots"] = [
            s for s in instance.get("snapshots", []) if s["name"] != snapshot
        ]
        self._persist()

    def snapshots(self, name: str) -> list[dict[str, Any]]:
        return list(self.created.get(name, {}).get("snapshots", []))

    def instance_state(self, name: str) -> dict[str, Any]:
        instance = self.created.get(name)
        if instance is None:
            raise IncusError(f"Instance « {name} » absente.")
        return instance.get("state") or {
            "status": instance.get("status", "Running"),
            "cpu": {"usage": instance.get("cpu_ns", 1_000_000_000)},
            "memory": {"usage": 174_764_032, "total": 2 * 1024**3},
            "disk": {"root": {"total": 10 * 1024**3, "usage": 534_981_632}},
            "network": {"eth0": {"counters": {"bytes_received": 461, "bytes_sent": 2192}}},
        }


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
