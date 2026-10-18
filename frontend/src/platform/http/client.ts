// SPDX-License-Identifier: MIT
/** frontend/src/platform/http/client.ts — client REST typé : génération de session, statuts classés en `ApiResult`, JSON validé par Zod. */
import type { ZodType } from "zod";

import type { GestionnaireSession } from "../../features/auth/session";
import { decoderErreur } from "./resultat";
import type { ApiResult } from "./resultat";

export type Fetch = (entree: string, init?: RequestInit) => Promise<Response>;

export interface OptionsRequete<T> {
  /** Schéma de la réponse ; absent : corps ignoré (204 ou réponse sans intérêt). */
  readonly schema?: ZodType<T>;
  /** Un 401 ne termine pas la session (connexion : identifiants refusés). */
  readonly sans401?: boolean;
}

export function estAbandon(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}

export class ClientHttp {
  readonly #fetch: Fetch;
  readonly session: GestionnaireSession;

  constructor(session: GestionnaireSession, fetchImpl?: Fetch) {
    this.session = session;
    this.#fetch = fetchImpl ?? ((u, i) => globalThis.fetch(u, i));
  }

  /** Une requête, jamais rejouée ; la réponse d'une génération révolue est rendue `perime`, sans effet sur la session. */
  async requete<T = undefined>(
    url: string,
    init: RequestInit = {},
    opts: OptionsRequete<T> = {},
  ): Promise<ApiResult<T>> {
    const generation = this.session.generation;
    let rep: Response;
    try {
      rep = await this.#fetch(url, { credentials: "same-origin", ...init });
    } catch (e) {
      if (estAbandon(e)) return { type: "annulation" };
      return { type: "reseau", raison: e instanceof Error ? e.message : String(e) };
    }
    if (!this.session.estCourante(generation)) return { type: "perime" };
    if (rep.status === 401 && !opts.sans401) {
      this.session.signalerExpiration(generation);
      return { type: "expiration", statut: 401 };
    }
    if (!rep.ok) return this.#echec(rep, generation);
    if (!opts.schema) return { type: "ok", statut: rep.status, valeur: undefined as T };
    let texte: string;
    try {
      texte = await rep.text();
    } catch (e) {
      if (estAbandon(e)) return { type: "annulation" };
      return { type: "reseau", raison: e instanceof Error ? e.message : String(e) };
    }
    if (!this.session.estCourante(generation)) return { type: "perime" };
    let brut: unknown;
    try {
      brut = JSON.parse(texte);
    } catch {
      return { type: "invalide", statut: rep.status, raison: "JSON illisible" };
    }
    const r = opts.schema.safeParse(brut);
    if (!r.success) return { type: "invalide", statut: rep.status, raison: r.error.message };
    return { type: "ok", statut: rep.status, valeur: r.data };
  }

  async #echec<T>(rep: Response, generation: number): Promise<ApiResult<T>> {
    const texte = await rep.text().catch(() => "");
    if (!this.session.estCourante(generation)) return { type: "perime" };
    const erreur = decoderErreur(texte, rep.headers.get("content-type"));
    if (rep.status === 401) return { type: "requete", statut: 401, erreur };
    if (rep.status === 403) {
      const motDePasseAChanger = erreur.detail === "must_change_password";
      if (motDePasseAChanger) this.session.motDePasseAChanger();
      return { type: "refus", statut: 403, erreur, motDePasseAChanger };
    }
    if (rep.status === 409) return { type: "conflit", statut: 409, erreur };
    if (rep.status >= 500) return { type: "serveur", statut: rep.status, erreur };
    return { type: "requete", statut: rep.status, erreur };
  }
}
