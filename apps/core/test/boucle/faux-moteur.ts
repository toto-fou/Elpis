// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/faux-moteur.ts — faux client HTTP du moteur : un script SSE par appel, corps envoyés capturés, coupures et refus. */
import { HTTPStatusError, ReponseHttp } from "../../src/llm/client-http";
import type { ClientHttp, OptionsRequete } from "../../src/llm/client-http";

export const REQUETE = { method: "POST", url: "http://moteur.invalid/v1/chat/completions" };

/** Réponse en flux scriptée ; `coupure` est levée après les lignes (transport mort en route). */
export class FauxFlux {
  readonly statusCode: number;
  readonly lignes: readonly string[];
  readonly coupure: unknown;
  ferme = false;

  constructor(lignes: readonly string[], o: { statut?: number; coupure?: unknown } = {}) {
    this.lignes = lignes;
    this.statusCode = o.statut ?? 200;
    this.coupure = o.coupure;
  }

  async *aiterLines(): AsyncGenerator<string> {
    for (const l of this.lignes) yield l;
    if (this.coupure !== undefined) throw this.coupure;
  }

  aread(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array());
  }

  aclose(): Promise<void> {
    this.ferme = true;
    return Promise.resolve();
  }

  raiseForStatus(): this {
    if (this.statusCode < 400) return this;
    throw new HTTPStatusError(`HTTP ${this.statusCode}`, {
      request: REQUETE,
      response: new ReponseHttp({ statusCode: this.statusCode, request: REQUETE }),
    });
  }
}

/** Réponse non streamée (replis) : `json` sérialisé, ou corps vide. */
export function reponse(statut: number, json?: unknown): ReponseHttp {
  return new ReponseHttp({
    statusCode: statut,
    request: REQUETE,
    ...(json === undefined
      ? {}
      : { text: JSON.stringify(json), headers: { "content-type": "application/json" } }),
  });
}

/** Client factice : `scripts[i]` sert le i-ème flux (le dernier au-delà), `posts` les requêtes sans flux, dans l'ordre. */
export class FauxClient {
  readonly payloads: unknown[] = [];
  readonly urls: string[] = [];
  readonly options: OptionsRequete[] = [];
  nStream = 0;
  private readonly scripts: readonly (readonly string[] | FauxFlux)[];
  private readonly posts: ReponseHttp[];

  constructor(scripts: readonly (readonly string[] | FauxFlux)[], posts: ReponseHttp[] = []) {
    this.scripts = scripts;
    this.posts = [...posts];
  }

  stream(_methode: string, url: string, o: OptionsRequete = {}): Promise<FauxFlux> {
    this.payloads.push(o.json);
    this.urls.push(url);
    this.options.push(o);
    const s = this.scripts[Math.min(this.nStream, this.scripts.length - 1)]!;
    this.nStream++;
    return Promise.resolve(s instanceof FauxFlux ? s : new FauxFlux(s));
  }

  post(_url: string, o: OptionsRequete = {}): Promise<ReponseHttp> {
    this.payloads.push(o.json);
    const r = this.posts.shift();
    if (r === undefined) return Promise.reject(new Error("aucune réponse POST scriptée"));
    return Promise.resolve(r);
  }

  delete(): Promise<ReponseHttp> {
    return Promise.resolve(reponse(200));
  }

  enClient(): ClientHttp {
    return this as unknown as ClientHttp;
  }
}

export function data(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}`;
}
