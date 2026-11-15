// SPDX-License-Identifier: MIT
/** browser-service/src/express.d.ts — types de la partie d'Express 5 que le service utilise (Express n'en livre pas, et le dépôt n'ajoute aucun paquet @types). */
declare module "express" {
  import type { IncomingMessage, Server, ServerResponse } from "node:http";

  /** Chaîne de requête d'un appel : l'hôte d'outils envoie chaque paramètre une fois. */
  export type Query = Record<string, string | undefined>;

  export interface Request<B = unknown, Q = Query> extends IncomingMessage {
    body: B;
    query: Q;
    path: string;
    get(name: string): string | undefined;
  }

  export interface Response extends ServerResponse {
    status(code: number): this;
    json(body?: unknown): this;
    set(field: string, value: string): this;
  }

  export type NextFunction = (err?: unknown) => void;

  export type RequestHandler<B = unknown, Q = Query> = (
    req: Request<B, Q>,
    res: Response,
    next: NextFunction,
  ) => unknown;

  export interface Application {
    use(...handlers: RequestHandler[]): this;
    use(path: string, ...handlers: RequestHandler[]): this;
    get<B = unknown, Q = Query>(path: string, ...handlers: RequestHandler<B, Q>[]): this;
    post<B = unknown, Q = Query>(path: string, ...handlers: RequestHandler<B, Q>[]): this;
    listen(path: string, callback?: () => void): Server;
  }

  interface Express {
    (): Application;
    json(options?: { limit?: string }): RequestHandler;
    static(root: string): RequestHandler;
  }

  const express: Express;
  export default express;
}
