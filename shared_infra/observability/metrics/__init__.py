# SPDX-License-Identifier: MIT
"""
backend.metrics — Metrics engine and inter-worker broadcast bus.

Two modules:

  - ``engine`` — the registry of KPI providers (everything from
                  ``KPIDAUProvider`` to ``LatencyPercentilesProvider``),
                  the ``BackgroundMonitor`` that scrapes psutil, and the
                  ``registry`` singleton the admin endpoints query.

  - ``broadcast`` — file-backed pub/sub that lets every worker push
                     metric updates onto a shared bus and one tailer task
                     fan them out via the SSE system events stream.

Public API kept minimal: external callers only ever needed ``registry``
from the engine and the publish helpers from broadcast. Everything
else (the 60+ KPI provider classes, the ``BackgroundMonitor`` class) is
internal to the engine — accessible via ``from backend.metrics.engine
import …`` for the rare case where it's needed.
"""
from shared_infra.observability.metrics.engine import registry, MetricsRegistry, BackgroundMonitor, sys_monitor
from shared_infra.observability.metrics.broadcast import publish_event, start_metric_tailer

__all__ = [
    "registry",
    "MetricsRegistry",
    "BackgroundMonitor",
    "sys_monitor",
    "publish_event",
    "start_metric_tailer",
]
