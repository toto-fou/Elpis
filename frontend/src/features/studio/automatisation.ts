// SPDX-License-Identifier: MIT
/** frontend/src/features/studio/automatisation.ts — Studio d'automatisation : le code Python (runtime elpis_auto) est le document ; enregistrement des actions, palette de blocs, aide IA, exécution sur la machine cible, rapport et réparation, persistance dans la sandbox. */
import { computed, ref } from "vue";

import {
  API_CHEATSHEET,
  DEFAULT_TIMEOUT_MS,
  actionStep,
  applyIdentity,
  deleteLineAt,
  elseInsertPoint,
  ensureTimeoutVar,
  extractPythonBlock,
  insertLinesAt,
  makeStep,
  outlineFromCode,
  readTimeoutValue,
  scriptSkeleton,
  setTimeoutValue,
  stepLines,
  timeoutDeclared,
  usesTimeoutVar,
} from "../../modeles/automation-model.ts";
import type { EtapeAuto, LignePlan } from "../../modeles/automation-model.ts";
import {
  anchorFromElement,
  diffElements,
  frameEffect,
  isWindowRole,
  realName,
  resolvePath,
  resultOk,
  scenarioStepFromAct,
  scenarioStepFromDirect,
} from "../../modeles/scenario-model.ts";
import type { Ancre, ElementUi, PasScenario } from "../../modeles/scenario-model.ts";
import type { ActionDirecte, SurfaceDialogueStudio } from "./dialogue.ts";
import type { SurfaceMenuStudio } from "./menu.ts";
import type { LecteurBureau } from "./api.ts";

type Dict = Record<string, unknown>;

/** Éditeur de code minimal (Monaco ou équivalent) : seules les méthodes employées ici. */
export interface EditeurPython {
  getValue(): string;
  setValue(v: string): void;
  getModel(): {
    getValue(): string;
    getEOL(): string;
    getPositionAt(o: number): { lineNumber: number; column: number };
  } | null;
  executeEdits(source: string, edits: unknown[]): unknown;
  pushUndoStop(): void;
  getPosition(): { lineNumber: number; column: number } | null;
  setPosition(p: { lineNumber: number; column: number }): void;
  onDidChangeModelContent(cb: () => void): unknown;
  onDidChangeCursorPosition(cb: (e: { position: { lineNumber: number } }) => void): unknown;
  revealLineInCenterIfOutsideViewport(l: number): void;
  revealLineInCenter(l: number): void;
  focus(): void;
  layout(): void;
  dispose(): void;
}

export interface MonacoMinimal {
  editor: { create(el: HTMLElement, options: Dict): EditeurPython };
}

export interface CtxAutomatisationStudio {
  showToast?: (message: string, type?: string) => void;
  fetchAuth: (url: string, init?: RequestInit, soft?: boolean) => Promise<Response | null>;
  lireJson?: LecteurBureau;
  currentModelId?: () => string | null;
  currentConnectorId?: () => string | number | null;
  /** Chargeur de Monaco, quand `window.monaco` n'est pas déjà posé. */
  chargerMonaco?: () => Promise<MonacoMinimal>;
}

export type DialogueAuto = Partial<
  Pick<
    SurfaceDialogueStudio,
    "registerStudioRecorder" | "askStudioText" | "studioCtxMenu" | "studioTab" | "closeStudioCtx"
  >
>;
export type MenuAuto = Partial<
  Pick<
    SurfaceMenuStudio,
    | "selectedTarget"
    | "studioTargets"
    | "studioMonitor"
    | "studioElements"
    | "studioFrame"
    | "selectedElement"
    | "selectStudioElement"
  >
>;

export interface ScriptSandbox {
  slug: string;
  name: string;
  path: string;
  size?: number;
}

export interface ExecutionAuto {
  run_id: string;
  target: string;
  running: boolean;
  code: number | null;
  report: RapportExecution | null;
  log: unknown[];
  summary: string;
  error: string;
  mode: string;
  started: number;
  sent_code: string;
  matrix?: MatriceExecution | null;
  warning?: string;
  poll_errors?: number;
  report_dir?: string;
}

export interface EtapeRapport extends Dict {
  line?: number;
  index?: number;
  label?: string;
  error?: string;
  ok?: boolean;
  dry?: boolean;
  ms?: number;
  method?: string;
  waited_ms?: number;
  resolved_by?: string;
  screenshot?: string;
  trace_png?: string;
  healed?: { suggest?: string } & Dict;
  trace_tree?: string;
}

export interface RapportExecution extends Dict {
  summary?: string;
  steps?: EtapeRapport[];
  healed?: unknown[];
}

export interface ResultatMachine {
  target?: string;
  ok?: boolean;
  summary?: string;
  message?: string;
  error?: string;
  duration_s?: number;
}

export interface MatriceExecution extends Dict {
  results?: ResultatMachine[];
}

const RAIL_DEFAUT = 560;
const RAIL_MIN = 420;
const CODE_PCT_DEFAUT = 50;
const ATTENTE_DEFAUT_S = Math.round(DEFAULT_TIMEOUT_MS / 1000);
const ATTENTE_MAX_S = 3600;
const DOSSIER = "automations";

const PREFIXE_COMPOSITION = [
  "[Mode composition d'un script : tes actions sont ENREGISTRÉES comme lignes Python.]",
  "Agis PAS À PAS : une action à la fois, puis observe (desktop_observe) pour vérifier son effet avant la suivante.",
  "Vise les éléments exposés (auto_id, sinon nom + rôle) ; n'invente aucun élément ; si une étape échoue, dis-le et propose une autre voie.",
  "À la fin, résume les étapes accomplies.",
].join("\n");

function lireNombre(cle: string, defaut: number): number {
  try {
    const v = Number(localStorage.getItem(cle));
    return isFinite(v) && v > 0 ? v : defaut;
  } catch {
    return defaut;
  }
}
function ecrireNombre(cle: string, v: number): void {
  try {
    localStorage.setItem(cle, String(Math.round(v)));
  } catch {
    /* stockage privé ou plein */
  }
}

const jsonOuVide = async (r: Response | null): Promise<Dict> =>
  r ? ((await r.json().catch(() => ({}))) as Dict) : {};

/** Éléments joints au résultat d'un `desktop_act` : le serveur coupe `result` à 2000 caractères, on lit d'abord `ev.desktop`. */
function elementsDe(ev: Dict | null | undefined): ElementUi[] {
  if (!ev) return [];
  const d = ev["desktop"] as Dict | undefined;
  if (d && Array.isArray(d["elements"])) return d["elements"] as ElementUi[];
  let obj = ev["result"];
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return [];
    }
  }
  const els = obj && typeof obj === "object" ? (obj as Dict)["elements"] : null;
  return Array.isArray(els) ? (els as ElementUi[]) : [];
}

function sigDe(result: unknown): string {
  if (!result) return "";
  if (typeof result === "object") return String((result as Dict)["sig"] || "");
  try {
    return String(((JSON.parse(String(result)) as Dict) || {})["sig"] || "");
  } catch {
    return "";
  }
}
function sigDeEvenement(ev: Dict | null | undefined): string {
  const d = ev && (ev["desktop"] as Dict | undefined);
  return (d && String(d["sig"] || "")) || sigDe(ev && ev["result"]);
}

function slugDe(name: string): string {
  return (
    String(name || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "automatisation"
  );
}

function parcourir(items: unknown, sortie: Dict[]): Dict[] {
  for (const it of (items as Dict[] | null | undefined) || []) {
    if (!it) continue;
    if (Array.isArray(it["children"])) parcourir(it["children"], sortie);
    else sortie.push(it);
  }
  return sortie;
}

const libelleElements = (els: readonly ElementUi[]): string =>
  els
    .slice(0, 80)
    .map((e) => `- ${e.role || "?"} · ${e.label || ""}${e.auto_id ? ` · ${e.auto_id}` : ""}`)
    .join("\n") || "- (aucune capture)";

export function creerAutomatisationStudio(
  ctx: CtxAutomatisationStudio,
  studioMenu: MenuAuto | null | undefined,
  studioChat: DialogueAuto | null | undefined,
) {
  const { fetchAuth } = ctx;
  const lireJson: LecteurBureau = ctx.lireJson ?? ((r) => jsonOuVide(r));
  const toast = (m: string, t?: string): void => ctx.showToast?.(m, t);
  const menu: MenuAuto = studioMenu || {};
  const chat: DialogueAuto = studioChat || {};

  const autoCode = ref("");
  const autoName = ref("");
  const autoRecording = ref(false);
  const autoIgnored = ref(0);
  const autoScripts = ref<ScriptSandbox[]>([]);
  const autoListOpen = ref(true);
  const autoSaving = ref(false);
  const autoLoading = ref(false);
  const autoCurrent = ref("");
  const autoDirty = ref(false);
  const autoEditorReady = ref(false);
  const autoCursorLine = ref(-1);
  const autoAiPrompt = ref("");
  const autoAiBusy = ref(false);
  const autoAiLast = ref("");
  const autoHelpOpen = ref(false);
  const autoClearArmed = ref(false);

  interface ActionEnVol {
    args: Dict;
    before: ElementUi[];
  }
  let actionEnVol: Dict | null = null;
  let avantAction: ElementUi[] = [];
  // Plusieurs `desktop_act` partent dans le même tour (tous les appels avant les résultats) : attribués par call_id.
  const actionsEnVol = new Map<string, ActionEnVol>();

  const autoComposeOn = ref(false);
  let compositionArmeRec = false;
  function toggleAutoCompose(): void {
    autoComposeOn.value = !autoComposeOn.value;
    if (autoComposeOn.value) {
      compositionArmeRec = !autoRecording.value;
      if (!autoRecording.value) toggleAutoRecording();
      if (chat.studioTab) chat.studioTab.value = "assistant";
    } else if (compositionArmeRec && autoRecording.value) {
      toggleAutoRecording();
      compositionArmeRec = false;
    }
  }
  let derniereSig = "";
  let minuterieArme: ReturnType<typeof setTimeout> | null = null;
  let editeur: EditeurPython | null = null;
  let elementEditeur: HTMLElement | null = null;
  let abandonIa: AbortController | null = null;
  let supprimerChangement = false;

  const autoRailWidth = ref(lireNombre("studioRailWidth", RAIL_DEFAUT));
  const autoCodePct = ref(lireNombre("studioCodePct", CODE_PCT_DEFAUT));
  function autoSetRailWidth(px?: unknown, largeurFenetre?: number): number {
    const vw = Number(largeurFenetre || (typeof window !== "undefined" && window.innerWidth) || 1600);
    const max = Math.max(RAIL_MIN, vw - 360);
    autoRailWidth.value = Math.round(Math.max(RAIL_MIN, Math.min(max, Number(px) || RAIL_DEFAUT)));
    return autoRailWidth.value;
  }
  function autoSetCodePct(pct: unknown): number {
    autoCodePct.value = Math.round(Math.max(15, Math.min(85, Number(pct) || CODE_PCT_DEFAUT)));
    return autoCodePct.value;
  }
  function autoRailReset(): void {
    autoSetRailWidth(RAIL_DEFAUT);
    ecrireNombre("studioRailWidth", autoRailWidth.value);
  }

  const prefAttente = ref(lireNombre("studioWaitSec", ATTENTE_DEFAUT_S));
  const autoWaitSec = computed(() => {
    const v = readTimeoutValue(autoCode.value);
    return v != null && v > 0 ? v : prefAttente.value;
  });
  function autoSetWaitSec(v: unknown): number {
    const n = Math.round(Number(v));
    const sec = isFinite(n) && n > 0 ? Math.min(ATTENTE_MAX_S, n) : ATTENTE_DEFAUT_S;
    prefAttente.value = sec;
    ecrireNombre("studioWaitSec", sec);
    if (autoCode.value) {
      const suivant = setTimeoutValue(autoCode.value, sec);
      if (suivant !== autoCode.value) {
        ecrireCode(suivant, true);
        autoDirty.value = true;
      } else if (readTimeoutValue(autoCode.value) == null && timeoutDeclared(autoCode.value)) {
        toast("TIMEOUT est calculé dans le code : modifie sa ligne", "error");
      }
    }
    return sec;
  }
  /** Un bloc qui utilise `TIMEOUT` dans un script qui ne la déclare pas : on la déclare (sinon NameError à la première attente) ; rend le nombre de lignes ajoutées. */
  function garantirTimeout(): number {
    const code = String(autoCode.value || "");
    if (timeoutDeclared(code) || !usesTimeoutVar(code)) return 0;
    const suivant = ensureTimeoutVar(code, prefAttente.value);
    if (suivant === code) return 0;
    ecrireCode(suivant, true);
    autoDirty.value = true;
    return suivant.split("\n").length - code.split("\n").length;
  }
  const dureePauseMs = (): number =>
    Math.max(1, Math.min(ATTENTE_MAX_S, Number(autoWaitSec.value) || ATTENTE_DEFAUT_S)) * 1000;

  function autoRailDragStart(ev: PointerEvent): void {
    if (!ev || ev.button) return;
    const startX = ev.clientX;
    const startW = autoRailWidth.value;
    const el = ev.currentTarget as HTMLElement;
    const move = (e: PointerEvent): void => {
      autoSetRailWidth(startW + (startX - e.clientX));
      mettreEnPage();
    };
    const up = (): void => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      ecrireNombre("studioRailWidth", autoRailWidth.value);
      mettreEnPage();
    };
    try {
      el.setPointerCapture(ev.pointerId);
    } catch {
      /* ancien navigateur */
    }
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    ev.preventDefault();
  }

  const cible = (): string => menu.selectedTarget?.value || "";
  function osCible(): string {
    const t = cible();
    const hit = (menu.studioTargets?.value || []).find((x) => x && x.name === t);
    return (hit && hit.os) || "";
  }
  const moniteur = (): number => Number(menu.studioMonitor?.value || 0);
  const elements = (): ElementUi[] => menu.studioElements?.value || [];
  const elementChoisi = (): ElementUi | null => menu.selectedElement?.value || null;
  const autoSlug = computed(() => slugDe(autoName.value));

  let planFige: string | null = null;
  let minuteriePlan: ReturnType<typeof setTimeout> | null = null;
  let planPrecedent: LignePlan[] = [];
  const planKick = ref(0);
  const autoOutline = computed<LignePlan[]>(() => {
    void planKick.value;
    const rows = outlineFromCode(planFige !== null ? planFige : autoCode.value);
    const identique =
      rows.length === planPrecedent.length &&
      rows.every((r, i) => {
        const p = planPrecedent[i];
        return (
          !!p &&
          p.line === r.line &&
          p.text === r.text &&
          p.indent === r.indent &&
          p.kind === r.kind &&
          p.anchor === r.anchor
        );
      });
    if (!identique) planPrecedent = rows;
    return planPrecedent;
  });
  function liberePlan(): void {
    if (minuteriePlan) {
      clearTimeout(minuteriePlan);
      minuteriePlan = null;
    }
    if (planFige !== null) {
      planFige = null;
      planKick.value++;
    }
  }
  const autoNeedsVision = computed(() => /s\.(wait|expect)\.text\(|s\.sees\(/.test(autoCode.value));
  const autoLineCount = computed(() => autoOutline.value.length);
  const API_HELP = API_CHEATSHEET;

  /** `reset` : un autre document (ouvrir, nouveau), historique d'annulation remis à zéro ; sinon une édition annulable de la seule partie qui change. */
  function ecrireCode(code: string, garderCurseur?: boolean, reset?: boolean): void {
    liberePlan();
    autoCode.value = code;
    if (!editeur) return;
    supprimerChangement = true;
    try {
      const model = editeur.getModel ? editeur.getModel() : null;
      const ancien = model ? model.getValue() : "";
      if (reset || !model || model.getEOL() !== "\n" || typeof editeur.executeEdits !== "function") {
        const pos = garderCurseur ? editeur.getPosition() : null;
        editeur.setValue(code);
        if (pos) editeur.setPosition(pos);
        return;
      }
      if (ancien === code) return;
      let a = 0;
      const max = Math.min(ancien.length, code.length);
      while (a < max && ancien.charCodeAt(a) === code.charCodeAt(a)) a++;
      let b = 0;
      while (b < max - a && ancien.charCodeAt(ancien.length - 1 - b) === code.charCodeAt(code.length - 1 - b))
        b++;
      const s = model.getPositionAt(a);
      const e = model.getPositionAt(ancien.length - b);
      editeur.pushUndoStop();
      editeur.executeEdits("studio", [
        {
          range: {
            startLineNumber: s.lineNumber,
            startColumn: s.column,
            endLineNumber: e.lineNumber,
            endColumn: e.column,
          },
          text: code.slice(a, code.length - b),
          forceMoveMarkers: true,
        },
      ]);
      editeur.pushUndoStop();
    } finally {
      supprimerChangement = false;
    }
  }
  function ligneCurseur(): number {
    if (editeur) {
      const p = editeur.getPosition();
      return p ? p.lineNumber - 1 : -1;
    }
    return autoCursorLine.value;
  }
  /** Insère les lignes au curseur (voir `insertLinesAt`) et pose le curseur sur la dernière ligne insérée. */
  function autoInsertLines(lines: readonly string[] | null | undefined, indentOverride?: number): number {
    if (!lines || !lines.length) return -1;
    const r = insertLinesAt(autoCode.value, ligneCurseur(), lines, indentOverride);
    ecrireCode(r.code, false);
    if (lines.some((l) => /\bTIMEOUT\b/.test(l))) r.line += garantirTimeout();
    const derniere = r.line + lines.length - 1;
    if (editeur) {
      try {
        editeur.setPosition({ lineNumber: derniere + 1, column: 1e6 });
        editeur.revealLineInCenterIfOutsideViewport(derniere + 1);
      } catch {
        /* éditeur en cours de démontage */
      }
    } else {
      autoCursorLine.value = derniere;
    }
    autoDirty.value = true;
    return r.line;
  }
  function autoNewCode(): string {
    return scriptSkeleton({
      name: autoName.value || "automatisation",
      target: cible(),
      os: osCible(),
      monitor: moniteur(),
      timeout_s: prefAttente.value || undefined,
    });
  }

  function mettreEnPage(): void {
    if (editeur) {
      try {
        editeur.layout();
      } catch {
        /* démonté */
      }
    }
  }
  async function autoMountEditor(el: HTMLElement | null): Promise<void> {
    elementEditeur = el;
    if (!el || typeof window === "undefined") return;
    try {
      const fen = window as unknown as { monaco?: MonacoMinimal };
      let monaco = fen.monaco;
      if (!monaco) {
        if (!ctx.chargerMonaco) return;
        monaco = await ctx.chargerMonaco();
      }
      if (!monaco || elementEditeur !== el || !el.isConnected) return;
      const ed = monaco.editor.create(el, {
        value: autoCode.value,
        language: "python",
        theme: "vs-dark",
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 12,
        lineHeight: 20,
        scrollBeyondLastLine: false,
        wordWrap: "off",
        tabSize: 4,
        insertSpaces: true,
        padding: { top: 8, bottom: 8 },
        renderWhitespace: "selection",
        lineNumbersMinChars: 3,
      });
      editeur = ed;
      ed.onDidChangeModelContent(() => {
        if (supprimerChangement) return;
        if (planFige === null) planFige = autoCode.value;
        autoCode.value = ed.getValue();
        autoDirty.value = true;
        if (minuteriePlan) clearTimeout(minuteriePlan);
        minuteriePlan = setTimeout(liberePlan, 150);
      });
      ed.onDidChangeCursorPosition((e) => {
        autoCursorLine.value = e.position.lineNumber - 1;
        focaliserAncreDeLigne(e.position.lineNumber - 1);
      });
      (window as unknown as { __studioEditor?: EditeurPython | null }).__studioEditor = ed;
      autoEditorReady.value = true;
    } catch {
      autoEditorReady.value = false;
    }
  }
  function autoUnmountEditor(): void {
    if (editeur) {
      try {
        editeur.dispose();
      } catch {
        /* déjà disposé */
      }
    }
    editeur = null;
    elementEditeur = null;
    autoEditorReady.value = false;
    if (typeof window !== "undefined")
      (window as unknown as { __studioEditor?: EditeurPython | null }).__studioEditor = null;
  }
  function autoOnTextarea(ev: Event): void {
    const t = ev && (ev.target as HTMLTextAreaElement | null);
    autoCode.value = (t && t.value) || "";
    autoDirty.value = true;
    if (t) {
      const avant = String(t.value || "").slice(0, t.selectionStart || 0);
      autoCursorLine.value = avant.split("\n").length - 1;
    }
  }

  /** La ligne courante vise un élément : il est surligné sur la capture. */
  function focaliserAncreDeLigne(i: number): void {
    const ligne = String(autoCode.value || "").split("\n")[i] || "";
    const mId = /auto_id="([^"]+)"/.exec(ligne);
    const mName = /\bname="([^"]+)"/.exec(ligne);
    const mPath = /\bpath="([^"]+)"/.exec(ligne);
    if (!mId && !mName && !mPath) return;
    const els = elements();
    const nomDe = (e: ElementUi): string => realName(e);
    const hit =
      (mId && els.find((e) => e && e.auto_id === mId[1])) ||
      (mPath && resolvePath(els, mPath[1])) ||
      (mName && els.find((e) => e && String(nomDe(e)).toLowerCase() === (mName[1] ?? "").toLowerCase()));
    if (hit && menu.selectStudioElement) {
      try {
        menu.selectStudioElement(hit.id as string | number, true);
      } catch {
        /* scène absente */
      }
    }
  }

  const sigTrame = (): string => menu.studioFrame?.value?.sig || "";
  function enregistrer(step: Partial<PasScenario>, sigApres: string): void {
    const st = actionStep(step);
    st.effect = frameEffect(derniereSig, sigApres);
    const lines = stepLines(st);
    // Le commentaire va sur la ligne d'action, pas sur l'attente qui peut la suivre.
    const k = (lines[0] || "").startsWith("s.snapshot(") ? 1 : 0;
    if (st.effect === "none" && lines[k]) lines[k] += "   # aucun effet visible à l'enregistrement";
    autoInsertLines(lines);
    if (sigApres) derniereSig = sigApres;
  }
  if (chat.registerStudioRecorder) {
    chat.registerStudioRecorder({
      onToolCall(ev) {
        if (!autoRecording.value || !ev || ev["name"] !== "desktop_act") return;
        const pend: ActionEnVol = { args: (ev["args"] as Dict) || {}, before: elements().slice() };
        if (ev["call_id"]) actionsEnVol.set(String(ev["call_id"]), pend);
        actionEnVol = pend.args;
        avantAction = pend.before;
      },
      onToolResult(ev) {
        if (!autoRecording.value || !ev || ev["name"] !== "desktop_act") return;
        let pend: ActionEnVol | null = null;
        const cid = ev["call_id"] ? String(ev["call_id"]) : "";
        if (cid && actionsEnVol.has(cid)) {
          pend = actionsEnVol.get(cid) ?? null;
          actionsEnVol.delete(cid);
        } else if (actionEnVol) {
          pend = { args: actionEnVol, before: avantAction };
        }
        actionEnVol = null;
        avantAction = [];
        if (!pend) return;
        if (!resultOk(ev["result"])) {
          autoIgnored.value++;
          return;
        }
        enregistrer(
          scenarioStepFromAct({ args: pend.args, elements: pend.before.length ? pend.before : elements() }),
          sigDeEvenement(ev),
        );
        // Composer par l'IA : ce qui est apparu après l'action devient une attente nommée (fenêtre d'abord), jamais un rang.
        if (autoComposeOn.value) {
          const apres = elementsDe(ev);
          if (apres.length) {
            const ajoutes = (diffElements(pend.before, apres).added || []).filter(
              (e) => e && (e.auto_id || realName(e) || e.label),
            );
            ajoutes.sort((a, b) => (isWindowRole(b.role) ? 1 : 0) - (isWindowRole(a.role) ? 1 : 0));
            const premier = ajoutes[0];
            if (premier) {
              autoInsertLines(
                stepLines(
                  makeStep("wait", {
                    expect: { kind: "element", anchor: anchorFromElement(premier, apres), query: "" },
                  }),
                ),
              );
            }
          }
        }
      },
      composePrefix() {
        if (!autoComposeOn.value || !autoRecording.value) return "";
        return PREFIXE_COMPOSITION;
      },
      async onDirectAct(info: ActionDirecte) {
        if (!autoRecording.value || !info) return;
        if (!(info.result && resultOk(info.result))) {
          autoIgnored.value++;
          return;
        }
        let step: PasScenario;
        if (info.element) {
          step = scenarioStepFromDirect({
            op: info.op,
            element: info.element,
            args: info.args,
            elements: elements(),
          });
          // Contrôle sans nom ni auto_id : une vignette de la capture devient un repli visuel (image=).
          if (step.anchor && step.anchor.path && !step.anchor.auto_id && !step.anchor.label) {
            const asset = await sauverVignette(info.element);
            if (asset) step.anchor.image = asset;
          }
        } else if (info.point) {
          step = scenarioStepFromAct({
            args: { op: info.op, x: info.point[0], y: info.point[1], ...(info.args || {}) },
            elements: [],
          });
        } else {
          step = scenarioStepFromAct({ args: { op: info.op, ...(info.args || {}) }, elements: [] });
        }
        // Lancement : la fenêtre réellement apparue devient l'attente du script ; sans titre confirmé, launch() attend seul.
        if (info.op === "launch" && step.expect && step.expect.kind === "window_ready") {
          const r = (info.result || {}) as Dict;
          if (r["found"] && r["title"]) step.expect.query = String(r["title"]);
        }
        enregistrer(step, sigDe(info.result));
      },
    });
  }
  /** Découpe la box de l'élément dans la capture affichée et l'enregistre en PNG dans la sandbox ; rend le chemin relatif au script, ou « ». */
  async function sauverVignette(el: ElementUi): Promise<string> {
    const ASSETS = `${DOSSIER}/assets`;
    try {
      const f = menu.studioFrame?.value;
      const b = el && el.box;
      if (!f || !f.imageUrl || !Array.isArray(b) || b.length < 4 || typeof document === "undefined")
        return "";
      const x1 = Math.max(0, Math.floor(b[0] ?? 0));
      const y1 = Math.max(0, Math.floor(b[1] ?? 0));
      const x2 = Math.min(f.imgW || 0, Math.ceil(b[2] ?? 0));
      const y2 = Math.min(f.imgH || 0, Math.ceil(b[3] ?? 0));
      if (x2 - x1 < 4 || y2 - y1 < 4) return "";
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = f.imageUrl;
      });
      const cv = document.createElement("canvas");
      cv.width = x2 - x1;
      cv.height = y2 - y1;
      (cv.getContext("2d") as CanvasRenderingContext2D).drawImage(
        img,
        x1,
        y1,
        x2 - x1,
        y2 - y1,
        0,
        0,
        x2 - x1,
        y2 - y1,
      );
      const b64 = cv.toDataURL("image/png").split(",")[1] || "";
      if (!b64) return "";
      const nom = `${String(el.id || "el").replace(/[^\w-]+/g, "_")}-${String(f.sig || "").slice(0, 6)}.png`;
      const json = { "Content-Type": "application/json" };
      try {
        await fetchAuth(
          "/api/sandbox/mkdir",
          { method: "POST", headers: json, body: JSON.stringify({ path: ASSETS }) },
          true,
        );
      } catch {
        /* existe déjà */
      }
      const r = await fetchAuth(
        "/api/sandbox/save",
        {
          method: "POST",
          headers: json,
          body: JSON.stringify({ path: `${ASSETS}/${nom}`, content_b64: b64 }),
        },
        true,
      );
      return r && r.ok ? `assets/${nom}` : "";
    } catch {
      return "";
    }
  }
  function toggleAutoRecording(): void {
    autoRecording.value = !autoRecording.value;
    actionEnVol = null;
    avantAction = [];
    actionsEnVol.clear();
    if (autoRecording.value) {
      if (!autoCode.value.trim()) ecrireCode(autoNewCode(), false);
      autoIgnored.value = 0;
      derniereSig = sigTrame();
      toast("Enregistrement : chaque action s'écrit dans le code, à l'endroit du curseur.");
    }
  }

  const ancreDe = (el?: ElementUi | null): Ancre | null => {
    const e = el || elementChoisi();
    return e ? anchorFromElement(e, elements()) : null;
  };
  function placerSurPass(ligne: number): void {
    if (editeur) {
      try {
        editeur.setPosition({ lineNumber: ligne + 1, column: 1e6 });
      } catch {
        /* éditeur démonté */
      }
    } else autoCursorLine.value = ligne;
  }
  function autoInsertIf(type?: string, el?: ElementUi | null): void {
    const cond: Dict = { type: type || "exists", query: "" };
    const a = ancreDe(el);
    if (a && type !== "text") cond["anchor"] = a;
    else cond["query"] = "…";
    if (type === "value") {
      cond["expected"] = "";
      cond["cmp"] = "partiel";
    }
    if (type === "state") cond["state"] = "checked";
    const at = autoInsertLines(stepLines(makeStep("if", { cond })));
    placerSurPass(at + 1);
  }
  /** « Sinon » ressort d'un niveau : écrit après la fin du bloc qui contient le curseur (ou qu'il ouvre), à son indentation. */
  function autoInsertElse(): void {
    const cur = ligneCurseur();
    const tout = String(autoCode.value || "").split("\n");
    const pt = elseInsertPoint(tout, cur);
    if (!pt) {
      const indent = Math.max(0, (/^(\s*)/.exec(tout[cur] || "")?.[1]?.length ?? 0) - 4);
      placerSurPass(autoInsertLines(["else:", "    pass"], indent) + 1);
      return;
    }
    const r = insertLinesAt(autoCode.value, pt.after, ["else:", "    pass"], pt.indent);
    ecrireCode(r.code, false);
    autoDirty.value = true;
    placerSurPass(r.line + 1);
  }
  function autoInsertLoop(): void {
    const at = autoInsertLines(stepLines(makeStep("loop", { times: 3 })));
    placerSurPass(at + 1);
  }
  function attenteDe(kind?: string, el?: ElementUi | null): Partial<EtapeAuto> {
    const a = ancreDe(el);
    const ex: Dict = { kind: kind || (a ? "element" : "stable") };
    if (a && ["element", "element_gone", "value", "value_gone", "state"].indexOf(String(ex["kind"])) >= 0) {
      ex["anchor"] = a;
      ex["query"] = a.label || "";
    } else if (
      [
        "element",
        "element_gone",
        "value",
        "value_gone",
        "state",
        "text",
        "text_gone",
        "window_ready",
      ].indexOf(String(ex["kind"])) >= 0
    ) {
      ex["query"] = "…";
    }
    if (ex["kind"] === "value" || ex["kind"] === "value_gone") {
      ex["expected"] = "…";
      ex["cmp"] = "partiel";
    }
    if (ex["kind"] === "state") ex["state"] = "checked";
    if (ex["kind"] === "count") {
      ex["op"] = ">=";
      ex["count"] = 1;
    }
    const attente = { expect: ex };
    return attente;
  }
  function autoInsertWait(kind?: string, el?: ElementUi | null): void {
    autoInsertLines(stepLines(makeStep("wait", attenteDe(kind, el))));
  }
  /** Pause fixe de la durée du champ « Délai » (`s.wait.seconds(N)`). */
  function autoInsertPause(): void {
    autoInsertLines(stepLines(makeStep("wait", { expect: { kind: "pause" }, timeout_ms: dureePauseMs() })));
  }
  function autoInsertCheck(kind?: string, el?: ElementUi | null): void {
    autoInsertLines(stepLines(makeStep("check", attenteDe(kind, el))));
  }
  async function autoInsertFocus(): Promise<void> {
    const el = elementChoisi();
    const devine = el && isWindowRole(el.role) ? el.label || "" : "";
    const ask = chat.askStudioText;
    const titre = ask
      ? await ask("Fenêtre à mettre au premier plan", devine, "Titre (regex, insensible à la casse)…")
      : devine;
    if (titre == null) return;
    autoInsertLines(stepLines(makeStep("focus", { window: String(titre || "").trim() })));
  }
  async function autoInsertNote(): Promise<void> {
    const ask = chat.askStudioText;
    const text = ask ? await ask("Note dans le script", "", "Ce que fait cette partie…") : "";
    if (text == null) return;
    autoInsertLines(stepLines(makeStep("note", { text: String(text || "").trim() })));
  }
  function autoInsertVar(el?: ElementUi | null): void {
    const a = ancreDe(el);
    autoInsertLines(
      stepLines(
        makeStep("var", { name: "valeur", source: "value", anchor: a || undefined, query: a ? "" : "…" }),
      ),
    );
  }

  /** Cible du menu contextuel de la scène (l'élément du menu, pas la sélection courante) ; ferme le menu. */
  function cibleMenu(): { el: ElementUi | null; point: readonly number[] | null } {
    const m = chat.studioCtxMenu?.value;
    if (chat.closeStudioCtx) {
      try {
        chat.closeStudioCtx();
      } catch {
        /* menu absent */
      }
    }
    const el = (m && m.el) || null;
    const point = (m && m.point) || null;
    if (el && menu.selectStudioElement) {
      try {
        menu.selectStudioElement(el.id as string | number, true);
      } catch {
        /* scène absente */
      }
    }
    const visee = { el, point };
    return visee;
  }
  /** Ligne d'action écrite sans l'exécuter (élément → ancre exposée, point → at=). */
  function ecrireAction(
    op: string,
    el: ElementUi | null,
    point: readonly number[] | null,
    args?: Dict,
  ): void {
    let step: PasScenario;
    if (el) step = scenarioStepFromDirect({ op, element: el, args: args || {}, elements: elements() });
    else if (point)
      step = scenarioStepFromAct({ args: { op, x: point[0], y: point[1], ...(args || {}) }, elements: [] });
    else step = scenarioStepFromAct({ args: { op, ...(args || {}) }, elements: [] });
    autoInsertLines(stepLines(actionStep(step)));
  }
  async function ctxScript(kind: string): Promise<void> {
    const { el, point } = cibleMenu();
    switch (kind) {
      case "if":
        autoInsertIf("exists", el);
        break;
      case "if_missing":
        autoInsertIf("missing", el);
        break;
      case "else":
        autoInsertElse();
        break;
      case "loop":
        autoInsertLoop();
        break;
      case "wait":
        autoInsertWait(el ? "element" : "stable", el);
        break;
      case "wait_gone":
        autoInsertWait("element_gone", el);
        break;
      case "pause":
        autoInsertPause();
        break;
      case "check":
        autoInsertCheck("element", el);
        break;
      case "check_gone":
        autoInsertCheck("element_gone", el);
        break;
      case "var":
        autoInsertVar(el);
        break;
      case "note":
        await autoInsertNote();
        break;
      case "focus":
        await autoInsertFocus();
        break;
      case "click":
        ecrireAction("click", el, point);
        break;
      case "double_click":
        ecrireAction("double_click", el, point);
        break;
      case "right_click":
        ecrireAction("right_click", el, point);
        break;
      case "set_value": {
        const ask = chat.askStudioText;
        const text = ask ? await ask("Valeur à saisir", "", "Texte que le script saisira…") : "";
        if (text == null) return;
        if (el) ecrireAction("set_value", el, null, { text: String(text) });
        else ecrireAction("type", null, null, { text: String(text) });
        break;
      }
      default:
        break;
    }
    if (chat.studioTab) chat.studioTab.value = "script";
  }
  /** Corbeille du Plan : une ligne qui ouvre un bloc part avec son corps ; un corps vidé reçoit « pass ». */
  function autoDeleteLine(i: number): void {
    const r = deleteLineAt(autoCode.value, i);
    if (!r.removed && r.code === autoCode.value) return;
    ecrireCode(r.code, true);
    autoDirty.value = true;
    if (r.removed > 1) toast(`Bloc retiré (${r.removed} lignes)${editeur ? " — Ctrl+Z pour annuler" : ""}`);
  }
  function autoGotoLine(i: number): void {
    if (editeur) {
      try {
        editeur.setPosition({ lineNumber: i + 1, column: 1 });
        editeur.revealLineInCenter(i + 1);
        editeur.focus();
      } catch {
        /* éditeur démonté */
      }
    } else autoCursorLine.value = i;
    focaliserAncreDeLigne(i);
  }
  function autoClearCode(): void {
    if (!autoClearArmed.value) {
      autoClearArmed.value = true;
      if (minuterieArme) clearTimeout(minuterieArme);
      minuterieArme = setTimeout(() => {
        autoClearArmed.value = false;
      }, 3000);
      return;
    }
    autoClearArmed.value = false;
    ecrireCode(autoNewCode(), false);
    autoDirty.value = true;
    autoCursorLine.value = -1;
  }

  const modele = (): string | null => {
    try {
      return ctx.currentModelId?.() || null;
    } catch {
      return null;
    }
  };
  /** Serveur d'inférence du chat : l'aide IA partait toujours sur l'intégré. */
  const connecteur = (): string | number | null => {
    try {
      return ctx.currentConnectorId?.() || null;
    } catch {
      return null;
    }
  };
  /** Flux de chat éphémère sans outil → texte complet de la réponse. */
  async function demanderAuModele(prompt: string, signal: AbortSignal): Promise<string> {
    let text = "";
    const res = await fetchAuth("/api/chat-saved-stream3", {
      method: "POST",
      signal,
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        chat_id: "__studio_auto_ai__",
        ephemeral: true,
        active_mcp_servers: [],
        model: modele(),
        connector_id: connecteur(),
        thinking_mode: false,
      }),
    });
    if (!res || !res.ok || !res.body) throw new Error("flux indisponible");
    const lecteur = res.body.getReader();
    const dec = new TextDecoder("utf-8");
    let buf = "";
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lignes = buf.split("\n");
      buf = lignes.pop() ?? "";
      for (const ligne of lignes) {
        if (!ligne.trim()) continue;
        let ev: Dict;
        try {
          ev = JSON.parse(ligne) as Dict;
        } catch {
          continue;
        }
        if (ev["type"] === "content_token") text += String(ev["text"] || ev["content"] || ev["token"] || "");
        else if (ev["type"] === "error") throw new Error(String(ev["text"] || ev["error"] || "erreur"));
      }
    }
    return text;
  }
  async function autoAiAsk(): Promise<void> {
    const demande = (autoAiPrompt.value || "").trim();
    if (!demande || autoAiBusy.value) return;
    autoAiBusy.value = true;
    autoAiLast.value = "";
    const ac = new AbortController();
    abandonIa = ac;
    const prompt = [
      "Tu écris des lignes Python pour un script d'automatisation de bureau. Réponds UNIQUEMENT par un bloc ```python contenant les lignes à insérer (pas d'en-tête, pas de Session, pas de finish).",
      "Vise les éléments exposés (auto_id, sinon name + role) ; jamais de coordonnées sauf impossibilité.",
      "",
      API_CHEATSHEET,
      "",
      "Éléments visibles sur la capture (rôle · libellé · auto_id) :",
      libelleElements(elements()),
      "",
      "Script actuel :",
      "```python",
      autoCode.value,
      "```",
      "",
      `Demande : ${demande}`,
    ].join("\n");
    try {
      const text = await demanderAuModele(prompt, ac.signal);
      const bloc = extractPythonBlock(text);
      if (!bloc) {
        toast("L'IA n'a pas renvoyé de code exploitable", "error");
        return;
      }
      autoInsertLines(bloc.split("\n"));
      autoAiLast.value = bloc;
      autoAiPrompt.value = "";
    } catch (e) {
      if (!(e instanceof Error && e.name === "AbortError"))
        toast(`Aide IA : ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      autoAiBusy.value = false;
      abandonIa = null;
    }
  }
  function autoAiStop(): void {
    if (abandonIa) {
      try {
        abandonIa.abort();
      } catch {
        /* déjà abandonné */
      }
    }
  }

  const autoRun = ref<ExecutionAuto | null>(null);
  const autoRunOpen = ref(false);
  const autoRunMenuOpen = ref(false);
  const autoRunTargets = ref<Record<string, boolean>>({});
  const autoRepairBusy = ref(false);
  let minuterieExec: ReturnType<typeof setTimeout> | null = null;
  function arreterSuivi(): void {
    if (minuterieExec) {
      clearTimeout(minuterieExec);
      minuterieExec = null;
    }
  }
  /** Une exécution à la fois : deux scripts pilotaient sinon le même bureau. */
  function executionOccupee(): boolean {
    if (autoRun.value && autoRun.value.running) {
      toast("Une exécution est déjà en cours", "error");
      return true;
    }
    return false;
  }
  async function autoRunStart(mode?: string): Promise<void> {
    autoRunMenuOpen.value = false;
    if (executionOccupee()) return;
    const tgt = cible();
    if (!tgt) {
      toast("Choisis une cible", "error");
      return;
    }
    if (!autoCode.value.trim()) {
      toast("Le script est vide", "error");
      return;
    }
    arreterSuivi();
    garantirTimeout();
    const code = autoCode.value;
    autoRun.value = {
      run_id: "",
      target: tgt,
      running: true,
      code: null,
      report: null,
      log: [],
      summary: "",
      error: "",
      mode: mode || "run",
      started: Date.now(),
      sent_code: code,
    };
    const run = autoRun.value;
    autoRunOpen.value = true;
    try {
      const extra = await collecterComplements(code);
      const r = await fetchAuth("/api/desktop/run-automation", {
        method: "POST",
        body: JSON.stringify({
          target: tgt,
          name: autoName.value || "automatisation",
          code,
          libs: extra.libs,
          assets: extra.assets,
          dry_run: mode === "dry",
          trace: mode === "trace",
        }),
      });
      const d = await lireJson(r, "execution");
      if (!r || !r.ok || d["ok"] === false)
        throw new Error(String(d["message"] || d["detail"] || d["error"] || "lancement impossible"));
      run.run_id = String(d["run_id"]);
      if (autoRun.value === run) {
        arreterSuivi();
        minuterieExec = setTimeout(() => void sonderExecution(), 1200);
      }
    } catch (e) {
      run.running = false;
      run.error = String(e instanceof Error ? e.message : e);
      toast(`Exécution : ${run.error}`, "error");
    }
  }
  async function sonderExecution(): Promise<void> {
    minuterieExec = null;
    const run = autoRun.value;
    if (!run || !run.run_id || !run.running) return;
    try {
      const r = await fetchAuth(
        `/api/desktop/run-automation/status?target=${encodeURIComponent(run.target)}&run_id=${encodeURIComponent(run.run_id)}`,
      );
      const d = await lireJson(r, "etat");
      if (autoRun.value !== run || !run.running) return;
      if (!r || !r.ok || d["ok"] === false) {
        const e = new Error(String(d["message"] || d["error"] || "état inconnu")) as Error & {
          fatal?: boolean;
        };
        // 404 « exécution inconnue » : l'agent a redémarré, inutile d'insister.
        e.fatal = !!(r && r.status === 404) || /inconnue/.test(String(d["message"] || d["detail"] || ""));
        throw e;
      }
      run.poll_errors = 0;
      run.warning = "";
      run.log = (d["log"] as unknown[]) || [];
      run.summary = String(d["summary"] || run.summary);
      run.report_dir = String(d["report_dir"] || "");
      if (d["running"]) {
        minuterieExec = setTimeout(() => void sonderExecution(), 1500);
        return;
      }
      run.running = false;
      run.code = d["code"] as number | null;
      run.report = (d["report"] as RapportExecution) || null;
      if (!run.report && run.summary) run.error = "";
      toast(
        run.report ? String(run.report.summary) : `Terminé (code ${String(d["code"])})`,
        d["code"] === 0 ? "info" : "error",
      );
    } catch (e) {
      // Un 502 ou un délai pendant une exécution de dix minutes ne doit pas abandonner le suivi : on réessaie en espaçant.
      if (autoRun.value !== run || !run.running) return;
      run.poll_errors = (run.poll_errors || 0) + 1;
      const fatale = !!(e as { fatal?: boolean }).fatal;
      if (!fatale && run.poll_errors < 8) {
        run.warning = `suivi interrompu (${e instanceof Error ? e.message : String(e)}) — nouvel essai…`;
        minuterieExec = setTimeout(
          () => void sonderExecution(),
          Math.min(15000, 1500 * Math.pow(2, run.poll_errors - 1)),
        );
        return;
      }
      run.running = false;
      run.error = String(e instanceof Error ? e.message : e);
    }
  }
  async function autoRunStop(): Promise<void> {
    const run = autoRun.value;
    if (!run || !run.run_id) return;
    try {
      await fetchAuth("/api/desktop/run-automation/stop", {
        method: "POST",
        body: JSON.stringify({ target: run.target, run_id: run.run_id }),
      });
    } catch {
      /* arrêt local quoi qu'il arrive */
    }
    arreterSuivi();
    run.running = false;
    run.error = "arrêté";
  }
  function autoRunClose(): void {
    arreterSuivi();
    autoRun.value = null;
    autoRunOpen.value = false;
  }
  function autoRunFileUrl(path: string): string {
    const run = autoRun.value;
    if (!run || !path) return "";
    return `/api/desktop/run-file?target=${encodeURIComponent(run.target)}&path=${encodeURIComponent(String(path).replace(/\\/g, "/"))}`;
  }
  const autoRunSteps = computed<EtapeRapport[]>(() => {
    const rep = autoRun.value && autoRun.value.report;
    return rep && Array.isArray(rep.steps) ? rep.steps : [];
  });
  function autoRunToggleTargets(name: string): void {
    const t = Object.assign({}, autoRunTargets.value);
    if (t[name]) delete t[name];
    else t[name] = true;
    autoRunTargets.value = t;
  }
  async function autoRunMatrix(): Promise<void> {
    autoRunMenuOpen.value = false;
    if (executionOccupee()) return;
    const targets = Object.keys(autoRunTargets.value).filter((k) => autoRunTargets.value[k]);
    if (!targets.length) {
      toast("Coche au moins une machine", "error");
      return;
    }
    if (!autoCode.value.trim()) {
      toast("Le script est vide", "error");
      return;
    }
    garantirTimeout();
    arreterSuivi();
    const code = autoCode.value;
    autoRun.value = {
      run_id: "",
      target: targets.join(", "),
      running: true,
      code: null,
      report: null,
      log: [],
      summary: `Matrice : ${targets.length} machine(s)…`,
      error: "",
      mode: "matrix",
      started: Date.now(),
      matrix: null,
      sent_code: code,
    };
    const run = autoRun.value;
    autoRunOpen.value = true;
    try {
      const extra = await collecterComplements(code);
      const r = await fetchAuth("/api/desktop/run-automation-matrix", {
        method: "POST",
        // Budget par machine : le plafond du serveur (1 h), pas 10 minutes.
        body: JSON.stringify({
          targets,
          name: autoName.value || "automatisation",
          code,
          libs: extra.libs,
          assets: extra.assets,
          timeout_s: ATTENTE_MAX_S,
        }),
      });
      const d = await lireJson(r, "matrice");
      if (!r || !r.ok || d["ok"] === false)
        throw new Error(String(d["message"] || d["detail"] || d["error"] || "matrice impossible"));
      run.running = false;
      run.matrix = d;
      run.summary = String(d["summary"] || "");
      run.code = d["ok_count"] === d["targets"] ? 0 : 1;
    } catch (e) {
      run.running = false;
      run.error = String(e instanceof Error ? e.message : e);
    }
  }
  /** La ligne du rapport désigne le code envoyé : si elle a changé depuis, on la retrouve par son texte, sinon on refuse. */
  function indexLigneRapport(step: EtapeRapport): number {
    const idx = Number((step && step.line) || 0) - 1;
    const tout = String(autoCode.value || "").split("\n");
    const envoye =
      autoRun.value && typeof autoRun.value.sent_code === "string"
        ? autoRun.value.sent_code.split("\n")
        : null;
    if (!envoye || idx < 0 || idx >= envoye.length)
      return idx >= 0 && idx < tout.length && !envoye ? idx : -1;
    if (tout[idx] === envoye[idx]) return idx;
    const hits: number[] = [];
    tout.forEach((l, i) => {
      if (l === envoye[idx]) hits.push(i);
    });
    return hits.length === 1 ? (hits[0] ?? -1) : -1;
  }
  function autoApplyHeal(step: EtapeRapport): void {
    const h = step && step.healed;
    if (!h || !h.suggest) return;
    const idx = indexLigneRapport(step);
    const tout = String(autoCode.value || "").split("\n");
    if (idx < 0 || idx >= tout.length) {
      toast(
        `Ligne introuvable ou modifiée depuis l'exécution : reprends « ${h.suggest} » à la main`,
        "error",
      );
      return;
    }
    tout[idx] = applyIdentity(tout[idx], h.suggest);
    ecrireCode(tout.join("\n"), true);
    autoDirty.value = true;
    autoGotoLine(idx);
    toast(`Ligne ${idx + 1} réparée : ${h.suggest}`);
  }
  /** Réparation par l'IA d'une étape en échec : étape, erreur, ligne, extrait d'arbre (trace) et éléments visibles. */
  async function autoRepairWithAi(step: EtapeRapport): Promise<void> {
    if (!step || autoRepairBusy.value) return;
    autoRepairBusy.value = true;
    const ac = new AbortController();
    abandonIa = ac;
    try {
      const idx = indexLigneRapport(step);
      const tout = String(autoCode.value || "").split("\n");
      const texteLigne = idx >= 0 && idx < tout.length ? (tout[idx] ?? "") : "";
      let arbre = "";
      if (step.trace_tree && autoRun.value) {
        try {
          const rel = String(step.trace_tree).replace(/\\/g, "/");
          const t = await fetchAuth(autoRunFileUrl(rel));
          const d = t && t.ok ? ((await t.json()) as { nodes?: Dict[] }) : null;
          if (d && Array.isArray(d.nodes)) {
            arbre = d.nodes
              .slice(0, 60)
              .map(
                (n) =>
                  (n["target"] ? "▶ " : "  ") +
                  "  ".repeat(Number(n["depth"] || 0)) +
                  String(n["role"] || "") +
                  " " +
                  JSON.stringify(n["name"] || "") +
                  (n["auto_id"] ? ` #${String(n["auto_id"])}` : ""),
              )
              .join("\n");
          }
        } catch {
          /* pas de trace */
        }
      }
      const prompt = [
        "Une étape d'un script d'automatisation de bureau (API elpis_auto) a ÉCHOUÉ sur la machine. Corrige la ligne.",
        "Réponds UNIQUEMENT par un bloc ```python contenant la ou les lignes de remplacement (pas d'en-tête, pas de Session, pas de finish).",
        "Règle : viser auto_id, sinon name + role, sinon path=, sinon near= ; jamais de coordonnées sauf impossibilité.",
        "",
        API_CHEATSHEET,
        "",
        `Étape ${step.index || "?"} : ${step.label || ""}`,
        `Erreur : ${step.error || "inconnue"}`,
        texteLigne ? `Ligne actuelle (${idx + 1}) :\n\`\`\`python\n${texteLigne}\n\`\`\`` : "",
        arbre ? `Arbre d'accessibilité au moment de l'échec (▶ = cible visée) :\n${arbre}` : "",
        "Éléments visibles sur la dernière capture (rôle · libellé · auto_id) :",
        libelleElements(elements()),
      ]
        .filter(Boolean)
        .join("\n");
      const text = await demanderAuModele(prompt, ac.signal);
      const bloc = extractPythonBlock(text);
      if (!bloc) {
        toast("L'IA n'a pas renvoyé de code exploitable", "error");
        return;
      }
      const lignes = bloc.split("\n");
      if (idx >= 0 && idx < tout.length) {
        // Le code a pu bouger pendant la réponse du modèle : on relit le document actuel et on retrouve la ligne par son texte.
        const maintenant = String(autoCode.value || "").split("\n");
        let at = maintenant[idx] === texteLigne ? idx : -1;
        if (at < 0) {
          const hits: number[] = [];
          maintenant.forEach((l, i) => {
            if (l === texteLigne) hits.push(i);
          });
          if (hits.length === 1) at = hits[0] ?? -1;
        }
        if (at < 0) {
          autoAiLast.value = bloc;
          toast(
            "La ligne a changé pendant la réparation : correction non appliquée (voir le dernier bloc IA)",
            "error",
          );
          return;
        }
        const indent = (/^(\s*)/.exec(maintenant[at] ?? "") || ["", ""])[1] ?? "";
        maintenant.splice(at, 1, ...lignes.map((l, i) => (i === 0 ? indent + l.trim() : indent + l)));
        ecrireCode(maintenant.join("\n"), true);
        autoDirty.value = true;
        autoGotoLine(at + garantirTimeout());
      } else {
        autoInsertLines(lignes);
      }
      toast("Ligne réparée par l'IA — relance pour vérifier");
    } catch (e) {
      if (!(e instanceof Error && e.name === "AbortError"))
        toast(`Réparation IA : ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      autoRepairBusy.value = false;
      abandonIa = null;
    }
  }

  async function autoRefreshList(): Promise<void> {
    try {
      const r = await fetchAuth("/api/sandbox/tree");
      if (!r || !r.ok) return;
      const data = (await r.json()) as { items?: unknown };
      autoScripts.value = parcourir(data.items || [], [])
        .filter(
          (f) =>
            /\.py$/.test(String(f["path"] || f["name"] || "")) &&
            String(f["path"] || "").indexOf(`${DOSSIER}/`) === 0,
        )
        .map((f) => {
          const base = String(f["name"] || f["path"])
            .replace(/^.*\//, "")
            .replace(/\.py$/, "");
          return {
            slug: base,
            name: base.replace(/-/g, " "),
            path: String(f["path"]),
            size: Number(f["size"] || 0),
          };
        })
        .sort((a, b) => a.slug.localeCompare(b.slug));
    } catch {
      /* liste vide */
    }
  }
  async function autoSave(): Promise<boolean> {
    const name = (autoName.value || "").trim();
    if (!name) {
      toast("Donne un nom au script", "error");
      return false;
    }
    if (!autoCode.value.trim()) {
      toast("Le script est vide", "error");
      return false;
    }
    autoSaving.value = true;
    try {
      const slug = autoSlug.value;
      const json = { "Content-Type": "application/json" };
      try {
        await fetchAuth(
          "/api/sandbox/mkdir",
          { method: "POST", headers: json, body: JSON.stringify({ path: DOSSIER }) },
          true,
        );
      } catch {
        /* existe déjà */
      }
      const r = await fetchAuth(
        "/api/sandbox/save",
        {
          method: "POST",
          headers: json,
          body: JSON.stringify({ path: `${DOSSIER}/${slug}.py`, content: autoCode.value }),
        },
        true,
      );
      if (!(r && r.ok)) throw new Error("écriture refusée");
      autoCurrent.value = slug;
      autoDirty.value = false;
      toast(`Script enregistré : ${DOSSIER}/${slug}.py`);
      await autoRefreshList();
      return true;
    } catch (e) {
      toast(`Enregistrement impossible : ${e instanceof Error ? e.message : String(e)}`, "error");
      return false;
    } finally {
      autoSaving.value = false;
    }
  }
  async function autoOpen(item: ScriptSandbox | null | undefined): Promise<void> {
    if (!item) return;
    autoLoading.value = true;
    try {
      const r = await fetchAuth(
        `/api/sandbox/serve/${String(item.path).split("/").map(encodeURIComponent).join("/")}?t=${Date.now()}`,
      );
      if (!r || !r.ok) throw new Error("lecture impossible");
      ecrireCode(await r.text(), false, true);
      autoName.value = item.name || item.slug;
      autoCurrent.value = item.slug;
      autoDirty.value = false;
      autoCursorLine.value = -1;
    } catch (e) {
      toast(`Ouverture impossible : ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      autoLoading.value = false;
    }
  }
  async function autoDelete(item: ScriptSandbox | null | undefined): Promise<void> {
    if (!item) return;
    try {
      await fetchAuth(
        `/api/sandbox/delete?path=${encodeURIComponent(`${DOSSIER}/${item.slug}.py`)}`,
        { method: "DELETE" },
        true,
      );
      if (autoCurrent.value === item.slug) autoNew();
      await autoRefreshList();
    } catch {
      toast("Suppression impossible", "error");
    }
  }
  function autoNew(): void {
    autoName.value = "";
    autoCurrent.value = "";
    autoDirty.value = false;
    autoCursorLine.value = -1;
    autoRecording.value = false;
    actionEnVol = null;
    avantAction = [];
    actionsEnVol.clear();
    autoIgnored.value = 0;
    autoComposeOn.value = false;
    arreterSuivi();
    autoRun.value = null;
    autoRunOpen.value = false;
    ecrireCode(autoNewCode(), false, true);
  }
  function resetAutomation(): void {
    autoNew();
    autoScripts.value = [];
    autoUnmountEditor();
  }

  const autoDlOpen = ref(false);
  const autoDlBusy = ref(false);
  function enregistrerBlob(blob: Blob, nomFichier: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nomFichier;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function toggleAutoDl(): void {
    autoDlOpen.value = !autoDlOpen.value;
  }
  /** Bibliothèque partagée (automations/lib/*.py) et vignettes référencées par le script, embarquées dans le bundle. */
  async function collecterComplements(
    code?: string,
  ): Promise<{ libs: Record<string, string>; assets: Record<string, string> }> {
    const libs: Record<string, string> = {};
    const assets: Record<string, string> = {};
    try {
      const r = await fetchAuth("/api/sandbox/tree");
      const data = r && r.ok ? ((await r.json()) as { items?: unknown }) : { items: [] };
      const fichiers = parcourir(data.items || [], []).filter(
        (f) =>
          /\.py$/.test(String(f["path"] || "")) && String(f["path"] || "").indexOf(`${DOSSIER}/lib/`) === 0,
      );
      for (const f of fichiers) {
        const t = await fetchAuth(
          `/api/sandbox/serve/${String(f["path"]).split("/").map(encodeURIComponent).join("/")}`,
        );
        if (t && t.ok) libs[`lib/${String(f["path"]).slice(`${DOSSIER}/lib/`.length)}`] = await t.text();
      }
    } catch {
      /* pas de lib */
    }
    const refs = new Set<string>();
    String(code == null ? autoCode.value : code || "").replace(
      /\bimage\s*=\s*(?:"([^"]+)"|'([^']+)')/g,
      (m, p1: string | undefined, p2: string | undefined) => {
        refs.add(p1 || p2 || "");
        return m;
      },
    );
    for (const rel of refs) {
      try {
        const t = await fetchAuth(
          `/api/sandbox/serve/${`${DOSSIER}/${rel}`.split("/").map(encodeURIComponent).join("/")}`,
        );
        if (!t || !t.ok) continue;
        const buf = new Uint8Array(await t.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i] ?? 0);
        assets[rel] = btoa(bin);
      } catch {
        /* vignette absente */
      }
    }
    const complements = { libs, assets };
    return complements;
  }
  function autoDownload(): void {
    autoDlOpen.value = false;
    garantirTimeout();
    try {
      enregistrerBlob(
        new Blob([autoCode.value], { type: "text/x-python;charset=utf-8" }),
        `${autoSlug.value}.py`,
      );
    } catch {
      toast("Téléchargement impossible", "error");
    }
  }
  async function autoDownloadBundle(withWheels?: boolean): Promise<void> {
    autoDlOpen.value = false;
    garantirTimeout();
    if (autoDlBusy.value) return;
    autoDlBusy.value = true;
    try {
      const extra = await collecterComplements();
      const r = await fetchAuth("/api/desktop/automation-bundle", {
        method: "POST",
        body: JSON.stringify({
          name: autoName.value || "automatisation",
          code: autoCode.value,
          os: osCible() || "windows",
          include_wheels: !!withWheels,
          libs: extra.libs,
          assets: extra.assets,
        }),
      });
      if (!r || !r.ok) {
        const d = await jsonOuVide(r);
        toast(String(d["detail"] || d["message"] || "Bundle impossible"), "error");
        return;
      }
      enregistrerBlob(await r.blob(), `${autoSlug.value}.zip`);
      toast(
        withWheels
          ? "Bundle téléchargé : script + runtime + wheels hors ligne"
          : "Bundle téléchargé : script + runtime + requirements.txt",
      );
    } catch {
      toast("Bundle impossible", "error");
    } finally {
      autoDlBusy.value = false;
    }
  }
  async function autoCopyCode(): Promise<void> {
    try {
      await navigator.clipboard.writeText(autoCode.value);
      toast("Code copié");
    } catch {
      toast("Copie impossible", "error");
    }
  }

  if (!autoCode.value) autoCode.value = autoNewCode();

  return {
    autoCode,
    autoName,
    autoRecording,
    autoIgnored,
    autoScripts,
    autoListOpen,
    autoSaving,
    autoLoading,
    autoCurrent,
    autoDirty,
    autoEditorReady,
    autoCursorLine,
    autoAiPrompt,
    autoAiBusy,
    autoAiLast,
    autoHelpOpen,
    autoClearArmed,
    autoSlug,
    autoOutline,
    autoNeedsVision,
    autoLineCount,
    API_HELP,
    autoRailWidth,
    autoCodePct,
    autoSetRailWidth,
    autoSetCodePct,
    autoRailReset,
    autoRailDragStart,
    autoWaitSec,
    autoSetWaitSec,
    autoMountEditor,
    autoUnmountEditor,
    autoOnTextarea,
    autoInsertLines,
    autoNewCode,
    toggleAutoRecording,
    autoInsertIf,
    autoInsertElse,
    autoInsertLoop,
    autoInsertWait,
    autoInsertPause,
    autoInsertCheck,
    autoInsertFocus,
    autoInsertNote,
    autoInsertVar,
    autoDeleteLine,
    autoGotoLine,
    autoClearCode,
    ctxScript,
    autoAiAsk,
    autoAiStop,
    autoRefreshList,
    autoSave,
    autoOpen,
    autoDelete,
    autoNew,
    resetAutomation,
    autoDownload,
    autoDownloadBundle,
    autoDlOpen,
    autoDlBusy,
    toggleAutoDl,
    autoCopyCode,
    autoRun,
    autoRunOpen,
    autoRunMenuOpen,
    autoRunTargets,
    autoRunSteps,
    autoRepairBusy,
    autoRunStart,
    autoRunStop,
    autoRunClose,
    autoRunFileUrl,
    autoRunToggleTargets,
    autoRunMatrix,
    autoApplyHeal,
    autoRepairWithAi,
    autoComposeOn,
    toggleAutoCompose,
  };
}

export type SurfaceAutomatisationStudio = ReturnType<typeof creerAutomatisationStudio>;
