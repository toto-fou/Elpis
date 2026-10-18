// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/message/effets.ts — effets d'un message (écritures en mémoire) : lignes tirées des étapes d'outils, détail lu dans le journal des opérations, annulation. */
import type * as Vue from "vue";
import type { Ref } from "vue";

import type { DetailEffet, LigneEffet } from "./types.ts";

export interface EtapeEffet {
  _kind?: string;
  name?: string;
  status?: string;
  _is_error?: boolean;
  args?: Record<string, unknown> | null;
  result?: unknown;
}

export interface LigneMemoire extends LigneEffet {
  action: string;
  store: string;
  title: string;
  storeLabel: string;
  running: boolean;
  error: boolean;
  full: boolean;
  unchanged: boolean;
  op: string;
  content: string;
  target: string;
  message: string;
  fix: string;
}

const LIBELLE_EN_COURS: Readonly<Record<string, string>> = {
  add: "Écriture en mémoire",
  replace: "Mise à jour de la mémoire",
  remove: "Retrait de la mémoire",
  rewrite: "Réorganisation de la mémoire",
};
const LIBELLE_FAIT: Readonly<Record<string, string>> = {
  add: "Mémorisé",
  replace: "Mémoire mise à jour",
  remove: "Retiré de la mémoire",
  rewrite: "Mémoire réorganisée",
};
const LIBELLE_STOCK: Readonly<Record<string, string>> = {
  user: "profil utilisateur",
  memory: "notes projet",
};
// Plafond DOM ; la coupe visuelle sur une ligne est faite par `truncate`.
const MAX_TITRE = 140;

function premiereLigne(s: unknown, n: number): string {
  if (s == null) return "";
  let t = String(s).replace(/\r\n?/g, "\n");
  const nl = t.indexOf("\n");
  if (nl >= 0) t = t.slice(0, nl);
  t = t.trim();
  if (t.length > n)
    t =
      t
        .slice(0, n)
        .replace(/\s+\S*$/, "")
        .trim() + "…";
  return t;
}

export function estEcritureMemoire(step: EtapeEffet | null | undefined): boolean {
  if (!step) return false;
  if (step._kind === "memory") return true;
  if (step.name !== "memory") return false;
  const a = String(step.args?.action || "").toLowerCase();
  return a === "add" || a === "replace" || a === "remove" || a === "rewrite";
}

function estTaches(step: EtapeEffet | null | undefined): boolean {
  return !!step && (step._kind === "todo" || step.name === "todowrite");
}

function resultat(step: EtapeEffet): Record<string, unknown> | null {
  const r = step.result;
  if (r && typeof r === "object") return r as Record<string, unknown>;
  if (typeof r !== "string" || !r) return null;
  try {
    const o: unknown = JSON.parse(r);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Ligne d'une écriture en mémoire ; la clé suit l'opération du journal, sinon la position dans le chat. */
export function ligneMemoire(step: EtapeEffet, idx: number, portee: string): LigneMemoire {
  const args = step.args || {};
  const action = String(args.action || "").toLowerCase();
  const store = String(args.store || "memory").toLowerCase();
  const res = resultat(step);
  const running = step.status === "running";
  const code = res && res.ok === false ? String(res.error || "") : "";
  const full = !running && code === "over_limit";
  const error = !running && !full && (!!step._is_error || !!(res && res.ok === false));
  const op = res && typeof res.op === "string" ? res.op : "";
  const unchanged =
    !running && !error && !full && action === "add" && !!res && res.ok === true && res.op === "";
  const cible = args.target || args.old_text || "";
  const source = action === "remove" ? cible || args.content || "" : args.content || cible;
  const affiche = typeof args.title === "string" && args.title.trim() ? args.title : source;
  let label: string;
  if (running) label = LIBELLE_EN_COURS[action] || "Écriture en mémoire";
  else if (full) label = "Mémoire pleine";
  else if (error) label = "Échec — " + (LIBELLE_EN_COURS[action] || "Écriture en mémoire");
  else if (unchanged) label = "Déjà en mémoire";
  else label = LIBELLE_FAIT[action] || "Mémorisé";
  return {
    kind: "memory",
    key: op ? "mem:" + op : "mem:" + portee + ":" + idx,
    action,
    store,
    title: premiereLigne(affiche, MAX_TITRE),
    label,
    storeLabel: LIBELLE_STOCK[store] || "",
    running,
    error,
    full,
    unchanged,
    op,
    content: typeof args.content === "string" ? args.content : "",
    target: typeof cible === "string" ? cible : "",
    message: res && res.ok === false ? String(res.message || res.error || "") : "",
    fix: res && res.ok === false ? String(res.fix || "") : "",
  };
}

export interface RefsEffets {
  currentChatId?: Ref<string | null>;
}

export interface CtxEffets {
  fetchAuth?: (url: string, options?: Record<string, unknown>, soft?: boolean) => Promise<Response | null>;
  onMemoryChanged?: () => void;
  openSettingsTab?: (onglet: string) => unknown;
}

export interface CartesMemoire {
  effectLinesFor(
    msg: { toolSteps?: readonly EtapeEffet[] | null } | null,
    msgIdx?: number | null,
  ): LigneMemoire[];
  memorySavesFor(
    msg: { toolSteps?: readonly EtapeEffet[] | null } | null,
    msgIdx?: number | null,
  ): LigneMemoire[];
  toolStepsForDisplay<T extends EtapeEffet>(steps: readonly T[] | null | undefined): T[];
  effectIsOpen(line: LigneEffet | null | undefined): boolean;
  effectDetail(line: LigneEffet | null | undefined): DetailEffet | null;
  toggleEffect(line: LigneMemoire | null | undefined): void;
  undoMemoryEffect(line: LigneEffet | null | undefined): Promise<void>;
  manageMemory(): void;
  effectUiRev: Ref<number>;
}

const enregistrement = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object";

async function corps(r: Response): Promise<unknown> {
  try {
    return (await r.json()) as unknown;
  } catch {
    return null;
  }
}

/** Même contrat que l'ancien `setupChatMemoryCard(vue, refs, ctx)` de chat/_memory_card.js. */
export function creerCartesMemoire(
  vue: Pick<typeof Vue, "ref" | "reactive"> | null,
  refs: RefsEffets | null,
  ctx: CtxEffets | null,
): CartesMemoire {
  const ref = vue?.ref ?? (<T>(v: T) => ({ value: v }) as Ref<T>);
  const reactive = vue?.reactive ?? (<T extends object>(o: T) => o);
  const effectUiRev = ref(0);
  const ouverts = reactive<Record<string, boolean>>({});
  const details = reactive<Record<string, DetailEffet>>({});
  // Les lignes sont mémoïsées par la liste : un compteur dit qu'un détail ou une ouverture a changé.
  const signaler = (): void => {
    effectUiRev.value++;
  };
  const lire = (u: string, o?: Record<string, unknown>): Promise<Response | null> =>
    ctx && typeof ctx.fetchAuth === "function"
      ? ctx.fetchAuth(u, o || {}, true)
      : fetch(u, { credentials: "same-origin", ...o });

  function lignes(
    msg: { toolSteps?: readonly EtapeEffet[] | null } | null,
    msgIdx?: number | null,
  ): LigneMemoire[] {
    if (!msg || !Array.isArray(msg.toolSteps)) return [];
    const chat = refs?.currentChatId?.value || "";
    const portee = String(chat) + ":" + (msgIdx == null ? "" : msgIdx);
    const out: LigneMemoire[] = [];
    msg.toolSteps.forEach((step: EtapeEffet, i: number) => {
      if (estEcritureMemoire(step)) out.push(ligneMemoire(step, i, portee));
    });
    return out;
  }

  // Étapes affichées dans le travail : sans écritures mémoire, liste de tâches ni sous-agents (rendus à part).
  function toolStepsForDisplay<T extends EtapeEffet>(steps: readonly T[] | null | undefined): T[] {
    if (!Array.isArray(steps)) return [];
    return steps.filter(
      (s) => !estEcritureMemoire(s) && !estTaches(s) && !(s && (s._kind === "task" || s.name === "task")),
    );
  }

  function effectIsOpen(line: LigneEffet | null | undefined): boolean {
    return !!(line && ouverts[line.key]);
  }

  function effectDetail(line: LigneEffet | null | undefined): DetailEffet | null {
    return (line && line.op && details[line.op]) || null;
  }

  async function chargerDetail(op: string): Promise<void> {
    details[op] = { state: "loading", data: null, error: "" };
    signaler();
    try {
      const r = await lire("/api/memory/ops/" + encodeURIComponent(op));
      if (!r) details[op] = { state: "error", data: null, error: "Détail indisponible (réseau)" };
      else if (!r.ok) {
        const j = await corps(r);
        const msg = enregistrement(j) && j.detail ? String(j.detail) : "Détail indisponible";
        details[op] = { state: "error", data: null, error: msg };
      } else details[op] = { state: "ok", data: (await r.json()) as DetailEffet["data"], error: "" };
    } catch {
      details[op] = { state: "error", data: null, error: "Détail indisponible (réseau)" };
    }
    signaler();
  }

  function toggleEffect(line: LigneMemoire | null | undefined): void {
    if (!line || line.kind !== "memory" || line.running) return;
    ouverts[line.key] = !ouverts[line.key];
    const d = line.op ? details[line.op] : null;
    if (ouverts[line.key] && line.op && (!d || d.state === "error")) void chargerDetail(line.op);
    signaler();
  }

  async function undoMemoryEffect(line: LigneEffet | null | undefined): Promise<void> {
    const op = line?.op;
    if (!op) return;
    const cur: DetailEffet = details[op] || { state: "ok", data: null, error: "" };
    if (cur.undoing) return;
    details[op] = { ...cur, undoing: true, error: "" };
    signaler();
    try {
      const r = await lire("/api/memory/ops/" + encodeURIComponent(op) + "/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const j = r ? await corps(r) : null;
      if (r && r.ok && enregistrement(j) && j.op) {
        details[op] = { state: "ok", data: j.op as DetailEffet["data"], error: "" };
        try {
          ctx?.onMemoryChanged?.();
        } catch {
          /* rafraîchissement best-effort */
        }
      } else {
        const msg = enregistrement(j) && j.detail ? String(j.detail) : "Annulation impossible";
        let data = cur.data;
        try {
          const r2 = await lire("/api/memory/ops/" + encodeURIComponent(op));
          if (r2 && r2.ok) data = (await r2.json()) as DetailEffet["data"];
        } catch {
          /* on garde le détail connu */
        }
        details[op] = {
          state: "ok",
          data,
          undoing: false,
          error: msg.charAt(0).toUpperCase() + msg.slice(1),
        };
      }
    } catch {
      details[op] = { ...cur, undoing: false, error: "Annulation impossible (réseau)" };
    }
    signaler();
  }

  function manageMemory(): void {
    ctx?.openSettingsTab?.("memory");
  }

  return {
    effectLinesFor: lignes,
    memorySavesFor: lignes,
    toolStepsForDisplay,
    effectIsOpen,
    effectDetail,
    toggleEffect,
    undoMemoryEffect,
    manageMemory,
    effectUiRev,
  };
}
