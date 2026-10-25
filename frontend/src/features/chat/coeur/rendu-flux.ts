// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/coeur/rendu-flux.ts — rendu du flux (porté d'`app-chat.js`) : patchs du message en cours, rendu Markdown incrémental (corps `_md`, ligne vivante `_pp`), versement lissé, tampons de réflexion et de narration, sortie shell coalescée, défilement. */
import { journal } from "../../../platform/journal";
import { nextTick } from "vue";

import type { CoeurChat, EntreeAffichee } from "./liens.ts";
import type { MessageChat, Objet } from "./types.ts";

type Prefixe = "_md" | "_pp";

const RENDU_ACTIF_MS = 110;
const FENETRE_LISSAGE_MS = 350;
const LISSAGE_MIN = 24;
const SHELL_FLUSH_MS = 120;
const SHELL_MAX = 98304;

/** Champs d'affichage du rendu incrémental du corps, purgés à chaque fin ou remise à zéro du flux. */
export const STREAM_RENDER_CLEAR: Readonly<Objet> = Object.freeze({
  _mdBlocks: null,
  _mdActiveHtml: "",
  _mdScanPos: 0,
  _mdFence: false,
  _mdBlockStart: 0,
  _modelLoad: null,
});

/** Idem pour la ligne vivante du conteneur « Travail de l'assistant ». */
export const PRE_RENDER_CLEAR: Readonly<Objet> = Object.freeze({
  _ppBlocks: null,
  _ppActiveHtml: "",
  _ppScanPos: 0,
  _ppFence: false,
  _ppBlockStart: 0,
});

/** Cadence de versement : espacée quand le texte grandit (coût du patch proportionnel à sa longueur). */
export function streamFlushDelay(len: number): number {
  if (len < 16384) return 40;
  if (len < 65536) return 80;
  return 120;
}

/** Tranche à révéler : proportionnelle au retard, jamais au milieu d'une paire de substitution UTF-16. */
export function smoothTake(buf: string, dtMs: number): number {
  if (!buf) return 0;
  let take = Math.max(LISSAGE_MIN, Math.ceil((buf.length * dtMs) / FENETRE_LISSAGE_MS));
  if (take >= buf.length) return buf.length;
  const cc = buf.charCodeAt(take - 1);
  if (cc >= 0xd800 && cc <= 0xdbff) take++;
  return Math.min(take, buf.length);
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0);

export function creerRenduFlux(c: CoeurChat) {
  const { r, ctx, e, f, md, l } = c;

  function getStreamMsgs(): MessageChat[] {
    return r.messages.value;
  }

  // Cible des patchs : le dernier assistant en cours (un notice poussé pendant le tour ne la vole pas).
  function streamIdx(msgs: readonly MessageChat[]): number {
    for (let i = msgs.length - 1, n = 0; i >= 0 && n < 4; i--, n++) {
      const m = msgs[i];
      if (m && m.role === "assistant" && m.isStreaming) return i;
    }
    return msgs.length - 1;
  }

  function patch(idx: number, p: Objet): void {
    const msgs = getStreamMsgs();
    const cur = msgs[idx];
    if (idx >= 0 && cur) msgs[idx] = Object.assign({}, cur, p);
  }

  // Les messages chargés sont gelés : on remplace l'objet à son index (relocalisé par identité).
  function setMsgUi(entry: EntreeAffichee | null | undefined, p: Objet): void {
    const arr = r.messages.value;
    if (!entry || !Array.isArray(arr)) return;
    let i = typeof entry.idx === "number" ? entry.idx : -1;
    if (!(i >= 0 && i < arr.length && arr[i] === entry.msg)) i = arr.indexOf(entry.msg);
    const cur = arr[i];
    if (i >= 0 && cur) arr[i] = Object.assign({}, cur, p);
  }

  // Une écriture de défilement par image, après le rendu de Vue.
  function scheduleStreamScroll(): void {
    if (f.scrollPending) return;
    f.scrollPending = true;
    void nextTick(() =>
      requestAnimationFrame(() => {
        f.scrollPending = false;
        const el = e.chatContainer.value;
        if (r.isUserScrolling.value || !el) return;
        ctx._lockAutoScroll?.();
        el.scrollTop = el.scrollHeight;
      }),
    );
  }

  function scrollToBottom(force?: boolean): void {
    if (!e.chatContainer.value || (!force && r.isUserScrolling.value)) return;
    if (force) r.isUserScrolling.value = false;
    l.vsEnsureTail();
    void nextTick(() => {
      const el = e.chatContainer.value;
      if (!el) return;
      ctx._lockAutoScroll?.();
      if (force) {
        // Saut instantané : `scroll-smooth` se ferait interrompre par les rendus différés.
        const avant = el.style.scrollBehavior;
        el.style.scrollBehavior = "auto";
        el.scrollTop = el.scrollHeight;
        el.style.scrollBehavior = avant || "";
      } else el.scrollTop = el.scrollHeight;
    });
  }

  // Après un chargement, recolle le bas en plusieurs passes tant que l'utilisateur n'a pas repris la main.
  function settleScrollBottom(): void {
    const chatAuDepart = r.currentChatId.value;
    for (const delai of [80, 250, 600, 1200])
      setTimeout(() => {
        if (r.currentChatId.value !== chatAuDepart) return;
        const el = e.chatContainer.value;
        if (!el || r.isUserScrolling.value) return;
        if (el.scrollHeight - el.scrollTop - el.clientHeight > 4) {
          ctx._lockAutoScroll?.();
          const avant = el.style.scrollBehavior;
          el.style.scrollBehavior = "auto";
          el.scrollTop = el.scrollHeight;
          el.style.scrollBehavior = avant || "";
        }
      }, delai);
  }

  // Blocs terminés figés une fois, bloc actif re-rendu au plus toutes les 110 ms.
  function applyIncrementalRender(cur: MessageChat, text: string, P: Prefixe, caret = true): Objet {
    let blocs = (cur[P + "Blocks"] as { i: number; html: string }[] | null | undefined) || null;
    const scan = md.scanStreamBlocks(
      text,
      num(cur[P + "ScanPos"]),
      !!cur[P + "Fence"],
      num(cur[P + "BlockStart"]),
    );
    const fige = scan.blocks.length > 0;
    if (fige) {
      blocs = (blocs || []).slice();
      for (const bmd of scan.blocks) blocs.push({ i: blocs.length, html: md.renderStreamBlock(bmd) });
    }
    const p: Objet = {
      [P + "Blocks"]: blocs,
      [P + "ScanPos"]: scan.scanPos,
      [P + "Fence"]: scan.fence,
      [P + "BlockStart"]: scan.blockStart,
    };
    const now = Date.now();
    if (fige || now - f.liveRenderTs[P] >= RENDU_ACTIF_MS) {
      const html = md.renderStreamingActive(text.slice(scan.blockStart));
      p[P + "ActiveHtml"] = caret ? md.injecterCaret(html) : html;
      f.liveRenderTs[P] = now;
      f.liveRenderDirty[P] = false;
    } else f.liveRenderDirty[P] = true;
    return p;
  }

  // Rattrapage du bloc actif resté en retard quand le tampon s'est vidé dans la fenêtre de 110 ms.
  function catchUpRender(cur: MessageChat, text: string, P: Prefixe, caret = true): Objet {
    f.liveRenderDirty[P] = false;
    f.liveRenderTs[P] = Date.now();
    const html = md.renderStreamingActive(text.slice(num(cur[P + "BlockStart"])));
    return { [P + "ActiveHtml"]: caret ? md.injecterCaret(html) : html };
  }

  function applyStreamRender(cur: MessageChat, content: string): Objet {
    return Object.assign({ content, isStreaming: true }, applyIncrementalRender(cur, content, "_md"));
  }

  function applyPreRender(cur: MessageChat, text: string): Objet {
    return Object.assign({ _pendingPreContent: text }, applyIncrementalRender(cur, text, "_pp", false));
  }

  function flushThinkBuf(): void {
    if (!f.thinkBuf) return;
    const msgs = getStreamMsgs();
    const idx = streamIdx(msgs);
    const cur = msgs[idx];
    if (idx < 0 || !cur) {
      f.thinkBuf = "";
      return;
    }
    // Réflexion d'un appel précédent déjà posée sur son étape : celle-ci ne s'y ajoute pas.
    const neuve = !!cur._reflexionPosee;
    const fusion = (neuve ? "" : cur.thinking || "") + f.thinkBuf;
    f.thinkBuf = "";
    msgs[idx] = Object.assign(
      {},
      cur,
      { thinking: fusion },
      cur._thinkingStartedAt && !neuve
        ? {}
        : {
            _thinkingStartedAt: Date.now(),
            _thinkingEndedAt: undefined,
            _thinkingMs: undefined,
            _reflexionPosee: false,
          },
    );
    e.statusText.value = l.thinkingTitle(fusion);
    scheduleStreamScroll();
  }

  function stopThinkFlush(): void {
    if (f.thinkFlushTimer) {
      clearInterval(f.thinkFlushTimer);
      f.thinkFlushTimer = null;
    }
    flushThinkBuf();
  }

  // Narration d'outils : même versement lissé que le corps ; `force` (fin de phase, Stop) draine tout.
  function flushPreContentBuf(force?: boolean): void {
    const msgs = getStreamMsgs();
    const idx = streamIdx(msgs);
    const cur = msgs[idx];
    if (idx < 0 || !cur) {
      f.preContentBuf = "";
      return;
    }
    if (!f.preContentBuf) {
      if (f.liveRenderDirty._pp && cur._pendingPreContent)
        msgs[idx] = Object.assign({}, cur, catchUpRender(cur, cur._pendingPreContent, "_pp", false));
      else f.liveRenderDirty._pp = false;
      return;
    }
    const take = force ? f.preContentBuf.length : smoothTake(f.preContentBuf, 40);
    const morceau = f.preContentBuf.slice(0, take);
    f.preContentBuf = f.preContentBuf.slice(take);
    const complet = (cur._pendingPreContent || "") + morceau;
    msgs[idx] = Object.assign({}, cur, applyPreRender(cur, complet), { _statusLine: cur._statusLine || "" });
    try {
      l.voix().onAssistantToolStream(complet);
    } catch (err) {
      journal.erreur("[voix]", err);
    }
    if (!r.isUserScrolling.value && e.chatContainer.value) {
      l.vsEnsureTail();
      scheduleStreamScroll();
    }
  }

  function stopPreContentFlush(): void {
    if (f.preContentFlushTimer) {
      clearInterval(f.preContentFlushTimer);
      f.preContentFlushTimer = null;
    }
    flushPreContentBuf(true);
    f.liveRenderTs._pp = 0;
    f.liveRenderDirty._pp = false;
  }

  function streamFlushTick(): void {
    f.streamFlushTimer = null;
    let len = 0;
    if (!f.streamBuf.length && f.liveRenderDirty._md) {
      const m = getStreamMsgs();
      const i = streamIdx(m);
      const cur = m[i];
      if (i >= 0 && cur && cur.isStreaming) {
        const content = cur.content || "";
        len = content.length;
        m[i] = Object.assign({}, cur, catchUpRender(cur, content, "_md"));
      } else f.liveRenderDirty._md = false;
    }
    if (f.streamBuf.length) {
      const now = Date.now();
      const dt = f.lastContentFlushTs ? Math.min(150, now - f.lastContentFlushTs) : 40;
      f.lastContentFlushTs = now;
      const take = smoothTake(f.streamBuf, dt);
      const morceau = f.streamBuf.slice(0, take);
      f.streamBuf = f.streamBuf.slice(take);
      const m = getStreamMsgs();
      const i = streamIdx(m);
      const cur = m[i];
      if (i >= 0 && cur) {
        const content = (cur.content || "") + morceau;
        len = content.length;
        try {
          l.voix().onAssistantStream(content);
        } catch (err) {
          journal.erreur("[voix]", err);
        }
        m[i] = Object.assign({}, cur, applyStreamRender(cur, content));
        if (!r.isUserScrolling.value && e.chatContainer.value) {
          l.vsEnsureTail();
          scheduleStreamScroll();
        }
      }
    }
    f.streamFlushTimer = setTimeout(streamFlushTick, streamFlushDelay(len));
  }

  function armStreamFlush(): void {
    if (!f.streamFlushTimer) f.streamFlushTimer = setTimeout(streamFlushTick, 40);
  }

  function stopStreamFlush(): void {
    if (f.streamFlushTimer) {
      clearTimeout(f.streamFlushTimer);
      f.streamFlushTimer = null;
    }
    f.liveRenderTs._md = 0;
    f.lastContentFlushTs = 0;
    f.liveRenderDirty._md = false;
  }

  function shellFoldPend(st: { shellOut?: string | null }, pend: { chunk: string }): string {
    const acc = (st.shellOut || "") + pend.chunk;
    return acc.length > SHELL_MAX ? acc.slice(-SHELL_MAX) : acc;
  }

  // Sortie shell coalescée : un patch par étape et par cadence, jamais un par morceau.
  function flushShellPend(): void {
    f.shellFlushTimer = null;
    const m = getStreamMsgs();
    for (const [k, pend] of f.shellPend) {
      const sep = k.lastIndexOf(":");
      const idx = Number(k.slice(0, sep));
      const si = Number(k.slice(sep + 1));
      const cur = m[idx];
      const st = cur?.toolSteps?.[si];
      if (!cur || !cur.toolSteps || !st) continue;
      const steps = [...cur.toolSteps];
      steps[si] = {
        ...st,
        shellOut: shellFoldPend(st, pend),
        shellSeq: Math.max(st.shellSeq || 0, pend.seq || 0),
      };
      patch(idx, { toolSteps: steps });
    }
    f.shellPend.clear();
  }

  function armerShell(): void {
    if (!f.shellFlushTimer) f.shellFlushTimer = setTimeout(flushShellPend, SHELL_FLUSH_MS);
  }

  return {
    getStreamMsgs,
    streamIdx,
    patch,
    setMsgUi,
    scheduleStreamScroll,
    scrollToBottom,
    settleScrollBottom,
    applyStreamRender,
    applyPreRender,
    flushThinkBuf,
    stopThinkFlush,
    flushPreContentBuf,
    stopPreContentFlush,
    armStreamFlush,
    stopStreamFlush,
    shellFoldPend,
    flushShellPend,
    armerShell,
  };
}
