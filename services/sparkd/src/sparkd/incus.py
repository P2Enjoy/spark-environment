"""Client de l'API Incus, sur la socket Unix.

@spec docs/BACKLOG.md#SPK-07 · docs/DAT.md §5.1 (Acces a Incus), §5.2 (ce qui
      est lu, et ou)

On ne lance jamais le binaire « incus » : sa sortie est un format d'affichage,
qui change sans preavis et se parse mal — la commande n'accepte meme aucun
« --format ». L'API rend des types.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

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


@dataclass
class FakeIncus:
    """Pilote factice, pour les tests et le developpement local.

    Il rend la meme FORME que l'hote reel — structure relevee le 2026-08-18 —
    afin que la traduction eprouvee ici soit celle qui tournera en production.
    Il ne prouve jamais qu'un quota est applique : cela exige un hote reel
    (docs/DAT.md §12).
    """

    payload: dict[str, Any] | None = None
    pool_payload: dict[str, Any] | None = None
    created: dict[str, dict[str, Any]] = field(default_factory=dict)

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
        nom = payload["name"]
        if nom in self.created:
            raise IncusError(f"Instance « {nom} » deja presente.")
        self.created[nom] = {"name": nom, "status": "Stopped", "config": payload.get("config", {})}

    def set_instance_state(self, name: str, action: str) -> None:
        if name not in self.created:
            raise IncusError(f"Instance « {name} » absente.")
        self.created[name]["status"] = "Running" if action == "start" else "Stopped"

    def delete_instance(self, name: str) -> None:
        if name not in self.created:
            raise IncusError(f"Instance « {name} » absente.")
        del self.created[name]

    def update_instance_config(self, name: str, config: dict[str, Any]) -> None:
        if name not in self.created:
            raise IncusError(f"Instance « {name} » absente.")
        self.created[name].setdefault("config", {}).update(config)


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
