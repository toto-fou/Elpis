// SPDX-License-Identifier: MIT
/** apps/core/test/journal-securite/catalogue-divers.test.ts — journal de sécurité des jetons personnels, du trafic LLM de la console et des refus de rôle de l'AX. */
import { createUser, dependancesParDefaut, ligneUtilisateur } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { creerFamilleAdminLlm } from "../../src/familles/admin-llm";
import { creerFamilleAx } from "../../src/familles/ax";
import { creerFamilleJetons } from "../../src/familles/jetons";
import { appTest, journalMuet } from "../aides";
import { journalDeTest } from "./aides-journal";
import type { JournalDeTest } from "./aides-journal";

describe("journal de sécurité : jetons, trafic LLM, AX", () => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let appAdmin: FastifyInstance;
  let j: JournalDeTest;

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await createUser(t.base, "root", "mdp-root", { isAdmin: 1 });
    await createUser(t.base, "bob", "mdp-bob", { isAdmin: 0 });
    j = journalDeTest();
    const identifier = async (req: { headers: Record<string, unknown>; utilisateur?: unknown }) => {
      const uid = req.headers["x-uid"];
      if (!uid) throw new HttpError(401, "not logged in");
      const ligne = await ligneUtilisateur(t.base, Number(uid));
      req.utilisateur = { id: Number(uid), username: ligne ? String(ligne.username) : null };
    };
    app = await appTest({
      familles: [
        creerFamilleJetons({
          auth: dependancesParDefaut(t.base),
          racine: "/tmp",
          mandataires: [],
          journal: journalMuet,
          mode: "main",
        }),
        creerFamilleAx({ base: t.base }),
      ],
      gardes: { session: identifier },
    });
    appAdmin = await appTest({
      mode: "admin",
      familles: [creerFamilleAdminLlm({ base: t.base, journal: journalMuet })],
      gardes: { admin: identifier, staff: identifier },
    });
  });

  afterAll(async () => {
    await app?.close();
    await appAdmin?.close();
    j?.fermer();
    await t?.fermer();
  });

  const appeler = (
    method: "GET" | "POST" | "DELETE",
    url: string,
    uid: number,
    payload?: Record<string, unknown>,
    cible = app,
  ) =>
    cible.inject({
      method,
      url,
      headers: { "x-uid": String(uid), "x-elpis-console": "1" },
      ...(payload ? { payload } : {}),
    });

  it("jetons : création, régénération et suppression, valeur jamais écrite", async () => {
    const cree = await appeler("POST", "/api/tokens", 2, {
      kind: "tools",
      name: "poste",
      families: ["fs"],
      days: 5,
    });
    expect(cree.statusCode).toBe(200);
    const { token, item } = cree.json() as { token: string; item: { id: number } };
    expect(j.derniere("token.create")).toMatchObject({
      outcome: "success",
      user_id: 2,
      username: "bob",
      details: { token_id: item.id, name: "poste", type: "tools", expires_at: expect.any(Number) },
    });
    expect(j.derniere("token.create").ip).not.toBeNull();
    const regenere = await appeler("POST", `/api/tokens/${item.id}/regenerate`, 2);
    const nouvelId = (regenere.json() as { item: { id: number } }).item.id;
    expect(j.derniere("token.regenerate").details).toEqual({ token_id: item.id, new_token_id: nouvelId });
    await appeler("DELETE", `/api/tokens/${nouvelId}`, 2);
    expect(j.derniere("token.delete").details).toEqual({ token_id: nouvelId });
    const brut = j.brut();
    for (const secret of [token, (regenere.json() as { token: string }).token])
      expect(brut).not.toContain(secret);
  });

  it("trafic LLM : lecture du détail et effacement", async () => {
    await t.base.run("INSERT INTO llm_calls(ts, status, request_json, response_json) VALUES(1, 'ok', ?, ?)", [
      '{"messages":[{"content":"prompt-secret-1"}]}',
      '{"choices":[]}',
    ]);
    const liste = await appeler("GET", "/api/admin/llm-traffic", 1, undefined, appAdmin);
    expect(liste.statusCode).toBe(200);
    expect(j.de("admin.llm_traffic.read")).toHaveLength(0);
    const detail = await appeler("GET", "/api/admin/llm-traffic/1", 1, undefined, appAdmin);
    expect(detail.statusCode).toBe(200);
    expect(j.derniere("admin.llm_traffic.read")).toMatchObject({ user_id: 1, details: { call_id: 1 } });
    await appeler("DELETE", "/api/admin/llm-traffic", 1, undefined, appAdmin);
    expect(j.derniere("admin.llm_traffic.delete").details).toEqual({ deleted: 1 });
    expect(j.brut()).not.toContain("prompt-secret-1");
  });

  it("AX : un compte simple est refusé et le refus est journalisé", async () => {
    const r = await appeler("DELETE", "/api/ax/all?confirm=WIPE", 2);
    expect(r.statusCode).toBe(403);
    expect(j.derniere("auth.role.denied")).toMatchObject({
      outcome: "failure",
      user_id: 2,
      username: "bob",
      details: { method: "DELETE", required: "admin" },
    });
    await appeler("POST", "/api/ax/bulk-delete", 2, { sites: [] });
    expect(j.derniere("auth.role.denied").details).toMatchObject({ required: "staff" });
  });
});
