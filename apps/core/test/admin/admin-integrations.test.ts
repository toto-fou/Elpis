// SPDX-License-Identifier: MIT
/** apps/core/test/admin/admin-integrations.test.ts — `/api/admin` des intégrations, des prompts système et du manifeste MCP rejoué contre le routeur admin Python (vecteurs, faux service RAG / llama-server, faux client vocal) ; client vocal absent, invalidation du pool, écritures concurrentes. */
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { signerSession } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { comparePointsDeCode, longueurPy, pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { oublierManifeste, reglerEnvironnementManifeste, surInvalidationMcp } from "@elpis/mcp";
import type { EvenementMcp } from "@elpis/mcp";
import { IDENTITY_HEADER, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ecrirePrompt } from "../../src/administration/prompts-systeme";
import { remplacerBase } from "../../src/base";
import { composer } from "../../src/composition";
import { closeAdminClient } from "../../src/llm/llama-http";
import { reglerSystemePourTests } from "../../src/prompts/systeme";
import { VoiceInjoignable, VoiceRefus } from "../../src/voix/erreurs";
import { installerClientVoix } from "../../src/voix/ports";
import type { ClientVoix } from "../../src/voix/ports";
import { appTest, journalMuet } from "../aides";
import { FauxServeur } from "../llm/faux-serveur";
import type { RequeteRecue } from "../llm/faux-serveur";

/** [compte, méthode (ou CONFIG, MCP, FICHIERS, RENOMMER), chemin, corps, statut TS si écart]. */
type Etape = [string, string, string, unknown, number?];

const TEXTE_V = readFileSync(new URL("../vecteurs/admin-integrations.json", import.meta.url), "utf-8");
/** Corps des étapes relus sans perte (`2.0` reste un flottant, comme dans le script Python). */
const CORPS = (pyJsonLoads(TEXTE_V) as { etapes: Etape[] }).etapes.map((e) => e[3]);
const V = JSON.parse(TEXTE_V) as {
  comptes: [string, number][];
  config: Dict;
  faux: Record<string, [number, string, string]>;
  fichiers: Record<string, [string, number | null]>;
  etapes: Etape[];
  ids: Record<string, number>;
  reponses: ({ statut: number; corps: string } | null)[];
  requetes: [string, string, string][];
  fichiers_finaux: Record<string, string>;
};

const T = 1_791_331_200;
const T0 = 1_800_000_000.5;
const SECRET = "secret-de-test";
const PY_FACTICE = "/opt/python-factice/bin/python";
const NODE_FACTICE = "/opt/node-factice/bin/node";
const DEPOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const ENV = [
  "APP_MCP_MANIFEST",
  "ELPIS_AUDIT_DIR",
  "LOCAL_MCP_URL",
  "LOCAL_MCP_TOKEN",
  "LOCAL_MCP_TOOL_FAMILIES",
  "LOCAL_MCP_OPENCODE_FAMILIES",
  "RAG_SERVICE_URL",
  "RAG_SERVICE_TOKEN",
  "RAG_SERVICE_TIMEOUT",
  "APP_SKILLS_DIR",
] as const;
const envAvant = Object.fromEntries(ENV.map((n) => [n, process.env[n]]));

afterAll(() => {
  for (const [nom, valeur] of Object.entries(envAvant)) {
    if (valeur === undefined) delete process.env[nom];
    else process.env[nom] = valeur;
  }
  oublierConfigurationAudit();
});

/** Écarts de message connus (statut identique) : erreur réseau d'undici, erreur de lecture JSON du manifeste. */
const ECARTS: Record<string, RegExp> = {
  "/api/admin/rag-service/test": /^\{"ok":false,"error":"Network error: [^"]+"\}$/u,
  "/api/admin/mcp/manifest/reload":
    /^\{"ok":true,"source":"synthesized","errors":\["mcp\.json illisible : [^"]+"\],"warnings":\["sans mcp\.json, l'hôte d'outils ne sert plus les familles du compte \(chart, memory, skill, todo\) : \.\/elpis configure écrit mcp\.json, qui les fait servir par main"\],"servers":\["elpis-tools"\]\}$/u,
};

/** `/manifest` de l'hôte factice : `shell` vivante sans SSE (famille relayée sans `mcp_upstream_sse`). */
const MANIFESTE_HOTE = {
  ok: true,
  endpoints: { fs: { http: "h", sse: "s", stdio: {} }, shell: { http: "h", stdio: {} } },
};
const SHELL_SSE =
  ',"x-elpis-shell":{"type":"sse","url":"{h}/sse/shell","headers":{"Authorization":"Bearer jeton-hote"}}';

/** Écarts B2-06 : repli stdio dérivé = `main.mjs --stdio` de l'hôte TS ; l'export ajoute `omis` (sans le transport demandé ; en SSE, d'après le `/manifest` de l'hôte). */
function attenduB206(chemin: string, attendu: { statut: number; corps: string } | null): unknown {
  if (attendu === null) return attendu;
  let corps = attendu.corps.replaceAll(
    '"command":"<PY>","args":["-m","toolhost","--stdio",',
    '"command":"<NODE>","args":["<DEPOT>/apps/toolhost/dist/main.mjs","--stdio",',
  );
  if (chemin.startsWith("/api/admin/mcp/manifest/export") && corps.startsWith('{"ok":true')) {
    const sse = chemin.includes("transport=sse");
    const omis = chemin.endsWith("transport=ws") ? ["elpis-fs", "elpis-shell"] : sse ? ["x-elpis-shell"] : [];
    corps = `${(sse ? corps.replace(SHELL_SSE, "") : corps).slice(0, -1)},"omis":${JSON.stringify(omis)}}`;
  }
  return { statut: attendu.statut, corps };
}

function cookie(uid: number): string {
  return `mcpwebui_session=${signerSession({ user_id: uid, _login_ts: T - 10 }, SECRET, T)}`;
}

/** Le faux client vocal du script Python : champs texte et booléens renvoyés (jamais le jeton), pannes selon l'adresse. */
function vu(cfg: Dict): Dict {
  const out: Dict = {};
  for (const k of Object.keys(cfg).sort(comparePointsDeCode)) {
    const v = cfg[k];
    if ((typeof v === "string" || typeof v === "boolean") && k !== "token") out[k] = v;
  }
  out["timeout_sec"] = cfg["timeout_sec"];
  out["has_token"] = Boolean(cfg["token"]);
  return out;
}

function panne(cfg: Dict): void {
  const u = String(cfg["endpoint_url"]);
  if (u.endsWith("/refus"))
    throw new VoiceRefus("Le service vocal refuse la requête.", { detail: "HTTP 500 : panne", code: 500 });
  if (u.endsWith("/vide")) throw new VoiceInjoignable("Service vocal injoignable.");
  if (u.endsWith("/boom")) throw new Error("boum");
}

const CLIENT_FACTICE: ClientVoix = {
  sondeStt: async (cfg) => {
    panne(cfg);
    return { text: "bonjour", format: cfg["format"], vu: vu(cfg) };
  },
  sondeTts: async (cfg) => {
    panne(cfg);
    return { bytes: 2048, mime: "audio/wav", voices: ["a", "b"], vu: vu(cfg) };
  },
  listeModeles: async (section, cfg) => {
    panne(cfg);
    return {
      models: [{ id: "m1", label: "M1" }],
      current: "m1",
      source: `${section}/${String(cfg["format"])}`,
      vu: vu(cfg),
    };
  },
};

describe("famille /api/admin des intégrations, prompts système et manifeste MCP", () => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let faux: FauxServeur;
  let d: string;
  const restaurations: (() => void)[] = [];

  async function monter(mode: "main" | "admin"): Promise<FastifyInstance> {
    const dep: DependancesAuth & DependancesJetons = {
      base: t.base,
      config: () => ({}),
      attributsCookie: () => ({
        cookie_name: "mcpwebui_session",
        same_site: "lax",
        https_only: false,
        max_age: 86400,
      }),
      secret: () => SECRET,
      jetonService: () => "",
      maintenant: () => T,
    };
    const c = await composer(mode, t.base, journalMuet, dep, d);
    return appTest({ ...c, mode });
  }

  function ecrire(chemin: string, contenu: unknown): void {
    if (typeof contenu === "string" && contenu.startsWith("<<")) writeFileSync(chemin, contenu.slice(2, -2));
    else
      writeFileSync(
        chemin,
        pyJsonDumps(contenu, { ensureAscii: false, indent: 2 }).replaceAll("{h}", faux.url),
      );
  }

  function appel(uid: number, method: string, url: string, corps?: unknown): Promise<LightMyRequestResponse> {
    const entetes: Record<string, string> = { cookie: cookie(uid) };
    let payload: Buffer | undefined;
    if (corps !== null && typeof corps === "object" && !Array.isArray(corps) && "@repete" in corps) {
      const [motif, n] = (corps as { "@repete": [string, number] })["@repete"];
      corps = { content: motif.repeat(n) };
    }
    if (typeof corps === "string" && corps.startsWith("<<"))
      payload = Buffer.from(corps.slice(2, -2), "utf8");
    else if (corps !== undefined && corps !== null)
      payload = Buffer.from(pyJsonDumps(corps, { ensureAscii: false }).replaceAll("{h}", faux.url), "utf8");
    if (payload !== undefined) entetes["content-type"] = "application/json";
    return app.inject({ method: method as "GET", url, headers: entetes, ...(payload ? { payload } : {}) });
  }

  /** Préparations rejouées comme le script Python : config.json, mcp.json, dates de fichiers, dossier renommé. */
  function preparer(methode: string, corps: unknown): void {
    if (methode === "CONFIG") {
      ecrire(path.join(d, "config.json"), corps);
      invalidateConfigCache();
    } else if (methode === "MCP") ecrire(path.join(d, "mcp.json"), corps);
    else if (methode === "FICHIERS")
      for (const [rel, date] of Object.entries(corps as Record<string, number>))
        utimesSync(path.join(d, rel), date, date);
    else {
      const [de, vers] = corps as [string, string];
      renameSync(path.join(d, de), path.join(d, vers));
    }
  }

  let manifesteHote: Dict | null = MANIFESTE_HOTE;

  function repondre(req: RequeteRecue, rep: ServerResponse): void {
    if (req.methode === "GET" && req.url.pathname === "/manifest" && manifesteHote !== null) {
      rep.writeHead(200, { "content-type": "application/json" });
      rep.end(JSON.stringify(manifesteHote));
      return;
    }
    if (req.methode === "POST" && req.url.pathname === "/tokenize") {
      const contenu = String((JSON.parse(req.corps) as Dict)["content"]);
      const jetons = contenu.includes("estimation")
        ? "x"
        : Array.from({ length: Math.floor(longueurPy(contenu) / 3) + 1 }, (_, i) => i);
      rep.writeHead(200, { "content-type": "application/json" });
      rep.end(JSON.stringify({ tokens: jetons }));
      return;
    }
    const [statut, type, corps] = V.faux[`${req.methode} ${req.url.pathname}`] ?? [
      404,
      "text/plain",
      "absent",
    ];
    rep.writeHead(statut, { "content-type": type });
    rep.end(corps);
  }

  beforeEach(async () => {
    d = mkdtempSync(path.join(tmpdir(), "elpis-admin-integrations-"));
    faux = await FauxServeur.demarrer({ "*": repondre });
    writeFileSync(
      path.join(d, "config.json"),
      pyJsonDumps(V.config, { ensureAscii: false, indent: 2 }).replaceAll("{h}", faux.url),
    );
    mkdirSync(path.join(d, "system_prompts"));
    for (const [rel, [contenu, date]] of Object.entries(V.fichiers)) {
      const p = path.join(d, rel);
      if (contenu.startsWith("lien:")) {
        symlinkSync(contenu.slice(5), p);
        continue;
      }
      writeFileSync(p, contenu.startsWith("hex:") ? Buffer.from(contenu.slice(4), "hex") : contenu);
      if (date !== null) utimesSync(p, date, date);
    }
    for (const nom of ENV) delete process.env[nom];
    process.env["APP_MCP_MANIFEST"] = path.join(d, "mcp.json");
    process.env["ELPIS_AUDIT_DIR"] = path.join(d, "audit");
    // Bibliothèque figée telle que les vecteurs l'ont enregistrée (indépendante des skills livrés).
    process.env["APP_SKILLS_DIR"] = path.join(DEPOT, "apps/core/test/vecteurs/skills-integres");
    oublierConfigurationAudit();
    oublierManifeste();
    restaurations.push(
      surchargerConfig({
        CONFIG_JSON_PATH: path.join(d, "config.json"),
        LLAMA_URL: `${faux.url}/v1/chat/completions`,
        LLAMA_PROVIDER_TYPE: "llamacpp",
      }),
      reglerSystemePourTests({ dossierPrompts: () => path.join(d, "system_prompts") }),
      reglerEnvironnementManifeste({ python: PY_FACTICE, node: NODE_FACTICE }),
    );
    invalidateConfigCache();
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    for (const [nom, admin] of V.comptes)
      await t.base.run(
        "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES (?, 's', 'h', 0, ?)",
        [nom, admin],
      );
    remplacerBase(t.base);
    app = await monter("admin");
    installerClientVoix(CLIENT_FACTICE);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
    installerClientVoix(null);
    while (restaurations.length > 0) restaurations.pop()?.();
    oublierManifeste();
    invalidateConfigCache();
    await closeAdminClient();
    remplacerBase(undefined);
    await faux.arreter();
    await t.fermer();
    rmSync(d, { recursive: true, force: true });
  });

  it("inventaire : 11 routes du process admin sous la garde admin, rien dans main ; anonyme = 401", async () => {
    const inventaire = JSON.parse(
      readFileSync(new URL("../../../../migration-kit/routes.inventory.json", import.meta.url), "utf-8"),
    ) as { routes: { methodes: string[]; chemin: string; process: string[]; module: string }[] };
    const attendues = inventaire.routes.filter(
      (r) =>
        ["shared_infra/routes/admin/integrations.py", "shared_infra/routes/admin/system_prompts.py"].includes(
          r.module,
        ) ||
        (r.module === "shared_infra/mcp/panel.py" && r.chemin.startsWith("/api/admin/")),
    );
    expect(attendues).toHaveLength(11);
    const montees = app.elpis.routes.filter((r) => r.famille === "admin-integrations");
    expect(montees).toHaveLength(11);
    for (const r of attendues) {
      const chemin = r.chemin.replace("{category}", ":category");
      const m = montees.find((x) => x.chemin === chemin && x.methodes[0] === r.methodes[0]);
      expect([m?.acces, r.process], `${r.methodes[0]} ${r.chemin}`).toEqual(["admin", ["admin"]]);
      const url = r.chemin.replace("{category}", "CHATBOT_SYSTEM");
      const rep = await app.inject({
        method: r.methodes[0] as "GET",
        url,
        ...(r.methodes[0] === "GET" ? {} : { payload: {} }),
      });
      expect([rep.statusCode, rep.json()], `${r.methodes[0]} ${url}`).toEqual([
        401,
        { detail: "not logged in" },
      ]);
    }
    const main = await monter("main");
    expect(main.elpis.routes.filter((r) => r.famille === "admin-integrations")).toEqual([]);
    await main.close();
  });

  it("rejoue les étapes et rend les mêmes réponses, au texte près (vecteurs) ; requêtes reçues et fichiers dans le même état", async () => {
    const evenements: EvenementMcp[] = [];
    const desabonner = surInvalidationMcp((e) => void evenements.push(e));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (const [i, [nom, methode, chemin, , statutTs]] of V.etapes.entries()) {
        const corps = CORPS[i];
        vi.setSystemTime(Math.round((T0 + 10 * i) * 1000));
        if (["CONFIG", "MCP", "FICHIERS", "RENOMMER"].includes(methode)) {
          preparer(methode, corps);
          continue;
        }
        const r = await appel(V.ids[nom] ?? 0, methode, chemin, corps);
        const texte = r.body
          .replaceAll(faux.url, "{h}")
          .replaceAll(d, "<R>")
          .replaceAll(PY_FACTICE, "<PY>")
          .replaceAll(NODE_FACTICE, "<NODE>")
          .replaceAll(DEPOT, "<DEPOT>");
        for (const jeton of ["jeton-rag", "jeton-voix", "jeton-externe"]) expect(texte).not.toContain(jeton);
        if (!chemin.includes("with_token=1")) expect(texte).not.toContain("jeton-hote");
        if (statutTs !== undefined && statutTs !== null) {
          expect(r.statusCode, `étape ${i} (écart) : ${methode} ${chemin}`).toBe(statutTs);
          expect(texte, `étape ${i} (écart)`).toMatch(ECARTS[chemin] ?? /^$/u);
          continue;
        }
        expect({ statut: r.statusCode, corps: texte }, `étape ${i} : ${methode} ${chemin}`).toEqual(
          attenduB206(chemin, V.reponses[i] ?? null),
        );
      }
    } finally {
      vi.useRealTimers();
      desabonner();
    }
    const recues = faux.requetes
      .filter((q) => q.url.pathname !== "/tokenize" && q.url.pathname !== "/manifest")
      .map((q) => [q.methode, `${q.url.pathname}${q.url.search}`, q.entetes["authorization"] ?? ""]);
    expect(recues).toEqual(V.requetes);
    const manifestes = faux.requetes.filter((q) => q.url.pathname === "/manifest");
    expect(
      manifestes.map((q) => [q.methode, q.entetes["authorization"], Boolean(q.entetes[IDENTITY_HEADER])]),
    ).toEqual([["GET", "Bearer jeton-hote", true]]);
    const dossier = path.join(d, "system_prompts");
    const fichiers: Record<string, string> = {};
    for (const nom of readdirSync(dossier).sort(comparePointsDeCode)) {
      const p = path.join(dossier, nom);
      const octets = lstatSync(p).isSymbolicLink() ? null : readFileSync(p);
      fichiers[nom] =
        octets === null
          ? `lien:${readlinkSync(p)}`
          : octets.length <= 200
            ? octets.toString("hex")
            : `sha256:${createHash("sha256").update(octets).digest("hex")}`;
    }
    expect(fichiers).toEqual(V.fichiers_finaux);
    expect(evenements.filter((e) => e.type === "manifeste")).toHaveLength(3);
  });

  it("export SSE : hôte sans /manifest exploitable, aucune entrée retirée sur sa foi (écart B2-06)", async () => {
    manifesteHote = null;
    try {
      preparer("MCP", CORPS[V.etapes.findIndex((e) => e[1] === "MCP")]);
      oublierManifeste();
      const r = await appel(V.ids["admin"] ?? 0, "GET", "/api/admin/mcp/manifest/export?transport=sse");
      expect(r.statusCode).toBe(200);
      const d = r.json() as Dict;
      expect([Object.keys(d["mcpServers"] as Dict), d["omis"]]).toEqual([["elpis-fs", "elpis-shell"], []]);
      expect(faux.requetes.filter((q) => q.url.pathname === "/manifest")).toHaveLength(1);
    } finally {
      manifesteHote = MANIFESTE_HOTE;
    }
  });

  it("client vocal non branché : erreur interne rendue comme le Python, toujours 200", async () => {
    installerClientVoix(null);
    const admin = V.ids["admin"] ?? 0;
    const test = await appel(admin, "POST", "/api/admin/voice/test", {});
    expect(test.statusCode).toBe(200);
    expect((test.json() as Dict)["stt"]).toEqual({
      ok: false,
      error: "Erreur interne : client du moteur vocal non branché",
    });
    const modeles = await appel(admin, "POST", "/api/admin/voice/models", { section: "stt" });
    expect(modeles.json()).toEqual({
      ok: false,
      models: [],
      current: null,
      source: "",
      error: "Erreur interne : client du moteur vocal non branché",
    });
  });

  describe("PUT /api/admin/system-prompts/{catégorie} (écarts au Python : rien de créé, texte gardé, \\n final)", () => {
    const dossier = (): string => path.join(realpathSync(d), "system_prompts");
    const put = (categorie: string, corps: unknown): Promise<LightMyRequestResponse> =>
      appel(V.ids["admin"] ?? 0, "PUT", `/api/admin/system-prompts/${categorie}`, corps);
    const fichiers = (): string[] => readdirSync(dossier()).sort(comparePointsDeCode);

    it("écritures concurrentes : temporaires distincts, contenu entier de l'une d'elles, aucun reste", async () => {
      const contenus = Array.from({ length: 8 }, (_, i) => `version ${i} `.repeat(500));
      const reps = await Promise.all(contenus.map((content) => put("CHATBOT_SYSTEM", { content })));
      expect(reps.map((r) => r.statusCode)).toEqual(contenus.map(() => 200));
      const final = readFileSync(path.join(dossier(), "CHATBOT_SYSTEM.md"), "utf-8");
      expect(contenus.map((c) => `${c}\n`)).toContain(final);
      expect(readdirSync(dossier()).filter((n) => n.endsWith(".tmp"))).toEqual([]);
      expect(lstatSync(path.join(dossier(), "CHATBOT_SYSTEM.md")).mode & 0o777).toBe(0o644);
    });

    it("le texte est gardé tel que saisi ; un \\n final est écrit s'il manque et conservé s'il est là ; la réponse compte ce qui est écrit", async () => {
      const cas: [string, string][] = [
        ["Nouveau prompt", "Nouveau prompt\n"],
        ["Nouveau prompt\n", "Nouveau prompt\n"],
        ["  Nouveau prompt\r\n  ", "  Nouveau prompt\r\n  \n"],
        ["\n\nligne\n\n", "\n\nligne\n\n"],
        ["é\u{1F600}", "é\u{1F600}\n"],
      ];
      for (const [saisi, ecrit] of cas) {
        const r = await put("CHATBOT_SYSTEM", { content: saisi });
        expect([r.statusCode, r.json()], JSON.stringify(saisi)).toEqual([
          200,
          {
            ok: true,
            category: "CHATBOT_SYSTEM",
            size_chars: longueurPy(ecrit),
            path: path.join(dossier(), "CHATBOT_SYSTEM.md"),
          },
        ]);
        expect(readFileSync(path.join(dossier(), "CHATBOT_SYSTEM.md"), "utf-8")).toBe(ecrit);
        const relu = await appel(V.ids["admin"] ?? 0, "GET", "/api/admin/system-prompts/CHATBOT_SYSTEM");
        const vu = ecrit.replace(/\r\n?/gu, "\n");
        expect(relu.json()).toEqual({ category: "CHATBOT_SYSTEM", content: vu, size_chars: longueurPy(vu) });
      }
    });

    it("lire puis réécrire un prompt le laisse identique (le Python retirait son \\n final à chaque enregistrement)", async () => {
      const avant = readFileSync(path.join(dossier(), "CHATBOT_SYSTEM.md"), "utf-8");
      expect(avant.endsWith("\n")).toBe(true);
      const lu = (await appel(V.ids["admin"] ?? 0, "GET", "/api/admin/system-prompts/CHATBOT_SYSTEM")).json<{
        content: string;
      }>();
      expect((await put("CHATBOT_SYSTEM", { content: lu.content })).statusCode).toBe(200);
      expect(readFileSync(path.join(dossier(), "CHATBOT_SYSTEM.md"), "utf-8")).toBe(avant);
    });

    it("limite de 50 000 octets sur le texte saisi, vide refusé (espaces compris), \\n final ajouté en plus de la limite", async () => {
      const limite = await put("CHATBOT_SYSTEM", { content: "é".repeat(25000) });
      expect([limite.statusCode, limite.json<{ size_chars: number }>().size_chars]).toEqual([200, 25001]);
      const trop = await put("CHATBOT_SYSTEM", { content: "é".repeat(25001) });
      expect([trop.statusCode, trop.json()]).toEqual([
        400,
        { detail: "content too large (25001 chars > 50000 bytes max)" },
      ]);
      for (const vide of ["", " \n\t ", "\n"]) {
        const r = await put("CHATBOT_SYSTEM", { content: vide });
        expect([r.statusCode, r.json()], JSON.stringify(vide)).toEqual([
          400,
          { detail: "content is empty — use DELETE if you really want to remove this category" },
        ]);
      }
      expect(readFileSync(path.join(dossier(), "CHATBOT_SYSTEM.md"), "utf-8")).toBe(`${"é".repeat(25000)}\n`);
    });

    it("catégorie inconnue : 404 comme le GET (le Python la créait), aucun fichier créé, avant la lecture du corps", async () => {
      const avant = fichiers();
      for (const corps of [{ content: "créé" }, "<<{>>", [1], undefined]) {
        const r = await put("NOUVEAU", corps);
        expect([r.statusCode, r.json()], JSON.stringify(corps)).toEqual([
          404,
          { detail: "NOUVEAU.md not found" },
        ]);
      }
      const lu = await appel(V.ids["admin"] ?? 0, "GET", "/api/admin/system-prompts/NOUVEAU");
      expect([lu.statusCode, lu.json()]).toEqual([404, { detail: "NOUVEAU.md not found" }]);
      expect(fichiers()).toEqual(avant);
      mkdirSync(path.join(dossier(), "dossier.md"));
      expect((await put("dossier", { content: "x" })).json()).toEqual({ detail: "dossier.md not found" });
      expect(fichiers()).toEqual([...avant, "dossier.md"].sort(comparePointsDeCode));
    });

    it("écriture confinée au dossier : lien vers l'extérieur refusé (cible intacte, rien d'écrit à côté), lien interne suivi", async () => {
      const dehors = path.join(d, "dehors");
      mkdirSync(dehors);
      writeFileSync(path.join(dehors, "cible.md"), "intact\n");
      symlinkSync(path.join(dehors, "cible.md"), path.join(dossier(), "evasion.md"));
      symlinkSync(dehors, path.join(dossier(), "repertoire.md"));
      for (const categorie of ["evasion", "repertoire"]) {
        const r = await put(categorie, { content: "pirate" });
        expect([r.statusCode, r.json()], categorie).toEqual([
          400,
          { detail: "path escapes system_prompts/" },
        ]);
      }
      expect(readdirSync(dehors)).toEqual(["cible.md"]);
      expect(readFileSync(path.join(dehors, "cible.md"), "utf-8")).toBe("intact\n");
      expect(readdirSync(dossier()).filter((n) => n.endsWith(".tmp"))).toEqual([]);

      symlinkSync("CHATBOT_SYSTEM.md", path.join(dossier(), "alias.md"));
      const r = await put("alias", { content: "via alias" });
      expect(r.json<{ path: string }>().path).toBe(path.join(dossier(), "CHATBOT_SYSTEM.md"));
      expect(readFileSync(path.join(dossier(), "CHATBOT_SYSTEM.md"), "utf-8")).toBe("via alias\n");
      expect(readlinkSync(path.join(dossier(), "alias.md"))).toBe("CHATBOT_SYSTEM.md");
    });

    it("ecrirePrompt revérifie le confinement : cible hors du dossier refusée sans rien écrire", async () => {
      const dehors = path.join(d, "dehors");
      mkdirSync(dehors);
      await expect(ecrirePrompt(path.join(dehors, "x.md"), "pirate\n")).rejects.toMatchObject({
        statusCode: 400,
        detail: "path escapes system_prompts/",
      });
      expect(readdirSync(dehors)).toEqual([]);
      await ecrirePrompt(path.join(dossier(), "CHATBOT_SYSTEM.md"), "direct\n");
      expect(readFileSync(path.join(dossier(), "CHATBOT_SYSTEM.md"), "utf-8")).toBe("direct\n");
    });

    it("atomique : un lecteur voit toujours une version entière, jamais un fichier tronqué ni un temporaire", async () => {
      const versions = ["a".repeat(40_000), "b".repeat(40_000)].map((c) => `${c}\n`);
      const cible = path.join(dossier(), "CHATBOT_SYSTEM.md");
      let continuer = true;
      const vus = new Set<string>();
      const lecteur = (async () => {
        while (continuer) {
          vus.add(readFileSync(cible, "utf-8"));
          await new Promise((r) => setImmediate(r));
        }
      })();
      try {
        for (let i = 0; i < 30; i++) await put("CHATBOT_SYSTEM", { content: versions[i % 2] });
      } finally {
        continuer = false;
        await lecteur;
      }
      expect([...vus].every((v) => versions.includes(v) || v === "Tu es Elpis.\n")).toBe(true);
      expect(fichiers().some((n) => n.endsWith(".tmp"))).toBe(false);
    });

    it.skipIf(process.getuid?.() === 0)(
      "écriture impossible (dossier en lecture seule) : 500 « write failed », contenu intact, aucun temporaire",
      async () => {
        const avant = readFileSync(path.join(dossier(), "CHATBOT_SYSTEM.md"), "utf-8");
        chmodSync(dossier(), 0o555);
        try {
          const r = await put("CHATBOT_SYSTEM", { content: "refusé" });
          expect(r.statusCode).toBe(500);
          expect(r.json<{ detail: string }>().detail).toMatch(
            /^write failed: EACCES|^write failed: \[Errno 13\]/u,
          );
        } finally {
          chmodSync(dossier(), 0o755);
        }
        expect(readFileSync(path.join(dossier(), "CHATBOT_SYSTEM.md"), "utf-8")).toBe(avant);
        expect(readdirSync(dossier()).filter((n) => n.endsWith(".tmp"))).toEqual([]);
      },
    );
  });
});
