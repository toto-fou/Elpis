// SPDX-License-Identifier: MIT
/** apps/core/test/identite/banc.ts — banc des routes de la console d'entreprise sur l'un des deux moteurs (comptes, config.json et coffre jetables). */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut, ligneUtilisateur } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance, FastifyRequest, LightMyRequestResponse } from "fastify";

import { creerFamilleAdminIdentite } from "../../src/familles/admin-identite";
import { appTest, journalMuet } from "../aides";
import { cleCoffreDeTest, configDeTest } from "./aides";
import type { ConfigDeTest } from "./aides";

export const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
export const URL_PUBLIQUE = "https://elpis.exemple.lan";

export interface Banc {
  readonly t: BaseDeTest;
  readonly cfg: ConfigDeTest;
  readonly admin: FastifyInstance;
  readonly chef: number;
  readonly alice: number;
  readonly revoques: number[];
  appeler(
    methode: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    corps?: unknown,
  ): Promise<LightMyRequestResponse>;
  lireConfig(): Record<string, unknown>;
  fermer(): Promise<void>;
}

/** Console d'entreprise sur un moteur, avec un administrateur `chef` et un compte `alice`. */
export async function ouvrirBanc(moteur: "sqlite" | "postgres"): Promise<Banc> {
  const t = ouvrirBaseDeTest(moteur);
  await initialiserBase(t.base);
  cleCoffreDeTest();
  const cfg = configDeTest({ https: true });
  const dossier = mkdtempSync(join(tmpdir(), "elpis-banc-auth-"));
  configureAudit({
    service: "admin",
    auditDir: join(dossier, "audit"),
    hmacKeyPath: join(dossier, "sans-cle"),
  });
  const chef = await createUser(t.base, "chef", "mdp-chef-1", { isAdmin: 1 });
  const alice = await createUser(t.base, "alice", "mdp-alice-1");
  const revoques: number[] = [];
  const auth = {
    ...dependancesParDefaut(t.base),
    attributsCookie: () => ({
      cookie_name: "mcpwebui_session",
      same_site: "lax" as const,
      https_only: true,
      max_age: 86_400,
    }),
  };
  const garde = async (req: FastifyRequest): Promise<void> => {
    const uid = req.headers["x-uid"];
    if (!uid) throw new HttpError(401, "not logged in");
    const ligne = await ligneUtilisateur(t.base, Number(uid));
    req.utilisateur = { id: Number(uid), username: ligne ? String(ligne.username) : null };
    if (!ligne || Number(ligne.is_admin) !== 1) throw new HttpError(403, "Admin required");
  };
  const admin = await appTest({
    mode: "admin",
    familles: [
      creerFamilleAdminIdentite({
        base: t.base,
        auth,
        journal: journalMuet,
        revoquer: async (uid) => void revoques.push(uid),
      }),
    ],
    gardes: { admin: garde, staff: garde, session: garde, service: async () => undefined },
  });
  return {
    t,
    cfg,
    admin,
    chef,
    alice,
    revoques,
    appeler: (methode, url, corps) =>
      admin.inject({
        method: methode,
        url,
        headers: { "x-uid": String(chef) },
        ...(corps === undefined ? {} : { payload: corps as object }),
      }),
    lireConfig: () =>
      existsSync(cfg.chemin) ? (JSON.parse(readFileSync(cfg.chemin, "utf8")) as Record<string, unknown>) : {},
    async fermer() {
      await admin.close();
      oublierConfigurationAudit();
      cfg.fermer();
      await t.fermer();
      rmSync(dossier, { recursive: true, force: true });
    },
  };
}
