"""La notification hors bande des actions sensibles.

@spec docs/BACKLOG.md#SPK-62 · docs/DAT.md §47 (le contrat), §47.1 (où elle
      s'accroche), §47.2 (ce qui notifie, liste FERMÉE), §47.3 (le canal),
      §47.4 (ce que l'envoi porte), §47.5 (un canal injoignable ne fait jamais
      échouer un geste), §47.6 (l'échec est dit), §47.7 (ce qu'elle ne prétend
      pas) · §45.4 (elle ne prévient pas, elle DÉTECTE) · §21.2 (aucun secret) ·
      §37.4.5 (une panne de traçabilité ne devient pas une panne d'exploitation)
@spec docs/BACKLOG.md#SPK-151 · docs/DAT.md §47.3.1 (l'aperçu : `texte_envoye`,
      `EXEMPLE`, `apercu` — le même rendu que l'envoi)

**Ce que cette fonction est, et ce qui décide de tout son code** : elle ne
prévient rien. Le geste a déjà eu lieu quand le message part. Elle sert à
DÉTECTER — y compris contre un poste compromis, que le §45.2 assume ne pas
traiter. C'est pourquoi elle n'a jamais le droit d'empêcher quoi que ce soit :
un canal muet doit rester un silence, pas une panne.
"""

from __future__ import annotations

import json
import logging
import re
import queue
import smtplib
import ssl
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

LOG = logging.getLogger("sparkd.notification")

#: Version du format envoyé. Un destinataire qui reçoit un jour autre chose doit
#: pouvoir le voir sans deviner.
VERSION = "spark-notify-v1"

#: Le délai de garde, connexion et lecture comprises (§47.5).
DELAI_S = 5.0

#: Taille de la file. Bornée : une file sans borne transforme un canal muet en
#: fuite de mémoire, et la Forge tomberait pour une raison étrangère à son
#: travail (§47.5).
FILE_MAX = 256

#: Les actions qui notifient, et RIEN d'autre (§47.2). La liste est FERMÉE et
#: énumérée : un motif du genre « tout ce qui contient delete » laisserait passer
#: `spark.unprotect`, qui est le geste le plus grave de la liste.
ACTIONS = frozenset({
    "spark.delete",       # détruit un Spark et ses données
    "spark.unprotect",    # LÈVE une protection : le geste qui rend les autres possibles
    "snapshot.delete",    # détruit le point de retour
    "snapshot.restore",   # écrase l'état courant
    "sshkey.revoke",      # retire un accès
    "sshkey.grant",       # DONNE un accès
    "port.withdraw",      # referme un port publié
    "ingress.withdraw",   # retire un nom public
    "spark.rescue_exec",  # ouvre un shell root dans une cellule (§37.3)
    # SPK-61 · §46.4 bis : une clé restreinte a tenté ce qu'elle n'a pas le
    # droit de faire. C'est le SEUL refus de la liste, et l'exception est
    # nommée dans `notifiable()` juste en dessous.
    "forge.shell_refused",
    # SPK-184 · §75.7 : une sonde de santé a CHANGÉ D'ÉTAT. Deux actions, une par
    # transition — jamais une par relevé. Ce sont des lignes du RUNTIME ; leur
    # exception est nommée dans `RUNTIME_NOTIFIABLES`, pas déduite.
    "health.down",        # une sonde a atteint son seuil d'échecs
    "health.up",          # une sonde en panne est rétablie
})

#: SPK-184 · docs/DAT.md §75.7 : les SEULES actions du runtime qui notifient. Un
#: propriétaire a configuré la sonde et demandé à être prévenu : ce n'est pas un
#: événement dont « personne n'a voulu » (§36.4). L'exception est une liste, pas
#: une condition : le jour où l'on en ajoutera une, il faudra le décider.
RUNTIME_NOTIFIABLES = frozenset({"health.down", "health.up"})

#: Les actions dont un REFUS mérite l'alerte. La règle générale les écarte —
#: « rien n'a eu lieu » —, et cette exception doit rester une liste, pas une
#: condition : un jour on ajoutera un refus, et il faudra le décider.
REFUS_NOTIFIABLES = frozenset({"forge.shell_refused"})


def notifiable(action: str, result: str, actor_class: str) -> bool:
    """Cette ligne mérite-t-elle un message hors bande ? (§47.2)

    Trois refus, et chacun a son motif :

    - une action hors liste — la liste est fermée, jamais déduite ;
    - une ligne du RUNTIME : personne ne l'a demandée (§36.4) — sauf les deux
      transitions de santé de `RUNTIME_NOTIFIABLES` (§75.7) — et les notifier
      noierait les neuf actions sous des dizaines d'autres. Un canal qui crie
      tout le temps n'est plus lu, et c'est la panne la plus probable de ce
      dispositif ;
    - un REFUS : rien n'a eu lieu. Le notifier apprendrait à ignorer le canal.
    """
    if action in REFUS_NOTIFIABLES and result == "denied":
        # §46.4 bis : ici le refus EST l'événement. Une clé restreinte qui tente
        # un shell est ou bien une erreur de l'exploitant, ou bien quelqu'un qui
        # essaie la clé qu'il vient de voler — et c'est exactement ce qu'une
        # alerte hors bande existe pour porter.
        return actor_class != "runtime"
    if action in RUNTIME_NOTIFIABLES:
        return result == "ok"
    return (action in ACTIONS
            and result == "ok"
            and actor_class != "runtime")


def corps(ligne: dict, forge: str) -> dict:
    """Ce que l'envoi porte — et le `payload` n'y est PAS (§47.4).

    C'est là que vivent les valeurs d'un geste : corps de clé, réglages, chemins.
    Le §21.2 les caviarde déjà pour le journal ; ne pas les envoyer du tout est
    plus sûr que de les caviarder une seconde fois. Un champ qu'on n'envoie pas
    ne fuit pas.
    """
    return {
        "version": VERSION,
        "ts": ligne.get("ts"),
        # Quand plusieurs Forges écrivent dans le même canal, « un Spark a été
        # supprimé » sans dire OÙ est une alerte inexploitable.
        "forge": forge,
        "action": ligne.get("action"),
        "actor": ligne.get("actor"),
        "actor_class": ligne.get("actor_class"),
        "target_type": ligne.get("target_type"),
        "target_id": ligne.get("target_id"),
        "result": ligne.get("result"),
        "message": ligne.get("message"),
    }


#: Les champs qu'un gabarit a le droit de nommer (§47.3.1). C'est EXACTEMENT ce
#: que `corps()` publie — pas un de plus. Un gabarit ne peut donc pas faire
#: sortir ce que le §47.4 refuse de faire sortir, `payload` en tête : le nom
#: n'existe pas pour lui.
CHAMPS = ("version", "ts", "forge", "action", "actor", "actor_class",
          "target_type", "target_id", "result", "message")

#: `{champ}`. Volontairement borné aux minuscules et au souligné : un motif plus
#: large accepterait `{ }` ou `{0}` et donnerait l'illusion d'un langage.
PLACEHOLDER = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


def champs_inconnus(gabarit: str) -> tuple[str, ...]:
    """Les noms qu'un gabarit cite et que le §47.4 ne publie pas.

    @spec docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3.1

    Rendu AVANT tout envoi, jamais pendant : « sinon la panne se découvre le jour
    de l'incident ». C'est la première des trois règles non négociables.
    """
    vus = [n for n in PLACEHOLDER.findall(gabarit) if n not in CHAMPS]
    return tuple(dict.fromkeys(vus))


def rendre(gabarit: str, charge: dict) -> str:
    """Le gabarit, ses `{champ}` remplacés par les valeurs de CETTE ligne.

    @spec docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3.1

    **Substitution de texte, jamais une exécution** — deuxième règle. Il n'y a
    ici ni `eval`, ni `format`, ni moteur de gabarit : une expression régulière
    et un remplacement.

    Chaque valeur est ÉCHAPPÉE pour le contexte d'une chaîne JSON. Sans cela, un
    Spark nommé avec un guillemet casserait le document — ou pire, y injecterait
    de la structure, et le gabarit ne dessinerait plus la forme envoyée. `json`
    échappe, on retire les guillemets qu'il ajoute autour.
    """
    def remplacer(trouve: "re.Match[str]") -> str:
        valeur = charge.get(trouve.group(1))
        return json.dumps("" if valeur is None else str(valeur),
                          ensure_ascii=False)[1:-1]
    return PLACEHOLDER.sub(remplacer, gabarit)


def _serialiser(charge: "dict | str") -> str:
    """Le texte qui part : le rendu d'un gabarit tel quel, le corps en JSON."""
    return charge if isinstance(charge, str) else json.dumps(charge, ensure_ascii=False)


def texte_envoye(gabarit: str, charge: dict) -> str:
    """Le texte EXACT que l'envoi poserait pour cette charge.

    @spec docs/BACKLOG.md#SPK-151 · docs/DAT.md §47.3.1 (l'aperçu)

    Le choix est celui de `Canal._tenter` — le gabarit rendu s'il y en a un, le
    corps du §47.4 sinon —, puis la sérialisation d'`envoyer`. L'aperçu passe
    par ici : il ne peut pas montrer autre chose que ce qui partirait.
    """
    return _serialiser(rendre(gabarit, charge) if gabarit else charge)


#: SPK-151 · §47.3.1 : l'événement de l'aperçu. Un geste que la liste fermée
#: NOTIFIE (§47.2) — sans quoi l'aperçu montrerait un message qui ne part jamais —,
#: décrit comme le journal le décrirait. Fixe : un aperçu se compare d'un essai à
#: l'autre.
EXEMPLE = {
    "action": "spark.unprotect", "actor": "console/local", "actor_class": "human",
    "target_type": "spark", "target_id": "exemple", "result": "ok",
    "message": "Protection levée sur « exemple ».",
}


def apercu(gabarit: str, forge: str, *, maintenant=None) -> dict:
    """Le message tel qu'il partirait, sur l'événement d'exemple (SPK-151).

    @spec docs/BACKLOG.md#SPK-151 · docs/DAT.md §47.3.1 (l'aperçu)

    Ne lit, n'écrit et n'envoie rien : c'est un calcul. Un champ inconnu n'est
    pas une erreur ici — il est NOMMÉ, et rien n'est rendu : c'est ce que
    l'enregistrement refuserait.
    """
    instant = maintenant or datetime.now(timezone.utc)
    charge = corps({**EXEMPLE, "ts": instant.isoformat(timespec="seconds")}, forge)
    inconnus = list(champs_inconnus(gabarit))
    if inconnus:
        return {"rendered": None, "unknown_fields": inconnus, "valid_json": None,
                "event": charge}
    texte = texte_envoye(gabarit, charge)
    try:
        json.loads(texte)
        valide = True
    except ValueError:
        valide = False
    return {"rendered": texte, "unknown_fields": [], "valid_json": valide, "event": charge}


def envoyer(url: str, charge: "dict | str", *, ouvrir=urllib.request.urlopen,
            delai: float = DELAI_S) -> None:
    """Un `POST` de JSON. Lève en cas d'échec — c'est l'appelant qui absorbe.

    `charge` est le corps du §47.4, ou le TEXTE déjà rendu par un gabarit. Le
    second n'est pas resérialisé : le gabarit dessine le document, et le
    repasser par `json` en changerait la forme, qui est précisément ce que le
    destinataire exige.
    """
    # SPK-151 : la même sérialisation que l'aperçu (`texte_envoye`).
    corps_brut = _serialiser(charge)
    requete = urllib.request.Request(
        url,
        data=corps_brut.encode("utf-8"),
        headers={"content-type": "application/json; charset=utf-8",
                 "user-agent": f"sparkd-notify/{VERSION}"},
        method="POST",
    )
    reponse = ouvrir(requete, timeout=delai)
    code = getattr(reponse, "status", None) or getattr(reponse, "code", 0)
    fermer = getattr(reponse, "close", None)
    if fermer:
        fermer()
    if not 200 <= int(code) < 300:
        raise urllib.error.HTTPError(url, int(code), "refusé", None, None)


class _CanalFil:
    """Ce que les DEUX canaux ont en commun, et rien d'autre : une file bornée, un fil
    d'envoi, des compteurs et une dernière erreur.

    @spec docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3.2 bis (deux témoins
          indépendants : chaque canal a SA file, SON fil et SES compteurs),
          §47.5 (un canal injoignable ne fait jamais échouer un geste)

    **Il ne LÈVE jamais vers l'appelant** (§47.5). `record()` doit rendre `None`
    comme avant, quoi qu'il arrive au réseau : une panne de traçabilité ne
    devient pas une panne d'exploitation (§37.4.5).

    L'envoi part dans un fil séparé, jamais dans la transaction SQLite du geste :
    un `POST` de trois secondes tenu à l'intérieur bloquerait l'unique écrivain de
    SQLite pour toute la Forge.

    Une sous-classe dit COMMENT on expédie (`_expedier`) et QUAND elle est prête
    (`configured`, `mal_configure`) ; la file, elle, ne sait rien du transport.
    """

    #: Le nom sous lequel l'écran et l'agrégat désignent le canal.
    nom = ""

    def __init__(self, forge: str = "", *, file_max: int = FILE_MAX):
        self.forge = forge
        self._file: queue.Queue = queue.Queue(maxsize=file_max)
        self._verrou = threading.Lock()
        self._fil: threading.Thread | None = None
        self._arret = threading.Event()
        self.sent = 0
        self.failed = 0
        self.dropped = 0
        self.last_error: str | None = None
        self.last_error_at: str | None = None

    # --- ce que la sous-classe dit ------------------------------------------

    @property
    def configured(self) -> bool:  # pragma: no cover - abstrait
        raise NotImplementedError

    @property
    def mal_configure(self) -> bool:  # pragma: no cover - abstrait
        raise NotImplementedError

    def _expedier(self, charge: dict) -> None:  # pragma: no cover - abstrait
        raise NotImplementedError

    # --- ce qu'elles partagent ----------------------------------------------

    def poster(self, ligne: dict, *, maintenant=None) -> None:
        """Dépose une ligne à envoyer. Ne bloque JAMAIS, ne lève JAMAIS."""
        if not self.configured or self.mal_configure:
            return
        if not notifiable(str(ligne.get("action") or ""),
                          str(ligne.get("result") or ""),
                          str(ligne.get("actor_class") or "")):
            return
        charge = corps(ligne, self.forge)
        try:
            self._file.put_nowait(charge)
        except queue.Full:
            # Pleine, on jette le PLUS ANCIEN et on compte : les gestes récents
            # intéressent davantage que ceux d'il y a une heure, et un compteur
            # qui monte est un signal en soi.
            try:
                self._file.get_nowait()
                with self._verrou:
                    self.dropped += 1
                self._file.put_nowait(charge)
            except (queue.Empty, queue.Full):  # pragma: no cover - course rare
                with self._verrou:
                    self.dropped += 1
                return
        self._assurer_fil()

    def _assurer_fil(self) -> None:
        with self._verrou:
            if self._fil is not None and self._fil.is_alive():
                return
            self._arret.clear()
            self._fil = threading.Thread(target=self._boucle,
                                         name=f"sparkd-notify-{self.nom or 'canal'}",
                                         daemon=True)
            self._fil.start()

    def _boucle(self) -> None:
        while not self._arret.is_set():
            try:
                charge = self._file.get(timeout=0.5)
            except queue.Empty:
                return
            self._tenter(charge)

    def _tenter(self, charge: dict) -> None:
        try:
            self._expedier(charge)
        except Exception as erreur:  # noqa: BLE001 - AUCUNE ne remonte (§47.5)
            with self._verrou:
                self.failed += 1
                self.last_error = str(erreur) or type(erreur).__name__
                self.last_error_at = charge.get("ts")
            # Une notification qui échoue ne notifie PAS (§47.2) : sans cette
            # règle, un canal en panne produirait une boucle infinie.
            LOG.warning("notification hors bande refusée (%s) : %s",
                        self.nom or "canal", self.last_error)
        else:
            with self._verrou:
                self.sent += 1

    def _compteurs(self) -> dict:
        return {
            "sent": self.sent, "failed": self.failed, "dropped": self.dropped,
            "last_error": self.last_error, "last_error_at": self.last_error_at,
        }

    def vider(self, delai: float = 5.0) -> bool:
        """Attend que la file soit drainée. Pour les PREUVES, pas pour le service.

        Le service ne doit jamais attendre son canal ; une preuve, si — sans quoi
        elle mesurerait une file au lieu d'un envoi.
        """
        fil = self._fil
        if fil is None:
            return True
        fil.join(delai)
        return not fil.is_alive()


class Canal(_CanalFil):
    """Le canal WEBHOOK, et son état visible.

    @spec docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3.1 (le gabarit), §47.6
    """

    nom = "webhook"

    def __init__(self, url: str = "", forge: str = "", *,
                 gabarit: str = "", envoi=envoyer, file_max: int = FILE_MAX):
        super().__init__(forge, file_max=file_max)
        self.url = (url or "").strip()
        # SPK-62 · §47.3.1 : le gabarit est vérifié ICI, au chargement, donc
        # AVANT tout envoi. Un nom inconnu n'arme pas le canal — il ne le fait
        # pas non plus échouer à l'envoi, ce qui ferait découvrir la panne le
        # jour de l'incident. Le canal se dit alors « mal configuré », un
        # troisième état que l'écran distingue de « muet » et de « en échec ».
        self.gabarit = (gabarit or "").strip()
        self.gabarit_refuse: tuple[str, ...] = (
            champs_inconnus(self.gabarit) if self.gabarit else ())
        #: SPK-62 · §47.3 : d'où vient la configuration ACTUELLE — `registre` ou
        #: `environnement`. L'écran le dit : sur une Forge dont la configuration
        #: n'a pas encore été reprise au registre, il faut savoir que la régler
        #: à l'écran ne servira à rien tant que la variable est là.
        self.source = "environnement" if self.url else "registre"
        self._envoi = envoi

    def reregler(self, url: str, gabarit: str, source: str = "registre") -> None:
        """Reprend la configuration à chaud, sans redémarrer le service.

        @spec docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3

        Appelée quand le registre change. La file en cours n'est PAS vidée : les
        alertes déjà déposées partent vers l'ancien destinataire, ce qui est le
        comportement voulu — elles ont été produites sous cette configuration-là,
        et les rediriger ferait arriver un geste ancien sur un canal neuf.
        """
        with self._verrou:
            self.url = (url or "").strip()
            self.gabarit = (gabarit or "").strip()
            self.gabarit_refuse = champs_inconnus(self.gabarit) if self.gabarit else ()
            self.source = source

    @property
    def configured(self) -> bool:
        return bool(self.url)

    @property
    def mal_configure(self) -> bool:
        """Une URL est posée, mais le gabarit cite un champ qui n'existe pas.

        Ce n'est PAS « muet » — quelqu'un a voulu un canal — et ce n'est pas
        « en échec » — rien n'a été tenté. Confondre les trois ferait lire
        « tout va bien » sur une Forge que personne ne surveille (§14.6).
        """
        return bool(self.url) and bool(self.gabarit_refuse)

    def etat(self) -> dict:
        """Ce que `GET /v1/forge` rend (§47.6).

        `configured: false` NE veut pas dire « tout va bien » : les compteurs
        valent alors zéro parce que rien n'est surveillé, et l'écran doit le dire
        autrement (§14.6).
        """
        with self._verrou:
            return {
                "configured": self.configured,
                "source": self.source,
                "misconfigured": self.mal_configure,
                "unknown_fields": list(self.gabarit_refuse),
                **self._compteurs(),
            }

    def _expedier(self, charge: dict) -> None:
        self._envoi(self.url,
                    rendre(self.gabarit, charge) if self.gabarit else charge)


# --- SPK-62 · §47.3.2 : le canal SMTP -----------------------------------------

#: Les modes TLS (§47.3.2 point 1). `starttls` EXIGE la montée en TLS : un serveur
#: qui ne l'annonce pas fait échouer l'envoi, jamais un repli en clair.
MODES_TLS = ("starttls", "tls", "none")

#: Au plus ce nombre de destinataires (§47.3.2 point 5).
DESTINATAIRES_MAX = 10

#: `local@hôte`, sans espace, sans chevron, sans guillemet, sans saut de ligne :
#: un en-tête ne se construit pas à partir d'un texte qui peut en injecter un autre.
ADRESSE = re.compile(r"^[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.\-]{0,251}[A-Za-z0-9])?$")

#: Un nom d'hôte ou une adresse IP, rien d'autre : pas de schéma, pas de chemin.
HOTE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9.\-]{0,251}[A-Za-z0-9])?$|^\[[0-9A-Fa-f:.]+\]$")


def adresses_valides(texte: str) -> tuple[str, ...]:
    """Les adresses d'une liste séparée par des virgules. Lève `ValueError` en la nommant."""
    morceaux = [m.strip() for m in str(texte or "").split(",")]
    morceaux = [m for m in morceaux if m]
    if not morceaux:
        raise ValueError("aucune adresse")
    if len(morceaux) > DESTINATAIRES_MAX:
        raise ValueError(f"{len(morceaux)} adresses, {DESTINATAIRES_MAX} au plus")
    for adresse in morceaux:
        if not ADRESSE.match(adresse):
            raise ValueError(f"« {adresse} » n'est pas une adresse valide")
    return tuple(morceaux)


@dataclass(frozen=True)
class ReglageSmtp:
    """Ce qu'il faut pour envoyer UN courriel. Le mot de passe y est en clair, en MÉMOIRE
    seulement : il est déchiffré au chargement et ne sort jamais de ce module."""

    host: str
    port: int
    tls: str
    sender: str
    recipients: tuple[str, ...]
    username: str | None = None
    password: str | None = None

    def __repr__(self) -> str:  # jamais le mot de passe dans une trace
        return (f"ReglageSmtp(host={self.host!r}, port={self.port}, tls={self.tls!r}, "
                f"sender={self.sender!r}, recipients={self.recipients!r}, "
                f"username={self.username!r}, password={'***' if self.password else None})")


def _nettoyer(texte: object, limite: int) -> str:
    """Un en-tête sur UNE ligne : les caractères de contrôle partent, la longueur est bornée."""
    propre = re.sub(r"[\x00-\x1f\x7f]+", " ", str(texte or "")).strip()
    return propre[:limite]


def message_courriel(charge: dict, reglage: ReglageSmtp) -> EmailMessage:
    """Le courriel d'une alerte (§47.3.2 point 6).

    Les dix champs du §47.4, une ligne chacun, issus de `corps()` — donc du MÊME filtre
    que le webhook, et sans le `payload`. Texte seul : ni HTML, ni pièce jointe.
    """
    message = EmailMessage()
    message["From"] = reglage.sender
    message["To"] = ", ".join(reglage.recipients)
    message["Subject"] = _nettoyer(
        f"[{charge.get('forge') or '?'}] {charge.get('action') or '?'} — "
        f"{charge.get('target_id') or '?'}", 200)
    message["Date"] = formatdate(localtime=False)
    message["Message-ID"] = make_msgid(domain="sparkd.invalid")
    lignes = [f"{champ} : {_nettoyer(charge.get(champ), 2000)}" for champ in CHAMPS]
    # Quoted-printable, toujours : le choix par défaut dépend du contenu (QP ou base64), et un
    # message dont l'encodage change d'une alerte à l'autre se lit mal à l'œil comme à la machine.
    message.set_content("\n".join(lignes) + "\n", charset="utf-8", cte="quoted-printable")
    return message


def envoyer_courriel(reglage: ReglageSmtp, charge: dict, *, contexte: "ssl.SSLContext | None" = None,
                     delai: float = DELAI_S) -> None:
    """Un courriel par SMTP. Lève en cas d'échec — c'est l'appelant qui absorbe.

    @spec docs/DAT.md §47.3.2 (mode TLS, certificat vérifié, compte), §47.5 (délai borné)

    `contexte` n'existe que pour qu'une PREUVE puisse faire confiance à son certificat de
    test : en service il vaut `None`, soit le contexte par défaut du système, qui vérifie la
    chaîne ET le nom. Aucun réglage ne permet de s'en dispenser.
    """
    message = message_courriel(charge, reglage)
    contexte = contexte or ssl.create_default_context()
    if reglage.tls == "tls":
        serveur: smtplib.SMTP = smtplib.SMTP_SSL(reglage.host, reglage.port, timeout=delai,
                                                 context=contexte)
    else:
        serveur = smtplib.SMTP(reglage.host, reglage.port, timeout=delai)
    with serveur:
        serveur.ehlo()
        if reglage.tls == "starttls":
            # Pas de repli : `starttls()` lève si le serveur ne l'annonce pas.
            serveur.starttls(context=contexte)
            serveur.ehlo()
        if reglage.username:
            serveur.login(reglage.username, reglage.password or "")
        serveur.send_message(message, from_addr=reglage.sender,
                             to_addrs=list(reglage.recipients))


class CanalSmtp(_CanalFil):
    """Le canal COURRIEL : même contrat que le webhook, file et compteurs à lui.

    @spec docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3.2, §47.3.2 bis, §47.6
    """

    nom = "smtp"

    def __init__(self, forge: str = "", *, envoi=envoyer_courriel, file_max: int = FILE_MAX):
        super().__init__(forge, file_max=file_max)
        self._reglage: ReglageSmtp | None = None
        #: Le mot de passe est au registre mais ne se déchiffre pas (clé changée, registre
        #: modifié) : le canal le DIT au lieu d'essayer sans compte (§14.6).
        self._illisible = False
        self._envoi = envoi

    def reregler(self, reglage: "ReglageSmtp | None", *, illisible: bool = False) -> None:
        """Reprend la configuration à chaud. La file en cours n'est pas vidée (voir `Canal`)."""
        with self._verrou:
            self._reglage = reglage
            self._illisible = bool(illisible) and reglage is not None

    @property
    def configured(self) -> bool:
        return self._reglage is not None

    @property
    def mal_configure(self) -> bool:
        return self._reglage is not None and self._illisible

    def etat(self) -> dict:
        with self._verrou:
            return {
                "configured": self.configured,
                "source": "registre",
                "misconfigured": self.mal_configure,
                "unknown_fields": [],
                "misconfiguration": ("Le mot de passe SMTP enregistré ne se déchiffre pas : "
                                     "ressaisissez-le." if self.mal_configure else None),
                **self._compteurs(),
            }

    def _expedier(self, charge: dict) -> None:
        reglage = self._reglage
        if reglage is None:  # pragma: no cover - coupé entre la file et l'envoi
            return
        self._envoi(reglage, charge)


# --- l'ensemble : deux témoins, pas une chaîne ---------------------------------


class Ensemble:
    """Les canaux, alimentés CHACUN DANS SON PROPRE `try` (§47.3.2 bis).

    @spec docs/BACKLOG.md#SPK-62 · docs/DAT.md §47.3.2 bis, §47.6 (agrégat et détail)

    Une exception, une file pleine ou un serveur muet d'un côté ne retarde pas l'autre.
    C'est lui que l'audit appelle : `audit.set_canal(ensemble)`.
    """

    _LIBELLES = {"webhook": "Webhook", "smtp": "SMTP"}

    def __init__(self, **canaux: _CanalFil):
        self.canaux = canaux

    @property
    def forge(self) -> str:
        return next(iter(self.canaux.values())).forge if self.canaux else ""

    def poster(self, ligne: dict, *, maintenant=None) -> None:
        for nom, canal in self.canaux.items():
            try:
                canal.poster(ligne, maintenant=maintenant)
            except Exception:  # noqa: BLE001 - §47.5, un canal ne retient jamais l'autre
                LOG.exception("canal %s : l'alerte n'a pas pu être déposée", nom)

    def vivants(self) -> tuple[str, ...]:
        """Les canaux qui veillent MAINTENANT (configurés et capables d'envoyer)."""
        return tuple(n for n, c in self.canaux.items() if c.configured and not c.mal_configure)

    def poster_a(self, noms, ligne: dict) -> None:
        """Dépose la ligne sur certains canaux seulement (l'avis de coupure, §47.3.2 ter)."""
        for nom in noms:
            canal = self.canaux.get(nom)
            if canal is None:
                continue
            try:
                canal.poster(ligne)
            except Exception:  # noqa: BLE001
                LOG.exception("canal %s : l'avis n'a pas pu être déposé", nom)

    def vider(self, delai: float = 5.0) -> bool:
        return all([canal.vider(delai) for canal in self.canaux.values()])

    def etat(self) -> dict:
        """L'agrégat de `GET /v1/forge`, et le détail dans `channels` (§47.6)."""
        detail = {nom: canal.etat() for nom, canal in self.canaux.items()}
        actifs = [d for d in detail.values() if d["configured"]]
        # Le canal le plus récemment en échec donne `last_error`, préfixée de son nom quand
        # plusieurs veillent : sans préfixe on ne saurait pas lequel est muet.
        fautifs = [(d["last_error_at"] or "", nom, d) for nom, d in detail.items() if d["last_error"]]
        fautif = max(fautifs, key=lambda t: t[0], default=None)
        erreur = None
        if fautif:
            erreur = fautif[2]["last_error"]
            if len(actifs) > 1:
                erreur = f"{self._LIBELLES.get(fautif[1], fautif[1])} : {erreur}"
        webhook = detail.get("webhook", {})
        return {
            "configured": bool(actifs),
            "source": webhook.get("source", "registre"),
            "misconfigured": any(d["misconfigured"] for d in actifs),
            "unknown_fields": webhook.get("unknown_fields", []),
            "sent": sum(d["sent"] for d in detail.values()),
            "failed": sum(d["failed"] for d in detail.values()),
            "dropped": sum(d["dropped"] for d in detail.values()),
            "last_error": erreur,
            "last_error_at": fautif[0] or None if fautif else None,
            "channels": detail,
        }
