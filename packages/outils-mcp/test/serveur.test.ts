// SPDX-License-Identifier: MIT
/** packages/outils-mcp/test/serveur.test.ts — serveur des familles en mémoire : initialize, liste paginée, appel, middlewares, notifications, identité. */
import type { Dict } from "@elpis/commun";
import { py } from "@elpis/http";
import { avecIdentite, creerIdentite, current } from "@elpis/securite";
import { afterEach, describe, expect, it } from "vitest";

import { ok } from "../src/boite";
import type { JetonAcces } from "../src/contexte";
import { LimiteConcurrence, LimiteDebit } from "../src/limites";
import { ouvrirEnMemoire } from "../src/memoire";
import type { ConnexionEnMemoire } from "../src/memoire";
import {
  CAPACITES,
  decoderCurseur,
  encoderCurseur,
  SERVER_INSTRUCTIONS,
  ServeurOutils,
} from "../src/serveur";
import type { DefinitionOutil, OptionsServeur } from "../src/serveur";
import { ClientBrut, outilsGit, outilsMemoire, outilsTodo } from "./aides";

const ouvertes: ConnexionEnMemoire[] = [];

afterEach(async () => {
  for (const c of ouvertes.splice(0)) await c.fermer();
});

function serveur(o: OptionsServeur = {}, journal: unknown[] = []): ServeurOutils {
  const s = new ServeurOutils({
    version: "9.9.9",
    famillesOpencode: ["git"],
    limiteDebit: null,
    limiteConcurrence: null,
    ...o,
  });
  s.enregistrerFamille("todo", outilsTodo(journal));
  s.enregistrerFamille("memory", outilsMemoire());
  s.enregistrerFamille("git", outilsGit());
  return s;
}

async function client(
  s: ServeurOutils,
  o: { famille?: string | null; jeton?: JetonAcces | null } = {},
): Promise<ClientBrut> {
  const c = await ouvrirEnMemoire(s, o);
  ouvertes.push(c);
  const b = new ClientBrut(c.transport);
  await b.demarrer();
  await b.initialiser();
  return b;
}

const jeton = (claims: Dict): JetonAcces => ({
  token: "t",
  client_id: "c",
  scopes: ["local-tools"],
  expires_at: null,
  claims,
});
const noms = (r: Dict): string[] =>
  ((r["result"] as Dict)["tools"] as Dict[]).map((t) => t["name"] as string);

describe("initialize", () => {
  it("capacités de FastMCP, serverInfo, instructions ; version inconnue (2024-10-07 compris) → la plus récente", async () => {
    const s = serveur();
    const c = await ouvrirEnMemoire(s);
    ouvertes.push(c);
    const b = new ClientBrut(c.transport);
    await b.demarrer();
    const r = (await b.initialiser("2025-06-18"))["result"] as Dict;
    expect(r).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: CAPACITES,
      serverInfo: { name: "local-tools", version: "9.9.9" },
      instructions: SERVER_INSTRUCTIONS,
    });
    expect(Object.keys(r)).toEqual(["protocolVersion", "capabilities", "serverInfo", "instructions"]);
    expect(((await b.initialiser("2024-10-07"))["result"] as Dict)["protocolVersion"]).toBe("2025-11-25");
  });
});

describe("tools/list", () => {
  it("tous les outils dans l'ordre d'enregistrement, titre rempli sans écraser title ni annotations.title", async () => {
    const b = await client(serveur());
    const r = await b.requete("tools/list");
    const outils = (r["result"] as Dict)["tools"] as Dict[];
    expect(outils.map((t) => t["name"])).toEqual([...outilsTodo().map((o) => o.nom), "memory", "git_query"]);
    expect(outils[0]).toMatchObject({ name: "echo", title: "Echo" });
    expect(Object.keys(outils[0] as Dict).slice(0, 3)).toEqual(["name", "title", "description"]);
    expect(outils.find((t) => t["name"] === "titre_donne")?.["title"]).toBe("Titre Donné");
    expect(outils.find((t) => t["name"] === "titre_annote")).not.toHaveProperty("title");
    expect(outils.find((t) => t["name"] === "echec_enveloppe")?.["title"]).toBe("Echec Enveloppe");
  });

  it("pagination par curseur FastMCP ; curseur invalide → -32602", async () => {
    const b = await client(serveur({ taillePage: 4 }));
    const p1 = (await b.requete("tools/list"))["result"] as Dict;
    expect((p1["tools"] as Dict[]).length).toBe(4);
    expect(p1["nextCursor"]).toBe(encoderCurseur(4));
    expect(Buffer.from(p1["nextCursor"] as string, "base64url").toString()).toBe('{"o": 4}');
    const vus: string[] = [];
    let curseur: unknown = undefined;
    do {
      const p = (await b.requete("tools/list", curseur === undefined ? {} : { cursor: curseur }))[
        "result"
      ] as Dict;
      vus.push(...(p["tools"] as Dict[]).map((t) => t["name"] as string));
      curseur = p["nextCursor"];
    } while (curseur !== undefined);
    expect(vus.length).toBe(12);
    expect(await b.requete("tools/list", { cursor: "zzz" })).toMatchObject({
      error: { code: -32602, message: "Invalid cursor: zzz" },
    });
    expect(decoderCurseur("eyJvIjogMn0=")).toBe(2);
    expect(() => decoderCurseur("eyJvIjogMn0")).toThrow("Invalid cursor");
  });

  it("portée de session, opencode, jeton d'outils, délégation sans famille, extinctions", async () => {
    const s = serveur({ outilsEteints: () => ["texte_brut", "inexistant"] });
    expect(noms(await (await client(s, { famille: "memory" })).requete("tools/list"))).toEqual(["memory"]);
    expect(
      noms(await (await client(s, { jeton: jeton({ client_kind: "opencode" }) })).requete("tools/list")),
    ).toEqual(["git_query"]);
    const outilsGitMem = await client(s, {
      jeton: jeton({ client_kind: "tools", families: ["git", "memory"] }),
    });
    expect(noms(await outilsGitMem.requete("tools/list"))).toEqual(["memory", "git_query"]);
    expect(
      noms(
        await (
          await client(s, { jeton: jeton({ client_kind: "tools", families: [] }) })
        ).requete("tools/list"),
      ),
    ).toEqual([]);
    expect(
      noms(
        await (
          await client(s, { jeton: jeton({ client_kind: "oauth", delegated: true, families: [] }) })
        ).requete("tools/list"),
      ),
    ).toEqual([]);
    expect(
      noms(
        await (await client(s, { jeton: jeton({ client_kind: "x", families: [] }) })).requete("tools/list"),
      ),
    ).toHaveLength(11);
    const portee = await client(s, {
      famille: "git",
      jeton: jeton({ client_kind: "tools", families: ["memory"] }),
    });
    expect(noms(await portee.requete("tools/list"))).toEqual([]);
    expect(noms(await (await client(s)).requete("tools/list"))).not.toContain("texte_brut");
  });
});

describe("tools/call", () => {
  it("outil inconnu, éteint ou caché : même erreur de protocole -32602, aucun oracle", async () => {
    const s = serveur({ outilsEteints: () => ["texte_brut"] });
    const b = await client(s, { famille: "todo" });
    for (const nom of ["inconnu", "texte_brut", "memory"])
      expect(await b.requete("tools/call", { name: nom, arguments: {} })).toMatchObject({
        error: { code: -32602, message: `Unknown tool: '${nom}'` },
      });
  });

  it("succès : texte JSON de pydantic + structuredContent ; texte brut sans structure", async () => {
    const b = await client(serveur());
    expect(await b.appeler("echo", { texte: "é", n: "3" })).toEqual({
      content: [{ type: "text", text: '{"ok":true,"texte":"é","n":3}' }],
      structuredContent: { ok: true, texte: "é", n: 3 },
      isError: false,
    });
    expect(await b.appeler("texte_brut")).toEqual({
      content: [{ type: "text", text: "bonjour" }],
      isError: false,
    });
  });

  it("un dict rendu qui porte « type » (read_file d'un texte) reste un dict ; seul un bloc de forme exacte passe tel quel", async () => {
    const def = (nom: string, traiter: DefinitionOutil["traiter"]): DefinitionOutil => ({
      nom,
      famille: "fs",
      definition: { name: nom, description: nom, inputSchema: { type: "object", properties: {} } },
      signature: {},
      traiter,
    });
    const s = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
    s.enregistrerFamille("fs", [
      def("lire", () => ok({ type: "text", content: "x" })),
      def("bloc", () => ({ type: "text", text: "brut" })),
    ]);
    const b = await client(s);
    expect(await b.appeler("lire")).toEqual({
      content: [{ type: "text", text: '{"ok":true,"type":"text","content":"x"}' }],
      structuredContent: { ok: true, type: "text", content: "x" },
      isError: false,
    });
    expect(await b.appeler("bloc")).toMatchObject({
      content: [{ type: "text", text: "brut" }],
      isError: false,
    });
  });

  it("arguments invalides : texte de la ValidationError en isError", async () => {
    const b = await client(serveur());
    expect(await b.appeler("echo", { n: "x", z: 1 })).toEqual({
      content: [
        {
          type: "text",
          text:
            "3 validation errors for call[echo]\ntexte\n  Missing required argument [type=missing_argument, input_value={'n': 'x', 'z': 1}, input_type=dict]\n    For further information visit https://errors.pydantic.dev/2.13/v/missing_argument\n" +
            "n\n  Input should be a valid integer, unable to parse string as an integer [type=int_parsing, input_value='x', input_type=str]\n    For further information visit https://errors.pydantic.dev/2.13/v/int_parsing\n" +
            "z\n  Unexpected keyword argument [type=unexpected_keyword_argument, input_value=1, input_type=int]\n    For further information visit https://errors.pydantic.dev/2.13/v/unexpected_keyword_argument",
        },
      ],
      isError: true,
    });
  });

  it("{ok:false} → isError, enveloppe en json.dumps espacé ; exception → « Error calling tool » ; ToolError → message", async () => {
    const b = await client(serveur());
    expect(await b.appeler("echec_enveloppe")).toEqual({
      content: [
        {
          type: "text",
          text: '{"ok": false, "error": "bad_path", "message": "chemin hors du bac — é", "fix": "relatif"}',
        },
      ],
      isError: true,
    });
    expect(await b.appeler("echec_leve")).toEqual({
      content: [{ type: "text", text: "Error calling tool 'echec_leve': boum" }],
      isError: true,
    });
    expect(await b.appeler("echec_outil")).toEqual({
      content: [{ type: "text", text: "refus net" }],
      isError: true,
    });
  });

  it("sortie enveloppée (x-fastmcp-wrap-result) et sortie validée contre outputSchema", async () => {
    const b = await client(serveur());
    expect(await b.appeler("enveloppe")).toEqual({
      _meta: { fastmcp: { wrap_result: true } },
      content: [{ type: "text", text: '{"ok":true,"v":1.5}' }],
      structuredContent: { result: { ok: true, v: 1.5 } },
      isError: false,
    });
    expect((await b.appeler("sortie_validee"))["isError"]).toBe(false);
    expect(await b.appeler("sortie_validee", { bon: false })).toEqual({
      content: [{ type: "text", text: "Output validation error: 'x' is not of type 'integer'" }],
      isError: true,
    });
  });

  it("paramètres d'appel invalides et méthodes : -32602 « Invalid request parameters », -32601 pour une méthode connue sans gestionnaire", async () => {
    const b = await client(serveur());
    expect(await b.requete("tools/call", { arguments: {} })).toMatchObject({
      error: { code: -32602, message: "Invalid request parameters", data: "" },
    });
    expect(await b.requete("tools/call", { name: "echo", arguments: [1] })).toMatchObject({
      error: { code: -32602 },
    });
    expect(await b.requete("nimporte")).toMatchObject({
      error: { code: -32602, message: "Invalid request parameters", data: "" },
    });
    expect(await b.requete("completion/complete", {})).toMatchObject({
      error: { code: -32601, message: "Method not found" },
    });
    expect((await b.requete("resources/list"))["result"]).toEqual({ resources: [] });
    expect((await b.requete("resources/templates/list"))["result"]).toEqual({ resourceTemplates: [] });
    expect((await b.requete("prompts/list"))["result"]).toEqual({ prompts: [] });
    expect((await b.requete("ping"))["result"]).toEqual({});
  });
});

describe("notifications", () => {
  it("journal { msg, extra } lié à la requête, filtré par logging/setLevel ; progression si progressToken", async () => {
    const journal: unknown[] = [];
    const b = await client(serveur({}, journal));
    await b.appeler("bavard", {}, { progressToken: 7, username: "alice" });
    expect(b.notifications).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level: "debug", data: { msg: "détail", extra: null } },
      },
      {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: {
          level: "info",
          logger: "elpis.shell",
          data: { msg: "étape", extra: { kind: "shell_output", call_id: "c1" } },
        },
      },
      {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: 7, progress: 1, total: 2, message: "moitié" },
      },
    ]);
    expect(journal).toEqual([{ progressToken: 7, username: "alice" }]);
    b.notifications.length = 0;
    expect((await b.requete("logging/setLevel", { level: "info" }))["result"]).toEqual({});
    await b.appeler("bavard");
    expect(b.notifications.map((n) => (n["params"] as Dict)["level"])).toEqual(["info"]);
    expect(await b.requete("logging/setLevel", { level: "bavard" })).toMatchObject({
      error: { code: -32602 },
    });
  });
});

describe("identité et limites", () => {
  function serveurIdentite(o: OptionsServeur = {}): { s: ServeurOutils; vus: unknown[] } {
    const vus: unknown[] = [];
    const s = new ServeurOutils({ famillesOpencode: [], limiteDebit: null, limiteConcurrence: null, ...o });
    s.enregistrerFamille("todo", [
      {
        nom: "qui",
        famille: "todo",
        definition: { name: "qui", inputSchema: { type: "object" } },
        signature: { attente: py.int().defaut(0) },
        traiter: async (a) => {
          await new Promise((fin) => setTimeout(fin, a["attente"] as number));
          const i = current();
          vus.push(
            i === null ? null : { u: i.username, id: i.user_id, np: i.network_profile_id, admin: i.is_admin },
          );
          return ok();
        },
      },
    ]);
    return { s, vus };
  }

  it("_meta → identité de l'appel, isolée entre appels concurrents ; jeton client prioritaire ; rappel si l'id manque", async () => {
    const appels: string[] = [];
    const { s, vus } = serveurIdentite({
      rappel: {
        actif: true,
        identityForUsername: (u) => {
          appels.push(u);
          return Promise.resolve({ user_id: 42, username: u, network_profile_id: "web", is_admin: true });
        },
      },
    });
    const b = await client(s);
    await Promise.all([
      b.appeler("qui", { attente: 30 }, { username: "alice", user_id: 1, network_profile_id: "lan" }),
      b.appeler("qui", { attente: 0 }, { username: "bob", user_id: 2 }),
    ]);
    expect(vus).toEqual([
      { u: "bob", id: 2, np: "", admin: false },
      { u: "alice", id: 1, np: "lan", admin: false },
    ]);
    vus.length = 0;
    await b.appeler("qui", {}, { username: "carl", network_profile_id: "lan" });
    expect(vus).toEqual([{ u: "carl", id: 42, np: "lan", admin: true }]);
    const tiers = await client(s, { jeton: jeton({ username: "dora", trusted_meta: false }) });
    vus.length = 0;
    await tiers.appeler("qui", {}, { username: "alice", user_id: 1 });
    expect(vus).toEqual([{ u: "dora", id: 42, np: "web", admin: true }]);
    expect(appels).toEqual(["carl", "dora"]);
    vus.length = 0;
    await b.appeler("qui");
    await avecIdentite(creerIdentite({ user_id: 9, username: "ambiant" }), () => b.appeler("qui"));
    expect(vus).toEqual([null, null]);
  });

  it("rappel au core quand l'id manque : le champ du sous-agent est gardé ; l'hôte n'applique aucun périmètre d'outils", async () => {
    const { s } = serveurIdentite({
      rappel: {
        actif: true,
        identityForUsername: (u) =>
          Promise.resolve({ user_id: 42, username: u, network_profile_id: "", is_admin: false }),
      },
    });
    const enfants: unknown[] = [];
    s.enregistrerFamille("fs", [
      {
        nom: "enfant",
        famille: "fs",
        definition: { name: "enfant", inputSchema: { type: "object" } },
        signature: {},
        traiter: () => {
          enfants.push(current()?.subagent ?? null);
          return Promise.resolve(ok());
        },
      },
    ]);
    const b = await client(s);
    const meta = { username: "carl", subagent: { type: "explore", read_only: true, id: "t1-ab" } };
    expect((await b.appeler("enfant", {}, meta))["isError"]).toBe(false);
    expect(enfants).toEqual([{ type: "explore", id: "t1-ab", browser_session: "isolated" }]);
  });

  it("débit par (compte, outil) : seau vide → isError « Rate limit exceeded »", async () => {
    const { s } = serveurIdentite({ limiteDebit: new LimiteDebit(0.001, 1) });
    const b = await client(s);
    expect((await b.appeler("qui", {}, { username: "alice" }))["isError"]).toBe(false);
    expect(await b.appeler("qui", {}, { username: "alice" })).toEqual({
      content: [{ type: "text", text: "Rate limit exceeded for tool 'qui'" }],
      isError: true,
    });
    expect((await b.appeler("qui", {}, { username: "bob" }))["isError"]).toBe(false);
  });

  it("concurrence par compte : attente bornée puis message lisible", async () => {
    const { s } = serveurIdentite({ limiteConcurrence: new LimiteConcurrence(10, 1, 0.05) });
    const b = await client(s);
    const [lent, refuse] = await Promise.all([
      b.appeler("qui", { attente: 300 }, { username: "alice" }),
      new Promise<Dict>((fin) =>
        setTimeout(() => void b.appeler("qui", {}, { username: "alice" }).then(fin), 20),
      ),
    ]);
    expect(lent["isError"]).toBe(false);
    expect(refuse).toEqual({
      content: [
        {
          type: "text",
          text: "Too many tool calls running for this account (1 at once); wait for the running ones (e.g. a long execute_shell) to finish, then retry.",
        },
      ],
      isError: true,
    });
  });
});

describe("registre", () => {
  it("une famille connue une seule fois ; nom d'outil en double refusé", () => {
    const s = serveur();
    expect(() => s.enregistrerFamille("inconnue", [])).toThrow("famille d'outils inconnue : inconnue");
    expect(s.enregistrerFamille("todo", [])).toBe(false);
    expect(() => s.enregistrerFamille("chart", outilsMemoire())).toThrow("outil déjà enregistré : memory");
    expect(s.famillesActives).toEqual(["todo", "memory", "git"]);
  });

  it("une vague de familles : ordre canonique, extinctions appliquées une fois après la vague", () => {
    const vu: string[] = [];
    const s = new ServeurOutils({
      outilsEteints: () => ["texte_brut"],
      limiteDebit: null,
      limiteConcurrence: null,
    });
    const avant = s.appliquerExtinctions;
    s.appliquerExtinctions = (): string[] => {
      vu.push([...s.famillesActives].join(","));
      return avant.call(s);
    };
    expect(
      s.enregistrerFamilles([
        ["todo", outilsTodo([])],
        ["memory", outilsMemoire()],
      ]),
    ).toEqual(["memory", "todo"]);
    expect(vu).toEqual(["memory,todo"]);
    const noms = s.lister({ jeton: null, famille: null }).tools.map((t) => t["name"]);
    expect(noms[0]).toBe("memory");
    expect(noms).toContain("echo");
    expect(noms).not.toContain("texte_brut");
    expect(s.enregistrerFamilles([["todo", []]])).toEqual([]);
  });
});
