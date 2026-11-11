// SPDX-License-Identifier: MIT
/** packages/outils-mcp/test/jetons.test.ts — jetons du service d'outils : table, délégation et portée (vecteurs Python), vérificateur (cache, introspection, `dlg_`). */
import type { Dict } from "@elpis/commun";
import { delegationToken, FAMILY_NAMES } from "@elpis/mcp";
import { describe, expect, it, vi } from "vitest";

import {
  construireTable,
  creerVerificateur,
  erreurConfigJetons,
  jetonDelegue,
  liaisonPermise,
  VerificateurJetons,
} from "../src/jetons";
import type { IdentiteJeton } from "../src/jetons";
import { familleDuChemin, famillesCachees } from "../src/portee";
import { lireVecteurs } from "./vecteurs";

const V = lireVecteurs<{
  tables: {
    entree: { service: string; clients: Record<string, string>; familles: Record<string, string[]> };
    table: Record<string, Dict>;
    erreur: string | null;
  }[];
  delegations: { entree: Dict; client_id: string; scopes: string[]; claims: Dict }[];
  cachees: { claims: Dict | null; famille: string | null; cachees: string[] }[];
  liaisons: { hote: string; jetons: boolean; ok: boolean }[];
  familles: string[];
}>("jetons");

const SERVICE = "svc-0123456789abcdef";

describe("table, délégation, portée, liaison (vecteurs local_mcp_server.py)", () => {
  it("familles connues", () => {
    expect([...FAMILY_NAMES]).toEqual(V.familles);
  });

  it.each(V.tables.map((t, i) => [i, t] as const))("build_token_table / token_config_error %i", (_i, t) => {
    const table = construireTable(t.entree.service, t.entree.clients, t.entree.familles);
    expect(Object.fromEntries(table)).toEqual(t.table);
    expect([...table.keys()]).toEqual(Object.keys(t.table));
    expect(erreurConfigJetons(t.entree.service, t.entree.clients)).toBe(t.erreur);
  });

  it("delegated_access_token", () => {
    for (const d of V.delegations) {
      const j = jetonDelegue("dlg_x", d.entree);
      expect({ client_id: j.client_id, scopes: j.scopes, claims: j.claims }).toEqual({
        client_id: d.client_id,
        scopes: d.scopes,
        claims: d.claims,
      });
      expect(Object.keys(j.claims)).toEqual(Object.keys(d.claims));
    }
  });

  it("hidden_families_for_current_client (jeton × portée par l'URL)", () => {
    const opencode = new Set(["git", "browser", "desktop"]);
    for (const c of V.cachees)
      expect(
        [...famillesCachees(c.claims, c.famille, opencode)].sort(),
        JSON.stringify([c.claims, c.famille]),
      ).toEqual(c.cachees);
  });

  it("bind_allowed", () => {
    for (const l of V.liaisons) expect(liaisonPermise(l.hote, l.jetons), l.hote).toBe(l.ok);
  });

  it("segment de famille d'un chemin monté", () => {
    expect(familleDuChemin("")).toBeNull();
    expect(familleDuChemin("/")).toBeNull();
    expect(familleDuChemin("Git/")).toBe("git");
    expect(familleDuChemin("skill_run")).toBe("skill_run");
    expect(familleDuChemin("a/b")).toBeUndefined();
    expect(familleDuChemin("..")).toBeUndefined();
  });
});

describe("vérificateur Bearer", () => {
  const table = construireTable(SERVICE, { "cli-a": "alice" }, { "cli-a": ["git"] });

  it("jeton de service (trusted_meta) et jeton client, comparés sur toute la table ; inconnu → null", async () => {
    const v = new VerificateurJetons({ table });
    expect(await v.verifier(SERVICE)).toEqual({
      token: SERVICE,
      client_id: "elpis-app",
      scopes: ["local-tools"],
      expires_at: null,
      claims: { client_id: "elpis-app", scopes: ["local-tools"], trusted_meta: true },
    });
    expect((await v.verifier("cli-a"))?.claims).toMatchObject({
      username: "alice",
      families: ["git"],
      trusted_meta: false,
    });
    for (const faux of ["", "cli-", "cli-ab", SERVICE + " ", "é".repeat(40), "svc"])
      expect(await v.verifier(faux)).toBeNull();
  });

  it("jetons personnels : base d'abord (cache 15 s, 5 s si inconnu), puis introspection ; type outils ou opencode", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const base = new Map<string, IdentiteJeton>([
        ["ept_" + "a".repeat(40), { username: "alice", kind: "tools", families: ["git", "fs"] }],
        ["pcr_" + "b".repeat(40), { username: "bob", kind: "opencode", families: [] }],
      ]);
      const lus: string[] = [];
      const introspectes: string[] = [];
      const v = new VerificateurJetons({
        table,
        resoudre: (j) => {
          lus.push(j);
          return Promise.resolve(base.get(j) ?? null);
        },
        introspection: {
          actif: true,
          introspectToken: (j) => {
            introspectes.push(j);
            return Promise.resolve(j === "pcr_distant" ? { username: "carl", families: ["x"] } : null);
          },
        },
      });
      expect(await v.verifier("ept_" + "a".repeat(40))).toEqual({
        token: "ept_" + "a".repeat(40),
        client_id: "tools:alice",
        scopes: ["local-tools"],
        expires_at: null,
        claims: {
          username: "alice",
          trusted_meta: false,
          client_kind: "tools",
          families: ["git", "fs"],
          scopes: ["local-tools"],
        },
      });
      expect((await v.verifier("pcr_" + "b".repeat(40)))?.claims).toEqual({
        username: "bob",
        trusted_meta: false,
        client_kind: "opencode",
        scopes: ["local-tools"],
      });
      expect((await v.verifier("pcr_distant"))?.client_id).toBe("opencode:carl");
      expect(await v.verifier("autre")).toBeNull();
      await v.verifier("ept_" + "a".repeat(40));
      await v.verifier("pcr_distant");
      expect(lus).toEqual(["ept_" + "a".repeat(40), "pcr_" + "b".repeat(40), "pcr_distant"]);
      expect(introspectes).toEqual(["pcr_distant", "pcr_distant"]);
      base.delete("ept_" + "a".repeat(40));
      vi.advanceTimersByTime(14_000);
      expect(await v.verifier("ept_" + "a".repeat(40))).not.toBeNull();
      vi.advanceTimersByTime(2_000);
      expect(await v.verifier("ept_" + "a".repeat(40))).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("base en panne : refus sans exception", async () => {
    const v = new VerificateurJetons({ table, resoudre: () => Promise.reject(new Error("base")) });
    expect(await v.verifier("ept_x")).toBeNull();
  });

  it("introspection sans compte (absent, vide, blanc, non textuel) : refus", async () => {
    const reponses: Record<string, unknown> = {
      pcr_absent: { kind: "opencode", families: [] },
      pcr_vide: { username: "" },
      pcr_blanc: { username: "  " },
      pcr_nombre: { username: 7 },
      pcr_null: { username: null },
    };
    const v = new VerificateurJetons({
      table,
      introspection: {
        actif: true,
        introspectToken: (j) => Promise.resolve(reponses[j] as { username: unknown }),
      },
    });
    for (const j of Object.keys(reponses)) expect(await v.verifier(j), j).toBeNull();
  });

  it("délégation dlg_ : signée avec le jeton de service, datée, jamais la confiance du service", async () => {
    const maintenant = 1_000_000;
    const v = new VerificateurJetons({ table, maintenant: () => maintenant });
    const dlg = delegationToken(
      { username: "alice", user_id: 3, kind: "tools", families: ["git"] },
      SERVICE,
      { now: maintenant },
    );
    expect((await v.verifier(dlg))?.claims).toEqual({
      username: "alice",
      trusted_meta: false,
      client_kind: "tools",
      delegated: true,
      scopes: ["local-tools"],
      user_id: 3,
      families: ["git"],
    });
    expect(
      await v.verifier(
        delegationToken({ username: "alice", kind: "tools" }, "autre-cle", { now: maintenant }),
      ),
    ).toBeNull();
    expect(
      await v.verifier(
        delegationToken({ username: "alice", kind: "tools" }, SERVICE, { now: maintenant - 61 }),
      ),
    ).toBeNull();
    expect(
      await v.verifier(delegationToken({ username: "", kind: "tools" }, SERVICE, { now: maintenant })),
    ).toBeNull();
    const sansService = new VerificateurJetons({ table: construireTable("", { "cli-a": "alice" }) });
    expect(await sansService.verifier(dlg)).toBeNull();
  });

  it("creerVerificateur : aucun jeton → null ; clients sans service → refus explicite", () => {
    expect(creerVerificateur({ jetons: { service: "", clients: {}, familles: {} } })).toBeNull();
    expect(() =>
      creerVerificateur({ jetons: { service: "", clients: { a: "alice" }, familles: {} } }),
    ).toThrow("LOCAL_MCP_CLIENT_TOKENS est posé sans LOCAL_MCP_TOKEN");
    expect(creerVerificateur({ jetons: { service: SERVICE, clients: {}, familles: {} } })).toBeInstanceOf(
      VerificateurJetons,
    );
  });
});
