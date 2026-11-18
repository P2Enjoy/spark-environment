"""Chaîne crontab à cinq champs : analyse, prochaine occurrence, phrase lisible.

@spec docs/BACKLOG.md#SPK-182 · docs/DAT.md §74.3 (la fréquence : une chaîne
      crontab à cinq champs, lue en UTC ; la sémantique du jour ; l'écart
      minimal de 15 minutes ; l'analyseur est écrit dans le dépôt)

`minute heure jour-du-mois mois jour-de-la-semaine`, lue en **UTC**.

Pourquoi un analyseur écrit ici plutôt qu'une bibliothèque : cinq champs ne
justifient pas une dépendance de plus (CLAUDE.md §19), et la sémantique du jour
— jour du mois ET jour de la semaine, qui se combinent en « ou » — est
précisément ce qui varie d'une bibliothèque à l'autre. Ce module ne lit ni
l'horloge ni le registre : il est pur, donc éprouvable sans rien monter.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

#: Écart minimal entre deux prises consécutives, en minutes (DAT §74.3). Un SLA
#: toutes les minutes produirait des centaines d'instantanés par jour et
#: épuiserait le quota (§19.4). Constante du code, documentée au DAT : ni une
#: variable d'environnement ni un réglage.
ECART_MINIMAL_MINUTES = 15

_MOIS = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
         "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
_JOURS = {"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6}

#: (nom du champ, minimum, maximum, noms admis). Le dimanche vaut 0 ou 7.
_CHAMPS = (
    ("minute", 0, 59, {}),
    ("heure", 0, 23, {}),
    ("jour du mois", 1, 31, {}),
    ("mois", 1, 12, _MOIS),
    ("jour de la semaine", 0, 7, _JOURS),
)

_NOMS_JOURS = ("dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi")
_NOMS_MOIS = ("janvier", "février", "mars", "avril", "mai", "juin", "juillet",
              "août", "septembre", "octobre", "novembre", "décembre")

#: Au-delà de huit ans, une date qui ne vient pas ne viendra pas : le 29 février
#: revient au plus tous les huit ans (1896 → 1904), et rien d'autre n'est plus rare.
_HORIZON_JOURS = 366 * 8 + 2


class ErreurCron(ValueError):
    """Chaîne refusée. Le message dit ce qui ne va pas, pour l'écran."""


@dataclass(frozen=True)
class Horaire:
    """Une chaîne crontab analysée."""

    source: str
    minutes: frozenset[int]
    heures: frozenset[int]
    jours: frozenset[int]
    mois: frozenset[int]
    semaine: frozenset[int]  # 0 = dimanche, jamais 7
    jour_restreint: bool
    semaine_restreinte: bool

    def convient_jour(self, jour: date) -> bool:
        """Le mois et le jour conviennent-ils ?

        Sémantique de cron : quand le jour du mois ET le jour de la semaine sont
        tous deux restreints, une date convient dès que **l'un ou l'autre**
        convient. Quand l'un est `*`, il convient à tout : le « et » suffit.
        """
        if jour.month not in self.mois:
            return False
        du_mois = jour.day in self.jours
        de_la_semaine = (jour.weekday() + 1) % 7 in self.semaine
        if self.jour_restreint and self.semaine_restreinte:
            return du_mois or de_la_semaine
        return du_mois and de_la_semaine

    def prochaine(self, apres: datetime) -> datetime:
        """La plus petite occurrence **strictement après** `apres`, en UTC."""
        apres = _en_utc(apres)
        t = apres.replace(second=0, microsecond=0) + timedelta(minutes=1)
        heures = sorted(self.heures)
        minutes = sorted(self.minutes)
        jour = t.date()
        for decalage in range(_HORIZON_JOURS):
            courant = jour + timedelta(days=decalage)
            if not self.convient_jour(courant):
                continue
            for h in heures:
                if decalage == 0 and h < t.hour:
                    continue
                for m in minutes:
                    if decalage == 0 and h == t.hour and m < t.minute:
                        continue
                    return datetime(courant.year, courant.month, courant.day, h, m,
                                    tzinfo=timezone.utc)
        raise ErreurCron("Aucune date ne convient à cette fréquence (par exemple un 31 février).")

    def occurrences(self, apres: datetime, nombre: int) -> list[datetime]:
        """Les `nombre` prochaines occurrences, strictement après `apres`."""
        rendues: list[datetime] = []
        courante = apres
        for _ in range(nombre):
            courante = self.prochaine(courante)
            rendues.append(courante)
        return rendues

    def ecart_minimal(self) -> int:
        """Le plus petit écart, en minutes, entre deux occurrences consécutives."""
        heure_du_jour = sorted(h * 60 + m for h in self.heures for m in self.minutes)
        ecarts = [b - a for a, b in zip(heure_du_jour, heure_du_jour[1:])]
        # Entre le dernier horaire d'un jour et le premier du suivant, seulement
        # si deux jours consécutifs conviennent : sur quatre ans, bissextile
        # comprise, tous les enchaînements possibles se présentent.
        depart = date(2024, 1, 1)
        for i in range(366 * 4):
            jour = depart + timedelta(days=i)
            if self.convient_jour(jour) and self.convient_jour(jour + timedelta(days=1)):
                ecarts.append(1440 - heure_du_jour[-1] + heure_du_jour[0])
                break
        return min(ecarts) if ecarts else 1440 * 366


def _en_utc(instant: datetime) -> datetime:
    if instant.tzinfo is None:
        return instant.replace(tzinfo=timezone.utc)
    return instant.astimezone(timezone.utc)


def _valeur(texte: str, champ: tuple, brut: str) -> int:
    nom, mini, maxi, noms = champ
    minuscule = texte.lower()
    if minuscule in noms:
        valeur = noms[minuscule]
    elif texte.isdigit():
        valeur = int(texte)
    else:
        raise ErreurCron(f"Champ « {nom} » : « {texte} » n'est pas une valeur admise.")
    if not mini <= valeur <= maxi:
        raise ErreurCron(
            f"Champ « {nom} » : {valeur} est hors des bornes {mini} à {maxi}.")
    return valeur


def _champ(texte: str, champ: tuple) -> frozenset[int]:
    nom, mini, maxi, _noms = champ
    if texte == "":
        raise ErreurCron(f"Champ « {nom} » vide.")
    valeurs: set[int] = set()
    for morceau in texte.split(","):
        base, pas_texte = (morceau.split("/", 1) + [None])[:2] if "/" in morceau \
            else (morceau, None)
        if pas_texte is not None:
            if not pas_texte.isdigit() or int(pas_texte) < 1:
                raise ErreurCron(f"Champ « {nom} » : le pas « {pas_texte} » doit être un entier ≥ 1.")
            pas = int(pas_texte)
        else:
            pas = 1
        if base == "*":
            debut, fin = mini, maxi
            if nom == "jour de la semaine":
                fin = 6  # `*` ne compte pas le dimanche deux fois
        elif "-" in base:
            gauche, droite = base.split("-", 1)
            debut, fin = _valeur(gauche, champ, texte), _valeur(droite, champ, texte)
            if debut > fin:
                raise ErreurCron(
                    f"Champ « {nom} » : l'intervalle « {base} » va à rebours.")
        else:
            if pas_texte is not None:
                raise ErreurCron(
                    f"Champ « {nom} » : un pas ne s'applique qu'à « * » ou à un intervalle.")
            debut = fin = _valeur(base, champ, texte)
        valeurs.update(range(debut, fin + 1, pas))
    if nom == "jour de la semaine":
        valeurs = {v % 7 for v in valeurs}  # 7 est un dimanche
    return frozenset(valeurs)


def analyser(texte: str) -> Horaire:
    """Analyse une chaîne crontab ; lève `ErreurCron` avec la raison du refus."""
    if not isinstance(texte, str) or not texte.strip():
        raise ErreurCron("La fréquence est vide.")
    source = " ".join(texte.split())
    if source.startswith("@"):
        raise ErreurCron(
            f"L'alias « {source.split()[0]} » n'est pas pris en charge : "
            "choisissez une fréquence courante ou écrivez les cinq champs.")
    morceaux = source.split(" ")
    if len(morceaux) != 5:
        raise ErreurCron(
            f"Cinq champs attendus (minute heure jour mois jour-de-la-semaine), "
            f"{len(morceaux)} reçu(s).")
    minutes, heures, jours, mois, semaine = (
        _champ(t, c) for t, c in zip(morceaux, _CHAMPS))
    horaire = Horaire(
        source=source, minutes=minutes, heures=heures, jours=jours, mois=mois,
        semaine=semaine,
        # Comme cron : un champ qui COMMENCE par « * » n'est pas une restriction.
        jour_restreint=not morceaux[2].startswith("*"),
        semaine_restreinte=not morceaux[4].startswith("*"),
    )
    horaire.prochaine(datetime(2024, 1, 1, tzinfo=timezone.utc))  # une date existe-t-elle ?
    ecart = horaire.ecart_minimal()
    if ecart < ECART_MINIMAL_MINUTES:
        raise ErreurCron(
            f"Deux prises ne peuvent pas être espacées de moins de "
            f"{ECART_MINIMAL_MINUTES} minutes (celle-ci : {ecart}).")
    return horaire


# --- la phrase lisible ---------------------------------------------------------

def _liste(elements: list[str]) -> str:
    if len(elements) <= 1:
        return "".join(elements)
    return ", ".join(elements[:-1]) + " et " + elements[-1]


def _progression(valeurs: list[int], pas_max: int) -> int | None:
    """Le pas d'une progression arithmétique démarrant à 0, ou `None`."""
    if len(valeurs) < 2 or valeurs[0] != 0:
        return None
    pas = valeurs[1] - valeurs[0]
    if pas < 2 or pas > pas_max or valeurs != list(range(0, valeurs[-1] + 1, pas)):
        return None
    return pas


def _ordinal(jour: int) -> str:
    return "1er" if jour == 1 else str(jour)


def _jours_phrase(h: Horaire) -> str:
    semaine = sorted(h.semaine)
    du_mois = sorted(h.jours)
    morceaux: list[str] = []
    if h.semaine_restreinte:
        if semaine == [1, 2, 3, 4, 5]:
            morceaux.append("du lundi au vendredi")
        elif len(semaine) == 1:
            morceaux.append(f"le {_NOMS_JOURS[semaine[0]]}")
        else:
            morceaux.append("le " + _liste([_NOMS_JOURS[d] for d in semaine]))
    if h.jour_restreint:
        if len(du_mois) == 1:
            morceaux.append(f"le {_ordinal(du_mois[0])} du mois")
        else:
            morceaux.append("les " + _liste([_ordinal(d) for d in du_mois]) + " du mois")
    if not morceaux:
        jours = "tous les jours"
    else:
        jours = " ou ".join(morceaux)
    if len(h.mois) < 12:
        jours += " en " + _liste([_NOMS_MOIS[m - 1] for m in sorted(h.mois)])
    return jours


def decrire(h: Horaire) -> str:
    """La fréquence en français (« Tous les jours à 02:00 UTC »).

    Une phrase d'aide à la lecture : ce qui fait foi est la chaîne. Quand la
    forme n'est pas reconnue, la phrase le dit au lieu d'inventer.
    """
    minutes = sorted(h.minutes)
    heures = sorted(h.heures)
    tous_les_jours = not h.jour_restreint and not h.semaine_restreinte and len(h.mois) == 12
    jours = _jours_phrase(h)

    if len(heures) == 24 and len(minutes) == 1:
        cadence = "Toutes les heures" if minutes[0] == 0 \
            else f"Toutes les heures, à la minute {minutes[0]}"
    elif len(heures) == 24 and (pas := _progression(minutes, 59)):
        cadence = f"Toutes les {pas} minutes"
    elif len(minutes) == 1 and (pas := _progression(heures, 12)):
        cadence = f"Toutes les {pas} heures" if minutes[0] == 0 \
            else f"Toutes les {pas} heures, à la minute {minutes[0]}"
    else:
        cadence = None

    if cadence is not None:
        return cadence + ("" if tous_les_jours else f", {jours}") + " (UTC)"

    horaires = [f"{hh:02d}:{mm:02d}" for hh in heures for mm in minutes]
    if len(horaires) > 8:
        return (f"{jours[0].upper()}{jours[1:]}, {len(horaires)} fois par jour (UTC) "
                f"— voir la chaîne")
    return f"{jours[0].upper()}{jours[1:]} à {_liste(horaires)} UTC"
