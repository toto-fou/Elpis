// SPDX-License-Identifier: MIT
/** frontend/src/features/studio/dialogue.ts — Studio : mini-chat latéral qui pilote la cible desktop (flux éphémère limité aux outils desktop), clic direct, menu contextuel, glisser-déposer, zone, modale de saisie. */
import { nextTick, ref } from "vue";

import { resultOk } from "../../modeles/scenario-model.ts";
import type { ElementUi } from "../../modeles/scenario-model.ts";
import type { SurfaceMenuStudio, TrameFil } from "./menu.ts";
import type { LecteurBureau } from "./api.ts";

type Dict = Record<string, unknown>;

export interface EtapeDialogue {
  name: string;
  args: unknown;
  status: string;
}

export interface MessageDialogue {
  role: string;
  content: string;
  steps?: EtapeDialogue[];
  streaming?: boolean;
}

export interface CtxDialogueStudio {
  showToast?: (message: string, type?: string) => void;
  fetchAuth: (url: string, init?: RequestInit, soft?: boolean) => Promise<Response | null>;
  lireJson?: LecteurBureau;
  currentModelId?: () => string | null;
  currentConnectorId?: () => string | number | null;
}

/** Crochets de l'enregistreur de script (posés par l'automatisation). */
export interface EnregistreurStudio {
  onToolCall: ((ev: Dict) => void) | null;
  onToolResult: ((ev: Dict) => void) | null;
  onDirectAct: ((info: ActionDirecte) => unknown) | null;
  composePrefix: (() => string) | null;
}

export interface ActionDirecte {
  op: string;
  element?: ElementUi;
  point?: readonly number[];
  args?: Dict;
  result?: Dict;
  before?: ElementUi[];
}

export interface MenuContexte {
  x: number;
  y: number;
  point: readonly number[] | null;
  el: ElementUi | null;
}

type PointImage = [number, number];

const OPS_SEMANTIQUES = [
  "toggle",
  "check",
  "uncheck",
  "select",
  "expand",
  "collapse",
  "scroll_into_view",
  "set_value",
  "invoke",
];

export const RACCOURCIS_TOUCHES: ReadonlyArray<{ label: string; keys: string }> = [
  { label: "Entrée", keys: "enter" },
  { label: "Tabulation", keys: "tab" },
  { label: "Échap", keys: "esc" },
  { label: "Supprimer", keys: "delete" },
  { label: "Retour arrière", keys: "backspace" },
  { label: "Enregistrer · Ctrl+S", keys: "ctrl+s" },
  { label: "Copier · Ctrl+C", keys: "ctrl+c" },
  { label: "Coller · Ctrl+V", keys: "ctrl+v" },
  { label: "Couper · Ctrl+X", keys: "ctrl+x" },
  { label: "Tout sélectionner · Ctrl+A", keys: "ctrl+a" },
  { label: "Annuler · Ctrl+Z", keys: "ctrl+z" },
  { label: "Rétablir · Ctrl+Y", keys: "ctrl+y" },
  { label: "Rechercher · Ctrl+F", keys: "ctrl+f" },
  { label: "Rafraîchir · F5", keys: "f5" },
  { label: "Renommer · F2", keys: "f2" },
];

const jsonOuVide = async (r: Response | null): Promise<Dict> =>
  r ? ((await r.json().catch(() => ({}))) as Dict) : {};

export function creerDialogueStudio(ctx: CtxDialogueStudio, studioMenu: SurfaceMenuStudio) {
  const { fetchAuth } = ctx;
  const lireJson: LecteurBureau = ctx.lireJson ?? ((r) => jsonOuVide(r));
  const toast = (m: string, t?: string): void => ctx.showToast?.(m, t);

  const studioTab = ref("assistant");
  const studioChatMessages = ref<MessageDialogue[]>([]);
  const studioChatInput = ref("");
  const studioChatStreaming = ref(false);

  let abandon: AbortController | null = null;
  const idDialogue = `studio_${Date.now().toString(36)}`;

  // Tampon de tokens : chaque token ré-évaluerait la page entière ; rafale de 40 ms, vidée avant tout événement structurel.
  let tamponTok = "";
  let minuterieTok: ReturnType<typeof setTimeout> | null = null;
  let tamponCible: MessageDialogue | null = null;
  function viderTok(): void {
    if (minuterieTok !== null) {
      clearTimeout(minuterieTok);
      minuterieTok = null;
    }
    if (tamponCible && tamponTok) {
      tamponCible.content += tamponTok;
      defilerDialogue();
    }
    tamponTok = "";
  }
  function empilerTok(asst: MessageDialogue, text: string): void {
    if (tamponCible !== asst) {
      viderTok();
      tamponCible = asst;
    }
    tamponTok += text;
    if (minuterieTok === null) minuterieTok = setTimeout(viderTok, 40);
  }

  const studioChatScrollEl = ref<HTMLElement | null>(null);
  let collerAuBas = true;
  let defilementEnFile = false;
  function onStudioChatScroll(): void {
    const el = studioChatScrollEl.value;
    if (el) collerAuBas = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }
  function defilerDialogue(force?: boolean): void {
    if (!force && !collerAuBas) return;
    if (defilementEnFile) return;
    defilementEnFile = true;
    requestAnimationFrame(() => {
      defilementEnFile = false;
      const el = studioChatScrollEl.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  const rec: EnregistreurStudio = {
    onToolCall: null,
    onToolResult: null,
    onDirectAct: null,
    composePrefix: null,
  };
  function registerStudioRecorder(hooks: Partial<EnregistreurStudio> | null | undefined): void {
    if (hooks && typeof hooks === "object") Object.assign(rec, hooks);
  }

  const cible = (): string => studioMenu.selectedTarget?.value || "";
  function modele(): string | null {
    try {
      return ctx.currentModelId?.() || null;
    } catch {
      return null;
    }
  }
  /** Le mini-chat part sur le serveur choisi dans le chat : sans lui il visait toujours l'intégré. */
  function connecteur(): string | number | null {
    try {
      return ctx.currentConnectorId?.() || null;
    } catch {
      return null;
    }
  }

  function traiterEvenement(ev: Dict, asst: MessageDialogue): void {
    const t = ev && ev["type"];
    if (t === "content_token") {
      empilerTok(asst, String(ev["text"] || ""));
    } else if (t === "tool_call") {
      viderTok();
      asst.steps = asst.steps ?? [];
      asst.steps.push({
        name: String(ev["name"] || ev["tool"] || ""),
        args: ev["args"] || ev["arguments"] || null,
        status: "running",
      });
      defilerDialogue();
      if (rec.onToolCall) {
        try {
          rec.onToolCall(ev);
        } catch {
          /* l'enregistreur ne doit pas casser le flux */
        }
      }
    } else if (t === "tool_result") {
      viderTok();
      const okk = resultOk(ev["result"]);
      const s = asst.steps?.[asst.steps.length - 1];
      if (s) s.status = okk ? "done" : "error";
      if (rec.onToolResult) {
        try {
          rec.onToolResult(ev);
        } catch {
          /* idem */
        }
      }
    } else if (t === "annotation_frame") {
      try {
        void studioMenu.applyFrame(ev as TrameFil);
      } catch {
        /* scène absente */
      }
    } else if (t === "error") {
      viderTok();
      asst.content += `${asst.content ? "\n" : ""}Erreur : ${String(ev["text"] || ev["error"] || "erreur")}`;
    }
  }

  async function studioChatSend(): Promise<void> {
    const text = (studioChatInput.value || "").trim();
    if (!text || studioChatStreaming.value) return;
    const tgt = cible();
    if (!tgt) {
      toast("Choisis une cible", "error");
      return;
    }
    // Les outils desktop agissent sur la cible active : on l'aligne sur celle du Studio avant d'envoyer.
    try {
      await studioMenu.setDesktopActiveTarget?.(tgt);
    } catch {
      /* cible active inchangée */
    }
    studioChatMessages.value.push({ role: "user", content: text });
    const asst: MessageDialogue = { role: "assistant", content: "", steps: [], streaming: true };
    studioChatMessages.value.push(asst);
    studioChatInput.value = "";
    studioChatStreaming.value = true;
    collerAuBas = true;
    defilerDialogue(true);

    const ac = new AbortController();
    abandon = ac;
    try {
      const prefixe = typeof rec.composePrefix === "function" ? rec.composePrefix() || "" : "";
      const msgs = studioChatMessages.value
        .filter((m) => m.role === "user" || (m.content && m.content.trim()))
        .map((m) => ({ role: m.role, content: m.content }));
      const dernier = msgs[msgs.length - 1];
      if (prefixe && dernier && dernier.role === "user")
        msgs[msgs.length - 1] = { role: "user", content: `${prefixe}\n\n${dernier.content}` };
      const body = {
        messages: msgs,
        chat_id: idDialogue,
        ephemeral: true,
        active_mcp_servers: [
          {
            type: "stdio",
            name: "Outils Locaux",
            command: "DEFAULT_LOCAL_PYTHON",
            filter_categories: ["desktop"],
          },
        ],
        model: modele(),
        connector_id: connecteur(),
        thinking_mode: false,
      };
      const res = await fetchAuth("/api/chat-saved-stream3", {
        method: "POST",
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res || !res.ok || !res.body) throw new Error("stream failed");
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
          traiterEvenement(ev, asst);
        }
      }
    } catch (e) {
      // Vider le tampon avant la mention d'interruption : sinon des tokens sortent après elle.
      viderTok();
      if (!(e instanceof Error && e.name === "AbortError")) {
        asst.content += `${asst.content ? "\n" : ""}Commande interrompue`;
        toast("Échec de la commande", "error");
      }
    } finally {
      viderTok();
      asst.streaming = false;
      studioChatStreaming.value = false;
      abandon = null;
    }
  }

  function studioChatStop(): void {
    const enCours = studioChatStreaming.value || !!abandon;
    // Annulation serveur d'abord : abort() ne coupe que le flux HTTP, la boucle outillée continuerait à piloter la VM.
    try {
      void fetchAuth("/api/chat/cancel", {
        method: "POST",
        body: JSON.stringify({ chat_id: idDialogue }),
      })?.catch(() => undefined);
    } catch {
      /* envoi sans attente */
    }
    if (abandon) {
      try {
        abandon.abort();
      } catch {
        /* déjà abandonné */
      }
      abandon = null;
    }
    studioChatStreaming.value = false;
    if (enCours) toast("Arrêt demandé — l'action en cours sur la VM se termine");
  }

  /** Action directe (sans LLM, déterministe, enregistrable). */
  async function posterAction(payload: Dict): Promise<Dict | null> {
    const tgt = cible();
    if (!tgt) {
      toast("Choisis une cible", "error");
      return null;
    }
    if (studioChatStreaming.value) return null;
    const expect_sig = studioMenu.studioFrame?.value?.sig || "";
    try {
      const res = await fetchAuth("/api/desktop/act", {
        method: "POST",
        body: JSON.stringify({ target: tgt, expect_sig, ...payload }),
      });
      const data = await lireJson(res, "action");
      if (res && res.status === 409 && data["error"] === "stale_frame") {
        if (data["image_url"]) {
          try {
            void studioMenu.applyFrame(data as TrameFil);
          } catch {
            /* scène absente */
          }
        }
        toast("L'écran a changé — capture rafraîchie, reclique la cible", "error");
        return null;
      }
      if (!res || !res.ok || data["ok"] === false) {
        toast(String(data["message"] || data["error"] || "Action échouée"), "error");
        return null;
      }
      if (data["image_url"]) {
        try {
          void studioMenu.applyFrame(data as TrameFil);
        } catch {
          /* scène absente */
        }
      }
      if (data["warning"] === "type_no_effect") {
        toast(
          "La saisie n'a peut-être pas atteint le champ (écran inchangé) — clique d'abord dans la zone de saisie",
          "error",
        );
      }
      return data;
    } catch {
      toast("Action échouée", "error");
      return null;
    }
  }
  const elementsAvant = (): ElementUi[] => (studioMenu.studioElements?.value || []).slice();
  const nomDe = (el: ElementUi): string => studioMenu.elementName?.(el) || el.label || "";
  function notifierActionDirecte(info: ActionDirecte): void {
    if (!rec.onDirectAct) return;
    try {
      void rec.onDirectAct(info);
    } catch {
      /* l'enregistreur ne doit pas casser l'action */
    }
  }

  async function actOnElement(el: ElementUi | null | undefined, op?: string, extra?: Dict): Promise<void> {
    if (!el) return;
    const operation = op || "click";
    const plus = extra || {};
    const before = elementsAvant();
    // On agit aux coordonnées du centre affiché (stables et WYSIWYG), pas via element_id résolu sur un cache par worker.
    const c = el.center;
    const hasC = Array.isArray(c) && c.length >= 2;
    let payload: Dict;
    if (OPS_SEMANTIQUES.indexOf(operation) >= 0) {
      payload = { op: operation, auto_id: el.auto_id || "", name: nomDe(el), control_type: el.role || "" };
      if (hasC) {
        payload["x"] = c[0];
        payload["y"] = c[1];
      }
      if (plus["text"] != null) payload["text"] = plus["text"];
    } else if (el.auto_id && (operation === "click" || operation === "double_click")) {
      payload = { op: "invoke", auto_id: el.auto_id, name: nomDe(el), control_type: el.role || "" };
      if (hasC) {
        payload["x"] = c[0];
        payload["y"] = c[1];
      }
      if (operation === "double_click") payload["clicks"] = 2;
    } else if (hasC) {
      payload = { op: operation, x: c[0], y: c[1], ...plus };
    } else {
      payload = { op: operation, element_id: el.id, ...plus };
    }
    const data = await posterAction(payload);
    if (data) notifierActionDirecte({ op: operation, element: el, args: plus, result: data, before });
  }

  /** Lance une app sur la cible (synchro fiable côté agent) et, si on enregistre, en fait un pas « launch » rejouable. */
  async function studioLaunch(app: string): Promise<void> {
    const nom = (app || "").trim();
    if (!nom) return;
    const tgt = cible();
    if (!tgt) {
      toast("Choisis une cible", "error");
      return;
    }
    if (studioChatStreaming.value) return;
    const before = elementsAvant();
    try {
      const r = await fetchAuth("/api/desktop/launch", {
        method: "POST",
        body: JSON.stringify({ target: tgt, app: nom, timeout_ms: 30000 }),
      });
      const data = await lireJson(r, "lancement");
      if (!r || !r.ok || data["ok"] === false) {
        toast(String(data["message"] || data["error"] || "Lancement échoué"), "error");
        return;
      }
      if (data["image_url"]) {
        try {
          void studioMenu.applyFrame(data as TrameFil);
        } catch {
          /* scène absente */
        }
      }
      notifierActionDirecte({ op: "launch", args: { app: nom }, result: data, before });
      toast(data["found"] ? `Lancé : ${String(data["title"] || nom)}` : `Lancé : ${nom}`);
    } catch {
      toast("Lancement échoué", "error");
    }
  }
  async function actAtPoint(
    op: string,
    point: readonly number[] | null | undefined,
    args?: Dict,
  ): Promise<void> {
    if (!point) return;
    const before = elementsAvant();
    const data = await posterAction({ op, x: point[0], y: point[1], ...(args || {}) });
    if (data) notifierActionDirecte({ op, point, args: args || {}, result: data, before });
  }

  const studioSel = ref<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  let selEnCours = false;
  const studioDrag = ref<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const studioDragFrom = ref<PointImage | null>(null);
  let dragEnCours = false;
  const studioStageMode = ref("inspect");

  /** Écran → pixels natifs de la VM, par la matrice du SVG : valable quel que soit le viewBox (zoom, déplacement). */
  function clientVersImage(svg: Element, cx: number, cy: number): PointImage {
    const f = studioMenu.studioFrame?.value || { imgW: 0, imgH: 0 };
    const iw = f.imgW || 1;
    const ih = f.imgH || 1;
    let ix: number;
    let iy: number;
    const s = svg as SVGSVGElement;
    const ctm = s && s.getScreenCTM ? s.getScreenCTM() : null;
    if (ctm && s.createSVGPoint) {
      const pt = s.createSVGPoint();
      pt.x = cx;
      pt.y = cy;
      const p = pt.matrixTransform(ctm.inverse());
      ix = p.x;
      iy = p.y;
    } else {
      const r = svg.getBoundingClientRect();
      const echelle = Math.min(r.width / iw, r.height / ih) || 1;
      const offX = (r.width - iw * echelle) / 2;
      const offY = (r.height - ih * echelle) / 2;
      ix = (cx - r.left - offX) / echelle;
      iy = (cy - r.top - offY) / echelle;
    }
    ix = Math.max(0, Math.min(iw, ix));
    iy = Math.max(0, Math.min(ih, iy));
    return [Math.round(ix), Math.round(iy)];
  }

  let departDeplacement: { p: PointImage; moved: boolean } | null = null;

  function onStageWheel(e: WheelEvent): void {
    if (!studioMenu.zoomStudio) return;
    e.preventDefault();
    const svg = e.currentTarget as Element;
    studioMenu.measureStage(svg);
    const p = clientVersImage(svg, e.clientX, e.clientY);
    studioMenu.zoomStudio(e.deltaY < 0 ? 1.25 : 1 / 1.25, p);
  }
  function panMaybeStart(e: MouseEvent): boolean {
    if (studioStageMode.value !== "inspect") return false;
    if (!studioMenu.studioZoom || studioMenu.studioZoom.value === "fit") return false;
    const svg = e.currentTarget as Element;
    studioMenu.measureStage(svg);
    departDeplacement = { p: clientVersImage(svg, e.clientX, e.clientY), moved: false };
    return true;
  }
  function panMaybeMove(e: MouseEvent): boolean {
    if (!departDeplacement) return false;
    const p = clientVersImage(e.currentTarget as Element, e.clientX, e.clientY);
    const dx = departDeplacement.p[0] - p[0];
    const dy = departDeplacement.p[1] - p[1];
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      departDeplacement.moved = true;
      studioMenu.panStudio(dx, dy);
    }
    return true;
  }
  /** Vrai si c'était un déplacement de scène, pas un clic. */
  function panMaybeEnd(): boolean {
    const bouge = !!(departDeplacement && departDeplacement.moved);
    departDeplacement = null;
    return bouge;
  }
  function selStart(e: MouseEvent): void {
    if (e.button !== 0) return;
    closeStudioCtx();
    const p = clientVersImage(e.currentTarget as Element, e.clientX, e.clientY);
    if (!studioDragFrom.value && panMaybeStart(e)) return;
    if (studioDragFrom.value) {
      const src = studioDragFrom.value;
      cancelStudioDrag();
      execDrag(src, p);
      return;
    }
    if (studioStageMode.value === "drag") {
      dragEnCours = true;
      studioDrag.value = { x1: p[0], y1: p[1], x2: p[0], y2: p[1] };
      return;
    }
    if (studioStageMode.value !== "select") return;
    selEnCours = true;
    studioSel.value = { x1: p[0], y1: p[1], x2: p[0], y2: p[1] };
  }
  function selMove(e: MouseEvent): void {
    if (panMaybeMove(e)) return;
    const p = clientVersImage(e.currentTarget as Element, e.clientX, e.clientY);
    if (studioDragFrom.value || dragEnCours) {
      const d = studioDrag.value || { x1: p[0], y1: p[1] };
      studioDrag.value = { x1: d.x1, y1: d.y1, x2: p[0], y2: p[1] };
      return;
    }
    if (!selEnCours) return;
    const s = studioSel.value || { x1: p[0], y1: p[1] };
    studioSel.value = { x1: s.x1, y1: s.y1, x2: p[0], y2: p[1] };
  }
  function selEnd(_e?: Event): void {
    if (panMaybeEnd()) return;
    if (dragEnCours) {
      dragEnCours = false;
      const d = studioDrag.value;
      studioDrag.value = null;
      if (d && (Math.abs(d.x2 - d.x1) >= 5 || Math.abs(d.y2 - d.y1) >= 5))
        execDrag([d.x1, d.y1], [d.x2, d.y2]);
      return;
    }
    selEnCours = false;
    const s = studioSel.value;
    if (s && Math.abs(s.x2 - s.x1) < 5 && Math.abs(s.y2 - s.y1) < 5) studioSel.value = null;
  }
  function regionSelection(): number[] | null {
    const s = studioSel.value;
    if (!s) return null;
    return [Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.max(s.x1, s.x2), Math.max(s.y1, s.y2)];
  }
  /** Élément le plus profond sous le point (même règle que la scène). */
  function elementSousPoint(point: readonly number[]): ElementUi | null {
    if (studioMenu.studioHitTest) return studioMenu.studioHitTest(point);
    const els = studioMenu.studioElements?.value || [];
    let meilleur: ElementUi | null = null;
    let meilleureSurface = Infinity;
    for (const el of els) {
      const b = el.box;
      if (!b || b.length < 4) continue;
      const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = b;
      if ((point[0] ?? 0) >= x1 && (point[0] ?? 0) <= x2 && (point[1] ?? 0) >= y1 && (point[1] ?? 0) <= y2) {
        const a = (x2 - x1) * (y2 - y1);
        if (a < meilleureSurface) {
          meilleur = el;
          meilleureSurface = a;
        }
      }
    }
    return meilleur;
  }

  const studioCtxMenu = ref<MenuContexte | null>(null);
  const studioCtxSub = ref("");
  function ctxSubLeft(): boolean {
    const vw = (typeof window !== "undefined" && window.innerWidth) || 1920;
    return !!(studioCtxMenu.value && studioCtxMenu.value.x > vw * 0.55);
  }
  function ctxSubUp(): boolean {
    const vh = (typeof window !== "undefined" && window.innerHeight) || 1080;
    return !!(studioCtxMenu.value && studioCtxMenu.value.y > vh * 0.5);
  }
  function ctxSubPos(): string {
    return (ctxSubLeft() ? "right-full mr-1 " : "left-full ml-1 ") + (ctxSubUp() ? "bottom-0" : "top-0");
  }

  const studioTextModal = ref<{ title: string; value: string; placeholder: string } | null>(null);
  const textModalInput = ref<HTMLTextAreaElement | null>(null);
  let resoudreTexte: ((v: string | null) => void) | null = null;
  /** Saisie propre (remplace window.prompt) : textarea multi-ligne, Ctrl ou Cmd + Entrée valide ; null si annulée. */
  function demanderTexte(title?: string, initial?: string, placeholder?: string): Promise<string | null> {
    return new Promise((resolve) => {
      resoudreTexte = resolve;
      studioTextModal.value = {
        title: title || "Saisie",
        value: initial || "",
        placeholder: placeholder || "",
      };
      void nextTick(() => {
        try {
          textModalInput.value?.focus();
        } catch {
          /* champ absent */
        }
      });
    });
  }
  // Pas de préfixe `_` : Vue réserve les clés de setup commençant par `_` ou `$` et ne les expose pas au gabarit.
  function textModalOk(): void {
    const v = studioTextModal.value ? String(studioTextModal.value.value || "") : "";
    studioTextModal.value = null;
    if (resoudreTexte) {
      const r = resoudreTexte;
      resoudreTexte = null;
      r(v);
    }
  }
  function textModalCancel(): void {
    studioTextModal.value = null;
    if (resoudreTexte) {
      const r = resoudreTexte;
      resoudreTexte = null;
      r(null);
    }
  }
  /** Garde le menu dans la fenêtre : près d'un bord il est recadré plutôt que de sortir de l'écran. */
  function placerMenu(clientX: number, clientY: number): { x: number; y: number } {
    const MARGE = 8;
    const MENU_L = 210;
    const MENU_H = 260;
    const vw = (typeof window !== "undefined" && window.innerWidth) || 1920;
    const vh = (typeof window !== "undefined" && window.innerHeight) || 1080;
    let x = clientX;
    let y = clientY;
    if (x + MENU_L + MARGE > vw) x = Math.max(MARGE, vw - MENU_L - MARGE);
    if (y + MENU_H + MARGE > vh) y = Math.max(MARGE, vh - MENU_H - MARGE);
    return { x, y };
  }
  function sousMenuParDefaut(): void {
    studioCtxSub.value = studioTab.value === "script" ? "script" : "";
  }
  /** `el` : la box effectivement cliquée (mode Inspecter) ; sans `el`, l'élément le plus profond sous le point. */
  function openStudioCtx(e: MouseEvent, el?: ElementUi | null): void {
    const pos = placerMenu(e.clientX, e.clientY);
    const reg = studioStageMode.value === "select" ? regionSelection() : null;
    if (reg) {
      const centre = [
        Math.round(((reg[0] ?? 0) + (reg[2] ?? 0)) / 2),
        Math.round(((reg[1] ?? 0) + (reg[3] ?? 0)) / 2),
      ];
      studioCtxMenu.value = { x: pos.x, y: pos.y, point: centre, el: null };
      return;
    }
    const cur = e.currentTarget as (Element & { ownerSVGElement?: Element | null }) | null;
    const svg = (cur && cur.ownerSVGElement) || (cur as Element);
    const point = clientVersImage(svg, e.clientX, e.clientY);
    studioCtxMenu.value = { x: pos.x, y: pos.y, point, el: el || elementSousPoint(point) };
    sousMenuParDefaut();
  }
  function closeStudioCtx(): void {
    studioCtxMenu.value = null;
    studioCtxSub.value = "";
  }

  /** Clic gauche sur une box (mode inspect) : choisit l'élément (arbre et surlignage synchronisés) et ouvre le menu d'actions. */
  function onBoxClick(el: ElementUi, e: MouseEvent): void {
    if (studioStageMode.value !== "inspect") return;
    if (el && studioMenu.selectStudioElement) {
      try {
        studioMenu.selectStudioElement(el.id as string | number, true);
      } catch {
        /* arbre absent */
      }
    }
    openStudioCtx(e, el);
  }

  function prendreMenu(): MenuContexte | null {
    const m = studioCtxMenu.value;
    closeStudioCtx();
    return m;
  }
  const pointDe = (m: MenuContexte): readonly number[] | null => m.point || (m.el && m.el.center) || null;

  async function ctxAct(op: string): Promise<void> {
    const m = prendreMenu();
    if (!m) return;
    if (m.el) await actOnElement(m.el, op);
    else await actAtPoint(op, m.point);
  }
  /** Action sans coordonnées côté agent (frappe sur le focus) : postée puis notifiée à l'enregistreur. */
  async function actionSansPoint(op: string, args: Dict): Promise<void> {
    const before = elementsAvant();
    const data = await posterAction({ op, ...args });
    if (data) notifierActionDirecte({ op, args, result: data, before });
  }
  /** Clique d'abord sur la cible du menu (focus), puis exécute l'opération. */
  async function cliquerPuis(
    m: MenuContexte,
    pt: readonly number[] | null,
    op: string,
    args: Dict,
  ): Promise<void> {
    if (m.el) await actOnElement(m.el, "click");
    else if (pt) await actAtPoint("click", pt);
    if (pt) await actAtPoint(op, pt, args);
    else await actionSansPoint(op, args);
  }
  async function ctxType(): Promise<void> {
    const m = prendreMenu();
    if (!m) return;
    const text = await demanderTexte("Texte à saisir", "", "Texte ou code à taper… (multi-ligne)");
    if (!text) return;
    await cliquerPuis(m, pointDe(m), "type", { text });
  }
  async function ctxRead(): Promise<void> {
    const m = prendreMenu();
    if (!m) return;
    const region = regionSelection() || (m.el && m.el.box) || null;
    const tgt = cible();
    if (!tgt) {
      toast("Choisis une cible", "error");
      return;
    }
    try {
      const res = await fetchAuth("/api/desktop/read", {
        method: "POST",
        body: JSON.stringify({ target: tgt, region }),
      });
      const data = await lireJson(res, "lecture");
      if (res && res.ok && data["ok"] !== false && studioMenu.setStudioText) {
        studioMenu.setStudioText(String(data["text"] || "(aucun texte)"), String(data["region"] || "zone"));
        studioMenu.openStudioTreeDock?.();
      } else toast(String(data["message"] || data["error"] || "Lecture échouée"), "error");
    } catch {
      toast("Lecture échouée", "error");
    }
  }
  function ctxAsk(): void {
    const m = prendreMenu();
    if (!m) return;
    const reg = regionSelection();
    const ref = reg
      ? `[zone ${reg.join(",")}] `
      : m.point
        ? `[point ${m.point.join(",")}] `
        : m.el
          ? `[${m.el.label || String(m.el.id)}] `
          : "";
    studioChatInput.value = ref + (studioChatInput.value || "");
    studioTab.value = "assistant";
  }

  /** Clic droit sur un nœud d'arbre : même menu que sur la scène, le point étant le centre de l'élément. */
  function openNodeCtx(e: MouseEvent, el: ElementUi | null | undefined): void {
    if (!el) return;
    if (studioMenu.selectStudioElement) {
      try {
        studioMenu.selectStudioElement(el.id as string | number, true);
      } catch {
        /* arbre absent */
      }
    }
    const c = Array.isArray(el.center) ? el.center : null;
    const pos = placerMenu(e.clientX, e.clientY);
    studioCtxMenu.value = { x: pos.x, y: pos.y, point: c, el };
    sousMenuParDefaut();
  }

  function execDrag(debut: readonly number[] | null, fin: readonly number[] | null): void {
    if (!debut || !fin) return;
    void actAtPoint("drag", debut, { x2: fin[0], y2: fin[1] });
  }
  function surToucheDrag(e: KeyboardEvent): void {
    if (e.key === "Escape") cancelStudioDrag();
  }
  function cancelStudioDrag(): void {
    studioDragFrom.value = null;
    studioDrag.value = null;
    dragEnCours = false;
    try {
      window.removeEventListener("keydown", surToucheDrag);
    } catch {
      /* fenêtre absente */
    }
  }
  function ctxDragFrom(): void {
    const m = prendreMenu();
    if (!m) return;
    const src = pointDe(m);
    if (!src) {
      toast("Pas de point de départ", "error");
      return;
    }
    studioDragFrom.value = [src[0] ?? 0, src[1] ?? 0];
    studioDrag.value = { x1: src[0] ?? 0, y1: src[1] ?? 0, x2: src[0] ?? 0, y2: src[1] ?? 0 };
    try {
      window.addEventListener("keydown", surToucheDrag);
    } catch {
      /* fenêtre absente */
    }
  }

  async function ctxScroll(dir: string): Promise<void> {
    const m = prendreMenu();
    if (!m) return;
    const pt = pointDe(m);
    if (!pt) {
      toast("Pas de point visé", "error");
      return;
    }
    await actAtPoint("scroll", pt, { dy: dir === "up" ? 3 : -3 });
  }

  async function ctxKeyPreset(keys: string): Promise<void> {
    const m = prendreMenu();
    if (!m || !keys) return;
    await cliquerPuis(m, pointDe(m), "key", { keys });
  }
  async function ctxSemantic(op: string): Promise<void> {
    const m = prendreMenu();
    if (!m || !m.el) {
      toast("Cette action vise un élément (clic droit sur une box / un nœud)", "error");
      return;
    }
    await actOnElement(m.el, op);
  }
  async function ctxSetValue(): Promise<void> {
    const m = prendreMenu();
    if (!m || !m.el) {
      toast("Sélectionne un champ (élément)", "error");
      return;
    }
    const val = await demanderTexte(
      "Définir la valeur du champ",
      String(m.el["value"] || ""),
      "Nouvelle valeur…",
    );
    if (val == null) return;
    await actOnElement(m.el, "set_value", { text: val });
  }
  async function ctxPaste(): Promise<void> {
    const m = prendreMenu();
    if (!m) return;
    const text = await demanderTexte("Texte à coller", "", "Texte ou code à coller… (multi-ligne)");
    if (!text) return;
    await cliquerPuis(m, pointDe(m), "paste", { text });
  }
  async function ctxCopy(): Promise<void> {
    const m = prendreMenu();
    if (!m) return;
    await cliquerPuis(m, pointDe(m), "copy", {});
  }
  async function ctxMove(): Promise<void> {
    const m = prendreMenu();
    if (!m) return;
    const pt = pointDe(m);
    if (!pt) {
      toast("Pas de point visé", "error");
      return;
    }
    await actAtPoint("move", pt);
  }

  return {
    studioTab,
    studioChatMessages,
    studioChatInput,
    studioChatStreaming,
    studioChatScrollEl,
    onStudioChatScroll,
    studioChatSend,
    studioChatStop,
    actOnElement,
    studioLaunch,
    registerStudioRecorder,
    askStudioText: demanderTexte,
    studioSel,
    studioStageMode,
    selStart,
    selMove,
    selEnd,
    onBoxClick,
    onStageWheel,
    studioCtxMenu,
    studioCtxSub,
    ctxSubLeft,
    ctxSubPos,
    openStudioCtx,
    closeStudioCtx,
    openNodeCtx,
    ctxAct,
    ctxType,
    ctxRead,
    ctxAsk,
    ctxScroll,
    KEY_PRESETS: RACCOURCIS_TOUCHES,
    ctxKeyPreset,
    ctxSemantic,
    ctxSetValue,
    ctxPaste,
    ctxCopy,
    ctxMove,
    studioTextModal,
    textModalInput,
    textModalOk,
    textModalCancel,
    studioDrag,
    studioDragFrom,
    ctxDragFrom,
    cancelStudioDrag,
  };
}

export type SurfaceDialogueStudio = ReturnType<typeof creerDialogueStudio>;
