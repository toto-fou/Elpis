// SPDX-License-Identifier: MIT
/** apps/core/src/erreur-bilingue.ts — erreurs de validation partagées interface/modèle : `message` français (routes), `en` anglais (résultat d'outil). */
import { ErreurPython, HttpError } from "@elpis/commun";

/** `HttpError` dont le texte anglais `en` est celui qu'un outil rend au modèle. */
export class HttpErrorEn extends HttpError {
  readonly en: string;

  constructor(statusCode: number, message: string, en: string) {
    super(statusCode, message);
    this.en = en;
  }
}

/** `ValueError` dont le texte anglais `en` est celui qu'un outil rend au modèle. */
export class ValueErrorEn extends ErreurPython {
  readonly en: string;

  constructor(message: string, en: string) {
    super("ValueError", message);
    this.en = en;
  }
}

/** Texte à rendre au modèle : l'anglais si l'erreur le porte, sinon son message. */
export function texteModele(e: Error): string {
  return e instanceof HttpErrorEn || e instanceof ValueErrorEn ? e.en : e.message;
}
