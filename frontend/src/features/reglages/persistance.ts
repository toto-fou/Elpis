// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/persistance.ts — persistance du document `settings` : instantané « non enregistré », enregistrement automatique, écriture ciblée par clés et bascules immédiates. */
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

/** Clés dont la valeur diffère entre deux états du document. */
export function clesDifferentes(avant: Record<string, unknown>, apres: Record<string, unknown>): string[] {
  const toutes = new Set([...Object.keys(avant), ...Object.keys(apres)]);
  return [...toutes].filter((k) => JSON.stringify(avant[k]) !== JSON.stringify(apres[k]));
}

export function creerPersistance(vue: VueReglages, settings: Ref<ReglagesApp>, ctx: CtxReglages) {
  const { computed, ref, watch } = vue;
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

  /** Rétablit ces clés à leurs valeurs `avant` et les réécrit (valeurs actuelles reprises si l'écriture échoue). */
  function annulerVers(keys: readonly string[], avant: Record<string, unknown>): void {
    const actuelles = valeursInstantane(keys);
    restaurer(keys, avant);
    void persistKeys(keys, { rollback: () => restaurer(keys, actuelles), silencieux: true });
  }

  const modifie = (keys: readonly string[], avant: Record<string, unknown>): boolean =>
    keys.some((k) => JSON.stringify(avant[k]) !== JSON.stringify(settings.value[k]));

  /** Toast de confirmation dont « Annuler » rétablit les valeurs précédentes et les réécrit. */
  function toastAnnulable(message: string, keys: readonly string[], avant: Record<string, unknown>): void {
    if (!modifie(keys, avant)) {
      ctx.showToast(message);
      return;
    }
    ctx.showToast(message, "success", {
      duration: 6000,
      actionLabel: "Annuler",
      onAction: () => annulerVers(keys, avant),
    });
  }

  // Valeurs d'avant la rafale d'enregistrements automatiques, tant que son toast est affiché.
  let rafale: Record<string, unknown> | null = null;

  /** Un seul toast pour la rafale, mis à jour à chaque écriture ; « Annuler » ramène chaque clé à sa valeur d'avant la rafale. */
  function toastRafale(keys: readonly string[], avant: Record<string, unknown>): void {
    const r = (rafale ??= {});
    for (const k of keys) if (!(k in r)) r[k] = avant[k];
    const cles = Object.keys(r);
    const annulable = modifie(cles, r);
    ctx.showToast("Enregistré", "success", {
      cle: "reglages-rafale",
      duration: 6000,
      actionLabel: annulable ? "Annuler" : undefined,
      onAction: annulable
        ? () => {
            rafale = null;
            annulerVers(cles, r);
          }
        : undefined,
      onExpire: () => {
        rafale = null;
      },
    });
  }

  /** Clés du document différentes de l'instantané. */
  function clesModifiees(): string[] {
    try {
      return clesDifferentes(objet(JSON.parse(snapshot.value || "{}")), settings.value);
    } catch {
      return [];
    }
  }

  /** Enregistre sur-le-champ les clés modifiées depuis l'instantané (valeur rétablie si l'écriture échoue). */
  async function enregistrerModifications(): Promise<void> {
    await Promise.allSettled([...enVol]);
    const keys = clesModifiees();
    if (!keys.length || !snapshot.value) return;
    const avant = valeursInstantane(keys);
    if (await persistKeys(keys, { rollback: () => restaurer(keys, avant), silencieux: true }))
      toastRafale(keys, avant);
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
    passwordSaving,
    snapshot,
    settingsDirty,
    viderEnAttente,
    activerEnregistrementAuto,
    persistKeys,
    persistImmediat,
    majInstantane,
  };
}

export type Persistance = ReturnType<typeof creerPersistance>;
