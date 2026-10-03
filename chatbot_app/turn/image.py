# SPDX-License-Identifier: MIT
"""
chatbot_app.turn.image — tour de chat « Images » : la demande part au moteur
d'images, pas au modèle de langage.

Appelé par ``api_chat_saved_stream3`` (``chatbot_app/routes/chats.py``) dès
que le corps porte ``image_gen``, APRÈS ses gardes communes (compaction en
cours, génération déjà active, plafond d'exécutions du compte). Même flux
NDJSON, même verrou de présence, même Stop, même journal reprenable :

    mode {kind:"image"}                                   une fois
    image_prompt {text}                                   description enrichie
    image_progress {state, queue_position, elapsed_s, eta_s, pct, pct_real…}
                                                          à chaque changement
    image {items:[références], prompt}                    images rangées
    image_error {code, message, retryable}                en cas d'échec
    final {assistant, generated_images, image_meta, image_error?, persisted…}

``ping`` maintient la connexion pendant un long calcul (jamais journalisé).
Le temps écoulé se compte côté interface : le journal ne reçoit que les
changements d'état.

Pré-vol en HTTP, avant le flux (seul moment où un code d'erreur peut encore
partir) : 503 moteur indisponible, 403 compte non autorisé ou case décochée,
400 demande invalide, 404 image à modifier introuvable, 409 modèle de langage
indisponible pour enrichir.

Persistance : la question (avec ``image_request``) est écrite dès le début,
puis la réponse ``{content: légende, generated_images, image_meta}`` (ou
``image_error``) sous la garde optimiste de ``_persist_turn``. La légende est
ce que le modèle lit aux tours suivants : jamais les octets de l'image.

Déconnexion du client (onglet fermé, autre conversation) : le tour continue et
persiste seul — une image coûte cher à recalculer. Seul un Stop explicite
l'arrête (job en file annulé, job en cours abandonné).
"""
from __future__ import annotations

import asyncio
import logging
import secrets
import time
from typing import Any, Callable, Dict, List, Optional

from fastapi import HTTPException, Request
from fastapi.responses import StreamingResponse

from chatbot_app.turn.admission import (
    _PENDING_GEN_LOCK_WATCHDOG_S,
    _acquire_gen_presence,
    _handover_rebaseline_ok,
    _pending_gen_locks,
    _release_unclaimed_gen_lock,
)
from chatbot_app.turn.history import _normalize_client_messages
from chatbot_app.turn.persistence import _attendre_hors_annulation, _persist_turn
from chatbot_app.turn.tasks import keep
from llm_core.imagegen.base import ImageError, decode_b64
from llm_core.imagegen.service import (
    ProgressTracker,
    build_request,
    capabilities,
    generate_and_store,
    model_name,
)
from shared_infra.chat.store import (
    enforce_recent_chats_cap,
    get_chat,
    set_title_if_default,
    upsert_chat,
)
from shared_infra.image import access
from shared_infra.image.config import get_image_config, image_ready
from shared_infra.image.messages import caption, failure_caption, sanitize_request
from shared_infra.image.store import read_bytes, valid_id
from shared_infra.observability.tracing import swallow
from shared_infra.routes._helpers import _msg_text, _ndjson_line
from shared_infra.routes._state import (
    clear_chat_cancellation,
    is_chat_cancelled,
    register_chat_task,
    unregister_chat_task,
)

logger = logging.getLogger("uvicorn.error")

#: Silence au-delà duquel un ``ping`` part (proxy, navigateur).
_PING_S = 15.0
_QUEUE_MAX = 200
_STOPPED = "Génération arrêtée."


def _source_from_message(content: Any) -> Optional[bytes]:
    """Première image jointe (partie ``image_url`` en data URL) du message.
    Synchrone : à appeler en thread (jusqu'à une vingtaine de Mo décodés)."""
    if not isinstance(content, list):
        return None
    for part in content:
        if isinstance(part, dict) and part.get("type") == "image_url":
            url = str((part.get("image_url") or {}).get("url") or "")
            if url.startswith("data:image/"):
                return decode_b64(url)
    return None


def _compression_carry(existing: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Message system d'état de compaction à re-préfixer (le client ne renvoie
    jamais les system) : sans lui, ce tour effacerait le résumé du chat."""
    if not existing:
        return []
    try:
        from llm_core.conversation_compressor import (
            build_state_system_message,
            extract_compression_state,
        )
        st = extract_compression_state(existing.get("messages") or [])
        if not st or not st.get("summary_xml"):
            return []
        return [build_state_system_message(
            st["summary_xml"], int(st.get("round") or 1), int(st.get("covered_turns") or 0),
            turns_compressed=st.get("turns_compressed"),
            ledger_block=st.get("ledger_block") or "")]
    except Exception:                                           # noqa: BLE001
        logger.warning("[image] état de compaction illisible : persisté sans", exc_info=True)
        return []


def _access_check(user_id: int, cfg: Dict[str, Any]) -> Optional[str]:
    """Message de refus (403), ou ``None``. Synchrone (groupes, réglages)."""
    if not access.user_allowed(user_id, cfg):
        return "La génération d'images n'est pas ouverte à votre compte."
    if not access.enabled_in(access.read_settings(user_id)):
        return "La génération d'images est désactivée dans vos Paramètres."
    return None


def _http_error(exc: ImageError) -> HTTPException:
    status = exc.status if exc.status in (400, 404) else (
        503 if exc.code in ("unavailable", "timeout", "busy") else 400)
    if exc.detail:
        logger.info("[image] pré-vol : %s — %s", exc.message, exc.detail)
    return HTTPException(status, {"code": exc.code, "message": exc.message})


def _resolve_enhance_target(user_id: int, data: Dict[str, Any]):
    """Cible du modèle de langage qui enrichit la description : celle du chat,
    avec les mêmes droits que pour un tour texte (409 sinon)."""
    from llm_core._target import EngineUnavailable, resolve_llm_target
    try:
        cid = data.get("connector_id")
        cid = int(cid) if cid not in (None, "", 0, "0") else None
    except (TypeError, ValueError):
        cid = None
    try:
        target = resolve_llm_target(user_id, cid, data.get("model"), strict=True)
    except EngineUnavailable as eu:
        raise HTTPException(409, {"code": "engine_unavailable", "reason": eu.reason,
                                  "message": eu.message}) from eu
    from shared_infra.llm import engine_access as _ea
    ekey = _ea.connector_key(cid) if cid else _ea.BUILTIN_KEY
    if not _ea.can_use_engine(user_id, ekey):
        raise HTTPException(409, {"code": "engine_unavailable", "reason": "forbidden",
                                  "message": "Ce serveur ne vous est pas ouvert."})
    return target


async def image_turn(request: Request, data: Dict[str, Any], user_id: int,
                     chat_id: str) -> StreamingResponse:
    cfg = get_image_config()
    if not image_ready(cfg):
        raise HTTPException(503, {"code": "unavailable",
                                  "message": "Aucun moteur d'images n'est configuré."})
    refus = await asyncio.to_thread(_access_check, user_id, cfg)
    if refus:
        raise HTTPException(403, {"code": "forbidden", "message": refus})
    opts = data.get("image_gen")
    if not isinstance(opts, dict):
        raise HTTPException(400, "image_gen doit être un objet")
    raw_messages = data.get("messages") or []
    if not isinstance(raw_messages, list):
        raise HTTPException(400, "messages doit être une liste")
    messages, msgs = _normalize_client_messages(raw_messages)
    if not msgs or msgs[-1].get("role") != "user":
        raise HTTPException(400, "messages: le dernier message doit être la demande")
    prompt = _msg_text(messages[-1].get("content", "")).strip()

    # Édition : image générée désignée (« Modifier ») OU image jointe.
    ref_id = opts.get("ref_image_id") if valid_id(opts.get("ref_image_id")) else ""
    try:
        if ref_id:
            source = await asyncio.to_thread(read_bytes, user_id, ref_id)
            if source is None:
                raise HTTPException(404, {"code": "invalid",
                                          "message": "Image à modifier introuvable ou expirée."})
        else:
            source = await asyncio.to_thread(_source_from_message, messages[-1].get("content"))
        caps = await capabilities(cfg)
        req = await asyncio.to_thread(build_request, cfg, prompt, opts, caps, source)
    except ImageError as exc:
        raise _http_error(exc) from exc

    enhance_target = None
    if opts.get("enhance") is True and cfg["enhance_enabled"]:
        enhance_target = await asyncio.to_thread(_resolve_enhance_target, user_id, data)

    ephemeral = bool(data.get("ephemeral", False))
    persist: Callable[..., Any] = (lambda *a, **k: None) if ephemeral else upsert_chat
    if not chat_id:
        chat_id = secrets.token_hex(12)

    existing, read_failed = None, False
    try:
        existing = await asyncio.to_thread(get_chat, user_id, chat_id)
    except Exception:                                           # noqa: BLE001
        read_failed = True
        logger.warning("[image] lecture du chat %s échouée", chat_id[:12], exc_info=True)
    if read_failed and not ephemeral:
        # Sans l'état lu, l'écriture effacerait l'état de compaction du chat.
        raise HTTPException(503, "Conversation momentanément illisible : réessayez.")

    base: Dict[str, Any] = {
        "updated_at": (existing or {}).get("updated_at"),
        "messages": (existing or {}).get("messages"),
        "title": ((existing or {}).get("title") or "").strip(),
    }
    title_generated = not base["title"] or base["title"] == "Nouveau chat"
    title = (" ".join(prompt.split())[:28] or "Images") if title_generated else base["title"]

    request_fields = {"size": f"{req.width}x{req.height}", "n": req.n,
                      "seed": opts.get("seed"), "steps": opts.get("steps"),
                      "negative_prompt": opts.get("negative_prompt"),
                      "enhance": opts.get("enhance"), "strength": opts.get("strength"),
                      "ref_image_id": ref_id, "ratio": opts.get("ratio"),
                      "side": opts.get("side"), "model": model_name(cfg, caps)}
    msgs[-1]["image_request"] = sanitize_request(request_fields)
    carry = _compression_carry(existing)
    resumable = bool(data.get("resumable", False)) and not ephemeral
    run_id = secrets.token_hex(8)
    exec_id = f"image-{run_id}"

    passation: list = []
    fd = await _acquire_gen_presence(user_id, chat_id, waited_out=passation)
    lock_key = (user_id, str(chat_id))
    if passation and not ephemeral:
        try:
            with swallow("image.handover_rebaseline"):
                frais = await asyncio.to_thread(get_chat, user_id, chat_id)
                if frais and _handover_rebaseline_ok(base["messages"], frais.get("messages")):
                    base.update(updated_at=frais.get("updated_at"),
                                messages=frais.get("messages"),
                                title=(frais.get("title") or "").strip())
        except BaseException:
            if fd is not None:
                from shared_infra.runtime import chat_locks as _cl
                _cl.release(fd)
            raise
    if fd is not None:
        entry = (fd, time.monotonic())
        _pending_gen_locks[lock_key] = entry
        with swallow("image.pending_lock_watchdog"):
            asyncio.get_running_loop().call_later(
                _PENDING_GEN_LOCK_WATCHDOG_S, _release_unclaimed_gen_lock, lock_key, entry)
    if resumable and title_generated and existing:
        with swallow("image.early_title"):
            await asyncio.to_thread(set_title_if_default, user_id, chat_id, title)

    turn = _ImageTurn(user_id=user_id, chat_id=chat_id, cfg=cfg, caps=caps, req=req,
                      prompt=prompt, data=data, msgs=msgs, raw_count=len(raw_messages),
                      persist=persist, ephemeral=ephemeral, resumable=resumable,
                      run_id=run_id, exec_id=exec_id, title=title,
                      title_generated=title_generated, base=base, carry=carry,
                      enhance_target=enhance_target)
    return StreamingResponse(turn.stream(), media_type="application/x-ndjson; charset=utf-8")


class _ImageTurn:
    """Un tour « Images » : worker (génération, persistance, ``final``) et
    générateur NDJSON qui draine sa file."""

    def __init__(self, *, user_id: int, chat_id: str, cfg: Dict[str, Any],
                 caps: Dict[str, Any], req: Any, prompt: str, data: Dict[str, Any],
                 msgs: List[Dict[str, Any]], raw_count: int, persist: Callable[..., Any],
                 ephemeral: bool, resumable: bool, run_id: str, exec_id: str, title: str,
                 title_generated: bool, base: Dict[str, Any], carry: List[Dict[str, Any]],
                 enhance_target: Any) -> None:
        self.user_id, self.chat_id = user_id, chat_id
        self.cfg, self.caps, self.req, self.prompt = cfg, caps, req, prompt
        self.data, self.msgs, self.raw_count = data, msgs, raw_count
        self.persist, self.ephemeral, self.resumable = persist, ephemeral, resumable
        self.run_id, self.exec_id = run_id, exec_id
        self.title, self.title_generated = title, title_generated
        self.base, self.carry, self.enhance_target = base, carry, enhance_target
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_MAX)
        self.detached = False
        self.journal: Any = None
        self.tracker = ProgressTracker(req)

    # ── Événements ────────────────────────────────────────────────────────
    async def emit(self, ev: Dict[str, Any]) -> None:
        if self.journal is not None:
            # L'aperçu (image intermédiaire) ne va pas au journal : il pèse,
            # et un rejeu n'en a que faire.
            self.journal.append({k: v for k, v in ev.items() if k != "preview"})
            if ev.get("type") == "final":
                j, self.journal = self.journal, None
                statut = "cancelled" if ev.get("cancelled") else (
                    "error" if ev.get("image_error") else "done")
                keep(asyncio.create_task(j.close(statut)))
        if self.detached:
            return
        if ev.get("type") == "image_progress" and self.queue.full():
            return                               # avancée périmée : le client lent la perd
        await self.queue.put(ev)

    async def _progress(self, state: str, qp: Optional[int] = None,
                        info: Optional[Dict[str, Any]] = None) -> None:
        await self.emit(self.tracker.event())

    # ── Persistance ───────────────────────────────────────────────────────
    def _write(self, full: List[Dict[str, Any]]):
        if self.carry:
            from llm_core.conversation_compressor import _strip_summary_messages
            full = self.carry + _strip_summary_messages(full)
        return _persist_turn(self.persist, self.user_id, self.chat_id, self.title, full,
                             baseline_updated_at=self.base["updated_at"],
                             baseline_messages=self.base["messages"],
                             baseline_title=self.base["title"])

    async def _persist_question(self) -> None:
        if self.ephemeral:
            return
        with swallow("image.persist_question"):
            (ok, _t) = await asyncio.to_thread(self._write, list(self.msgs))
            if ok is not False:
                frais = await asyncio.to_thread(get_chat, self.user_id, self.chat_id)
                self.base.update(updated_at=(frais or {}).get("updated_at"),
                                 messages=(frais or {}).get("messages"), title=self.title)

    # ── Worker ────────────────────────────────────────────────────────────
    async def worker(self) -> None:
        from shared_infra.observability.runs import run_scope
        try:
            async with run_scope("image", run_id=self.exec_id, user_id=self.user_id,
                                 chat_id=self.chat_id, model=model_name(self.cfg, self.caps),
                                 engine=self.cfg["provider"], sample_sandbox=False) as run:
                statut, kind = await self._body()
                run.finish(statut, error_kind=kind)
        finally:
            # Sortie sans ``final`` (exception hors du corps) : le journal est
            # fermé quand même, sinon un client rattaché attendrait sans fin.
            if self.journal is not None:
                j, self.journal = self.journal, None
                with swallow("image.run_journal.close"):
                    await asyncio.shield(j.close("error"))

    async def _body(self) -> "tuple[str, str]":
        clear_chat_cancellation(self.user_id, self.chat_id)
        await self._persist_question()
        await self.emit({"type": "mode", "kind": "image", "text": "Génération d'image…"})
        await self.emit(self.tracker.event())
        refs: List[Dict[str, Any]] = []
        meta: Dict[str, Any] = {}
        err: Optional[ImageError] = None
        revised = ""
        try:
            if self.enhance_target is not None:
                revised = await self._enhance()
            refs, meta = await generate_and_store(
                self.cfg, self.req, user_id=self.user_id,
                chat_id=None if self.ephemeral else self.chat_id, prompt=self.prompt,
                caps=self.caps, on_progress=self._progress,
                cancelled=lambda: is_chat_cancelled(self.user_id, self.chat_id),
                tracker=self.tracker, extra={"revised_prompt": revised} if revised else None)
            logger.info("[image] user=%s chat=%s : %d image(s) en %.1f s", self.user_id,
                        self.chat_id[:12], len(refs), time.monotonic() - self.tracker.t0)
        except asyncio.CancelledError:
            # Stop (``task.cancel``) : on finit le tour pour dire qu'il est
            # arrêté et l'écrire ; la demande d'annulation est consommée.
            t = asyncio.current_task()
            if t is not None and hasattr(t, "uncancel"):
                t.uncancel()
            err = ImageError(_STOPPED, code="cancelled")
        except ImageError as exc:
            if exc.detail:
                logger.warning("[image] %s — %s", exc.message, exc.detail)
            err = ImageError(_STOPPED, code="cancelled") if exc.code == "cancelled" else exc
        except Exception:                                       # noqa: BLE001
            logger.exception("[image] génération : erreur inattendue")
            err = ImageError("Erreur interne de génération.", code="engine")
        if refs:
            await self.emit({"type": "image", "items": refs, "prompt": self.prompt})
        if err is not None:
            await self.emit({"type": "image_error", **err.payload()})
        assistant: Dict[str, Any] = {"role": "assistant", "run_ids": [self.exec_id]}
        if refs:
            assistant.update(content=caption(self.prompt, len(refs)), generated_images=refs,
                             image_meta=meta)
            if revised:
                assistant["revised_prompt"] = revised
        else:
            if err is None:
                err = ImageError("Le moteur n'a renvoyé aucune image.", code="engine")
            assistant.update(content=("[Génération d'image arrêtée]" if err.code == "cancelled"
                                      else failure_caption(err.message)),
                             image_error=err.payload())
        persisted, persist_error = await self._persist_answer(assistant)
        final: Dict[str, Any] = {
            "type": "final", "assistant": assistant["content"], "chat_id": self.chat_id,
            "run_ids": [self.exec_id], "generated_images": refs, "image": True,
            "revised_prompt": revised, "image_meta": meta, "persisted": persisted,
            "metrics": {"model": meta.get("model") or model_name(self.cfg, self.caps),
                        "duration_s": meta.get("duration_s")},
        }
        if err is not None:
            final["image_error"] = err.payload()
            if err.code == "cancelled":
                final["cancelled"] = True
        if persist_error:
            final["persist_error"] = persist_error
        if self.title_generated:
            final["title"] = self.title
        await self.emit(final)
        if refs or err is None:
            return "ok", ""
        statut = {"cancelled": "cancelled", "timeout": "timeout"}.get(err.code, "error")
        return statut, err.code

    async def _enhance(self) -> str:
        from llm_core._target import use_llm_target
        from llm_core.imagegen.enhance import enhance_prompt
        self.tracker.update("enhancing")
        await self.emit(self.tracker.event())
        with use_llm_target(self.enhance_target):
            revised, why = await enhance_prompt(self.prompt, model=self.data.get("model") or None,
                                                chat_id=self.chat_id)
        self.tracker.update("queued")
        if revised:
            self.req.prompt = revised
            await self.emit({"type": "image_prompt", "text": revised})
            return revised
        await self.emit({"type": "info",
                         "text": f"Description non enrichie ({why}) : envoyée telle quelle."})
        return ""

    async def _persist_answer(self, assistant: Dict[str, Any]) -> "tuple[bool, str]":
        if self.ephemeral:
            return True, ""
        try:
            (ret, _titre), _stop = await _attendre_hors_annulation(asyncio.ensure_future(
                asyncio.to_thread(self._write, list(self.msgs) + [assistant])))
        except Exception:                                       # noqa: BLE001
            logger.warning("[image] persistance échouée chat=%s", self.chat_id[:12],
                           exc_info=True)
            return False, "db"
        if ret is False:
            return False, "conflict"
        with swallow("image.recent_cap"):
            await asyncio.to_thread(enforce_recent_chats_cap, self.user_id)
        return True, ""

    # ── Flux ──────────────────────────────────────────────────────────────
    async def _open_journal(self) -> None:
        if not self.resumable:
            return
        with swallow("image.run_journal.open"):
            from shared_infra.runtime.run_journal import RunJournal
            meta = {"engine_key": "image", "model": model_name(self.cfg, self.caps),
                    "is_continue": False, "base_count": self.raw_count,
                    "user_message": self.prompt[:20000],
                    "image_request": self.msgs[-1].get("image_request") or {}}
            j = RunJournal(self.user_id, self.chat_id, self.run_id, meta=meta)
            if await j.open(dict(meta, chat_id=self.chat_id)):
                self.journal = j

    async def stream(self):
        """Générateur NDJSON : réclame le verrou réservé, lance le worker,
        draine sa file ; à la fermeture, détache le run ou attend sa fin."""
        claimed = _pending_gen_locks.pop((self.user_id, str(self.chat_id)), None)
        try:
            await self._open_journal()
        except BaseException:
            if claimed:
                with swallow("image.release_claimed"):
                    from shared_infra.runtime import chat_locks as _cl
                    _cl.release(claimed[0])
            raise
        task = keep(asyncio.create_task(self.worker()))
        register_chat_task(self.user_id, task, self.chat_id,
                           presence_fd=(claimed[0] if claimed else None))
        getter: Optional[asyncio.Future] = None
        saw_final = False
        try:
            while True:
                getter = asyncio.ensure_future(self.queue.get())
                done, _ = await asyncio.wait({getter, task}, timeout=_PING_S,
                                             return_when=asyncio.FIRST_COMPLETED)
                if not done:
                    getter.cancel()
                    getter = None
                    yield _ndjson_line({"type": "ping"})
                    continue
                if getter in done:
                    ev = getter.result()
                    getter = None
                    yield _ndjson_line(ev)
                    if ev.get("type") == "final":
                        saw_final = True
                        break
                    continue
                getter.cancel()
                getter = None
                while not self.queue.empty():
                    ev = self.queue.get_nowait()
                    saw_final = saw_final or ev.get("type") == "final"
                    yield _ndjson_line(ev)
                if not saw_final:
                    # Worker mort sans ``final`` : le dire, sinon le client
                    # voit une fin de flux propre et n'affiche rien.
                    yield _ndjson_line({"type": "image_error", "code": "engine",
                                        "message": "Génération d'image interrompue.",
                                        "retryable": True})
                break
        finally:
            if getter is not None and not getter.done():
                getter.cancel()
            if not task.done() and is_chat_cancelled(self.user_id, self.chat_id):
                # Stop : ``/api/chat/cancel`` a déjà annulé la tâche (ou posé le
                # drapeau que le moteur consulte). Pas de second ``cancel()`` :
                # il couperait l'annulation du job distant et l'écriture du
                # tour arrêté. On attend sa fin, bornée.
                with swallow("image.cancel_wait"):
                    await asyncio.wait_for(asyncio.shield(task), timeout=15.0)
            if task.done():
                unregister_chat_task(self.user_id, self.chat_id, task)
            else:
                # Client parti : le tour finit seul et persiste. Détacher ET
                # vider la file, sinon ``emit`` bloquerait sur une file pleine
                # et le verrou du chat ne serait jamais rendu.
                self.detached = True
                while not self.queue.empty():
                    self.queue.get_nowait()
                task.add_done_callback(
                    lambda _t: unregister_chat_task(self.user_id, self.chat_id, task))
