"""@verifies docs/BACKLOG.md#SPK-38 · docs/DAT.md §36.1 (ce qu'une chaine prouve,
             et contre qui), §36.5 (les pieges), §36.9 (le contrat) ·
             docs/SCHEMA.md §9.2

La DoD nomme cinq preuves. Quatre sont ici ; la cinquieme — l'ancre — vit cote
console, car c'est precisement le point : la verite de reference doit vivre
AILLEURS que sur la machine qu'on soupconne.

Ces tests DESACTIVENT le verrou d'ecriture du 005 pour alterer le journal. C'est
volontaire et c'est le seul endroit du depot ou cela se fait : on simule ici un
adversaire qui a deja root, exactement celui contre lequel le §36.1 dit que la
chaine seule ne suffit pas.
"""

from __future__ import annotations

import pytest

from sparkd import audit, migrations
from sparkd.db import connect, transaction


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "c.db")
    migrations.upgrade(connection)
    yield connection
    connection.close()


def peupler(db, combien=5):
    for n in range(combien):
        audit.record(db, "moi", "essai", "ok", f"ligne {n}")


def deverrouiller(db):
    """Retire les declencheurs du 005. Un adversaire qui a root le ferait aussi —
    et le §36.1 dit que la chaine ne protege pas de lui : elle rend son passage
    DETECTABLE, ce qui n'est pas la meme chose."""
    db.execute("DROP TRIGGER audit_log_immuable_update")
    db.execute("DROP TRIGGER audit_log_immuable_delete")


# --- la chaine se forme (§36.9.1) -------------------------------------------

def test_la_premiere_ligne_porte_GENESE_et_non_la_chaine_vide(db):
    """Une chaine vide se confondrait avec « colonne oubliee », et la confusion
    tomberait sur la ligne qui ancre tout le reste (§36.9.1)."""
    peupler(db, 1)
    ligne = db.execute("SELECT * FROM audit_log").fetchone()
    assert ligne["prev_hash"] == audit.GENESIS
    assert len(ligne["entry_hash"]) == 64


def test_chaque_ligne_porte_l_empreinte_de_la_precedente(db):
    peupler(db, 4)
    lignes = [dict(r) for r in db.execute("SELECT * FROM audit_log ORDER BY id")]
    for precedente, suivante in zip(lignes, lignes[1:]):
        assert suivante["prev_hash"] == precedente["entry_hash"]
    assert audit.verify_chain(db)["intact"] is True


def test_l_identifiant_n_entre_PAS_dans_l_empreinte(db):
    """§36.9.2 : il est attribue par la base et un ROLLBACK en consomme sans
    ecrire. L'empreinte ne peut pas dependre d'un compteur que le produit ne
    controle pas."""
    ligne = {champ: "x" for champ in audit.CHAINED_FIELDS}
    assert audit.entry_hash({**ligne, "id": 1}) == audit.entry_hash({**ligne, "id": 999})


def test_la_serialisation_est_STABLE_quel_que_soit_l_ordre_des_cles(db):
    """La forme est figee : une vérification qui echouerait un an plus tard sans
    qu'aucune ligne n'ait bouge detruirait la confiance dans le dispositif."""
    a = {"ts": "t", "actor": "a", "action": "x", "result": "ok", "message": "m",
         "prev_hash": "p", "payload": None, "target_id": None,
         "target_type": None, "actor_class": "human"}
    b = dict(reversed(list(a.items())))
    assert audit.canonical(a) == audit.canonical(b)
    # Une valeur absente est serialisee `null`, JAMAIS omise : l'omettre
    # produirait deux octets differents pour deux lignes equivalentes.
    manquant = {k: v for k, v in a.items() if k != "target_id"}
    assert audit.canonical(manquant) == audit.canonical(a)
    assert b'"target_id":null' in audit.canonical(a)


# --- LES PREUVES DE LA DoD ---------------------------------------------------

def test_UNE_LIGNE_MODIFIEE_est_DESIGNEE(db):
    """Premiere preuve de la DoD : modifier une ligne en base, et prouver que la
    verification la designe."""
    peupler(db, 5)
    deverrouiller(db)
    db.execute("UPDATE audit_log SET message = 'récrit' WHERE id = 3")

    etat = audit.verify_chain(db)
    assert etat["intact"] is False
    assert etat["break"]["id"] == 3
    # `entry_hash` dit que la ligne ELLE-MEME a ete recrite (§36.9.5).
    assert etat["break"]["reason"] == "entry_hash"


def test_UNE_LIGNE_SUPPRIMEE_AU_MILIEU_est_detectee(db):
    """Deuxieme preuve : supprimer une ligne au milieu, et prouver la
    detection. Le motif differe — c'est la SUIVANTE qui ne se raccorde plus."""
    peupler(db, 5)
    deverrouiller(db)
    db.execute("DELETE FROM audit_log WHERE id = 3")

    etat = audit.verify_chain(db)
    assert etat["intact"] is False
    assert etat["break"]["id"] == 4
    # `prev_hash` dit qu'une ligne a ete RETIREE ou INSEREE avant celle-ci.
    assert etat["break"]["reason"] == "prev_hash"


def test_UNE_LIGNE_INSEREE_au_milieu_est_detectee(db):
    """Le pendant de la precedente : fabriquer une ligne credible ne suffit pas,
    car elle ne se raccorde a rien."""
    peupler(db, 4)
    db.execute(
        "INSERT INTO audit_log (ts, actor, actor_class, action, result, message,"
        " prev_hash, entry_hash) VALUES ('t','faux','human','x','ok','m','abc','def')")
    etat = audit.verify_chain(db)
    assert etat["intact"] is False
    assert etat["break"]["reason"] == "prev_hash"


def test_UNE_TRONCATURE_N_EST_PAS_DETECTEE_par_la_chaine_seule(db):
    """Troisieme preuve de la DoD, et elle DOCUMENTE une limite au lieu de la
    cacher : la chaine seule ne voit pas la troncature. On coupe la fin, ce qui
    reste est parfaitement valide.

    C'est exactement pourquoi l'ancre du §36.2 existe, et pourquoi elle vit sur
    une AUTRE machine. Le verdict `shrunk` de `apps/webui/host/anchor.js` est ce
    qui detecte cette attaque ; ce test prouve que la chaine ne le peut pas.
    """
    peupler(db, 5)
    deverrouiller(db)
    db.execute("DELETE FROM audit_log WHERE id >= 4")

    etat = audit.verify_chain(db)
    assert etat["intact"] is True, (
        "la chaîne tronquée reste valide — c'est la limite que le §36.1 annonce")
    # Ce qui a change, et que SEULE la console peut comparer : la longueur.
    assert etat["length"] == 3


def test_un_ROLLBACK_REEL_n_altere_PAS_la_chaine(db):
    """Quatrieme preuve de la DoD, avec ce que la mesure a corrige.

    MESURE le 2026-08-19 : sur SQLite, un ROLLBACK ne laisse PAS de trou. Il
    annule aussi la mise a jour de `sqlite_sequence`, et l'identifiant est
    reattribue. Le §36.5 affirmait le contraire ; il est corrige.

    Ce que ce test etablit reste ce qui compte : une transaction annulee ne
    laisse aucune trace ET ne rompt pas la chaine — la ligne suivante se
    raccorde bien a celle qui precedait l'echec.
    """
    peupler(db, 2)
    avant = [r["id"] for r in db.execute("SELECT id FROM audit_log ORDER BY id")]

    with pytest.raises(RuntimeError):
        with transaction(db):
            audit.record(db, "moi", "abandonne", "ok", "cette ligne disparaîtra")
            raise RuntimeError("échec provoqué, la transaction est annulée")

    peupler(db, 1)
    apres = [dict(r) for r in db.execute("SELECT * FROM audit_log ORDER BY id")]
    assert len(apres) == len(avant) + 1, "la ligne annulée n'a pas été écrite"
    # L'identifiant est REATTRIBUE : c'est la mesure qui corrige le §36.5.
    assert apres[-1]["id"] == avant[-1] + 1
    # Et la chaine se raccorde par-dessus l'echec.
    assert apres[-1]["prev_hash"] == apres[-2]["entry_hash"]
    assert audit.verify_chain(db)["intact"] is True


def test_UN_TROU_D_IDENTIFIANT_ne_declenche_AUCUNE_alerte(db):
    """La garantie de CONCEPTION du §36.5 : la verification ne juge jamais la
    continuite des `id`.

    Le ROLLBACK n'en produit pas sur SQLite, mais une purge, une restauration
    partielle ou un autre moteur le pourraient. Une verification qui jugerait la
    continuite deviendrait fausse ce jour-la, sans que personne ne l'ait touchee
    — et une alerte fausse est la meilleure facon de faire ignorer les vraies.
    """
    peupler(db, 3)
    # Un trou FABRIQUE, en poussant le compteur : la chaine, elle, est intacte.
    db.execute("UPDATE sqlite_sequence SET seq = 500 WHERE name = 'audit_log'")
    peupler(db, 2)

    ids = [r["id"] for r in db.execute("SELECT id FROM audit_log ORDER BY id")]
    assert ids[-1] - ids[2] > 1, "le trou est bien là"

    etat = audit.verify_chain(db)
    assert etat["intact"] is True, "un trou d'identifiant n'est PAS une altération"
    assert etat["break"] is None
    assert etat["checked"] == 5


def test_un_refus_journalise_HORS_transaction_reste_chaine(db):
    """§21.1 : un refus se journalise hors transaction, sinon le ROLLBACK
    emporterait la trace — exactement le cas ou elle sert. La chaine ne doit pas
    avoir casse ce comportement."""
    peupler(db, 1)
    audit.record(db, "moi", "spark.create", "denied", "Capacité insuffisante.")
    etat = audit.verify_chain(db)
    assert etat["intact"] is True
    assert etat["checked"] == 2


# --- ce que la verification ne juge pas -------------------------------------

def test_les_lignes_ANTERIEURES_a_la_migration_sont_traversees_sans_jugement(db):
    """docs/SCHEMA.md §9.2 : elles ne sont pas chainees retroactivement, parce
    qu'une chaine recalculee ne prouverait que la capacite a calculer un
    sha256."""
    db.execute(
        "INSERT INTO audit_log (ts, actor, actor_class, action, result, message)"
        " VALUES ('ancien','?','runtime','x','ok','avant la migration')")
    peupler(db, 2)
    etat = audit.verify_chain(db)
    assert etat["intact"] is True
    assert etat["checked"] == 2, "seules les lignes chaînées sont jugées"


def test_la_verification_s_arrete_a_la_PREMIERE_rupture(db):
    """Signaler les suivantes serait du bruit : une ligne modifiee invalide
    mecaniquement toute la suite, et mille alertes feraient manquer la seule qui
    compte (§36.9.5)."""
    peupler(db, 6)
    deverrouiller(db)
    db.execute("UPDATE audit_log SET message = 'a' WHERE id = 2")
    db.execute("UPDATE audit_log SET message = 'b' WHERE id = 5")
    etat = audit.verify_chain(db)
    assert etat["break"]["id"] == 2
    assert etat["checked"] == 2, "on s'arrête là, on ne parcourt pas le reste"
