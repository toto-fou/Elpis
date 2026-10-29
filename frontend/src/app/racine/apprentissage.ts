// SPDX-License-Identifier: MIT
/** frontend/src/app/racine/apprentissage.ts — « Enregistrer comme procédure » : brouillon tiré de la conversation, choix de l'utilisateur (gestes, paramètres, confirm), aperçu et enregistrement d'une version non approuvée. */
import type { BrouillonDto, ChoixApprentissageDto } from "@elpis/contracts";
import { onScopeDispose, ref, watch } from "vue";
import type { ShallowUnwrapRef } from "vue";

import { creerApiApprentissage } from "../../features/procedures/api";
import type { ClientHttp } from "../../platform/http/client";
import { messageErreur } from "../../platform/http/resultat";

export interface DependancesApprentissage {
  readonly http: ClientHttp;
  showToast(message: string, type?: string): void;
  /** Ouvre Paramètres › Procédures (approbation de la version créée). */
  ouvrirProcedures(): void;
}

export function creerApprentissage(dep: DependancesApprentissage) {
  const api = creerApiApprentissage(dep.http);
  const ouvert = ref(false);
  const chargement = ref(false);
  const erreur = ref("");
  const brouillon = ref<BrouillonDto | null>(null);
  const choix = ref<ChoixApprentissageDto | null>(null);
  const apercu = ref<{ lines: string[]; erreurs: string[] }>({ lines: [], erreurs: [] });
  const occupe = ref(false);
  const termine = ref<{ id: string; version: number } | null>(null);
  let chatId = "";
  let origine: string | undefined;
  let minuteur: ReturnType<typeof setTimeout> | null = null;
  let version = 0;

  async function ouvrir(chat: string, origin?: string): Promise<void> {
    chatId = chat;
    origine = origin;
    ouvert.value = true;
    chargement.value = true;
    erreur.value = "";
    termine.value = null;
    const r = await api.brouillon(chat, origin);
    chargement.value = false;
    if (r.type !== "ok") {
      erreur.value = messageErreur(r) || "Lecture de la conversation impossible";
      brouillon.value = null;
      choix.value = null;
      return;
    }
    brouillon.value = r.valeur;
    choix.value = { ...r.valeur.choix };
  }

  async function rafraichirApercu(): Promise<void> {
    const c = choix.value;
    if (!c) return;
    const v = ++version;
    const r = await api.apercu(chatId, c, origine);
    if (v !== version) return;
    apercu.value =
      r.type === "ok"
        ? { lines: r.valeur.lines, erreurs: r.valeur.erreurs }
        : { lines: [], erreurs: [messageErreur(r) || "Aperçu indisponible"] };
  }

  // Chaque changement de choix recalcule l'aperçu côté serveur (même validation que l'enregistrement).
  watch(
    choix,
    () => {
      if (minuteur !== null) clearTimeout(minuteur);
      minuteur = setTimeout(() => void rafraichirApercu(), 250);
    },
    { deep: true },
  );
  onScopeDispose(() => {
    if (minuteur !== null) clearTimeout(minuteur);
  });

  function garde(id: number): boolean {
    return !(choix.value?.retires ?? []).includes(id);
  }
  function basculerGarde(id: number): void {
    const c = choix.value;
    if (!c) return;
    c.retires = garde(id) ? [...c.retires, id] : c.retires.filter((x) => x !== id);
  }

  async function enregistrer(): Promise<void> {
    const c = choix.value;
    if (!c || occupe.value) return;
    occupe.value = true;
    try {
      const r = await api.enregistrer(chatId, c, origine);
      if (r.type === "ok") {
        termine.value = { id: r.valeur.id, version: r.valeur.version };
        dep.showToast("Version enregistrée, à approuver", "success");
      } else erreur.value = messageErreur(r) || "Enregistrement impossible";
    } finally {
      occupe.value = false;
    }
  }

  function fermer(): void {
    ouvert.value = false;
    brouillon.value = null;
    choix.value = null;
  }

  function ouvrirProcedures(): void {
    fermer();
    dep.ouvrirProcedures();
  }

  return {
    ouvert,
    chargement,
    erreur,
    brouillon,
    choix,
    apercu,
    occupe,
    termine,
    ouvrir,
    fermer,
    garde,
    basculerGarde,
    enregistrer,
    ouvrirProcedures,
  };
}

export type SurfaceApprentissage = ShallowUnwrapRef<ReturnType<typeof creerApprentissage>>;
