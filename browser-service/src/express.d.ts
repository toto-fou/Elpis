// SPDX-License-Identifier: MIT
/** browser-service/src/express.d.ts — types of the part of Express 5 the service uses (Express ships none, and the repository adds no @types package). */
declare module "express" {
  import type { IncomingMessage, Server, ServerResponse } from "node:http";

  /** Query string of a call: the tool host sends each parameter once. */
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
