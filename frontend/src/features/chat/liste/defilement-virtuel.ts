// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/liste/defilement-virtuel.ts — fenêtrage des longues conversations (au-delà de 30 messages) : marge bornée en messages et en hauteurs de vue, messages hors de la vue montés au repos, espaceurs, mesure des hauteurs, saut fiable vers un message, réveils regroupés dans la bulle qu'ils continuent. */
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
// Queue du flux : au plus autant de messages montés au bas du fil.
const QUEUE = MARGE_VIRTUELLE * 2 + 5;
// Ouverture d'une conversation (et retour en bas) : les derniers messages seuls dans l'image, la suite au repos.
const PREMIERE_IMAGE = 8;
// Marges en hauteurs de vue : en deçà de MARGE_DURE le montage se fait dans l'image, jusqu'à MARGE_REPOS au repos.
const MARGE_DURE = 1;
const MARGE_REPOS = 3;

interface Echeance {
  timeRemaining(): number;
}

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
  /** Annule le montage au repos planifié (null : aucun). */
  let repos: (() => void) | null = null;
  /** Petite conversation en cours d'ouverture : la fenêtre s'applique sous le seuil jusqu'à couvrir tout le fil. */
  const ouverture = ref(false);
  let seqSaut = 0;
  let sautEnCours = false;
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
  // Message qui couvre le pixel `px` du fil (hauteurs mesurées, sinon estimées).
  function rang(px: number): number {
    const total = messages.value.length;
    for (let i = 0, acc = 0; i < total; i++) if ((acc += hauteur(i)) > px) return i;
    return Math.max(0, total - 1);
  }
  /** Fenêtre [début, fin) : la vue et `marge` pixels de part et d'autre, au plus MARGE_VIRTUELLE messages de chaque côté. */
  function fenetre(st: number, vh: number, marge: number): [number, number] {
    const total = messages.value.length;
    return [
      Math.max(rang(st) - MARGE_VIRTUELLE, rang(st - marge)),
      Math.min(total, rang(st + vh) + MARGE_VIRTUELLE + 1, rang(st + vh + marge) + 1),
    ];
  }

  function mesurer(): void {
    if (!chatContainer.value) return;
    chatContainer.value.querySelectorAll<HTMLElement>("[data-vs-idx]").forEach((el) => {
      const i = parseInt(el.dataset.vsIdx ?? "", 10);
      if (!isNaN(i)) hauteurs[i] = el.offsetHeight;
    });
  }

  function poser(s: number, e: number, total: number): void {
    s = tete(s);
    while (e < total && absorbe(messages.value, e)) e++;
    debut.value = s;
    fin.value = e;
    vsTopPad.value = somme(0, s);
    vsBotPad.value = somme(e, total);
  }

  // Fil collé en bas : la queue est l'affaire de _vsEnsureTail, la position lue dans le DOM peut précéder le collage.
  const suitLeBas = (): boolean => !isUserScrolling.value && fin.value === messages.value.length;

  /** Dans l'image : seule la marge minimale manquante est montée (saut, défilement rapide), le reste attend le repos. */
  function recalculer(): void {
    const total = messages.value.length;
    const cont = chatContainer.value;
    if (!cont || (total <= SEUIL_VIRTUEL && !ouverture.value)) {
      ouverture.value = false;
      poser(0, total, total);
      return;
    }
    const vh = cont.clientHeight;
    const [s, e] = fenetre(cont.scrollTop, vh, MARGE_DURE * vh);
    if (!suitLeBas() && (debut.value > tete(s) || fin.value < e)) {
      const garde = debut.value < e && fin.value > s;
      poser(garde ? Math.min(s, debut.value) : s, garde ? Math.max(e, fin.value) : e, total);
    }
    planifierRepos();
  }

  /** Un pas au repos : la fenêtre gagne un message vers la fenêtre de lecture (côté le moins couvert), perd ceux sortis de la marge ; vrai s'il reste à faire. */
  function pas(): boolean {
    const total = messages.value.length;
    const cont = chatContainer.value;
    if (total > SEUIL_VIRTUEL) ouverture.value = false;
    if (!cont || sautEnCours || (total <= SEUIL_VIRTUEL && !ouverture.value)) return false;
    mesurer();
    const vh = cont.clientHeight;
    const st = suitLeBas() ? Math.max(0, somme(0, total) - vh) : cont.scrollTop;
    const [bs, be] = ouverture.value ? [0, total] : fenetre(st, vh, Infinity);
    const [vs, ve] = ouverture.value ? [0, total] : fenetre(st, vh, MARGE_REPOS * vh);
    let s = Math.max(debut.value, bs);
    let e = Math.min(fin.value, be);
    if (s >= e) [s, e] = [vs, ve];
    else if (s > vs && (e >= ve || st - somme(0, s) < somme(0, e) - st - vh)) s--;
    else if (e < ve) e++;
    const [d0, f0] = [debut.value, fin.value];
    poser(s, e, total);
    if (ouverture.value && debut.value === 0 && fin.value === total) ouverture.value = false;
    return (debut.value !== d0 || fin.value !== f0) && (debut.value > tete(vs) || fin.value < ve);
  }

  /** Montage au repos par tranches bornées en temps : chaque pas est mis en page avant de mesurer le temps restant. */
  async function auRepos(echeance: Echeance): Promise<void> {
    repos = null;
    while (pas()) {
      await nextTick();
      chatContainer.value?.getBoundingClientRect();
      if (echeance.timeRemaining() < 4) return planifierRepos();
    }
  }

  function planifierRepos(): void {
    if (repos) return;
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback((d) => void auRepos(d), { timeout: 200 });
      repos = () => cancelIdleCallback(id);
    } else {
      const id = setTimeout(() => void auRepos({ timeRemaining: () => 0 }), 50);
      repos = () => clearTimeout(id);
    }
  }

  function annulerRepos(): void {
    repos?.();
    repos = null;
  }

  /** La fenêtre posée est peinte d'abord, sa marge vient au repos qui suit. */
  function reposApresImage(): void {
    annulerRepos();
    const id = requestAnimationFrame(() => {
      repos = null;
      planifierRepos();
    });
    repos = () => cancelAnimationFrame(id);
  }

  function onChatScroll(): void {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      if (messages.value.length > SEUIL_VIRTUEL || ouverture.value) mesurer();
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
    const virtuel = total > SEUIL_VIRTUEL || ouverture.value;
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
    annulerRepos();
    ouverture.value = false;
    seqSaut++;
    sautEnCours = false;
    hauteurs.length = 0;
    debut.value = 0;
    fin.value = 0;
    vsTopPad.value = 0;
    vsBotPad.value = 0;
  }

  /** Fenêtre posée sur la queue AVANT le premier rendu d'un chat chargé : les derniers messages dans la première image, la suite au repos après elle. */
  function _vsInitTail(total: number): void {
    annulerRepos();
    ouverture.value = total > PREMIERE_IMAGE && total <= SEUIL_VIRTUEL;
    poser(Math.max(0, total - PREMIERE_IMAGE), total, total);
    if (total > PREMIERE_IMAGE) reposApresImage();
  }

  /** Queue visible pendant le flux : seuls les messages ajoutés sont montés (au plus QUEUE) ; garde rapide, appel à chaque flush. */
  function _vsEnsureTail(): void {
    const total = messages.value.length;
    if (total <= SEUIL_VIRTUEL && !ouverture.value) return;
    const loin = fin.value <= total - PREMIERE_IMAGE;
    const s = loin ? total - PREMIERE_IMAGE : Math.max(debut.value, total - QUEUE);
    if (debut.value === tete(s) && fin.value === total) return;
    poser(s, total, total);
    if (loin) reposApresImage();
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
    annulerRepos();
    sautEnCours = idx !== total - 1;
    if (ouverture.value) {
      ouverture.value = false;
      poser(0, total, total);
    }
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
    cont.style.overflowAnchor = "none";
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
            sautEnCours = false;
          }
          cont.style.overflowAnchor = ancrage || "";
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
      annulerRepos();
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
