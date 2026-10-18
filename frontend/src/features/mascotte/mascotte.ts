// SPDX-License-Identifier: MIT
/** frontend/src/features/mascotte/mascotte.ts — mascotte du bloc « nouveau chat » : choisit l'état (chantier, salut, réveil, sommeil, flânerie, repos), pilote la scène animée et le perchoir de la barre de saisie. */
import { computed, onUnmounted, ref, watch } from "vue";
import type { Ref } from "vue";

import { journal } from "../../platform/journal";
import type { SceneAccueil, montrerAccueil } from "./accueil";

export interface EntreeCatalogue {
  id: string;
  label: string;
}

export interface ReglagesMascotte {
  mascottes_catalogue?: EntreeCatalogue[];
  mascottes_actives?: string[];
  mascottes_on?: boolean;
  welcome_mascot?: string | null;
  welcome_mascot_anime?: boolean;
  [cle: string]: unknown;
}

export interface RefsMascotte {
  settings: Ref<ReglagesMascotte>;
  messages: Ref<unknown[]>;
  isStreaming: Ref<boolean>;
  currentView: Ref<string>;
}

export interface CtxMascotte {
  welcomeConfig?: Ref<{ scene?: StyleScene } | null> | null;
  skinCourant?: Ref<{ mascot?: string } | null> | null;
}

interface StyleScene {
  motif?: string;
  word_scale?: number;
  mascot_scale?: number;
}

type EtatMascotte = "chantier" | "sommeil" | "flanerie" | "repos" | "salut" | "reveil";
type Minuterie = ReturnType<typeof setTimeout>;

const CATALOGUE_REPLI: EntreeCatalogue[] = [
  { id: "boite_or", label: "Coffre" },
  { id: "flamme", label: "Flamme" },
  { id: "flamme_bleue", label: "Flamme bleue" },
  { id: "fantome", label: "Fantôme" },
  { id: "elpis", label: "Elpis" },
];

const DELAI_SOMMEIL = 3 * 60 * 1000;
const DELAI_FLANERIE = 45 * 1000;
const FLANERIES = ["vol", "souffle", "ronde", "foudre", "pouvoir"];
const FLANERIES_KIKI = ["fusillade", "coupe"];

const SCENARIOS: Readonly<Record<string, string>> = {
  salut: "salut",
  reveil: "reveil",
  sommeil: "sieste",
  chantier: "chantier",
  repos: "repos",
};

const SCENES_KIKI: Readonly<Record<string, string>> = {
  salut: "attente",
  reveil: "attente",
  repos: "attente",
  chantier: "patrouille",
  sommeil: "dodo",
};

const PERCHE_ANIM: Readonly<Record<string, string>> = {
  entre: "run-right",
  arrive: "run-right",
  dort: "sommeil",
  reveil: "reveil",
  part: "run-right",
};
const PERCHE_X: Readonly<Record<string, string>> = {
  entre: "-14%",
  arrive: "31%",
  dort: "31%",
  reveil: "31%",
  part: "108%",
};
const PERCHE_DUREE: Readonly<Record<string, string>> = {
  entre: "0s",
  arrive: "2.6s",
  dort: "0s",
  reveil: "0s",
  part: "1.8s",
};

const BASE = "/static/assets/mascotte/";

export function creerMascotte(refs: RefsMascotte, ctx: CtxMascotte) {
  const { settings, messages, isStreaming, currentView } = refs;

  const styleAdmin = (): StyleScene => ctx.welcomeConfig?.value?.scene ?? {};

  const TOUTES_C = computed<EntreeCatalogue[]>(() => {
    const c = (settings.value || {}).mascottes_catalogue;
    const base = Array.isArray(c) && c.length ? c : CATALOGUE_REPLI;
    return base.map((m) => ({ id: m.id, label: m.label })).concat([{ id: "", label: "Logo" }]);
  });

  const IDS = computed<string[]>(() => {
    const s = settings.value || {};
    if (s.mascottes_on === false) return [];
    const a = s.mascottes_actives;
    return Array.isArray(a) && a.length ? a : TOUTES_C.value.map((m) => m.id).filter(Boolean);
  });
  const MASCOTTES = computed(() => TOUTES_C.value.filter((m) => !m.id || IDS.value.includes(m.id)));
  const mascottesOffertes = computed(() => (settings.value || {}).mascottes_on !== false);

  const mascottePhase = ref<"" | "salut" | "reveil">("");
  const mascotteDort = ref(false);
  const mascotteFlanerie = ref("");
  let tSommeil: Minuterie | undefined;
  let tFlanerie: Minuterie | undefined;
  let nFlanerie = 0;

  const skinMascotte = computed(() => {
    const s = settings.value || {};
    const sk = ctx.skinCourant?.value ?? null;
    return sk && sk.mascot && s.mascottes_on !== false ? String(sk.mascot) : "";
  });
  const skinKiki = computed(() => skinMascotte.value === "kiki");

  const mascotteId = computed(() => {
    const s = settings.value || {};
    if (skinMascotte.value) return skinMascotte.value;
    const v = String(s.welcome_mascot ?? "");
    return IDS.value.includes(v) ? v : "";
  });

  const mascotteVisible = computed(
    () => !!mascotteId.value && currentView.value === "chat" && (messages.value || []).length === 0,
  );

  const percheEtat = ref("");
  let tPerche: Minuterie | undefined;

  const perchePossible = computed(
    () =>
      !!mascotteId.value &&
      (settings.value || {}).welcome_mascot_anime !== false &&
      currentView.value === "chat" &&
      (messages.value || []).length > 0,
  );
  const perchee = computed(() => perchePossible.value && !!percheEtat.value);
  const percheDort = computed(() => percheEtat.value === "dort");
  const percheAnim = computed(() => PERCHE_ANIM[percheEtat.value] || "repos");
  const percheX = computed(() => PERCHE_X[percheEtat.value] || "-14%");
  const percheDuree = computed(() => PERCHE_DUREE[percheEtat.value] || "0s");

  function percher(): void {
    clearTimeout(tPerche);
    percheEtat.value = "entre";
    // Deux rAF : l'élément doit être posé hors champ avant qu'on lui donne sa destination.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (percheEtat.value === "entre") percheEtat.value = "arrive";
      }),
    );
    tPerche = setTimeout(() => {
      if (percheEtat.value === "arrive") percheEtat.value = "dort";
    }, 2600);
  }

  function depercher(): void {
    if (!percheEtat.value || percheEtat.value === "part") return;
    clearTimeout(tPerche);
    percheEtat.value = "reveil";
    tPerche = setTimeout(() => {
      percheEtat.value = "part";
      tPerche = setTimeout(() => {
        percheEtat.value = "";
      }, 1800);
    }, 900);
  }

  const mascotteEtat = computed<EtatMascotte>(() => {
    if (isStreaming.value) return "chantier";
    if (mascottePhase.value) return mascottePhase.value;
    if (mascotteDort.value) return "sommeil";
    if (mascotteFlanerie.value) return "flanerie";
    return "repos";
  });

  function armerSommeil(): void {
    clearTimeout(tSommeil);
    tSommeil = setTimeout(() => {
      if (perchePossible.value) percher();
      else mascotteDort.value = true;
    }, DELAI_SOMMEIL);
  }

  function armerFlanerie(): void {
    clearTimeout(tFlanerie);
    tFlanerie = setTimeout(() => {
      const liste = skinKiki.value ? FLANERIES_KIKI : FLANERIES;
      mascotteFlanerie.value = liste[nFlanerie++ % liste.length] ?? "";
    }, DELAI_FLANERIE);
  }

  function mascotteActivite(): void {
    if (mascotteDort.value) {
      mascotteDort.value = false;
      mascottePhase.value = "reveil";
    }
    depercher();
    armerSommeil();
    if (mascotteEtat.value === "repos") armerFlanerie();
  }

  function toutDesarmer(): void {
    clearTimeout(tSommeil);
    clearTimeout(tFlanerie);
    clearTimeout(tPerche);
    mascottePhase.value = "";
    mascotteDort.value = false;
    mascotteFlanerie.value = "";
    percheEtat.value = "";
  }

  const surveille = computed(() => mascotteVisible.value || perchePossible.value);

  watch(
    surveille,
    (actif) => {
      toutDesarmer();
      if (!actif) {
        document.removeEventListener("pointerdown", mascotteActivite, true);
        document.removeEventListener("keydown", mascotteActivite, true);
        return;
      }
      if (mascotteVisible.value) mascottePhase.value = "salut";
      armerSommeil();
      document.addEventListener("pointerdown", mascotteActivite, true);
      document.addEventListener("keydown", mascotteActivite, true);
    },
    { immediate: true },
  );

  watch(isStreaming, (on) => {
    if (!on && mascotteVisible.value) armerSommeil();
  });

  function scenarioDe(etat: string): string {
    if (skinKiki.value) {
      return etat === "flanerie" ? mascotteFlanerie.value || "fusillade" : (SCENES_KIKI[etat] ?? "attente");
    }
    return etat === "flanerie" ? mascotteFlanerie.value || "vol" : (SCENARIOS[etat] ?? "repos");
  }

  /** La scène a fini de jouer un événement : on le retire, et l'état retombe d'un cran. */
  function finDeScene(nom: string): void {
    if (skinKiki.value) {
      if (nom === "arrivee") mascottePhase.value = "";
      if (FLANERIES_KIKI.includes(nom)) mascotteFlanerie.value = "";
      return;
    }
    const phase = mascottePhase.value;
    if (phase && SCENARIOS[phase] === nom) mascottePhase.value = "";
    else if (mascotteFlanerie.value === nom) mascotteFlanerie.value = "";
  }

  const accueilHote = ref<HTMLElement | null>(null);
  let scene: SceneAccueil | null = null;
  let montage = 0;

  const mouvementReduit =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  function demonterScene(): void {
    scene?.detruire();
    scene = null;
  }

  async function monterScene(premier: boolean): Promise<void> {
    const hote = accueilHote.value;
    if (!hote || !mascotteVisible.value) return;
    const jeton = ++montage;
    let mod: { montrerAccueil: typeof montrerAccueil };
    try {
      mod = await import("./accueil");
    } catch (e) {
      journal.erreur("[mascotte] accueil illisible :", e);
      return;
    }
    if (jeton !== montage || !mascotteVisible.value) return;
    demonterScene();
    const reglage = (settings.value || {}).welcome_mascot_anime;
    const anime = reglage !== false;
    const style = styleAdmin();
    scene = mod.montrerAccueil(hote, {
      base: BASE,
      perso: mascotteId.value,
      mot: skinKiki.value ? "kiki" : "elpis",
      suffixe: skinKiki.value ? "teams" : "",
      scenario: scenarioDe(mascotteEtat.value),
      intro: premier,
      mouvement: anime ? "toujours" : "systeme",
      auFini: finDeScene,
      motif: style.motif,
      echelleMot: style.word_scale,
      echellePerso: style.mascot_scale,
    });
    journal.info(
      "[mascotte] accueil monté :",
      scene.choix,
      "· animé :",
      anime,
      "(réglage :",
      String(reglage),
      "· système réduit :",
      mouvementReduit,
      ")",
    );
  }

  watch(
    accueilHote,
    (hote) => {
      if (hote) void monterScene(true);
      else demonterScene();
    },
    { immediate: true },
  );

  watch(mascotteId, (id) => {
    if (!accueilHote.value) return;
    if (id) mascottePhase.value = "salut";
    void monterScene(true);
  });

  watch(mascotteEtat, (etat) => {
    clearTimeout(tFlanerie);
    if (etat !== "flanerie" && mascotteFlanerie.value) mascotteFlanerie.value = "";
    if (etat === "repos" && mascotteVisible.value) armerFlanerie();
    const nom = scenarioDe(etat);
    if (scene && !(skinKiki.value && scene.scenario === nom)) scene.jouer(nom);
    if (skinKiki.value && (etat === "salut" || etat === "reveil")) {
      setTimeout(() => {
        if (mascottePhase.value === etat) mascottePhase.value = "";
      }, 0);
    }
  });

  watch(
    () => (settings.value || {}).welcome_mascot_anime,
    () => {
      if (accueilHote.value) void monterScene(false);
    },
  );

  watch(
    () => {
      const s = styleAdmin();
      return `${s.motif}|${s.word_scale}|${s.mascot_scale}`;
    },
    () => {
      if (accueilHote.value) void monterScene(false);
    },
  );

  onUnmounted(() => {
    clearTimeout(tSommeil);
    clearTimeout(tFlanerie);
    clearTimeout(tPerche);
    demonterScene();
    document.removeEventListener("pointerdown", mascotteActivite, true);
    document.removeEventListener("keydown", mascotteActivite, true);
  });

  return {
    MASCOTTES,
    mascottesOffertes,
    mascotteId,
    perchee,
    percheDort,
    percheAnim,
    percheX,
    percheDuree,
    mascotteVisible,
    mascotteEtat,
    accueilHote,
    mouvementReduit,
  };
}

export type SurfaceMascotte = ReturnType<typeof creerMascotte>;
