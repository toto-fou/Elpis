// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/executions.ts — console › Supervision › Exécutions : coût par compte et liste filtrable (`/api/admin/runs*`). */
import { schemaReponseExecutionsConsole, schemaReponseExecutionsParCompte } from "@elpis/contracts";
import type { ExecutionListee } from "@elpis/contracts";
import { ref } from "vue";
import type { Ref } from "vue";

import { chargementEchoue, chargementReussi } from "./suivi-chargement";
import type { ClientHttp } from "../../platform/http/client";
import { fmtTokenCount, tokenBreakdown } from "../../utils/utils-purs";

type CompteExecutions = (typeof schemaReponseExecutionsParCompte)["_output"]["items"][number];

export interface FiltreExecutions {
  userId: number | null;
  username: string;
  kind: string;
  status: string;
}

interface LigneTokens {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  thinking_tokens?: number | null;
  tool_tokens?: number | null;
}

export function setupAdminRuns(http: ClientHttp) {
  const admRunsScope = ref(24);
  const admRunsLoading = ref(false);
  const admRunsAccounts: Ref<CompteExecutions[]> = ref([]);
  const admRunsItems: Ref<ExecutionListee[]> = ref([]);
  const admRunsFilter: Ref<FiltreExecutions> = ref({ userId: null, username: "", kind: "", status: "" });
  let seq = 0;

  function qs(): string {
    const f = admRunsFilter.value;
    const p = ["hours=" + admRunsScope.value];
    if (f.userId !== null) p.push("user_id=" + encodeURIComponent(f.userId));
    if (f.kind) p.push("kind=" + encodeURIComponent(f.kind));
    if (f.status) p.push("status=" + encodeURIComponent(f.status));
    return p.join("&");
  }

  async function loadAdminRuns(): Promise<void> {
    const moi = ++seq;
    admRunsLoading.value = true;
    try {
      const [ra, rl] = await Promise.all([
        http.requete(
          `/api/admin/runs/accounts?hours=${admRunsScope.value}`,
          {},
          { schema: schemaReponseExecutionsParCompte },
        ),
        http.requete(`/api/admin/runs?${qs()}`, {}, { schema: schemaReponseExecutionsConsole }),
      ]);
      if (moi !== seq) return;
      if (ra.type === "ok") admRunsAccounts.value = ra.valeur.items;
      if (rl.type === "ok") admRunsItems.value = rl.valeur.items;
      if (ra.type === "ok" && rl.type === "ok") chargementReussi("loadAdminRuns");
      else chargementEchoue("loadAdminRuns", "Réponse du serveur inattendue ou en échec.", loadAdminRuns);
    } finally {
      if (moi === seq) admRunsLoading.value = false;
    }
  }

  function setAdmRunsScope(h: number): void {
    admRunsScope.value = h === 168 || h === 720 ? h : 24;
    void loadAdminRuns();
  }

  function setAdmRunsFilter(patch?: Partial<FiltreExecutions>): void {
    admRunsFilter.value = { ...admRunsFilter.value, ...patch };
    void loadAdminRuns();
  }

  function toggleAdmRunsAccount(a: CompteExecutions | null): void {
    if (a && admRunsFilter.value.userId !== a.user_id) {
      setAdmRunsFilter({ userId: a.user_id, username: a.username || "#" + a.user_id });
    } else setAdmRunsFilter({ userId: null, username: "" });
  }

  const admRunsTokens = (n: unknown): string => fmtTokenCount(n);
  const parts = (r: LigneTokens | null | undefined) =>
    tokenBreakdown(
      r?.input_tokens,
      r?.output_tokens,
      r?.cache_read_tokens,
      r?.thinking_tokens,
      r?.tool_tokens,
    );

  function admRunsIn(r: LigneTokens): string {
    const b = parts(r);
    return admRunsTokens(b.input) + (b.cache ? " · " + b.cache_pct + " % cache" : "");
  }

  function admRunsOut(r: LigneTokens): string {
    const b = parts(r);
    return admRunsTokens(b.output) + (b.thinking ? " · " + admRunsTokens(b.thinking) + " réflexion" : "");
  }

  function admRunsTokensTitle(r: LigneTokens): string {
    const b = parts(r);
    const n = (x: number): string => x.toLocaleString("fr-FR");
    return (
      "Entrée " +
      n(b.input) +
      " : cache " +
      n(b.cache) +
      " · utile " +
      n(b.input_new) +
      (b.tools ? " · outils ≈ " + n(b.tools) : "") +
      "\nSortie " +
      n(b.output) +
      " : réflexion " +
      n(b.thinking) +
      " · réponse " +
      n(b.response)
    );
  }

  function admRunsDuration(ms: unknown): string {
    const n = Math.round(Number(ms) || 0);
    if (n < 1000) return n + " ms";
    if (n < 60000) return (n / 1000).toFixed(1).replace(".", ",") + " s";
    if (n < 3600000) return Math.floor(n / 60000) + " min " + Math.round((n % 60000) / 1000) + " s";
    return Math.floor(n / 3600000) + " h " + Math.round((n % 3600000) / 60000) + " min";
  }

  return {
    admRunsScope,
    admRunsLoading,
    admRunsAccounts,
    admRunsItems,
    admRunsFilter,
    loadAdminRuns,
    setAdmRunsScope,
    setAdmRunsFilter,
    toggleAdmRunsAccount,
    admRunsTokens,
    admRunsDuration,
    admRunsIn,
    admRunsOut,
    admRunsTokensTitle,
  };
}
