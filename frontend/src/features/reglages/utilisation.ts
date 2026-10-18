// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/utilisation.ts — Paramètres › Utilisation : métriques du compte (`/api/usage/me`) et barres de tokens. */
import { schemaReponseUsageMoi, schemaUsageSource, schemaUsageTokens } from "@elpis/contracts";
import { computed, ref } from "vue";
import type { Ref } from "vue";
import { z } from "zod";

import type { ClientHttp } from "../../platform/http/client";
import type { ApiResult } from "../../platform/http/resultat";
import { fmtTokenCount } from "../../utils/utils-purs";

const schemaSource = schemaUsageSource.partial();
/** Réponse du contrat, relue sans exiger chaque champ : un serveur plus ancien ne fait pas tomber l'onglet. */
export const schemaUsageMoi = schemaReponseUsageMoi
  .extend({
    chats: schemaReponseUsageMoi.shape.chats.partial(),
    messages: schemaReponseUsageMoi.shape.messages.partial(),
    routines: schemaReponseUsageMoi.shape.routines.partial(),
    tokens: schemaUsageTokens.partial().extend({ by_source: z.array(schemaSource).optional() }),
  })
  .partial()
  .loose();
export type UsageMoi = z.infer<typeof schemaUsageMoi>;
type SourceUsage = z.infer<typeof schemaSource>;

export interface BarreUsage {
  key: string;
  label: string;
  cls: string;
  value: number | undefined;
  sub?: boolean;
  note: string;
  title: string;
}

const LIBELLES_SOURCE: Readonly<Record<string, string>> = Object.freeze({
  chat: "Chat",
  routine: "Routines",
  webhook: "Webhooks",
  subagent: "Sous-agents",
  title: "Titres",
  compression: "Compression",
  scenario: "Studio",
  remote: "Remote code",
  unknown: "Non attribué",
});

const nb = (x: unknown): string => (Number(x) || 0).toLocaleString("fr-FR");
const pc = (part: unknown, total: unknown): number =>
  Number(total) > 0 ? Math.round((100 * (Number(part) || 0)) / Number(total)) : 0;

export const usageSourceLabel = (s: string | undefined): string => (s && LIBELLES_SOURCE[s]) || s || "Autre";

export function usageWidth(part: unknown, total: unknown): string {
  const p = Number(part) || 0;
  const t = Number(total) || 0;
  return (t > 0 ? Math.max(0, Math.min(100, (100 * p) / t)) : 0).toFixed(2) + "%";
}

export function usageSourceTitle(s: SourceUsage): string {
  return (
    usageSourceLabel(s.source) +
    " — " +
    nb(s.tokens) +
    " tokens, " +
    nb(s.turns) +
    " tours" +
    "\nentrée " +
    nb(s.input) +
    " (cache " +
    nb(s.cache) +
    ", outils ≈ " +
    nb(s.tools) +
    ")" +
    "\nsortie " +
    nb(s.output) +
    " (réflexion " +
    nb(s.thinking) +
    ")"
  );
}

function erreurChargement(r: ApiResult<unknown>): string {
  switch (r.type) {
    case "requete":
    case "serveur":
    case "refus":
    case "conflit":
      return "Erreur serveur (HTTP " + r.statut + ")";
    case "reseau":
    case "annulation":
    case "perime":
    case "expiration":
      return "Service injoignable";
    default:
      return "Erreur de chargement";
  }
}

export function setupUtilisation(http: ClientHttp) {
  const usageData: Ref<UsageMoi | null> = ref(null);
  const usageLoading = ref(false);
  const usageError = ref("");
  const usageDays = ref(30);

  async function loadUsageData(): Promise<void> {
    usageLoading.value = true;
    usageError.value = "";
    try {
      const r = await http.requete(`/api/usage/me?days=${usageDays.value}`, {}, { schema: schemaUsageMoi });
      if (r.type === "ok") usageData.value = r.valeur;
      else usageError.value = erreurChargement(r);
    } finally {
      usageLoading.value = false;
    }
  }

  function setUsageDays(d: number): void {
    usageDays.value = [1, 7, 90].includes(d) ? d : 30;
    void loadUsageData();
  }

  const usageThinkingPct = computed(() => {
    const t = usageData.value?.tokens;
    if (!t?.output) return 0;
    return Math.round((1000 * (t.thinking || 0)) / t.output) / 10;
  });

  const usageFmt = (n: unknown): string => fmtTokenCount(n);

  const usageBars = computed<BarreUsage[]>(() => {
    const t = usageData.value?.tokens ?? {};
    const inp = Number(t.input) || 0;
    const out = Number(t.output) || 0;
    return [
      {
        key: "input",
        label: "Entrée",
        cls: "bg-blue-500",
        value: inp,
        note: "utile " + usageFmt(t.input_new),
        title:
          "Entrée " +
          nb(inp) +
          " : " +
          nb(t.cache) +
          " relus du cache, " +
          nb(t.input_new) +
          " utiles (calculés)" +
          (t.cache_creation ? " · " + nb(t.cache_creation) + " mis en cache" : ""),
      },
      {
        key: "cache",
        label: "Cache",
        cls: "bg-slate-300",
        value: t.cache,
        sub: true,
        note: pc(t.cache, inp) + " % de l'entrée",
        title: "Entrée relue du cache de prompt : " + nb(t.cache) + " tokens",
      },
      {
        key: "tools",
        label: "Outils",
        cls: "bg-blue-400",
        value: t.tools,
        sub: true,
        note: "≈ " + pc(t.tools, inp) + " % de l'entrée",
        title:
          "Entrée occupée par les outils (définitions, appels et résultats re-soumis à chaque appel du modèle) : ≈ " +
          nb(t.tools) +
          " tokens, estimés",
      },
      {
        key: "output",
        label: "Sortie",
        cls: "bg-blue-700",
        value: out,
        note: "réponse " + usageFmt(t.response),
        title:
          "Sortie " +
          nb(out) +
          " : " +
          nb(t.thinking) +
          " de réflexion, " +
          nb(t.response) +
          " de réponse (texte et appels d'outils)",
      },
      {
        key: "thinking",
        label: "Réflexion",
        cls: "bg-amber-500",
        value: t.thinking,
        sub: true,
        note: pc(t.thinking, out) + " % de la sortie",
        title: "Réflexion (raisonnement) : " + nb(t.thinking) + " tokens, comptés dans la sortie",
      },
    ];
  });

  const usageBarMax = computed(() => {
    const t = usageData.value?.tokens ?? {};
    return Math.max(Number(t.input) || 0, Number(t.output) || 0);
  });

  const usageSourceMax = computed(() =>
    (usageData.value?.tokens?.by_source ?? []).reduce((m, s) => Math.max(m, Number(s.tokens) || 0), 0),
  );

  return {
    usageData,
    usageLoading,
    usageError,
    usageDays,
    loadUsageData,
    setUsageDays,
    usageSourceLabel,
    usageThinkingPct,
    usageFmt,
    usageWidth,
    usageBars,
    usageBarMax,
    usageSourceMax,
    usageSourceTitle,
  };
}
