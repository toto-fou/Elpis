// SPDX-License-Identifier: MIT
/** frontend/src/features/coffre/coffre.ts — Paramètres › Coffre : entrées d'identifiants du compte (origine exacte, identifiant, mot de passe en écriture seule). */
import type { EntreeCoffre } from "@elpis/contracts";
import { ref } from "vue";
import type { Ref } from "vue";

import type { ClientHttp } from "../../platform/http/client";
import { messageErreur } from "../../platform/http/resultat";
import { creerApiCoffre } from "./api";

export type { EntreeCoffre };

/** Le mot de passe n'est jamais prérempli : vide à la modification, il reste inchangé. */
export interface FormulaireCoffre {
  id?: number;
  nom: string;
  origin: string;
  username: string;
  password: string;
}

export interface CtxCoffre {
  showToast?(message: string, type?: string): void;
  openConfirm?(titre: string, message: string, danger: boolean, libelle: string): Promise<boolean>;
}

export function setupCoffre(ctx: CtxCoffre | null | undefined, http: ClientHttp) {
  const api = creerApiCoffre(http);
  const toast = (m: string, type?: string): void => ctx?.showToast?.(m, type);
  const coffreItems: Ref<EntreeCoffre[]> = ref([]);
  const coffreForm: Ref<FormulaireCoffre | null> = ref(null);
  const coffreBusy = ref(false);
  const coffreErreur = ref("");

  async function loadCoffre(): Promise<void> {
    const r = await api.lister();
    if (r.type === "ok") coffreItems.value = r.valeur.items;
  }

  function newCoffre(): void {
    coffreErreur.value = "";
    coffreForm.value = { nom: "", origin: "", username: "", password: "" };
  }

  function editCoffre(e: EntreeCoffre): void {
    coffreErreur.value = "";
    coffreForm.value = { id: e.id, nom: e.nom, origin: e.origin ?? "", username: e.username, password: "" };
  }

  function cancelCoffre(): void {
    coffreForm.value = null;
    coffreErreur.value = "";
  }

  async function saveCoffre(): Promise<void> {
    const f = coffreForm.value;
    if (!f) return;
    const nom = f.nom.trim();
    const origin = f.origin.trim();
    const username = f.username.trim();
    if (!nom || !origin || !username || (!f.id && !f.password)) {
      coffreErreur.value = "Nom, origine, identifiant et mot de passe requis.";
      return;
    }
    coffreBusy.value = true;
    coffreErreur.value = "";
    try {
      const r = f.id
        ? await api.modifier(f.id, { nom, origin, username, ...(f.password ? { password: f.password } : {}) })
        : await api.creer({ nom, origin, username, password: f.password });
      if (r.type === "ok") {
        f.password = "";
        coffreForm.value = null;
        await loadCoffre();
        toast(f.id ? "Entrée mise à jour" : "Entrée ajoutée", "success");
      } else {
        f.password = "";
        coffreErreur.value = messageErreur(r) || "Échec de l'enregistrement";
      }
    } finally {
      coffreBusy.value = false;
    }
  }

  async function confirmCoffre(e: EntreeCoffre): Promise<void> {
    const origin = e.origin ?? "";
    if (!origin) {
      editCoffre(e);
      toast("Indiquez l'origine exacte du site.", "info");
      return;
    }
    const r = await api.confirmer(e.id, origin);
    if (r.type === "ok") {
      await loadCoffre();
      toast("Origine confirmée", "success");
    } else toast(messageErreur(r) || "Échec de la confirmation", "error");
  }

  async function deleteCoffre(e: EntreeCoffre): Promise<void> {
    const ok = await ctx?.openConfirm?.(
      "Supprimer l'entrée ?",
      `${e.nom} · ${e.origin ?? "origine à confirmer"}`,
      true,
      "Supprimer",
    );
    if (!ok) return;
    const r = await api.supprimer(e.id);
    if (r.type === "ok") {
      await loadCoffre();
      toast("Entrée supprimée", "success");
    } else toast(messageErreur(r) || "Échec de la suppression", "error");
  }

  return {
    coffreItems,
    coffreForm,
    coffreBusy,
    coffreErreur,
    loadCoffre,
    newCoffre,
    editCoffre,
    cancelCoffre,
    saveCoffre,
    confirmCoffre,
    deleteCoffre,
  };
}
