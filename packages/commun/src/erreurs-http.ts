// SPDX-License-Identifier: MIT
/** packages/commun/src/erreurs-http.ts — erreurs HTTP au format de FastAPI (`{"detail"}`, 422 de Pydantic). */
import { STATUS_CODES } from "node:http";

/** Équivalent de `HTTPException` ; sans `detail`, le libellé du code (« Not Found »). */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly detail: unknown;
  readonly entetes: Readonly<Record<string, string>> | undefined;

  constructor(statusCode: number, detail?: unknown, entetes?: Record<string, string>) {
    const texte = detail ?? STATUS_CODES[statusCode] ?? "Error";
    super(typeof texte === "string" ? texte : JSON.stringify(texte));
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.detail = texte;
    this.entetes = entetes;
  }
}

export type Emplacement = "body" | "query" | "path" | "header" | "cookie";

export interface ErreurPydantic {
  type: string;
  loc: (string | number)[];
  msg: string;
  input?: unknown;
  ctx?: Record<string, unknown>;
}

export class ErreurValidation extends Error {
  readonly erreurs: ErreurPydantic[];

  constructor(erreurs: ErreurPydantic[]) {
    super(erreurs.map((e) => `${e.loc.join(".")}: ${e.msg}`).join(" ; "));
    this.name = "ErreurValidation";
    this.erreurs = erreurs;
  }
}
