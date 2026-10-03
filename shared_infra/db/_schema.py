# SPDX-License-Identifier: MIT
"""
shared_infra.db._schema — le schéma de référence de la base, déclaré UNE fois
et rendu pour chaque moteur (SQLite, PostgreSQL, MariaDB/MySQL).

Avant (jusqu'au 2026-09-26), le schéma vivait à deux endroits : des
``CREATE TABLE IF NOT EXISTS`` éparpillés (``init_db`` et six ``init_*_db``,
mais aussi la page Code, la mémoire AX, les terminaux) et 21 migrations.
Impossible, dans ces conditions, de créer la même base dans un autre moteur.

Ici, chaque table est décrite par des objets (``Table``, ``Col``, ``Index``,
``FK``) avec un petit vocabulaire de types :

    ID    clé entière auto-incrémentée    INTEGER PRIMARY KEY AUTOINCREMENT
    INT   entier (64 bits partout)        INTEGER / BIGINT
    REAL  flottant (horodatages epoch)    REAL / DOUBLE PRECISION / DOUBLE
    TEXT  texte                           TEXT / TEXT / LONGTEXT, ou
                                          VARCHAR(n) en MySQL quand la colonne
                                          sert de clé ou d'index (``key=n``,
                                          191 par défaut)

Le rendu SQLite reproduit EXACTEMENT le schéma historique (même types
déclarés, défauts, contraintes, index) : c'est ce que vérifie
``tests/db/test_schema_reference_2026_09_26.py`` contre un instantané du
schéma pris avant la bascule. Les familles de l'application ne portent plus
de DDL : elles demandent leurs tables à ce module (``ensure_tables``).

Une base NEUVE est créée d'un coup (``create_all``) et les migrations que ce
schéma contient déjà sont TAMPONNÉES (``BASELINE_COVERS``) au lieu d'être
rejouées ; une base existante continue sa chaîne de migrations.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Tuple

from shared_infra.db._dialect import (
    MYSQL,
    POSTGRES,
    SQLITE,
    dialect_of,
    table_columns,
    table_names,
)

log = logging.getLogger("uvicorn.error")

ID = "id"
INT = "int"
REAL = "real"
TEXT = "text"
TEXT_CI = "text_ci"          # MySQL : collation insensible (plein texte) ; TEXT ailleurs


class _Null:
    """Défaut explicite ``DEFAULT NULL`` (distinct d'une absence de défaut)."""
    def __repr__(self) -> str:          # pragma: no cover — affichage
        return "NULL"


NULL = _Null()
_NO_DEFAULT = object()


@dataclass(frozen=True)
class Col:
    name: str
    type: str
    null: bool = True
    default: Any = _NO_DEFAULT
    primary: bool = False
    unique: bool = False
    check: Optional[str] = None
    key: Optional[int] = None                 # longueur VARCHAR en MySQL
    types: Optional[Dict[str, str]] = None    # type propre à un moteur


@dataclass(frozen=True)
class FK:
    cols: Tuple[str, ...]
    table: str
    ref_cols: Tuple[str, ...]
    on_delete: Optional[str] = None


@dataclass(frozen=True)
class Index:
    name: str
    cols: Tuple[str, ...]                     # « col » ou « col DESC »
    unique: bool = False
    where: Optional[str] = None               # index partiel (SQLite, PG)


@dataclass(frozen=True)
class Table:
    name: str
    cols: List[Col]
    pk: Tuple[str, ...] = ()
    unique: List[Tuple[str, ...]] = field(default_factory=list)
    fks: List[FK] = field(default_factory=list)
    indexes: List[Index] = field(default_factory=list)
    only: Optional[Tuple[str, ...]] = None        # moteurs concernés (None = tous)

    def col(self, name: str) -> Col:
        for c in self.cols:
            if c.name == name:
                return c
        raise KeyError(f"{self.name}.{name}")


# ─────────────────────────────────────────────────────────────────────────────
#  Rendu
# ─────────────────────────────────────────────────────────────────────────────

def q(name: str) -> str:
    """Identifiant cité — ``groups``, ``key`` ou ``trigger`` sont des mots
    réservés en MySQL 8 ; la citation est neutre ailleurs."""
    return '"' + name.replace('"', '""') + '"'


def _q_mysql(name: str) -> str:
    return "`" + name.replace("`", "``") + "`"


def _literal(v: Any) -> str:
    if v is NULL:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def _keyed_columns(t: Table) -> set:
    """Colonnes texte qui servent de clé ou d'index : VARCHAR en MySQL."""
    keyed = set(t.pk)
    for c in t.cols:
        if c.primary or c.unique:
            keyed.add(c.name)
    for u in t.unique:
        keyed.update(u)
    for ix in t.indexes:
        keyed.update(part.split()[0] for part in ix.cols)
    for fk in t.fks:
        keyed.update(fk.cols)
    return keyed


def _col_type(t: Table, c: Col, dialect: str) -> str:
    typ = (c.types or {}).get(dialect, c.type)
    if typ == TEXT_CI:
        # Texte à collation insensible à la casse ET aux accents (index
        # FULLTEXT de MySQL/MariaDB, qui suit la collation de la colonne).
        if dialect == MYSQL:
            return "LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
        typ = TEXT
    if dialect == SQLITE:
        return {INT: "INTEGER", REAL: "REAL", TEXT: "TEXT"}[typ]
    if dialect == POSTGRES:
        return {INT: "BIGINT", REAL: "DOUBLE PRECISION", TEXT: "TEXT"}[typ]
    if typ == TEXT:
        if c.name in _keyed_columns(t):
            return f"VARCHAR({c.key or 191})"
        return "LONGTEXT"
    return {INT: "BIGINT", REAL: "DOUBLE"}[typ]


def _col_sql(t: Table, c: Col, dialect: str) -> str:
    qn = _q_mysql if dialect == MYSQL else q
    if c.type == ID:
        if dialect == SQLITE:
            return f"{qn(c.name)} INTEGER PRIMARY KEY AUTOINCREMENT"
        if dialect == POSTGRES:
            return f"{qn(c.name)} BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY"
        return f"{qn(c.name)} BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY"
    typ = _col_type(t, c, dialect)
    parts = [qn(c.name), typ]
    if c.primary:
        parts.append("PRIMARY KEY")
    if c.unique:
        parts.append("UNIQUE")
    if not c.null:
        parts.append("NOT NULL")
    if c.default is not _NO_DEFAULT:
        lit = _literal(c.default)
        if dialect == MYSQL and typ == "LONGTEXT" and c.default is not NULL:
            lit = f"({lit})"                 # défaut d'expression (MySQL ≥ 8.0.13)
        parts.append(f"DEFAULT {lit}")
    if c.check:
        parts.append(f"CHECK ({c.check})")
    return " ".join(parts)


def create_table_sql(t: Table, dialect: str = SQLITE) -> str:
    qn = _q_mysql if dialect == MYSQL else q
    lines = [_col_sql(t, c, dialect) for c in t.cols]
    if t.pk:
        lines.append(f"PRIMARY KEY ({', '.join(qn(c) for c in t.pk)})")
    for u in t.unique:
        lines.append(f"UNIQUE ({', '.join(qn(c) for c in u)})")
    for fk in t.fks:
        od = f" ON DELETE {fk.on_delete}" if fk.on_delete else ""
        lines.append(f"FOREIGN KEY ({', '.join(qn(c) for c in fk.cols)}) "
                     f"REFERENCES {qn(fk.table)}({', '.join(qn(c) for c in fk.ref_cols)}){od}")
    body = ",\n  ".join(lines)
    tail = ""
    if dialect == MYSQL:
        tail = " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin"
    return f"CREATE TABLE IF NOT EXISTS {qn(t.name)} (\n  {body}\n){tail}"


def create_index_sql(t: Table, ix: Index, dialect: str = SQLITE) -> str:
    qn = _q_mysql if dialect == MYSQL else q
    cols = []
    for part in ix.cols:
        name, *rest = part.split()
        cols.append(" ".join([qn(name)] + rest))
    uniq = "UNIQUE " if ix.unique else ""
    where = f" WHERE {ix.where}" if ix.where and dialect != MYSQL else ""
    if dialect == MYSQL:
        # Pas d'IF NOT EXISTS sur les index en MySQL : ``ensure_tables``
        # vérifie l'existence avant de créer.
        return f"CREATE {uniq}INDEX {qn(ix.name)} ON {qn(t.name)} ({', '.join(cols)})"
    return (f"CREATE {uniq}INDEX IF NOT EXISTS {qn(ix.name)} "
            f"ON {qn(t.name)} ({', '.join(cols)}){where}")

# ─────────────────────────────────────────────────────────────────────────────
#  Les tables — parents avant enfants (clés étrangères)
# ─────────────────────────────────────────────────────────────────────────────
#  Premier jet généré le 2026-09-26 depuis le schéma SQLite réel (base neuve
#  créée par le code d'alors), puis annoté. L'ordre des colonnes est celui de
#  SQLite (colonnes ajoutées après coup en fin de table).

TABLES: List[Table] = [
    Table('ax_credentials', [
        Col('owner', TEXT, null=False, default=''),
        Col('site', TEXT, null=False),
        Col('username', TEXT, null=False),
        Col('password', TEXT, null=False),
        Col('last_ok', REAL),
        Col('use_count', INT, null=False, default=1),
    ],
        pk=('owner', 'site'),
    ),
    Table('ax_nodes', [
        Col('id', ID),
        Col('site', TEXT, null=False),
        Col('path', TEXT, null=False, key=255),
        Col('parent_id', INT),
        Col('node_type', TEXT, null=False),
        Col('region_tag', TEXT),
        Col('role', TEXT, null=False),
        Col('name', TEXT, null=False),
        Col('node_key', TEXT, null=False),
        Col('verified_count', INT, null=False, default=0),
        Col('last_ok', REAL),
        Col('stale', INT, null=False, default=0),
        Col('stale_at', REAL),
    ],
        unique=[('site', 'path', 'parent_id', 'node_key')],
        fks=[FK(('parent_id',), 'ax_nodes', ('id',), on_delete='CASCADE')],
        indexes=[
            Index('idx_ax_nodes_parent', ('parent_id',)),
            Index('idx_ax_nodes_site_path', ('site', 'path', 'stale')),
        ],
    ),
    Table('ax_selectors', [
        Col('id', ID),
        Col('node_id', INT, null=False),
        Col('strategy', TEXT, null=False),
        Col('value', TEXT, null=False, key=300),   # tronqué à 300 par ax/actions.py
        Col('success_count', INT, null=False, default=0),
        Col('failure_count', INT, null=False, default=0),
        Col('last_ok', REAL),
        Col('last_fail', REAL),
    ],
        unique=[('node_id', 'strategy', 'value')],
        fks=[FK(('node_id',), 'ax_nodes', ('id',), on_delete='CASCADE')],
        indexes=[
            Index('idx_ax_sel_node', ('node_id',)),
        ],
    ),
    Table('ax_transitions', [
        Col('id', ID),
        Col('site', TEXT, null=False),
        Col('from_path', TEXT, null=False, key=255),
        Col('action_node_id', INT, null=False),
        Col('to_path', TEXT, null=False, key=255),
        Col('verified_count', INT, null=False, default=1),
        Col('last_ok', REAL),
    ],
        unique=[('site', 'from_path', 'action_node_id', 'to_path')],
        fks=[FK(('action_node_id',), 'ax_nodes', ('id',), on_delete='CASCADE')],
        indexes=[
            Index('idx_ax_trans_to', ('site', 'to_path')),
            Index('idx_ax_trans_from', ('site', 'from_path')),
        ],
    ),
    Table('users', [
        Col('id', ID),
        Col('username', TEXT, null=False, unique=True),
        Col('pass_salt', TEXT, null=False),
        Col('pass_hash', TEXT, null=False),
        Col('created_at', REAL, null=False),
        Col('is_admin', INT, default=0),
        Col('avatar', TEXT),
        Col('settings_json', TEXT),
        Col('must_change_pwd', INT, default=0),
        Col('session_min_ts', REAL, default=0),
    ],
    ),
    Table('chats', [
        Col('id', TEXT, primary=True),
        Col('user_id', INT, null=False),
        Col('title', TEXT, null=False),
        Col('messages_json', TEXT, null=False),
        Col('updated_at', REAL, null=False),
        Col('archived', INT, null=False, default=0),
        Col('archived_at', REAL),
        Col('meta_json', TEXT, null=False, default='{}'),
    ],
        fks=[FK(('user_id',), 'users', ('id',))],
        indexes=[
            Index('idx_chats_user_archived', ('user_id', 'archived', 'updated_at DESC')),
            Index('idx_chats_user_updated', ('user_id', 'updated_at DESC')),
        ],
    ),
    Table('code_clients', [
        Col('user_id', INT, null=False),
        Col('client_id', TEXT, null=False),
        Col('last_seen', REAL, null=False, default=0),
        Col('plugin_version', INT, null=False, default=1),
        Col('directory', TEXT, null=False, default=''),
        Col('bye', INT, null=False, default=0),
    ],
        pk=('user_id', 'client_id'),
    ),
    Table('code_commands', [
        Col('id', TEXT, primary=True),
        Col('user_id', INT, null=False),
        Col('session_id', TEXT, null=False, default=''),
        Col('kind', TEXT, null=False),
        Col('payload', TEXT, null=False, default='{}'),
        Col('created_at', REAL, null=False, default=0),
        Col('target', TEXT, null=False, default=''),
    ],
        indexes=[
            Index('idx_code_commands_user', ('user_id', 'created_at')),
        ],
    ),
    Table('code_messages', [
        Col('user_id', INT, null=False),
        Col('session_id', TEXT, null=False),
        Col('id', TEXT, null=False),
        Col('info', TEXT, null=False, default='{}'),
        Col('created', REAL, null=False, default=0),
    ],
        pk=('user_id', 'session_id', 'id'),
    ),
    Table('code_meta', [
        Col('user_id', INT, null=False),
        Col('key', TEXT, null=False),
        Col('value', TEXT, null=False),
    ],
        pk=('user_id', 'key'),
    ),
    Table('code_notes', [
        Col('user_id', INT, null=False),
        Col('session_id', TEXT, null=False),
        Col('id', TEXT, null=False),
        Col('kind', TEXT, null=False, default='command'),
        Col('label', TEXT, null=False, default=''),
        Col('detail', TEXT, null=False, default=''),
        Col('created', REAL, null=False, default=0),
    ],
        pk=('user_id', 'session_id', 'id'),
    ),
    Table('code_pairings', [
        Col('id', TEXT, primary=True),
        Col('code', TEXT, null=False),
        Col('ip', TEXT, null=False, default=''),
        Col('created_at', REAL, null=False),
        Col('expires_at', REAL, null=False),
        Col('confirmed_uid', INT),
        Col('token', TEXT),
    ],
    ),
    Table('code_parts', [
        Col('user_id', INT, null=False),
        Col('session_id', TEXT, null=False),
        Col('message_id', TEXT, null=False),
        Col('id', TEXT, null=False),
        Col('part', TEXT, null=False, default='{}'),
        Col('ts', REAL, null=False, default=0),
    ],
        pk=('user_id', 'session_id', 'message_id', 'id'),
    ),
    Table('code_permissions', [
        Col('user_id', INT, null=False),
        Col('session_id', TEXT, null=False),
        Col('id', TEXT, null=False),
        Col('info', TEXT, null=False, default='{}'),
        Col('created', REAL, null=False, default=0),
    ],
        pk=('user_id', 'session_id', 'id'),
    ),
    Table('code_questions', [
        Col('user_id', INT, null=False),
        Col('session_id', TEXT, null=False),
        Col('id', TEXT, null=False),
        Col('info', TEXT, null=False, default='{}'),
        Col('created', REAL, null=False, default=0),
    ],
        pk=('user_id', 'session_id', 'id'),
    ),
    Table('code_sessions', [
        Col('user_id', INT, null=False),
        Col('id', TEXT, null=False),
        Col('info', TEXT, null=False, default='{}'),
        Col('client_id', TEXT, null=False, default=''),
        Col('busy', INT, null=False, default=0),
        Col('updated_at', REAL, null=False, default=0),
        Col('last_model', TEXT, null=False, default=''),
        Col('preview', TEXT, null=False, default=''),
    ],
        pk=('user_id', 'id'),
    ),
    Table('daily_usage_reports', [
        Col('date', TEXT, primary=True),
        Col('payload_json', TEXT, null=False),
        Col('created_at', REAL, null=False),
    ],
        indexes=[
            Index('idx_daily_reports_created', ('created_at DESC',)),
        ],
    ),
    Table('editor_action_cache', [
        Col('scope', TEXT, null=False),
        Col('query_norm', TEXT, null=False, key=255),
        Col('auto_id', TEXT, null=False, default=''),
        Col('role', TEXT, null=False, default=''),
        Col('center_x', INT, default=NULL),
        Col('center_y', INT, default=NULL),
        Col('hits', INT, null=False, default=1),
        Col('updated_at', REAL, null=False),
    ],
        pk=('scope', 'query_norm'),
        indexes=[
            Index('idx_action_cache_age', ('updated_at',)),
        ],
    ),
    Table('editor_routines', [
        Col('id', ID),
        Col('owner_user_id', INT, null=False),
        Col('name', TEXT, null=False),
        Col('cron_expr', TEXT, null=False),
        Col('model', TEXT, default=NULL),
        Col('system_prompt', TEXT, null=False, default=''),
        Col('task_prompt', TEXT, null=False, default=''),
        Col('mcp_snapshot', TEXT, null=False, default='[]'),
        Col('skills', TEXT, null=False, default='[]'),
        Col('thinking_mode', INT, null=False, default=0),
        Col('enabled', INT, null=False, default=1),
        Col('created_at', REAL, null=False),
        Col('updated_at', REAL, null=False),
        Col('last_fire_minute', TEXT, default=NULL),
        Col('runs_keep', INT, null=False, default=0),
        Col('notify_on', TEXT, null=False, default='all'),
        Col('notify_keep', INT, null=False, default=0),
        Col('webhook_enabled', INT, null=False, default=0),
        Col('webhook_secret', TEXT, default=NULL),
        Col('webhook_filter', TEXT, null=False, default='{}'),
        Col('trigger_after_id', INT, default=NULL),
        Col('trigger_after_on', TEXT, null=False, default='ok'),
        Col('agents_enabled', INT, null=False, default=0),
        Col('connector_id', INT, default=NULL),
    ],
        fks=[FK(('owner_user_id',), 'users', ('id',), on_delete='CASCADE')],
        indexes=[
            Index('idx_editor_routines_enabled', ('enabled',), where='enabled=1'),
            Index('idx_editor_routines_owner', ('owner_user_id',)),
        ],
    ),
    Table('editor_routine_runs', [
        Col('id', ID),
        Col('routine_id', INT, null=False),
        Col('owner_user_id', INT, null=False),
        Col('status', TEXT, null=False, default='running'),
        Col('trigger', TEXT, null=False, default='schedule'),
        Col('started_at', REAL, null=False),
        Col('ended_at', REAL, default=NULL),
        Col('duration_ms', INT, default=NULL),
        Col('input_tokens', INT, default=NULL),
        Col('output_tokens', INT, default=NULL),
        Col('summary', TEXT, default=NULL),
        Col('error', TEXT, default=NULL),
        Col('tool_limit_reached', INT, null=False, default=0),
        Col('worker_boot_id', TEXT, default=NULL),
        Col('heartbeat_at', REAL, default=NULL),
        Col('files', TEXT, null=False, default='[]'),
    ],
        fks=[FK(('owner_user_id',), 'users', ('id',), on_delete='CASCADE'), FK(('routine_id',), 'editor_routines', ('id',), on_delete='CASCADE')],
        indexes=[
            Index('idx_editor_runs_running', ('owner_user_id', 'status'), where="status='running'"),
            Index('idx_editor_runs_routine', ('routine_id', 'started_at DESC')),
        ],
    ),
    Table('editor_webhook_deliveries', [
        Col('delivery_id', TEXT, null=False),
        Col('routine_id', INT, null=False),
        Col('received_at', REAL, null=False),
    ],
        pk=('delivery_id', 'routine_id'),
        indexes=[
            Index('idx_editor_webhook_deliveries_received', ('received_at',)),
        ],
    ),
    Table('git_connectors', [
        Col('id', ID),
        Col('owner_user_id', INT, null=False),
        Col('provider_type', TEXT, null=False),
        Col('host', TEXT, null=False),
        Col('api_base', TEXT, null=False, default=''),
        Col('label', TEXT, null=False, default=''),
        Col('username', TEXT, null=False, default=''),
        Col('token_enc', TEXT, null=False),
        Col('token_scheme', TEXT, null=False, default='plain'),
        Col('created_at', REAL, null=False),
        Col('updated_at', REAL, null=False),
        Col('last_used', REAL),
    ],
        fks=[FK(('owner_user_id',), 'users', ('id',), on_delete='CASCADE')],
        indexes=[
            Index('idx_gitconn_owner_host', ('owner_user_id', 'host')),
            Index('idx_gitconn_owner_host_label', ('owner_user_id', 'host', 'label'), unique=True),
        ],
    ),
    Table('groups', [
        Col('id', ID),
        Col('name', TEXT, null=False, unique=True),
        Col('description', TEXT),
        Col('created_at', REAL, null=False),
    ],
    ),
    Table('llm_calls', [
        Col('id', ID),
        Col('ts', REAL, null=False),
        Col('req_id', TEXT, default=NULL),
        Col('user_id', INT, default=NULL),
        Col('chat_id', TEXT, default=NULL),
        Col('model', TEXT, default=NULL),
        Col('path', TEXT, default=NULL),
        Col('status', TEXT, null=False, default='ok'),
        Col('finish_reason', TEXT, default=NULL),
        Col('prompt_tokens', INT, default=NULL),
        Col('completion_tokens', INT, default=NULL),
        Col('duration_ms', INT, default=NULL),
        Col('n_messages', INT, default=NULL),
        Col('n_tool_calls', INT, default=NULL),
        Col('request_json', TEXT, default=NULL),
        Col('response_json', TEXT, default=NULL),
        Col('error', TEXT, default=NULL),
    ],
        indexes=[
            Index('idx_llm_calls_status', ('status', 'ts DESC'), where="status != 'ok'"),
            Index('idx_llm_calls_user', ('user_id', 'ts DESC')),
            Index('idx_llm_calls_ts', ('ts DESC',)),
        ],
    ),
    Table('llm_connectors', [
        Col('id', ID),
        Col('owner_user_id', INT),
        Col('scope', TEXT, null=False, default='user'),
        Col('provider_type', TEXT, null=False),
        Col('wire', TEXT, null=False, default='openai'),
        Col('label', TEXT, null=False, default=''),
        Col('base_url', TEXT, null=False, default=''),
        Col('api_key_enc', TEXT, null=False, default=''),
        Col('key_scheme', TEXT, null=False, default='fernet'),
        Col('default_model', TEXT, null=False, default=''),
        Col('models_json', TEXT, null=False, default=''),
        Col('enabled', INT, null=False, default=1),
        Col('created_at', REAL, null=False),
        Col('updated_at', REAL, null=False),
        Col('last_used', REAL),
        Col('context_window', INT),
        Col('max_models', INT),
        Col('max_concurrency', INT),
    ],
        fks=[FK(('owner_user_id',), 'users', ('id',), on_delete='CASCADE')],
        indexes=[
            Index('idx_llmconn_scope', ('scope',)),
            Index('idx_llmconn_owner', ('owner_user_id',)),
        ],
    ),
    Table('llm_engine_policies', [
        Col('principal_type', TEXT, null=False, check="principal_type IN ('user', 'group')"),
        Col('principal_id', INT, null=False),
        Col('engine_keys', TEXT),
        Col('can_manage_models', INT),
        Col('updated_at', REAL, null=False),
    ],
        pk=('principal_type', 'principal_id'),
    ),
    Table('mcp_shared_servers', [
        Col('id', ID),
        Col('name', TEXT, null=False, default=''),
        Col('type', TEXT, null=False, default='sse'),
        Col('url', TEXT, null=False, default=''),
        Col('command', TEXT, null=False, default=''),
        Col('auth_mode', TEXT, null=False, default=''),
        Col('auth_user', TEXT, null=False, default=''),
        Col('auth_enc', TEXT, null=False, default=''),
        Col('key_scheme', TEXT, null=False, default='fernet'),
        Col('enabled', INT, null=False, default=1),
        Col('created_at', REAL, null=False),
        Col('updated_at', REAL, null=False),
        Col('headers_enc', TEXT, null=False, default=''),
        Col('env_enc', TEXT, null=False, default=''),
        Col('extra_scheme', TEXT, null=False, default='plain'),
    ],
        indexes=[
            Index('idx_mcpshared_enabled', ('enabled',)),
        ],
    ),
    Table('metric_events', [
        Col('id', ID),
        Col('event_type', TEXT, null=False),
        Col('value', REAL),
        Col('tags_json', TEXT),
        Col('created_at', REAL, null=False),
        Col('user_id', INT),
    ],
        indexes=[
            Index('idx_metrics_type_date', ('event_type', 'created_at DESC')),
        ],
    ),
    Table('notifications', [
        Col('id', ID),
        Col('owner_user_id', INT, null=False),
        Col('kind', TEXT, null=False),
        Col('title', TEXT, null=False),
        Col('body', TEXT, default=''),
        Col('ref_type', TEXT, default=''),
        # Entier (id de routine, date AAAAMMJJ) OU texte (doc_id OCR) : SQLite
        # accepte les deux ; ailleurs la colonne est texte, relue en entier
        # quand elle est numérique (cf. notifications/store.py).
        Col('ref_id', INT, types={"postgres": TEXT, "mysql": TEXT}),
        Col('read_at', REAL),
        Col('created_at', REAL, null=False),
    ],
        fks=[FK(('owner_user_id',), 'users', ('id',), on_delete='CASCADE')],
        indexes=[
            Index('idx_notif_user_unread', ('owner_user_id', 'read_at', 'created_at')),
        ],
    ),
    Table('prompt_templates', [
        Col('id', ID),
        Col('user_id', INT, null=False),
        Col('name', TEXT, null=False),
        Col('title', TEXT, null=False),
        Col('content', TEXT, null=False),
        Col('created_at', REAL, null=False),
        Col('updated_at', REAL, null=False),
    ],
        unique=[('user_id', 'name')],
        fks=[FK(('user_id',), 'users', ('id',), on_delete='CASCADE')],
        indexes=[
            Index('idx_prompt_templates_user', ('user_id',)),
        ],
    ),
    Table('revoked_sessions', [
        Col('sid', TEXT, primary=True),
        Col('user_id', INT),
        Col('revoked_at', REAL, null=False),
    ],
        indexes=[
            Index('idx_revoked_sessions_at', ('revoked_at',)),
        ],
    ),
    # Exécutions (L5.2, migration 0021) : une ligne par tour de chat, run de
    # routine, sous-agent ou compaction manuelle — ressources consommées et
    # issue (cf. shared_infra/observability/runs.py).
    Table('runs', [
        Col('id', TEXT, primary=True, key=64),
        Col('kind', TEXT, null=False, default='chat'),
        Col('user_id', INT),
        Col('chat_id', TEXT, null=False, default=''),
        Col('routine_id', INT, default=NULL),
        Col('parent_id', TEXT, null=False, default=''),
        Col('project_id', INT, default=NULL),
        Col('model', TEXT, null=False, default=''),
        Col('engine', TEXT, null=False, default=''),
        Col('started_at', REAL, null=False),
        Col('ended_at', REAL, default=NULL),
        Col('status', TEXT, null=False, default='running'),
        Col('error_kind', TEXT, null=False, default=''),
        Col('input_tokens', INT, null=False, default=0),
        Col('output_tokens', INT, null=False, default=0),
        Col('cache_read_tokens', INT, null=False, default=0),
        Col('cache_creation_tokens', INT, null=False, default=0),
        Col('thinking_tokens', INT, null=False, default=0),
        Col('llm_calls', INT, null=False, default=0),
        Col('prefill_ms', INT, null=False, default=0),
        Col('decode_ms', INT, null=False, default=0),
        Col('wait_ms', INT, null=False, default=0),
        Col('tool_calls', INT, null=False, default=0),
        Col('tool_errors', INT, null=False, default=0),
        Col('tool_families', TEXT, null=False, default='{}'),
        Col('files_changed', INT, null=False, default=0),
        Col('sandbox_cpu_peak', REAL, default=NULL),
        Col('sandbox_mem_peak_mb', REAL, default=NULL),
    ],
        indexes=[
            Index('idx_runs_started', ('started_at DESC',)),
            Index('idx_runs_user', ('user_id', 'started_at DESC')),
            Index('idx_runs_chat', ('chat_id', 'started_at')),
            Index('idx_runs_parent', ('parent_id',)),
            Index('idx_runs_running', ('status', 'started_at'), where="status = 'running'"),
        ],
    ),
    Table('sandbox_placements', [
        Col('user_id', INT, primary=True),
        Col('host_id', TEXT, null=False),
        Col('created_at', REAL, null=False),
        Col('updated_at', REAL, null=False),
    ],
        indexes=[
            Index('idx_sandbox_placements_host', ('host_id',)),
        ],
    ),
    Table('saved_prompts', [
        Col('id', ID),
        Col('user_id', INT, null=False),
        Col('title', TEXT, null=False),
        Col('content', TEXT, null=False),
        Col('created_at', REAL, null=False),
    ],
        fks=[FK(('user_id',), 'users', ('id',))],
    ),
    Table('session_messages', [
        Col('id', ID),
        Col('user_id', INT, null=False),
        Col('app', TEXT, null=False),
        Col('session_id', TEXT, null=False),
        Col('scope_key', TEXT, null=False, default=''),
        Col('role', TEXT, null=False),
        Col('content', TEXT, null=False, types={"mysql": TEXT_CI}),
        Col('ts', REAL, null=False),
    ],
        fks=[FK(('user_id',), 'users', ('id',), on_delete='CASCADE')],
        indexes=[
            Index('idx_sm_ts', ('ts',)),
            Index('idx_sm_session', ('user_id', 'app', 'session_id')),
            Index('idx_sm_user', ('user_id', 'ts DESC')),
        ],
    ),
    Table('shared_prompts', [
        Col('id', ID),
        Col('from_user_id', INT, null=False),
        Col('to_user_id', INT, null=False),
        Col('title', TEXT, null=False),
        Col('content', TEXT, null=False),
        Col('created_at', REAL, null=False),
    ],
        fks=[FK(('to_user_id',), 'users', ('id',)), FK(('from_user_id',), 'users', ('id',))],
    ),
    Table('terminal_sessions', [
        Col('id', TEXT, primary=True),
        Col('uid', INT, null=False),
        Col('tid', INT),
        Col('name', TEXT, null=False, default='Terminal'),
        Col('created_at', INT, null=False),
        Col('last_connected_at', INT, null=False),
    ],
        indexes=[
            Index('idx_term_sessions_uid', ('uid', 'tid')),
        ],
    ),
    Table('tool_call_metrics', [
        Col('id', ID),
        Col('run_id', TEXT, null=False),
        Col('user_id', INT, null=False),
        Col('pipeline_id', INT, default=NULL),
        Col('node_id', TEXT, default=NULL),
        Col('member_id', TEXT, default=NULL),
        Col('tool_name', TEXT, null=False),
        Col('server_name', TEXT, default=NULL),
        Col('status', TEXT, null=False, default='success'),
        Col('duration_ms', INT, null=False, default=0),
        Col('error_short', TEXT, default=NULL),
        Col('ts', REAL, null=False),
        # L5.1 (migration 0021) : NULL = non mesuré (lignes antérieures).
        Col('call_id', TEXT, default=NULL),
        Col('started_at', REAL, default=NULL),
        Col('category', TEXT, default=NULL),
        Col('exit_code', INT, default=NULL),
        Col('args_bytes', INT, default=NULL),
        Col('result_bytes', INT, default=NULL),
    ],
        indexes=[
            Index('idx_tcm_ts', ('ts',)),
            Index('idx_tcm_status', ('status', 'ts DESC'), where="status != 'success'"),
            Index('idx_tcm_tool', ('tool_name', 'ts DESC')),
            Index('idx_tcm_user', ('user_id', 'ts DESC')),
            Index('idx_tcm_run', ('run_id', 'ts')),
        ],
    ),
    # Jetons personnels des outils externes (2026-09-30, lot EXT.1) : plugin et
    # outils opencode (``pcr_``), clients MCP/OpenAPI (``ept_``), vision d'une
    # automatisation de bureau (``evt_``). Seule l'EMPREINTE SHA-256 est gardée :
    # un jeton se montre une fois, à sa création, puis se régénère. Remplace
    # ``code_remote_tokens`` (un jeton par compte, en clair). Cf.
    # ``shared_infra/accounts/tokens.py``.
    Table('tool_tokens', [
        Col('id', ID),
        Col('user_id', INT, null=False),
        Col('kind', TEXT, null=False, key=16),
        Col('name', TEXT, null=False, default=''),
        Col('token_hash', TEXT, null=False, unique=True, key=64),
        Col('hint', TEXT, null=False, default=''),
        Col('families', TEXT, null=False, default=''),
        Col('created_at', REAL, null=False),
        Col('expires_at', REAL),
        Col('last_used_at', REAL),
    ],
        fks=[FK(('user_id',), 'users', ('id',), on_delete='CASCADE')],
        indexes=[
            Index('idx_tool_tokens_user', ('user_id', 'kind')),
        ],
    ),
    # Autorisation OAuth 2.1 des clients MCP (EXT.4, migration 0023) : clients
    # (enregistrés dynamiquement, par document de métadonnées ou à la main),
    # codes d'autorisation à usage unique et jetons opaques — empreintes
    # SHA-256 seules (cf. shared_infra/mcp/oauth.py).
    Table('oauth_clients', [
        Col('client_id', TEXT, primary=True, key=255),
        Col('kind', TEXT, null=False, default='dcr', key=16),
        Col('name', TEXT, null=False, default=''),
        Col('secret_hash', TEXT, null=False, default=''),
        Col('auth_method', TEXT, null=False, default='none'),
        Col('redirect_uris', TEXT, null=False, default='[]'),
        Col('metadata', TEXT, null=False, default='{}'),
        Col('created_at', REAL, null=False),
        Col('fetched_at', REAL),
        Col('last_used_at', REAL),
    ]),
    Table('oauth_codes', [
        Col('code_hash', TEXT, primary=True, key=64),
        Col('client_id', TEXT, null=False, key=255),
        Col('user_id', INT, null=False),
        Col('grant_id', TEXT, null=False, key=64),
        Col('redirect_uri', TEXT, null=False, default=''),
        Col('code_challenge', TEXT, null=False, default=''),
        Col('resource', TEXT, null=False, default=''),
        Col('families', TEXT, null=False, default=''),
        Col('created_at', REAL, null=False),
        Col('expires_at', REAL, null=False),
        Col('used_at', REAL),
    ],
        fks=[FK(('user_id',), 'users', ('id',), on_delete='CASCADE'),
             FK(('client_id',), 'oauth_clients', ('client_id',), on_delete='CASCADE')],
        indexes=[
            Index('idx_oauth_codes_expires', ('expires_at',)),
        ],
    ),
    Table('oauth_tokens', [
        Col('id', ID),
        Col('grant_id', TEXT, null=False, key=64),
        Col('user_id', INT, null=False),
        Col('client_id', TEXT, null=False, key=255),
        Col('kind', TEXT, null=False, key=16),
        Col('token_hash', TEXT, null=False, unique=True, key=64),
        Col('families', TEXT, null=False, default=''),
        Col('resource', TEXT, null=False, default=''),
        Col('created_at', REAL, null=False),
        Col('expires_at', REAL, null=False),
        Col('used_at', REAL),
        Col('revoked_at', REAL),
        Col('last_used_at', REAL),
    ],
        fks=[FK(('user_id',), 'users', ('id',), on_delete='CASCADE'),
             FK(('client_id',), 'oauth_clients', ('client_id',), on_delete='CASCADE')],
        indexes=[
            Index('idx_oauth_tokens_grant', ('grant_id',)),
            Index('idx_oauth_tokens_user', ('user_id', 'kind')),
        ],
    ),
    Table('usage_events', [
        Col('id', ID),
        Col('ts', REAL, null=False),
        Col('user_id', INT),
        Col('source', TEXT, null=False, default='unknown'),
        Col('origin_id', TEXT, null=False, default=''),
        Col('parent_id', TEXT, null=False, default=''),
        Col('model', TEXT, null=False, default=''),
        Col('connector', TEXT, null=False, default=''),
        Col('path', TEXT, null=False, default=''),
        Col('input_tokens', INT, null=False, default=0),
        Col('output_tokens', INT, null=False, default=0),
        Col('submitted_tokens', INT, null=False, default=0),
        Col('cache_read_tokens', INT, null=False, default=0),
        Col('cache_creation_tokens', INT, null=False, default=0),
        Col('duration_ms', INT, null=False, default=0),
        Col('iterations', INT, null=False, default=0),
        Col('status', TEXT, null=False, default='ok'),
        Col('error_kind', TEXT, null=False, default=''),
        Col('thinking_tokens', INT, null=False, default=0),
        Col('run_id', TEXT, null=False, default=''),          # exécution (L5.2, 0021)
    ],
        indexes=[
            Index('idx_usage_status_ts', ('status', 'ts DESC'), where="status != 'ok'"),
            Index('idx_usage_model_ts', ('model', 'ts DESC')),
            Index('idx_usage_source_ts', ('source', 'ts DESC')),
            Index('idx_usage_user_ts', ('user_id', 'ts DESC')),
            Index('idx_usage_ts', ('ts DESC',)),
            Index('idx_usage_run', ('run_id',)),
        ],
    ),
    Table('user_groups', [
        Col('user_id', INT, null=False),
        Col('group_id', INT, null=False),
    ],
        pk=('user_id', 'group_id'),
        fks=[FK(('group_id',), 'groups', ('id',), on_delete='CASCADE'), FK(('user_id',), 'users', ('id',), on_delete='CASCADE')],
        indexes=[
            Index('idx_user_groups_group', ('group_id',)),
            Index('idx_user_groups_user', ('user_id',)),
        ],
    ),
    # Images produites par le moteur d'images (0024) : une ligne par image, le
    # fichier vit sous ``user_db/generated_images/`` (``rel_path`` relatif à
    # cette racine). ``model``, ``steps``, ``megapixels`` et ``duration_s``
    # servent l'estimation de durée des générations suivantes.
    Table('generated_images', [
        Col('id', TEXT, primary=True, key=64),
        Col('user_id', INT, null=False),
        Col('chat_id', TEXT, key=64),
        Col('prompt', TEXT, null=False, default=''),
        Col('params_json', TEXT, null=False, default='{}'),
        Col('model', TEXT, null=False, default=''),
        Col('mime', TEXT, null=False),
        Col('width', INT, null=False),
        Col('height', INT, null=False),
        Col('bytes', INT, null=False),
        Col('rel_path', TEXT, null=False),
        Col('thumb_rel_path', TEXT, null=False, default=''),
        Col('steps', INT, null=False, default=0),
        Col('megapixels', REAL, null=False, default=0),
        Col('duration_s', REAL, default=NULL),
        Col('created_at', REAL, null=False),
    ],
        fks=[FK(('user_id',), 'users', ('id',), on_delete='CASCADE')],
        indexes=[
            Index('idx_generated_images_user', ('user_id', 'created_at')),
            Index('idx_generated_images_chat', ('user_id', 'chat_id')),
            Index('idx_generated_images_model', ('model', 'created_at')),
        ],
    ),
]


# Tables propres au runner de migrations (créées aussi par lui, même DDL).
TABLES.append(Table("schema_migrations", [
    Col("id", ID),
    Col("name", TEXT, null=False, unique=True),
    Col("applied_at", REAL, null=False),
]))

# Verrou d'écriture des moteurs serveur (``_dialect.begin_write``) : une ligne
# verrouillée par ``SELECT … FOR UPDATE``, libérée au COMMIT/ROLLBACK. SQLite
# a ``BEGIN IMMEDIATE`` et n'en a pas besoin.
TABLES.append(Table("elpis_locks", [
    Col("name", TEXT, primary=True, key=64),
], only=(POSTGRES, MYSQL)))

TABLES_BY_NAME: Dict[str, Table] = {t.name: t for t in TABLES}

# Migrations dont l'effet est DÉJÀ dans ce schéma : une base neuve les
# tamponne au lieu de les rejouer. Règle : toute nouvelle migration met à jour
# ce schéma ET ajoute son nom ici (le test d'équivalence le vérifie).
BASELINE_COVERS: Tuple[str, ...] = (
    "0001_rename_toolbox_to_mcp",
    "0002_remove_dead_blocks",
    "0003_drop_agentic_tables",
    "0004_drop_agents_routines_tables",
    "0005_notifications_table",
    "0006_git_connectors",
    "0007_llm_connectors",
    "0008_chat_meta",
    "0009_revoked_sessions",
    "0010_mcp_shared_servers",
    "0011_usage_events",
    "0012_drop_unused_metric_index",
    "0013_encrypt_personal_mcp_auth",
    "0014_usage_thinking_tokens",
    "0015_mcp_headers_env",
    "0016_sandbox_placements",
    "0017_drop_scenarios",
    "0018_llm_engine_policies",
    "0019_llm_connector_engine_limits",
    "0020_prompt_templates",
    "0021_runs",
    "0022_tool_tokens",
    "0023_oauth",
    "0024_generated_images",
)


# ─────────────────────────────────────────────────────────────────────────────
#  Recherche plein texte (historique des sessions)
# ─────────────────────────────────────────────────────────────────────────────
#  SQLite : index FTS5 à contenu externe, tenu à jour par trois déclencheurs.
#  PostgreSQL / MySQL : branchés avec leurs adaptateurs (lot B).

FTS_SQLITE = (
    """CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
                content,
                user_id    UNINDEXED,
                app        UNINDEXED,
                session_id UNINDEXED,
                role       UNINDEXED,
                content='session_messages',
                content_rowid='id',
                tokenize='unicode61 remove_diacritics 2'
            )""",
    """CREATE TRIGGER IF NOT EXISTS sm_ai AFTER INSERT ON session_messages BEGIN
                INSERT INTO session_messages_fts(rowid, content, user_id, app, session_id, role)
                VALUES (new.id, new.content, new.user_id, new.app, new.session_id, new.role);
            END""",
    """CREATE TRIGGER IF NOT EXISTS sm_ad AFTER DELETE ON session_messages BEGIN
                INSERT INTO session_messages_fts(session_messages_fts, rowid, content, user_id, app, session_id, role)
                VALUES('delete', old.id, old.content, old.user_id, old.app, old.session_id, old.role);
            END""",
    """CREATE TRIGGER IF NOT EXISTS sm_au AFTER UPDATE ON session_messages BEGIN
                INSERT INTO session_messages_fts(session_messages_fts, rowid, content, user_id, app, session_id, role)
                VALUES('delete', old.id, old.content, old.user_id, old.app, old.session_id, old.role);
                INSERT INTO session_messages_fts(rowid, content, user_id, app, session_id, role)
                VALUES (new.id, new.content, new.user_id, new.app, new.session_id, new.role);
            END""",
)


def ensure_fts(conn: Any) -> bool:
    """Pose l'index plein texte de ``session_messages``. Rend False si le
    moteur ne l'a pas (SQLite compilé sans FTS5) : la recherche retombe alors
    sur LIKE.

    * SQLite : FTS5 à contenu externe + trois déclencheurs.
    * PostgreSQL : colonne générée ``content_tsv`` (configuration
      ``elpis_simple`` = ``simple`` + ``unaccent`` si l'extension est
      disponible, comme ``remove_diacritics`` de FTS5) + index GIN.
    * MySQL/MariaDB : index ``FULLTEXT`` (colonne en collation insensible à
      la casse et aux accents), mots vides désactivés à la création.
    """
    d = dialect_of(conn)
    try:
        if d == SQLITE:
            for stmt in FTS_SQLITE:
                conn.execute(stmt)
        elif d == POSTGRES:
            _ensure_fts_pg(conn)
        else:
            _ensure_fts_mysql(conn)
        return True
    except Exception as exc:                          # moteur sans plein texte
        log.warning("[schema] plein texte indisponible (%s) — recherche d'historique en LIKE.", exc)
        return False


# Ponctuation ramenée à des espaces avant l'analyse, côté index ET côté requête
# (``memory.store._fts_terms``) : FTS5 ``unicode61`` coupe sur tout ce qui n'est
# ni lettre ni chiffre, alors que l'analyseur de PostgreSQL garde entiers les
# chemins, hôtes et versions (« notes/plan.md » = un seul lexème, introuvable
# par « plan.md »).
FTS_PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~«»‘’“”…–—·•"


def pg_fts_document(col: str) -> str:
    """Texte indexé par PostgreSQL : ``col`` sans sa ponctuation."""
    return "translate({}, '{}', '{}')".format(
        col, FTS_PUNCT.replace("'", "''"), " " * len(FTS_PUNCT))


def _ensure_fts_pg(conn: Any) -> None:
    unaccent = True
    try:
        conn.execute("CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA public")
    except Exception as exc:
        unaccent = False
        log.warning("[schema] extension unaccent indisponible (%s) : recherche "
                    "sensible aux accents.", exc)
    row = conn.execute(
        "SELECT 1 FROM pg_ts_config WHERE cfgname = 'elpis_simple' "
        "AND cfgnamespace = current_schema()::regnamespace").fetchone()
    if row is None:
        conn.execute("CREATE TEXT SEARCH CONFIGURATION elpis_simple (COPY = pg_catalog.simple)")
        if unaccent:
            conn.execute("ALTER TEXT SEARCH CONFIGURATION elpis_simple "
                         "ALTER MAPPING FOR word, numword, hword, hword_part, numhword, "
                         "hword_numpart WITH public.unaccent, simple")
    if "content_tsv" not in table_columns(conn, "session_messages"):
        conn.execute("ALTER TABLE session_messages ADD COLUMN content_tsv tsvector "
                     "GENERATED ALWAYS AS (to_tsvector('elpis_simple', "
                     f"{pg_fts_document('content')})) STORED")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sm_fts ON session_messages USING GIN (content_tsv)")


def _ensure_fts_mysql(conn: Any) -> None:
    row = conn.execute(
        "SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() "
        "AND table_name = 'session_messages' AND index_name = 'idx_sm_fts' LIMIT 1").fetchone()
    if row is None:
        conn.execute("SET SESSION innodb_ft_enable_stopword = OFF")
        conn.execute("ALTER TABLE session_messages ADD FULLTEXT INDEX idx_sm_fts (content)")


# ─────────────────────────────────────────────────────────────────────────────
#  Application du schéma
# ─────────────────────────────────────────────────────────────────────────────

def _add_column_sql(t: Table, c: Col, dialect: str) -> str:
    """Définition pour ``ALTER TABLE … ADD COLUMN`` : sans PRIMARY KEY ni
    UNIQUE, que SQLite refuse sur une colonne ajoutée."""
    plain = Col(c.name, c.type, null=c.null, default=c.default, check=c.check,
                key=c.key, types=c.types)
    return _col_sql(t, plain, dialect)


def add_missing_columns(conn: Any, t: Table) -> List[str]:
    """Ajoute à une table EXISTANTE les colonnes du schéma qui lui manquent
    (bases créées avant l'ajout d'une colonne). Rend les noms ajoutés."""
    d = dialect_of(conn)
    present = set(table_columns(conn, t.name))
    if not present:
        return []
    added = []
    for c in t.cols:
        if c.name in present:
            continue
        if c.type == ID or c.primary or c.unique or (not c.null and c.default is _NO_DEFAULT):
            log.error("[schema] %s.%s manque et ne peut pas être ajoutée "
                      "(clé, unicité ou NOT NULL sans défaut).", t.name, c.name)
            continue
        conn.execute(f"ALTER TABLE {q(t.name) if d != MYSQL else _q_mysql(t.name)} "
                     f"ADD COLUMN {_add_column_sql(t, c, d)}")
        added.append(c.name)
    return added


def _index_exists(conn: Any, t: Table, ix: Index) -> bool:
    row = conn.execute(
        "SELECT 1 FROM information_schema.statistics "
        "WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1",
        (t.name, ix.name)).fetchone()
    return row is not None


def ensure_tables(conn: Any, names: Optional[Iterable[str]] = None) -> None:
    """Crée les tables demandées (toutes par défaut) si elles manquent, leur
    ajoute les colonnes manquantes et pose leurs index. Idempotent — c'est ce
    qu'appellent ``init_db`` et les familles (``init_routines_db``…)."""
    d = dialect_of(conn)
    tables = TABLES if names is None else [TABLES_BY_NAME[n] for n in names]
    for t in tables:
        if t.only is not None and d not in t.only:
            continue
        conn.execute(create_table_sql(t, d))
        add_missing_columns(conn, t)
        for ix in t.indexes:
            if d == MYSQL and _index_exists(conn, t, ix):
                continue
            conn.execute(create_index_sql(t, ix, d))


def create_all(conn: Any) -> bool:
    """Le schéma complet. Rend la disponibilité du plein texte."""
    ensure_tables(conn)
    if dialect_of(conn) != SQLITE:
        conn.execute("INSERT INTO elpis_locks(name) VALUES ('write') ON CONFLICT DO NOTHING")
        conn.commit()
    return ensure_fts(conn)


def is_fresh(conn: Any) -> bool:
    """Base VIERGE : aucune table. Une base qui en a ne serait-ce qu'une (même
    partielle, même ancienne) rejoue sa chaîne de migrations au lieu d'être
    tamponnée — c'est la seule façon de ne sauter aucune transformation."""
    return not table_names(conn)


__all__ = [
    "ID", "INT", "REAL", "TEXT", "TEXT_CI", "NULL", "Col", "FK", "Index", "Table",
    "TABLES", "TABLES_BY_NAME", "BASELINE_COVERS", "q", "create_table_sql",
    "create_index_sql", "ensure_tables", "ensure_fts", "create_all",
    "add_missing_columns", "is_fresh",
]
