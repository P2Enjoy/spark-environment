"""La coupure d'une surveillance hors bande s'ANNONCE, quelle que soit sa source.

@verifies docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3.3 (la désactivation notifie
          par le canal qu'elle coupe, et pendant qu'il fonctionne encore),
          §47.3 (le registre l'emporte sur l'environnement) ·
          docs/PROD_MIGRATIONS.md OP-20

**Ce que ces preuves gardent, et pourquoi elles existent.** Le §47.3.3 donne son
propre motif : « la coupure serait le seul geste dont personne n'entendrait
parler — et c'est le premier qu'un attaquant tenterait ».

La garde ne regardait que le canal du REGISTRE. Sur une Forge qui veille encore
par `SPARKD_NOTIFY_URL` — l'état de la production tant que l'OP-20 n'est pas
repris —, la première écriture depuis l'onglet débranchait ce repli **sans un
mot**. Mesuré le 2026-09-14, arbitré le même jour : l'avis part désormais par le
canal vivant, quel que soit l'endroit où son adresse est rangée.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from sparkd.app import create_app
from sparkd.config import load

#: Le gabarit porte `{message}` : c'est le seul champ par lequel le TEXTE du
#: produit atteint le salon (§47.4). Sans lui, ces preuves mesureraient le
#: gabarit de l'exploitant au lieu de ce que le produit a décidé d'envoyer.
GABARIT = '{"content":"{forge} {action} {target_id} — {message}"}'


class CanalEspion:
    """Recueille ce que le produit POSTE, sans réseau.

    Le doublon est posé à la place de l'envoi réel du `Canal` : on éprouve ce
    que le produit décide d'envoyer, pas la couche HTTP — qui a ses propres
    preuves au §47.5.
    """

    def __init__(self) -> None:
        self.envois: list[dict] = []

    def __call__(self, url, charge, **_):
        self.envois.append({"url": url, "charge": charge})
        return True


@pytest.fixture()
def espion():
    return CanalEspion()


def _client(tmp_path, espion, *, url_environnement: str = ""):
    """Une Forge dont le canal vient de l'ENVIRONNEMENT, ou de rien."""
    source = {"SPARKD_DB": str(tmp_path / "canal.db"), "SPARKD_DRIVER": "fake"}
    if url_environnement:
        source["SPARKD_NOTIFY_URL"] = url_environnement
        source["SPARKD_NOTIFY_TEMPLATE"] = GABARIT
    client = TestClient(create_app(load(source)))
    client.app.state.notify._envoi = espion
    return client


def test_la_Forge_part_bien_sur_le_repli_par_ENVIRONNEMENT(tmp_path, espion):
    """Le préalable des autres preuves : sans lui, elles seraient vertes pour la
    mauvaise raison — un canal qui ne veillait pas ne peut pas être coupé."""
    client = _client(tmp_path, espion, url_environnement="https://salon.test/hook")
    vu = client.get("/v1/notify/channels").json()
    assert vu["live"]["source"] == "environnement"
    assert vu["live"]["configured"] is True


def test_une_premiere_ecriture_qui_DEBRANCHE_le_repli_l_ANNONCE(tmp_path, espion):
    """LE défaut corrigé (I-02, §47.3.3).

    L'exploitant ouvre l'onglet pour la première fois et enregistre un gabarit,
    sans cocher « actif ». Le registre l'emporte alors sur l'environnement, et
    plus rien ne veille — c'est une coupure, et elle doit partir par le canal
    qu'elle coupe, pendant qu'il fonctionne encore.
    """
    client = _client(tmp_path, espion, url_environnement="https://salon.test/hook")

    rendu = client.put("/v1/notify/channels", json={
        "password": "le-garde", "webhook_template": GABARIT})
    assert rendu.status_code == 200, rendu.text

    assert espion.envois, (
        "la surveillance s'est arrêtée sans un mot : c'est exactement le geste "
        "que le §47.3.3 veut rendre impossible à faire en silence")
    assert espion.envois[0]["url"] == "https://salon.test/hook", (
        "l'avis part par le canal QU'ELLE COUPE, donc par celui de "
        "l'environnement — pas par un canal du registre qui n'existe pas encore")
    assert "DÉSACTIVÉ" in str(espion.envois[0]["charge"])

    # Et la coupure a bien eu lieu : l'avis ne la remplace pas, il l'annonce.
    assert client.get("/v1/notify/channels").json()["live"]["configured"] is False


def test_une_ecriture_qui_REMPLACE_le_repli_n_annonce_AUCUNE_coupure(tmp_path, espion):
    """Reprendre la configuration au registre n'est pas une coupure.

    C'est le geste que l'OP-20 demande, et l'annoncer comme un arrêt ferait
    crier au loup à chaque migration — après quoi plus personne ne lirait les
    avis, ce qui est le vrai danger.
    """
    client = _client(tmp_path, espion, url_environnement="https://salon.test/hook")

    rendu = client.put("/v1/notify/channels", json={
        "password": "le-garde", "webhook_template": GABARIT,
        "webhook_url": "https://salon.test/neuf", "webhook_enabled": True})
    assert rendu.status_code == 200, rendu.text

    assert espion.envois == [], "rien n'a cessé de veiller : rien à annoncer"
    vu = client.get("/v1/notify/channels").json()
    assert vu["live"]["source"] == "registre"
    assert vu["live"]["configured"] is True


def test_la_desactivation_d_un_canal_du_REGISTRE_s_annonce_toujours(tmp_path, espion):
    """La garde d'origine (§47.3.3) : elle ne doit pas être perdue en chemin."""
    client = _client(tmp_path, espion)
    assert client.put("/v1/notify/channels", json={
        "password": "le-garde", "webhook_url": "https://salon.test/hook",
        "webhook_template": GABARIT, "webhook_enabled": True}).status_code == 200
    espion.envois.clear()

    assert client.put("/v1/notify/channels", json={
        "password": "le-garde", "webhook_enabled": False}).status_code == 200
    assert espion.envois, "une désactivation explicite s'annonce"
    assert espion.envois[0]["url"] == "https://salon.test/hook"


def test_une_Forge_qui_ne_veillait_PAS_n_annonce_rien(tmp_path, espion):
    """§14.6 : on ne coupe pas ce qui ne veillait pas. Un avis envoyé là n'aurait
    aucun destinataire — et le produit n'a aucun canal pour le porter."""
    client = _client(tmp_path, espion)
    assert client.put("/v1/notify/channels", json={
        "password": "le-garde", "webhook_template": GABARIT}).status_code == 200
    assert espion.envois == []


def test_un_mot_de_passe_REFUSE_n_annonce_aucune_coupure(tmp_path, espion):
    """Second défaut trouvé par ces preuves, et non prévu en les écrivant.

    L'avis partait AVANT l'écriture du registre — pour que le canal fonctionne
    encore. Conséquence : un mot de passe refusé faisait annoncer un arrêt qui
    n'avait pas lieu, et la surveillance continuait. Le canal criait sa propre
    mort puis restait en vie, ce qui est le §1.3 à l'envers.

    Il part désormais APRÈS l'écriture et AVANT `reregler` : le registre écrit ne
    change rien au canal vivant, qui peut donc encore porter son propre avis de
    décès."""
    client = _client(tmp_path, espion)
    assert client.put("/v1/notify/channels", json={
        "password": "le-garde", "webhook_url": "https://salon.test/hook",
        "webhook_template": GABARIT, "webhook_enabled": True}).status_code == 200
    espion.envois.clear()

    refus = client.put("/v1/notify/channels", json={
        "password": "pas-le-bon", "webhook_enabled": False})
    assert refus.status_code == 403
    assert espion.envois == [], (
        "aucune coupure n'a eu lieu : le mot de passe a été refusé")
    assert client.get("/v1/notify/channels").json()["webhook"]["enabled"] is True
