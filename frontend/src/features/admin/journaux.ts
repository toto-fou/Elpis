// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/journaux.ts — console › Supervision › Journaux : filtres persistés, tampon en direct filtré côté client, amorçage depuis le tampon serveur et défilement automatique. */
import type { Ref } from "vue";

import { corpsJson, estObjet, listeObjets, objet } from "../../utils/lecture-json";
import type { BaseAdmin } from "./etat";
import type { EntreeJournal } from "./types";

const CLE_FILTRES = "elpis_admin_log_filters";

export interface FiltresJournaux {
  services: string[];
  levels: string[];
  categories: string[];
  query: string;
}

function filtresInitiaux(): FiltresJournaux {
  const vide: FiltresJournaux = { services: [], levels: [], categories: [], query: "" };
  try {
    const brut: unknown = JSON.parse(localStorage.getItem(CLE_FILTRES) ?? "null");
    if (!estObjet(brut)) return vide;
    const texteListe = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    return {
      services: texteListe(brut["services"]),
      levels: texteListe(brut["levels"]),
      categories: texteListe(brut["categories"]),
      query: typeof brut["query"] === "string" ? brut["query"] : "",
    };
  } catch {
    return vide;
  }
}

export function creerJournaux(b: BaseAdmin) {
  const { vue, ctx } = b;
  const { computed, ref, watch } = vue;
  const logFilters: Ref<FiltresJournaux> = ref(filtresInitiaux());
  const logAutoScroll = ref(true);
  const logsConsoleRef: Ref<HTMLElement | null> = ref(null);
  const logsLoading = ref(false);
  const liveLogs: Ref<EntreeJournal[]> = ref([]);
  let formateur: Intl.DateTimeFormat | null = null;

  watch(
    logFilters,
    (v) => {
      try {
        localStorage.setItem(CLE_FILTRES, JSON.stringify(v));
      } catch {
        /* stockage indisponible */
      }
    },
    { deep: true },
  );

  /** Filtre côté client sur le tampon, sans aller-retour, pour que le flux en direct reste fluide. */
  const filteredLogs = computed<EntreeJournal[]>(() => {
    const tampon = ctx.liveLogs;
    if (!tampon || !tampon.value) return [];
    const f = logFilters.value;
    const q = (f.query || "").toLowerCase().trim();
    return tampon.value.filter((l) => {
      if (f.services.length && (!l.service || !f.services.includes(l.service))) return false;
      if (f.levels.length && (!l.level || !f.levels.includes(l.level))) return false;
      if (f.categories.length && (!l.category || !f.categories.includes(l.category))) return false;
      if (q && !(l.message || "").toLowerCase().includes(q)) return false;
      return true;
    });
  });

  /** Un formateur Intl partagé : `toLocaleTimeString` en recrée un à chaque appel, soit 800 par rendu. */
  function fmtLogTs(ts: number | null | undefined): string {
    if (!ts) return "";
    try {
      formateur ??= new Intl.DateTimeFormat("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      return formateur.format(new Date(ts * 1000));
    } catch {
      return "";
    }
  }

  /** Amorce la console depuis le tampon serveur (300 dernières entrées), sans doublon avec le flux déjà reçu. */
  async function loadRecentLogs(): Promise<void> {
    const tampon = ctx.liveLogs;
    if (!tampon) return;
    logsLoading.value = true;
    try {
      const f = logFilters.value;
      const qs = new URLSearchParams({ limit: "300" });
      if (f.services.length) qs.set("services", f.services.join(","));
      if (f.levels.length) qs.set("levels", f.levels.join(","));
      if (f.categories.length) qs.set("categories", f.categories.join(","));
      const res = await ctx.fetchAuth("/api/admin/logs/recent?" + qs.toString(), {}, true);
      if (!res || !res.ok) return;
      const items = listeObjets(objet(await corpsJson(res))["items"]) as EntreeJournal[];
      const vus = new Set((tampon.value || []).map((l) => `${l.ts}|${l.message}`));
      const neufs = items.filter((l) => !vus.has(`${l.ts}|${l.message}`));
      tampon.value = [...neufs, ...(tampon.value || [])]
        .sort((a, c) => (a.ts || 0) - (c.ts || 0))
        .slice(-800);
    } catch {
      /* tampon inchangé */
    } finally {
      logsLoading.value = false;
    }
  }

  // Surveille le tampon (réaffecté une fois par lot) plutôt que le filtre : le défilement ne se fait que console montée.
  watch(
    () => ctx.liveLogs?.value,
    () => {
      if (!logAutoScroll.value || !logsConsoleRef.value) return;
      void ctx.nextTick().then(() => {
        const el = logsConsoleRef.value;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },
  );

  return {
    logFilters,
    logAutoScroll,
    logsConsoleRef,
    filteredLogs,
    logsLoading,
    loadRecentLogs,
    fmtLogTs,
    liveLogs,
  };
}
