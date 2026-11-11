// SPDX-License-Identifier: MIT
/** packages/outils-mcp/test/ressources-arguments.test.ts — ressources à gabarit d'URI (templates/list, read), arguments gardant leur forme Python (1.0, entiers longs), non finis en null, paramètres en mots-clés seuls. */
import type { Dict } from "@elpis/commun";
import { clesOrdonnees, FlottantPy, noterOrdreDesCles } from "@elpis/commun";
import { py } from "@elpis/http";
import { afterEach, describe, expect, it } from "vitest";

import { ok, tokenIdentity } from "../src/boite";
import { ouvrirEnMemoire } from "../src/memoire";
import type { ConnexionEnMemoire } from "../src/memoire";
import { ServeurOutils } from "../src/serveur";
import type { DefinitionOutil, DefinitionRessource } from "../src/serveur";
import { ClientBrut, CATEGORIE_TACHES } from "./aides";
import { demarrerTs, rejouer } from "./differentiel";
import type { Etape } from "./differentiel";

const ouvertes: ConnexionEnMemoire[] = [];

afterEach(async () => {
  for (const c of ouvertes.splice(0)) await c.fermer();
});

const lus: Dict[] = [];

function ressource(nom: string, modele: string): DefinitionRessource {
  return {
    nom,
    modele,
    description: `Ressource ${nom}.`,
    mimeType: "application/json",
    tags: ["task", "demo"],
    lire: (p) => {
      lus.push({ ...p, identite: tokenIdentity() });
      return `lu:${JSON.stringify(p)}`;
    },
  };
}

function outilBrut(brutes: Dict[]): DefinitionOutil {
  return {
    nom: "forme",
    famille: "todo",
    definition: {
      name: "forme",
      description: "Rend la forme des arguments.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      _meta: { category: CATEGORIE_TACHES, fastmcp: { tags: ["task"] } },
    },
    signature: { a: py.any(), b: py.any().defaut(null) },
    motsClesSeuls: true,
    traiter: (_valeurs, _ctx, brut) => {
      brutes.push(brut);
      return ok();
    },
  };
}

async function client(s: ServeurOutils): Promise<ClientBrut> {
  const c = await ouvrirEnMemoire(s);
  ouvertes.push(c);
  const b = new ClientBrut(c.transport);
  await b.demarrer();
  await b.initialiser();
  return b;
}

describe("ressources à gabarit d'URI", () => {
  const serveur = (taillePage = 100): ServeurOutils => {
    const s = new ServeurOutils({ taillePage, limiteDebit: null, limiteConcurrence: null });
    s.enregistrerFamille(
      "todo",
      [],
      [ressource("une", "demo://{compte}/{id}"), ressource("deux", "autre://{tout*}")],
    );
    return s;
  };

  it("resources/templates/list : champs et ordre de FastMCP, étiquettes triées ; resources/list vide", async () => {
    const b = await client(serveur());
    expect((await b.requete("resources/templates/list"))["result"]).toEqual({
      resourceTemplates: [
        {
          name: "une",
          uriTemplate: "demo://{compte}/{id}",
          description: "Ressource une.",
          mimeType: "application/json",
          _meta: { fastmcp: { tags: ["demo", "task"] } },
        },
        {
          name: "deux",
          uriTemplate: "autre://{tout*}",
          description: "Ressource deux.",
          mimeType: "application/json",
          _meta: { fastmcp: { tags: ["demo", "task"] } },
        },
      ],
    });
    expect((await b.requete("resources/list"))["result"]).toEqual({ resources: [] });
  });

  it("pagination par curseur, curseur invalide (-32602) sur les deux listes", async () => {
    const b = await client(serveur(1));
    const p1 = (await b.requete("resources/templates/list"))["result"] as Dict;
    expect((p1["resourceTemplates"] as Dict[]).map((t) => t["name"])).toEqual(["une"]);
    const p2 = (await b.requete("resources/templates/list", { cursor: p1["nextCursor"] }))["result"] as Dict;
    expect((p2["resourceTemplates"] as Dict[]).map((t) => t["name"])).toEqual(["deux"]);
    expect(p2["nextCursor"]).toBeUndefined();
    for (const methode of ["resources/templates/list", "resources/list"])
      expect((await b.requete(methode, { cursor: "zzz" }))["error"]).toEqual({
        code: -32602,
        message: "Invalid cursor: zzz",
      });
    expect((await b.requete("resources/list", { cursor: 5 }))["error"]).toMatchObject({ code: -32602 });
  });

  it("resources/read : URI normalisée, paramètres décodés, premier gabarit qui s'apparie, text/plain", async () => {
    const b = await client(serveur());
    lus.length = 0;
    const lire = async (uri: unknown): Promise<Dict> => b.requete("resources/read", { uri });
    expect((await lire("demo://alice/ab c"))["result"]).toEqual({
      contents: [
        { uri: "demo://alice/ab%20c", mimeType: "text/plain", text: 'lu:{"compte":"alice","id":"ab c"}' },
      ],
    });
    expect(((await lire("demo://%C3%A9/a%2Fb?x=1"))["result"] as Dict)["contents"]).toEqual([
      { uri: "demo://%C3%A9/a%2Fb?x=1", mimeType: "text/plain", text: 'lu:{"compte":"é","id":"a/b"}' },
    ]);
    expect(((await lire("autre://a/b/c"))["result"] as Dict)["contents"]).toEqual([
      { uri: "autre://a/b/c", mimeType: "text/plain", text: 'lu:{"tout":"a/b/c"}' },
    ]);
    expect(lus.map((l) => l["identite"])).toEqual([null, null, null]);
  });

  it("resources/read : URI sans gabarit -32002 (URI normalisée), URI invalide ou absente -32602", async () => {
    const b = await client(serveur());
    expect((await b.requete("resources/read", { uri: "demo://alice" }))["error"]).toEqual({
      code: -32002,
      message: "Resource not found: Unknown resource: 'demo://alice'",
    });
    expect((await b.requete("resources/read", { uri: "demo://alice/.." }))["error"]).toEqual({
      code: -32002,
      message: "Resource not found: Unknown resource: 'demo://alice/'",
    });
    for (const params of [{ uri: "nope" }, { uri: "" }, { uri: 5 }, {}])
      expect((await b.requete("resources/read", params))["error"]).toEqual({
        code: -32602,
        message: "Invalid request parameters",
        data: "",
      });
  });

  it("resources/read : demi-paire de substitution dans l'URI → -32602 ; échec de lecture → erreur 0 « Error reading resource » avec le texte d'un OSError Python", async () => {
    const s = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
    const lire = (p: Readonly<Record<string, string>>): string => {
      if (p["a"] === "os")
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES", path: "/tmp/x/y" });
      throw new Error("autre échec");
    };
    s.enregistrerFamille("todo", [], [{ ...ressource("casse", "casse://{a}"), lire }]);
    const b = await client(s);
    expect((await b.requete("resources/read", { uri: "casse://\ud800" }))["error"]).toMatchObject({
      code: -32602,
    });
    expect((await b.requete("resources/read", { uri: "casse://os" }))["error"]).toEqual({
      code: 0,
      message: "Error reading resource 'casse://os': [Errno 13] Permission denied: '/tmp/x/y'",
    });
    expect((await b.requete("resources/read", { uri: "casse://x" }))["error"]).toEqual({
      code: 0,
      message: "Error reading resource 'casse://x': autre échec",
    });
  });

  it("sans ressource enregistrée : toute URI valide est « Resource not found »", async () => {
    const s = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
    s.enregistrerFamille("todo", []);
    const b = await client(s);
    expect((await b.requete("resources/templates/list"))["result"]).toEqual({ resourceTemplates: [] });
    expect((await b.requete("resources/read", { uri: "demo://a/b" }))["error"]).toEqual({
      code: -32002,
      message: "Resource not found: Unknown resource: 'demo://a/b'",
    });
  });
});

describe("arguments d'un appel", () => {
  it("en mémoire : non finis → null, le reste rendu tel quel (flottant marqué, entier long, ordre Python des clés)", async () => {
    const brutes: Dict[] = [];
    const s = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
    s.enregistrerFamille("todo", [outilBrut(brutes)]);
    const b = await client(s);
    const imbrique: Dict = { y: 1 };
    Object.assign(imbrique, { 2: "deux", 1: "un" });
    noterOrdreDesCles(imbrique, ["y", "2", "1"]);
    const lisse = { a: [new FlottantPy(1), 2n ** 70n], b: imbrique };
    const r = await b.appeler("forme", lisse);
    expect(r["isError"]).toBe(false);
    expect(brutes[0]?.["a"]).toBe(lisse.a);
    expect(brutes[0]?.["b"]).toBe(imbrique);
    await b.appeler("forme", {
      a: [new FlottantPy(NaN), NaN, Infinity, new FlottantPy(-Infinity), 1.5],
      b: { z: NaN, 1: 1, 2: 2 },
    });
    expect(brutes[1]).toEqual({ a: [null, null, null, null, 1.5], b: { z: null, 1: 1, 2: 2 } });
    const nanOrdonne: Dict = { 2: NaN, 1: 1 };
    noterOrdreDesCles(nanOrdonne, ["2", "1"]);
    await b.appeler("forme", { a: 0, b: nanOrdonne });
    expect(clesOrdonnees(brutes[2]?.["b"] as Dict)).toEqual(["2", "1"]);
    expect(brutes[2]?.["b"]).toEqual({ 1: 1, 2: null });
    expect(brutes[2]?.["b"]).not.toBe(nanOrdonne);
  });

  it("paramètres en mots-clés seuls : message et type de pydantic, absence d'un requis puis argument inattendu", async () => {
    const s = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
    s.enregistrerFamille("todo", [outilBrut([])]);
    const b = await client(s);
    const r = await b.appeler("forme", { zzz: 1 });
    expect(r["isError"]).toBe(true);
    expect(((r["content"] as Dict[])[0] as Dict)["text"]).toBe(
      "2 validation errors for call[forme]\na\n  Missing required keyword only argument [type=missing_keyword_only_argument, input_value={'zzz': 1}, input_type=dict]\n    For further information visit https://errors.pydantic.dev/2.13/v/missing_keyword_only_argument\nzzz\n  Unexpected keyword argument [type=unexpected_keyword_argument, input_value=1, input_type=int]\n    For further information visit https://errors.pydantic.dev/2.13/v/unexpected_keyword_argument",
    );
  });
});

describe("messages SSE", () => {
  it("corps refusé comme model_validate_json : BOM, UTF-8 invalide, demi-paire → 400 « Could not parse message » ; NaN accepté", async () => {
    const s = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
    s.enregistrerFamille("todo", [outilBrut([])]);
    const cible = await demarrerTs({ serveur: s, verificateur: null, transport: "sse" });
    try {
      const ouvert = await fetch(cible.base + "/sse", { headers: { accept: "text/event-stream" } });
      const lecteur = (ouvert.body as ReadableStream<Uint8Array>).getReader();
      const premier = new TextDecoder().decode((await lecteur.read()).value);
      const endpoint = /data: (\S+)/u.exec(premier)?.[1] ?? "";
      const poster = async (corps: Uint8Array | string): Promise<[number, string]> => {
        const r = await fetch(cible.base + endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: typeof corps === "string" ? corps : Buffer.from(corps),
        });
        return [r.status, await r.text()];
      };
      const ping = '{"jsonrpc":"2.0","id":7,"method":"ping"}';
      expect(await poster(ping)).toEqual([202, "Accepted"]);
      expect(await poster("\ufeff" + ping)).toEqual([400, "Could not parse message"]);
      expect(await poster(new Uint8Array([0x7b, 0xff, 0x7d]))).toEqual([400, "Could not parse message"]);
      expect(await poster(ping.replace("ping", "x\\ud800"))).toEqual([400, "Could not parse message"]);
      const avecNan =
        '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"forme","arguments":{"a":NaN}}}';
      expect(await poster(avecNan)).toEqual([202, "Accepted"]);
      await lecteur.cancel();
    } finally {
      await cible.arreter();
    }
  });
});

describe("arguments reçus par HTTP", () => {
  const H = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const S = { ...H, "mcp-session-id": "$sid:s", "mcp-protocol-version": "2025-06-18" };

  it("tools/call et messages SSE : 1.0, 100.0, entiers longs et NaN arrivent en forme Python, NaN en null ; le reste de la requête reste ordinaire", async () => {
    const brutes: Dict[] = [];
    const s = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
    s.enregistrerFamille("todo", [outilBrut(brutes)]);
    const corps = (id: number): string =>
      `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"forme","arguments":{"a":[1.0,100.0,12345678901234567890,9007199254740993,1e2,NaN,2.5,-0.0],"b":{"2":1.0,"1":2}},"_meta":{"x":1.0}}}`;
    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    };
    const notif = { jsonrpc: "2.0", method: "notifications/initialized" };
    const CT = { "content-type": "application/json" };
    for (const transport of ["http", "sse"] as const) {
      brutes.length = 0;
      const cible = await demarrerTs({ serveur: s, verificateur: null, transport });
      try {
        const etapes: Etape[] =
          transport === "http"
            ? [
                { m: "POST", u: "/mcp", h: H, garder: "s", corps: init },
                { m: "POST", u: "/mcp", h: S, corps: notif },
                { m: "POST", u: "/mcp", h: S, corps: corps(2) },
              ]
            : [
                { sse: "/sse", h: { accept: "text/event-stream" }, nom: "e" },
                { m: "POST", u: "$ep:e", h: CT, corps: init },
                { lire: "e", n: 1 },
                { m: "POST", u: "$ep:e", h: CT, corps: notif },
                { m: "POST", u: "$ep:e", h: CT, corps: corps(2) },
                { lire: "e", n: 1 },
                { fermer: "e" },
              ];
        const reponses = await rejouer(etapes, cible.base);
        const derniere = reponses.at(-1) as Dict;
        const evenements = (transport === "http" ? derniere["corps"] : derniere["evenements"]) as Dict[];
        expect(((evenements[0]?.["data"] as Dict)["result"] as Dict)["isError"]).toBe(false);
        const a = brutes[0]?.["a"] as unknown[];
        expect(
          a.map((v) =>
            v instanceof FlottantPy
              ? `f${v.valeur}`
              : typeof v === "bigint"
                ? `i${v}`
                : v === null
                  ? "null"
                  : `n${String(v)}`,
          ),
        ).toEqual(["f1", "f100", "i12345678901234567890", "i9007199254740993", "f100", "null", "n2.5", "f0"]);
        expect(clesOrdonnees(brutes[0]?.["b"] as Dict)).toEqual(["2", "1"]);
      } finally {
        await cible.arreter();
      }
    }
  });
});
