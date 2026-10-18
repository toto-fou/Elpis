// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/liste/defilement-virtuel.ts — fenêtrage des longues conversations (au-delà de 30 messages) : marge de 10 messages, espaceurs, mesure des hauteurs, saut fiable vers un message (même contrat que l'ancien setupChatVirtualScroll), réveils regroupés dans la bulle qu'ils continuent. */
import type {
  computed as ComputedFn,
  nextTick as NextTick,
  onScopeDispose as OnScopeDispose,
  ref as RefFn,
  Ref,
  watch as WatchFn,
} from "vue";

import { absorbe, teteDeBulle } from "./regroupement.ts";
import type { MessageGroupable } from "./regroupement.ts";

export const SEUIL_VIRTUEL = 30;
export const MARGE_VIRTUELLE = 10;
const HAUTEUR_DEFAUT = 180;
const ECART = 32;

export interface VueDefilement {
  ref: typeof RefFn;
  computed: typeof ComputedFn;
  watch: typeof WatchFn;
  nextTick: typeof NextTick;
  onScopeDispose?: typeof OnScopeDispose;
}

export type MessageListe = MessageGroupable;

/** Ligne rendue : un message, et les réveils et réponses qui continuent sa bulle (`suite`). */
export interface EntreeListe {
  msg: MessageListe;
  idx: number;
  suite?: readonly EntreeListe[];
}

export interface RefsDefilement {
  messages: Ref<readonly MessageListe[]>;
  chatContainer: Ref<HTMLElement | null>;
  isUserScrolling: Ref<boolean>;
}

export interface ContexteDefilement {
  _lockAutoScroll?: () => void;
}

export interface OptionsSaut {
  offset?: number | null;
  highlight?: boolean;
}

export function creerDefilementVirtuel(
  vue: VueDefilement,
  refs: RefsDefilement,
  ctx?: ContexteDefilement | null,
) {
  const { ref, computed, watch, nextTick } = vue;
  const onScopeDispose = vue.onScopeDispose || ((_: () => void) => {});
  const { messages, chatContainer, isUserScrolling } = refs;
  const c: ContexteDefilement = ctx || {};
  const verrouiller = (): void => c._lockAutoScroll?.();

  const hauteurs: number[] = [];
  const vsTopPad = ref(0);
  const vsBotPad = ref(0);
  const debut = ref(0);
  const fin = ref(0);
  /** Message mis en évidence après un saut : la ligne (composant MessageChat) lit cet index. */
  const vsFlashIdx = ref<number | null>(null);
  let raf: number | null = null;
  let seqSaut = 0;
  let minuterieFlash: ReturnType<typeof setTimeout> | null = null;

  const tete = (i: number): number => teteDeBulle(messages.value, i);
  // Un message regroupé n'a ni hauteur ni écart propres : la bulle de sa tête les porte.
  const hauteur = (i: number): number =>
    absorbe(messages.value, i) ? 0 : (hauteurs[i] || HAUTEUR_DEFAUT) + ECART;
  function somme(de: number, a: number): number {
    let h = 0;
    for (let i = de; i < a; i++) h += hauteur(i);
    return h;
  }

  function mesurer(): void {
    if (!chatContainer.value) return;
    chatContainer.value.querySelectorAll<HTMLElement>("[data-vs-idx]").forEach((el) => {
      const i = parseInt(el.dataset.vsIdx ?? "", 10);
      if (!isNaN(i)) hauteurs[i] = el.offsetHeight;
    });
  }

  function poser(s: number, e: number, total: number, basNul = false): void {
    s = tete(s);
    while (e < total && absorbe(messages.value, e)) e++;
    debut.value = s;
    fin.value = e;
    vsTopPad.value = somme(0, s);
    vsBotPad.value = basNul ? 0 : somme(e, total);
  }

  function recalculer(): void {
    const total = messages.value.length;
    if (total <= SEUIL_VIRTUEL || !chatContainer.value) {
      debut.value = 0;
      fin.value = total;
      vsTopPad.value = 0;
      vsBotPad.value = 0;
      return;
    }
    const st = chatContainer.value.scrollTop;
    const vh = chatContainer.value.clientHeight;
    let acc = 0;
    let premier = 0;
    for (let i = 0; i < total; i++) {
      const h = hauteur(i);
      if (acc + h > st) {
        premier = i;
        break;
      }
      acc += h;
      if (i === total - 1) premier = total;
    }
    if (premier >= total) premier = Math.max(0, total - 1);
    let dernier = premier;
    let vu = acc;
    for (let i = premier; i < total; i++) {
      dernier = i;
      vu += hauteur(i);
      if (vu >= st + vh) break;
    }
    poser(Math.max(0, premier - MARGE_VIRTUELLE), Math.min(total, dernier + MARGE_VIRTUELLE + 1), total);
  }

  function onChatScroll(): void {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      mesurer();
      recalculer();
    });
  }

  // Entrée stable par message (même objet tant que le message, son rang et sa suite ne changent pas) : un flush ne réalloue pas toute la fenêtre.
  const entrees = new WeakMap<object, EntreeListe>();
  function entree(m: MessageListe, idx: number, suite?: EntreeListe[]): EntreeListe {
    const fraiche = (): EntreeListe => (suite ? { msg: m, idx, suite } : { msg: m, idx });
    if (!m || typeof m !== "object") return fraiche();
    const e = entrees.get(m);
    const memeSuite =
      e?.suite === suite ||
      (!!e?.suite && !!suite && e.suite.length === suite.length && e.suite.every((x, k) => x === suite[k]));
    if (e && e.idx === idx && memeSuite) return e;
    const nouvelle = fraiche();
    entrees.set(m, nouvelle);
    return nouvelle;
  }

  const visibleMessages = computed(() => {
    const msgs = messages.value;
    const total = msgs.length;
    const virtuel = total > SEUIL_VIRTUEL;
    const e = virtuel ? Math.min(fin.value, total) : total;
    const out: EntreeListe[] = [];
    let i = virtuel ? tete(debut.value) : 0;
    while (i < e) {
      let j = i + 1;
      const suite: EntreeListe[] = [];
      for (; j < total && absorbe(msgs, j); j++) suite.push(entree(msgs[j] as MessageListe, j));
      out.push(entree(msgs[i] as MessageListe, i, suite.length ? suite : undefined));
      i = j;
    }
    return out;
  });

  const lastAssistantIdx = computed(() => {
    const msgs = messages.value;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === "assistant") return i;
    return -1;
  });

  function annulerRaf(): void {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = null;
    }
  }

  function _vsReset(): void {
    annulerRaf();
    seqSaut++;
    hauteurs.length = 0;
    debut.value = 0;
    fin.value = 0;
    vsTopPad.value = 0;
    vsBotPad.value = 0;
  }

  /** Fenêtre posée sur la queue AVANT le premier rendu d'un chat chargé (pas de fil vide entre deux passes). */
  function _vsInitTail(total: number): void {
    if (total <= SEUIL_VIRTUEL) {
      debut.value = 0;
      fin.value = total;
      vsTopPad.value = 0;
      vsBotPad.value = 0;
      return;
    }
    poser(Math.max(0, total - (MARGE_VIRTUELLE * 2 + 5)), total, total, true);
  }

  /** Queue visible pendant le flux ; garde rapide quand elle l'est déjà (appel à chaque flush). */
  function _vsEnsureTail(): void {
    const total = messages.value.length;
    if (total <= SEUIL_VIRTUEL) return;
    const s = Math.max(0, total - MARGE_VIRTUELLE * 3);
    if (debut.value === tete(s) && fin.value === total) return;
    poser(s, total, total, true);
  }

  function flasher(idx: number): void {
    if (minuterieFlash) clearTimeout(minuterieFlash);
    vsFlashIdx.value = idx;
    minuterieFlash = setTimeout(() => {
      minuterieFlash = null;
      vsFlashIdx.value = null;
    }, 1200);
  }

  function corriger(idx: number, opts: OptionsSaut, seq: number, flash: boolean): void {
    const cont = chatContainer.value;
    if (!cont || idx >= messages.value.length) return;
    const el =
      cont.querySelector('[data-vs-idx="' + idx + '"]') || cont.querySelector('[data-vs-part="' + idx + '"]');
    if (!el) return;
    const offset = opts.offset != null ? opts.offset : 16;
    const delta = el.getBoundingClientRect().top - cont.getBoundingClientRect().top - offset;
    if (Math.abs(delta) > 2) {
      verrouiller();
      cont.scrollTop += delta;
    }
    if (flash && opts.highlight !== false && seq === seqSaut) flasher(idx);
  }

  /** Saut vers un message (plan, recherche) : auto-défilement gelé, ancrage coupé, trois passes de correction. */
  function scrollToMessage(cible: number, options?: OptionsSaut | null): void {
    const opts = options || {};
    const total = messages.value.length;
    const cont = chatContainer.value;
    if (!cont || total === 0) return;
    const idx = Math.max(0, Math.min(Math.floor(cible), total - 1));
    const seq = ++seqSaut;
    if (idx === total - 1) {
      isUserScrolling.value = false;
      _vsEnsureTail();
      void nextTick(() => {
        verrouiller();
        if (chatContainer.value) chatContainer.value.scrollTop = chatContainer.value.scrollHeight;
      });
      return;
    }
    isUserScrolling.value = true;
    verrouiller();
    annulerRaf();
    const ancrage = cont.style.overflowAnchor;
    const comportement = cont.style.scrollBehavior;
    cont.style.overflowAnchor = "none";
    cont.style.scrollBehavior = "auto";
    if (total > SEUIL_VIRTUEL) {
      const dedans = idx >= debut.value + 2 && idx < fin.value - 2;
      if (!dedans)
        poser(Math.max(0, idx - MARGE_VIRTUELLE), Math.min(total, idx + MARGE_VIRTUELLE + 1), total);
    }
    void nextTick(() => {
      if (seq !== seqSaut) return;
      mesurer();
      corriger(idx, opts, seq, false);
      requestAnimationFrame(() => {
        if (seq !== seqSaut) return;
        mesurer();
        corriger(idx, opts, seq, false);
        setTimeout(() => {
          if (seq === seqSaut) {
            mesurer();
            corriger(idx, opts, seq, true);
          }
          cont.style.overflowAnchor = ancrage || "";
          cont.style.scrollBehavior = comportement || "";
        }, 250);
      });
    });
  }

  watch(
    () => messages.value.length,
    () => {
      void nextTick(() => {
        mesurer();
        if (!isUserScrolling.value) _vsEnsureTail();
        else recalculer();
      });
    },
  );

  if (typeof ResizeObserver !== "undefined") {
    let ro: ResizeObserver | null = null;
    watch(
      chatContainer,
      (el) => {
        if (ro) {
          ro.disconnect();
          ro = null;
        }
        if (el) {
          ro = new ResizeObserver(() => onChatScroll());
          ro.observe(el);
        }
      },
      { immediate: true },
    );
    onScopeDispose(() => {
      if (ro) {
        ro.disconnect();
        ro = null;
      }
      annulerRaf();
    });
  }

  return {
    visibleMessages,
    vsTopPad,
    vsBotPad,
    vsFlashIdx,
    lastAssistantIdx,
    onChatScroll,
    scrollToMessage,
    _vsReset,
    _vsEnsureTail,
    _vsInitTail,
  };
}
