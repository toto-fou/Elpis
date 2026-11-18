// SPDX-License-Identifier: MIT
/** apps/core/test/securite-auth-https.test.ts — tant qu'un fournisseur d'identité est allumé, la console refuse de repasser en HTTP (les mots de passe d'annuaire circuleraient en clair) ; éteint, le retour reste possible. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut, ligneUtilisateur } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance, FastifyRequest, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { creerFamilleAdminSecurite } from "../src/familles/admin-securite";
import { appTest, journalMuet } from "./aides";
import { ldapValide, oidcValide } from "./identite/aides";

describe("retour à HTTP et fournisseurs allumés", () => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let dossier: string;
  let configJson: string;
  let restaurer: () => void;
  let chef = 0;
  const evenements: unknown[][] = [];

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    chef = await createUser(t.base, "chef", "mdp-chef-1", { isAdmin: 1 });
    dossier = mkdtempSync(join(tmpdir(), "elpis-auth-https-"));
    configJson = join(dossier, "config.json");
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: configJson });
    configureAudit({
      service: "admin",
      auditDir: join(dossier, "audit"),
      hmacKeyPath: join(dossier, "sans-cle"),
    });
    app = await appTest({
      mode: "admin",
      familles: [
        creerFamilleAdminSecurite({
          base: t.base,
          auth: dependancesParDefaut(t.base),
          journal: journalMuet,
          revoquer: async () => null,
          diffuser: async (m) => void evenements.push([m["type"]]),
          cycleVie: { redemarrerMain: async () => false, programmerRechargement: () => undefined },
          sonderPort: async () => true,
        }),
      ],
      gardes: {
        admin: async (req: FastifyRequest) => {
          const ligne = await ligneUtilisateur(t.base, Number(req.headers["x-uid"]));
          if (!ligne || Number(ligne.is_admin) !== 1) throw new HttpError(403, "Admin required");
          req.utilisateur = { id: Number(ligne.id), username: String(ligne.username) };
        },
        staff: async () => undefined,
      },
    });
  });
  afterAll(async () => {
    await app.close();
    oublierConfigurationAudit();
    restaurer();
    invalidateConfigCache();
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  const ecrire = (contenu: unknown): void => {
    writeFileSync(configJson, JSON.stringify(contenu));
    invalidateConfigCache();
  };
  const lire = (): Record<string, unknown> =>
    existsSync(configJson) ? (JSON.parse(readFileSync(configJson, "utf8")) as Record<string, unknown>) : {};
  const basculer = (enabled: boolean): Promise<LightMyRequestResponse> =>
    app.inject({
      method: "POST",
      url: "/api/admin/security/https",
      headers: { "x-uid": String(chef), "content-type": "application/json" },
      payload: JSON.stringify({ enabled }),
    });
  const https = (c: Record<string, unknown>): { enabled: unknown; https_only: unknown } => {
    const s = c["security"] as { https?: { enabled?: unknown }; session?: { https_only?: unknown } };
    return { enabled: s.https?.enabled, https_only: s.session?.https_only };
  };

  it.each([
    ["fournisseur allumé", [ldapValide({ enabled: true })]],
    ["un fournisseur OIDC allumé parmi d'autres", [ldapValide(), oidcValide({ enabled: true })]],
    ["fournisseur illisible mais allumé", [{ id: "casse", enabled: true }]],
  ])("%s : repasser en HTTP est refusé (409), rien n'est écrit", async (_nom, providers) => {
    const base = {
      security: { https: { enabled: true }, session: { https_only: true } },
      auth: { providers },
    };
    ecrire(base);
    const avant = readFileSync(configJson, "utf8");
    const r = await basculer(false);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.body).toContain("Éteignez d'abord les fournisseurs");
    expect(readFileSync(configJson, "utf8")).toBe(avant);
    expect(https(lire())).toEqual({ enabled: true, https_only: true });
  });

  it("fournisseurs éteints ou absents : le retour à HTTP reste possible ; activer HTTPS l'est toujours", async () => {
    ecrire({
      security: { https: { enabled: true }, session: { https_only: true } },
      auth: { providers: [ldapValide()] },
    });
    expect((await basculer(false)).statusCode).toBe(200);
    expect(https(lire())).toEqual({ enabled: false, https_only: false });
    ecrire({ security: { https: { enabled: true }, session: { https_only: true } } });
    expect((await basculer(false)).statusCode).toBe(200);
    ecrire({ auth: { providers: [ldapValide({ enabled: true })] } });
    expect((await basculer(true)).statusCode).toBe(200);
    expect(https(lire())).toEqual({ enabled: true, https_only: true });
  });
});
