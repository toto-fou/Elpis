// SPDX-License-Identifier: MIT
/** apps/core/test/outils/mcp/vecteurs.test.ts — clients MCP : schémas pour la grammaire, tools[], en-têtes d'auth, routage des logs, messages et charge utile (vecteurs Python). */
import "../../moteur-environnement";

import { describe, expect, it } from "vitest";

import { ErreurPython } from "@elpis/commun";
import type { SurJournal } from "@elpis/mcp";

import {
  buildAuthHeaders,
  contentBlockText,
  flattenExceptionMessage,
  friendlyMcpError,
  logCallToken,
  mcpToolToOpenai,
  pickToolPayload,
  RouteurJournal,
  sanitizeSchemaForGrammar,
  toolTimeoutJson,
} from "../../../src/outils/mcp/clients";
import { delaiEnAnglais } from "../../ecart-delai-outil";
import { decoder, lireVecteurs } from "../../vecteurs-moteur";

type Dict = Record<string, unknown>;
type Issue = { valeur: unknown } | { erreur: string; message: string };

const V = lireVecteurs<Record<string, unknown>>("outils-mcp");

/** Erreur de la classe Python nommée (`RuntimeError` : le nom sert de repli quand le message est vide). */
function erreurPy(message: string, nom = "RuntimeError"): Error {
  const e = new Error(message);
  e.name = nom;
  return e;
}

function exception(spec: Dict): Error {
  if (spec["type"] === "groupe")
    return new AggregateError((spec["items"] as Dict[]).map(exception), "groupe");
  return erreurPy(spec["message"] as string);
}

function appel(f: () => unknown): Issue {
  try {
    return { valeur: f() };
  } catch (e) {
    const nom = e instanceof ErreurPython ? e.type : e instanceof Error ? e.name : typeof e;
    return { erreur: nom, message: e instanceof Error ? e.message : String(e) };
  }
}

describe("schémas d'outils pour le LLM", () => {
  it("_sanitize_schema_for_grammar : schémas booléens → {} sauf additionalProperties", () => {
    for (const c of V["sanitize"] as Dict[])
      expect(sanitizeSchemaForGrammar(decoder(c["schema"])), JSON.stringify(c["schema"])).toEqual(c["out"]);
  });

  it("mcp_tool_to_openai : nom, description, schéma par défaut", () => {
    const cas = V["openai"] as Dict[];
    expect(cas.length).toBe(12);
    for (const c of cas)
      expect(
        appel(() => mcpToolToOpenai(c["outil"])),
        JSON.stringify(c["outil"]),
      ).toEqual(c["out"]);
  });
});

describe("en-têtes et routage", () => {
  it("_build_auth_headers : dict, paires, texte « K: v », authorization, basic_auth", () => {
    for (const c of V["auth_headers"] as Dict[])
      expect(
        appel(() => buildAuthHeaders(c["cfg"] as Dict)),
        JSON.stringify(c["cfg"]),
      ).toEqual(c["out"]);
  });

  it("_log_call_token : log_token, call_id, sinon anonyme", () => {
    for (const c of V["jetons"] as Dict[]) {
      const j = logCallToken(c["meta"]);
      const attendu = c["jeton"];
      if (typeof attendu === "string") expect(j, JSON.stringify(c["meta"])).toBe(attendu);
      else {
        expect(j.startsWith("_anon_")).toBe(true);
        expect(j.length).toBe((attendu as Dict)["anonyme"]);
      }
    }
  });

  it("_LogRouter : identifiant porté, appel unique, nom d'outil, sinon jetée ; collision → jeton anonyme", () => {
    const cas = V["routeur"] as Dict[];
    for (const sc of cas.slice(0, -1)) {
      const r = new RouteurJournal();
      for (const [jeton, outil] of sc["appels"] as [string, string][])
        r.register(jeton, outil, jeton as unknown as SurJournal);
      const resolus = (sc["params"] as Dict[]).map((p) => ({
        call_id: RouteurJournal.callIdOf(p),
        cb: r.resolve(p),
      }));
      expect(resolus, JSON.stringify(sc["appels"])).toEqual(sc["resolus"]);
    }
    const collision = (cas.at(-1) as Dict)["collision"] as Dict;
    const r = new RouteurJournal();
    const premier = r.register("t", "a", "cb-a" as unknown as SurJournal);
    const second = r.register("t", "b", "cb-b" as unknown as SurJournal);
    expect(premier).toBe(collision["premier"]);
    expect(second.slice(0, 5)).toBe(collision["second_prefixe"]);
    expect(second.length).toBe(collision["second_longueur"]);
    expect(
      r.resolve({ level: "info", data: { msg: "x", extra: { kind: "shell_output", call_id: "t" } } }),
    ).toBe(collision["resolu"]);
  });
});

describe("messages et charge utile", () => {
  it("friendly_mcp_error", () => {
    for (const c of V["friendly"] as Dict[])
      expect(friendlyMcpError(erreurPy(c["message"] as string)), c["message"] as string).toBe(c["out"]);
  });

  it("pick_tool_payload et _content_block_text (jamais la charge base64)", () => {
    const payloads = V["payloads"] as Dict[];
    expect(payloads.length).toBe(22);
    for (const c of payloads)
      expect(pickToolPayload(c["resultat"]), JSON.stringify(c["resultat"]).slice(0, 120)).toEqual(
        decoder(c["out"]),
      );
    for (const c of V["blocs"] as Dict[])
      expect(contentBlockText(c["bloc"]), JSON.stringify(c["bloc"]).slice(0, 120)).toBe(c["out"]);
  });

  it("_tool_timeout_json et flatten_exception_message", () => {
    for (const c of V["timeouts"] as Dict[])
      expect(toolTimeoutJson(c["outil"] as string, c["delai"] as number)).toBe(
        delaiEnAnglais(c["json"] as string),
      );
    expect(JSON.parse(toolTimeoutJson("task_wait", 1860))).toMatchObject({
      error: "timeout",
      message: expect.stringMatching(/^Tool 'task_wait' did not answer within 1860 s: /u),
    });
    for (const c of V["flatten"] as Dict[])
      expect(
        flattenExceptionMessage(exception(c["exception"] as Dict)),
        JSON.stringify(c["exception"]).slice(0, 80),
      ).toBe(c["out"]);
  });
});
