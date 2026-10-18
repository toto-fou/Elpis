// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/palette.ts — recherche Ctrl+K de la console : pages, réglages (index généré des gabarits) et actions, classement par sous-mot puis flou compact, révélation du champ. */
import type { Ref } from "vue";

import { fuzzyMatch } from "../../utils/utils-purs";
import { CHAMPS_ADMIN } from "./champs.gen";
import type { BaseAdmin } from "./etat";
import type { SurfaceNavigation } from "./navigation";

type GenreElement = "page" | "field" | "action";

interface ElementPalette {
  kind: GenreElement;
  label: string;
  meta?: string;
  icon: string;
  page?: string;
  field?: string;
  keywords: string;
  run?: () => unknown;
}

interface Segment {
  t: string;
  hit: boolean;
}

export interface ResultatPalette extends ElementPalette {
  key: string;
  kindLabel: string;
  segs: Segment[];
}

interface Classement {
  score: number;
  idx: number[];
}

const LIBELLES_GENRE: Readonly<Record<GenreElement, string>> = {
  page: "Page",
  field: "Réglage",
  action: "Action",
};
const ORDRE_GENRE: Readonly<Record<GenreElement, number>> = { page: 0, action: 1, field: 2 };
const SEPARATEUR = /[\s'’›&(/._:-]/;

const normaliser = (t: unknown): string => String(t).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const plage = (debut: number, longueur: number): number[] =>
  Array.from({ length: longueur }, (_, k) => debut + k);

function segments(texte: string, indices: readonly number[]): Segment[] {
  const touches = new Set(indices);
  const sortie: Segment[] = [];
  for (let i = 0; i < texte.length; i++) {
    const hit = touches.has(i);
    const dernier = sortie[sortie.length - 1];
    if (dernier && dernier.hit === hit) dernier.t += texte.charAt(i);
    else sortie.push({ t: texte.charAt(i), hit });
  }
  return sortie;
}

/** Correspondance floue compacte : lettres rapprochées seulement (initiales, fautes de frappe). */
function flouCompact(q: string, texte: string, n: string): Classement | null {
  const m = fuzzyMatch(q, texte);
  if (!m || n.length < 2 || !m.idx.length) return null;
  const premier = m.idx[0] ?? 0;
  const dernier = m.idx[m.idx.length - 1] ?? 0;
  const etendue = dernier - premier + 1;
  return etendue <= Math.max(2 * n.length, n.length + 3) ? { score: 50 + m.score, idx: m.idx } : null;
}

/** Sous-mot contigu d'abord (début de mot en tête), puis tous les mots de la saisie, puis flou compact. */
function classer(q: string, texte: string, flouAutorise: boolean): Classement | null {
  const t = normaliser(texte);
  const n = normaliser(q).trim();
  if (!n) return null;
  const pos = t.indexOf(n);
  if (pos >= 0) {
    const debut = pos === 0 || SEPARATEUR.test(t.charAt(pos - 1));
    return { score: (debut ? 400 : 300) - pos * 0.5 - t.length * 0.05, idx: plage(pos, n.length) };
  }
  const mots = n.split(/\s+/).filter(Boolean);
  if (mots.length > 1) {
    let score = 200 - t.length * 0.05;
    const idx: number[] = [];
    for (const w of mots) {
      const p = t.indexOf(w);
      if (p < 0) return flouAutorise ? flouCompact(q, texte, n) : null;
      if (!(p === 0 || SEPARATEUR.test(t.charAt(p - 1)))) score -= 10;
      idx.push(...plage(p, w.length));
    }
    return { score, idx };
  }
  return flouAutorise ? flouCompact(q, texte, n) : null;
}

export function creerPalette(b: BaseAdmin, navigation: SurfaceNavigation) {
  const { vue, ctx, e, nav, lien, refs } = b;
  const { computed, ref, watch } = vue;
  const paletteOpen = ref(false);
  const paletteQuery = ref("");
  const paletteIndex = ref(0);
  const paletteInput: Ref<HTMLInputElement | null> = ref(null);
  let retour: Element | null = null;

  function actions(): ElementPalette[] {
    const sortie: ElementPalette[] = [];
    const ajouter = (
      label: string,
      icon: string,
      run: () => unknown,
      keywords?: string,
      admin?: boolean,
    ): void => {
      if (admin && !b.estAdmin()) return;
      sortie.push({ kind: "action", label, icon, run, keywords: keywords ?? "" });
    };
    ajouter(
      "Tester toutes les connexions",
      "ph-arrows-clockwise",
      async () => {
        if (await lien.goAdminPage("overview")) await lien.loadOverview(true);
      },
      "services sondes état joignable",
      true,
    );
    ajouter(
      "Redémarrer le serveur",
      "ph-power",
      () => lien.restartServer(),
      "relancer appliquer réglages",
      true,
    );
    ajouter(
      "Télécharger une sauvegarde",
      "ph-download-simple",
      () => lien.downloadBackup("full"),
      "archive backup export",
      true,
    );
    ajouter(
      "Révoquer toutes les sessions",
      "ph-sign-out",
      () => lien.revokeAllSessions(),
      "déconnecter tout le monde cookies",
      true,
    );
    ajouter(
      "Créer un compte",
      "ph-user-plus",
      () => lien.overviewShortcut("account"),
      "utilisateur nouveau ajouter",
      true,
    );
    ajouter(
      "Ajouter un moteur",
      "ph-plugs",
      () => lien.overviewShortcut("engine"),
      "connecteur llm vllm serveur",
      true,
    );
    const theme = ctx.themeApi;
    if (theme?.toggleThemeMode) {
      ajouter(
        "Basculer le mode sombre",
        "ph-moon",
        () => theme.toggleThemeMode(),
        "clair sombre apparence nuit",
      );
      for (const sk of theme.skins || []) {
        ajouter(
          "Thème : " + sk.label,
          "ph-palette",
          () => theme.setAppSkin(sk.id),
          "apparence couleurs skin",
        );
      }
    }
    return sortie;
  }

  const corpus = computed<ElementPalette[]>(() => {
    const items: ElementPalette[] = [];
    for (const en of navigation.adminNav.value) {
      for (const p of en.pages) {
        items.push({
          kind: "page",
          label: p.label,
          meta: en.label !== p.label ? en.label : "",
          icon: en.icon,
          page: p.id,
          keywords: "",
        });
      }
    }
    const vus = new Set<string>();
    for (const f of CHAMPS_ADMIN) {
      const page = nav.pages[f.page];
      if (!navigation.adminCanOpen(f.page) || !page) continue;
      const label = f.control && f.control !== f.label ? f.label + " › " + f.control : f.label;
      const cle = f.page + "|" + label;
      if (vus.has(cle)) continue;
      vus.add(cle);
      items.push({
        kind: "field",
        label,
        meta: page.label,
        icon: "ph-sliders-horizontal",
        page: f.page,
        field: f.store + ":" + f.path,
        keywords: (f.hint || "") + " " + f.path,
      });
    }
    return items.concat(actions());
  });

  const paletteResults = computed<ResultatPalette[]>(() => {
    const q = paletteQuery.value.trim();
    const notes: { it: ElementPalette; score: number; idx: number[] }[] = [];
    for (const it of corpus.value) {
      let score = 0;
      let idx: number[] = [];
      if (q) {
        const m = classer(q, it.label, true);
        if (m) {
          score = m.score;
          idx = m.idx;
        } else {
          const alt = classer(q, (it.meta || "") + " " + it.keywords, false);
          if (!alt) continue;
          score = alt.score * 0.3;
        }
      } else if (it.kind === "field") continue;
      notes.push({ it, score, idx });
    }
    notes.sort((x, y) => y.score - x.score || ORDRE_GENRE[x.it.kind] - ORDRE_GENRE[y.it.kind]);
    return notes.slice(0, 40).map((r, i) => ({
      ...r.it,
      key: r.it.kind + ":" + (r.it.field || r.it.page || r.it.label) + ":" + i,
      kindLabel: LIBELLES_GENRE[r.it.kind],
      segs: segments(r.it.label, r.idx),
    }));
  });
  watch(paletteQuery, () => {
    paletteIndex.value = 0;
  });

  function openPalette(): void {
    if (paletteOpen.value) return;
    retour = document.activeElement;
    paletteQuery.value = "";
    paletteIndex.value = 0;
    paletteOpen.value = true;
    e.adminMeOpen.value = false;
    e.dashMenu.value = null;
    void ctx.nextTick().then(() => paletteInput.value?.focus());
  }
  function closePalette(garderFocus?: unknown): void {
    if (!paletteOpen.value) return;
    paletteOpen.value = false;
    if (garderFocus !== true && retour instanceof HTMLElement) {
      try {
        retour.focus({ preventScroll: true });
      } catch {
        /* focus impossible */
      }
    }
    retour = null;
  }

  /** Attend le champ (les chargeurs de la page sont asynchrones), déplie son « Avancé », le centre et le fait clignoter. */
  async function revelerChamp(champ: string): Promise<boolean> {
    const sel = '[data-field="' + String(champ).replace(/"/g, '\\"') + '"]';
    let el: HTMLElement | null = null;
    for (let i = 0; i < 40 && !el; i++) {
      el = document.querySelector<HTMLElement>(sel);
      if (!el) await new Promise((r) => setTimeout(r, 50));
    }
    if (!el) return false;
    for (let d = el.closest("details"); d; d = d.parentElement?.closest("details") ?? null) d.open = true;
    const reduit = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: reduit ? "auto" : "smooth" });
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* focus impossible */
    }
    const ligne = el.closest(".adm-row") ?? el;
    ligne.classList.add("adm-flash");
    setTimeout(() => ligne.classList.remove("adm-flash"), 1600);
    return true;
  }

  async function runPaletteItem(r: ResultatPalette | undefined): Promise<void> {
    if (!r) return;
    if (r.kind === "action") {
      closePalette();
      await r.run?.();
      return;
    }
    closePalette(r.kind === "field");
    if (!(await lien.goAdminPage(r.page ?? ""))) return;
    if (r.kind === "field") await revelerChamp(r.field ?? "");
    else navigation.focusAdminTitle();
  }

  function onPaletteKey(ev: KeyboardEvent): void {
    const n = paletteResults.value.length;
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      if (n) paletteIndex.value = (paletteIndex.value + 1) % n;
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      if (n) paletteIndex.value = (paletteIndex.value - 1 + n) % n;
    } else if (ev.key === "Home" && ev.ctrlKey) {
      ev.preventDefault();
      paletteIndex.value = 0;
    } else if (ev.key === "End" && ev.ctrlKey) {
      ev.preventDefault();
      paletteIndex.value = Math.max(0, n - 1);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      void runPaletteItem(paletteResults.value[paletteIndex.value]);
    } else if (ev.key === "Tab") ev.preventDefault();
    else return;
    void ctx.nextTick().then(() => {
      document.getElementById("adm-pal-" + paletteIndex.value)?.scrollIntoView({ block: "nearest" });
    });
  }

  function raccourci(ev: KeyboardEvent): void {
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.shiftKey || String(ev.key).toLowerCase() !== "k")
      return;
    if (refs.isAdminView && !refs.isAdminView.value) return;
    ev.preventDefault();
    if (paletteOpen.value) closePalette();
    else openPalette();
  }
  document.addEventListener("keydown", raccourci);
  const liberer = (): void => document.removeEventListener("keydown", raccourci);

  return {
    paletteOpen,
    paletteQuery,
    paletteIndex,
    paletteInput,
    paletteResults,
    openPalette,
    closePalette,
    runPaletteItem,
    onPaletteKey,
    liberer,
  };
}
