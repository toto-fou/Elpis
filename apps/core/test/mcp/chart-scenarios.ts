// SPDX-License-Identifier: MIT
/** apps/core/test/mcp/chart-scenarios.ts — scénarios d'appel de la famille chart (30 types, lecture tolérante, refus, validation, ressource) rejoués sur le Python et le TS. */
import type { Etape } from "../../../../packages/outils-mcp/test/differentiel";

type Dict = Record<string, unknown>;

/** Identifiant du graphique de `bar-id-connu` (SHA-1 de son option, mesuré sur le Python). */
export const ID_CONNU = "abc53bd62331";
export const SERVICE = "svc-chart-0123456789abcdef";
export const A = { authorization: `Bearer ${SERVICE}` };
export const J = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const META = { username: "alice", chat_id: "c1" };

const MOIS = ["janv.", "févr.", "mars", "avr."];
const mois = (v: number[], f: (m: string, x: number, i: number) => Dict): Dict[] =>
  MOIS.map((m, i) => f(m, v[i] ?? 0, i));

/** Un exemple par type (repris de tests/llm_core/test_chart_tools.py). */
export const EXEMPLES: Record<string, Dict> = {
  bar: {
    data: mois([120, 98, 143, 160], (m, v) => ({ mois: m, ventes: v, coûts: v - 30 })),
    lines: [{ value: 130, label: "objectif" }],
    show_values: true,
  },
  line: { data: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ semaine: `S${i}`, API: 180 + i })), trend: true },
  area: { data: mois([1, 2, 3, 4], (m, v) => ({ mois: m, a: v, b: 2 * v })), stack: "stacked" },
  stream: {
    data: [1, 2, 3, 4].flatMap((i) =>
      ["Tél", "Web"].map((c, k) => ({ mois: `2026-0${i}`, canal: c, n: i * 10 + k })),
    ),
  },
  radar: {
    data: [
      { solution: "A", coût: 7, sécurité: 9, support: 8 },
      { solution: "B", coût: 9, sécurité: 6, support: 6 },
    ],
  },
  polar_bar: { data: ["lun.", "mar.", "mer."].map((j, i) => ({ jour: j, n: [8, 9, 7][i] })) },
  waterfall: {
    data: [
      { étape: "Budget", montant: 1200 },
      { étape: "Recrutements", montant: -180 },
      { étape: "Subvention", montant: 140 },
    ],
  },
  pie: { data: { Fixe: 45, Mobile: 35, Box: 20 } },
  donut: { data: { Windows: 1240, macOS: 180 } },
  rose: { data: { Matériel: 34, Logiciel: 51, Réseau: 28 } },
  treemap: {
    data: [
      ["Tech", "Infra", 820],
      ["Tech", "Dév", 640],
      ["RH", "Paie", 160],
    ].map(([direction, service, budget]) => ({ direction, service, budget })),
  },
  sunburst: {
    data: [
      ["Recherche", "A", 4200],
      ["Recherche", "B", 1300],
      ["Direct", "Favori", 2100],
    ].map(([canal, source, visites]) => ({ canal, source, visites })),
  },
  funnel: { data: { Visites: 12000, Formulaire: 4300, Compte: 1650 } },
  histogram: { data: Array.from({ length: 60 }, (_, i) => ({ âge: 20 + ((i * 7) % 40) })) },
  boxplot: {
    data: ["A", "B"].flatMap((e) => [1, 2, 3, 4, 9].map((v) => ({ équipe: e, délai: v }))),
  },
  scatter: { data: [30, 45, 60, 90].map((s) => ({ surface: s, prix: 4 * s })), trend: true },
  bubble: {
    data: [30, 45, 60, 90].map((s) => ({ surface: s, prix: 4 * s, pièces: Math.floor(s / 20) })),
  },
  heatmap: {
    data: ["lun.", "mar."].flatMap((j, i) =>
      ["9 h", "14 h"].map((h, k) => ({ jour: j, heure: h, appels: i + k })),
    ),
  },
  calendar: {
    data: Array.from({ length: 28 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      commits: (i + 1) % 5,
    })),
  },
  parallel: {
    data: [
      ["E", 8, 32],
      ["H", 64, 512],
    ].map(([gamme, cœurs, RAM]) => ({ gamme, cœurs, RAM })),
  },
  sankey: {
    data: [
      { source: "Budget", target: "Salaires", value: 62 },
      { source: "Budget", target: "Locaux", value: 18 },
    ],
  },
  chord: {
    data: [
      { source: "RH", target: "Finances", value: 30 },
      { source: "Finances", target: "RH", value: 12 },
    ],
  },
  graph: {
    data: [
      { source: "Portail", target: "Annuaire" },
      { source: "Portail", target: "GED" },
    ],
  },
  tree: {
    data: [
      { nom: "DSI", parent: "" },
      { nom: "Études", parent: "DSI" },
    ],
  },
  gantt: {
    data: [
      { tâche: "Cadrage", début: "2020-09-01", fin: "2020-09-12" },
      { tâche: "Pilote", début: "2020-10-05", fin: "2020-10-23" },
    ],
  },
  candlestick: {
    data: [1, 2, 3, 4, 5, 6].map((i) => ({
      date: `2026-03-0${i}`,
      open: 100 + i,
      high: 104 + i,
      low: 99 + i,
      close: 102 + i,
    })),
    trend: true,
  },
  gauge: { data: [{ indicateur: "Disponibilité", valeur: 99.2, max: 100 }], unit: "%" },
  progress: { data: [{ chantier: "MFA", fait: 1210, total: 1500 }] },
  kpi: { data: [{ indicateur: "Tickets", valeur: 1284, précédent: 1190 }] },
  table: { data: [{ mesure: "Latence", valeur: 8, unité: "ms" }] },
};

/** Un appel : arguments en objet, ou en texte JSON brut (flottants `1.0`, entiers longs, NaN) ; `meta` remplace l'identité par défaut. */
export interface Appel {
  readonly nom: string;
  readonly outil: string;
  readonly args: Dict | string | unknown;
  readonly meta?: Dict | null;
}

const VENTES = [
  { m: "a", v: 1 },
  { m: "b", v: 2 },
];

/** Appels hors exemples : lecture tolérante, formes de données, refus, garde-fou, validation, tailles. */
export function appelsVaries(): Appel[] {
  const refus = { data: [{ jour: "lun.", appels: 3 }] };
  return [
    { nom: "bar-id-connu", outil: "chart_bar", args: { data: VENTES, title: "T" } },
    { nom: "bar-titre", outil: "chart_bar", args: { data: VENTES, title: "Ventes" } },
    { nom: "bar-meme-appel-reecrit", outil: "chart_bar", args: { data: VENTES, title: "Ventes" } },
    { nom: "bar-stacked-casse", outil: "chart_bar", args: { data: VENTES, stack: "Stacked" } },
    {
      nom: "bar-booleens-lax",
      outil: "chart_bar",
      args: { data: VENTES, horizontal: "yes", show_values: 1, trend: "true" },
    },
    { nom: "bar-booleen-faux", outil: "chart_bar", args: { data: VENTES, horizontal: "non", trend: 0 } },
    {
      nom: "bar-colonnes-casse",
      outil: "chart_bar",
      args: {
        x: "MOIS",
        y: ["Ventes"],
        data: [
          { mois: "a", ventes: "1 200 €" },
          { mois: "b", ventes: 2 },
        ],
      },
    },
    {
      nom: "bar-top-sort",
      outil: "chart_bar",
      args: {
        data: [
          { k: "a", v: 5 },
          { k: "b", v: 9 },
          { k: "c", v: 1 },
          { k: "d", v: 7 },
        ],
        top: 2,
        sort: "desc",
        unit: "€",
      },
    },
    {
      nom: "bar-top-texte",
      outil: "chart_bar",
      args: {
        data: [
          { k: "a", v: 5 },
          { k: "b", v: 9 },
          { k: "c", v: 1 },
        ],
        top: "2",
        highlight: "b",
      },
    },
    {
      nom: "bar-valeurs-par-defaut",
      outil: "chart_bar",
      args: {
        data: VENTES,
        title: "",
        x: null,
        unit: "",
        stack: "none",
        sort: "none",
        top: null,
        lines: null,
      },
    },
    { nom: "bar-csv", outil: "chart_bar", args: { data: "mois;ventes\nA;1\nB;2" } },
    { nom: "bar-markdown", outil: "chart_bar", args: { data: "| r | v |\n|---|---|\n| A | 1 |\n| B | 2 |" } },
    { nom: "bar-json-texte", outil: "chart_bar", args: { data: '[{"a": 1.0, "b": 2}, {"a": 3.0, "b": 4}]' } },
    { nom: "bar-colonnes", outil: "chart_bar", args: { data: { a: [1, 2], b: [3, 4] } } },
    {
      nom: "bar-liste-de-listes",
      outil: "chart_bar",
      args: {
        data: [
          ["x", "y"],
          ["a", 1],
          ["b", 2],
        ],
      },
    },
    { nom: "bar-chartjs", outil: "chart_bar", args: { data: [{ label: "s", data: [1, 2] }] } },
    {
      nom: "bar-unicode",
      outil: "chart_bar",
      args: {
        data: [
          { été: "à", "prix €": 3 },
          { été: "é", "prix €": 4 },
        ],
        title: "Ça va ? 😀",
      },
    },
    { nom: "bar-donnees-nulles", outil: "chart_bar", args: { data: null } },
    { nom: "bar-lignes-vides", outil: "chart_table", args: { data: [{}] } },
    { nom: "refus-1", outil: "chart_heatmap", args: refus },
    { nom: "refus-2-identique", outil: "chart_heatmap", args: refus },
    { nom: "refus-3-identique", outil: "chart_heatmap", args: refus },
    {
      nom: "refus-autre-chat",
      outil: "chart_heatmap",
      args: refus,
      meta: { username: "alice", chat_id: "c2" },
    },
    {
      nom: "refus-autre-compte",
      outil: "chart_heatmap",
      args: refus,
      meta: { username: "carol", chat_id: "c1" },
    },
    { nom: "refus-sans-identite", outil: "chart_heatmap", args: refus, meta: null },
    { nom: "refus-type-inconnu-meta-vide", outil: "chart_pie", args: { data: [] }, meta: {} },
    {
      nom: "avertissements",
      outil: "chart_waterfall",
      args: {
        data: [
          { poste: "Budget initial", variation: 0, total: 1200 },
          { poste: "Recrutements", variation: -180, total: 1020 },
          { poste: "Énergie", variation: -75, total: 945 },
          { poste: "Réalisé", variation: -300, total: 900 },
        ],
      },
    },
    {
      nom: "flottants-1.0",
      outil: "chart_bar",
      args: '{"data":[{"m":"a","v":1.0},{"m":"b","v":2.0}],"title":"flottants"}',
    },
    {
      nom: "flottants-100.0-et-exposants",
      outil: "chart_line",
      args: '{"data":[{"x":"a","v":100.0,"w":1e2},{"x":"b","v":-0.0,"w":2.50}]}',
    },
    {
      nom: "entier-long",
      outil: "chart_bar",
      args: '{"data":[{"m":"a","v":12345678901234567890},{"m":"b","v":2}]}',
    },
    {
      nom: "entier-2^53+1",
      outil: "chart_table",
      args: '{"data":[{"m":"a","v":9007199254740993},{"m":"b","v":1.5}]}',
    },
    { nom: "nan", outil: "chart_bar", args: '{"data":[{"m":"a","v":NaN},{"m":"b","v":2}]}' },
    { nom: "infini", outil: "chart_table", args: '{"data":[{"m":"a","v":Infinity},{"m":"b","v":2}]}' },
    {
      nom: "flottant-en-cle-lignes",
      outil: "chart_bar",
      args: '{"data":[{"m":"a","v":3},{"m":"b","v":4}],"lines":[{"value":3.0,"label":"cible"}]}',
    },
    {
      nom: "jauge-flottants",
      outil: "chart_gauge",
      args: '{"data":[{"indicateur":"Dispo","valeur":99.0,"max":100.0}],"unit":"%"}',
    },
    {
      nom: "titre-demi-paire",
      outil: "chart_bar",
      args: '{"data":[{"m":"a","v":1},{"m":"b","v":2}],"title":"\\ud800"}',
    },
    { nom: "donnee-demi-paire", outil: "chart_table", args: '{"data":[{"m":"\\udc00","v":1}]}' },
    { nom: "validation-data-absente", outil: "chart_bar", args: {} },
    { nom: "validation-argument-inconnu", outil: "chart_bar", args: { data: VENTES, palette: "x" } },
    {
      nom: "validation-argument-d-un-autre-type",
      outil: "chart_pie",
      args: { data: VENTES, stack: "stacked" },
    },
    { nom: "validation-titre-numerique", outil: "chart_bar", args: { data: VENTES, title: 5 } },
    { nom: "validation-titre-nul", outil: "chart_bar", args: { data: VENTES, title: null } },
    {
      nom: "validation-booleen-invalide",
      outil: "chart_bar",
      args: { data: VENTES, horizontal: "peut-etre" },
    },
    { nom: "validation-booleen-2", outil: "chart_bar", args: { data: VENTES, show_values: 2 } },
    {
      nom: "validation-booleen-flottant",
      outil: "chart_bar",
      args: '{"data":[{"m":"a","v":1}],"trend":1.0}',
    },
    { nom: "validation-plusieurs-erreurs", outil: "chart_bar", args: { title: 1, horizontal: [], truc: 1 } },
    { nom: "arguments-liste", outil: "chart_bar", args: [1] },
    { nom: "outil-inconnu", outil: "chart_nope", args: { data: VENTES } },
    {
      nom: "trop-de-lignes",
      outil: "chart_line",
      args: { data: Array.from({ length: 7 }, (_, i) => ({ x: i, y: i })) },
    },
    {
      nom: "trop-de-cellules",
      outil: "chart_table",
      args: {
        data: Array.from({ length: 5 }, () =>
          Object.fromEntries(Array.from({ length: 9 }, (_, k) => [`c${k}`, k])),
        ),
      },
    },
    {
      nom: "limites-respectees",
      outil: "chart_table",
      args: { data: Array.from({ length: 6 }, (_, i) => ({ a: i, b: i })) },
    },
    {
      nom: "donnees-dict-non-bornees",
      outil: "chart_pie",
      args: { data: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i + 1])) },
    },
    { nom: "texte-en-donnees", outil: "chart_pie", args: { data: "Nord;3\nSud;5" } },
    {
      nom: "sankey-boucle",
      outil: "chart_sankey",
      args: {
        data: [
          { source: "A", target: "B", value: 1 },
          { source: "B", target: "A", value: 1 },
        ],
      },
    },
    {
      nom: "heatmap-dimension-fusionnee",
      outil: "chart_heatmap",
      args: {
        data: [
          { jour: "Lundi matin", appels: 12 },
          { jour: "Lundi après-midi", appels: 9 },
          { jour: "Mardi matin", appels: 15 },
          { jour: "Mardi après-midi", appels: 8 },
        ],
      },
    },
  ];
}

/** Un appel par type d'`EXEMPLES`, puis les variantes. */
export function appelsTousTypes(): Appel[] {
  return [
    ...Object.entries(EXEMPLES).map(([type, args]): Appel => ({
      nom: `type-${type}`,
      outil: `chart_${type}`,
      args,
    })),
    ...appelsVaries(),
  ];
}

function appelJsonRpc(id: number, a: Appel): unknown {
  const meta = a.meta === undefined ? META : a.meta;
  if (typeof a.args === "string") {
    const m = meta === null ? "" : `,"_meta":${JSON.stringify(meta)}`;
    return `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":${JSON.stringify(a.outil)},"arguments":${a.args}${m}}}`;
  }
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: a.outil, arguments: a.args, ...(meta === null ? {} : { _meta: meta }) },
  };
}

/** Étapes de `etapesHttp` avant le premier appel d'outil (initialize, notification, listes, lectures invalides). */
export const ETAPES_AVANT_APPELS = 10;

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "chart", version: "1" } },
};
const NOTIF = { jsonrpc: "2.0", method: "notifications/initialized" };

const req = (id: number, methode: string, params?: unknown): unknown => ({
  jsonrpc: "2.0",
  id,
  method: methode,
  ...(params === undefined ? {} : { params }),
});

/** Étapes HTTP streamable : liste des outils, 30 types, variantes, puis ressources (gabarits, lectures, URI invalides). */
export function etapesHttp(appels: readonly Appel[], idExistant: string | null = null): Etape[] {
  const S = { ...J, ...A, "mcp-session-id": "$sid:c", "mcp-protocol-version": "2025-06-18" };
  const post = (corps: unknown): Etape => ({ m: "POST", u: "/mcp/chart", h: S, corps });
  const uris = [
    "chart://alice/ABC",
    "chart://alice",
    "nope",
    "",
    "chart://a/b/c",
    "chart://alice/%41bc?x=1",
    "file:///etc/passwd",
    "chart://alice/ab c",
    "chart://al ice/x",
    "chart://%C3%A9/x",
    "chart://alice/é",
    "chart://alice/..",
    "chart://alice/a%2Fb",
    "CHART://alice/x",
    "chart://alice/abc#frag",
    "chart:alice",
  ];
  const etapes: Etape[] = [
    { m: "POST", u: "/mcp/chart", h: { ...J, ...A }, corps: INIT, garder: "c" },
    post(NOTIF),
    post(req(2, "tools/list")),
    post(req(3, "resources/templates/list")),
    post(req(4, "resources/list")),
    post(req(5, "resources/templates/list", { cursor: "zzz" })),
    post(req(6, "resources/templates/list", { cursor: "eyJvIjogMX0=" })),
    post(req(7, "resources/list", { cursor: "zzz" })),
    post(req(8, "resources/read", {})),
    post(req(9, "resources/read", { uri: 5 })),
  ];
  appels.forEach((a, i) => etapes.push(post(appelJsonRpc(100 + i, a))));
  uris.forEach((uri, i) => etapes.push(post(req(500 + i, "resources/read", { uri }))));
  if (idExistant !== null)
    etapes.push(post(req(600, "resources/read", { uri: `chart://alice/${idExistant}` })));
  return etapes;
}

/** Corps SSE que pydantic refuse (400 « Could not parse message » puis notification d'erreur sur le flux) : BOM, demi-paire de substitution. */
export const CORPS_SSE_REFUSES: readonly string[] = [
  '\ufeff{"jsonrpc":"2.0","id":700,"method":"ping"}',
  '{"jsonrpc":"2.0","id":701,"method":"tools/call","params":{"name":"chart_bar","arguments":{"data":[{"m":"a","v":1}],"title":"\\ud800"}}}',
];

/** Étapes SSE : quelques appels (flottants compris) sur le flux, réponses lues une à une, puis les corps refusés. */
export function etapesSse(appels: readonly Appel[]): Etape[] {
  const H = { ...A, "content-type": "application/json" };
  const etapes: Etape[] = [
    { sse: "/sse/chart", h: { ...A, accept: "text/event-stream" }, nom: "e" },
    { m: "POST", u: "$ep:e", h: H, corps: INIT },
    { lire: "e", n: 1 },
    { m: "POST", u: "$ep:e", h: H, corps: NOTIF },
    { m: "POST", u: "$ep:e", h: H, corps: req(2, "resources/templates/list") },
    { lire: "e", n: 1 },
  ];
  appels.forEach((a, i) => {
    etapes.push({ m: "POST", u: "$ep:e", h: H, corps: appelJsonRpc(100 + i, a) }, { lire: "e", n: 1 });
  });
  for (const corps of CORPS_SSE_REFUSES)
    etapes.push({ m: "POST", u: "$ep:e", h: H, corps }, { lire: "e", n: 1 });
  etapes.push(
    { m: "POST", u: "$ep:e", h: H, corps: req(900, "resources/read", { uri: "chart://alice/ABC" }) },
    { lire: "e", n: 1 },
    { fermer: "e" },
  );
  return etapes;
}
