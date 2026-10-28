// SPDX-License-Identifier: MIT
/** frontend/src/app/racine/procedures.ts — écran Procédures (Paramètres) : versions du compte, résumé lisible, approbation d'une version, suppression en deux temps. */
import type { ProcedureListee } from "@elpis/contracts";
import { ref } from "vue";
import type { ShallowUnwrapRef } from "vue";

import { creerApiProcedures } from "../../features/procedures/api";
import type { ClientHttp } from "../../platform/http/client";
import { messageErreur } from "../../platform/http/resultat";

export interface DependancesProcedures {
  readonly http: ClientHttp;
  showToast(message: string, type?: string): void;
}

export const cleVersion = (id: string, version: number): string => `${id}@${version}`;

export function creerProcedures(dep: DependancesProcedures) {
  const api = creerApiProcedures(dep.http);
  const procedures = ref<ProcedureListee[]>([]);
  const procedures_charge = ref(false);
  const resumes = ref<Record<string, string[]>>({});
  const ouverte = ref<string | null>(null);
  const armee = ref<string | null>(null);
  const occupee = ref(false);

  async function chargerProcedures(): Promise<void> {
    const r = await api.lister();
    if (r.type === "ok") procedures.value = r.valeur.items;
    else dep.showToast(messageErreur(r) || "Chargement impossible", "error");
    procedures_charge.value = true;
  }

  async function voir(id: string, version: number): Promise<void> {
    const k = cleVersion(id, version);
    if (ouverte.value === k) {
      ouverte.value = null;
      return;
    }
    ouverte.value = k;
    if (resumes.value[k]) return;
    const r = await api.resume(id, version);
    if (r.type === "ok") resumes.value = { ...resumes.value, [k]: r.valeur.lines };
    else dep.showToast(messageErreur(r) || "Résumé indisponible", "error");
  }

  async function approuver(id: string, version: number): Promise<void> {
    if (occupee.value) return;
    occupee.value = true;
    try {
      const r = await api.approuver(id, version);
      if (r.type === "ok") {
        dep.showToast("Version approuvée", "success");
        await chargerProcedures();
      } else dep.showToast(messageErreur(r) || "Approbation impossible", "error");
    } finally {
      occupee.value = false;
    }
  }

  /** Premier clic : arme ; second clic sur la même cible : supprime (version 0 = toute la procédure). */
  async function supprimer(id: string, version: number): Promise<void> {
    const k = version === 0 ? id : cleVersion(id, version);
    if (armee.value !== k) {
      armee.value = k;
      return;
    }
    armee.value = null;
    if (occupee.value) return;
    occupee.value = true;
    try {
      const r = await api.supprimer(id, version === 0 ? undefined : version);
      if (r.type === "ok") await chargerProcedures();
      else dep.showToast(messageErreur(r) || "Suppression impossible", "error");
    } finally {
      occupee.value = false;
    }
  }

  return {
    procedures,
    procedures_charge,
    resumes,
    ouverte,
    armee,
    occupee,
    chargerProcedures,
    voir,
    approuver,
    supprimer,
  };
}

export type SurfaceProcedures = ShallowUnwrapRef<ReturnType<typeof creerProcedures>>;
