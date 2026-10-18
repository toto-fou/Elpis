// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/persistance.ts — persistance du document `settings` : instantané « non enregistré », enregistrement complet, écriture ciblée par clés et bascules immédiates. */
import type { Ref } from "vue";

import { corpsJson, detailErreur, objet } from "../../utils/lecture-json";
import { clonerValeur } from "./types";
import type { CtxReglages, OptionsPersistance, ReglagesApp, VueReglages } from "./types";

const ENTETES_JSON = { "Content-Type": "application/json" };

/** Message d'interface d'un enregistrement refusé selon le statut HTTP. */
export function messageErreurReglages(statut: number, corps: unknown): string {
  if (statut === 401 || statut === 403) return "Session expirée : reconnectez-vous puis réessayez.";
  if (statut === 413) return "Données trop volumineuses : raccourcis le prompt système.";
  if (statut >= 500) return "Erreur serveur : paramètres non enregistrés, réessaie.";
  const d = detailErreur(corps);
  return d && d.length < 120 ? d : "Paramètres non enregistrés : vérifie les valeurs puis réessaie.";
}

export interface LiensPersistance {
  closeSettings(sauterRecharge?: boolean): Promise<void> | void;
}

export function creerPersistance(
  vue: VueReglages,
  settings: Ref<ReglagesApp>,
  ctx: CtxReglages,
  liens: LiensPersistance,
) {
  const { computed, ref } = vue;
  const settingsSaving = ref(false);
  const passwordSaving = ref(false);
  const snapshot = ref("");
  const settingsDirty = computed(() => !!snapshot.value && JSON.stringify(settings.value) !== snapshot.value);

  /** Instantané relu, modifié par `maj`, puis réécrit (au mieux : un instantané illisible est laissé tel quel). */
  function majInstantane(maj: (s: Record<string, unknown>) => void): void {
    try {
      const s = objet(JSON.parse(snapshot.value || "{}"));
      maj(s);
      snapshot.value = JSON.stringify(s);
    } catch {
      /* instantané best-effort */
    }
  }

  async function saveSettings(closeModal = true): Promise<void> {
    if (closeModal && settingsSaving.value) return;
    if (closeModal) settingsSaving.value = true;
    try {
      const corpsEnvoye = JSON.stringify(settings.value);
      const res = await ctx.fetchAuth("/api/settings", {
        method: "PUT",
        headers: ENTETES_JSON,
        body: corpsEnvoye,
      });
      if (!res) {
        ctx.showToast("Erreur réseau : paramètres non enregistrés.", "error");
        return;
      }
      if (!res.ok) {
        ctx.showToast(messageErreurReglages(res.status, await corpsJson(res)), "error");
        return;
      }
      snapshot.value = corpsEnvoye;
      if (closeModal) {
        ctx.showToast("Paramètres enregistrés.");
        void liens.closeSettings(true);
      }
    } catch {
      ctx.showToast("Erreur réseau : paramètres non enregistrés.", "error");
    } finally {
      if (closeModal) settingsSaving.value = false;
    }
  }

  /** Écrit seulement les clés données (le serveur fusionne) ; `rollback` est rejoué si le PUT échoue. */
  async function persistKeys(keys: readonly string[], opts: OptionsPersistance = {}): Promise<boolean> {
    const corps: Record<string, unknown> = {};
    for (const k of keys) corps[k] = settings.value[k];
    let ok = false;
    try {
      const r = await ctx.fetchAuth("/api/settings", {
        method: "PUT",
        headers: ENTETES_JSON,
        body: JSON.stringify(corps),
      });
      ok = !!r && r.ok;
      if (!r) ctx.showToast("Erreur réseau : modification non enregistrée.", "error");
      else if (!ok) ctx.showToast(messageErreurReglages(r.status, await corpsJson(r)), "error");
    } catch {
      ctx.showToast("Erreur réseau : modification non enregistrée.", "error");
    }
    if (!ok) {
      try {
        opts.rollback?.();
      } catch {
        /* rejouer au mieux */
      }
      return false;
    }
    majInstantane((s) => {
      for (const k of keys) {
        const v = clonerValeur(settings.value[k]);
        if (v === undefined) delete s[k];
        else s[k] = v;
      }
    });
    if (opts.okMsg) ctx.showToast(opts.okMsg);
    return true;
  }

  /** Bascule qui doit tenir dès le clic : PUT des clés données puis instantané à jour ; `succes` fournit le toast. */
  async function persistImmediat(
    corps: Record<string, unknown>,
    messages: { echec: string; reseau: string; succes?: string },
  ): Promise<void> {
    try {
      const r = await ctx.fetchAuth("/api/settings", {
        method: "PUT",
        headers: ENTETES_JSON,
        body: JSON.stringify(corps),
      });
      if (!r || !r.ok) {
        ctx.showToast(messages.echec, "error");
        return;
      }
      majInstantane((s) => Object.assign(s, corps));
      if (messages.succes) ctx.showToast(messages.succes);
    } catch {
      ctx.showToast(messages.reseau, "error");
    }
  }

  return {
    settingsSaving,
    passwordSaving,
    snapshot,
    settingsDirty,
    saveSettings,
    persistKeys,
    persistImmediat,
    majInstantane,
  };
}

export type Persistance = ReturnType<typeof creerPersistance>;
