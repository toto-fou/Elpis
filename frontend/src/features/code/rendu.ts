// SPDX-License-Identifier: MIT
/** frontend/src/features/code/rendu.ts — rendu du transcript opencode : diff unifié en fichiers colorisés, parts brutes en éléments typés (texte, réflexion, outil, étape, sous-agent, patch…), lecture défensive. */

import { fmtElapsedMs } from "../../utils/utils-purs";

export const PLIAGE_DIFF = 12;
/** Au-delà, aucune carte n'est fabriquée : un fichier binaire ou minifié gèlerait l'onglet. */
export const TAILLE_DIFF_MAX = 200000;

export interface LigneDiff {
  t: "hunk" | "add" | "del" | "ctx";
  text: string;
}

export interface FichierDiff {
  path: string;
  additions: number;
  deletions: number;
  lines: LigneDiff[];
}

type Dict = Record<string, unknown>;

/** Part opencode brute : le schéma exact dépend de la version de la CLI, tout accès reste défensif. */
export interface PartOpencode extends Dict {
  id?: string;
  type?: string;
  tool?: string;
  name?: string;
  text?: string;
  reasoning?: string;
  synthetic?: boolean;
  time?: Dict;
  state?: Dict;
  metadata?: Dict;
}

export interface InfoMessage extends Dict {
  note?: { kind?: string; label?: string; detail?: string };
}

export interface MessageOpencode {
  id: string;
  role: string;
  parts: PartOpencode[];
  info: InfoMessage;
  pending?: boolean;
  _rev?: number;
}

export type ElementRendu =
  | { kind: "text"; id: string; text: string; heavy: boolean; live?: boolean }
  | { kind: "diff"; id: string; text: string }
  | { kind: "think"; id: string; text: string; done: boolean; meta: string }
  | ElementOutil
  | { kind: "step"; id: string }
  | { kind: "subtask"; id: string; agent: string; desc: string; prompt: string; model: string }
  | { kind: "compaction"; id: string; label: string }
  | { kind: "retry"; id: string; attempt: number; detail: string }
  | { kind: "patch"; id: string; files: string[]; diff: string; label: string }
  | { kind: "file"; id: string; filename: string }
  | { kind: "unknown"; id: string; type: string }
  | { kind: "status"; id: string; phase: string; since: number };

export interface TacheOutil {
  text: string;
  status: string;
}

export interface ElementOutil {
  kind: "tool";
  id: string;
  tool: string;
  status: string;
  running: boolean;
  error: boolean;
  icon: string;
  subject: string;
  metric: string;
  metricTone: string;
  todos: TacheOutil[] | null;
  input: Dict | null;
  output: string;
  errText: string;
  diff: string;
  outDiff: string;
  dur: string;
  hasDetail: boolean;
}

const cacheDiff = new Map<string, FichierDiff[]>();

/** Diff unifié (déjà calculé par opencode) → fichiers colorisés, mis en cache par (id de part, longueur). */
export function analyserDiff(id: string, text: string): FichierDiff[] {
  if (!text) return [];
  const cle = `${id}:${text.length}`;
  const hit = cacheDiff.get(cle);
  if (hit) return hit;
  const fichiers: FichierDiff[] = [];
  let cur: FichierDiff | null = null;
  const ouvrir = (path: string): FichierDiff => {
    const f: FichierDiff = { path: path || "", additions: 0, deletions: 0, lines: [] };
    fichiers.push(f);
    return f;
  };
  const lignes = String(text).split("\n");
  while (lignes.length && lignes[lignes.length - 1] === "") lignes.pop();
  for (const ln of lignes) {
    if (ln.startsWith("diff --git ")) {
      const m = ln.match(/ b\/(\S+)\s*$/);
      cur = ouvrir(m?.[1] ?? "");
      continue;
    }
    if (ln.startsWith("--- ")) {
      if (!cur) cur = ouvrir("");
      continue;
    }
    if (ln.startsWith("+++ ")) {
      if (!cur) cur = ouvrir("");
      if (!cur.path) {
        const pth = ln
          .slice(4)
          .trim()
          .replace(/^b\//, "")
          .replace(/^"(.*)"$/, "$1");
        if (pth !== "/dev/null") cur.path = pth;
      }
      continue;
    }
    if (!cur) cur = ouvrir("");
    if (ln.startsWith("@@")) {
      cur.lines.push({ t: "hunk", text: ln });
      continue;
    }
    if (ln.startsWith("+")) {
      cur.additions++;
      cur.lines.push({ t: "add", text: ln });
      continue;
    }
    if (ln.startsWith("-")) {
      cur.deletions++;
      cur.lines.push({ t: "del", text: ln });
      continue;
    }
    cur.lines.push({ t: "ctx", text: ln });
  }
  const propres = fichiers.filter((f) => f.lines.length || f.path);
  if (cacheDiff.size > 60) cacheDiff.clear();
  cacheDiff.set(cle, propres);
  return propres;
}

export function classeLigneDiff(t: string): string {
  return t === "add"
    ? "elpis-code-diff-add"
    : t === "del"
      ? "elpis-code-diff-del"
      : t === "hunk"
        ? "elpis-code-diff-hunk"
        : "";
}

/** Table littérale des icônes : un outil inconnu (serveur MCP de la CLI) reste lisible par l'icône de repli. */
const ICONES_OUTILS: Readonly<Record<string, string>> = {
  edit: "ph-pencil-simple",
  multiedit: "ph-pencil-simple",
  patch: "ph-git-diff",
  write: "ph-file-plus",
  read: "ph-file-text",
  bash: "ph-terminal",
  grep: "ph-magnifying-glass",
  glob: "ph-funnel",
  list: "ph-folder-open",
  todowrite: "ph-list-checks",
  todoread: "ph-list-checks",
  task: "ph-robot",
  webfetch: "ph-globe",
  websearch: "ph-globe",
};
const ICONE_REPLI = "ph-wrench";

function dureeLisible(ms: number): string {
  if (!(ms > 0)) return "";
  return fmtElapsedMs(ms, { precise: true });
}

export function formaterValeur(v: unknown): string {
  let s: string;
  if (typeof v === "string") s = v;
  else {
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
  }
  return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
}

export function libelleOutil(status: string): string {
  return status === "completed"
    ? "terminé"
    : status === "error"
      ? "erreur"
      : status === "running"
        ? "en cours"
        : "en attente";
}

/** Blocs ```diff fermés d'un texte markdown → segments alternés texte et diff ; une fence ouverte (flux) reste du texte. */
export function decouperFencesDiff(text: string): Array<{ text: string; diff?: true }> {
  const re = /```diff[ \t]*\n([\s\S]*?)\n?```/g;
  const sortie: Array<{ text: string; diff?: true }> = [];
  let dernier = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > dernier) sortie.push({ text: text.slice(dernier, m.index) });
    sortie.push({ diff: true, text: m[1] ?? "" });
    dernier = m.index + m[0].length;
  }
  if (dernier < text.length) sortie.push({ text: text.slice(dernier) });
  return sortie;
}

/** Une sortie d'outil EST-elle un diff unifié (git diff) : en-tête de diff en première ligne non vide et marqueurs +++ et @@. */
export function ressembleADiff(s: string): boolean {
  const i = s.search(/\S/);
  if (i < 0) return false;
  const debut = s.lastIndexOf("\n", i) + 1;
  const nl = s.indexOf("\n", i);
  const premiere = s.slice(debut, nl < 0 ? s.length : nl);
  if (!(premiere.startsWith("diff --git ") || premiere.startsWith("--- "))) return false;
  return /^\+\+\+ /m.test(s) && /^@@/m.test(s);
}

const memoOutils = new WeakMap<object, ElementOutil>();

const chaine = (v: unknown): string => (typeof v === "string" ? v : "");
const nombre = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : 0);
const dict = (v: unknown): Dict => (v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : {});

/** Première ligne, tronquée : une commande shell multi-lignes ne doit pas faire exploser la conversation. */
function premiereLigne(s: unknown, max: number): string {
  const t =
    String(s == null ? "" : s)
      .split("\n")[0]
      ?.trim() ?? "";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Un « write » n'a pas de diff côté opencode : on en fabrique un, tout en ajouts. */
function diffEcriture(path: string, content: unknown): string {
  if (typeof content !== "string" || !content || content.length > TAILLE_DIFF_MAX) return "";
  const lignes = content.split("\n");
  if (lignes.length && lignes[lignes.length - 1] === "") lignes.pop();
  return `--- /dev/null\n+++ b/${path || "fichier"}\n@@ -0,0 +1,${lignes.length} @@\n${lignes.map((l) => `+${l}`).join("\n")}`;
}

interface VueOutil {
  icon: string;
  subject: string;
  metric: string;
  metricTone: string;
  todos: TacheOutil[] | null;
  diff: string;
}

/** Nom, sujet et métrique d'un appel d'outil : les trois informations que le TUI met sur une ligne. */
function vueOutil(
  tool: string,
  st: Dict,
  md: Dict,
  input: Dict | null,
  status: string,
  durMs: number,
): VueOutil {
  const nom = tool || "outil";
  const inp = input || {};
  const fd = md["filediff"] && typeof md["filediff"] === "object" ? (md["filediff"] as Dict) : null;
  let subject = "";
  let metric = "";
  let metricTone = "";
  let todos: TacheOutil[] | null = null;
  let diff = "";

  if (nom === "edit" || nom === "multiedit" || nom === "patch") {
    subject = chaine(md["filepath"]) || (fd ? chaine(fd["file"]) : "") || chaine(inp["filePath"]);
    diff = chaine(md["diff"]);
    if (fd) metric = `+${nombre(fd["additions"])} −${nombre(fd["deletions"])}`;
  } else if (nom === "write") {
    subject = chaine(md["filepath"]) || chaine(inp["filePath"]);
    diff = chaine(md["diff"]) || (status === "completed" ? diffEcriture(subject, inp["content"]) : "");
    if (!diff && typeof inp["content"] === "string") metric = `+${String(inp["content"].split("\n").length)}`;
  } else if (nom === "bash") {
    subject = premiereLigne(chaine(md["command"]) || chaine(inp["command"]), 120);
    const code = nombre(md["exitCode"] !== undefined ? md["exitCode"] : md["exit"]);
    if (code) {
      metric = `exit ${code}`;
      metricTone = "elpis-code-metric-err";
    } else if (md["truncated"]) metric = "tronqué";
  } else if (nom === "grep") {
    subject = premiereLigne(chaine(md["pattern"]) || chaine(inp["pattern"]), 80);
    const n = nombre(md["matches"] !== undefined ? md["matches"] : md["count"]);
    if (n) metric = n + (md["truncated"] ? "+" : "") + (n > 1 ? " résultats" : " résultat");
  } else if (nom === "glob" || nom === "list") {
    subject = premiereLigne(
      chaine(md["pattern"]) || chaine(md["path"]) || chaine(md["root"]) || chaine(inp["path"]),
      80,
    );
    const n = nombre(md["count"]);
    if (n) metric = n + (md["truncated"] ? "+" : "");
  } else if (nom === "read") {
    subject = chaine(md["filepath"]) || chaine(inp["filePath"]);
  } else if (nom === "todowrite" || nom === "todoread") {
    const liste = Array.isArray(md["todos"])
      ? (md["todos"] as unknown[])
      : Array.isArray(inp["todos"])
        ? (inp["todos"] as unknown[])
        : [];
    if (liste.length) {
      todos = liste.map((t) => {
        const d = dict(t);
        return {
          text: premiereLigne(d["content"] || d["text"] || "", 90),
          status: chaine(d["status"]) || "pending",
        };
      });
      metric = `${todos.filter((t) => t.status === "completed").length}/${todos.length}`;
    }
  } else if (nom === "task") {
    subject = premiereLigne(chaine(md["description"]) || chaine(inp["description"]), 90);
    metric = chaine(md["subagent_type"]) || chaine(inp["subagent_type"]);
  } else if (nom === "webfetch" || nom === "websearch") {
    subject = premiereLigne(
      chaine(md["url"]) || chaine(md["query"]) || chaine(inp["url"]) || chaine(inp["query"]),
      90,
    );
    metric = chaine(md["format"]);
  }

  if (!subject) subject = chaine(st["title"]);
  if (!metric && status !== "running" && status !== "pending") metric = dureeLisible(durMs);
  return { icon: ICONES_OUTILS[nom] || ICONE_REPLI, subject, metric, metricTone, todos, diff };
}

/** Parts d'un message → éléments typés ; `live` ajoute le statut d'activité (phase réelle et durée) au message que la CLI écrit. */
export function etapes(m: MessageOpencode | null | undefined, live?: boolean): ElementRendu[] {
  const info = dict(m?.info);
  const msgDone = !!dict(info["time"])["completed"];
  const parts = m?.parts ?? [];
  const sortie: ElementRendu[] = [];
  let vuEtape = false;
  let phase = "";
  let depuis = 0;
  for (let i = 0; i < parts.length; i++) {
    const p: PartOpencode = parts[i] ?? {};
    if (p.synthetic) continue;
    const type = p.type || (p.tool ? "tool" : "");
    const id = p.id || `${type}:${i}`;
    if (type === "text") {
      if (!p.text) continue;
      phase = "Rédaction";
      depuis = (p.time && typeof p.time === "object" ? nombre(p.time["start"]) : 0) || 0;
      const enFlux = !msgDone;
      const lourd = enFlux && p.text.length > 100000;
      if (!lourd && m?.role !== "user" && p.text.indexOf("```diff") !== -1) {
        const segs = decouperFencesDiff(p.text);
        if (segs.some((sg) => sg.diff)) {
          let n = 0;
          for (const sg of segs) {
            if (sg.diff) sortie.push({ kind: "diff", id: `${id}:d${n++}`, text: sg.text });
            else if (sg.text.trim())
              sortie.push({ kind: "text", id: `${id}:t${n++}`, text: sg.text, heavy: false });
          }
          continue;
        }
      }
      sortie.push({ kind: "text", id, text: p.text, heavy: lourd, live: enFlux });
    } else if (type === "reasoning") {
      const txt = p.text || p.reasoning || "";
      if (!txt) continue;
      const pt = dict(p.time);
      const done = !!pt["end"] || msgDone || i < parts.length - 1;
      if (!done) {
        phase = "Réflexion";
        depuis = nombre(pt["start"]);
      }
      sortie.push({
        kind: "think",
        id,
        text: txt,
        done,
        meta: dureeLisible(nombre(pt["end"]) - nombre(pt["start"])),
      });
    } else if (type === "tool" || type === "tool-invocation" || p.tool) {
      const st = dict(p.state);
      const status = chaine(st["status"]) || "pending";
      const fige = status === "completed" || status === "error";
      const memo = fige ? memoOutils.get(p) : undefined;
      if (memo) {
        sortie.push(memo);
        continue;
      }
      const md =
        st["metadata"] && typeof st["metadata"] === "object" ? dict(st["metadata"]) : dict(p.metadata);
      const stt = dict(st["time"]);
      const input =
        st["input"] && typeof st["input"] === "object" && !Array.isArray(st["input"])
          ? dict(st["input"])
          : null;
      const enCours = status === "pending" || status === "running";
      const tool = p.tool || p.name || "outil";
      const durMs = nombre(stt["end"]) - nombre(stt["start"]);
      const vue = vueOutil(tool, st, md, input, status, durMs);
      if (enCours) {
        phase = `outil ${tool}`;
        depuis = nombre(stt["start"]);
      }
      const brut = st["output"];
      const outDiff =
        !vue.diff &&
        status === "completed" &&
        typeof brut === "string" &&
        brut.length <= TAILLE_DIFF_MAX &&
        ressembleADiff(brut)
          ? brut
          : "";
      const output = typeof brut === "string" ? brut : brut ? formaterValeur(brut) : chaine(md["preview"]);
      const element: ElementOutil = {
        kind: "tool",
        id,
        tool,
        status,
        running: enCours,
        error: status === "error",
        icon: vue.icon,
        subject: vue.subject,
        metric: vue.metric,
        metricTone: vue.metricTone,
        todos: vue.todos,
        input,
        output,
        errText: typeof st["error"] === "string" ? st["error"] : "",
        diff: vue.diff,
        outDiff,
        dur: dureeLisible(durMs),
        hasDetail: !!(input || output || outDiff),
      };
      sortie.push(element);
      if (fige) memoOutils.set(p, element);
    } else if (type === "step-start") {
      if (vuEtape) sortie.push({ kind: "step", id });
      vuEtape = true;
    } else if (type === "step-finish") {
      continue;
    } else if (type === "subtask") {
      sortie.push({
        kind: "subtask",
        id,
        agent: chaine(p["agent"]) || "agent",
        desc: premiereLigne(chaine(p["description"]), 120),
        prompt: chaine(p["prompt"]),
        model: p["model"] && typeof p["model"] === "object" ? chaine(dict(p["model"])["modelID"]) : "",
      });
    } else if (type === "compaction") {
      sortie.push({
        kind: "compaction",
        id,
        label: p["overflow"]
          ? "Contexte saturé — compacté"
          : p["auto"]
            ? "Contexte compacté"
            : "Compacté à la demande",
      });
    } else if (type === "retry") {
      const err = p["error"];
      const detail =
        err && typeof err === "object"
          ? chaine(dict(err)["message"]) ||
            chaine(dict(err)["name"]) ||
            chaine(dict(dict(err)["data"])["message"])
          : chaine(err);
      sortie.push({ kind: "retry", id, attempt: nombre(p["attempt"]) || 1, detail });
    } else if (type === "agent" || type === "snapshot") {
      continue;
    } else if (type === "patch") {
      const f = p["files"];
      const fichiers: string[] = (
        Array.isArray(f) ? f : f && typeof f === "object" ? Object.keys(f) : []
      ).map(String);
      let diffs = "";
      if (fichiers.length) {
        const vus = new Set<string>();
        for (const q of parts) {
          const qs = dict(q?.state);
          const qd = chaine(dict(qs["metadata"])["diff"]);
          if (!qd || vus.has(qd)) continue;
          if (fichiers.some((fl) => fl && qd.indexOf(String(fl).split("/").pop() ?? "") !== -1)) {
            vus.add(qd);
            diffs += (diffs ? "\n" : "") + qd;
          }
        }
      }
      sortie.push({
        kind: "patch",
        id,
        files: fichiers,
        diff: diffs,
        label: fichiers.length
          ? `patch · ${fichiers.length} fichier${fichiers.length > 1 ? "s" : ""}`
          : "patch",
      });
    } else if (type === "file") {
      sortie.push({ kind: "file", id, filename: chaine(p["filename"]) || p.name || "fichier" });
    } else if (type) {
      sortie.push({ kind: "unknown", id, type });
    }
  }
  if (live) {
    sortie.push({
      kind: "status",
      id: "status",
      phase: phase || "Génération",
      since: depuis || nombre(dict(info["time"])["created"]),
    });
  }
  return sortie;
}
