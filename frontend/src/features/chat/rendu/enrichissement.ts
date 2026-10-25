// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/rendu/enrichissement.ts — passe d'enrichissement des blocs d'un corps Markdown : en-tête et Copier, aperçu HTML, coloration différée, graphiques, Mermaid, SVG ; idempotente (data-cb-done). */
import DOMPurify from "dompurify";

import { ensureVendor } from "../../../platform/vendor.ts";
import { mouvementReduit } from "../../../utils/dom.ts";
import { ElpisCharts } from "./graphiques.ts";
import type { OptionBrute } from "./graphiques.ts";
import { ouvrirZoomDiagramme } from "./zoom-diagramme.ts";
import { ressembleASvg, sanitizeSvg } from "./svg.ts";
import type { PurifySvg } from "./svg.ts";

interface Mermaid {
  initialize(config: Readonly<Record<string, unknown>>): void;
  render(id: string, source: string): Promise<{ svg: string }>;
}

interface GlobalsEnrichissement {
  mermaid?: Mermaid;
  hljs?: { highlightElement(el: Element): void };
  echarts?: unknown;
}

export interface DependancesEnrichissement {
  fetch: (url: string) => Promise<Response>;
  chatCourant: () => string;
}

/** Marqueur des corps possédés par un composant : la passe historique (portée large) ne les touche pas. */
export const ATTRIBUT_COMPOSANT = "data-elpis-enrichi";
/** Zone où un graphique n'est pas tracé (texte d'étape, volet d'agent) : seule la réponse finale en trace. */
export const ATTRIBUT_SANS_GRAPHIQUES = "data-sans-graphiques";

const CACHE_GRAPHIQUES_MAX = 100;
const cacheGraphiques = new Map<string, unknown>();
let compteurMermaid = 0;
let compteurSvg = 0;
let dependances: DependancesEnrichissement = {
  fetch: (url) => fetch(url, { credentials: "same-origin" }),
  chatCourant: () => "",
};

function g(): GlobalsEnrichissement {
  return window as unknown as GlobalsEnrichissement;
}

/** Branche le client HTTP authentifié et le chat courant (chart-ref) ; appelé par le setup historique du rendu. */
export function configurerEnrichissement(dep: Partial<DependancesEnrichissement>): void {
  dependances = { ...dependances, ...dep };
}

function nettoyerSvg(raw: unknown): string | null {
  return sanitizeSvg(raw, DOMPurify as unknown as PurifySvg);
}

function surfaceSombre(): boolean {
  try {
    return document.body.classList.contains("elpis-dark-surface");
  } catch {
    return false;
  }
}

function themeMermaid(): string {
  return surfaceSombre() ? "dark" : "default";
}

function initialiserMermaid(m: Mermaid): void {
  m.initialize({
    startOnLoad: false,
    theme: themeMermaid(),
    securityLevel: "strict",
    flowchart: { useMaxWidth: true, htmlLabels: false },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
  });
}

function retenirGraphique(cle: string, config: unknown): void {
  if (cacheGraphiques.has(cle)) cacheGraphiques.delete(cle);
  cacheGraphiques.set(cle, config);
  while (cacheGraphiques.size > CACHE_GRAPHIQUES_MAX) {
    const ancien = cacheGraphiques.keys().next().value;
    if (ancien === undefined) break;
    cacheGraphiques.delete(ancien);
  }
}

/** Graphiques dont l'hôte a quitté le DOM (édition, défilement virtuel, changement de chat). */
export function balayerGraphiques(): void {
  ElpisCharts.sweep();
}

export function viderGraphiques(): void {
  ElpisCharts.disposeAll();
}

function remplacer(ancien: Element, nouveau: Element): void {
  if (ancien.parentNode) ancien.parentNode.replaceChild(nouveau, ancien);
}

function messageErreur(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e as string);
}

function erreurGraphique(pre: Element, rawText: string, renderErr?: unknown): void {
  const wrapper = document.createElement("div");
  wrapper.className = "chart-render-error rounded-xl border border-amber-200 bg-amber-50 p-4 mb-4";
  const head = document.createElement("div");
  head.className = "flex items-start gap-2 mb-2";
  const icon = document.createElement("i");
  icon.className = "ph ph-warning-circle text-amber-600 text-base mt-0.5";
  head.appendChild(icon);
  const middle = document.createElement("div");
  middle.className = "flex-1";
  const titleEl = document.createElement("div");
  titleEl.className = "text-xs font-bold text-amber-800 uppercase tracking-wide";
  titleEl.textContent = "Graphique non rendu";
  middle.appendChild(titleEl);
  const reasonEl = document.createElement("div");
  reasonEl.className = "text-xs text-amber-700 mt-0.5";
  reasonEl.textContent = renderErr
    ? "Erreur de rendu : " + messageErreur(renderErr)
    : "Le graphique n'a pas pu être chargé.";
  middle.appendChild(reasonEl);
  head.appendChild(middle);
  const toggleBtn = document.createElement("button");
  toggleBtn.className =
    "toggle-raw text-[10px] text-amber-600 hover:text-amber-800 font-medium flex items-center gap-1";
  const btnIcon = document.createElement("i");
  btnIcon.className = "ph ph-code text-xs";
  toggleBtn.appendChild(btnIcon);
  toggleBtn.appendChild(document.createTextNode(" Voir le code"));
  head.appendChild(toggleBtn);
  wrapper.appendChild(head);
  const codeBlock = document.createElement("pre");
  codeBlock.className =
    "hidden text-[10px] font-mono text-slate-700 bg-white border border-amber-200 rounded-lg p-3 mt-2 max-h-48 overflow-auto whitespace-pre-wrap";
  codeBlock.textContent = rawText;
  wrapper.appendChild(codeBlock);
  toggleBtn.onclick = () => codeBlock.classList.toggle("hidden");
  remplacer(pre, wrapper);
}

function noticeAncienGraphique(pre: Element): void {
  const box = document.createElement("div");
  box.className =
    "chart-render-error rounded-xl border border-dashed p-3 mb-4 text-xs " +
    (surfaceSombre() ? "border-slate-600 text-slate-400" : "border-slate-300 text-slate-500");
  const ic = document.createElement("i");
  ic.className = "ph ph-chart-bar mr-1";
  box.appendChild(ic);
  box.appendChild(
    document.createTextNode(
      "Graphique d'un ancien format, qui n'est plus affiché. Redemandez-le pour le tracer à nouveau.",
    ),
  );
  remplacer(pre, box);
}

function estOptionEcharts(cfg: unknown): cfg is OptionBrute {
  if (!cfg || typeof cfg !== "object") return false;
  const e = (cfg as { _elpis?: unknown })._elpis;
  return !!e && typeof e === "object";
}

function monterGraphique(pre: Element, cfg: unknown): void {
  if (!pre.parentNode) return;
  if (!estOptionEcharts(cfg)) {
    noticeAncienGraphique(pre);
    return;
  }
  const option = cfg;
  const w = g();
  const go = (): void => {
    if (pre.parentNode) ElpisCharts.mount(pre, option);
  };
  if (w.echarts) {
    go();
    return;
  }
  ensureVendor("echarts").then(go, (e: unknown) => {
    erreurGraphique(pre, "[graphique : échec du chargement d'ECharts]", e);
  });
}

// Hors réponse finale, la référence devient une mention discrète ; le graphique est tracé dans la réponse.
function graphiqueOuRenvoi(cible: Element, brut: string): void {
  if (!cible.closest("[" + ATTRIBUT_SANS_GRAPHIQUES + "]")) return blocReferenceGraphique(cible, brut);
  const note = document.createElement("span");
  note.className = "text-[12px] italic text-slate-400";
  note.setAttribute("data-renvoi-graphique", brut.trim());
  note.textContent = "graphique dans la réponse";
  cible.replaceWith(note);
}

function blocReferenceGraphique(pre: Element, brut: string): void {
  const chartId = String(brut || "")
    .trim()
    .toLowerCase();
  if (!chartId) {
    erreurGraphique(pre, "[chart-ref : id vide]");
    return;
  }
  const enCache = cacheGraphiques.get(chartId);
  if (enCache) {
    monterGraphique(pre, enCache);
    return;
  }
  const code = pre.querySelector("code");
  if (code) code.textContent = "Chargement du graphique " + chartId + "…";
  const cid = dependances.chatCourant();
  const url =
    "/api/charts/" + encodeURIComponent(chartId) + (cid ? "?chat_id=" + encodeURIComponent(cid) : "");
  dependances
    .fetch(url)
    .then((r) => r.json() as Promise<unknown>)
    .then((data) => {
      const d = (data ?? {}) as { ok?: unknown; config?: unknown; detail?: unknown };
      if (d.ok && d.config) {
        retenirGraphique(chartId, d.config);
        monterGraphique(pre, d.config);
      } else {
        const detail = typeof d.detail === "string" && d.detail ? d.detail : "introuvable";
        erreurGraphique(pre, "[chart-ref " + chartId + " — " + detail + "]");
      }
    })
    .catch((err: unknown) => erreurGraphique(pre, "[chart-ref " + chartId + " — échec du chargement]", err));
}

const REF_TEXTE = /!([0-9a-fA-F]{12})\b/;
const REF_CODE = /^\s*!([0-9a-fA-F]{12})\s*$/;

function porteur(): HTMLDivElement {
  const holder = document.createElement("div");
  holder.className = "chart-ref-holder";
  return holder;
}

/** Références `!id` (12 hex) en ligne ou en code inline : remplacées par un graphique. */
function referencesEnLigne(scope: ParentNode, corps: readonly Element[]): void {
  scope.querySelectorAll(".markdown-body code").forEach((codeEl) => {
    if (codeEl.closest(".chart-ref-holder")) return;
    const mm = (codeEl.textContent || "").match(REF_CODE);
    if (!mm || !mm[1]) return;
    const pre = codeEl.parentNode as Element | null;
    const cible =
      pre && pre.tagName === "PRE" && (pre.textContent || "").trim() === (codeEl.textContent || "").trim()
        ? pre
        : codeEl;
    if (!cible.parentNode) return;
    const holder = porteur();
    cible.parentNode.replaceChild(holder, cible);
    graphiqueOuRenvoi(holder, mm[1]);
  });
  for (const body of corps) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let p = node.parentNode as Element | null;
        while (p && p !== body) {
          const tag = p.tagName;
          if (tag === "PRE" || tag === "CODE" || tag === "A") return NodeFilter.FILTER_REJECT;
          if (
            p.classList &&
            (p.classList.contains("chart-render") ||
              p.classList.contains("chart-render-error") ||
              p.classList.contains("chart-ref-holder"))
          )
            return NodeFilter.FILTER_REJECT;
          p = p.parentNode as Element | null;
        }
        return REF_TEXTE.test(node.nodeValue || "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    const hits: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) hits.push(n as Text);
    for (const textNode of hits) {
      let node: Text | null = textNode;
      let m: RegExpMatchArray | null;
      let garde = 256;
      while (node && (m = (node.nodeValue || "").match(REF_TEXTE)) && garde-- > 0) {
        try {
          const after: Text = node.splitText(m.index ?? 0);
          const rest: Text = after.splitText(m[0].length);
          const holder = porteur();
          if (!after.parentNode) break;
          after.parentNode.replaceChild(holder, after);
          graphiqueOuRenvoi(holder, m[1] ?? "");
          node = rest;
        } catch {
          break;
        }
      }
    }
  }
}

function normaliserSvgMermaid(svgEl: SVGElement): void {
  let natW = 0;
  const vb = svgEl.getAttribute("viewBox");
  if (vb) {
    const p = vb.split(/[\s,]+/).map(parseFloat);
    if (p.length === 4 && (p[2] ?? 0) > 0) natW = p[2] ?? 0;
  }
  if (!natW) natW = parseFloat(svgEl.getAttribute("width") || "") || 0;
  svgEl.removeAttribute("width");
  svgEl.removeAttribute("height");
  svgEl.style.display = "block";
  svgEl.style.margin = "0 auto";
  svgEl.style.height = "auto";
  svgEl.style.width = "100%";
  if (natW > 0) svgEl.style.maxWidth = Math.round(Math.max(natW, 360)) + "px";
}

function brancherZoom(cible: Element, carte: Element, safe: string): void {
  const svgEl = cible.querySelector("svg");
  if (!svgEl) return;
  normaliserSvgMermaid(svgEl);
  svgEl.style.cursor = "zoom-in";
  svgEl.addEventListener("click", () => ouvrirZoomDiagramme(safe, nettoyerSvg));
  const zoomBtn = carte.querySelector<HTMLElement>('[data-act="zoom"]');
  if (zoomBtn) zoomBtn.onclick = () => ouvrirZoomDiagramme(safe, nettoyerSvg);
}

function blocCodeDeRepli(pre: HTMLElement, rawText: string, label: string): void {
  const wrapper = document.createElement("div");
  wrapper.className = "code-wrapper relative group mb-4";
  const header = document.createElement("div");
  header.className = "code-header flex justify-between items-center px-3 py-1.5";
  const hdrSpan = document.createElement("span");
  hdrSpan.className = "text-xs font-bold text-gray-400 font-mono";
  hdrSpan.textContent = label;
  header.appendChild(hdrSpan);
  const btn = boutonCopier(rawText);
  pre.parentNode?.insertBefore(wrapper, pre);
  const copyHolder = document.createElement("div");
  copyHolder.className = "copy-sticky";
  const actions = document.createElement("div");
  actions.className = "code-actions";
  actions.appendChild(btn);
  copyHolder.appendChild(actions);
  wrapper.appendChild(copyHolder);
  wrapper.appendChild(header);
  wrapper.appendChild(pre);
}

function blocMermaid(pre: HTMLElement, rawText: string): void {
  const w = g();
  const m = w.mermaid;
  if (!m) {
    if (pre.dataset.mermaidPending === "1") return;
    pre.dataset.mermaidPending = "1";
    ensureVendor("mermaid").then(
      () => {
        delete pre.dataset.mermaidPending;
        if (pre.isConnected) blocMermaid(pre, rawText);
      },
      () => {
        delete pre.dataset.mermaidPending;
        if (pre.isConnected) blocCodeDeRepli(pre, rawText, "MERMAID");
      },
    );
    return;
  }
  const wrapper = document.createElement("div");
  wrapper.className =
    "mermaid-render rounded-xl border p-4 mb-4 shadow-sm " +
    (surfaceSombre() ? "border-slate-700 bg-slate-800" : "border-slate-200 bg-white");
  const hdr = document.createElement("div");
  hdr.className = "flex items-center justify-between mb-3";
  hdr.innerHTML =
    '<span class="text-xs font-bold text-slate-500 uppercase tracking-wide flex items-center gap-1.5"><i class="ph ph-graph text-indigo-500"></i> Diagramme</span>' +
    '<div class="flex items-center gap-2">' +
    '<button data-act="zoom" class="text-[10px] text-slate-400 hover:text-indigo-600 flex items-center gap-1 transition-colors" title="Agrandir"><i class="ph ph-arrows-out text-xs"></i> Agrandir</button>' +
    '<button data-act="code" class="text-[10px] text-slate-400 hover:text-slate-600 flex items-center gap-1 transition-colors" title="Voir le code"><i class="ph ph-code text-xs"></i></button>' +
    "</div>";
  wrapper.appendChild(hdr);
  const codeBlock = document.createElement("pre");
  codeBlock.className =
    "hidden text-[10px] font-mono text-slate-600 bg-slate-50 rounded-lg p-3 mb-3 max-h-40 overflow-auto whitespace-pre-wrap";
  codeBlock.textContent = rawText;
  codeBlock.setAttribute("data-mermaid-src", "1");
  wrapper.appendChild(codeBlock);
  const btnCode = hdr.querySelector<HTMLElement>('[data-act="code"]');
  if (btnCode) btnCode.onclick = () => codeBlock.classList.toggle("hidden");
  const renderDiv = document.createElement("div");
  renderDiv.className = "flex justify-center overflow-auto custom-scrollbar";
  renderDiv.style.maxHeight = "70vh";
  renderDiv.setAttribute("data-mermaid-target", "1");
  wrapper.appendChild(renderDiv);
  remplacer(pre, wrapper);
  const mid = "mermaid_" + ++compteurMermaid;
  const erreur = (msg: string): void => {
    renderDiv.textContent = "";
    const el = document.createElement("div");
    el.className = "text-red-500 text-xs p-2";
    el.textContent = "Erreur Mermaid : " + msg;
    renderDiv.appendChild(el);
  };
  try {
    initialiserMermaid(m);
    m.render(mid, rawText.trim()).then(
      ({ svg }) => {
        const safe = nettoyerSvg(svg) || "";
        renderDiv.innerHTML = safe;
        brancherZoom(renderDiv, hdr, safe);
      },
      (e: unknown) => erreur(e && typeof e === "object" && "message" in e ? messageErreur(e) : ""),
    );
  } catch (e) {
    erreur(e instanceof Error ? e.message : "");
  }
}

function blocSvg(pre: HTMLElement, rawText: string): void {
  const safeSvg = nettoyerSvg(rawText);
  if (!safeSvg) {
    blocCodeDeRepli(pre, rawText, "SVG (invalide)");
    return;
  }
  const wrapper = document.createElement("div");
  wrapper.className = "svg-render rounded-xl border border-slate-200 bg-white mb-4 shadow-sm overflow-hidden";
  const hdr = document.createElement("div");
  hdr.className = "flex items-center justify-between px-4 py-2.5 border-b border-slate-100 bg-slate-50/50";
  hdr.innerHTML =
    '<span class="text-xs font-bold text-slate-500 uppercase tracking-wide flex items-center gap-1.5">' +
    '<i class="ph ph-paint-brush text-rose-500"></i> Illustration' +
    "</span>";
  const copyBtn = document.createElement("button");
  copyBtn.className =
    "text-[10px] text-slate-400 hover:text-rose-600 flex items-center gap-1 transition-colors font-medium";
  copyBtn.innerHTML = '<i class="ph ph-copy text-xs"></i> Copier';
  copyBtn.title = "Copier le code SVG";
  hdr.appendChild(copyBtn);
  wrapper.appendChild(hdr);
  const copie = (): void => {
    const orig = copyBtn.innerHTML;
    copyBtn.innerHTML = '<i class="ph ph-check text-xs text-green-500"></i> Copié';
    setTimeout(() => {
      copyBtn.innerHTML = orig;
    }, 1500);
  };
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(safeSvg);
      copie();
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = safeSvg;
        ta.style.cssText = "position:fixed;left:-9999px;top:0;";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        copie();
      } catch {
        /* presse-papiers indisponible */
      }
    }
  };
  const renderDiv = document.createElement("div");
  renderDiv.className = "svg-canvas flex justify-center items-center p-4 overflow-auto";
  renderDiv.style.maxHeight = "600px";
  renderDiv.innerHTML = safeSvg;
  const svgEl = renderDiv.querySelector("svg");
  if (svgEl) {
    svgEl.style.maxWidth = "100%";
    svgEl.style.height = "auto";
    svgEl.setAttribute("data-svg-id", "chat_svg_" + ++compteurSvg);
  }
  wrapper.appendChild(renderDiv);
  remplacer(pre, wrapper);
}

const ICONE_COPIER = '<i class="ph ph-copy"></i><span class="sr-only">Copier</span>';
// Document d'aperçu servi par le core avec sa propre CSP (un srcdoc hériterait de celle de la page).
const URL_APERCU = "/apercu-code";
const APERCU_PRET = "elpis-apercu-pret";

function boutonApercu(pre: HTMLElement, wrapper: HTMLElement, rawText: string): HTMLButtonElement {
  const previewBtn = document.createElement("button");
  const fermer = (): void => {
    previewBtn.innerHTML = '<i class="ph ph-eye"></i><span>Aperçu</span>';
    previewBtn.title = "Afficher le rendu de la page";
  };
  fermer();
  let iframe: HTMLIFrameElement | null = null;
  let surPret: ((e: MessageEvent) => void) | null = null;
  previewBtn.onclick = () => {
    if (surPret) window.removeEventListener("message", surPret);
    surPret = null;
    if (iframe) {
      iframe.remove();
      iframe = null;
      pre.style.display = "";
      fermer();
      return;
    }
    const cadre = document.createElement("iframe");
    cadre.className = "code-preview-frame";
    cadre.setAttribute("sandbox", "allow-scripts");
    // Origine opaque (sans allow-same-origin) : le HTML part vers « * » et seulement à l'amorce de ce cadre.
    const ecoute = (e: MessageEvent): void => {
      if (!cadre.contentWindow || e.source !== cadre.contentWindow || e.data !== APERCU_PRET) return;
      window.removeEventListener("message", ecoute);
      surPret = null;
      cadre.contentWindow.postMessage(rawText, "*");
    };
    surPret = ecoute;
    window.addEventListener("message", ecoute);
    cadre.src = URL_APERCU;
    iframe = cadre;
    wrapper.appendChild(cadre);
    pre.style.display = "none";
    previewBtn.innerHTML = '<i class="ph ph-code"></i><span>Code</span>';
    previewBtn.title = "Revenir au code";
  };
  return previewBtn;
}

function boutonCopier(rawText: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "copy-btn";
  btn.title = "Copier";
  btn.setAttribute("aria-label", "Copier");
  btn.innerHTML = ICONE_COPIER;
  btn.onclick = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(rawText);
      else {
        const ta = Object.assign(document.createElement("textarea"), { value: rawText });
        ta.style.cssText = "position:fixed;left:-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      btn.innerHTML = '<i class="ph ph-check text-green-400"></i><span class="sr-only">Copié</span>';
      setTimeout(() => {
        btn.innerHTML = ICONE_COPIER;
      }, 2000);
    } catch {
      /* presse-papiers refusé */
    }
  };
  return btn;
}

function colorationDifferee(code: HTMLElement | null): void {
  const w = g();
  if (!code || w.hljs || code.dataset.hlPending) return;
  code.dataset.hlPending = "1";
  ensureVendor("highlight").then(
    () => {
      delete code.dataset.hlPending;
      const hl = g().hljs;
      if (!code.isConnected || !hl) return;
      try {
        hl.highlightElement(code);
      } catch {
        /* langue inconnue : le code reste échappé et lisible */
      }
    },
    () => {
      delete code.dataset.hlPending;
    },
  );
}

function enrichirPre(pre: HTMLElement): void {
  if (pre.hasAttribute("data-cb-done")) return;
  const parent = pre.parentNode as Element | null;
  if (!parent || parent.classList?.contains("code-wrapper")) return;
  pre.setAttribute("data-cb-done", "1");
  const code = pre.querySelector("code");
  pre.classList.add("custom-style-applied");
  const langClass = code ? Array.from(code.classList).find((c) => c.startsWith("language-")) : "";
  const lang = langClass ? langClass.replace("language-", "").toLowerCase() : "";
  const rawText = (code ? code.textContent : pre.textContent) || "";
  if (lang === "chart-ref") return graphiqueOuRenvoi(pre, rawText);
  if (lang === "mermaid") return blocMermaid(pre, rawText);
  if (lang === "svg") return blocSvg(pre, rawText);
  if ((lang === "" || lang === "xml" || lang === "html" || lang === "plaintext") && ressembleASvg(rawText))
    return blocSvg(pre, rawText);
  colorationDifferee(code);
  const wrapper = document.createElement("div");
  wrapper.className = "code-wrapper relative group mb-4";
  const header = document.createElement("div");
  header.className = "code-header flex justify-between items-center px-3 py-1.5";
  const hdrLang = document.createElement("span");
  hdrLang.className = "text-xs font-bold text-gray-400 font-mono";
  hdrLang.textContent = (lang || "code").toUpperCase();
  header.appendChild(hdrLang);
  const actions = document.createElement("div");
  actions.className = "code-actions";
  if (lang === "html") actions.appendChild(boutonApercu(pre, wrapper, rawText));
  actions.appendChild(boutonCopier(rawText));
  parent.insertBefore(wrapper, pre);
  const copyHolder = document.createElement("div");
  copyHolder.className = "copy-sticky";
  copyHolder.appendChild(actions);
  wrapper.appendChild(copyHolder);
  wrapper.appendChild(header);
  wrapper.appendChild(pre);
}

function horsComposant(el: Element, scope: Element | Document, exclure: boolean): boolean {
  if (!exclure) return true;
  const proprietaire = el.closest("[" + ATTRIBUT_COMPOSANT + "]");
  return !proprietaire || (scope instanceof Element && proprietaire === scope);
}

/** Enrichit les blocs `pre` des corps Markdown de `scope` ; `exclureComposants` saute les corps possédés par un composant. */
export function enrichirBlocs(scope: Element | Document, exclureComposants = false): void {
  balayerGraphiques();
  const corps: Element[] = [];
  if (scope instanceof Element && scope.matches(".markdown-body")) corps.push(scope);
  scope.querySelectorAll(".markdown-body").forEach((b) => corps.push(b));
  const retenus = corps.filter((b) => horsComposant(b, scope, exclureComposants));
  for (const body of retenus) {
    if (body.querySelector("pre:not([data-cb-done])"))
      body.querySelectorAll(".svg-render").forEach((el) => el.remove());
  }
  scope.querySelectorAll<HTMLElement>(".markdown-body pre").forEach((pre) => {
    if (horsComposant(pre, scope, exclureComposants)) enrichirPre(pre);
  });
  const portee = exclureComposants ? retenus : corps;
  if (exclureComposants) for (const b of retenus) referencesEnLigne(b, [b]);
  else referencesEnLigne(scope, portee);
}

const enAttente = new Set<() => void>();
let attenteProgrammee = false;

function viderAttente(): void {
  attenteProgrammee = false;
  const taches = [...enAttente];
  enAttente.clear();
  for (const t of taches) t();
}

/** Enrichissement d'un corps qui vient d'être monté : regroupé et reporté après le premier affichage (chargement d'un long chat). */
export function planifierEnrichissement(tache: () => void): void {
  enAttente.add(tache);
  if (attenteProgrammee) return;
  attenteProgrammee = true;
  if (typeof window.requestIdleCallback === "function")
    window.requestIdleCallback(viderAttente, { timeout: 200 });
  else setTimeout(viderAttente, 50);
}

export function annulerEnrichissement(tache: () => void): void {
  enAttente.delete(tache);
}

/** Re-thème des visuels déjà rendus (mode sombre, skin) : cartes Mermaid, graphiques ECharts, diagrammes re-rendus. */
export function rethemerVisuels(): void {
  try {
    const dark = surfaceSombre();
    document.querySelectorAll(".mermaid-render").forEach((el) => {
      el.classList.toggle("bg-white", !dark);
      el.classList.toggle("border-slate-200", !dark);
      el.classList.toggle("bg-slate-800", dark);
      el.classList.toggle("border-slate-700", dark);
    });
    ElpisCharts.rethemeAll();
    const m = g().mermaid;
    if (!m) return;
    initialiserMermaid(m);
    document.querySelectorAll(".mermaid-render").forEach((wrap) => {
      const srcEl = wrap.querySelector("[data-mermaid-src]");
      const target = wrap.querySelector("[data-mermaid-target]");
      if (!srcEl || !target || !target.querySelector("svg")) return;
      const src = (srcEl.textContent || "").trim();
      if (!src) return;
      m.render("mermaid_" + ++compteurMermaid, src).then(
        ({ svg }) => {
          const safe = nettoyerSvg(svg) || "";
          if (!safe) return;
          target.innerHTML = safe;
          brancherZoom(target, wrap, safe);
        },
        () => {},
      );
    });
  } catch {
    /* re-thème au mieux : un visuel non re-rendu garde l'ancien thème */
  }
}

export interface ActionsClicMarkdown {
  ouvrirDansEditeur?: (chemin: string, ligne?: number | null, colonne?: number | null) => void;
  analyserChemin?: (texte: string) => { path: string; line?: number | null; col?: number | null } | null;
}

/** Clic dans un corps Markdown : chemin `fichier:ligne` vers l'éditeur, ancre interne vers son titre. */
export function clicMarkdown(event: Event, actions: ActionsClicMarkdown): void {
  const cible = event.target as Element | null;
  if (!cible || typeof cible.closest !== "function") return;
  const pathCode = cible.closest("code.elpis-path-link");
  if (pathCode && !pathCode.closest("pre") && actions.ouvrirDansEditeur && actions.analyserChemin) {
    const parsed = actions.analyserChemin(pathCode.textContent || "");
    if (parsed) {
      event.preventDefault();
      actions.ouvrirDansEditeur(parsed.path, parsed.line, parsed.col);
      return;
    }
  }
  const link = cible.closest("a");
  if (!link) return;
  const href = link.getAttribute("href");
  if (!href || !href.startsWith("#") || href.length < 2) return;
  event.preventDefault();
  let id = href.substring(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    /* ancre mal encodée : gardée telle quelle */
  }
  let el: Element | null = document.getElementById(id);
  if (!el) {
    const conteneur = cible.closest(".markdown-body") || document;
    for (const h of conteneur.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
      const hId = (h.textContent || "")
        .trim()
        .toLowerCase()
        .replace(/[^\wÀ-￿\s-]/g, "")
        .replace(/\s+/g, "-");
      if (hId === id || hId.includes(id.replace(/[^a-z0-9-]/g, ""))) {
        el = h;
        break;
      }
    }
  }
  if (el) el.scrollIntoView({ behavior: mouvementReduit() ? "auto" : "smooth", block: "start" });
}
