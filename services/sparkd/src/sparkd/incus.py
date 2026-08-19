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

    def push_file(self, name: str, path: str, content: str, mode: str = "0600") -> None: ...

    def exec_command(self, name: str, command: list[str]) -> None: ...

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
        except httpx.HTTPError as error:
            raise IncusError(f"Incus a refuse {method} {path} : {error}") from error

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

    def create_instance(self, payload: dict[str, Any]) -> None:
        self._maybe_fail("create_instance")
        nom = payload["name"]
        if nom in self.created:
            raise IncusError(f"Instance « {nom} » deja presente.")
        self.created[nom] = {"name": nom, "status": "Stopped", "config": payload.get("config", {})}
        self._persist()

    def set_instance_state(self, name: str, action: str) -> None:
        self._maybe_fail("set_instance_state")
        if name not in self.created:
            raise IncusError(f"Instance « {name} » absente.")
        self.created[name]["status"] = "Running" if action == "start" else "Stopped"
        self._persist()

    def delete_instance(self, name: str) -> None:
        if name not in self.created:
            raise IncusError(f"Instance « {name} » absente.")
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
        self._persist()

    def exec_command(self, name: str, command: list[str]) -> None:
        if name not in self.created:
            raise IncusError(f"Instance « {name} » absente.")
        self.created[name].setdefault("commands", []).append(command)
        self._persist()

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
