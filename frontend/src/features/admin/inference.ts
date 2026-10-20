// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/inference.ts — console › Inférence : mode d'ordonnancement LLM, compression conversationnelle, connecteurs LLM partagés avec fournisseurs autorisés et sélecteur de moteur unique. */
import {
  schemaCompressionConfig,
  schemaReponseCapacitesLlm,
  schemaReponseConnecteursPartages,
  schemaReponseFournisseursAutorises,
  schemaReponseFournisseursEcrits,
  schemaReponseModeOrdonnancement,
  schemaReponseRapportMoteur,
  schemaReponseSondeCapacites,
  schemaReponseTestConnecteurLlm,
} from "@elpis/contracts";
import type { ConnecteurLlm, RapportMoteur, ReponseConnecteursPartages } from "@elpis/contracts";
import type { Ref } from "vue";

import { corpsJson, detailErreur, lireSchema } from "../../utils/lecture-json";
import type { BaseAdmin } from "./etat";
import { journal } from "../../platform/journal";
import { gardeFocus as creerGardeFocus, piegerTab } from "../../utils/focus";

const ENTETES_JSON = { "Content-Type": "application/json" };

export interface FormulaireConnecteurPartage {
  id?: number;
  provider_type: string;
  base_url: string;
  api_key: string;
  label: string;
  default_model: string;
  models_json: string;
  context_window: number | null;
  max_models: number | null;
  max_concurrency: number | null;
}

type ResultatTest = {
  testing?: boolean;
  ok?: boolean;
  error?: string;
  sonde?: RapportMoteur;
  [cle: string]: unknown;
};

export function creerInference(b: BaseAdmin) {
  const { vue, ctx, e, lien } = b;
  const { computed, ref } = vue;
  const { showToast, openConfirm, fetchAuth } = ctx;
  const { llmScheduling, compressionCfg, admLlmAllowed } = e;

  // ── Mode d'ordonnancement ────────────────────────────────────────────────
  const llmSchedulingProbing = ref(false);
  const llmSchedulingSaving = ref(false);

  async function loadLlmScheduling(): Promise<void> {
    try {
      const d = await lireSchema(await fetchAuth("/api/admin/llm-capabilities"), schemaReponseCapacitesLlm);
      if (d) {
        llmScheduling.value = d;
        lien.markAdminStoreClean("scheduling");
      }
    } catch (err) {
      journal.avertir("[admin] loadLlmScheduling failed", err);
    }
  }
  /** Re-déclenche le probe côté serveur (llama-server redémarré, `--slots` ajouté). */
  async function probeLlmCapabilities(): Promise<void> {
    if (llmSchedulingProbing.value) return;
    llmSchedulingProbing.value = true;
    try {
      const res = await fetchAuth("/api/admin/llm-capabilities/probe", { method: "POST" });
      const d = await lireSchema(res, schemaReponseSondeCapacites);
      if (d) {
        if (llmScheduling.value) llmScheduling.value.capabilities = d.capabilities || {};
        showToast("Capacités llama re-détectées", "success");
      } else {
        showToast("Erreur lors du probe", "error");
      }
      await loadLlmScheduling();
    } catch (err) {
      showToast("Erreur: " + (err instanceof Error ? err.message : String(err)), "error");
    } finally {
      llmSchedulingProbing.value = false;
    }
  }
  /** Le mode choisi est pris en compte à la requête suivante, sans redémarrage ; le bilan est affiché par la page. */
  async function saveLlmSchedulingMode(): Promise<boolean> {
    if (!llmScheduling.value || llmSchedulingSaving.value) return false;
    llmSchedulingSaving.value = true;
    try {
      const res = await fetchAuth("/api/admin/llm-scheduling-mode", {
        method: "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify({ mode: llmScheduling.value.configured_mode }),
      });
      const d = await lireSchema(res, schemaReponseModeOrdonnancement);
      if (d && llmScheduling.value) {
        llmScheduling.value.configured_mode = d.configured_mode;
        llmScheduling.value.effective_mode = d.effective_mode;
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      llmSchedulingSaving.value = false;
    }
  }

  // ── Moteur intégré : sonde du profil déclaré ─────────────────────────────
  const rapportMoteur: Ref<RapportMoteur | null> = ref(null);
  const rapportMoteurTest = ref(false);
  async function loadRapportMoteur(): Promise<void> {
    try {
      const d = await lireSchema(
        await fetchAuth("/api/admin/llm/engine", {}, true),
        schemaReponseRapportMoteur,
      );
      if (d) rapportMoteur.value = d.rapport;
    } catch (err) {
      journal.avertir("[admin] loadRapportMoteur failed", err);
    }
  }
  /** « Tester » : sonde complète (adresses, version, modèle, contexte, métriques, options manquantes). */
  async function testerMoteurIntegre(): Promise<void> {
    if (rapportMoteurTest.value) return;
    rapportMoteurTest.value = true;
    try {
      const d = await lireSchema(
        await fetchAuth("/api/admin/llm/engine/test", { method: "POST" }),
        schemaReponseRapportMoteur,
      );
      if (d) rapportMoteur.value = d.rapport;
      else showToast("Sonde du moteur impossible", "error");
    } catch (err) {
      showToast("Erreur: " + (err instanceof Error ? err.message : String(err)), "error");
    } finally {
      rapportMoteurTest.value = false;
    }
  }

  // ── Compression conversationnelle ────────────────────────────────────────
  const compressionSaving = ref(false);
  async function loadCompressionCfg(): Promise<void> {
    try {
      const d = await lireSchema(await fetchAuth("/api/admin/compression-config"), schemaCompressionConfig);
      if (d) {
        compressionCfg.value = d;
        lien.markAdminStoreClean("compression");
      }
    } catch (err) {
      journal.avertir("[admin] loadCompressionCfg failed", err);
    }
  }
  async function saveCompressionCfg(): Promise<boolean> {
    if (!compressionCfg.value || compressionSaving.value) return false;
    compressionSaving.value = true;
    try {
      const res = await fetchAuth("/api/admin/compression-config", {
        method: "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify(compressionCfg.value),
      });
      const d = await lireSchema(res, schemaCompressionConfig);
      if (d) {
        compressionCfg.value = d;
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      compressionSaving.value = false;
    }
  }

  // ── Connecteurs LLM partagés ─────────────────────────────────────────────
  const admLlmConnectors: Ref<ConnecteurLlm[]> = ref([]);
  const admLlmPresets: Ref<ReponseConnecteursPartages["presets"]> = ref({});
  const admLlmAllProviders: Ref<string[]> = ref([]);
  const admLlmCloudTypes: Ref<string[]> = ref([]);
  const admLlmForm: Ref<FormulaireConnecteurPartage | null> = ref(null);
  const admLlmBusy = ref(false);
  const admLlmTest: Ref<Record<string, ResultatTest>> = ref({});

  async function loadAdminLlmConnectors(): Promise<void> {
    try {
      const d = await lireSchema(
        await fetchAuth("/api/admin/llm/connectors", {}, true),
        schemaReponseConnecteursPartages,
      );
      if (d) {
        admLlmConnectors.value = d.connectors;
        admLlmPresets.value = d.presets;
        admLlmAllProviders.value = d.all_provider_types;
      }
      const a = await lireSchema(
        await fetchAuth("/api/admin/llm/allowed-providers", {}, true),
        schemaReponseFournisseursAutorises,
      );
      if (a) {
        admLlmAllowed.value = a.allowed;
        admLlmCloudTypes.value = a.cloud_provider_types;
        lien.markAdminStoreClean("allowed");
      }
    } catch {
      /* au mieux */
    }
  }
  const admLlmLabel = (pt: string): string => admLlmPresets.value[pt]?.label || pt;
  function newAdmLlmConnector(): void {
    admLlmForm.value = {
      provider_type: "vllm",
      base_url: "",
      api_key: "",
      label: "",
      default_model: "",
      models_json: "",
      context_window: null,
      max_models: null,
      max_concurrency: null,
    };
  }
  function editAdmLlmConnector(c: ConnecteurLlm): void {
    admLlmForm.value = {
      id: c.id,
      provider_type: c.provider_type,
      base_url: c.base_url || "",
      api_key: "",
      label: c.label || "",
      default_model: c.default_model || "",
      models_json: c.models_json || "",
      context_window: c.context_window || null,
      max_models: c.max_models || null,
      max_concurrency: c.max_concurrency || null,
    };
  }

  // ── Sélecteur de moteur unique ───────────────────────────────────────────
  const engineSel = e.engineSel;
  const engineConnector = computed(
    () => admLlmConnectors.value.find((c) => String(c.id) === String(engineSel.value)) ?? null,
  );
  const engineDrawer: Ref<HTMLElement | null> = ref(null);
  const gardeFocus = creerGardeFocus();

  function onEngineSelect(): void {
    const v = engineSel.value;
    if (v === "__local__") {
      closeEngineDrawer();
      return;
    }
    if (!admLlmForm.value) gardeFocus.remember();
    if (v === "__new__") newAdmLlmConnector();
    else {
      const c = admLlmConnectors.value.find((x) => String(x.id) === String(v));
      if (c) editAdmLlmConnector(c);
      else {
        closeEngineDrawer();
        return;
      }
    }
    void ctx.nextTick().then(() => {
      const el = engineDrawer.value;
      const premier = el?.querySelector<HTMLElement>("select, input, textarea");
      (premier ?? el)?.focus();
    });
  }
  function closeEngineDrawer(): void {
    const etaitOuvert = !!admLlmForm.value;
    engineSel.value = "__local__";
    admLlmForm.value = null;
    if (etaitOuvert) gardeFocus.restore();
  }
  function onEngineDrawerKey(ev: KeyboardEvent): void {
    piegerTab(ev, engineDrawer.value);
  }

  async function saveAdmLlmConnector(): Promise<void> {
    const f = admLlmForm.value;
    if (!f) return;
    admLlmBusy.value = true;
    try {
      const edition = !!f.id;
      const url = edition ? "/api/admin/llm/connectors/" + f.id : "/api/admin/llm/connectors";
      const corps: Record<string, unknown> = {
        base_url: (f.base_url || "").trim(),
        label: (f.label || "").trim(),
        default_model: (f.default_model || "").trim(),
        models_json: (f.models_json || "").trim(),
      };
      if (!edition) corps["provider_type"] = f.provider_type;
      if ((f.api_key || "").trim()) corps["api_key"] = f.api_key.trim();
      // Capacité d'un serveur llama.cpp : vide = découverte (null côté serveur).
      if (f.provider_type === "llamacpp") {
        for (const k of ["context_window", "max_models", "max_concurrency"] as const) {
          const v = f[k];
          corps[k] = typeof v === "number" && v > 0 ? Math.round(v) : null;
        }
      }
      const r = await fetchAuth(url, {
        method: edition ? "PUT" : "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify(corps),
      });
      if (r?.ok) {
        await loadAdminLlmConnectors();
        closeEngineDrawer();
        showToast(edition ? "Connecteur mis à jour" : "Connecteur ajouté", "success");
      } else {
        showToast(detailErreur(await corpsJson(r)) || "Échec", "error");
      }
    } finally {
      admLlmBusy.value = false;
    }
  }
  async function deleteAdmLlmConnector(c: ConnecteurLlm): Promise<void> {
    const ok = await openConfirm(
      "Supprimer le connecteur partagé ?",
      admLlmLabel(c.provider_type) + (c.label ? " · " + c.label : ""),
      true,
    );
    if (!ok) return;
    const r = await fetchAuth("/api/admin/llm/connectors/" + c.id, { method: "DELETE" });
    if (r?.ok) {
      closeEngineDrawer();
      await loadAdminLlmConnectors();
      showToast("Supprimé", "success");
    }
  }
  async function testAdmLlmConnector(c: ConnecteurLlm): Promise<void> {
    admLlmTest.value = { ...admLlmTest.value, [c.id]: { testing: true } };
    try {
      const r = await fetchAuth("/api/admin/llm/connectors/" + c.id + "/test?sonde=1", { method: "POST" });
      const brut: unknown = r ? await r.json().catch(() => ({ ok: false })) : { ok: false };
      const lu = schemaReponseTestConnecteurLlm.safeParse(brut);
      const d: ResultatTest = lu.success
        ? { ...lu.data }
        : { ok: false, error: detailErreur(brut) || "Réponse illisible" };
      admLlmTest.value = { ...admLlmTest.value, [c.id]: d };
    } catch (err) {
      admLlmTest.value = { ...admLlmTest.value, [c.id]: { ok: false, error: String(err) } };
    }
  }
  function toggleAdmAllowed(pt: string): void {
    const cur = admLlmAllowed.value.slice();
    const i = cur.indexOf(pt);
    if (i >= 0) cur.splice(i, 1);
    else cur.push(pt);
    admLlmAllowed.value = cur;
  }
  async function saveAdmAllowed(): Promise<boolean> {
    try {
      const r = await fetchAuth("/api/admin/llm/allowed-providers", {
        method: "PUT",
        headers: ENTETES_JSON,
        body: JSON.stringify({ allowed: admLlmAllowed.value }),
      });
      const d = await lireSchema(r, schemaReponseFournisseursEcrits);
      if (d) {
        admLlmAllowed.value = d.allowed;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  return {
    rapportMoteur,
    rapportMoteurTest,
    loadRapportMoteur,
    testerMoteurIntegre,
    llmScheduling,
    llmSchedulingProbing,
    llmSchedulingSaving,
    loadLlmScheduling,
    probeLlmCapabilities,
    saveLlmSchedulingMode,
    compressionCfg,
    compressionSaving,
    loadCompressionCfg,
    saveCompressionCfg,
    admLlmConnectors,
    admLlmPresets,
    admLlmAllProviders,
    admLlmCloudTypes,
    admLlmAllowed,
    admLlmForm,
    admLlmBusy,
    admLlmTest,
    admLlmLabel,
    loadAdminLlmConnectors,
    newAdmLlmConnector,
    editAdmLlmConnector,
    saveAdmLlmConnector,
    deleteAdmLlmConnector,
    testAdmLlmConnector,
    toggleAdmAllowed,
    saveAdmAllowed,
    engineSel,
    engineConnector,
    onEngineSelect,
    engineDrawer,
    closeEngineDrawer,
    onEngineDrawerKey,
  };
}
