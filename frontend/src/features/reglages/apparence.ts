// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/apparence.ts — apparence du compte : skins serveur, mode sombre (système, clair, sombre), classes posées sur le body et nom de marque du rail. */
import { getCurrentScope, onScopeDispose } from "vue";
import type { Ref } from "vue";

import { corpsJson, estObjet, liste, objet, texte } from "../../utils/lecture-json";
import { rethemerVisuels as rethemerRendus } from "../chat/rendu/enrichissement";
import type { Persistance } from "./persistance";
import type { CtxReglages, ReglagesApp, VueReglages } from "./types";

export interface SkinApp {
  id: string;
  label: string;
  desc: string;
  builtin: boolean;
  sw: string[];
  darkBase?: boolean;
  brand?: { name?: string; [cle: string]: unknown };
  css_url?: string;
  [cle: string]: unknown;
}

export type ModeTheme = "system" | "light" | "dark";

const SKINS_REPLI: readonly SkinApp[] = [
  { id: "elpis", label: "Elpis", desc: "", builtin: true, sw: ["#f3efe8", "#fcfbf9", "#b88a3d"] },
  { id: "", label: "Ardoise", desc: "", builtin: true, sw: ["#0f172a", "#f8fafc", "#2563eb"] },
];

export function creerApparence(
  vue: VueReglages,
  settings: Ref<ReglagesApp>,
  ctx: CtxReglages,
  persistance: Persistance,
) {
  const { computed, ref, watch } = vue;
  const APP_SKINS: Ref<SkinApp[]> = ref(SKINS_REPLI.map((s) => ({ ...s })));
  const skinsDefaut = ref("elpis");

  /** Lit `/api/skins` (skins activés) ; faux si l'appel échoue. */
  async function loadAppSkins(): Promise<boolean> {
    try {
      const r = await ctx.fetchAuth("/api/skins", {}, true);
      if (!r || !r.ok) return false;
      const d = objet(await corpsJson(r));
      const skins = liste(d["skins"]).filter(estObjet);
      if (skins.length) APP_SKINS.value = skins as SkinApp[];
      if (typeof d["default"] === "string") skinsDefaut.value = d["default"];
      return true;
    } catch {
      return false;
    }
  }

  const skinCourant = computed<SkinApp>(() => {
    const id = settings.value.skin || "";
    const liste = APP_SKINS.value;
    return liste.find((k) => k.id === id) || liste[0] || (SKINS_REPLI[0] as SkinApp);
  });

  /** Un nom d'assistant choisi par le compte l'emporte sur la marque du skin ; « Elpis » et « Assistant » sont les défauts. */
  const nomMarque = computed(() => {
    const nom = settings.value.assistant_name || "Elpis";
    const parDefaut = nom === "Elpis" || nom === "Assistant";
    const marque = skinCourant.value.brand?.name;
    return marque && parDefaut ? marque : nom;
  });

  function appliquerModeSombre(actif: boolean): void {
    try {
      document.body.classList.toggle("elpis-app-dark", actif);
    } catch {
      /* DOM indisponible */
    }
  }
  function appliquerSkin(id: string): void {
    try {
      const cls = document.body.classList;
      Array.from(cls).forEach((c) => {
        if (c.indexOf("elpis-skin-") === 0) cls.remove(c);
      });
      if (id) cls.add("elpis-skin-" + id);
    } catch {
      /* DOM indisponible */
    }
  }

  const prefereSombre = ref(false);
  try {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    prefereSombre.value = !!mq.matches;
    const surChangement = (e: MediaQueryListEvent): void => {
      prefereSombre.value = !!e.matches;
    };
    mq.addEventListener("change", surChangement);
    if (getCurrentScope() !== undefined)
      onScopeDispose(() => mq.removeEventListener("change", surChangement));
  } catch {
    /* matchMedia indisponible */
  }
  const appDark = computed(() =>
    settings.value.dark_mode_auto ? prefereSombre.value : !!settings.value.dark_mode,
  );

  /** Marqueur `elpis-dark-surface` : mode sombre actif ou skin à base sombre. */
  function appliquerSurfaceSombre(): void {
    try {
      const sk = APP_SKINS.value.find((k) => k.id === (settings.value.skin || ""));
      document.body.classList.toggle("elpis-dark-surface", appDark.value || !!sk?.darkBase);
    } catch {
      /* DOM indisponible */
    }
  }
  /** Re-thème des graphiques et diagrammes déjà rendus, différé d'un tick. */
  function rethemerVisuels(): void {
    try {
      setTimeout(rethemerRendus, 0);
    } catch {
      /* hook absent */
    }
  }
  watch(
    appDark,
    (actif) => {
      appliquerModeSombre(actif);
      appliquerSurfaceSombre();
      rethemerVisuels();
    },
    { immediate: true },
  );
  watch(
    () => settings.value.skin,
    (id) => {
      appliquerSkin(id || "");
      appliquerSurfaceSombre();
      rethemerVisuels();
    },
    { immediate: true },
  );

  /** Feuille d'un skin importé, liée à la demande et seulement pour le skin actif. */
  function appliquerCssSkinPlugin(sk: SkinApp): void {
    try {
      const url = !sk.builtin && sk.css_url ? sk.css_url : "";
      let el = document.getElementById("elpis-plugin-skin");
      if (!url) {
        el?.remove();
        return;
      }
      if (!el) {
        el = document.createElement("link");
        el.id = "elpis-plugin-skin";
        el.setAttribute("rel", "stylesheet");
        document.head.appendChild(el);
      }
      if (el.getAttribute("href") !== url) el.setAttribute("href", url);
    } catch {
      /* DOM indisponible */
    }
  }
  watch(
    () => skinCourant.value.id + "|" + texte(skinCourant.value.css_url),
    () => {
      appliquerCssSkinPlugin(skinCourant.value);
      appliquerSurfaceSombre();
    },
    { immediate: true },
  );

  const themeMode = computed<ModeTheme>(() =>
    settings.value.dark_mode_auto ? "system" : settings.value.dark_mode ? "dark" : "light",
  );
  /** Mute seulement : la modale enregistre au clic sur Enregistrer. */
  function applyThemeMode(mode: ModeTheme): void {
    if (mode === "system") {
      settings.value.dark_mode_auto = true;
      return;
    }
    settings.value.dark_mode_auto = false;
    settings.value.dark_mode = mode === "dark";
  }
  async function setThemeMode(mode: string): Promise<boolean> {
    if (mode !== "system" && mode !== "light" && mode !== "dark") return false;
    const prev = { a: settings.value.dark_mode_auto, d: settings.value.dark_mode };
    applyThemeMode(mode);
    return persistance.persistKeys(["dark_mode", "dark_mode_auto"], {
      rollback: () => {
        settings.value.dark_mode_auto = prev.a;
        settings.value.dark_mode = prev.d;
      },
    });
  }
  const toggleThemeMode = (): Promise<boolean> => setThemeMode(appDark.value ? "light" : "dark");
  async function setAppSkin(id: string): Promise<boolean> {
    if (!APP_SKINS.value.some((k) => k.id === id)) return false;
    const prev = settings.value.skin;
    settings.value.skin = id;
    return persistance.persistKeys(["skin"], {
      rollback: () => {
        settings.value.skin = prev;
      },
    });
  }

  /** Interface classique, enregistrée dès le clic ; rétablie si l'écriture échoue. */
  async function setClassicUi(actif: boolean): Promise<boolean> {
    const prev = settings.value.classic_ui;
    settings.value.classic_ui = actif;
    return persistance.persistKeys(["classic_ui"], {
      rollback: () => {
        settings.value.classic_ui = prev;
      },
    });
  }

  return {
    APP_SKINS,
    skinsDefaut,
    loadAppSkins,
    skinCourant,
    nomMarque,
    appDark,
    themeMode,
    applyThemeMode,
    setThemeMode,
    toggleThemeMode,
    setAppSkin,
    setClassicUi,
  };
}
