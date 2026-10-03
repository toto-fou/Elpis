# SPDX-License-Identifier: MIT
"""Magasin des images générées — fichiers par compte + table ``generated_images``.

Règles :
  * un fichier par image sous ``<dossier de la base>/generated_images/<uid>/``,
    nommé par son id (uuid4 hex) — rien ne vient du client ; la ligne garde le
    chemin RELATIF à cette racine (une restauration ailleurs reste lisible) ;
  * une vignette WebP (``THUMB_SIDE`` px au plus) à côté, pour la grille et la
    galerie ; le fichier plein sert la visionneuse et le téléchargement ;
  * chaque lecture filtre par ``user_id`` : l'image d'un autre compte n'existe
    pas (404, sans oracle) ;
  * rétention glissante : après insertion, seules les ``keep`` plus récentes du
    compte restent ; lignes purgées dans la MÊME transaction, fichiers effacés
    après le commit (un fichier orphelin vaut mieux qu'une ligne qui pointe
    dans le vide, et le balayage le rattrape) ;
  * mesure de durée : la première image d'un lot porte ``duration_s`` (calcul
    du lot) ; toutes portent ``megapixels`` du lot entier et ``steps`` — base
    de l'estimation des générations suivantes (:func:`recent_timings`).

La racine suit ``DB_PATH`` à chaque appel (jamais figée à l'import) : les tests
et un ``APP_DB_PATH`` déplacé la redirigent.
"""
from __future__ import annotations

import io
import json
import logging
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from shared_infra.db import _connection
from shared_infra.db._connection import db_conn
from shared_infra.db._dialect import no_limit

logger = logging.getLogger("uvicorn.error")

_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
_ID_RE = re.compile(r"^[0-9a-f]{32}$")
THUMB_SIDE = 384
#: Une image d'une conversation que la base ne connaît pas (encore) n'est
#: ramassée qu'au-delà de ce délai : la question d'un chat neuf peut être
#: écrite après l'image.
ORPHAN_GRACE_S = 60.0
#: Fichier sans ligne : ramassé au-delà de ce délai (écriture en cours sinon).
_FILE_GRACE_S = 3600.0
_COLONNES = ("id, user_id, chat_id, prompt, params_json, model, mime, width, height, "
             "bytes, rel_path, thumb_rel_path, steps, megapixels, duration_s, created_at")


def valid_id(image_id: Any) -> bool:
    return isinstance(image_id, str) and bool(_ID_RE.match(image_id))


def url_for(image_id: str, *, thumb: bool = False) -> str:
    return f"/api/images/{image_id}" + ("?thumb=1" if thumb else "")


def root() -> Path:
    """Racine du magasin, à côté de la base."""
    return Path(_connection.DB_PATH).parent / "generated_images"


def _abs(rel: str) -> Optional[Path]:
    """Chemin absolu d'un chemin relatif s'il reste sous la racine."""
    if not rel:
        return None
    base = root().resolve()
    try:
        p = (base / rel).resolve()
        p.relative_to(base)
    except (OSError, ValueError):
        return None
    return p


def _unlink(rels: Iterable[str]) -> None:
    for rel in rels:
        if not rel:
            continue
        p = _abs(rel)
        if p is None:
            logger.warning("[image] chemin hors magasin ignoré : %s", rel)
            continue
        try:
            p.unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("[image] effacement de %s impossible : %s", p, exc)


def _thumbnail(data: bytes) -> Optional[bytes]:
    """Vignette WebP, ou ``None`` si l'image ne se décode pas."""
    try:
        from PIL import Image
        with Image.open(io.BytesIO(data)) as src:
            if src.format == "JPEG":
                src.draft("RGB", (THUMB_SIDE, THUMB_SIDE))
            im = src.convert("RGBA" if src.mode in ("RGBA", "LA", "P") else "RGB")
            im.thumbnail((THUMB_SIDE, THUMB_SIDE))
            buf = io.BytesIO()
            im.save(buf, "WEBP", quality=80, method=4)
            return buf.getvalue()
    except Exception:                                           # noqa: BLE001
        logger.info("[image] vignette impossible", exc_info=True)
        return None


def _write(path: Path, data: bytes) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def ref_for(row: Dict[str, Any]) -> Dict[str, Any]:
    """Référence d'image portée par un message : jamais d'URL arbitraire."""
    params = row.get("params") if isinstance(row.get("params"), dict) else None
    if params is None:
        try:
            params = json.loads(row.get("params_json") or "{}")
        except ValueError:
            params = {}
    ref = {"id": row["id"], "url": url_for(row["id"]),
           "thumb_url": url_for(row["id"], thumb=True),
           "width": int(row["width"]), "height": int(row["height"]), "mime": row["mime"]}
    if isinstance(params.get("seed"), int):
        ref["seed"] = params["seed"]
    return ref


def save_images(user_id: int, chat_id: Optional[str], prompt: str, *, model: str,
                params: Dict[str, Any], results: Sequence[Any], keep: int,
                steps: int = 0, duration_s: Optional[float] = None) -> List[Dict[str, Any]]:
    """Écrit les images d'un lot, les inscrit, applique la rétention. Rend les
    références à mettre dans le message (cf. :func:`ref_for`)."""
    uid = int(user_id)
    d = root() / str(uid)
    d.mkdir(parents=True, exist_ok=True)
    now = time.time()
    batch_mp = round(sum(int(r.width) * int(r.height) for r in results) / 1e6, 4)
    rows: List[tuple] = []
    refs: List[Dict[str, Any]] = []
    written: List[str] = []
    old: list = []
    try:
        for i, res in enumerate(results):
            image_id = uuid.uuid4().hex
            rel = f"{uid}/{image_id}.{_EXT.get(res.mime, 'png')}"
            _write(root() / rel, res.data)
            written.append(rel)
            thumb_rel = ""
            thumb = _thumbnail(res.data)
            if thumb:
                thumb_rel = f"{uid}/{image_id}.thumb.webp"
                _write(root() / thumb_rel, thumb)
                written.append(thumb_rel)
            p = dict(params)
            if res.seed is not None:
                p["seed"] = res.seed
            if getattr(res, "revised_prompt", ""):
                p["revised_prompt"] = res.revised_prompt
            row = {"id": image_id, "width": res.width, "height": res.height,
                   "mime": res.mime, "params": p}
            refs.append(ref_for(row))
            # ``now + i * 1e-6`` : ordre stable dans un lot pour la rétention.
            rows.append((image_id, uid, chat_id, prompt or "", json.dumps(p, ensure_ascii=False),
                         model or "", res.mime, int(res.width), int(res.height), len(res.data),
                         rel, thumb_rel, int(steps or 0), batch_mp,
                         duration_s if i == 0 else None, now + i * 1e-6))
        with db_conn() as conn:
            conn.executemany(
                f"INSERT INTO generated_images ({_COLONNES}) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
            old = list(conn.execute(
                "SELECT id, rel_path, thumb_rel_path FROM generated_images WHERE user_id=? "
                f"ORDER BY created_at DESC LIMIT {no_limit()} OFFSET ?",
                (uid, max(1, int(keep)))).fetchall())
            # Conversations supprimées par un chemin qui n'a pas nettoyé
            # (ancienne version, panne entre les deux écritures) : passé le
            # délai de grâce seulement.
            old += list(conn.execute(
                "SELECT id, rel_path, thumb_rel_path FROM generated_images g "
                "WHERE user_id=? AND chat_id IS NOT NULL AND created_at < ? AND NOT EXISTS "
                "(SELECT 1 FROM chats c WHERE c.id=g.chat_id AND c.user_id=g.user_id)",
                (uid, now - ORPHAN_GRACE_S)).fetchall())
            if old:
                conn.executemany("DELETE FROM generated_images WHERE id=?",
                                 [(r["id"],) for r in old])
            conn.commit()
    except BaseException:
        _unlink(written)
        raise
    _unlink(rel for r in old for rel in (r["rel_path"], r["thumb_rel_path"]))
    return refs


def _row(user_id: int, image_id: str) -> Optional[Dict[str, Any]]:
    if not valid_id(image_id):
        return None
    with db_conn() as conn:
        row = conn.execute(f"SELECT {_COLONNES} FROM generated_images WHERE id=? AND user_id=?",
                           (image_id, int(user_id))).fetchone()
    return dict(row) if row else None


def get_image(user_id: int, image_id: str) -> Optional[Dict[str, Any]]:
    """La ligne si elle appartient au compte ET si son fichier existe, avec
    ``path`` (absolu) et ``thumb_path`` (absolu, ou ``None``)."""
    row = _row(user_id, image_id)
    if not row:
        return None
    p = _abs(row["rel_path"])
    if p is None or not p.is_file():
        return None
    t = _abs(row.get("thumb_rel_path") or "")
    row["path"] = str(p)
    row["thumb_path"] = str(t) if t is not None and t.is_file() else None
    return row


def read_bytes(user_id: int, image_id: str) -> Optional[bytes]:
    """Octets d'une image du compte (édition à partir d'une image générée)."""
    row = get_image(user_id, image_id)
    if not row:
        return None
    with open(row["path"], "rb") as fh:
        return fh.read()


def delete_image(user_id: int, image_id: str) -> bool:
    row = _row(user_id, image_id)
    if not row:
        return False
    with db_conn() as conn:
        cur = conn.execute("DELETE FROM generated_images WHERE id=? AND user_id=?",
                           (image_id, int(user_id)))
        conn.commit()
        deleted = cur.rowcount > 0
    _unlink([row["rel_path"], row.get("thumb_rel_path") or ""])
    return deleted


def delete_for_chats(user_id: int, chat_ids: Iterable[str]) -> int:
    """Efface les images de conversations supprimées."""
    ids = [str(c) for c in chat_ids if c]
    if not ids:
        return 0
    rels: List[str] = []
    n = 0
    with db_conn() as conn:
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            ph = ",".join("?" * len(chunk))
            rows = conn.execute(
                "SELECT rel_path, thumb_rel_path FROM generated_images "
                f"WHERE user_id=? AND chat_id IN ({ph})", (int(user_id), *chunk)).fetchall()
            rels += [x for r in rows for x in (r["rel_path"], r["thumb_rel_path"])]
            conn.execute(f"DELETE FROM generated_images WHERE user_id=? AND chat_id IN ({ph})",
                         (int(user_id), *chunk))
            n += len(rows)
        conn.commit()
    _unlink(rels)
    return n


def delete_user_dir(user_id: int) -> None:
    """Dossier d'un compte supprimé (les lignes partent avec le compte)."""
    p = _abs(str(int(user_id)))
    if p is not None and p.is_dir():
        shutil.rmtree(p, ignore_errors=True)


def list_images(user_id: int, *, before: Optional[float] = None, limit: int = 50,
                chat_id: Optional[str] = None) -> Tuple[List[Dict[str, Any]], Optional[float], int]:
    """Galerie : ``(images, curseur suivant, total du compte)``, plus récentes
    d'abord. Le curseur est le ``created_at`` de la dernière image rendue."""
    limit = max(1, min(int(limit), 100))
    where: List[str] = ["user_id=?"]
    params: List[Any] = [int(user_id)]
    if chat_id:
        where.append("chat_id=?")
        params.append(str(chat_id))
    if before is not None:
        where.append("created_at < ?")
        params.append(float(before))
    with db_conn() as conn:
        rows = conn.execute(
            f"SELECT {_COLONNES} FROM generated_images WHERE {' AND '.join(where)} "
            "ORDER BY created_at DESC LIMIT ?", (*params, limit + 1)).fetchall()
        total = int(conn.execute("SELECT COUNT(*) FROM generated_images WHERE user_id=?",
                                 (int(user_id),)).fetchone()[0] or 0)
    rows = [dict(r) for r in rows]
    more = len(rows) > limit
    rows = rows[:limit]
    items = []
    for r in rows:
        ref = ref_for(r)
        try:
            p = json.loads(r.get("params_json") or "{}")
        except ValueError:
            p = {}
        ref.update(chat_id=r.get("chat_id") or None, prompt=r.get("prompt") or "",
                   model=r.get("model") or "", created_at=float(r["created_at"]))
        if p.get("revised_prompt"):
            ref["revised_prompt"] = p["revised_prompt"]
        items.append(ref)
    return items, (float(rows[-1]["created_at"]) if more and rows else None), total


def count_for_user(user_id: int) -> int:
    with db_conn() as conn:
        row = conn.execute("SELECT COUNT(*) FROM generated_images WHERE user_id=?",
                           (int(user_id),)).fetchone()
    return int(row[0] or 0)


def recent_timings(model: str, steps: int, limit: int = 20) -> List[Tuple[float, float]]:
    """``[(secondes de calcul, mégapixels du lot)]`` des derniers lots du même
    modèle à ce nombre d'étapes, tous comptes confondus (durées seulement,
    rien de personnel)."""
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT duration_s, megapixels FROM generated_images "
            "WHERE model=? AND steps=? AND duration_s IS NOT NULL AND megapixels > 0 "
            "ORDER BY created_at DESC LIMIT ?",
            (model or "", int(steps or 0), int(limit))).fetchall()
    return [(float(r["duration_s"]), float(r["megapixels"])) for r in rows
            if r["duration_s"] and float(r["duration_s"]) > 0]


def sweep_orphans(now: Optional[float] = None) -> int:
    """Entretien : lignes de conversations disparues, fichiers sans ligne,
    dossiers de comptes supprimés. Rend le nombre d'éléments retirés."""
    now = time.time() if now is None else now
    n = 0
    with db_conn() as conn:
        old = conn.execute(
            "SELECT id, rel_path, thumb_rel_path FROM generated_images g "
            "WHERE chat_id IS NOT NULL AND created_at < ? AND NOT EXISTS "
            "(SELECT 1 FROM chats c WHERE c.id=g.chat_id AND c.user_id=g.user_id)",
            (now - ORPHAN_GRACE_S,)).fetchall()
        if old:
            conn.executemany("DELETE FROM generated_images WHERE id=?", [(r["id"],) for r in old])
            conn.commit()
        known = {x for r in conn.execute(
            "SELECT rel_path, thumb_rel_path FROM generated_images").fetchall()
            for x in (r["rel_path"], r["thumb_rel_path"]) if x}
        users = {int(r[0]) for r in conn.execute("SELECT id FROM users").fetchall()}
    _unlink(rel for r in old for rel in (r["rel_path"], r["thumb_rel_path"]))
    n += len(old)
    base = root()
    if not base.is_dir():
        return n
    for d in base.iterdir():
        if not d.is_dir() or not d.name.isdigit():
            continue
        if int(d.name) not in users:
            shutil.rmtree(d, ignore_errors=True)
            n += 1
            continue
        for f in d.iterdir():
            rel = f"{d.name}/{f.name}"
            try:
                if rel not in known and f.is_file() and now - f.stat().st_mtime > _FILE_GRACE_S:
                    f.unlink()
                    n += 1
            except OSError:
                continue
    return n
