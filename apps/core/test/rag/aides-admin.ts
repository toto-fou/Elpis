// SPDX-License-Identifier: MIT
/** apps/core/test/rag/aides-admin.ts — banc de la console du RAG : app en mode admin avec garde par en-tête (admin seul, comme la vraie garde), comptes, modérateur, appels typés. */
import { HttpError } from "@elpis/commun";
import type { Base } from "@elpis/db";
import { ClientQdrant } from "@elpis/rag";
import type { FastifyInstance } from "fastify";

import { creerFamilleAdminRag } from "../../src/familles/admin-rag";
import type { ServiceIndexationRag } from "../../src/rag/service";
import { appTest } from "../aides";
import { creerCompte } from "./aides-indexation";
import { fetchQdrantFaux } from "./aides-routes";
import type { Banc, Reponse } from "./aides-routes";

export interface AppAdminRag {
  readonly app: FastifyInstance;
  appeler(uid: number | null, methode: string, url: string, corps?: unknown): Promise<Reponse>;
  fermer(): Promise<void>;
}

/** App du processus admin avec les routes de la console du RAG ; la garde `admin` relit `is_admin` en base (1 seulement). */
export async function creerAppAdminRag(o: {
  base: Base;
  service: () => ServiceIndexationRag | null;
  qdrant?: (url: string) => ClientQdrant;
  sondeExtracteur?: () => Promise<unknown>;
}): Promise<AppAdminRag> {
  const app = await appTest({
    mode: "admin",
    familles: [
      creerFamilleAdminRag({
        base: o.base,
        service: o.service,
        ...(o.qdrant ? { qdrant: o.qdrant } : {}),
        ...(o.sondeExtracteur ? { sondeExtracteur: o.sondeExtracteur } : {}),
      }),
    ],
    gardes: {
      admin: async (req) => {
        const v = req.headers["x-uid"];
        if (!v) throw new HttpError(401, "not logged in");
        const [r] = await o.base.valeurs<[unknown]>("SELECT is_admin FROM users WHERE id=?", [Number(v)]);
        if (r === undefined || Number(r[0]) !== 1) throw new HttpError(403, "Admin required");
        req.utilisateur = { id: Number(v), username: null };
      },
    },
  });
  return {
    app,
    appeler: async (uid, methode, url, corps) => {
      const r = await app.inject({
        method: methode as "GET",
        url,
        headers: uid === null ? {} : { "x-uid": String(uid) },
        ...(corps === undefined ? {} : { payload: corps as object }),
      });
      let c: unknown = null;
      if (String(r.headers["content-type"] ?? "").startsWith("application/json")) c = r.json();
      return { statut: r.statusCode, corps: c, entetes: r.headers, brut: r.rawPayload };
    },
    fermer: () => app.close(),
  };
}

export interface BancAdmin extends Banc {
  readonly console: AppAdminRag;
  /** Compte modérateur (`is_admin = 2`) : pas admin pour le RAG. */
  readonly moderateur: number;
  appelerAdmin(uid: number | null, methode: string, url: string, corps?: unknown): Promise<Reponse>;
}

/** Banc des routes du compte (L4) complété de la console : même base, même service, même Qdrant en mémoire. */
export async function ajouterConsole(b: Banc): Promise<BancAdmin> {
  const moderateur = await creerCompte(b.base, "moderatrice");
  await b.base.run("UPDATE users SET is_admin = 2 WHERE id = ?", [moderateur]);
  const console = await creerAppAdminRag({
    base: b.base,
    service: () => b.service,
    qdrant: (url) => new ClientQdrant({ url, fetch: fetchQdrantFaux(b.q) }),
  });
  return {
    ...b,
    console,
    moderateur,
    appelerAdmin: (uid, methode, url, corps) => console.appeler(uid, methode, url, corps),
    fermer: async () => {
      await console.fermer();
      await b.fermer();
    },
  };
}
