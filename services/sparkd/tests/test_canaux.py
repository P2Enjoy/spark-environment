"""La configuration des canaux d'alerte, au registre.

@verifies docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3 (deux canaux réglés depuis
          un onglet), §47.3.1 (le gabarit refusé à l'ENREGISTREMENT),
          §47.3.3 (le mot de passe), §35.3 (le mécanisme réemployé),
          §43.3 (un secret ne sort pas), §14.6 (les états se distinguent) ·
          CLAUDE.md §10 (la règle est appliquée côté serveur)
"""

import pytest

from sparkd import canaux, migrations, notification
from sparkd.db import connect


@pytest.fixture()
def registre(tmp_path):
    c = connect(tmp_path / "r.db")
    migrations.upgrade(c)
    yield c
    c.close()


# --- la ligne existe toujours (§14.6) ----------------------------------------


def test_la_ligne_EXISTE_des_la_migration(registre):
    """« Aucun canal » se dit par `enabled = 0`, qui est un FAIT. Une table vide
    serait une question sans réponse, et l'écran ne saurait quoi en dire."""
    e = canaux.etat(registre)
    assert e["webhook"]["enabled"] is False
    assert e["webhook"]["configured"] is False
    assert e["guard_set"] is False


def test_il_n_y_a_QU_UNE_ligne_et_le_schema_l_impose(registre):
    """Le §47.3 décide DEUX canaux, pas N canaux du même genre. Une seconde
    ligne rendrait la question « l'échec de l'un n'empêche pas l'autre »
    indécidable à trois."""
    import sqlite3
    with pytest.raises(sqlite3.IntegrityError):
        registre.execute(
            "INSERT INTO notify_channels (id, updated_at) VALUES (2, 't')")


# --- le garde du §47.3.3 -----------------------------------------------------


def test_le_PREMIER_usage_pose_le_mot_de_passe(registre):
    """Un garde qu'il faut armer par un geste séparé ne l'est jamais. Le premier
    réglage d'un canal est aussi celui qui décide qui pourra le couper."""
    assert canaux.etat(registre)["guard_set"] is False
    canaux.regler(registre, "le-mot", {"webhook_enabled": 1}, actor="moi")
    e = canaux.etat(registre)
    assert e["guard_set"] is True
    assert e["guard_set_at"] is not None


def test_le_premier_usage_SANS_mot_de_passe_est_refuse(registre):
    """Et le refus DIT que ce mot de passe sera le mot de passe : poser un garde
    sans le savoir serait pire que ne pas en poser."""
    with pytest.raises(canaux.MotDePasseRefuse) as e:
        canaux.regler(registre, "", {"webhook_enabled": 1})
    assert "sera le mot de passe" in str(e.value)


def test_un_mauvais_mot_de_passe_NE_MODIFIE_RIEN(registre):
    canaux.regler(registre, "bon", {"webhook_enabled": 1, "webhook_url": "https://a.test/x"})
    with pytest.raises(canaux.MotDePasseRefuse):
        canaux.regler(registre, "mauvais", {"webhook_enabled": 0})
    assert canaux.etat(registre)["webhook"]["enabled"] is True, (
        "le refus doit laisser la configuration EXACTEMENT où elle était")


def test_le_mot_de_passe_n_est_JAMAIS_au_registre_en_clair(registre):
    canaux.regler(registre, "un-mot-de-passe-reconnaissable", {"webhook_enabled": 1})
    brut = registre.execute("SELECT * FROM notify_channels WHERE id = 1").fetchone()
    for valeur in tuple(brut):
        assert "un-mot-de-passe-reconnaissable" not in str(valeur)


# --- le gabarit, refusé à l'ENREGISTREMENT (§47.3.1) -------------------------


def test_un_gabarit_FAUTIF_est_refuse_a_l_enregistrement(registre):
    """La première des trois règles non négociables. Refusé à l'envoi, la panne
    se découvrirait le jour de l'incident."""
    with pytest.raises(canaux.CanalError) as e:
        canaux.regler(registre, "m", {"webhook_template": '{"content":"{payload}"}'})
    assert "payload" in str(e.value)
    # Et il n'est PAS enregistré : le refus n'écrit rien.
    assert canaux.etat(registre)["webhook"]["template"] is None


def test_un_gabarit_VALIDE_est_enregistre(registre):
    canaux.regler(registre, "m", {"webhook_template": '{"content":"{forge} {action}"}'})
    e = canaux.etat(registre)
    assert e["webhook"]["template_unknown_fields"] == []


def test_un_champ_INCONNU_est_refuse_au_lieu_d_etre_ignore(registre):
    """Accepter un champ inconnu en silence laisserait croire qu'il a été pris."""
    with pytest.raises(canaux.CanalError) as e:
        canaux.regler(registre, "m", {"webhook_urll": "https://a.test/x"})
    assert "webhook_urll" in str(e.value)


# --- ce qui SORT, et ce qui ne sort pas (§43.3) ------------------------------


def test_l_URL_ne_sort_JAMAIS_de_l_etat(registre):
    """Elle EST un secret : qui la détient écrit dans le salon. On rend de quoi
    RECONNAÎTRE le canal — son hôte —, jamais de quoi s'en servir."""
    url = "https://discord.com/api/webhooks/123/un-jeton-tres-secret"
    canaux.regler(registre, "m", {"webhook_enabled": 1, "webhook_url": url})
    rendu = canaux.etat(registre)
    assert "un-jeton-tres-secret" not in str(rendu)
    assert rendu["webhook"]["host"] == "discord.com"
    assert rendu["webhook"]["configured"] is True


def test_le_journal_ne_porte_ni_URL_ni_mot_de_passe(registre):
    canaux.regler(registre, "mot-secret", {
        "webhook_enabled": 1, "webhook_url": "https://a.test/jeton-secret"})
    lignes = registre.execute(
        "SELECT message, payload FROM audit_log WHERE action = 'notify.configure'"
    ).fetchall()
    assert lignes, "la configuration d'un canal DOIT laisser une trace"
    entier = " ".join(str(dict(l)) for l in lignes)
    assert "jeton-secret" not in entier and "mot-secret" not in entier


# --- « désactivé » n'est pas « absent » (§14.6) -------------------------------


def test_DESACTIVER_conserve_l_URL(registre):
    """Le §47.3 : on garde une URL en la désactivant, sans avoir à la retaper.
    Vider le champ à la place forcerait à la ressaisir pour un simple essai."""
    canaux.regler(registre, "m", {"webhook_enabled": 1, "webhook_url": "https://a.test/x"})
    canaux.regler(registre, "m", {"webhook_enabled": 0})
    e = canaux.etat(registre)
    assert e["webhook"]["enabled"] is False
    assert e["webhook"]["configured"] is True, "l'URL doit être CONSERVÉE"
    assert canaux.webhook_actif(registre) == ("", ""), (
        "un canal désactivé ne veille pas, quelle que soit son URL")


def test_le_journal_NOMME_la_desactivation(registre):
    """C'est le geste qu'un attaquant tenterait en premier. Le journal doit dire
    « DÉSACTIVÉ », pas « réglages modifiés »."""
    canaux.regler(registre, "m", {"webhook_enabled": 1, "webhook_url": "https://a.test/x"})
    canaux.regler(registre, "m", {"webhook_enabled": 0})
    dernier = registre.execute(
        "SELECT message FROM audit_log WHERE action = 'notify.configure'"
        " ORDER BY id DESC LIMIT 1").fetchone()
    assert "DÉSACTIVÉ" in dernier["message"]


def test_le_gabarit_du_registre_est_celui_que_le_canal_emploie(registre):
    canaux.regler(registre, "m", {
        "webhook_enabled": 1, "webhook_url": "https://a.test/x",
        "webhook_template": '{"content":"{forge}"}'})
    url, gabarit = canaux.webhook_actif(registre)
    assert url == "https://a.test/x"
    assert notification.champs_inconnus(gabarit) == ()
