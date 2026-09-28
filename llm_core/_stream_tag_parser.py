# SPDX-License-Identifier: MIT
"""
backend.services._stream_tag_parser — robust streaming detector for
``<think>``/``</think>`` tags split across SSE chunk boundaries.

Why this exists
---------------
Both ``llama_chat_stream_tokens`` (chat sans tools) and
``_llama_chat_with_tools_stream`` (chat + tools) used to detect the
opening and closing think tags with a naive ``if "<think>" in chunk:``
test. That works as long as the entire tag fits inside a single SSE
chunk. In practice, llama.cpp can split the bytes anywhere — we have
seen real traces where a chunk ends with ``<th`` and the next one
starts with ``ink>``. Result: tag never detected, the entire reasoning
ended up in ``content_buf`` (visible as raw ``<think>...`` text in the
chat bubble) — or worse, ``</think>`` split mid-tag meant we *never
exit* think mode and the actual answer ended up in the thinking panel.

This module exposes a tiny stateful parser that buffers up to N-1
characters between chunks (where N = max tag length) so it can detect
tags that straddle a boundary, while still producing output as fast as
possible (no buffering for plain text).

Public API
----------
- ``ThinkTagSplitter()``                     → instance per stream
- ``splitter.feed(chunk: str) -> List[Segment]``
   where ``Segment`` is one of ``("content", text)``, ``("thinking", text)``,
   or ``("toggle", "open"|"close")`` for state-change observability.

The caller iterates the segments and routes them to the right buffer
exactly the same way the inline code did before. Because we never look
at more than one tag at a time, this stays O(n) on stream length.
"""
from __future__ import annotations

import re
from typing import List, Tuple

# We only emit raw text segments — tag toggles are implicit (the parser
# alternates between "content" and "thinking" segments by definition).
Segment = Tuple[str, str]   # (kind, text)  kind ∈ {"content","thinking"}

_OPEN  = "<think>"
_CLOSE = "</think>"

# AUDIT 2026-08-23 — recherche par REGEX insensible à la casse SUR LA CHAÎNE
# D'ORIGINE. Le parseur travaillait sur ``data.lower()`` et appliquait les
# indices obtenus à ``data`` : il suppose donc ``len(s.lower()) == len(s)``,
# ce qui est FAUX en Unicode. ``'İ'.lower()`` (U+0130, I turc pointé) rend
# DEUX caractères — le seul codepoint du plan concerné, vérifié par balayage
# de 0..0x2FFFF. Dès qu'un tel caractère précédait une balise dans la même
# fenêtre, tous les découpages suivants du chunk étaient décalés d'un
# caractère : mesuré, ``feed('İ<think>abc</think>fin')`` rendait
# ``[('content','İ<'), ('thinking','bc<'), ('content','in')]`` — le ``<`` de
# la balise fuit dans la bulle, le ``a`` et le ``f`` sont perdus. Atteignable
# dès qu'un fournisseur envoie des deltas multi-tokens (OpenAI-compat
# distant, rejeu de tampon d'une reprise) sur du texte turc.
#
# AUDIT 2026-08-23 (bis) — le dialecte ``<|thinking|>`` / ``<|/thinking|>``
# (émis par certains builds llama.cpp) est reconnu ICI, à la source. Le
# splitter ne connaissait que ``<think>`` : les balises traversaient donc le
# canal CONTENU token par token, l'utilisateur les voyait s'écrire dans sa
# bulle, et le buffer streamé — qui prime sur la version nettoyée en fin de
# tour — les faisait persister en base. ``_extract_thinking`` savait pourtant
# les retirer, mais seulement sur le chemin non streamé.
_OPEN_ALT = "<|thinking|>"
_CLOSE_ALT = "<|/thinking|>"
_OPEN_TAGS = (_OPEN, _OPEN_ALT)
_CLOSE_TAGS = (_CLOSE, _CLOSE_ALT)
_RE_OPEN = re.compile("|".join(re.escape(x) for x in _OPEN_TAGS), re.IGNORECASE)
_RE_CLOSE = re.compile("|".join(re.escape(x) for x in _CLOSE_TAGS), re.IGNORECASE)

# Maximum tag length we care about (longer of OPEN/CLOSE). Used to size
# the lookahead buffer: at any point the buffer holds at most
# ``_MAX_TAG_LEN - 1`` characters that *might* be the prefix of a tag.
_MAX_TAG_LEN = max(len(x) for x in (_OPEN, _CLOSE, _OPEN_ALT, _CLOSE_ALT))


def _shared_prefix_with_tag(tail: str, tag: str) -> int:
    """Return the length of the longest non-empty suffix of ``tail`` that
    equals a prefix of ``tag``. Used to know how many trailing characters
    of ``tail`` we MUST hold back because they might form the start of
    ``tag`` once the next chunk arrives.

    Example::

        _shared_prefix_with_tag("hello </th",   "</think>")  → 4   ("</th")
        _shared_prefix_with_tag("hello </think", "</think>") → 7   ("</think")  # but tag found, see below
        _shared_prefix_with_tag("hello world",   "</think>") → 0
    """
    if not tail or not tag:
        return 0
    # Largest k such that tail[-k:] == tag[:k] (case-insensitive).
    # ⚠ La comparaison se fait CARACTÈRE PAR CARACTÈRE sur les chaînes
    # d'origine : ``tail.lower()`` peut changer de LONGUEUR (U+0130), et un
    # ``endswith`` sur la version minusculée rapporterait alors un ``k`` qui
    # ne correspond à rien dans ``tail`` (cf. la note en tête de module).
    max_k = min(len(tail), len(tag))
    for k in range(max_k, 0, -1):
        if all(a.lower() == b.lower() for a, b in zip(tail[-k:], tag[:k])):
            return k
    return 0


class ThinkTagSplitter:
    """Stateful parser. Feed it chunks, get back routed segments.

    Thread-/coroutine-safety: NOT safe for concurrent use. One instance
    per stream.
    """

    __slots__ = ("_in_think", "_buf")

    def __init__(self) -> None:
        # AUDIT 2026-08-23 — ``start_in_think`` SUPPRIMÉ : les quatre sites de
        # construction du dépôt instancient tous sans argument. Le commentaire
        # de ``_chat_with_tools`` qui affirmait « le flux de continuation est
        # routé en thinking via ThinkTagSplitter(start_in_think=True) » est
        # périmé depuis que le repli de reprise a basculé d'un prefill
        # ``<think>`` NON fermé à un prefill FERMÉ + consigne de conclusion.
        self._in_think: bool = False
        # Pending text we know belongs to the current state but COULD
        # still be the start of a tag once we see more bytes. We hold
        # back up to ``_MAX_TAG_LEN - 1`` bytes here.
        self._buf: str = ""

    @property
    def in_think(self) -> bool:
        return self._in_think

    def feed(self, chunk: str) -> List[Segment]:
        """Process one chunk; return the list of (kind, text) to emit.

        The parser is greedy on emitting plain text (we don't buffer the
        whole stream) but conservative about characters that *might* be
        the start of a tag — those are kept in ``self._buf`` until the
        next chunk disambiguates.
        """
        if not chunk:
            return []
        out: List[Segment] = []
        # Combine any held-over prefix from the previous chunk with the
        # new bytes. From here on, ``data`` is the working window.
        data = self._buf + chunk
        self._buf = ""
        i = 0
        n = len(data)

        while i < n:
            # Decide which tag we're looking for given current state.
            targets = _CLOSE_TAGS if self._in_think else _OPEN_TAGS
            rx = _RE_CLOSE if self._in_think else _RE_OPEN

            # Recherche sur ``data`` LUI-MÊME : les indices rendus sont donc
            # ceux de la chaîne qu'on va trancher (cf. la note de module).
            _m = rx.search(data, i)
            j = _m.start() if _m else -1
            if j != -1:
                # Plain text up to the tag goes to the current channel.
                if j > i:
                    out.append(
                        ("thinking" if self._in_think else "content", data[i:j])
                    )
                # Skip past the tag itself and flip state. ``_m.end()`` et
                # non ``j + len(target)`` : deux dialectes de longueurs
                # différentes partagent la même expression.
                i = _m.end()
                self._in_think = not self._in_think
                continue

            # No full tag in remaining data. Determine how many trailing
            # characters MIGHT be the start of a tag — those we hold
            # back in ``_buf`` for the next ``feed()`` call.
            tail = data[i:]
            # On retient le plus long préfixe partagé avec l'UN des dialectes
            # attendus dans cet état — sinon un chunk qui s'arrête sur
            # ``<|thin`` serait émis en clair puis complété au chunk suivant.
            hold = max(_shared_prefix_with_tag(tail, x) for x in targets)
            # Edge case: hold can equal len(tail) only if the entire
            # remainder is itself a strict prefix of the tag (e.g. the
            # chunk ends with exactly ``<th``). That's fine — we hold
            # the whole thing.
            if hold > 0:
                self._buf = tail[-hold:]
                emit = tail[:-hold]
            else:
                self._buf = ""
                emit = tail
            if emit:
                out.append(
                    ("thinking" if self._in_think else "content", emit)
                )
            break

        return out

    def flush(self) -> List[Segment]:
        """Flush whatever's left in the held-back buffer at end of stream.

        At end-of-stream there is no more data to disambiguate the held
        prefix — by definition it was NOT the start of a tag (since the
        rest of the tag never came). So we emit it as plain text on the
        current channel.
        """
        if not self._buf:
            return []
        out: List[Segment] = [
            ("thinking" if self._in_think else "content", self._buf)
        ]
        self._buf = ""
        return out
