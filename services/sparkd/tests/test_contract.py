"""@verifies docs/BACKLOG.md#SPK-17 · docs/DAT.md §23

La verification de derive n'a de valeur que si la generation est DETERMINISTE :
sans cela elle echouerait a chaque execution et serait desactivee dans la
semaine.
"""

from __future__ import annotations

import json

from sparkd import contract


def test_la_generation_est_deterministe():
    """docs/DAT.md §23.2 — deux executions rendent le meme octet."""
    assert contract.serialize(contract.build()) == contract.serialize(contract.build())


def test_la_serialisation_est_stable_quel_que_soit_l_ordre():
    a = contract.serialize({"b": 1, "a": {"z": 1, "y": 2}})
    b = contract.serialize({"a": {"y": 2, "z": 1}, "b": 1})
    assert a == b
    assert a.endswith("\n")


def test_le_contrat_committe_correspond_au_code():
    """C'est LA verification que la Definition of Done demande."""
    ok, message = contract.check()
    assert ok, message


def test_une_derive_est_detectee_et_expliquee(tmp_path):
    faux = tmp_path / "sparkd.json"
    faux.write_text(json.dumps({"openapi": "3.1.0", "paths": {}}), encoding="utf-8")
    ok, message = contract.check(faux)
    assert ok is False
    assert "ne correspond plus au code" in message
    assert "make contract" in message      # le message dit quoi faire


def test_un_contrat_absent_est_signale(tmp_path):
    ok, message = contract.check(tmp_path / "absent.json")
    assert ok is False and "absent" in message


def test_le_contrat_couvre_les_chemins_du_produit():
    chemins = contract.build()["paths"]
    for attendu in ("/healthz", "/v1/forge", "/v1/sparks", "/v1/ingress",
                    "/v1/ssh-keys", "/v1/audit"):
        assert attendu in chemins
