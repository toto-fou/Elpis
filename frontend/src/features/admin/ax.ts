// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/ax.ts — mémoire AX (sites parcourus par le navigateur de l'assistant) : liste, arbre ASCII, suppressions et marquage « périmé », unitaires ou groupés. */
import type { Ref } from "vue";

import { corpsJson, listeObjets, nombre, objet, texte } from "../../utils/lecture-json";
import type { BaseAdmin } from "./etat";

export interface SiteAx {
  site: string;
  [cle: string]: unknown;
}

const ENTETES_JSON = { "Content-Type": "application/json" };

export function creerAx(b: BaseAdmin) {
  const { vue, ctx } = b;
  const { ref } = vue;
  const { showToast, openConfirm, fetchAuth } = ctx;
  const confirmerSaisie = (titre: string, message: string, mot: string, libelle: string): Promise<boolean> =>
    ctx.openTypedConfirm
      ? ctx.openTypedConfirm(titre, message, mot, libelle)
      : openConfirm(titre, message, true, libelle);
  const axSites: Ref<SiteAx[]> = ref([]);
  const axSelected: Ref<string[]> = ref([]);
  const axExpanded: Ref<Record<string, boolean>> = ref({});
  const axTrees: Ref<Record<string, string>> = ref({});
  const axTreeLoading: Ref<Record<string, boolean>> = ref({});
  const axLoading = ref(false);
  const showAxModal = ref(false);
  const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  async function loadAxSites(): Promise<void> {
    axLoading.value = true;
    try {
      const res = await fetchAuth("/api/ax/sites");
      if (!res || !res.ok) {
        showToast("Erreur chargement AX sites", "error");
        return;
      }
      axSites.value = listeObjets(objet(await corpsJson(res))["sites"]) as SiteAx[];
      axSelected.value = [];
    } catch (err) {
      showToast("Erreur AX: " + message(err), "error");
    } finally {
      axLoading.value = false;
    }
  }
  async function openAxModal(): Promise<void> {
    showAxModal.value = true;
    await loadAxSites();
  }

  async function toggleAxSite(site: string): Promise<void> {
    if (axExpanded.value[site]) {
      axExpanded.value = { ...axExpanded.value, [site]: false };
      return;
    }
    axExpanded.value = { ...axExpanded.value, [site]: true };
    if (!axTrees.value[site]) {
      axTreeLoading.value = { ...axTreeLoading.value, [site]: true };
      try {
        const res = await fetchAuth("/api/ax/sites/" + encodeURIComponent(site) + "/tree-ascii");
        if (res?.ok) {
          const data = objet(await corpsJson(res));
          axTrees.value = { ...axTrees.value, [site]: texte(data["ascii"]) || "(vide)" };
        } else {
          showToast("Erreur chargement arbre " + site, "error");
        }
      } catch (err) {
        showToast("Erreur: " + message(err), "error");
      } finally {
        axTreeLoading.value = { ...axTreeLoading.value, [site]: false };
      }
    }
  }
  function toggleSelectAllAx(ev: Event): void {
    const coche = ev.target instanceof HTMLInputElement && ev.target.checked;
    axSelected.value = coche ? axSites.value.map((s) => s.site) : [];
  }

  async function deleteSite(site: string, avecIdentifiants?: boolean): Promise<void> {
    const msg = avecIdentifiants
      ? 'Supprimer le site "' + site + '" ET ses credentials ? Action irreversible.'
      : 'Supprimer le site "' + site + '" (garde les credentials) ?';
    const ok = await openConfirm(msg, "", false, "Supprimer");
    if (!ok) return;
    try {
      const url =
        "/api/ax/sites/" + encodeURIComponent(site) + (avecIdentifiants ? "?include_credentials=true" : "");
      const res = await fetchAuth(url, { method: "DELETE" });
      if (res?.ok) {
        const d = objet(objet(await corpsJson(res))["deleted"]);
        showToast(
          "Site supprime : " + nombre(d["nodes"]) + " noeuds, " + nombre(d["transitions"]) + " transitions",
          "success",
        );
        const arbres = { ...axTrees.value };
        delete arbres[site];
        axTrees.value = arbres;
        const deplies = { ...axExpanded.value };
        delete deplies[site];
        axExpanded.value = deplies;
        await loadAxSites();
      } else showToast("Erreur suppression", "error");
    } catch (err) {
      showToast("Erreur: " + message(err), "error");
    }
  }
  async function deleteCreds(site: string): Promise<void> {
    const ok = await openConfirm('Supprimer les credentials de "' + site + '" ?', "", false, "Supprimer");
    if (!ok) return;
    try {
      const res = await fetchAuth("/api/ax/sites/" + encodeURIComponent(site) + "/credentials", {
        method: "DELETE",
      });
      if (res?.ok) {
        showToast("Credentials supprimes", "success");
        await loadAxSites();
      } else showToast("Erreur", "error");
    } catch (err) {
      showToast("Erreur: " + message(err), "error");
    }
  }
  async function markStale(site: string): Promise<void> {
    try {
      const res = await fetchAuth("/api/ax/sites/" + encodeURIComponent(site) + "/mark-stale", {
        method: "POST",
      });
      if (res?.ok) {
        const data = objet(await corpsJson(res));
        showToast(nombre(data["marked"]) + " elements marques stale sur " + site, "success");
        const arbres = { ...axTrees.value };
        delete arbres[site];
        axTrees.value = arbres;
        if (axExpanded.value[site]) {
          await toggleAxSite(site);
          await toggleAxSite(site);
        }
      } else showToast("Erreur mark stale", "error");
    } catch (err) {
      showToast("Erreur: " + message(err), "error");
    }
  }
  async function bulkDelete(avecIdentifiants?: boolean): Promise<void> {
    if (axSelected.value.length === 0) return;
    const msg =
      "Supprimer " +
      axSelected.value.length +
      " site(s) ?" +
      (avecIdentifiants ? " Les credentials seront aussi supprimes." : "");
    const ok = await openConfirm(msg, "", false, "Supprimer");
    if (!ok) return;
    try {
      const res = await fetchAuth("/api/ax/bulk-delete", {
        method: "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify({ sites: axSelected.value, include_credentials: avecIdentifiants }),
      });
      if (res?.ok) {
        const d = objet(objet(await corpsJson(res))["deleted"]);
        showToast(
          "Supprime : " + nombre(d["sites_processed"]) + " sites, " + nombre(d["nodes"]) + " noeuds",
          "success",
        );
        axTrees.value = {};
        axExpanded.value = {};
        await loadAxSites();
      } else showToast("Erreur bulk delete", "error");
    } catch (err) {
      showToast("Erreur: " + message(err), "error");
    }
  }
  async function bulkMarkStale(): Promise<void> {
    if (axSelected.value.length === 0) return;
    const ok = await openConfirm(
      "Marquer " + axSelected.value.length + " site(s) comme stale ?",
      "",
      false,
      "Confirmer",
    );
    if (!ok) return;
    try {
      const res = await fetchAuth("/api/ax/bulk-mark-stale", {
        method: "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify({ sites: axSelected.value, include_credentials: false }),
      });
      if (res?.ok) {
        showToast(nombre(objet(await corpsJson(res))["marked"]) + " elements marques stale", "success");
        axTrees.value = {};
        await loadAxSites();
      } else showToast("Erreur bulk mark stale", "error");
    } catch (err) {
      showToast("Erreur: " + message(err), "error");
    }
  }
  async function confirmWipeAll(): Promise<void> {
    const ok = await confirmerSaisie(
      "Effacer toute la mémoire AX",
      "Tous les sites et tous les identifiants enregistrés. Sans retour arrière.",
      "EFFACER",
      "Effacer",
    );
    if (!ok) return;
    try {
      const res = await fetchAuth("/api/ax/all?confirm=WIPE", { method: "DELETE" });
      if (res?.ok) {
        const d = objet(objet(await corpsJson(res))["deleted"]);
        showToast(
          "Mémoire AX effacée : " +
            nombre(d["nodes"]) +
            " nœuds, " +
            nombre(d["credentials"]) +
            " identifiants",
          "success",
        );
        axTrees.value = {};
        axExpanded.value = {};
        axSelected.value = [];
        await loadAxSites();
      } else showToast("Effacement refusé", "error");
    } catch (err) {
      showToast("Erreur: " + message(err), "error");
    }
  }

  return {
    axSites,
    axSelected,
    axExpanded,
    axTrees,
    axTreeLoading,
    axLoading,
    showAxModal,
    openAxModal,
    loadAxSites,
    toggleAxSite,
    toggleSelectAllAx,
    deleteSite,
    deleteCreds,
    markStale,
    bulkDelete,
    bulkMarkStale,
    confirmWipeAll,
  };
}
