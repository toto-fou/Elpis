// SPDX-License-Identifier: MIT
/** frontend/src/platform/http/legacy.ts — `fetchAuth` et `fetchJsonAuth` des scripts historiques (Response ou `null`), sur la session TS. */
import type { GestionnaireSession } from "../../features/auth/session";
import type { Fetch } from "./client";
import { estAbandon } from "./client";
import { noterHeureServeur } from "../horloge";

export type Toast = (message: string, type?: string, options?: { duration?: number }) => void;

export interface DependancesHttpLegacy {
  readonly session: GestionnaireSession;
  readonly showToast: Toast;
  /** Bascule l'affichage sur la carte de connexion (`user = null`). */
  readonly deconnecterAffichage: () => void;
  /** 403 `must_change_password` : carte de changement ; vrai si l'état vient de changer (toast à faire). */
  readonly exigerMotDePasse: () => boolean;
  readonly fetch?: Fetch;
}

export interface OptionsFetchAuth extends RequestInit {
  /** L'appelant qui abandonne sa requête veut voir l'AbortError, pas un `null`. */
  readonly rethrowAbort?: boolean;
}

export interface OptionsFetchJsonAuth {
  readonly soft?: boolean;
  readonly silent?: boolean;
  readonly errorMsg?: string;
}

export interface HttpLegacy {
  fetchAuth(url: string, options?: OptionsFetchAuth, soft?: boolean): Promise<Response | null>;
  fetchJsonAuth(url: string, options?: OptionsFetchAuth, opts?: OptionsFetchJsonAuth): Promise<unknown>;
  handleSessionExpired(): void;
}

const MESSAGE_EXPIRATION =
  "Session expirée — reconnectez-vous. Les modifications non enregistrées seront perdues.";

export function creerHttpLegacy(dep: DependancesHttpLegacy): HttpLegacy {
  const faireFetch: Fetch = dep.fetch ?? ((u, i) => globalThis.fetch(u, i));

  /** Fin subie vue par n'importe quel client (401, SSE, 403 de mot de passe) : un toast par session, affichage détaché. */
  dep.session.surChangement((etat, precedent) => {
    if (precedent.statut !== "connecte") return;
    if (etat.statut === "deconnecte" && etat.raison === "expiration") {
      dep.showToast(MESSAGE_EXPIRATION, "warning", { duration: 12000 });
      dep.deconnecterAffichage();
    } else if (etat.statut === "mot_de_passe_a_changer") {
      if (dep.exigerMotDePasse())
        dep.showToast("Votre mot de passe doit être changé avant de continuer.", "warning");
      dep.deconnecterAffichage();
    }
  });

  function handleSessionExpired(): void {
    dep.session.fermer("expiration");
    dep.deconnecterAffichage();
  }

  async function fetchAuth(
    url: string,
    options: OptionsFetchAuth = {},
    soft = false,
  ): Promise<Response | null> {
    const { rethrowAbort, ...init } = options;
    const generation = dep.session.generation;
    let res: Response;
    try {
      res = await faireFetch(url, { credentials: "same-origin", ...init });
    } catch (e) {
      if (estAbandon(e)) {
        if (rethrowAbort) throw e;
        return null;
      }
      if (!soft) dep.showToast("Erreur réseau", "error");
      return null;
    }
    noterHeureServeur(res.headers?.get("date"));
    if (!dep.session.estCourante(generation)) return null;
    if (res.status === 401) {
      handleSessionExpired();
      return null;
    }
    if (res.status === 403) {
      let detail: unknown = null;
      try {
        const corps: unknown = await res.clone().json();
        if (corps !== null && typeof corps === "object") detail = (corps as { detail?: unknown }).detail;
      } catch {
        detail = null;
      }
      if (detail === "must_change_password") {
        dep.session.motDePasseAChanger();
        dep.deconnecterAffichage();
        return null;
      }
    }
    return res;
  }

  async function fetchJsonAuth(
    url: string,
    options?: OptionsFetchAuth,
    opts: OptionsFetchJsonAuth = {},
  ): Promise<unknown> {
    const res = await fetchAuth(url, options, opts.soft);
    if (!res) return null;
    if (!res.ok) {
      if (!opts.silent) dep.showToast(opts.errorMsg || `Erreur serveur (HTTP ${res.status})`, "error");
      return null;
    }
    try {
      return (await res.json()) as unknown;
    } catch {
      if (!opts.silent) dep.showToast("Réponse serveur invalide", "error");
      return null;
    }
  }

  return { fetchAuth, fetchJsonAuth, handleSessionExpired };
}
