# SPDX-License-Identifier: MIT
"""Supervision et contexte (L5.5-L5.6) : jalons de compaction gardés sur le
message (champs connus et bornés, round-trip client, fusion d'un
« Continuer »), sorties élaguées comptées, et ``<harness_status>`` qui
annonce la fenêtre restante et les limites de la sandbox aux seuls jalons."""
from __future__ import annotations

from chatbot_app.routes.chats import (
    _compaction_pour_message,
    _merge_prev_segment_lists,
    _normalize_client_messages,
)
from llm_core import _chat_with_tools as cwt
from llm_core._chat_with_tools import _harness_status_line


def test_jalon_de_compaction_borne():
    c = _compaction_pour_message({
        "round": 2, "reason": "threshold", "threshold": 6000.7, "tokens_before": 8000,
        "tokens_after": 2000, "had_previous_summary": True, "model_used": "m" * 500,
        "path": "x" * 100, "new_state": {"summary_xml": "gros résumé"}, "ratio": True,
        "turns_compressed": "3",
    })
    assert c == {"round": 2, "reason": "threshold", "threshold": 6000, "tokens_before": 8000,
                 "tokens_after": 2000, "had_previous_summary": True,
                 "model_used": "m" * 120, "path": "x" * 32}


def test_round_trip_client_garde_compactions_et_elagage():
    _f, pers = _normalize_client_messages([
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "r", "pruned": 4,
         "compactions": [{"reason": "overflow", "tokens_before": 10}, "pas un dict"] + [{}] * 30},
    ])
    asst = pers[-1]
    assert asst["pruned"] == 4
    assert asst["compactions"][0] == {"reason": "overflow", "tokens_before": 10}
    assert len(asst["compactions"]) <= 20


def test_round_trip_client_refuse_les_valeurs_hors_forme():
    _f, pers = _normalize_client_messages([
        {"role": "assistant", "content": "r", "pruned": True, "compactions": "non"},
        {"role": "assistant", "content": "r", "pruned": -1},
    ])
    assert all("pruned" not in m and "compactions" not in m for m in pers)


def test_continuer_garde_les_compactions_du_segment_tronque():
    prev = {"compactions": [{"reason": "threshold", "round": 1}]}
    msg = {"compactions": [{"reason": "overflow", "round": 3}]}
    _merge_prev_segment_lists(prev, msg)
    assert [c["reason"] for c in msg["compactions"]] == ["threshold", "overflow"]


def test_statut_du_harnais_annonce_contexte_et_sandbox_aux_jalons():
    ligne = _harness_status_line(100, 200, ctx_left=42_500, ctx_size=131_072,
                                 sandbox_limits="2048 MB RAM, 1 CPU")
    assert ligne is not None
    assert "Context window: ~42k of 131k tokens left." in ligne
    assert "Sandbox limits: 2048 MB RAM, 1 CPU." in ligne
    # Hors jalon : rien, même avec ces informations.
    assert _harness_status_line(7, 200, ctx_left=1, ctx_size=2, sandbox_limits="x") is None
    # Fenêtre inconnue : pas de ligne de contexte.
    assert "Context window" not in (_harness_status_line(100, 200, ctx_left=10, ctx_size=0) or "")


def test_limites_de_la_sandbox_lues_dans_la_config_admin(monkeypatch):
    from shared_infra.sandbox.executors import _user_sandbox as us

    class Cfg:
        memory_mb, cpu_quota_pct, pids_max, timeout_s = 4096, 150, 256, 600
    monkeypatch.setattr(us, "load_admin_config", lambda: Cfg())
    assert cwt._sandbox_limits_text() == "4096 MB RAM, 1.5 CPU, 256 processes, 600 s per command"

    def casse():
        raise OSError("config illisible")
    monkeypatch.setattr(us, "load_admin_config", casse)
    assert cwt._sandbox_limits_text() is None


def test_widgets_attente_llm_et_cache_kv(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.init_db()
    from shared_infra.observability.metrics.engine import (
        DEFAULT_WIDGETS,
        KPIKVPrefixReuseProvider,
        KPILLMWaitProvider,
        registry,
    )
    for v in (100, 300):
        legacy.log_metric("llm_wait_time_ms", v, {})
    for v in (0, 80, 100):
        legacy.log_metric("kv_prefix_reuse_pct", v, {})
    attente = KPILLMWaitProvider().get_data(scope_hours=24)
    assert attente["value"] == 200 and attente["detail"].startswith("P95 300 ms")
    # Un préfixe cassé (0 %) compte dans la moyenne.
    assert KPIKVPrefixReuseProvider().get_data(scope_hours=168)["value"] == 60
    ids = {p.id for p in registry.providers}
    assert {"kpi_llm_wait", "kpi_kv_prefix_reuse"} <= ids
    # Activables depuis le sélecteur, pas ajoutés au tableau de bord par défaut.
    assert not ({"kpi_llm_wait", "kpi_kv_prefix_reuse"} & DEFAULT_WIDGETS)


def test_jalon_refuse_les_nombres_non_finis_ou_demesures():
    c = _compaction_pour_message({"tokens_before": float("inf"), "tokens_after": float("nan"),
                                  "threshold": 1e300, "round": -1, "ctx_size": 8192})
    assert c == {"ctx_size": 8192}


def test_continuer_decale_le_round_des_compactions_de_la_reprise():
    prev = {"tool_history_delta": True, "compactions": [{"round": 1}], "tool_history": [
        {"role": "assistant", "tool_calls": [{"id": "a"}]}, {"role": "tool", "tool_call_id": "a"},
        {"role": "assistant", "tool_calls": [{"id": "b"}]}, {"role": "tool", "tool_call_id": "b"},
    ]}
    msg = {"compactions": [{"round": 1, "reason": "overflow"}]}
    _merge_prev_segment_lists(prev, msg)
    # 2 rounds dans le tronc : la compaction faite après le 1er round de la
    # reprise se place après le 3e round de la tool_history rechargée.
    assert [c["round"] for c in msg["compactions"]] == [1, 3]
