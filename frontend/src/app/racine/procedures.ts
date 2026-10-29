// SPDX-License-Identifier: MIT
/** frontend/src/app/racine/procedures.ts — écran Procédures (Paramètres) : versions du compte, résumé lisible, approbation d'une version, suppression en deux temps. */
import type { ChoixParametre, ProcedureListee } from "@elpis/contracts";
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
  interface Resume {
    lines: string[];
    readable: boolean;
    approved: boolean;
    params: { name: string; type: string; choice: ChoixParametre | null }[];
  }
  const resumes = ref<Record<string, Resume>>({});
  /** Choix en cours par version : `libre` coché, ou valeur figée saisie ; rien par défaut. */
  const choix = ref<Record<string, Record<string, { libre: boolean; valeur: string }>>>({});
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
    if (r.type === "ok") {
      resumes.value = { ...resumes.value, [k]: r.valeur };
      const init: Record<string, { libre: boolean; valeur: string }> = {};
      for (const p of r.valeur.params)
        if (p.type !== "creds")
          init[p.name] = {
            libre: p.choice?.mode === "free",
            valeur: p.choice?.mode === "fixed" ? String(p.choice.value) : "",
          };
      choix.value = { ...choix.value, [k]: init };
    } else dep.showToast(messageErreur(r) || "Résumé indisponible", "error");
  }

  /** Tous les paramètres (hors creds) ont un choix explicite : libre, ou une valeur figée non vide. */
  function pret(id: string, version: number): boolean {
    const k = cleVersion(id, version);
    const c = choix.value[k];
    return (
      c !== undefined &&
      resumes.value[k] !== undefined &&
      Object.values(c).every((x) => x.libre || x.valeur !== "")
    );
  }

  async function approuver(id: string, version: number): Promise<void> {
    const k = cleVersion(id, version);
    if (occupee.value || !pret(id, version)) return;
    const params: Record<string, ChoixParametre> = {};
    for (const p of resumes.value[k]?.params ?? [])
      if (p.type !== "creds") {
        const c = choix.value[k]?.[p.name];
        params[p.name] = c?.libre
          ? { mode: "free" }
          : { mode: "fixed", value: p.type === "number" ? Number(c?.valeur) : (c?.valeur ?? "") };
      }
    occupee.value = true;
    try {
      const r = await api.approuver(id, version, params);
      if (r.type === "ok") {
        dep.showToast("Version approuvée", "success");
        delete resumes.value[k];
        ouverte.value = null;
        await chargerProcedures();
      } else dep.showToast(messageErreur(r) || "Approbation impossible", "error");
    } finally {
      occupee.value = false;
    }
  }

  async function retirer(id: string, version: number): Promise<void> {
    if (occupee.value) return;
    occupee.value = true;
    try {
      const r = await api.retirer(id, version);
      if (r.type === "ok") {
        delete resumes.value[cleVersion(id, version)];
        ouverte.value = null;
        await chargerProcedures();
      } else dep.showToast(messageErreur(r) || "Retrait impossible", "error");
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
    choix,
    ouverte,
    armee,
    occupee,
    chargerProcedures,
    voir,
    pret,
    approuver,
    retirer,
    supprimer,
  };
}

export type SurfaceProcedures = ShallowUnwrapRef<ReturnType<typeof creerProcedures>>;
