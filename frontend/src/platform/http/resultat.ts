// SPDX-License-Identifier: MIT
/** frontend/src/platform/http/resultat.ts — `ApiResult<T>` : issue typée d'un appel REST et décodage des erreurs `{"detail"}` et 422. */
import { schemaErreur422, schemaErreurApi } from "@elpis/contracts";
import type { ErreurPydantic } from "@elpis/contracts";

/** Détail lisible d'une erreur : texte du serveur, ou `null` (corps non JSON, `detail` non texte). */
export interface ErreurDecodee {
  readonly detail: string | null;
  readonly brut: unknown;
  readonly validation: readonly ErreurPydantic[] | null;
}

export type ApiResult<T> =
  | { readonly type: "ok"; readonly statut: number; readonly valeur: T }
  | { readonly type: "expiration"; readonly statut: 401 }
  | {
      readonly type: "refus";
      readonly statut: 403;
      readonly erreur: ErreurDecodee;
      readonly motDePasseAChanger: boolean;
    }
  | { readonly type: "conflit"; readonly statut: 409; readonly erreur: ErreurDecodee }
  | { readonly type: "requete"; readonly statut: number; readonly erreur: ErreurDecodee }
  | { readonly type: "serveur"; readonly statut: number; readonly erreur: ErreurDecodee }
  | { readonly type: "invalide"; readonly statut: number; readonly raison: string }
  | { readonly type: "annulation" }
  | { readonly type: "reseau"; readonly raison: string }
  | { readonly type: "perime" };

export type TypeApiResult = ApiResult<unknown>["type"];

/** Échec dont l'issue côté serveur est inconnue : une mutation ne doit jamais être rejouée automatiquement. */
export function estAmbigu(r: ApiResult<unknown>): boolean {
  return r.type === "reseau" || r.type === "serveur" || r.type === "annulation" || r.type === "perime";
}

export function estOk<T>(
  r: ApiResult<T>,
): r is { readonly type: "ok"; readonly statut: number; readonly valeur: T } {
  return r.type === "ok";
}

/** Adaptateur pour les appelants historiques : la valeur, ou `null` pour toute autre issue. */
export function valeurOuNull<T>(r: ApiResult<T>): T | null {
  return r.type === "ok" ? r.valeur : null;
}

function texteValidation(liste: readonly ErreurPydantic[]): string {
  return liste.map((e) => (e.loc.length ? `${e.loc.join(".")} : ${e.msg}` : e.msg)).join(" ; ");
}

/** Décode le corps d'une réponse d'erreur : `{"detail": texte}`, 422 de validation, ou texte brut (500 non rattrapé). */
export function decoderErreur(texte: string, typeContenu: string | null): ErreurDecodee {
  if (!typeContenu || !typeContenu.toLowerCase().includes("json")) {
    return { detail: null, brut: texte, validation: null };
  }
  let brut: unknown;
  try {
    brut = JSON.parse(texte);
  } catch {
    return { detail: null, brut: texte, validation: null };
  }
  const v422 = schemaErreur422.safeParse(brut);
  if (v422.success) return { detail: texteValidation(v422.data.detail), brut, validation: v422.data.detail };
  const api = schemaErreurApi.safeParse(brut);
  if (api.success && typeof api.data.detail === "string") {
    return { detail: api.data.detail, brut, validation: null };
  }
  return { detail: null, brut, validation: null };
}

/** Message d'interface pour une issue en échec (toasts des appelants historiques). */
export function messageErreur(r: ApiResult<unknown>): string {
  switch (r.type) {
    case "ok":
      return "";
    case "expiration":
      return "Session expirée";
    case "refus":
      return r.erreur.detail ?? "Accès refusé";
    case "conflit":
      return r.erreur.detail ?? "Conflit";
    case "requete":
      return r.erreur.detail ?? `Requête refusée (HTTP ${r.statut})`;
    case "serveur":
      return `Erreur serveur (HTTP ${r.statut})`;
    case "invalide":
      return "Réponse serveur invalide";
    case "annulation":
      return "Requête annulée";
    case "reseau":
      return "Erreur réseau";
    case "perime":
      return "";
  }
}
