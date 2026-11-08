// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/observabilite.ts — console › Activité › Appels d'outils : synthèse par outil et dernières erreurs, avec jeton de fraîcheur. */
import type { Ref } from "vue";

import { corpsJson, listeObjets, objet } from "../../utils/lecture-json";
import type { BaseAdmin } from "./etat";
import { PAR_PAGE, pageBornee, parametresTri, trierPar } from "./pagination";
import type { Tri } from "./pagination";
import { ecrirePeriode, lirePeriode, periodeValide } from "./periode";
import { chargementEchoue, chargementReussi } from "./suivi-chargement";

export interface SyntheseOutils {
  totals: {
    n: number;
    total_ms?: number;
    n_error?: number;
    n_blocked?: number;
    n_timeout?: number;
    [cle: string]: unknown;
  };
  per_tool: {
    tool_name: string;
    n: number;
    total_ms: number;
    n_failed: number;
    avg_ms: number;
    [cle: string]: unknown;
  }[];
  [cle: string]: unknown;
}
export interface ErreurOutil {
  ts: number;
  run_id: string | null;
  node_id: string | null;
  tool_name: string;
  server_name?: string | null;
  status: string;
  duration_ms: number | null;
  error_short: string | null;
  [cle: string]: unknown;
}
export interface FiltreOutils {
  statut: string;
  outil: string;
  serveur: string;
  q: string;
}
const TRI_OUTILS: Tri = { col: "ts", dir: "desc" };
const DELAI_RECHERCHE_MS = 300;

export function creerObservabilite(b: BaseAdmin) {
  const { vue, ctx } = b;
  const { ref } = vue;
  const obsScope = ref(lirePeriode());
  const obsLoading = ref(false);
  const obsDerniereMaj: Ref<number | null> = ref(null);
  const obsEchec = ref(false);
  const obsSummary: Ref<SyntheseOutils> = ref({ totals: { n: 0 }, per_tool: [] });
  const obsFailures: Ref<ErreurOutil[]> = ref([]);
  const outilsFiltre: Ref<FiltreOutils> = ref({ statut: "", outil: "", serveur: "", q: "" });
  const outilsTri: Ref<Tri> = ref({ ...TRI_OUTILS });
  const outilsPage = ref(1);
  const outilsParPage = PAR_PAGE;
  const outilsTotal = ref(0);
  let minuterieOutils: ReturnType<typeof setTimeout> | null = null;
  let sequenceOutils = 0;
  let sequenceSynthese = 0;
  /** La dernière synthèse par outil a échoué : une page ou un filtre réussis ne le font pas oublier. */
  let echecSynthese = false;

  /** Recharge l'onglet Appels d'outils (`frais` : Actualiser, le serveur ignore son cache). */
  function rechargerPage(frais = false): void {
    void loadToolCalls(frais);
  }
  function setObsScope(h: number): void {
    obsScope.value = periodeValide(h);
    ecrirePeriode(obsScope.value);
    outilsPage.value = 1;
    rechargerPage();
  }

  function debut(): void {
    obsLoading.value = true;
    obsScope.value = lirePeriode();
  }
  function fin(reussi: boolean, raison: string): void {
    if (reussi) {
      chargementReussi("loadToolCalls");
      obsEchec.value = false;
      obsDerniereMaj.value = Date.now();
    } else {
      obsEchec.value = true;
      chargementEchoue("loadToolCalls", raison, reessayer);
    }
  }

  /** Paramètres de la liste des erreurs : période, fenêtre, tri, filtres et recherche. */
  function requeteErreurs(heures: number): string {
    const f = outilsFiltre.value;
    const p = [
      `hours=${heures}`,
      `limit=${outilsParPage}`,
      `offset=${(outilsPage.value - 1) * outilsParPage}`,
    ];
    p.push(...parametresTri(outilsTri.value, TRI_OUTILS));
    if (f.statut) p.push("status=" + encodeURIComponent(f.statut));
    if (f.outil) p.push("tool=" + encodeURIComponent(f.outil));
    if (f.serveur) p.push("server=" + encodeURIComponent(f.serveur));
    if (f.q.trim()) p.push("q=" + encodeURIComponent(f.q.trim()));
    return p.join("&");
  }

  /** Charge les erreurs paginées (page purgée entre-temps : retour à la dernière) et la synthèse par outil si demandée ; seule la dernière demande de chaque genre écrit. */
  async function chargerOutils(avecSynthese: boolean, frais = false): Promise<void> {
    const moi = ++sequenceOutils;
    const moiSynthese = avecSynthese ? ++sequenceSynthese : 0;
    debut();
    const heures = obsScope.value;
    try {
      const [rSynthese, rErreurs] = await Promise.all([
        avecSynthese
          ? ctx.fetchAuth(
              `/api/admin/observability/tool-summary?hours=${heures}&limit=500${frais ? "&fresh=1" : ""}`,
              {},
              true,
            )
          : Promise.resolve(null),
        ctx.fetchAuth(`/api/admin/observability/tool-failures?${requeteErreurs(heures)}`, {}, true),
      ]);
      let rechargerPageVide = false;
      if (avecSynthese && moiSynthese === sequenceSynthese) echecSynthese = !rSynthese?.ok;
      if (rSynthese?.ok) {
        const d = objet(await corpsJson(rSynthese));
        if (moiSynthese === sequenceSynthese)
          obsSummary.value = {
            ...d,
            totals: { n: 0, ...objet(d["totals"]) },
            per_tool: listeObjets(d["per_tool"]) as SyntheseOutils["per_tool"],
          };
      }
      if (moi !== sequenceOutils) return;
      if (rErreurs?.ok) {
        const d = objet(await corpsJson(rErreurs));
        if (moi === sequenceOutils) {
          obsFailures.value = listeObjets(d["items"]) as ErreurOutil[];
          outilsTotal.value = typeof d["total"] === "number" ? d["total"] : obsFailures.value.length;
          const page = pageBornee(outilsPage.value, outilsTotal.value, outilsParPage);
          if (page !== outilsPage.value) {
            outilsPage.value = page;
            rechargerPageVide = true;
          }
        }
      }
      if (moi === sequenceOutils)
        fin(!!rErreurs?.ok && !echecSynthese, "Réponse du serveur inattendue ou en échec.");
      if (rechargerPageVide && moi === sequenceOutils) void loadErreursOutils();
    } catch {
      if (avecSynthese && moiSynthese === sequenceSynthese) echecSynthese = true;
      if (moi === sequenceOutils) fin(false, "Erreur réseau.");
    } finally {
      if (moi === sequenceOutils) obsLoading.value = false;
    }
  }

  /** Réessayer relance la synthèse si c'est elle qui a échoué, sinon les erreurs seules. */
  const reessayer = (): Promise<void> => (echecSynthese ? loadToolCalls() : loadErreursOutils());

  /** Entrée sur l'onglet, période, Actualiser : synthèse par outil et erreurs. */
  function loadToolCalls(frais = false): Promise<void> {
    return chargerOutils(true, frais);
  }

  /** Page, tri, filtre ou recherche : les erreurs seules, sans relancer la synthèse. */
  function loadErreursOutils(): Promise<void> {
    return chargerOutils(false);
  }

  function filtrerOutils(patch: Partial<FiltreOutils>): void {
    outilsFiltre.value = { ...outilsFiltre.value, ...patch };
    outilsPage.value = 1;
    void loadErreursOutils();
  }

  /** Recherche libre côté serveur, lancée 300 ms après la dernière frappe. */
  function rechercherOutils(q: string): void {
    outilsFiltre.value = { ...outilsFiltre.value, q };
    if (minuterieOutils !== null) clearTimeout(minuterieOutils);
    minuterieOutils = setTimeout(() => {
      minuterieOutils = null;
      outilsPage.value = 1;
      void loadErreursOutils();
    }, DELAI_RECHERCHE_MS);
  }

  function effacerFiltresOutils(): void {
    if (minuterieOutils !== null) clearTimeout(minuterieOutils);
    minuterieOutils = null;
    filtrerOutils({ statut: "", outil: "", serveur: "", q: "" });
  }

  function trierOutils(col: string): void {
    outilsTri.value = trierPar(outilsTri.value, col);
    outilsPage.value = 1;
    void loadErreursOutils();
  }

  function setOutilsPage(page: number): void {
    outilsPage.value = pageBornee(page, outilsTotal.value, outilsParPage);
    void loadErreursOutils();
  }

  return {
    obsScope,
    obsLoading,
    obsDerniereMaj,
    obsEchec,
    loadToolCalls,
    loadErreursOutils,
    rechargerPage,
    obsSummary,
    obsFailures,
    outilsFiltre,
    outilsTri,
    outilsPage,
    outilsParPage,
    outilsTotal,
    filtrerOutils,
    rechercherOutils,
    effacerFiltresOutils,
    trierOutils,
    setOutilsPage,
    setObsScope,
  };
}
