// SPDX-License-Identifier: MIT
/** apps/core/test/outils/mcp/securite-schema-sortie.test.ts — un outputSchema distant ne bloque pas la boucle d'événements : au pire la sortie n'est pas validée ; un schéma ordinaire reste validé. */
import "../../moteur-environnement";

import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ClientMcpHttp } from "../../../src/outils/mcp/clients";
import { installerCrochetJournal } from "../../../src/journal";

type Dict = Record<string, unknown>;

/** Sans borne de temps : 2^30 pas de regex, 2^40 appels de `$ref`, 2.10^10 comparaisons. */
const VALEUR_LENTE = "a".repeat(30) + "!";
const MOTIF_LENT = "^(a+)+$";
const LARGEMENT = 10_000;
const TROP_PROFOND = "profond_serialisation";

function chaineDeRefs(n: number): Dict {
  const $defs: Dict = { [`d${n}`]: { type: "object" } };
  for (let i = 0; i < n; i++)
    $defs[`d${i}`] = { allOf: [{ $ref: `#/$defs/d${i + 1}` }, { $ref: `#/$defs/d${i + 1}` }] };
  return { $defs, $ref: "#/$defs/d0" };
}

function grosSchema(octets: number): Dict {
  const properties: Dict = {};
  for (let i = 0; i < octets / 25; i++) properties[`p${i}`] = { type: "string" };
  return { type: "object", properties };
}

const imbrique = (n: number): string => '{"not":'.repeat(n) + "{}" + "}".repeat(n);

/** Outils du faux serveur : nom → schéma de sortie en JSON brut (un JSON trop profond pour `JSON.stringify` reste émis) et contenu structuré. */
const OUTILS: Record<string, [string, unknown]> = {
  ordinaire: [JSON.stringify({ type: "object", properties: { n: { type: "integer" } } }), null],
  motif_sain: [
    JSON.stringify({ type: "object", properties: { n: { type: "string", pattern: "^[a-z]+$" } } }),
    null,
  ],
  cles_saines: [
    JSON.stringify({
      type: "object",
      patternProperties: { "^s_": { type: "string" } },
      additionalProperties: false,
    }),
    null,
  ],
  branches: [
    JSON.stringify({
      oneOf: [{ properties: { n: { pattern: "^a" } } }, { properties: { n: { pattern: "^b" } } }],
    }),
    null,
  ],
  schema_moyen: [JSON.stringify(grosSchema(4 * 1024)), null],
  pattern: [
    JSON.stringify({ type: "object", properties: { x: { type: "string", pattern: MOTIF_LENT } } }),
    { x: VALEUR_LENTE },
  ],
  pattern_properties: [
    JSON.stringify({ type: "object", patternProperties: { [MOTIF_LENT]: { type: "string" } } }),
    { [VALEUR_LENTE]: 1 },
  ],
  property_names: [
    JSON.stringify({ type: "object", propertyNames: { pattern: MOTIF_LENT } }),
    { [VALEUR_LENTE]: 1 },
  ],
  additional_properties: [
    JSON.stringify({
      type: "object",
      patternProperties: { [MOTIF_LENT]: true },
      additionalProperties: false,
    }),
    { [VALEUR_LENTE]: 1 },
  ],
  refs: [JSON.stringify(chaineDeRefs(40)), { x: 1 }],
  unique_items: [
    JSON.stringify({ type: "object", properties: { l: { type: "array", uniqueItems: true } } }),
    { l: Array.from({ length: 200_000 }, (_, i) => ({ i })) },
  ],
  tres_gros: [JSON.stringify({ ...grosSchema(1024 * 1024), required: ["p0"] }), { x: 1 }],
  profond_compilation: [imbrique(1_800), { x: 1 }],
  [TROP_PROFOND]: [imbrique(100_000), { x: 1 }],
  type_inconnu: [JSON.stringify({ type: "entier" }), { x: 1 }],
  motif_illisible: [
    JSON.stringify({ type: "object", properties: { x: { type: "string", pattern: "^[\\w-.]+$" } } }),
    { x: "y" },
  ],
};

/** Réponses de ces outils selon l'appel : l'argument `sortie` prime sur le contenu fixé, `null` n'en rend aucun. */
function resultat(m: Dict): Dict {
  const p = m["params"] as Dict;
  const args = p["arguments"] as Dict;
  const sortie = Object.hasOwn(args, "sortie") ? args["sortie"] : OUTILS[String(p["name"])]?.[1];
  return { content: [], ...(sortie === null ? {} : { structuredContent: sortie }) };
}

/** `/profond` sert à part le schéma qui casse `JSON.stringify` : sur la base, il fait échouer toute la liste du serveur. */
function repondre(m: Dict, chemin: string | undefined): string {
  const entete = `{"jsonrpc":"2.0","id":${JSON.stringify(m["id"])},"result":`;
  if (m["method"] === "initialize")
    return `${entete}${JSON.stringify({
      protocolVersion: (m["params"] as Dict)["protocolVersion"],
      capabilities: { tools: {} },
      serverInfo: { name: "hostile", version: "1" },
    })}}`;
  if (m["method"] === "tools/list") {
    const outils = Object.entries(OUTILS)
      .filter(([nom]) => (nom === TROP_PROFOND) === (chemin === "/profond"))
      .map(
        ([nom, [schema]]) =>
          `{"name":${JSON.stringify(nom)},"inputSchema":{"type":"object"},"outputSchema":${schema}}`,
      );
    return `${entete}{"tools":[${outils.join(",")}]}}`;
  }
  return `${entete}${JSON.stringify(resultat(m))}}`;
}

let srv: Server;
let url: string;
let c: ClientMcpHttp;
let alertes: string[];
const signal = new AbortController().signal;

beforeAll(async () => {
  srv = createServer((req, rep) => {
    if (req.method !== "POST") return void rep.writeHead(405).end();
    let corps = "";
    req.on("data", (d: Buffer) => (corps += d.toString()));
    req.on("end", () => {
      const m = JSON.parse(corps) as Dict;
      if (m["id"] === undefined) return void rep.writeHead(202).end();
      rep.writeHead(200, { "content-type": "application/json" }).end(repondre(m, req.url));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  srv.closeAllConnections();
  await new Promise((r) => srv.close(r));
});

beforeEach(async () => {
  alertes = [];
  installerCrochetJournal((niveau, message) => {
    if (niveau === "WARNING") alertes.push(message);
  });
  c = new ClientMcpHttp(url);
  await c.connecter(signal);
  await c.listerOutils(signal);
});

afterEach(async () => {
  installerCrochetJournal(null);
  await c.fermer();
});

const appeler = (nom: string, args: Dict = {}): Promise<unknown> => c.appelerOutil(nom, args, { signal });

describe("schéma hostile : borné, l'outil continue sans validation", () => {
  for (const nom of [
    "pattern",
    "pattern_properties",
    "property_names",
    "additional_properties",
    "refs",
    "unique_items",
  ])
    it(`${nom} : l'appel rend le résultat, une seule alerte sur deux appels`, async () => {
      const debut = performance.now();
      const res = (await appeler(nom)) as Dict;
      expect(performance.now() - debut).toBeLessThan(LARGEMENT);
      expect(res["structuredContent"]).toEqual(OUTILS[nom]?.[1]);
      expect(alertes.filter((m) => m.includes(nom))).toHaveLength(1);
      await appeler(nom);
      expect(alertes.filter((m) => m.includes(nom))).toHaveLength(1);
    });

  for (const nom of ["tres_gros", "profond_compilation"])
    it(`${nom} : ni compilé ni bloquant, l'outil répond`, async () => {
      const debut = performance.now();
      const res = (await appeler(nom)) as Dict;
      expect(performance.now() - debut).toBeLessThan(LARGEMENT);
      expect(res["structuredContent"]).toEqual({ x: 1 });
      expect(alertes.some((m) => m.includes(nom))).toBe(true);
    });

  for (const nom of ["type_inconnu", "motif_illisible"])
    it(`${nom} : un schéma non compilable ne casse pas l'outil`, async () => {
      expect(await appeler(nom)).toMatchObject({ structuredContent: OUTILS[nom]?.[1] });
      expect(alertes.some((m) => m.includes(nom))).toBe(true);
    });

  it("schéma trop profond pour JSON.stringify : la liste du serveur tient, l'outil répond", async () => {
    const profond = new ClientMcpHttp(url.replace("/mcp", "/profond"));
    await profond.connecter(signal);
    try {
      expect((await profond.listerOutils(signal)).map((t) => t["name"])).toEqual([TROP_PROFOND]);
      expect(await profond.appelerOutil(TROP_PROFOND, {}, { signal })).toMatchObject({
        structuredContent: { x: 1 },
      });
      expect(alertes.some((m) => m.includes(TROP_PROFOND))).toBe(true);
    } finally {
      await profond.fermer();
    }
  });

  it("contenu structuré absent : toujours signalé, même schéma écarté", async () => {
    await expect(appeler("tres_gros", { sortie: null })).rejects.toThrow(
      "Tool tres_gros has an output schema but did not return structured content",
    );
  });
});

describe("schéma ordinaire : validé comme avant", () => {
  it("types", async () => {
    expect(await appeler("ordinaire", { sortie: { n: 3 } })).toMatchObject({ structuredContent: { n: 3 } });
    await expect(appeler("ordinaire", { sortie: { n: "x" } })).rejects.toThrow(
      "Invalid structured content returned by tool ordinaire: 'x' is not of type 'integer'",
    );
  });

  it("pattern sain : appliqué", async () => {
    expect(await appeler("motif_sain", { sortie: { n: "abc" } })).toMatchObject({
      structuredContent: { n: "abc" },
    });
    await expect(appeler("motif_sain", { sortie: { n: "ABC" } })).rejects.toThrow(
      "Invalid structured content returned by tool motif_sain: 'ABC' does not match '^[a-z]+$'",
    );
  });

  it("patternProperties et additionalProperties sains : appliqués, sans faux rejet", async () => {
    expect(await appeler("cles_saines", { sortie: { s_a: "x" } })).toMatchObject({
      structuredContent: { s_a: "x" },
    });
    await expect(appeler("cles_saines", { sortie: { s_a: 1 } })).rejects.toThrow(
      "Invalid structured content",
    );
    await expect(appeler("cles_saines", { sortie: { z: "x" } })).rejects.toThrow(
      "Invalid structured content",
    );
  });

  it("oneOf départagé par des pattern : exactement une branche, sans faux rejet", async () => {
    expect(await appeler("branches", { sortie: { n: "abc" } })).toMatchObject({
      structuredContent: { n: "abc" },
    });
    await expect(appeler("branches", { sortie: { n: "zzz" } })).rejects.toThrow("Invalid structured content");
  });

  it("schéma de taille moyenne : compilé, types appliqués", async () => {
    await expect(appeler("schema_moyen", { sortie: { p0: 1 } })).rejects.toThrow(
      "Invalid structured content returned by tool schema_moyen",
    );
    expect(alertes).toEqual([]);
  });
});
