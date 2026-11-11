// SPDX-License-Identifier: MIT
/** apps/core/test/executions/routes-runs.test.ts — /api/runs rejouées contre la vraie route FastAPI (vecteurs) : ligne et filles, chronologie, export masqué, 404 sans oracle ; masquage et argument principal ; SQLite et PostgreSQL. */
import "../moteur-environnement";

import { initialiserBase } from "@elpis/db";
import type { Base, Valeur } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { upsertChat } from "../../src/chats/stockage";
import { argumentPrincipal, masquer } from "../../src/executions/chronologie";
import { creerFamilleExecutions } from "../../src/familles/executions";
import { appTest } from "../aides";
import { lireVecteurs } from "../vecteurs-moteur";

type Dict = Record<string, unknown>;
const V = lireVecteurs<{
  runs: Dict[];
  usage: Dict[];
  outils: Dict[];
  messages: unknown[];
  requetes: [number, string][];
  textes: string[];
  arguments: unknown[];
  reponses: { statut: number; corps: string; entetes: Record<string, string | null> }[];
  masques: string[];
  arguments_principaux: string[];
}>("executions-chronologie");
const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

async function peupler(base: Base): Promise<void> {
  for (const nom of ["alice", "bob"])
    await base.run(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES(?,?,?,?,?)",
      [nom, "s", "h", 0, 0],
    );
  for (const [table, lignes] of [
    ["runs", V.runs],
    ["usage_events", V.usage],
    ["tool_call_metrics", V.outils],
  ] as const)
    for (const ligne of lignes) {
      const cols = Object.keys(ligne);
      await base.run(
        `INSERT INTO ${table}(${cols.join(", ")}) VALUES(${cols.map(() => "?").join(", ")})`,
        cols.map((k) => ligne[k] as Valeur),
      );
    }
  await upsertChat(base, 1, "c1", "Titre", V.messages, 1.0);
}

describe("masquage des secrets et argument principal (vecteurs Python)", () => {
  it("en-têtes, clé=valeur, jetons connus, URL, clés privées ; casse Unicode de re.IGNORECASE", () => {
    expect(V.textes.map(masquer)).toEqual(V.masques);
  });

  it("argument qui résume l'appel, tronqué ; repli sur le texte brut", () => {
    expect(V.arguments.map(argumentPrincipal)).toEqual(V.arguments_principaux);
  });
});

describe.each(MOTEURS)("routes /api/runs (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    await peupler(t.base);
    app = await appTest({
      familles: [creerFamilleExecutions({ base: t.base })],
      gardes: {
        session: async (req) => {
          req.utilisateur = { id: Number(req.headers["x-uid"]), username: "x" };
        },
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await t.fermer();
  });

  it("réponses identiques au routeur Python (statut, corps à l'octet près, en-têtes)", async () => {
    for (const [i, [uid, url]] of V.requetes.entries()) {
      const r = await app.inject({ method: "GET", url, headers: { "x-uid": String(uid) } });
      const attendu = V.reponses[i]!;
      expect([r.statusCode, r.body], url).toEqual([attendu.statut, attendu.corps]);
      expect(String(r.headers["content-type"]).replace("; charset=utf-8", ""), url).toBe(
        attendu.entetes["content-type"],
      );
      expect(r.headers["content-disposition"] ?? null, url).toBe(attendu.entetes["content-disposition"]);
      expect(r.headers["cache-control"] ?? null, url).toBe(attendu.entetes["cache-control"]);
    }
  });
});
