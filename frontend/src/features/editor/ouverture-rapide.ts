// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/ouverture-rapide.ts — palette « Ouvrir un fichier » (Ctrl+P) : recherche floue dans l'arbre chargé, fichiers récents d'abord sans saisie, navigation au clavier. */
import { computed, nextTick, ref, watch } from "vue";
import type { Ref } from "vue";

import { fuzzyMatch } from "../../utils/utils-purs";
import type { ReglagesEditeur } from "./instances";
import type { NoeudArbre } from "./schemas-bac";

export interface RefsOuvertureRapide {
  settings: Ref<ReglagesEditeur>;
  sandboxFiles: Ref<NoeudArbre[]>;
  recentFiles: Ref<string[]>;
}

export interface RappelsOuvertureRapide {
  ouvrirFichier(chemin: string, force: boolean): unknown;
}

/** Chemins des fichiers de l'arbre, dans l'ordre d'affichage. */
export function fichiersDe(noeuds: readonly NoeudArbre[] | null | undefined): string[] {
  const out: string[] = [];
  const parcourir = (liste: readonly NoeudArbre[] | null | undefined): void => {
    for (const n of liste || []) {
      if (n.type === "file") out.push(n.path);
      else if (n.children) parcourir(n.children);
    }
  };
  parcourir(noeuds);
  return out;
}

/** 50 résultats au plus : sans saisie, les récents encore présents puis le reste ; sinon tri par score, nom de base favorisé. */
export function resultatsOuvertureRapide(requete: string, fichiers: string[], recents: string[]): string[] {
  const q = (requete || "").trim();
  if (!q) {
    const existe = new Set(fichiers);
    const rec = recents.filter((p) => existe.has(p)).slice(0, 15);
    const dejaVus = new Set(rec);
    return rec.concat(fichiers.filter((p) => !dejaVus.has(p))).slice(0, 50);
  }
  const notes: Array<{ path: string; score: number }> = [];
  for (const p of fichiers) {
    const base = p.split("/").pop() ?? p;
    const s = Math.max((fuzzyMatch(q, base)?.score ?? 0) * 1.5, fuzzyMatch(q, p)?.score ?? 0);
    if (s > 0) notes.push({ path: p, score: s });
  }
  notes.sort((a, b) => b.score - a.score);
  return notes.slice(0, 50).map((x) => x.path);
}

/** Fichiers récents par compte (30 au plus), pour Ctrl+P sans saisie. */
export function creerFichiersRecents(user: Ref<{ id?: string | number } | null>) {
  const recentFiles = ref<string[]>([]);
  const cle = (): string => "elpis.editor.recent." + String(user.value?.id || "anon");
  watch(
    () => user.value?.id,
    () => {
      try {
        const arr: unknown = JSON.parse(localStorage.getItem(cle()) || "[]");
        recentFiles.value = Array.isArray(arr)
          ? arr.filter((x): x is string => typeof x === "string").slice(0, 30)
          : [];
      } catch {
        recentFiles.value = [];
      }
    },
    { immediate: true },
  );
  function _rememberRecent(chemin: string): void {
    if (!chemin || recentFiles.value[0] === chemin) return;
    const liste = [chemin].concat(recentFiles.value.filter((p) => p !== chemin)).slice(0, 30);
    recentFiles.value = liste;
    try {
      localStorage.setItem(cle(), JSON.stringify(liste));
    } catch {
      /* stockage plein ou interdit */
    }
  }
  return { recentFiles, _rememberRecent };
}

export function setupEditorQuickOpen(refs: RefsOuvertureRapide, r: RappelsOuvertureRapide) {
  const { settings, sandboxFiles, recentFiles } = refs;
  const quickOpenVisible = ref(false);
  const quickOpenQuery = ref("");
  const quickOpenSelectedIdx = ref(0);
  const quickOpenResults = computed(() =>
    resultatsOuvertureRapide(quickOpenQuery.value, fichiersDe(sandboxFiles.value), recentFiles.value),
  );
  const quickOpenRecent = computed(() => new Set(quickOpenQuery.value ? [] : recentFiles.value.slice(0, 15)));

  function openQuickOpen(): void {
    if (!settings.value.enable_editor) return;
    quickOpenVisible.value = true;
    quickOpenQuery.value = "";
    quickOpenSelectedIdx.value = 0;
    void nextTick(() => document.getElementById("elpis-quickopen-input")?.focus());
  }
  function closeQuickOpen(): void {
    quickOpenVisible.value = false;
  }
  function quickOpenSelect(chemin: string): void {
    closeQuickOpen();
    if (chemin) void r.ouvrirFichier(chemin, false);
  }
  function quickOpenKeyDown(e: KeyboardEvent): void {
    const n = quickOpenResults.value.length;
    if (e.key === "Escape") {
      e.preventDefault();
      closeQuickOpen();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      quickOpenSelectedIdx.value = Math.min(quickOpenSelectedIdx.value + 1, n - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      quickOpenSelectedIdx.value = Math.max(quickOpenSelectedIdx.value - 1, 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const p = quickOpenResults.value[quickOpenSelectedIdx.value];
      if (p) quickOpenSelect(p);
    }
  }
  watch(quickOpenQuery, () => {
    quickOpenSelectedIdx.value = 0;
  });

  // Ctrl+P en capture : vu avant Monaco, qui arrête la propagation de ses propres raccourcis.
  function surTouche(e: KeyboardEvent): void {
    if (!settings.value?.enable_editor) return;
    if (!((e.ctrlKey || e.metaKey) && (e.key === "p" || e.key === "P")) || e.shiftKey) return;
    e.preventDefault();
    if (quickOpenVisible.value) closeQuickOpen();
    else openQuickOpen();
  }
  window.addEventListener("keydown", surTouche, true);

  return {
    quickOpenVisible,
    quickOpenQuery,
    quickOpenSelectedIdx,
    quickOpenResults,
    quickOpenRecent,
    openQuickOpen,
    closeQuickOpen,
    quickOpenSelect,
    quickOpenKeyDown,
    libererOuvertureRapide: () => window.removeEventListener("keydown", surTouche, true),
  };
}
