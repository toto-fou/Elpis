// SPDX-License-Identifier: MIT
// tests/frontend/lib/journal-mock.mjs — réponses simulées du journal de sécurité (état, événements paginés, vérification) pour admin-server.mjs.

const HOTE = "elpis-test";
const BOOT = "a1b2c3d4e5f60718";

/** État du journal : « sain » (aucune alerte) ou « alertes » (centralisation absente, horloge, gel). */
export function etatJournal(
  maintenant,
  { alertes = false, gel = false, motif = "", retention_days = 365, forwarding_expected = true } = {},
) {
  const etat = {
    directory: "/var/lib/elpis/audit",
    fallback_directory: false,
    mode: "2750",
    group_id: 998,
    world_readable: false,
    signed: true,
    kid: "3fa2c19b",
    files: 365,
    bytes: 1932735283,
    oldest: "2025-11-09",
    newest: "2026-11-08",
    daily_avg_bytes: 5293000,
    disk: { free_bytes: 412 * 1024 ** 3, total_bytes: 960 * 1024 ** 3, days_left: 83560 },
    clock_synchronized: true,
    forwarding: {
      expected: forwarding_expected,
      agent: "rsyslog",
      active: true,
      rule: "/etc/rsyslog.d/60-elpis.conf",
      collector: "journaux.interne.lan:6514",
      transport: "TCP + TLS (x509/name)",
      queue: { type: "Disque (LinkedList)", file: "/var/spool/rsyslog/elpis-fwd", max_disk: "1g" },
      certificates: [
        {
          path: "/etc/elpis/pki/ca-interne.pem",
          role: "ca",
          readable: true,
          expires_at: "2029-03-01T00:00:00.000Z",
          days_left: 1220,
        },
        {
          path: "/etc/elpis/pki/elpis-client.pem",
          role: "client",
          readable: true,
          expires_at: "2027-06-01T00:00:00.000Z",
          days_left: 214,
        },
      ],
    },
    retention: {
      retention_days,
      hold: gel,
      hold_reason: gel ? motif : "",
      forwarding_expected,
      out_of_bounds: false,
      invalid: false,
      from_witness: false,
      eligible_files: gel ? 2 : 0,
    },
    write_failures: { count: 0, last_error: null },
    writers: [
      {
        host: HOTE,
        service: "admin",
        boot: BOOT,
        last_ts: maintenant - 1800,
        last_action: "admin.config.update",
        failures: 0,
        stopped: false,
      },
      {
        host: HOTE,
        service: "main",
        boot: BOOT,
        last_ts: maintenant - 900,
        last_action: "auth.login",
        failures: 0,
        stopped: false,
      },
    ],
    alerts: [],
    generated_at: maintenant - 40,
  };
  if (alertes) {
    etat.clock_synchronized = false;
    etat.forwarding.active = false;
    etat.alerts = [
      {
        id: "audit-forwarding",
        level: "danger",
        title: "Centralisation attendue mais absente : purge suspendue",
        detail: "rsyslog arrêté.",
      },
      {
        id: "audit-clock",
        level: "warn",
        title: "Horloge non synchronisée",
        detail: "Configurez chrony sur le serveur de temps interne.",
      },
    ];
  }
  if (gel)
    etat.alerts.push({
      id: "audit-hold",
      level: "info",
      title: "Gel de la purge du journal actif",
      detail: motif,
    });
  return etat;
}

const MODELES = [
  ["auth.login", "main", "success", "alice", 3, "10.0.0.21"],
  ["auth.login.failed", "main", "failure", "bob", 4, "10.0.0.34"],
  ["admin.config.update", "admin", "success", "admin", 1, "10.0.0.5"],
  ["admin.user.create", "admin", "success", "admin", 1, "10.0.0.5"],
  ["llm.connector.update", "main", "success", "alice", 3, "10.0.0.21"],
  ["code.exec.tools.shell", "toolhost", "success", "bob", 4, null],
  ["admin.audit.search", "admin", "success", "admin", 1, "10.0.0.5"],
];

/** 120 lignes signées sur les 23 dernières heures, plus récentes d'abord, dont 10 marqueurs d'écriture. */
export function evenements(maintenant) {
  const lignes = [];
  for (let i = 0; i < 120; i++) {
    const ts = maintenant - 120 - i * 600;
    const marqueur = i % 12 === 5;
    const m = MODELES[i % MODELES.length];
    const action = marqueur ? (i % 24 === 5 ? "audit.writer.start" : "audit.writer.heartbeat") : m[0];
    lignes.push({
      ref: `${new Date(ts * 1000).toISOString().slice(0, 10)}:${100000 - i * 211}`,
      v: 1,
      time: new Date(ts * 1000).toISOString(),
      ts,
      host: HOTE,
      service: marqueur ? "main" : m[1],
      boot: BOOT,
      seq: 5000 - i,
      action,
      outcome: marqueur ? "success" : m[2],
      user_id: marqueur ? null : m[4],
      username: marqueur ? null : m[3],
      ip: marqueur ? null : m[5],
      details: marqueur ? { pid: 4242 } : { target: "demo-" + i },
      signed: true,
      kid: "3fa2c19b",
    });
  }
  return lignes;
}

/** Recherche du serveur : filtres, marqueurs exclus, curseur = rang dans la liste filtrée. */
export function rechercher(toutes, p) {
  const f = toutes.filter((e) => {
    if (p.get("exclude_markers") === "1" && e.action.startsWith("audit.writer")) return false;
    const action = p.get("action");
    if (action && !(e.action === action || e.action.startsWith(action))) return false;
    const user = p.get("user");
    if (user && !(e.username || "").includes(user) && String(e.user_id) !== user) return false;
    if (p.get("outcome") && e.outcome !== p.get("outcome")) return false;
    if (p.get("ip") && !(e.ip || "").startsWith(p.get("ip"))) return false;
    if (p.get("service") && e.service !== p.get("service")) return false;
    const q = (p.get("q") || "").toLowerCase();
    if (q && !JSON.stringify(e).toLowerCase().includes(q)) return false;
    return true;
  });
  const debut = Number(p.get("cursor") || 0) || 0;
  const limite = Math.max(1, Math.min(200, Number(p.get("limit") || 50)));
  const page = f.slice(debut, debut + limite);
  const suite = debut + limite < f.length ? String(debut + limite) : null;
  return {
    events: page,
    cursor: suite,
    scanned_bytes: 8192,
    budget_reached: false,
    unreadable: 0,
    last_ts: page.length ? page[page.length - 1].ts : null,
    from: p.get("from") || "",
    to: p.get("to") || "",
  };
}

/** Résultat de « Vérifier l'intégrité » : intact. */
export function verification(p) {
  const vide = [];
  return {
    from: p.from || null,
    to: p.to || null,
    status: "intact",
    intact: true,
    key_available: true,
    files: 2,
    first_file: "audit-2026-11-07.jsonl",
    last_file: "audit-2026-11-08.jsonl",
    lines: 120,
    v0_lines: 0,
    signed: 120,
    valid: 120,
    unsigned: 0,
    unknown_key: 0,
    invalid_signatures: vide,
    unreadable: vide,
    gaps: vide,
    out_of_order: vide,
    unverified: vide,
    inconsistent: vide,
    misplaced: vide,
    duplicates: vide,
    writers: 2,
    writers_without_stop: 0,
    uncertain_ends: vide,
    reasons: vide,
    totals: {
      invalid_signatures: 0,
      unreadable: 0,
      gaps: 0,
      out_of_order: 0,
      unverified: 0,
      inconsistent: 0,
      misplaced: 0,
      late_v0: 0,
      duplicates: 0,
    },
  };
}
