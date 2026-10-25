// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/affichage-chat.ts — préférences d'affichage du chat (déroulé du tour, contexte, réflexions, métriques, densité) : valeurs fermées, lecture normalisée, seul point de lecture des composants, fourni par la racine. */
import { computed, inject, provide, reactive, watch } from "vue";
import type { InjectionKey } from "vue";

export const DEROULES = ["classic", "work_block", "timeline", "terminal"] as const;
export const CONTEXTES = ["tokens", "fill", "percent", "ring"] as const;
export const REFLEXIONS = ["collapsed", "expanded", "hidden"] as const;
export const METRIQUES = ["full", "essential", "hidden"] as const;
export const DENSITES = ["comfortable", "compact"] as const;

export type Deroule = (typeof DEROULES)[number];
export type AffichageContexte = (typeof CONTEXTES)[number];
export type AffichageReflexions = (typeof REFLEXIONS)[number];
export type AffichageMetriques = (typeof METRIQUES)[number];
export type Densite = (typeof DENSITES)[number];

export interface PreferencesChat {
  readonly deroule: Deroule;
  readonly contexte: AffichageContexte;
  readonly reflexions: AffichageReflexions;
  readonly metriques: AffichageMetriques;
  readonly densite: Densite;
  readonly captures: boolean;
}

/** Réglages lus : les clés d'affichage et les deux anciennes qu'elles remplacent. */
export interface ReglagesAffichageChat {
  chat_workflow?: unknown;
  context_display?: unknown;
  thinking_display?: unknown;
  footer_metrics?: unknown;
  thread_density?: unknown;
  hide_web_screenshots?: unknown;
  hide_thinking?: unknown;
}

// Par défaut, le premier affichage d'Elpis (déroulé et jetons du contexte, choix du 25/10) ; le reste se choisit dans Paramètres › Chat.
export const PREFERENCES_PAR_DEFAUT: PreferencesChat = Object.freeze({
  deroule: "classic",
  contexte: "tokens",
  reflexions: "collapsed",
  metriques: "full",
  densite: "comfortable",
  captures: true,
});

function choisir<T extends string>(valeurs: readonly T[], v: unknown, defaut: T): T {
  return typeof v === "string" && (valeurs as readonly string[]).includes(v) ? (v as T) : defaut;
}

/** Préférences normalisées ; un compte qui avait masqué le raisonnement le retrouve masqué. */
export function lirePreferencesChat(s: unknown): PreferencesChat {
  const r = (s && typeof s === "object" ? s : {}) as ReglagesAffichageChat;
  const d = PREFERENCES_PAR_DEFAUT;
  return {
    deroule: choisir(DEROULES, r.chat_workflow, d.deroule),
    contexte: choisir(CONTEXTES, r.context_display, d.contexte),
    reflexions: choisir(REFLEXIONS, r.thinking_display, r.hide_thinking === true ? "hidden" : d.reflexions),
    metriques: choisir(METRIQUES, r.footer_metrics, d.metriques),
    densite: choisir(DENSITES, r.thread_density, d.densite),
    captures: r.hide_web_screenshots !== true,
  };
}

export const CLE_PREFERENCES_CHAT: InjectionKey<PreferencesChat> = Symbol("elpis:preferences-chat");
export const CLASSE_FIL_COMPACT = "elpis-fil-compact";

/** Fournit les préférences depuis les réglages lus (dans le `setup` d'une racine) ; la densité pose une classe sur le body. */
export function fournirPreferencesChat(lire: () => unknown): PreferencesChat {
  const prefs = computed(() => lirePreferencesChat(lire()));
  const domaine = reactive({
    deroule: computed(() => prefs.value.deroule),
    contexte: computed(() => prefs.value.contexte),
    reflexions: computed(() => prefs.value.reflexions),
    metriques: computed(() => prefs.value.metriques),
    densite: computed(() => prefs.value.densite),
    captures: computed(() => prefs.value.captures),
  }) as PreferencesChat;
  watch(
    () => prefs.value.densite,
    (densite) => {
      try {
        document.body.classList.toggle(CLASSE_FIL_COMPACT, densite === "compact");
      } catch {
        /* DOM indisponible */
      }
    },
    { immediate: true },
  );
  provide(CLE_PREFERENCES_CHAT, domaine);
  return domaine;
}

/** Préférences fournies par la racine ; sans racine (composant monté seul), les valeurs par défaut. */
export function preferencesChat(): PreferencesChat {
  return inject(CLE_PREFERENCES_CHAT, PREFERENCES_PAR_DEFAUT);
}

export interface ChoixAffichage {
  readonly valeur: string;
  readonly libelle: string;
}

export interface ReglageAffichage {
  readonly cle: keyof ReglagesAffichageChat;
  readonly libelle: string;
  readonly icone: string;
  /** Lecture de la valeur courante dans les préférences normalisées. */
  readonly lire: (p: PreferencesChat) => string;
  readonly choix: readonly ChoixAffichage[];
  /** Une ligne sous le contrôle, selon la valeur choisie (déroulé seulement). */
  readonly aides?: Readonly<Record<string, string>>;
}

/** Réglages d'affichage proposés dans Paramètres › Chat, dans l'ordre de l'écran. */
export const REGLAGES_AFFICHAGE: readonly ReglageAffichage[] = [
  {
    cle: "chat_workflow",
    libelle: "Déroulé",
    icone: "ph-list-dashes",
    lire: (p) => p.deroule,
    choix: [
      { valeur: "classic", libelle: "Classique" },
      { valeur: "work_block", libelle: "En bloc" },
      { valeur: "timeline", libelle: "Chronologie" },
      { valeur: "terminal", libelle: "Journal" },
    ],
    aides: {
      classic: "Le premier affichage d'Elpis : le travail replié sur une ligne, la réponse en clair.",
      work_block: "Le travail en bloc au-dessus de la réponse, ouvert pendant le tour.",
      timeline: "Réflexion, texte et étapes de chaque appel, dans l'ordre.",
      terminal: "Une ligne par geste, façon terminal, résultats en retrait.",
    },
  },
  {
    cle: "context_display",
    libelle: "Contexte",
    icone: "ph-gauge",
    lire: (p) => p.contexte,
    choix: [
      { valeur: "tokens", libelle: "Jetons (utilisés / fenêtre)" },
      { valeur: "fill", libelle: "Bloc qui se remplit" },
      { valeur: "percent", libelle: "Pourcentage" },
      { valeur: "ring", libelle: "Anneau" },
    ],
  },
  {
    cle: "thinking_display",
    libelle: "Réflexions",
    icone: "ph-brain",
    lire: (p) => p.reflexions,
    choix: [
      { valeur: "collapsed", libelle: "Repliées" },
      { valeur: "expanded", libelle: "Dépliées" },
      { valeur: "hidden", libelle: "Masquées" },
    ],
  },
  {
    cle: "footer_metrics",
    libelle: "Métriques",
    icone: "ph-chart-line",
    lire: (p) => p.metriques,
    choix: [
      { valeur: "full", libelle: "Complètes" },
      { valeur: "essential", libelle: "Essentielles (modèle, durée)" },
      { valeur: "hidden", libelle: "Masquées" },
    ],
  },
  {
    cle: "thread_density",
    libelle: "Densité",
    icone: "ph-rows",
    lire: (p) => p.densite,
    choix: [
      { valeur: "comfortable", libelle: "Confortable" },
      { valeur: "compact", libelle: "Compacte" },
    ],
  },
];
