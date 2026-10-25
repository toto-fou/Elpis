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
  if (statut === 413) return "Données trop volumineuses : raccourcissez le prompt système.";
  if (statut >= 500) return "Erreur serveur : paramètres non enregistrés, réessayez.";
  const d = detailErreur(corps);
  return d && d.length < 120 ? d : "Paramètres non enregistrés : vérifiez les valeurs puis réessayez.";
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
  const { computed, ref, watch } = vue;
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

  const enVol = new Set<Promise<unknown>>();
  let minuterie: ReturnType<typeof setTimeout> | null = null;

  function suivre<T>(p: Promise<T>): Promise<T> {
    const q = p.finally(() => {
      enVol.delete(q);
    });
    enVol.add(q);
    return q;
  }

  /** Valeurs de l'instantané pour ces clés (copies), avant leur écriture. */
  function valeursInstantane(keys: readonly string[]): Record<string, unknown> {
    try {
      const s = objet(JSON.parse(snapshot.value || "{}"));
      const res: Record<string, unknown> = {};
      for (const k of keys) res[k] = clonerValeur(s[k]);
      return res;
    } catch {
      return {};
    }
  }

  function restaurer(keys: readonly string[], valeurs: Record<string, unknown>): void {
    const cible = settings.value as Record<string, unknown>;
    for (const k of keys) {
      const v = clonerValeur(valeurs[k]);
      if (v === undefined) delete cible[k];
      else cible[k] = v;
    }
  }

  /** Toast de confirmation dont « Annuler » rétablit les valeurs précédentes et les réécrit. */
  function toastAnnulable(message: string, keys: readonly string[], avant: Record<string, unknown>): void {
    const modifie = keys.some((k) => JSON.stringify(avant[k]) !== JSON.stringify(settings.value[k]));
    if (!modifie) {
      ctx.showToast(message);
      return;
    }
    ctx.showToast(message, "success", {
      duration: 6000,
      actionLabel: "Annuler",
      onAction: () => {
        const actuelles = valeursInstantane(keys);
        restaurer(keys, avant);
        void persistKeys(keys, { rollback: () => restaurer(keys, actuelles), silencieux: true });
      },
    });
  }

  /** Clés du document différentes de l'instantané. */
  function clesModifiees(): string[] {
    let avant: Record<string, unknown> = {};
    try {
      avant = objet(JSON.parse(snapshot.value || "{}"));
    } catch {
      return [];
    }
    const apres = settings.value as Record<string, unknown>;
    const toutes = new Set([...Object.keys(avant), ...Object.keys(apres)]);
    return [...toutes].filter((k) => JSON.stringify(avant[k]) !== JSON.stringify(apres[k]));
  }

  /** Enregistre sur-le-champ les clés modifiées depuis l'instantané (valeur rétablie si l'écriture échoue). */
  async function enregistrerModifications(): Promise<void> {
    await Promise.allSettled([...enVol]);
    const keys = clesModifiees();
    if (!keys.length || !snapshot.value) return;
    const avant = valeursInstantane(keys);
    await persistKeys(keys, { rollback: () => restaurer(keys, avant) });
  }

  /** Attend l'écriture en cours puis enregistre ce qui est encore en attente (fermeture de la fenêtre). */
  async function viderEnAttente(): Promise<void> {
    if (minuterie) clearTimeout(minuterie);
    minuterie = null;
    await enregistrerModifications();
  }

  /** Enregistre chaque réglage modifié après une courte pause de saisie, tant que `actif` est vrai. */
  function activerEnregistrementAuto(actif: Ref<boolean>, delaiMs = 800): void {
    watch(
      settings,
      () => {
        if (!actif.value || !snapshot.value) return;
        if (minuterie) clearTimeout(minuterie);
        minuterie = setTimeout(() => {
          minuterie = null;
          void enregistrerModifications();
        }, delaiMs);
      },
      { deep: true },
    );
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
  function persistKeys(keys: readonly string[], opts: OptionsPersistance = {}): Promise<boolean> {
    return suivre(ecrireCles(keys, opts));
  }

  async function ecrireCles(keys: readonly string[], opts: OptionsPersistance): Promise<boolean> {
    const avant = valeursInstantane(keys);
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
    if (!opts.silencieux) toastAnnulable(opts.okMsg ?? "Enregistré", keys, avant);
    return true;
  }

  /** Bascule qui doit tenir dès le clic : PUT des clés données puis instantané à jour ; `succes` fournit le toast, l'échec rétablit les valeurs. */
  function persistImmediat(
    corps: Record<string, unknown>,
    messages: { echec: string; reseau: string; succes?: string },
  ): Promise<void> {
    return suivre(ecrireImmediat(corps, messages));
  }

  async function ecrireImmediat(
    corps: Record<string, unknown>,
    messages: { echec: string; reseau: string; succes?: string },
  ): Promise<void> {
    const keys = Object.keys(corps);
    const avant = valeursInstantane(keys);
    const annuler = (): void => restaurer(keys, avant);
    try {
      const r = await ctx.fetchAuth("/api/settings", {
        method: "PUT",
        headers: ENTETES_JSON,
        body: JSON.stringify(corps),
      });
      if (!r || !r.ok) {
        annuler();
        ctx.showToast(messages.echec, "error");
        return;
      }
      majInstantane((s) => Object.assign(s, corps));
      toastAnnulable(messages.succes ?? "Enregistré", keys, avant);
    } catch {
      annuler();
      ctx.showToast(messages.reseau, "error");
    }
  }

  return {
    settingsSaving,
    passwordSaving,
    snapshot,
    settingsDirty,
    saveSettings,
    viderEnAttente,
    activerEnregistrementAuto,
    persistKeys,
    persistImmediat,
    majInstantane,
  };
}

export type Persistance = ReturnType<typeof creerPersistance>;
