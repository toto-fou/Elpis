# SPDX-License-Identifier: MIT
"""llm_core.context.compaction_gate — les DEUX seuils de la compaction, en un
seul endroit.

Le trou comblé ici
------------------
Le harnais v4 (M3) n'avait qu'UNE règle : compacter quand l'occupation réelle
atteint ``usable = n_ctx − cap de génération − buffer``. Cette formule vivait
en DEUX copies (``_chat_with_tools`` dans la boucle, ``conversation_compressor``
en repli) — deux copies qui n'ont pas divergé, mais qui n'attendaient qu'une
retouche pour le faire.

Elle laissait surtout l'utilisateur sans levier : la compaction partait quand
la fenêtre était pleine, point. Certains la veulent plus tôt (contexte propre,
KV plus léger), d'autres le plus tard possible (historique verbatim maximal).

D'où DEUX seuils au lieu d'un :

  ``usable_tokens``   plafond TECHNIQUE — inchangé, toujours armé. C'est lui
                      qui garantit qu'on ne tronque pas : au-delà, le serveur
                      refuse ou la génération se fait couper.
  ``trigger_tokens``  seuil EFFECTIF choisi par le compte, borné par le
                      plafond technique.

Deux unités pour le même réglage
--------------------------------
``CompactionThreshold`` porte les deux façons de l'exprimer, parce qu'aucune
ne suffit seule :

  • **pourcentage** — se transpose d'un modèle à l'autre. « 70 % » veut dire la
    même chose sur un 32k local et sur un 200k distant, et c'est l'unité de la
    jauge live du composeur ;
  • **tokens** — le budget que l'utilisateur a réellement en tête (« compacte à
    80k »), indépendant de la fenêtre. Sur un parc de modèles hétérogène, 80k
    reste 80k.

Les tokens PRIMENT sur le pourcentage quand les deux sont posés : c'est
l'expression la plus précise, et l'interface n'écrit jamais les deux à la fois
(choisir une unité efface l'autre). Un seuil non réglé (0/0) = « auto » = le
plafond technique, c'est-à-dire le comportement historique.

Le seuil s'applique AUSSI en cours de run
----------------------------------------
Première version : le seuil du compte n'armait qu'en TÊTE de tour, pour ne pas
réécrire l'historique « au milieu » d'une réponse. Règle retirée (2026-08-22) —
elle protégeait d'un danger inexistant et cassait l'usage principal.

La porte est évaluée EN HAUT d'une itération de la boucle outils, donc ENTRE
deux appels d'outils : la requête précédente est terminée, la suivante n'est
pas partie, rien n'est en cours de streaming à cet instant. Il n'y a pas de
flux à couper — juste un marqueur de compaction qui s'ajoute à une réponse déjà
affichée, exactement ce que le plafond technique faisait déjà à cet endroit.

Et une mission longue (plusieurs heures, des centaines d'itérations) tient dans
UN SEUL tour : « reporter au tour suivant » y voulait dire « ne jamais
compacter ». Le seuil du compte n'aurait servi qu'aux conversations courtes,
celles qui n'en ont pas besoin.

La seule règle non négociable reste le plafond technique, qui borne le seuil
par le haut.

Combien de fois ?
-----------------
Compacter tôt veut dire compacter SOUVENT : un run de plusieurs heures peut
passer le seuil dix fois. Le cap par conversation
(``COMPRESSION_MAX_PER_CHAT``) devient alors le vrai mur — atteint, il coupe la
compaction pour tout le reste du run, et il ne reste que le budget dur, qui
JETTE les vieux tours au lieu de les résumer. D'où le second réglage per-user
porté ici : ``compression_max_rounds`` (0 = défaut d'instance, -1 = illimité).

Module PUR : aucune I/O, aucun await. Les seules dépendances sont les constantes
de génération et la config de compaction (lues, jamais rechargées ici — le
resync disque multi-worker reste la responsabilité de l'appelant, qui le fait
déjà avant sa porte).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Optional

# Bornes du POURCENTAGE. 0 = « auto » (pas de choix exprimé). Sous 30 % la
# compaction tournerait en boucle sur les tours récents pour un gain quasi nul,
# et 100 % EST déjà le plafond technique (donc le maximum utile).
PCT_MIN = 30
PCT_MAX = 100

# Bornes du seuil en TOKENS. Plancher = le plancher de génération : sous ça, il
# ne resterait pas de quoi produire un tour. Plafond très large — la vraie
# borne est le plafond technique du modèle courant, appliqué à la résolution ;
# ce clamp-ci n'existe que contre une valeur aberrante (faute de frappe).
TOKENS_MIN = 2_048
TOKENS_MAX = 4_000_000

# Cap de compactions PAR CONVERSATION réglé par le compte. Convention des
# réglages per-user : 0 = « auto » (le défaut d'instance
# ``COMPRESSION_MAX_PER_CHAT`` s'applique). ``MAX_ROUNDS_UNLIMITED`` (-1) dit
# « aucun cap » — valeur distincte de 0 PARCE QUE le compresseur, lui, code
# déjà « illimité » par 0 : sans ce sentinel, un compte ne pourrait pas
# exprimer « illimité » sans être confondu avec « je n'ai rien réglé ».
MAX_ROUNDS_UNLIMITED = -1
# Plafond du réglage. 200 compactions dans une conversation, c'est déjà
# au-delà de ce qu'une mission de plusieurs heures consomme ; au-dessus, c'est
# « illimité » qu'on veut dire, et il y a une valeur pour ça.
MAX_ROUNDS_MAX = 200
# Budget de compactions d'UN run quand le compte a demandé « illimité ». Fini,
# pas infini : le garde-fou anti-emballement de la boucle garde un sens (une
# compaction ne peut pas boucler — seuls les SUCCÈS comptent, et un succès
# sans gain est refusé en amont par la garde no-gain).
RUN_COMPACTION_UNBOUNDED = 1_000

# Clés du réglage per-user (``settings_json``). Nommées ici : le chat, la route
# de settings et l'interface parlent tous du même endroit.
USER_KEY_PCT = "compression_threshold_pct"
USER_KEY_TOKENS = "compression_threshold_tokens"
USER_KEY_MAX_ROUNDS = "compression_max_rounds"


def clamp_threshold_pct(value: Any) -> int:
    """Normalise un pourcentage de seuil : 0 (auto) ou [PCT_MIN, PCT_MAX].

    Non numérique / négatif / None ⇒ 0. Source UNIQUE de la coercition : la
    route de settings, la config admin et la résolution s'en servent toutes,
    donc un même réglage donne le même chiffre partout.
    """
    try:
        pct = int(value)
    except (TypeError, ValueError):
        return 0
    if pct <= 0:
        return 0
    return max(PCT_MIN, min(PCT_MAX, pct))


def clamp_threshold_tokens(value: Any) -> int:
    """Normalise un seuil en tokens : 0 (auto) ou [TOKENS_MIN, TOKENS_MAX]."""
    try:
        tok = int(value)
    except (TypeError, ValueError):
        return 0
    if tok <= 0:
        return 0
    return max(TOKENS_MIN, min(TOKENS_MAX, tok))


def clamp_max_rounds(value: Any) -> int:
    """Normalise le cap de compactions par conversation.

    0 = auto (défaut d'instance), ``MAX_ROUNDS_UNLIMITED`` (-1) = illimité,
    sinon [1, MAX_ROUNDS_MAX]. Toute valeur négative vaut « illimité » : c'est
    la seule lecture possible d'un nombre de compactions négatif, et ça évite
    qu'un -3 tapé à la main devienne un cap de 1.
    """
    try:
        n = int(value)
    except (TypeError, ValueError):
        return 0
    if n < 0:
        return MAX_ROUNDS_UNLIMITED
    if n == 0:
        return 0
    return min(MAX_ROUNDS_MAX, n)


def resolve_max_rounds(user_settings: Optional[Mapping[str, Any]] = None
                       ) -> Optional[int]:
    """Cap de compactions par conversation choisi par le COMPTE, traduit dans
    la convention du compresseur (**0 = illimité**).

    ``None`` = le compte n'a rien réglé ⇒ l'appelant garde le défaut
    d'instance ``COMPRESSION_MAX_PER_CHAT``. Cette distinction est ce qui
    permet à l'admin de rester la référence pour tout le monde sauf ceux qui
    ont explicitement demandé autre chose.
    """
    raw = clamp_max_rounds((user_settings or {}).get(USER_KEY_MAX_ROUNDS))
    if raw == 0:
        return None
    return 0 if raw < 0 else raw


def run_compaction_budget(auto_budget: Any,
                          max_rounds: Optional[int] = None) -> int:
    """Nombre de compactions autorisées dans UN run.

    ``auto_budget`` = ce que la boucle calcule seule (réglage global mis à
    l'échelle du budget d'itérations). ``max_rounds`` = cap par conversation
    RÉGLÉ par le compte, convention compresseur (0 = illimité, None = rien de
    réglé).

    Un compte qui relève son cap veut que ça compte DANS le run : une mission
    de plusieurs heures se déroule dans un seul tour, et un budget de run plus
    bas que le cap de conversation rendrait le réglage muet — la compaction
    s'arrêterait au milieu de la mission sans que rien ne l'explique. Sans
    choix du compte, rien ne bouge : les défauts restent au chiffre près.
    """
    base = max(1, int(auto_budget or 1))
    if max_rounds is None:
        return base
    if int(max_rounds) <= 0:
        return max(base, RUN_COMPACTION_UNBOUNDED)
    return max(base, int(max_rounds))


@dataclass(frozen=True)
class CompactionThreshold:
    """« Contexte max avant compaction », tel que RÉGLÉ (pas encore résolu en
    tokens : il faut la fenêtre du modèle courant pour ça, cf.
    ``compaction_gate``).

    ``tokens`` prime sur ``pct`` — c'est l'expression la plus précise, et
    l'interface n'écrit jamais les deux (choisir une unité efface l'autre).
    Les deux à 0 = auto = plafond technique = comportement historique.
    """
    pct: int = 0
    tokens: int = 0

    @property
    def mode(self) -> str:
        """``"tokens"`` | ``"pct"`` | ``"auto"`` — ce que l'interface affiche."""
        if self.tokens > 0:
            return "tokens"
        return "pct" if self.pct > 0 else "auto"

    @property
    def is_set(self) -> bool:
        return self.mode != "auto"

    def target_tokens(self, ctx_size: int) -> int:
        """Le seuil en TOKENS pour cette fenêtre, avant bornage par ``usable``.
        0 = auto (aucun choix exprimé)."""
        if self.tokens > 0:
            return self.tokens
        if self.pct > 0 and ctx_size > 0:
            return int(ctx_size * self.pct / 100)
        return 0


#: Aucun seuil exprimé — le plafond technique fait foi (comportement d'avant).
AUTO = CompactionThreshold()


def threshold_from(pct: Any = 0, tokens: Any = 0) -> CompactionThreshold:
    """Construit un seuil en normalisant les deux unités d'un coup."""
    return CompactionThreshold(pct=clamp_threshold_pct(pct),
                               tokens=clamp_threshold_tokens(tokens))


def resolve_threshold(user_settings: Optional[Mapping[str, Any]] = None
                      ) -> CompactionThreshold:
    """Seuil applicable : choix du COMPTE, sinon défaut d'INSTANCE, sinon auto.

    Le choix du compte est pris EN BLOC : dès qu'il exprime quelque chose (en
    tokens ou en %), le défaut d'instance ne s'applique plus. Sans ça, un
    compte réglé « 60 % » sur une instance dont le défaut est « 80k » se
    retrouverait avec le 80k de l'admin (les tokens primant sur le pourcentage)
    — l'inverse de ce qu'il a demandé.

    Le défaut d'instance est lu à chaud : l'admin peut le changer sans
    redémarrage, comme les autres réglages de compaction. Best-effort — une
    config illisible retombe sur « auto », jamais sur une exception (toute la
    chaîne de contexte en dépend).
    """
    s = user_settings or {}
    own = threshold_from(s.get(USER_KEY_PCT), s.get(USER_KEY_TOKENS))
    if own.is_set:
        return own
    try:
        from shared_infra import config as _cfg
        return threshold_from(getattr(_cfg, "COMPACTION_THRESHOLD_PCT", 0),
                              getattr(_cfg, "COMPACTION_THRESHOLD_TOKENS", 0))
    except Exception:                               # noqa: BLE001 — best-effort
        return AUTO


@dataclass(frozen=True)
class CompactionGate:
    """Les deux seuils RÉSOLUS pour une fenêtre donnée, en tokens.

    ``ctx_size <= 0`` (fenêtre inconnue — cible distante sans ``n_ctx``
    déclaré) ⇒ tout à 0. L'appelant dégrade exactement comme avant : pas de
    compaction automatique (``reason: ctx_unknown``).
    """
    ctx_size:       int = 0
    usable_tokens:  int = 0   # plafond technique : n_ctx − gen_cap − buffer
    trigger_tokens: int = 0   # seuil effectif (≤ usable)
    threshold:      CompactionThreshold = AUTO

    @property
    def is_user_threshold(self) -> bool:
        """True si le compte a choisi un seuil STRICTEMENT plus tôt que le
        plafond technique — la compaction part alors sur un choix, pas sur une
        contrainte, et les logs le disent (c'est la différence entre « ça
        compacte tout seul » et « ça compacte parce que je l'ai demandé »)."""
        return 0 < self.trigger_tokens < self.usable_tokens

    def describe(self) -> str:
        """Libellé court du seuil, pour les logs (« 70 % », « 80000 tk »,
        « auto »)."""
        m = self.threshold.mode
        if m == "tokens":
            return f"{self.threshold.tokens} tk"
        if m == "pct":
            return f"{self.threshold.pct} %"
        return "auto"


def buffer_tokens(ctx_size: int) -> int:
    """Marge sous le plafond, en tokens — ``llm.compaction.buffer_tokens``,
    0 = auto ``min(20k, 10 % du n_ctx)``. Formule reprise MOT POUR MOT des deux
    copies qu'elle remplace (boucle outils + repli du compresseur)."""
    try:
        from shared_infra import config as _cfg
        buf = int(getattr(_cfg, "COMPACTION_BUFFER_TOKENS", 0) or 0)
    except Exception:                               # noqa: BLE001 — best-effort
        buf = 0
    if buf <= 0:
        buf = min(20_000, int(ctx_size * 0.10))
    return buf


def usable_window(ctx_size: Optional[int], thinking_mode: bool = False) -> int:
    """Plafond TECHNIQUE : ``n_ctx − cap de génération − buffer``.

    Identique au calcul historique, y compris le passage de ``thinking_mode``
    au cap (la boucle outils le connaît, le repli du compresseur non — ce
    dernier passait False, comportement conservé via le défaut)."""
    ctx = int(ctx_size or 0)
    if ctx <= 0:
        return 0
    from llm_core._constants import effective_generation_cap
    return ctx - effective_generation_cap(thinking_mode, ctx) - buffer_tokens(ctx)


def compaction_gate(ctx_size: Optional[int], *,
                    thinking_mode: bool = False,
                    threshold: Optional[CompactionThreshold] = None
                    ) -> CompactionGate:
    """Résout les deux seuils pour cette fenêtre.

    ``threshold`` est pris TEL QUEL (déjà résolu par l'appelant via
    ``resolve_threshold``) — même contrat que ``auto_enabled`` dans
    ``maybe_compress_conversation`` : la politique appartient à l'appelant, la
    géométrie appartient à ce module.
    """
    thr = threshold or AUTO
    ctx = int(ctx_size or 0)
    usable = usable_window(ctx, thinking_mode)
    if ctx <= 0 or usable <= 0:
        # Fenêtre inconnue, ou si petite que la réserve la mange entièrement :
        # rien à dimensionner. L'appelant renonce à la compaction auto.
        return CompactionGate(ctx_size=max(0, ctx), threshold=thr)
    want = thr.target_tokens(ctx)
    # Le plafond technique gagne TOUJOURS : un réglage ne doit jamais repousser
    # la compaction au-delà de ce que la fenêtre supporte (un seuil « 80k » sur
    # un modèle 32k vaut donc « auto »).
    trigger = usable if want <= 0 else min(usable, want)
    # Filet : un seuil qui tomberait sous le plancher de génération ne laisse
    # pas de quoi tenir un tour.
    from llm_core._constants import LLAMA_GEN_CAP_FLOOR
    trigger = max(trigger, min(usable, LLAMA_GEN_CAP_FLOOR))
    return CompactionGate(ctx_size=ctx, usable_tokens=usable,
                          trigger_tokens=trigger, threshold=thr)


def gate_tokens(gate: CompactionGate) -> int:
    """Seuil à opposer à l'occupation, à N'IMPORTE QUELLE itération.

    Une seule valeur, sans condition : ``trigger_tokens``, déjà borné par le
    plafond technique à la construction du gate. La variante qui prenait
    l'itération en compte (seuil du compte en tête de tour, plafond technique
    ensuite) est retirée — cf. l'en-tête du module : une mission longue tient
    dans un seul tour, « au tour suivant » y voulait dire « jamais ».

    Reste une fonction, et pas un accès direct à l'attribut, parce qu'un test
    de source vérifie que la boucle passe par ICI : ré-inliner une comparaison
    sur ``usable`` ferait silencieusement disparaître le réglage du compte, et
    aucun test fonctionnel ne verrait la différence à seuil « auto ».
    """
    return gate.trigger_tokens
