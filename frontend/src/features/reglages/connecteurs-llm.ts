// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/connecteurs-llm.ts — Paramètres › Connecteurs LLM : fournisseurs cloud du compte (`/api/llm/connectors*`), clé écrite seulement. */
import {
  schemaOk,
  schemaReponseConnecteurCree,
  schemaReponseConnecteursLlm,
  schemaReponseTestConnecteurLlm,
} from "@elpis/contracts";
import type { ConnecteurLlm, ReponseConnecteursLlm } from "@elpis/contracts";
import { ref } from "vue";
import type { Ref } from "vue";

import type { ClientHttp } from "../../platform/http/client";
import { valeurOuNull } from "../../platform/http/resultat";
import type { ApiResult } from "../../platform/http/resultat";

type Connecteur = ReponseConnecteursLlm["connectors"][number] | ConnecteurLlm;
type Presets = ReponseConnecteursLlm["presets"];

export interface FormulaireConnecteurLlm {
  id?: number;
  provider_type: string;
  api_key: string;
  label: string;
  default_model: string;
}

export interface ResultatTestLlm {
  testing?: boolean;
  ok?: boolean;
  models_count?: number;
  error?: string;
  hint?: string;
}

export interface CtxConnecteursLlm {
  showToast?(message: string, type?: string): void;
  openConfirm?(titre: string, message: string, danger: boolean): Promise<boolean>;
}

function detail(r: ApiResult<unknown>): string | undefined {
  if (r.type === "requete" || r.type === "refus" || r.type === "serveur" || r.type === "conflit") {
    return r.erreur.detail ?? undefined;
  }
  return undefined;
}

export function setupLlmConnecteurs(ctx: CtxConnecteursLlm | null | undefined, http: ClientHttp) {
  const toast = (m: string, type?: string): void => ctx?.showToast?.(m, type);
  const llmConnectors: Ref<Connecteur[]> = ref([]);
  const llmConnShared: Ref<ConnecteurLlm[]> = ref([]);
  const llmConnPresets: Ref<Presets> = ref({});
  const llmConnAllowed: Ref<string[]> = ref([]);
  const llmConnForm: Ref<FormulaireConnecteurLlm | null> = ref(null);
  const llmConnBusy = ref(false);
  const llmConnTest: Ref<Record<string, ResultatTestLlm>> = ref({});
  const poserTest = (id: number, res: ResultatTestLlm): void => {
    llmConnTest.value = { ...llmConnTest.value, [id]: res };
  };

  async function loadLlmConnectors(): Promise<void> {
    const d = valeurOuNull(
      await http.requete("/api/llm/connectors", {}, { schema: schemaReponseConnecteursLlm }),
    );
    if (!d) return;
    llmConnectors.value = d.connectors;
    llmConnShared.value = d.shared;
    llmConnPresets.value = d.presets;
    llmConnAllowed.value = d.allowed_provider_types;
  }

  const llmPresetLabel = (pt: string): string => llmConnPresets.value[pt]?.label || pt;

  function newLlmConnector(): void {
    const first = llmConnAllowed.value[0] || "anthropic";
    llmConnForm.value = { provider_type: first, api_key: "", label: "", default_model: "" };
  }

  function editLlmConnector(c: Connecteur): void {
    llmConnForm.value = {
      id: c.id,
      provider_type: c.provider_type,
      api_key: "",
      label: c.label || "",
      default_model: c.default_model || "",
    };
  }

  const cancelLlmConnector = (): void => {
    llmConnForm.value = null;
  };

  async function saveLlmConnector(): Promise<void> {
    const f = llmConnForm.value;
    if (!f) return;
    if (!f.id && !(f.api_key || "").trim()) {
      toast("Clé API requise", "error");
      return;
    }
    llmConnBusy.value = true;
    try {
      const edition = !!f.id;
      const corps: Record<string, string> = {
        label: (f.label || "").trim(),
        default_model: (f.default_model || "").trim(),
      };
      if (!edition) corps.provider_type = f.provider_type;
      if ((f.api_key || "").trim()) corps.api_key = f.api_key.trim();
      const init: RequestInit = {
        method: edition ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corps),
      };
      const r = edition
        ? await http.requete(`/api/llm/connectors/${f.id}`, init, { schema: schemaOk })
        : await http.requete("/api/llm/connectors", init, { schema: schemaReponseConnecteurCree });
      if (r.type === "ok") {
        llmConnForm.value = null;
        await loadLlmConnectors();
        toast(edition ? "Connecteur mis à jour" : "Connecteur ajouté", "success");
      } else {
        toast(detail(r) || "Échec de l'enregistrement", "error");
      }
    } finally {
      llmConnBusy.value = false;
    }
  }

  async function deleteLlmConnector(c: Connecteur): Promise<void> {
    const ok = await ctx?.openConfirm?.(
      "Supprimer le connecteur ?",
      llmPresetLabel(c.provider_type) + (c.label ? " · " + c.label : ""),
      true,
    );
    if (!ok) return;
    const r = await http.requete(`/api/llm/connectors/${c.id}`, { method: "DELETE" });
    if (r.type === "ok") {
      await loadLlmConnectors();
      toast("Connecteur supprimé", "success");
    }
  }

  async function testLlmConnector(c: Connecteur): Promise<void> {
    poserTest(c.id, { testing: true });
    const r = await http.requete(
      `/api/llm/connectors/${c.id}/test`,
      { method: "POST" },
      { schema: schemaReponseTestConnecteurLlm },
    );
    if (r.type === "ok") poserTest(c.id, r.valeur);
    else if (r.type === "invalide") poserTest(c.id, { ok: false, error: "parse" });
    else poserTest(c.id, { ok: false, error: detail(r) ?? "network" });
  }

  return {
    llmConnectors,
    llmConnShared,
    llmConnPresets,
    llmConnAllowed,
    llmConnForm,
    llmConnBusy,
    llmConnTest,
    llmPresetLabel,
    loadLlmConnectors,
    newLlmConnector,
    editLlmConnector,
    cancelLlmConnector,
    saveLlmConnector,
    deleteLlmConnector,
    testLlmConnector,
  };
}
