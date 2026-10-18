// SPDX-License-Identifier: MIT
/** frontend/src/platform/http/xhr.ts — envoi XHR avec progression (imports du bac), rattaché à un propriétaire de la session : une fin de session interrompt l'envoi. */
import type { GestionnaireSession } from "../../features/auth/session";

export interface ReponseXhr {
  ok: boolean;
  status: number;
  data: unknown;
  aborted?: true;
  timeout?: true;
}

/** Contrôle d'un import en cours (app.js) : `cancelled` posé par la croix, `xhr` interrompu par elle. */
export interface ControleXhr {
  cancelled?: boolean;
  xhr?: XMLHttpRequest | null;
}

const DELAI_MS = 10 * 60 * 1000;

/** POST d'un corps avec progression d'envoi ; une réponse d'une génération révolue est rendue comme une annulation. */
export function envoyerXhr(
  session: GestionnaireSession,
  url: string,
  corps: XMLHttpRequestBodyInit,
  progression?: ((charge: number, total: number) => void) | null,
  ctl?: ControleXhr | null,
): Promise<ReponseXhr> {
  return new Promise((resolve) => {
    if (ctl?.cancelled) {
      resolve({ ok: false, status: 0, data: null, aborted: true });
      return;
    }
    const proprietaire = session.proprietaire("import-xhr");
    const xhr = new XMLHttpRequest();
    let fini = false;
    const finir = (r: ReponseXhr): void => {
      if (fini) return;
      fini = true;
      if (ctl && ctl.xhr === xhr) ctl.xhr = null;
      proprietaire.liberer();
      resolve(r);
    };
    proprietaire.ajouter(() => {
      if (!fini) xhr.abort();
    });
    xhr.open("POST", url);
    xhr.timeout = DELAI_MS;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && progression) progression(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (!proprietaire.actif || !session.estCourante(proprietaire.generation)) {
        finir({ ok: false, status: 0, data: null, aborted: true });
        return;
      }
      let data: unknown;
      try {
        data = JSON.parse(xhr.responseText) as unknown;
      } catch {
        data = null;
      }
      finir({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
    };
    xhr.onerror = () => finir({ ok: false, status: 0, data: null });
    xhr.onabort = () => finir({ ok: false, status: 0, data: null, aborted: true });
    xhr.ontimeout = () => finir({ ok: false, status: 0, data: null, timeout: true });
    if (ctl) ctl.xhr = xhr;
    xhr.send(corps);
  });
}
