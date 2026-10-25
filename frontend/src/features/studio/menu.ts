// SPDX-License-Identifier: MIT
/** frontend/src/features/studio/menu.ts — Annotation Studio : capture annotée d'une cible desktop (live par SSE ou à la demande), plans, inspecteur, arbre UIA en colonne, zoom et déplacement de la scène. */
import { computed, getCurrentScope, nextTick, onScopeDispose, ref } from "vue";
import type { Ref } from "vue";

import { anchorQuality, targetKwargs } from "../../modeles/automation-model.ts";
import {
  a11yAudit,
  a11yAuditCsv,
  anchorFromElement,
  boxOnScreen,
  deepestAt,
  elementAncestors,
  elementLayers,
  elementTreeRows,
  filterByLayers,
  layerOrdinal,
  realName,
} from "../../modeles/scenario-model.ts";
import type { ElementUi } from "../../modeles/scenario-model.ts";
import type { LecteurBureau } from "./api.ts";

/** Élément détecté par l'agent ou la vision : identifiant et boîte toujours présents (les autres filtrés par `boxOnScreen`). */
export interface ElementStudio extends ElementUi {
  id: string | number;
  box: [number, number, number, number];
}

export interface AuditStudio {
  interactive: number;
  unnamed: number;
  rows: Array<{
    id: string | number;
    role: string;
    missing: string;
    volatile: boolean;
    path: string;
    near: string;
    box: number[] | undefined;
  }>;
}

export interface LigneArbreStudio {
  el: ElementStudio;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
}

export interface FrameStudio {
  imageUrl: string;
  boxes: ElementStudio[];
  imgW: number;
  imgH: number;
  target: string;
  ts: number;
  sig?: string;
  treeCapped?: boolean;
  treeNodes?: number;
}

export interface CibleStudio {
  name: string;
  default?: boolean;
  os?: string;
  [cle: string]: unknown;
}

export interface MoniteurStudio {
  index: number;
  label?: string;
  width?: number;
  height?: number;
  left?: number;
  top?: number;
}

/** Image reçue du serveur (champs snake_case de l'événement `annotation_frame` ou de la réponse de capture). */
export interface TrameFil {
  image_url?: string;
  imageUrl?: string;
  boxes?: ElementStudio[];
  img_w?: number;
  imgW?: number;
  img_h?: number;
  imgH?: number;
  target?: string;
  sig?: string;
  tree_capped?: boolean;
  tree_nodes?: number;
  ts?: number;
  [cle: string]: unknown;
}

export interface CtxMenuStudio {
  showToast?: (message: string, type?: string) => void;
  fetchAuth: (url: string, init?: RequestInit, soft?: boolean) => Promise<Response | null>;
  lireJson?: LecteurBureau;
}

export interface RefsMenuStudio {
  currentView: Ref<string>;
}

const TREE_W_DEFAULT = 300;
const TREE_W_MIN = 220;
const TREE_W_MAX = 560;
const ZOOM_MAX = 8;
const ICONES_ROLE: Readonly<Record<string, string>> = {
  window: "ph-app-window",
  dialog: "ph-app-window",
  frame: "ph-app-window",
  button: "ph-cursor-click",
  textbox: "ph-text-t",
  edit: "ph-text-t",
  checkbox: "ph-check-square",
  radio: "ph-circle",
  tab: "ph-browser",
  menuitem: "ph-list",
  menu: "ph-list",
  link: "ph-link",
  listitem: "ph-list-bullets",
  list: "ph-list-bullets",
  combobox: "ph-caret-down",
  text: "ph-text-aa",
  image: "ph-image",
  icon: "ph-image",
  pane: "ph-square",
  group: "ph-square",
  toolbar: "ph-square",
  document: "ph-square",
};

function lireStockage(cle: string): string | null {
  try {
    return localStorage.getItem(cle);
  } catch {
    return null;
  }
}
function ecrireStockage(cle: string, valeur: string): void {
  try {
    localStorage.setItem(cle, valeur);
  } catch {
    /* stockage privé ou plein */
  }
}

function trameVide(): FrameStudio {
  return { imageUrl: "", boxes: [], imgW: 0, imgH: 0, target: "", ts: 0 };
}

const surface = (el: ElementUi | null | undefined): number => {
  const b = el && el.box;
  return b && b.length >= 4
    ? Math.max(0, (b[2] ?? 0) - (b[0] ?? 0)) * Math.max(0, (b[3] ?? 0) - (b[1] ?? 0))
    : 0;
};

const jsonOuVide = async (r: Response | null): Promise<Record<string, unknown>> =>
  r ? ((await r.json().catch(() => ({}))) as Record<string, unknown>) : {};

export function creerMenuStudio(refs: RefsMenuStudio, ctx: CtxMenuStudio) {
  const { currentView } = refs;
  const { fetchAuth } = ctx;
  const lireJson: LecteurBureau = ctx.lireJson ?? ((r) => jsonOuVide(r));
  const toast = (m: string, t?: string): void => ctx.showToast?.(m, t);

  const studioFrame = ref<FrameStudio>(trameVide());
  const studioTargets = ref<CibleStudio[]>([]);
  const selectedTarget = ref("");
  const studioPrompt = ref("");
  const studioLive = ref(false);
  const studioCapturing = ref(false);
  const studioReading = ref(false);
  const studioText = ref<{ text: string; region: string } | null>(null);
  const studioRaw = ref(true);
  const studioError = ref("");
  const hoveredElementId = ref<string | number | null>(null);
  const desktopActiveTarget = ref("");
  const studioSettingsOpen = ref(false);
  const studioActionsOpen = ref(false);
  const studioMonitors = ref<MoniteurStudio[]>([]);
  const studioMonitor = ref(1);

  let dernierBlob = "";
  let minuterieLive: ReturnType<typeof setTimeout> | null = null;
  let activeChargee = false;
  let sequenceTrame = 0;

  const studioElements = computed<ElementStudio[]>(() => {
    const f = studioFrame.value;
    const W = Number(f.imgW || 0);
    const H = Number(f.imgH || 0);
    return (f.boxes || []).filter((b) => b && boxOnScreen(b.box, W, H));
  });

  /** Un grand cadre (fenêtre, conteneur) couvre l'écran : jamais dessiné en permanence, seulement au survol. */
  function isContainerBox(el: ElementUi): boolean {
    const f = studioFrame.value;
    const cadre = f && f.imgW && f.imgH ? f.imgW * f.imgH : 0;
    return cadre ? surface(el) / cadre >= 0.5 : false;
  }

  const studioLayersOpen = ref(false);
  const studioLayersOn = ref<Record<string, boolean>>({});
  const studioDepthMax = ref(0);
  const infoPlans = computed(() => elementLayers(studioElements.value));
  const studioLayers = computed(() => infoPlans.value.layers || []);
  const studioLayerActive = computed(
    () =>
      Object.keys(studioLayersOn.value).some((k) => studioLayersOn.value[k]) ||
      Number(studioDepthMax.value) > 0,
  );
  const studioLayerFiltered = computed<ElementStudio[]>(() => {
    if (!studioLayerActive.value) return studioElements.value;
    return filterByLayers(
      studioElements.value,
      studioLayersOn.value,
      studioDepthMax.value,
      infoPlans.value.layerOf,
    ) as ElementStudio[];
  });
  function toggleStudioLayers(): void {
    studioLayersOpen.value = !studioLayersOpen.value;
  }
  function isLayerOn(index: number): boolean {
    const on = studioLayersOn.value;
    return !Object.keys(on).some((k) => on[k]) || !!on[index];
  }
  function toggleLayer(index: number): void {
    const on: Record<string, boolean> = Object.assign({}, studioLayersOn.value);
    const any = Object.keys(on).some((k) => on[k]);
    if (!any) {
      for (const l of studioLayers.value) on[l.index] = l.index !== index;
    } else if (on[index]) delete on[index];
    else on[index] = true;
    if (studioLayers.value.every((l) => on[l.index])) studioLayersOn.value = {};
    else studioLayersOn.value = on;
  }
  function soloLayer(index: number): void {
    studioLayersOn.value = { [index]: true };
  }
  function showAllLayers(): void {
    studioLayersOn.value = {};
    studioDepthMax.value = 0;
  }
  function setDepthMax(n: unknown): void {
    studioDepthMax.value = Number(n) || 0;
  }
  function layerLabel(l: { index: number; label?: string }): string {
    const ord = layerOrdinal(l.index);
    return ord + (l.label && l.label !== ord ? ` — ${l.label}` : "");
  }

  /** Grands cadres au fond, petits éléments dessus : le clic cible toujours l'élément le plus spécifique. */
  const studioOverlayElements = computed(() =>
    studioLayerFiltered.value.slice().sort((a, b) => surface(b) - surface(a)),
  );

  function studioHitTest(point: readonly number[]): ElementUi | null {
    return deepestAt(studioOverlayElements.value, point);
  }
  function elementName(el: ElementUi | null | undefined): string {
    return realName(el);
  }
  function elementDisplay(el: ElementUi | null | undefined): string {
    if (!el) return "";
    const nm = elementName(el);
    if (nm) return nm;
    return `(${el.role || "élément"} sans nom)`;
  }

  const selectedElementId = ref<string | number>("");
  const studioLastHoverId = ref<string | number>("");
  const studioInspectOpen = ref(false);
  const studioInspectEl = computed<ElementStudio | null>(() => {
    const els = studioElements.value;
    const pick = (id: string | number | null | undefined): ElementStudio | null =>
      (id ? els.find((e) => e && e.id === id) : null) || null;
    return (
      pick(hoveredElementId.value) ||
      pick(selectedElementId.value) ||
      pick(hoveredElementId.value || studioLastHoverId.value)
    );
  });
  const studioInspectInfo = computed(() => {
    const el = studioInspectEl.value;
    if (!el) return null;
    const els = studioElements.value;
    const crumbs = elementAncestors(els, el) as ElementStudio[];
    const anchor = anchorFromElement(el, els);
    const quality = anchorQuality(anchor);
    const target = targetKwargs(anchor);
    const info = { el, crumbs, anchor, quality, target, path: anchor.path || "" };
    return info;
  });
  const studioInspectRows = computed(() => {
    const info = studioInspectInfo.value;
    if (!info) return [];
    const el = info.el;
    const rows: Array<{ k: string; v: string }> = [];
    const put = (k: string, v: unknown): void => {
      if (v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)) {
        rows.push({ k, v: Array.isArray(v) ? v.join(", ") : String(v) });
      }
    };
    put("rôle", el.role);
    put("nom", elementName(el));
    put("auto_id", el.auto_id);
    put("classe", el["class_name"]);
    put("chemin", info.path);
    put("box", el.box);
    put("centre", el.center);
    put("états", el.states);
    put("patterns", el.patterns);
    put("valeur", el["value"]);
    put("profondeur", el.depth);
    put("source", el.source);
    put("id", el.id);
    return rows;
  });
  function qualityLabel(q: string): string {
    return (
      (
        { uia: "UIA", nom: "nom", chemin: "chemin", vision: "vision", coords: "x,y" } as Record<
          string,
          string
        >
      )[q] || "—"
    );
  }
  function qualityClass(q: string): string {
    return (
      (
        {
          uia: "bg-emerald-100 text-emerald-700",
          nom: "bg-blue-100 text-blue-700",
          chemin: "bg-amber-100 text-amber-700",
          vision: "bg-violet-100 text-violet-700",
          coords: "bg-red-100 text-red-700",
        } as Record<string, string>
      )[q] || "bg-slate-100 text-slate-500"
    );
  }

  const studioAuditOpen = ref(false);
  const studioAudit = computed(() => a11yAudit(studioElements.value) as unknown as AuditStudio);
  function toggleStudioAudit(): void {
    studioAuditOpen.value = !studioAuditOpen.value;
  }

  const studioTreeDock = ref(
    lireStockage("studioTreeDock") === null ? true : lireStockage("studioTreeDock") === "1",
  );
  const studioExpert = ref(lireStockage("studioExpert") === "1");
  function definirStudioExpert(actif: boolean): void {
    studioExpert.value = actif;
    ecrireStockage("studioExpert", actif ? "1" : "0");
  }
  const studioTreeWidth = ref(
    (() => {
      const v = Number(lireStockage("studioTreeWidth"));
      return isFinite(v) && v >= TREE_W_MIN ? Math.min(TREE_W_MAX, v) : TREE_W_DEFAULT;
    })(),
  );
  const memoriserDock = (): void => ecrireStockage("studioTreeDock", studioTreeDock.value ? "1" : "0");
  function toggleStudioTreeDock(): void {
    studioTreeDock.value = !studioTreeDock.value;
    memoriserDock();
  }
  function openStudioTreeDock(): void {
    if (!studioTreeDock.value) {
      studioTreeDock.value = true;
      memoriserDock();
    }
  }
  function studioTreeDockReset(): void {
    studioTreeWidth.value = TREE_W_DEFAULT;
    ecrireStockage("studioTreeWidth", String(TREE_W_DEFAULT));
  }
  /** Poignée sur le bord gauche : glisser vers la gauche élargit l'arbre (la scène rétrécit). */
  function studioTreeDockDragStart(ev: PointerEvent): void {
    if (!ev || ev.button) return;
    const startX = ev.clientX;
    const startW = studioTreeWidth.value;
    const el = ev.currentTarget as HTMLElement;
    const move = (e: PointerEvent): void => {
      studioTreeWidth.value = Math.round(
        Math.max(TREE_W_MIN, Math.min(TREE_W_MAX, startW + (startX - e.clientX))),
      );
    };
    const up = (): void => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      ecrireStockage("studioTreeWidth", String(studioTreeWidth.value));
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
  function exportStudioAudit(): void {
    try {
      const csv = a11yAuditCsv(studioAudit.value);
      const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-accessibilite-${studioFrame.value.target || "cible"}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast("Export impossible", "error");
    }
  }
  async function copyStudioTarget(): Promise<void> {
    const info = studioInspectInfo.value;
    if (!info || !info.target) return;
    try {
      await navigator.clipboard.writeText(info.target);
      toast("Cible copiée");
    } catch {
      toast("Copie impossible", "error");
    }
  }

  async function loadStudioTargets(): Promise<void> {
    try {
      const r = await fetchAuth("/api/desktop/targets");
      if (!r || !r.ok) {
        studioTargets.value = [];
        return;
      }
      const data = (await lireJson(r, "cibles")) as { targets?: CibleStudio[] };
      studioTargets.value = Array.isArray(data.targets) ? data.targets : [];
    } catch {
      studioTargets.value = [];
    }
    if (!selectedTarget.value && studioTargets.value.length) {
      const def = studioTargets.value.find((t) => t.default) || studioTargets.value[0];
      selectedTarget.value = def ? def.name : "";
    }
  }

  async function ensureDesktopTargets(): Promise<void> {
    if (!studioTargets.value.length) await loadStudioTargets();
    if (!activeChargee) {
      activeChargee = true;
      try {
        const r = await fetchAuth("/api/desktop/active-target");
        const d = r && r.ok ? await lireJson(r, "cibleActive") : {};
        desktopActiveTarget.value = String(d["target"] || "");
      } catch {
        desktopActiveTarget.value = "";
      }
    }
  }
  async function setDesktopActiveTarget(name: string): Promise<void> {
    desktopActiveTarget.value = name || "";
    try {
      await fetchAuth("/api/desktop/active-target", {
        method: "POST",
        body: JSON.stringify({ target: name || "" }),
      });
      toast(name ? `Cible active : ${name}` : "Cible : défaut");
    } catch {
      toast("Échec changement de cible", "error");
    }
  }

  function openStudio(): void {
    currentView.value = "studio";
    void loadStudioTargets();
  }

  /** Quitter révoque la capture (blob) : l'écran de la machine cible ne reste pas vivant dans le tas. */
  function closeStudio(): void {
    currentView.value = "chat";
    if (minuterieLive) {
      clearTimeout(minuterieLive);
      minuterieLive = null;
    }
    activeChargee = false;
    sequenceTrame++;
    clearStudio();
  }

  function selectTarget(name: string): void {
    selectedTarget.value = name;
  }
  function highlightElement(id: string | number | null): void {
    hoveredElementId.value = id;
    if (id) studioLastHoverId.value = id;
  }
  function clearHighlight(): void {
    hoveredElementId.value = null;
  }
  function setStudioText(text: string, region: string): void {
    studioText.value = { text: text || "", region: region || "" };
  }

  function clearStudio(): void {
    if (dernierBlob) {
      try {
        URL.revokeObjectURL(dernierBlob);
      } catch {
        /* URL déjà révoquée */
      }
      dernierBlob = "";
    }
    studioFrame.value = trameVide();
    studioError.value = "";
    studioText.value = null;
    hoveredElementId.value = null;
    studioLastHoverId.value = "";
    selectedElementId.value = "";
    studioLive.value = false;
    if (minuterieLive) {
      clearTimeout(minuterieLive);
      minuterieLive = null;
    }
  }

  /** Point d'entrée unique des images (live et manuel) ; seule la dernière demande écrit (jeton de séquence). */
  async function applyFrame(frame: TrameFil | null | undefined): Promise<void> {
    if (!frame) return;
    const maSeq = ++sequenceTrame;
    const url = frame.image_url || frame.imageUrl || "";
    let blobUrl = "";
    let natW = 0;
    let natH = 0;
    if (url) {
      try {
        const r = await fetchAuth(url);
        if (r && r.ok) {
          const blob = await r.blob();
          blobUrl = URL.createObjectURL(blob);
          // Dimensions lues sur l'image : sans elles le viewBox tombe à « 0 0 1 1 » et les annotations sont projetées hors champ.
          try {
            const bmp = await createImageBitmap(blob);
            natW = bmp.width;
            natH = bmp.height;
            if (bmp.close) bmp.close();
          } catch {
            /* repli : onStageImgLoad */
          }
        }
      } catch {
        /* les boîtes restent même si l'image échoue */
      }
    }
    if (maSeq !== sequenceTrame) {
      if (blobUrl) {
        try {
          URL.revokeObjectURL(blobUrl);
        } catch {
          /* URL déjà révoquée */
        }
      }
      return;
    }
    if (dernierBlob) {
      try {
        URL.revokeObjectURL(dernierBlob);
      } catch {
        /* URL déjà révoquée */
      }
    }
    dernierBlob = blobUrl;
    studioFrame.value = {
      imageUrl: blobUrl,
      boxes: Array.isArray(frame.boxes) ? frame.boxes : [],
      imgW: Number(frame.img_w || frame.imgW || 0) || natW || 0,
      imgH: Number(frame.img_h || frame.imgH || 0) || natH || 0,
      target: frame.target || selectedTarget.value || "",
      sig: frame.sig || "",
      treeCapped: !!frame.tree_capped,
      treeNodes: Number(frame.tree_nodes || 0),
      ts: frame.ts || Date.now(),
    };
    if (frame.target && !selectedTarget.value) selectedTarget.value = frame.target;
    studioLive.value = true;
    if (minuterieLive) clearTimeout(minuterieLive);
    minuterieLive = setTimeout(() => {
      studioLive.value = false;
    }, 2500);
  }

  async function captureAndAnnotate(): Promise<void> {
    if (studioCapturing.value) return;
    if (!selectedTarget.value) {
      toast("Choisis une cible", "error");
      return;
    }
    studioCapturing.value = true;
    studioError.value = "";
    try {
      const r = await fetchAuth("/api/desktop/capture", {
        method: "POST",
        body: JSON.stringify({
          target: selectedTarget.value,
          prompt: (studioPrompt.value || "").trim(),
          raw: studioRaw.value,
        }),
      });
      const data = (await lireJson(r, "capture")) as TrameFil & {
        message?: string;
        error?: string;
        ok?: boolean;
        note?: string;
      };
      if (!r || !r.ok || data.ok === false) {
        studioError.value = data.message || data.error || "Capture échouée";
        toast(studioError.value, "error");
      } else {
        await applyFrame(data);
        if (data.note)
          toast(data.note, String(data.note).startsWith("annotation vision KO") ? "warning" : "info");
      }
    } catch (e) {
      studioError.value = String(e instanceof Error ? e.message : e);
      toast("Capture échouée", "error");
    } finally {
      studioCapturing.value = false;
    }
  }

  async function loadMonitors(): Promise<void> {
    if (!selectedTarget.value) {
      studioMonitors.value = [];
      return;
    }
    try {
      const r = await fetchAuth(
        `/api/desktop/monitors?target=${encodeURIComponent(selectedTarget.value)}`,
        {},
        true,
      );
      const d = r && r.ok ? await lireJson(r, "ecrans") : {};
      studioMonitors.value = Array.isArray(d["monitors"]) ? (d["monitors"] as MoniteurStudio[]) : [];
      if (typeof d["selected"] === "number") studioMonitor.value = d["selected"];
    } catch {
      studioMonitors.value = [];
    }
  }
  function toggleStudioSettings(): void {
    studioSettingsOpen.value = !studioSettingsOpen.value;
    if (studioSettingsOpen.value) void loadMonitors();
  }
  function toggleStudioActions(): void {
    studioActionsOpen.value = !studioActionsOpen.value;
  }
  function studioActionRead(): void {
    studioActionsOpen.value = false;
    void readText();
  }
  function studioActionClear(): void {
    studioActionsOpen.value = false;
    clearStudio();
  }
  async function selectMonitor(idx: number): Promise<void> {
    if (!selectedTarget.value) {
      toast("Choisis une cible", "error");
      return;
    }
    try {
      const r = await fetchAuth("/api/desktop/select-monitor", {
        method: "POST",
        body: JSON.stringify({ target: selectedTarget.value, monitor: idx }),
      });
      const d = await lireJson(r, "choixEcran");
      if (!r || !r.ok || d["ok"] === false) {
        toast(String(d["error"] || "Sélection écran échouée"), "error");
        return;
      }
      studioMonitor.value = typeof d["selected"] === "number" ? d["selected"] : idx;
      toast("Écran sélectionné");
      if (studioFrame.value.imageUrl) void captureAndAnnotate();
    } catch {
      toast("Sélection écran échouée", "error");
    }
  }

  /** OCR : lit le texte visible de la cible (ce que l'arbre d'accessibilité n'expose pas) ; la requête de la barre cible une zone. */
  async function readText(): Promise<void> {
    if (studioReading.value) return;
    if (!selectedTarget.value) {
      toast("Choisis une cible", "error");
      return;
    }
    studioReading.value = true;
    studioError.value = "";
    try {
      const r = await fetchAuth("/api/desktop/read", {
        method: "POST",
        body: JSON.stringify({ target: selectedTarget.value, query: (studioPrompt.value || "").trim() }),
      });
      const data = await lireJson(r, "lecture");
      if (!r || !r.ok || data["ok"] === false) {
        studioError.value = String(data["message"] || data["error"] || "Lecture échouée");
        toast(studioError.value, "error");
      } else {
        studioText.value = {
          text: String(data["text"] || "(aucun texte)"),
          region: String(data["region"] || ""),
        };
      }
    } catch (e) {
      studioError.value = String(e instanceof Error ? e.message : e);
      toast("Lecture échouée", "error");
    } finally {
      studioReading.value = false;
    }
  }

  function onStageImgLoad(ev: Event): void {
    const img = ev && (ev.target as SVGImageElement | HTMLImageElement | null);
    if (!img) return;
    measureStage((img as SVGImageElement).ownerSVGElement || null);
    if (!studioFrame.value.imgW || !studioFrame.value.imgH) {
      const i = img as unknown as { naturalWidth?: number; naturalHeight?: number };
      studioFrame.value = {
        ...studioFrame.value,
        imgW: i.naturalWidth || studioFrame.value.imgW,
        imgH: i.naturalHeight || studioFrame.value.imgH,
      };
    }
  }

  function fmtConfidence(c: unknown): string {
    const n = Number(c || 0);
    return n > 0 ? `${Math.round(n * 100)}%` : "—";
  }
  function boxStroke(el: ElementUi | null | undefined): string {
    if (el && el.id === selectedElementId.value) return "var(--accent)";
    if (el && el.id === hoveredElementId.value) return "var(--warn-soft)";
    return "var(--accent-300)";
  }

  const studioZoom = ref<"fit" | number>("fit");
  const studioPan = ref({ x: 0, y: 0 });
  const studioStage = ref({ w: 0, h: 0 });
  const studioDensity = ref("leaves");
  let elementScene: Element | null = null;

  /** Mesure le cadre à l'écran ; l'objet n'est remplacé que si la taille change (chaque nouvel objet re-rend l'overlay). */
  function measureStage(el?: Element | null): void {
    if (el) elementScene = el;
    if (!elementScene) return;
    const r = elementScene.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const cur = studioStage.value;
    if (cur && cur.w === r.width && cur.h === r.height) return;
    studioStage.value = { w: r.width, h: r.height };
  }
  if (typeof window !== "undefined") {
    let enFile = false;
    const surRedim = (): void => {
      if (enFile || currentView.value !== "studio") return;
      enFile = true;
      requestAnimationFrame(() => {
        enFile = false;
        measureStage();
      });
    };
    window.addEventListener("resize", surRedim);
    if (getCurrentScope() !== undefined) onScopeDispose(() => window.removeEventListener("resize", surRedim));
  }

  const studioFitScale = computed(() => {
    const f = studioFrame.value;
    const s = studioStage.value;
    if (!f.imgW || !f.imgH || !s.w || !s.h) return 1;
    return Math.min(s.w / f.imgW, s.h / f.imgH);
  });
  const studioScale = computed(() =>
    studioZoom.value === "fit"
      ? studioFitScale.value
      : Math.max(studioFitScale.value, Number(studioZoom.value) || 1),
  );
  /** Le viewBox EST la fenêtre sur l'image : tout clic doit passer par la matrice du SVG, pas par un calcul d'échelle refait à la main. */
  const studioViewBox = computed(() => {
    const f = studioFrame.value;
    const W = f.imgW || 1;
    const H = f.imgH || 1;
    if (studioZoom.value === "fit") return `0 0 ${W} ${H}`;
    const st = studioStage.value;
    const sc = studioScale.value;
    const vw = Math.min(W, (st.w || W) / sc);
    const vh = Math.min(H, (st.h || H) / sc);
    const x = Math.max(0, Math.min(W - vw, studioPan.value.x));
    const y = Math.max(0, Math.min(H - vh, studioPan.value.y));
    return `${x} ${y} ${vw} ${vh}`;
  });
  function vueRect(): { x: number; y: number; w: number; h: number } {
    const parts = String(studioViewBox.value).split(/\s+/).map(Number);
    const rect = { x: parts[0] || 0, y: parts[1] || 0, w: parts[2] || 1, h: parts[3] || 1 };
    return rect;
  }
  /** Zoome en gardant le point visé immobile. */
  function setStudioZoom(suivant: "fit" | number, ancre?: readonly number[] | null): void {
    const f = studioFrame.value;
    const plancher = studioFitScale.value;
    const cible = suivant === "fit" ? "fit" : Math.max(plancher, Math.min(ZOOM_MAX, Number(suivant) || 1));
    if (cible === "fit") {
      studioZoom.value = "fit";
      studioPan.value = { x: 0, y: 0 };
      return;
    }
    const avant = vueRect();
    const st = studioStage.value;
    const ax = ancre ? (ancre[0] ?? 0) : avant.x + avant.w / 2;
    const ay = ancre ? (ancre[1] ?? 0) : avant.y + avant.h / 2;
    const u = avant.w ? (ax - avant.x) / avant.w : 0.5;
    const v = avant.h ? (ay - avant.y) / avant.h : 0.5;
    const vw = Math.min(f.imgW || 1, (st.w || 1) / cible);
    const vh = Math.min(f.imgH || 1, (st.h || 1) / cible);
    studioZoom.value = cible;
    studioPan.value = { x: ax - u * vw, y: ay - v * vh };
  }
  function zoomStudio(facteur: number, ancre?: readonly number[] | null): void {
    setStudioZoom((studioZoom.value === "fit" ? studioFitScale.value : studioScale.value) * facteur, ancre);
  }
  function panStudio(dx: number, dy: number): void {
    if (studioZoom.value === "fit") return;
    const vue = vueRect();
    studioPan.value = { x: vue.x + dx, y: vue.y + dy };
  }

  /** Feuilles : éléments qui n'en contiennent aucun autre, pour casser l'empilement conteneur et cellules. */
  const studioLeafIds = computed(() => {
    const els = studioElements.value.filter((e) => e && e.box);
    const feuilles = new Set(els.map((e) => e.id));
    for (const ext of els) {
      const [ax1 = 0, ay1 = 0, ax2 = 0, ay2 = 0] = ext.box ?? [];
      for (const int of els) {
        if (int === ext || !feuilles.has(ext.id)) continue;
        const [bx1 = 0, by1 = 0, bx2 = 0, by2 = 0] = int.box ?? [];
        const dedans = bx1 >= ax1 - 1 && by1 >= ay1 - 1 && bx2 <= ax2 + 1 && by2 <= ay2 + 1;
        if (dedans && surface(int) < surface(ext) * 0.95) {
          feuilles.delete(ext.id);
          break;
        }
      }
    }
    return feuilles;
  });
  const studioVisibleElements = computed(() => {
    const tout = studioOverlayElements.value;
    if (studioDensity.value === "all") return tout;
    const feuilles = studioLeafIds.value;
    return tout.filter((el) => feuilles.has(el.id));
  });

  const studioFilter = ref("");
  const treeCollapsed = ref<Record<string, boolean>>({});
  const studioTreeRows = computed(
    () =>
      elementTreeRows(
        studioLayerFiltered.value,
        treeCollapsed.value,
        studioFilter.value,
      ) as LigneArbreStudio[],
  );
  const selectedElement = computed(
    () => studioElements.value.find((e) => e && e.id === selectedElementId.value) || null,
  );

  function toggleTreeCollapse(id: string | number): void {
    const c = Object.assign({}, treeCollapsed.value);
    if (c[id]) delete c[id];
    else c[id] = true;
    treeCollapsed.value = c;
  }
  function expandAllTree(): void {
    treeCollapsed.value = {};
  }
  function collapseAllTree(): void {
    const els = studioElements.value;
    const c: Record<string, boolean> = {};
    for (let i = 0; i < els.length; i++) {
      const nd = Number((els[i + 1] || {}).depth);
      const cur = els[i];
      if (cur && !isNaN(nd) && nd > Number(cur.depth || 0)) c[String(cur.id)] = true;
    }
    treeCollapsed.value = c;
  }
  function selectStudioElement(id: string | number, reveal?: boolean): void {
    if (reveal === true) selectedElementId.value = id;
    else selectedElementId.value = selectedElementId.value === id ? "" : id;
    if (!selectedElementId.value) return;
    revealInTree(selectedElementId.value);
  }
  function revealInTree(id: string | number): void {
    openStudioTreeDock();
    const els = studioElements.value;
    const el = els.find((e) => e && e.id === id);
    if (!el) return;
    const anc = elementAncestors(els, el);
    if (anc.some((a) => treeCollapsed.value[String(a.id)])) {
      const c = Object.assign({}, treeCollapsed.value);
      for (const a of anc) delete c[String(a.id)];
      treeCollapsed.value = c;
    }
    void nextTick(() => {
      try {
        const row = document.querySelector(
          `.elpis-studio-page [data-el-id="${String(id).replace(/"/g, "")}"]`,
        );
        if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
      } catch {
        /* hors DOM */
      }
    });
  }
  function roleIcon(role: unknown): string {
    return ICONES_ROLE[String(role || "").toLowerCase()] || "ph-dot-outline";
  }

  return {
    studioFrame,
    studioElements,
    studioOverlayElements,
    studioTargets,
    selectedTarget,
    studioPrompt,
    studioText,
    studioRaw,
    studioLive,
    studioCapturing,
    studioReading,
    studioError,
    hoveredElementId,
    desktopActiveTarget,
    studioSettingsOpen,
    studioMonitors,
    studioMonitor,
    toggleStudioSettings,
    loadMonitors,
    selectMonitor,
    studioActionsOpen,
    toggleStudioActions,
    studioActionRead,
    studioActionClear,
    studioFilter,
    treeCollapsed,
    selectedElementId,
    studioTreeRows,
    selectedElement,
    toggleTreeCollapse,
    expandAllTree,
    collapseAllTree,
    selectStudioElement,
    revealInTree,
    roleIcon,
    studioTreeDock,
    studioExpert,
    definirStudioExpert,
    studioTreeWidth,
    toggleStudioTreeDock,
    openStudioTreeDock,
    studioTreeDockReset,
    studioTreeDockDragStart,
    studioAuditOpen,
    studioAudit,
    toggleStudioAudit,
    exportStudioAudit,
    studioHitTest,
    elementName,
    elementDisplay,
    studioLastHoverId,
    studioInspectOpen,
    studioInspectEl,
    studioInspectInfo,
    studioInspectRows,
    qualityLabel,
    qualityClass,
    copyStudioTarget,
    openStudio,
    closeStudio,
    loadStudioTargets,
    captureAndAnnotate,
    applyFrame,
    clearStudio,
    readText,
    ensureDesktopTargets,
    setDesktopActiveTarget,
    setStudioText,
    selectTarget,
    highlightElement,
    clearHighlight,
    onStageImgLoad,
    studioLayersOpen,
    studioLayersOn,
    studioDepthMax,
    studioLayers,
    studioLayerActive,
    studioLayerFiltered,
    toggleStudioLayers,
    isLayerOn,
    toggleLayer,
    soloLayer,
    showAllLayers,
    setDepthMax,
    layerLabel,
    fmtConfidence,
    boxStroke,
    isContainerBox,
    studioZoom,
    studioPan,
    studioStage,
    studioDensity,
    studioViewBox,
    studioScale,
    studioFitScale,
    studioVisibleElements,
    studioLeafIds,
    measureStage,
    setStudioZoom,
    zoomStudio,
    panStudio,
  };
}

export type SurfaceMenuStudio = ReturnType<typeof creerMenuStudio>;
