// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/executions.ts — console › Supervision › Exécutions : coût par compte et liste filtrable (`/api/admin/runs*`). */
import { schemaReponseExecutionsConsole, schemaReponseExecutionsParCompte } from "@elpis/contracts";
import type { ExecutionListee } from "@elpis/contracts";
import { ref } from "vue";
import type { Ref } from "vue";

import { nombre } from "./formats";
import { PAR_PAGE, pageBornee, parametresTri, trierPar } from "./pagination";
import type { Tri } from "./pagination";
import { ecrirePeriode, lirePeriode, periodeValide } from "./periode";
import { chargementEchoue, chargementReussi } from "./suivi-chargement";
import type { ClientHttp } from "../../platform/http/client";
import { fmtTokenCount, tokenBreakdown } from "../../utils/utils-purs";

type CompteExecutions = (typeof schemaReponseExecutionsParCompte)["_output"]["items"][number];

export interface FiltreExecutions {
  userId: number | null;
  username: string;
  kind: string;
  status: string;
  q: string;
  /** Exécution précise (arrivée depuis un appel d'outil). */
  runId: string;
}

const TRI_DEFAUT: Tri = { col: "started_at", dir: "desc" };
const DELAI_RECHERCHE_MS = 300;

interface LigneTokens {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  thinking_tokens?: number | null;
  tool_tokens?: number | null;
}

export function setupAdminRuns(http: ClientHttp) {
  const admRunsScope = ref(lirePeriode());
  const admRunsLoading = ref(false);
  const admRunsDerniereMaj: Ref<number | null> = ref(null);
  const admRunsEchec = ref(false);
  const admRunsAccounts: Ref<CompteExecutions[]> = ref([]);
  const admRunsItems: Ref<ExecutionListee[]> = ref([]);
  const admRunsFilter: Ref<FiltreExecutions> = ref({
    userId: null,
    username: "",
    kind: "",
    status: "",
    q: "",
    runId: "",
  });
  const admRunsTri: Ref<Tri> = ref({ ...TRI_DEFAUT });
  const admRunsPage = ref(1);
  const admRunsParPage = PAR_PAGE;
  const admRunsTotal = ref(0);
  /** Exécution à mettre en évidence après une arrivée depuis un appel d'outil. */
  const admRunsSurligne = ref("");
  let seqComptes = 0;
  let seqListe = 0;
  /** Le total affiché ne correspond plus aux filtres tant qu'une réponse `count=1` n'a pas été appliquée. */
  let totalPerime = false;
  let actifs = 0;
  let echecComptes = false;
  let echecListe = false;
  let minuterie: ReturnType<typeof setTimeout> | null = null;

  function qs(avecTotal: boolean): string {
    const f = admRunsFilter.value;
    const p = ["hours=" + admRunsScope.value, "limit=" + admRunsParPage];
    p.push("offset=" + (admRunsPage.value - 1) * admRunsParPage);
    p.push(...parametresTri(admRunsTri.value, TRI_DEFAUT));
    if (f.runId) p.push("run_id=" + encodeURIComponent(f.runId));
    if (f.q.trim()) p.push("q=" + encodeURIComponent(f.q.trim()));
    if (f.userId !== null) p.push("user_id=" + encodeURIComponent(f.userId));
    if (f.kind) p.push("kind=" + encodeURIComponent(f.kind));
    if (f.status) p.push("status=" + encodeURIComponent(f.status));
    if (!avecTotal) p.push("count=0");
    return p.join("&");
  }

  /** Comptes de la période : agrégat lourd, relancé à l'entrée sur l'onglet, au changement de période et sur Actualiser seulement (`frais` : le serveur ignore son cache). */
  async function chargerComptes(frais: boolean): Promise<void> {
    const moi = ++seqComptes;
    debutChargement();
    try {
      const ra = await http.requete(
        `/api/admin/runs/accounts?hours=${admRunsScope.value}${frais ? "&fresh=1" : ""}`,
        {},
        { schema: schemaReponseExecutionsParCompte },
      );
      if (moi !== seqComptes) return;
      if (ra.type === "ok") admRunsAccounts.value = ra.valeur.items;
      echecComptes = ra.type !== "ok";
      bilan();
    } finally {
      finChargement();
    }
  }

  /** Liste des exécutions ; le total n'est redemandé (`avecTotal`) que si les filtres ou la période changent. */
  async function loadListeExecutions(avecTotal = true): Promise<void> {
    const moi = ++seqListe;
    debutChargement();
    admRunsScope.value = lirePeriode();
    if (avecTotal) totalPerime = true;
    try {
      const rl = await http.requete(
        `/api/admin/runs?${qs(avecTotal)}`,
        {},
        { schema: schemaReponseExecutionsConsole },
      );
      if (moi !== seqListe) return;
      if (rl.type === "ok") {
        admRunsItems.value = rl.valeur.items;
        if (rl.valeur.total !== null) {
          admRunsTotal.value = rl.valeur.total;
          totalPerime = false;
        }
        const page = pageBornee(admRunsPage.value, admRunsTotal.value, admRunsParPage);
        if (rl.valeur.total !== null && page !== admRunsPage.value) {
          admRunsPage.value = page;
          void loadListeExecutions();
        } else if (rl.valeur.total === null && admRunsPage.value > 1 && rl.valeur.items.length === 0) {
          // Page vidée par une purge : le total est redemandé pour retomber sur une page existante.
          void loadListeExecutions();
        }
      }
      echecListe = rl.type !== "ok";
      bilan();
    } finally {
      finChargement();
    }
  }

  function debutChargement(): void {
    actifs += 1;
    admRunsLoading.value = true;
  }
  function finChargement(): void {
    actifs -= 1;
    if (actifs <= 0) admRunsLoading.value = false;
  }
  function bilan(): void {
    admRunsEchec.value = echecComptes || echecListe;
    if (!admRunsEchec.value) {
      chargementReussi("loadAdminRuns");
      admRunsDerniereMaj.value = Date.now();
    } else chargementEchoue("loadAdminRuns", "Réponse du serveur inattendue ou en échec.", loadAdminRuns);
  }

  /** Entrée sur l'onglet, période, Actualiser (`frais`) : comptes et liste. */
  async function loadAdminRuns(frais = false): Promise<void> {
    admRunsScope.value = lirePeriode();
    await Promise.all([chargerComptes(frais), loadListeExecutions()]);
  }

  function setAdmRunsScope(h: number): void {
    admRunsScope.value = periodeValide(h);
    ecrirePeriode(admRunsScope.value);
    admRunsPage.value = 1;
    void loadAdminRuns();
  }

  function setAdmRunsFilter(patch?: Partial<FiltreExecutions>): void {
    admRunsFilter.value = { ...admRunsFilter.value, ...patch };
    admRunsPage.value = 1;
    void loadListeExecutions();
  }

  /** Recherche libre côté serveur, lancée 300 ms après la dernière frappe. */
  function rechercherExecutions(q: string): void {
    admRunsFilter.value = { ...admRunsFilter.value, q };
    if (minuterie !== null) clearTimeout(minuterie);
    minuterie = setTimeout(() => {
      minuterie = null;
      admRunsPage.value = 1;
      void loadListeExecutions();
    }, DELAI_RECHERCHE_MS);
  }

  function effacerFiltresExecutions(): void {
    if (minuterie !== null) clearTimeout(minuterie);
    minuterie = null;
    admRunsSurligne.value = "";
    setAdmRunsFilter({ userId: null, username: "", kind: "", status: "", q: "", runId: "" });
  }

  function trierExecutions(col: string): void {
    admRunsTri.value = trierPar(admRunsTri.value, col);
    admRunsPage.value = 1;
    void loadListeExecutions(totalPerime);
  }

  function setAdmRunsPage(page: number): void {
    admRunsPage.value = pageBornee(page, admRunsTotal.value, admRunsParPage);
    void loadListeExecutions(totalPerime);
  }

  /** Prépare la liste pour montrer une exécution (arrivée depuis un appel d'outil) ; l'onglet affiché la charge. */
  function montrerExecution(runId: string): void {
    admRunsFilter.value = { userId: null, username: "", kind: "", status: "", q: "", runId };
    admRunsPage.value = 1;
    admRunsSurligne.value = runId;
  }

  function toggleAdmRunsAccount(a: CompteExecutions | null): void {
    if (a && admRunsFilter.value.userId !== a.user_id) {
      setAdmRunsFilter({ userId: a.user_id, username: a.username || "#" + a.user_id });
    } else setAdmRunsFilter({ userId: null, username: "" });
  }

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
    return fmtTokenCount(b.input) + (b.cache ? " · " + b.cache_pct + " % cache" : "");
  }

  function admRunsOut(r: LigneTokens): string {
    const b = parts(r);
    return fmtTokenCount(b.output) + (b.thinking ? " · " + fmtTokenCount(b.thinking) + " réflexion" : "");
  }

  function admRunsTokensTitle(r: LigneTokens): string {
    const b = parts(r);
    return (
      "Entrée " +
      nombre(b.input) +
      " : cache " +
      nombre(b.cache) +
      " · utile " +
      nombre(b.input_new) +
      (b.tools ? " · outils ≈ " + nombre(b.tools) : "") +
      "\nSortie " +
      nombre(b.output) +
      " : réflexion " +
      nombre(b.thinking) +
      " · réponse " +
      nombre(b.response)
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
    admRunsDerniereMaj,
    admRunsEchec,
    admRunsLoading,
    admRunsAccounts,
    admRunsItems,
    admRunsFilter,
    admRunsTri,
    admRunsPage,
    admRunsParPage,
    admRunsTotal,
    admRunsSurligne,
    loadAdminRuns,
    loadListeExecutions,
    rechercherExecutions,
    effacerFiltresExecutions,
    trierExecutions,
    setAdmRunsPage,
    montrerExecution,
    setAdmRunsScope,
    setAdmRunsFilter,
    toggleAdmRunsAccount,
    admRunsDuration,
    admRunsIn,
    admRunsOut,
    admRunsTokensTitle,
  };
}
