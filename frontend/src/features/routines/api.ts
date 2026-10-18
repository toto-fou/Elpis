// SPDX-License-Identifier: MIT
/** frontend/src/features/routines/api.ts — routines (`/api/routines*`) : lectures, écritures, webhook et skills attachables, réponses validées par les schémas C2. */
import {
  schemaReponseActivationRoutine,
  schemaReponseArretRun,
  schemaReponseDesactivationWebhook,
  schemaReponseFiltreWebhook,
  schemaReponseLancementRoutine,
  schemaReponseListeSkills,
  schemaReponseRotationWebhook,
  schemaReponseRoutineCreee,
  schemaReponseRoutines,
  schemaReponseRunsRoutine,
} from "@elpis/contracts";
import type { ResumeSkill, RunRoutine } from "@elpis/contracts";
import type { ZodType } from "zod";

import type { ClientHttp } from "../../platform/http/client";
import type { ApiResult } from "../../platform/http/resultat";

export type RoutineListee = (typeof schemaReponseRoutines)["_output"]["items"][number];
export type ReponseLancement = (typeof schemaReponseLancementRoutine)["_output"];
export type ReponseArret = (typeof schemaReponseArretRun)["_output"];

/** Forme rendue au code historique : `echec` vaut « reseau » ou « refuse » (HTTP, schéma, expiration). */
export type LectureRoutines<T> = { ok: true; items: T[] } | { ok: false; echec: "reseau" | "refuse" };

/** Résultat d'une écriture : valeur validée, ou échec avec le `detail` du serveur s'il existe. */
export type Ecriture<T> =
  { ok: true; valeur: T } | { ok: false; echec: "reseau" | "refuse"; detail: string | null };

function lecture<T>(r: ApiResult<{ items: T[] }>): LectureRoutines<T> {
  if (r.type === "ok") return { ok: true, items: r.valeur.items };
  return { ok: false, echec: r.type === "reseau" ? "reseau" : "refuse" };
}

function ecriture<T>(r: ApiResult<T>): Ecriture<T> {
  if (r.type === "ok") return { ok: true, valeur: r.valeur };
  const detail = "erreur" in r ? r.erreur.detail : null;
  return { ok: false, echec: r.type === "reseau" ? "reseau" : "refuse", detail };
}

export interface CorpsFiltreWebhook {
  events: string[];
  branch: string;
  repo: string;
}

export interface ApiRoutines {
  lister(): Promise<LectureRoutines<RoutineListee>>;
  runs(id: number | string, limite?: number): Promise<LectureRoutines<RunRoutine>>;
  skills(): Promise<ApiResult<{ skills: ResumeSkill[] }>>;
  enregistrer(id: number | string | null, corps: unknown): Promise<Ecriture<{ id?: number }>>;
  supprimer(id: number | string): Promise<Ecriture<undefined>>;
  basculer(id: number | string, activer: boolean): Promise<Ecriture<unknown>>;
  lancer(id: number | string): Promise<Ecriture<ReponseLancement>>;
  arreter(idRoutine: number | string, idRun: number | string): Promise<Ecriture<ReponseArret>>;
  tournerWebhook(id: number | string): Promise<Ecriture<{ secret: string }>>;
  couperWebhook(id: number | string): Promise<Ecriture<unknown>>;
  filtrerWebhook(id: number | string, filtre: CorpsFiltreWebhook): Promise<Ecriture<unknown>>;
}

const JSON_ENTETES = { "Content-Type": "application/json" };

export function creerApiRoutines(http: ClientHttp): ApiRoutines {
  const seg = (id: number | string): string => encodeURIComponent(String(id));
  const poster = <T>(url: string, schema?: ZodType<T>, corps?: unknown) =>
    http.requete(
      url,
      corps === undefined
        ? { method: "POST" }
        : { method: "POST", headers: JSON_ENTETES, body: JSON.stringify(corps) },
      schema ? { schema } : {},
    );
  return {
    async lister() {
      return lecture(await http.requete("/api/routines", {}, { schema: schemaReponseRoutines }));
    },
    async runs(id, limite = 50) {
      const url = `/api/routines/${seg(id)}/runs?limit=${limite}`;
      return lecture(await http.requete(url, {}, { schema: schemaReponseRunsRoutine }));
    },
    skills() {
      return http.requete("/api/skills", {}, { schema: schemaReponseListeSkills });
    },
    async enregistrer(id, corps) {
      const edition = id !== null;
      const init = { method: edition ? "PUT" : "POST", headers: JSON_ENTETES, body: JSON.stringify(corps) };
      if (edition) {
        const r = ecriture(await http.requete(`/api/routines/${seg(id)}`, init));
        return r.ok ? { ok: true, valeur: {} } : r;
      }
      const r = ecriture(await http.requete("/api/routines", init, { schema: schemaReponseRoutineCreee }));
      return r.ok ? { ok: true, valeur: { id: r.valeur.id } } : r;
    },
    async supprimer(id) {
      return ecriture(await http.requete(`/api/routines/${seg(id)}`, { method: "DELETE" }));
    },
    async basculer(id, activer) {
      const action = activer ? "enable" : "disable";
      return ecriture(await poster(`/api/routines/${seg(id)}/${action}`, schemaReponseActivationRoutine));
    },
    async lancer(id) {
      return ecriture(await poster(`/api/routines/${seg(id)}/run-now`, schemaReponseLancementRoutine));
    },
    async arreter(idRoutine, idRun) {
      return ecriture(
        await poster(`/api/routines/${seg(idRoutine)}/runs/${seg(idRun)}/stop`, schemaReponseArretRun),
      );
    },
    async tournerWebhook(id) {
      return ecriture(await poster(`/api/routines/${seg(id)}/webhook/rotate`, schemaReponseRotationWebhook));
    },
    async couperWebhook(id) {
      return ecriture(
        await poster(`/api/routines/${seg(id)}/webhook/disable`, schemaReponseDesactivationWebhook),
      );
    },
    async filtrerWebhook(id, filtre) {
      return ecriture(
        await poster(`/api/routines/${seg(id)}/webhook/filter`, schemaReponseFiltreWebhook, filtre),
      );
    },
  };
}
