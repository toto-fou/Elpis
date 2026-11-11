// SPDX-License-Identifier: MIT
/** apps/core/test/mcp/chart.test.ts — famille chart en processus : 30 outils figés par le golden, tailles, enveloppes d'échec, cache, ressource chart://, arguments par HTTP (sans Python). */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FlottantPy, pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { ServeurOutils } from "@elpis/outils-mcp";
import type { ContexteAppel, JetonAcces } from "@elpis/outils-mcp";
import golden from "@elpis/outils-mcp/goldens/chart.json" with { type: "json" };
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { demarrerTs, rejouer } from "../../../../packages/outils-mcp/test/differentiel";
import { ClientBrut } from "../../../../packages/outils-mcp/test/aides";
import { ouvrirEnMemoire } from "../../../../packages/outils-mcp/src/memoire";
import type { ConnexionEnMemoire } from "../../../../packages/outils-mcp/src/memoire";
import { PER_TYPE, reinitialiserRefus, toolDescription } from "../../src/graphiques/moteur/index";
import {
  finish,
  limites,
  MAX_CELLS_DEFAUT,
  MAX_ROWS_DEFAUT,
  outilsChart,
  ressourcesChart,
  tooBig,
} from "../../src/outils/mcp/famille-chart";
import { A, EXEMPLES, J } from "./chart-scenarios";

const VENTES = [
  { m: "a", v: 1 },
  { m: "b", v: 2 },
];

let racine = "";

beforeAll(() => {
  racine = mkdtempSync(join(tmpdir(), "elpis-chart-"));
});

afterAll(() => {
  rmSync(racine, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("CHART_CACHE_DIR", join(racine, "cache"));
  reinitialiserRefus();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(join(racine, "cache"), { recursive: true, force: true });
});

function ctx(meta: Dict | null): ContexteAppel {
  return { meta } as unknown as ContexteAppel;
}

const fichiers = (compte: string): string[] =>
  existsSync(join(racine, "cache", compte)) ? readdirSync(join(racine, "cache", compte)).sort() : [];

describe("définition des outils", () => {
  it("30 outils chart_<type>, dans l'ordre et avec la description du golden ; mots-clés seuls", () => {
    const outils = outilsChart();
    expect(outils.map((o) => o.nom)).toEqual([...PER_TYPE.keys()].map((k) => `chart_${k}`));
    expect(outils.map((o) => o.nom)).toEqual(golden.outils.map((o) => o.name));
    for (const o of outils) {
      expect(o.famille).toBe("chart");
      expect(o.motsClesSeuls).toBe(true);
      expect(o.definition["description"]).toBe(toolDescription(o.nom.slice("chart_".length)));
    }
    expect(Object.keys(EXEMPLES)).toEqual([...PER_TYPE.keys()]);
  });

  it("une ressource chart://{username}/{chart_id}", () => {
    expect(ressourcesChart().map((r) => [r.nom, r.modele, r.mimeType, r.tags])).toEqual([
      ["chart_resource", "chart://{username}/{chart_id}", "application/json", ["chart"]],
    ]);
  });
});

describe("tailles", () => {
  it("_too_big : lignes, cellules des seules lignes objets, autre forme que tableau jamais trop grande", () => {
    expect(tooBig([{ a: 1 }, { a: 2 }, { a: 3 }], 2, 99)).toBe(true);
    expect(tooBig([{ a: 1 }, { a: 2 }], 2, 99)).toBe(false);
    expect(
      tooBig(
        [
          { a: 1, b: 2, c: 3 },
          { a: 1, b: 2 },
        ],
        9,
        5,
      ),
    ).toBe(false);
    expect(
      tooBig(
        [
          { a: 1, b: 2, c: 3 },
          { a: 1, b: 2, c: 3 },
        ],
        9,
        5,
      ),
    ).toBe(true);
    expect(tooBig([[1, 2, 3, 4, 5, 6, 7], "texte", null], 9, 5)).toBe(false);
    expect(tooBig({ a: Array.from({ length: 99 }, (_, i) => i) }, 1, 1)).toBe(false);
    expect(tooBig("x".repeat(99), 1, 1)).toBe(false);
  });

  it("limites : TOOL_CHART_MAX_ROWS et TOOL_CHART_MAX_CELLS lus à l'appel, 1 au minimum, défaut si illisibles", () => {
    expect(limites()).toEqual({ rows: MAX_ROWS_DEFAUT, cells: MAX_CELLS_DEFAUT });
    vi.stubEnv("TOOL_CHART_MAX_ROWS", "3");
    vi.stubEnv("TOOL_CHART_MAX_CELLS", " 12 ");
    expect(limites()).toEqual({ rows: 3, cells: 12 });
    vi.stubEnv("TOOL_CHART_MAX_ROWS", "0");
    vi.stubEnv("TOOL_CHART_MAX_CELLS", "beaucoup");
    expect(limites()).toEqual({ rows: 1, cells: MAX_CELLS_DEFAUT });
    vi.stubEnv("TOOL_CHART_MAX_ROWS", "");
    expect(limites().rows).toBe(MAX_ROWS_DEFAUT);
  });

  it("données trop grandes : enveloppe invalid_chart_spec avec le correctif, rien écrit", () => {
    vi.stubEnv("TOOL_CHART_MAX_ROWS", "3");
    const r = finish("line", { data: Array.from({ length: 5 }, (_, i) => ({ x: i, y: i })) }, ctx(null));
    expect(r).toEqual({
      ok: false,
      error: "invalid_chart_spec",
      message: "data is too large (max 3 rows / 60000 cells)",
      fix: "Aggregate or downsample the rows before charting.",
    });
    expect(fichiers("guest")).toEqual([]);
  });
});

describe("_finish", () => {
  it("écrit l'option sous le compte de l'identité, rend ref et chart_id puis le résumé, dossier 0700 et fichier 0600", () => {
    const r = finish("bar", { data: VENTES, title: "T" }, ctx({ username: "alice", chat_id: "c1" }));
    expect(r).toEqual({
      ok: true,
      ref: "!abc53bd62331",
      chart_id: "abc53bd62331",
      summary: "bar · x=m (2) · series: v",
      chart_type: "bar",
    });
    expect(Object.keys(r)).toEqual(["ok", "ref", "chart_id", "summary", "chart_type"]);
    expect(fichiers("alice")).toEqual(["abc53bd62331.json"]);
    const option = pyJsonLoads(
      readFileSync(join(racine, "cache", "alice", "abc53bd62331.json"), "utf8"),
    ) as Dict;
    expect((option["title"] as Dict)["text"]).toBe("T");
    expect(statSync(join(racine, "cache", "alice")).mode & 0o777).toBe(0o700);
    expect(statSync(join(racine, "cache", "alice", "abc53bd62331.json")).mode & 0o777).toBe(0o600);
    expect(finish("bar", { data: VENTES, title: "T" }, ctx({ username: "alice" }))["chart_id"]).toBe(
      "abc53bd62331",
    );
  });

  it("sans identité : compte guest ; corrections (fixes) et avertissements (warnings) rendus après le résumé", () => {
    const r = finish(
      "bar",
      {
        x: "MOIS",
        y: ["Ventes"],
        data: [
          { mois: "a", ventes: "1 200 €" },
          { mois: "b", ventes: 2 },
        ],
      },
      null,
    );
    expect(r["ok"]).toBe(true);
    expect(Object.keys(r)).toEqual(["ok", "ref", "chart_id", "summary", "chart_type", "fixes"]);
    expect(fichiers("guest")).toHaveLength(1);
  });

  it("un refus du moteur est rendu tel quel, avec un exemple ; le même appel renvoyé est dit répété (par compte et conversation)", () => {
    const appel = { data: [{ jour: "lun.", appels: 3 }] };
    const un = finish("heatmap", appel, ctx({ username: "alice", chat_id: "c1" }));
    expect(un).toMatchObject({ ok: false, error: "invalid_chart_spec" });
    expect((un["example"] as Dict)["data"]).toBeTruthy();
    expect(un["repeated"]).toBeUndefined();
    const deux = finish("heatmap", appel, ctx({ username: "alice", chat_id: "c1" }));
    expect(deux).toMatchObject({ error: "repeated_call", repeated: 2 });
    expect(finish("heatmap", appel, ctx({ username: "alice", chat_id: "c2" }))["repeated"]).toBeUndefined();
    expect(finish("heatmap", appel, ctx({ username: "bob", chat_id: "c1" }))["repeated"]).toBeUndefined();
    expect(fichiers("alice")).toEqual([]);
  });

  it("nombre non fini dans l'option : invalid_chart_spec « non-finite », rien d'écrit", () => {
    const r = finish(
      "table",
      {
        data: [
          { m: "a", v: new FlottantPy(Infinity) },
          { m: "b", v: 2 },
        ],
      },
      null,
    );
    expect(r).toEqual({
      ok: false,
      error: "invalid_chart_spec",
      message: "chart contains non-finite numbers (NaN/Infinity)",
      fix: "All numeric values must be finite.",
    });
    expect(fichiers("guest")).toEqual([]);
  });

  it("cache non inscriptible : chart_write_failed avec le message du système (« [Errno N] … »)", () => {
    mkdirSync(racine, { recursive: true });
    const fichier = join(racine, "pas-un-dossier");
    writeFileSync(fichier, "x");
    vi.stubEnv("CHART_CACHE_DIR", join(fichier, "sous"));
    const r = finish("bar", { data: VENTES }, null);
    expect(r["ok"]).toBe(false);
    expect(r["error"]).toBe("chart_write_failed");
    expect(r["message"]).toMatch(
      /^Could not save the chart: \[Errno (20|17)\] (Not a directory|File exists): '/u,
    );
    expect(r["fix"]).toContain("cache directory is writable");
    if (process.geteuid?.() === 0) return;
    const lecture = join(racine, "lecture-seule");
    mkdirSync(lecture, { recursive: true });
    chmodSync(lecture, 0o500);
    try {
      vi.stubEnv("CHART_CACHE_DIR", lecture);
      expect(finish("bar", { data: VENTES }, null)["message"]).toBe(
        `Could not save the chart: [Errno 13] Permission denied: '${join(lecture, "guest")}'`,
      );
    } finally {
      chmodSync(lecture, 0o700);
    }
  });

  it("les valeurs par défaut ne partent pas au moteur (aucune correction parasite)", () => {
    const r = finish(
      "bar",
      { data: VENTES, title: "", unit: "", stack: "none", sort: "none", horizontal: false },
      null,
    );
    expect(r["fixes"]).toBeUndefined();
  });
});

describe("service MCP en mémoire", () => {
  const ouvertes: ConnexionEnMemoire[] = [];

  afterEach(async () => {
    for (const c of ouvertes.splice(0)) await c.fermer();
  });

  function serveur(): ServeurOutils {
    const s = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
    s.enregistrerFamille("chart", outilsChart(), ressourcesChart());
    return s;
  }

  async function client(jeton: JetonAcces | null = null): Promise<ClientBrut> {
    const c = await ouvrirEnMemoire(serveur(), { jeton });
    ouvertes.push(c);
    const b = new ClientBrut(c.transport);
    await b.demarrer();
    await b.initialiser();
    return b;
  }

  const texte = (r: Dict): string => ((r["content"] as Dict[])[0] as Dict)["text"] as string;
  const META = { username: "alice", chat_id: "c1" };

  it("tools/list : les 30 définitions du golden, titre rempli ; chaque exemple donne un graphique", async () => {
    const b = await client();
    const liste = ((await b.requete("tools/list"))["result"] as Dict)["tools"] as Dict[];
    expect(liste.map((t) => t["name"])).toEqual(golden.outils.map((t) => t["name"]));
    expect(liste[0]?.["title"]).toBe("Chart Bar");
    for (const [type, args] of Object.entries(EXEMPLES)) {
      if (type === "gantt") continue;
      const r = await b.appeler(`chart_${type}`, args, META);
      expect(r["isError"], `${type} : ${texte(r)}`).toBe(false);
      expect((r["structuredContent"] as Dict)["result"]).toMatchObject({ ok: true, chart_type: type });
    }
    expect(fichiers("alice").length).toBeGreaterThanOrEqual(25);
  });

  it("validation permissive : « Stacked » et les booléens en texte passent, un booléen inconnu, un argument inconnu ou un titre numérique sont refusés", async () => {
    const b = await client();
    const bon = await b.appeler(
      "chart_bar",
      { data: VENTES, stack: "Stacked", horizontal: "yes", trend: 1 },
      META,
    );
    expect(bon["isError"]).toBe(false);
    expect(((bon["structuredContent"] as Dict)["result"] as Dict)["summary"]).toMatch(
      /^bar horizontal stacked/u,
    );
    for (const [args, attendu] of [
      [
        { data: VENTES, horizontal: "peut-etre" },
        "Input should be a valid boolean, unable to interpret input [type=bool_parsing",
      ],
      [{ data: VENTES, palette: "x" }, "Unexpected keyword argument [type=unexpected_keyword_argument"],
      [{ data: VENTES, title: 5 }, "Input should be a valid string [type=string_type"],
      [{}, "Missing required keyword only argument [type=missing_keyword_only_argument"],
    ] as [Dict, string][]) {
      const r = await b.appeler("chart_bar", args, META);
      expect(r["isError"]).toBe(true);
      expect(texte(r)).toContain(attendu);
    }
    expect((await b.appeler("chart_pie", { data: VENTES, stack: "stacked" }, META))["isError"]).toBe(true);
  });

  it("un échec du moteur est un résultat isError dont le texte est l'enveloppe JSON (error, message, fix, example)", async () => {
    const b = await client();
    const r = await b.appeler("chart_table", { data: [{}] }, META);
    expect(r["isError"]).toBe(true);
    expect(Object.keys(JSON.parse(texte(r)) as Dict)).toEqual(["ok", "error", "message", "fix", "example"]);
  });

  it("ressource chart:// : lue sous le même texte que le fichier ; absente → chart_not_found ; gabarit listé", async () => {
    const b = await client();
    const r = (await b.appeler("chart_bar", { data: VENTES, title: "T" }, META))["structuredContent"] as Dict;
    const id = (r["result"] as Dict)["chart_id"] as string;
    const fichier = readFileSync(join(racine, "cache", "alice", `${id}.json`), "utf8");
    const lu = (await b.requete("resources/read", { uri: `chart://alice/${id}` }))["result"] as Dict;
    expect(lu["contents"]).toEqual([{ uri: `chart://alice/${id}`, mimeType: "text/plain", text: fichier }]);
    const absent = (await b.requete("resources/read", { uri: "chart://alice/zzzzzzzzzzzz" }))[
      "result"
    ] as Dict;
    expect(((absent["contents"] as Dict[])[0] as Dict)["text"]).toBe(
      '{"ok": false, "error": "chart_not_found", "chart_id": "zzzzzzzzzzzz"}',
    );
    await b.requete("resources/read", { uri: "chart://carol/zzzzzzzzzzzz" });
    expect(existsSync(join(racine, "cache", "carol"))).toBe(false);
    const modeles = ((await b.requete("resources/templates/list"))["result"] as Dict)[
      "resourceTemplates"
    ] as Dict[];
    expect(modeles.map((m) => m["uriTemplate"])).toEqual(["chart://{username}/{chart_id}"]);
  });

  it("ressource chart:// et jeton client : seulement les graphiques de son propre compte (écart « plus strict »)", async () => {
    const service = await client();
    const id = (
      ((await service.appeler("chart_bar", { data: VENTES, title: "T" }, META))["structuredContent"] as Dict)[
        "result"
      ] as Dict
    )["chart_id"] as string;
    const jeton = (username: string): JetonAcces => ({
      token: "t",
      client_id: "cli",
      scopes: ["local-tools"],
      expires_at: null,
      claims: { username, families: ["chart"] },
    });
    const lire = async (b: ClientBrut, compte: string): Promise<string> => {
      const r = (await b.requete("resources/read", { uri: `chart://${compte}/${id}` }))["result"] as Dict;
      return ((r["contents"] as Dict[])[0] as Dict)["text"] as string;
    };
    const bob = await client(jeton("bob"));
    expect(await lire(bob, "alice")).toBe(`{"ok": false, "error": "chart_not_found", "chart_id": "${id}"}`);
    const alice = await client(jeton("alice"));
    expect(await lire(alice, "alice")).toContain('"series"');
    expect(await lire(service, "alice")).toContain('"series"');
    const ecrit = await bob.appeler("chart_bar", { data: VENTES, title: "T" }, { username: "mallory" });
    expect(ecrit["isError"]).toBe(false);
    expect(fichiers("bob")).toEqual([`${id}.json`]);
    expect(fichiers("mallory")).toEqual([]);
  });

  it("ressource chart:// et compte non ASCII : le dossier est celui de l'écriture (« é-dev » → « -dev »), le propriétaire relit ses graphiques", async () => {
    const jeton: JetonAcces = {
      token: "t",
      client_id: "cli",
      scopes: ["local-tools"],
      expires_at: null,
      claims: { username: "é-dev", families: ["chart"] },
    };
    const b = await client(jeton);
    const id = (
      ((await b.appeler("chart_bar", { data: VENTES }, { username: "autre" }))["structuredContent"] as Dict)[
        "result"
      ] as Dict
    )["chart_id"] as string;
    expect(fichiers("-dev")).toEqual([`${id}.json`]);
    const lire = async (compte: string): Promise<string> => {
      const r = (await b.requete("resources/read", { uri: `chart://${encodeURIComponent(compte)}/${id}` }))[
        "result"
      ] as Dict;
      return ((r["contents"] as Dict[])[0] as Dict)["text"] as string;
    };
    expect(await lire("-dev")).toContain('"series"');
    expect(await lire("alice")).toContain("chart_not_found");
  });
});

describe("arguments reçus par HTTP", () => {
  const S = { ...J, ...A, "mcp-session-id": "$sid:c", "mcp-protocol-version": "2025-06-18" };

  it("1.0 et 1 donnent deux graphiques, NaN vaut null, l'ordre des clés entières est celui de l'appel", async () => {
    const serveur = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
    serveur.enregistrerFamille("chart", outilsChart(), ressourcesChart());
    const cible = await demarrerTs({ serveur, verificateur: null, transport: "http" });
    const brut = (id: number, arguments_: string): string =>
      `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"chart_bar","arguments":${arguments_},"_meta":{"username":"alice","chat_id":"c1"}}}`;
    try {
      const entetes = { ...J, ...A };
      const r = await rejouer(
        [
          {
            m: "POST",
            u: "/mcp/chart",
            h: entetes,
            garder: "c",
            corps: {
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "t", version: "1" },
              },
            },
          },
          {
            m: "POST",
            u: "/mcp/chart",
            h: S,
            corps: { jsonrpc: "2.0", method: "notifications/initialized" },
          },
          {
            m: "POST",
            u: "/mcp/chart",
            h: S,
            corps: brut(2, '{"data":[{"m":"a","v":1.0},{"m":"b","v":2}]}'),
          },
          { m: "POST", u: "/mcp/chart", h: S, corps: brut(3, '{"data":[{"m":"a","v":1},{"m":"b","v":2}]}') },
          {
            m: "POST",
            u: "/mcp/chart",
            h: S,
            corps: brut(4, '{"data":[{"m":"a","v":NaN},{"m":"b","v":2}]}'),
          },
          {
            m: "POST",
            u: "/mcp/chart",
            h: S,
            corps: brut(5, '{"data":[{"m":"a","v":null},{"m":"b","v":2}]}'),
          },
          {
            m: "POST",
            u: "/mcp/chart",
            h: S,
            corps: brut(6, '{"data":[{"2":"a","1":5,"b":4},{"2":"b","1":7,"b":3}]}'),
          },
        ],
        cible.base,
      );
      const resultat = (i: number): Dict => {
        const corps = (r[i] as Dict)["corps"] as Dict[];
        return ((corps[0] as Dict)["data"] as Dict)["result"] as Dict;
      };
      const id = (i: number): unknown =>
        ((resultat(i)["structuredContent"] as Dict)["result"] as Dict)["chart_id"];
      expect(new Set([id(2), id(3)]).size).toBe(2);
      expect(id(4)).toBe(id(5));
      const ordre = (resultat(6)["structuredContent"] as Dict)["result"] as Dict;
      expect(ordre["summary"]).toBe("bar · x=2 (2) · series: 1, b");
    } finally {
      await cible.arreter();
    }
  });
});
