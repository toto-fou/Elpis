# SPDX-License-Identifier: MIT
"""llm_core.engine.live_text — émission directe du contenu d'un appel LLM.

Le contenu d'une itération part vers le client au fil des jetons, sans
attendre la fin de la génération (sinon le premier caractère visible
n'arriverait qu'à la fin). Le seul risque est le balisage d'appel d'outil
qu'un modèle mêle parfois à sa prose : une fenêtre de retenue et un portail
suffisent à ne jamais l'émettre. Dès qu'une trace de balisage apparaît dans la
partie non émise, l'émission directe s'arrête pour l'itération ; le reste part,
nettoyé, en fin d'itération (``emit_rest``). Un faux positif du portail est
donc bénin.

La fenêtre garantit qu'une amorce de balise encore incomplète n'est jamais
émise : la plus longue amorce discriminante fait ~10 caractères, 48 laissent de
la marge sans être perceptibles. Les motifs couvrent les dialectes retirés par
``_strip_tool_call_markup`` et les balises spéciales ``<|…|>`` des dialectes de
raisonnement inconnus du découpeur.

Un ``LiveText`` vit le temps d'UNE itération : il tient le tampon des jetons de
contenu (``parts``, relu par la boucle), le nombre de caractères déjà émis
(``n``), la fenêtre non émise (``pend``) et l'état du portail (``gated``).

``parts`` n'est jamais réaffectée, seulement modifiée en place (``on_token``,
``prefixer_deja_emis``, ``purger``) : les phases de la boucle en gardent un
alias (``_iter_content_parts = live.parts``) qui doit voir chaque changement.
``emit_rest`` est TERMINAL : il n'avance ni ``n`` ni ``pend``, aucune émission
ne le suit pour l'itération.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, List, Optional

from llm_core._scheduling._guard import _emit

_LIVE_HOLDBACK_CHARS = 48
_LIVE_MARKUP_SUSPECT_RE = re.compile(
    # ``{"name":`` = amorce d'un appel JSON en texte libre (stratégie « JSON
    # pur » d'``extract_tool_calls``) : halluciné vers un outil inconnu, la
    # boucle PURGE le tampon (cf. ``_looks_like_pure_tool_call_text``) — il ne
    # doit donc jamais partir en direct.
    r"<\s*/?\s*(?:tool_call|function|parameter|tools?\b|arg_key|arg_value)"
    r"|<\||\{\s*\"name\"\s*:",
    re.IGNORECASE)


def _live_stream_rest(clean_text: str, raw_text: str, n_emitted: int) -> Optional[str]:
    """Ce qu'il RESTE à émettre d'un texte NETTOYÉ dont un préfixe BRUT de
    ``n_emitted`` caractères est déjà parti en direct.

    ``_strip_tool_call_markup`` termine par ``.strip()`` : le nettoyé peut
    perdre le blanc de tête du brut — on aligne les offsets là-dessus. Retour :
    la queue à émettre (str, possiblement vide), ou ``None`` si le nettoyage a
    MODIFIÉ la partie déjà émise (l'appelant doit resynchroniser ou renoncer)."""
    if n_emitted <= 0:
        return clean_text
    lead_ws = len(raw_text) - len(raw_text.lstrip())
    eff = n_emitted - lead_ws
    if eff <= 0:
        return clean_text
    if clean_text[:eff] == raw_text[lead_ws:n_emitted]:
        return clean_text[eff:]
    return None


@dataclass(slots=True)
class LiveText:
    """Émission directe du contenu d'une itération (voir l'en-tête)."""

    on_event: Any
    # Tampon des jetons de contenu de l'itération : alimenté ici, relu par la
    # boucle, préfixé ou vidé par les méthodes ci-dessous. Jamais réaffecté
    # (cf. l'en-tête).
    parts: List[str] = field(default_factory=list)
    n: int = 0          # caractères déjà émis
    pend: str = ""      # fenêtre non émise
    gated: bool = False  # balisage suspecté : plus d'émission pour l'itération

    async def on_token(self, tok: str) -> None:
        """Rappel de flux : un jeton de contenu."""
        self.parts.append(tok)
        if self.gated:
            return
        self.pend += tok
        m = _LIVE_MARKUP_SUSPECT_RE.search(self.pend)
        if m is not None:
            self.gated = True
            chunk = self.pend[:m.start()]
            self.pend = ""
        else:
            cut = len(self.pend) - _LIVE_HOLDBACK_CHARS
            if cut <= 0:
                return
            chunk = self.pend[:cut]
            self.pend = self.pend[cut:]
        if chunk:
            self.n += len(chunk)
            await _emit(self.on_event, {"type": "content_token", "text": chunk})

    async def flush(self) -> None:
        """Émet la fenêtre de retenue avant une relance ou la génération des
        arguments d'un appel : ces ≤48 caractères déjà générés seraient sinon
        perdus (narration coupée en plein mot) ou retenus pendant toute la
        génération des arguments. Sans effet si le portail a coupé."""
        if self.gated or not self.pend:
            return
        chunk = self.pend
        self.pend = ""
        self.n += len(chunk)
        await _emit(self.on_event, {"type": "content_token", "text": chunk})

    def prefixer_deja_emis(self, texte: str) -> None:
        """Reprise de rédaction : place en tête de ``parts`` la prose des
        segments précédents, que le client tient DÉJÀ, et la compte dans
        ``n`` — sinon ``emit_rest`` renverrait ``(préfixe + segment)[n:]`` et
        la réponse s'afficherait en double à chaque reprise.

        Sans effet si ``parts`` est vide (fournisseur sans flux, stub de
        test) : ``finish_ok`` préfère le contenu streamé dès qu'il est non
        vide, et un tampon réduit au seul préfixe y ferait perdre le segment
        qui vient d'être généré."""
        if self.parts:
            self.parts.insert(0, texte)
            self.n += len(texte)

    def purger(self) -> None:
        """Vide le tampon des jetons (appel en texte vers un outil inconnu,
        sans prose autour : il ne doit pas finir dans la réponse). ``n``, le
        nombre de caractères déjà partis chez le client, ne change pas : la
        purge ne rappelle rien de ce qui est affiché."""
        self.parts.clear()

    async def emit_rest(self, text: str, *, replace_on_divergence: bool) -> None:
        """Émet la queue de ``text`` (version nettoyée du contenu) que le
        client n'a pas encore reçue. Si le nettoyage a modifié la partie déjà
        émise : ``content_replace`` quand ``replace_on_divergence``, rien
        sinon (le transcript persisté porte de toute façon la version propre).

        TERMINAL pour l'itération : ``n`` et ``pend`` ne sont pas avancés,
        aucun ``on_token`` ni ``flush`` ne doit suivre."""
        rest = _live_stream_rest(text, "".join(self.parts), self.n)
        if rest is None:
            if replace_on_divergence:
                await _emit(self.on_event, {"type": "content_replace", "text": text})
        elif rest:
            await _emit(self.on_event, {"type": "content_token", "text": rest})
