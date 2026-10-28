// SPDX-License-Identifier: MIT
/** frontend/src/app/racine/approbations.ts — accords humains des gestes sensibles d'une procédure : demandes de la conversation, boutons Approuver / Refuser, puis message automatique « Approuvé : … » qui relance le modèle. */
import type { DemandeApprobation } from "@elpis/contracts";
import { onScopeDispose, ref, watch } from "vue";
import type { Ref, ShallowUnwrapRef } from "vue";

import { creerApiAccords } from "../../features/procedures/api";
import type { DecisionAccord } from "../../features/procedures/api";
import type { ClientHttp } from "../../platform/http/client";
import { messageErreur } from "../../platform/http/resultat";

const SONDE_MS = 2500;
const RAFRAICHIR_MS = 20_000;

export interface DependancesApprobations {
  readonly http: ClientHttp;
  readonly currentChatId: Ref<string | null>;
  readonly isStreaming: Ref<boolean>;
  readonly inputMessage: Ref<string>;
  /** Envoie le contenu du brouillon comme message (envoi ordinaire du composeur). */
  envoyer(): Promise<void>;
  showToast(message: string, type?: string): void;
}

/** Geste en une ligne, sans emoji : « click « Payer » », « goto https://… ». */
export function resume(d: DemandeApprobation): string {
  const g = d.gesture;
  const cible = g.act === "goto" ? g.url : (g.targets[0] ?? "");
  return [g.act, cible, g.value && g.act !== "goto" ? `« ${g.value} »` : ""]
    .filter(Boolean)
    .join(" ")
    .slice(0, 160);
}

/** Message automatique envoyé après le clic : le modèle n'agit qu'à sa réception. */
export function messageDecision(d: DemandeApprobation, decision: DecisionAccord): string {
  return decision === "approve"
    ? `Approuvé : ${resume(d)} (procédure ${d.procedure_id}, accord ${d.id}). Vous pouvez continuer.`
    : `Refusé : ${resume(d)} (procédure ${d.procedure_id}, accord ${d.id}). Ne rejouez pas ce geste.`;
}

export function creerApprobations(dep: DependancesApprobations) {
  const api = creerApiAccords(dep.http);
  const accords = ref<DemandeApprobation[]>([]);
  const accordsOccupe = ref<string | null>(null);
  const accordsMaintenant = ref(Date.now() / 1000);
  let sonde: ReturnType<typeof setInterval> | null = null;
  let version = 0;

  async function rafraichir(): Promise<void> {
    const chat = dep.currentChatId.value;
    const v = ++version;
    if (!chat) {
      accords.value = [];
      return;
    }
    const r = await api.enAttente(chat);
    // Une réponse d'une conversation quittée ou dépassée n'écrase rien.
    if (r.type === "ok" && v === version && dep.currentChatId.value === chat) accords.value = r.valeur.items;
  }

  function arreter(): void {
    if (sonde !== null) clearInterval(sonde);
    sonde = null;
  }

  // Pendant une génération la demande peut surgir à tout instant ; hors génération, un rafraîchissement lent suffit.
  function armer(): void {
    arreter();
    sonde = setInterval(
      () => {
        accordsMaintenant.value = Date.now() / 1000;
        // Onglet caché : rien à montrer, la prochaine visite relit.
        if (!document.hidden) void rafraichir();
      },
      dep.isStreaming.value ? SONDE_MS : RAFRAICHIR_MS,
    );
  }
  watch(dep.isStreaming, (en, avant) => {
    armer();
    if (avant && !en) void rafraichir();
  });
  watch(dep.currentChatId, () => void rafraichir(), { immediate: true });
  armer();
  const auRetour = (): void => {
    if (!document.hidden) void rafraichir();
  };
  document.addEventListener("visibilitychange", auRetour);
  onScopeDispose(() => {
    arreter();
    document.removeEventListener("visibilitychange", auRetour);
  });

  async function envoyerAuto(texte: string): Promise<void> {
    if (dep.isStreaming.value)
      await new Promise<void>((fin) => {
        const arret = watch(dep.isStreaming, (en) => {
          if (en) return;
          arret();
          fin();
        });
      });
    const brouillon = dep.inputMessage.value;
    dep.inputMessage.value = texte;
    try {
      await dep.envoyer();
    } finally {
      // Le brouillon de l'utilisateur est rendu s'il n'a pas été consommé par l'envoi.
      if (dep.inputMessage.value === texte || dep.inputMessage.value === "")
        dep.inputMessage.value = brouillon;
    }
  }

  async function decider(d: DemandeApprobation, decision: DecisionAccord): Promise<void> {
    if (accordsOccupe.value !== null) return;
    accordsOccupe.value = d.id;
    try {
      const r = await api.decider(d.id, decision);
      if (r.type !== "ok") {
        dep.showToast(messageErreur(r) || "Décision non enregistrée", "error");
        await rafraichir();
        return;
      }
      accords.value = accords.value.filter((x) => x.id !== d.id);
      await envoyerAuto(messageDecision(d, decision));
    } finally {
      accordsOccupe.value = null;
    }
  }

  function accordRestant(d: DemandeApprobation): string {
    const s = Math.floor(d.expires_at - accordsMaintenant.value);
    if (s <= 0) return "expiré";
    return s >= 90 ? `${Math.ceil(s / 60)} min` : `${s} s`;
  }

  return { accords, accordsOccupe, decider, accordRestant, rafraichirAccords: rafraichir };
}

export type SurfaceApprobations = ShallowUnwrapRef<ReturnType<typeof creerApprobations>>;
