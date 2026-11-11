// SPDX-License-Identifier: MIT
/** apps/toolhost/test/browser-bac-e2e.test.ts — bout en bout du navigateur dans le bac (`browser.mode` = « sandbox ») : vrai conteneur elpis/sandbox:1.8.0, service lancé dedans, relais des secrets de l'hôte, vrai core (coffre) ; site servi dans le bac piloté par pw_*, téléchargement dans /work, URL extérieure refusée par le profil sans réseau, web-login http et https (TLS strict, autorité de l'instance), Basic et Digest ; la valeur n'atteint ni le modèle ni le bac. Opt-in : ELPIS_TEST_SANDBOX_BROWSER=1 (Docker, image 1.8.0, headless shell). */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createServerHttps } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { creerGardes, dependancesParDefaut, installerAuth } from "@elpis/auth";
import { definirFabriqueAgent, reglagesNavigateurBac } from "@elpis/bac";
import type { Dict } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { AgentClient } from "@elpis/fichiers";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { chargerAutorite, defisAuth, Feuilles, jugeRelaisBac, reponseDigest } from "@elpis/navigateur";
import { ouvrirEnMemoire, ServeurOutils } from "@elpis/outils-mcp";
import type { ConnexionEnMemoire } from "@elpis/outils-mcp";
import { configurerCoffre, configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ClientBrut } from "../../../packages/outils-mcp/test/aides";
import { creerApp } from "../../core/src/app";
import { mergeMetaJson, upsertChat } from "../../core/src/chats/stockage";
import { creerFamilleSecrets } from "../../core/src/familles/secrets";
import { Journal } from "../../core/src/journal";
import { creerSecret } from "../../core/src/secrets/stockage";
import { familleBrowser } from "../src/mcp/browser";
import { arreterNavigateursBac, injectionsNavigateurBac } from "../src/mcp/browser/bac";
import { ClientRappel } from "../src/rappel";
import { journalMuet } from "./aides";

const COMPTE = "e2enav";
const CONTENEUR = `elpis-sb-${COMPTE}`;
const IMAGE = "elpis/sandbox:1.8.0";
const SVC = "jeton-de-service-bac-e2e";
const SECRET = `Bac-${randomBytes(6).toString("hex")}-mdp!`;
const IDENTIFIANT = "alice.bac";

function dockerPret(): boolean {
  if (process.env["ELPIS_TEST_SANDBOX_BROWSER"] !== "1") return false;
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const ACTIF = dockerPret();

const formulaire = `<title>Connexion</title><form method="post" action="/session">
<label>Identifiant <input name="u" autocomplete="username"></label>
<label>Mot de passe <input name="p" type="password" autocomplete="current-password"></label>
<button>Connexion</button></form>`;

let dossier = "";
let http: Server;
let https: Server;
const recus: string[] = [];
let t: BaseDeTest;
let core: FastifyInstance;
let connexion: ConnexionEnMemoire | null = null;
let b: ClientBrut;
let uid = 0;
const chat = "conv-bac-e2e";
const resultats: string[] = [];
let restaurer: () => void = () => undefined;

/** Site d'essai de l'hôte (login.test, secure.test, basic.test, digest.test : tous résolus par le juge injecté en 127.0.0.1). */
function site(req: IncomingMessage, res: ServerResponse): void {
  const m: Buffer[] = [];
  req.on("data", (d: Buffer) => m.push(d));
  req.on("end", () => {
    const url = req.url ?? "/";
    const auth = String(req.headers["authorization"] ?? "");
    if (url === "/basic") {
      if (auth !== "Basic " + Buffer.from(`${IDENTIFIANT}:${SECRET}`).toString("base64"))
        return void res.writeHead(401, { "www-authenticate": 'Basic realm="bac"' }).end("refused");
      return void res.writeHead(200, { "content-type": "text/html" }).end("<h1>Basic area</h1>");
    }
    if (url === "/digest") {
      const p = defisAuth(["www-authenticate", auth])[0]?.params ?? {};
      const attendu = reponseDigest(
        { realm: "bac", nonce: "n-bac", opaque: "o", qop: "auth", algorithme: "MD5" },
        { username: IDENTIFIANT, secret: SECRET },
        req.method ?? "GET",
        url,
        Number.parseInt(p["nc"] ?? "0", 16),
        p["cnonce"] ?? "",
      );
      if (!auth.startsWith("Digest") || !attendu.includes(`response="${p["response"]}"`))
        return void res
          .writeHead(401, { "www-authenticate": 'Digest realm="bac", qop="auth", nonce="n-bac", opaque="o"' })
          .end("refused");
      return void res.writeHead(200, { "content-type": "text/html" }).end("<h1>Digest area</h1>");
    }
    if (req.method === "POST" && url === "/session") {
      const q = new URLSearchParams(Buffer.concat(m).toString());
      recus.push(q.get("p") ?? "");
      if (q.get("u") === IDENTIFIANT && q.get("p") === SECRET)
        return void res.writeHead(303, { location: "/tableau", "set-cookie": "sid=ok; Path=/" }).end();
      return void res
        .writeHead(200, { "content-type": "text/html" })
        .end(`${formulaire}<p role="alert">Refused</p>`);
    }
    if (url === "/tableau" && String(req.headers["cookie"] ?? "").includes("sid=ok"))
      return void res
        .writeHead(200, { "content-type": "text/html" })
        .end("<title>Tableau</title><h1>Tableau de bord</h1>");
    res.writeHead(200, { "content-type": "text/html" }).end(formulaire);
  });
}

const port = (s: Server): number => (s.address() as AddressInfo).port;

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 });
}

beforeAll(async () => {
  if (!ACTIF) return;
  dossier = mkdtempSync(path.join(tmpdir(), "bac-nav-e2e-"));
  configureAudit({ service: "main", auditDir: path.join(dossier, "journal"), hmacKeyPath: "/nonexistent" });
  configurerCoffre({
    cleEnv: randomBytes(32).toString("base64"),
    systeme: path.join(dossier, "absente.key"),
    repli: path.join(dossier, ".vault.key"),
  });
  const acAmont = chargerAutorite(path.join(dossier, "ca-amont"));
  const feuilles = new Feuilles(acAmont);
  http = createServer(site);
  https = createServerHttps({ SNICallback: (h, cb) => cb(null, feuilles.contexte(h)) }, site);
  for (const s of [http, https]) await new Promise<void>((ok) => s.listen(0, "127.0.0.1", () => ok()));
  mkdirSync(path.join(dossier, "sb"), { recursive: true });
  writeFileSync(path.join(dossier, "config.json"), JSON.stringify({ browser: { mode: "sandbox" } }));
  restaurer = surchargerConfig({
    LOCAL_MCP_TOKEN: SVC,
    CONFIG_JSON_PATH: path.join(dossier, "config.json"),
    SANDBOX_DIR: path.join(dossier, "sb"),
  });
  process.env["ELPIS_BROWSER_CA_DIR"] = path.join(dossier, "ca");
  process.env["PW_OWNERS_DIR"] = path.join(dossier, "owners");
  reglagesNavigateurBac.service = process.env["ELPIS_TEST_BROWSER_SERVICE_DIR"] || null;
  definirFabriqueAgent((bac) => new AgentClient(bac));
  // Juge du relais : les sites d'essai (*.test) sont ceux de l'hôte ; le reste suit le profil réel du bac (isolé : rien).
  const isole = jugeRelaisBac(() => ({ id: "isolated", mode: "none", ips: [], domains: [], ports: [] }));
  injectionsNavigateurBac.juge = () => async (h, p) =>
    h.endsWith(".test") ? { ok: true, adresse: "127.0.0.1" } : isole(h, p);
  injectionsNavigateurBac.caAmont = [acAmont.certPem];
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  uid = await t.base.insertId(
    `INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES ('${COMPTE}', '', '', 0)`,
  );
  await upsertChat(t.base, uid, chat, "T", [], 1);
  const acteur = { userId: uid, username: COMPTE };
  const ids: unknown[] = [];
  for (const [name, kind, origine] of [
    ["intranet", "web-login", `http://login.test:${port(http)}`],
    ["secure", "web-login", `https://secure.test:${port(https)}`],
    ["basic", "http-auth", `http://basic.test:${port(http)}`],
    ["digest", "http-auth", `http://digest.test:${port(http)}`],
  ] as const)
    ids.push(
      (
        await creerSecret(
          t.base,
          uid,
          { name, kind, scope: { origins: [origine] }, username: IDENTIFIANT, value: SECRET },
          acteur,
        )
      ).id,
    );
  await mergeMetaJson(t.base, uid, chat, (meta) => {
    meta["secrets"] = ids;
  });
  const auth = { ...dependancesParDefaut(t.base, () => SVC) };
  core = await creerApp({
    mode: "main",
    journal: new Journal({ niveau: "error", sortie: () => undefined }),
    familles: [creerFamilleSecrets({ base: t.base, auth })],
    gardes: creerGardes(auth),
    extensions: [(a) => installerAuth(a, auth)],
  });
  await core.listen({ host: "127.0.0.1", port: 0 });
  const rappel = new ClientRappel({
    appUrl: `http://127.0.0.1:${(core.server.address() as AddressInfo).port}`,
    jeton: SVC,
    journal: journalMuet,
  });
  const serveur = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
  serveur.enregistrerFamille("browser", familleBrowser({ journal: journalMuet, rappel }).outils);
  connexion = await ouvrirEnMemoire(serveur, {
    jeton: {
      token: "",
      client_id: "elpis-app",
      scopes: [],
      expires_at: null,
      claims: { trusted_meta: true },
    },
  });
  b = new ClientBrut(connexion.transport);
  await b.demarrer();
  await b.initialiser();
  await b.requete("tools/list");
}, 180_000);

afterAll(async () => {
  if (!ACTIF) return;
  await connexion?.fermer();
  await arreterNavigateursBac();
  try {
    docker("rm", "-f", CONTENEUR);
    docker(
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "rm",
      "-v",
      `${dossier}:/d`,
      IMAGE,
      "-rf",
      "/d/sb",
    );
  } catch {
    // déjà parti
  }
  await core?.close();
  await t?.fermer();
  for (const s of [http, https]) s?.close();
  restaurer();
  injectionsNavigateurBac.juge = null;
  injectionsNavigateurBac.caAmont = null;
  reglagesNavigateurBac.service = null;
  definirFabriqueAgent(null);
  delete process.env["ELPIS_BROWSER_CA_DIR"];
  delete process.env["PW_OWNERS_DIR"];
  oublierConfigurationAudit();
  rmSync(dossier, { recursive: true, force: true });
}, 120_000);

async function outil(nom: string, args: Dict): Promise<Dict> {
  const r = await b.appeler(nom, args, { username: COMPTE, user_id: String(uid), chat_id: chat });
  resultats.push(JSON.stringify(r));
  return (
    ((r["structuredContent"] as Dict | undefined)?.["result"] as Dict | undefined) ??
    (JSON.parse(((r["content"] as Dict[])[0] as Dict)["text"] as string) as Dict)
  );
}

describe.skipIf(!ACTIF)("navigateur dans le bac, de bout en bout (Docker, relais, core)", () => {
  it("site servi dans le bac piloté par pw_*, téléchargement dans /work/downloads", async () => {
    expect(await outil("pw_session", { action: "health" })).toMatchObject({ ok: true, mode: "sandbox" });
    docker(
      "exec",
      "-u",
      "10001:10001",
      CONTENEUR,
      "sh",
      "-c",
      'mkdir -p /work/site && printf \'<title>Sandbox site</title><h1>Sandbox site</h1><a href="file.txt" download>Get file</a><input type="file" id="f">\' > /work/site/index.html && printf "contenu" > /work/site/file.txt',
    );
    docker(
      "exec",
      "-d",
      "-u",
      "10001:10001",
      CONTENEUR,
      "python3",
      "-m",
      "http.server",
      "8080",
      "--bind",
      "127.0.0.1",
      "--directory",
      "/work/site",
    );
    await new Promise((ok) => setTimeout(ok, 1500));
    const s = await outil("pw_session", { action: "start", url: "http://localhost:8080/" });
    expect(s).toMatchObject({ status: "started", title: "Sandbox site" });
    const sid = String(s["session_id"]);
    expect(JSON.stringify(await outil("pw_page", { session_id: sid, action: "text" }))).toContain(
      "Sandbox site",
    );
    expect(
      await outil("pw_act", { session_id: sid, action: "click", target: "text=Get file" }),
    ).not.toMatchObject({ ok: false });
    await new Promise((ok) => setTimeout(ok, 1500));
    expect(docker("exec", CONTENEUR, "sh", "-c", "cat /work/downloads/*/file.txt")).toBe("contenu");
    const capture = await outil("pw_page", { session_id: sid, action: "screenshot" });
    expect(String(capture["screenshot_url"])).toMatch(/^\/api\/playwright\/screenshot\//u);
    // Envoi d'un fichier du bac (lu par l'agent), enregistreur écrit dans /work/recordings.
    await outil("pw_recorder", { session_id: sid, action: "start" });
    expect(
      await outil("pw_act", {
        session_id: sid,
        action: "upload",
        target: "css=#f",
        files: ["/work/site/file.txt"],
      }),
    ).not.toMatchObject({ ok: false });
    const nom = await outil("pw_page", {
      session_id: sid,
      action: "eval",
      value: "document.getElementById('f').files[0].name",
    });
    expect(JSON.stringify(nom)).toContain("file.txt");
    const dump = await outil("pw_recorder", { session_id: sid, action: "dump" });
    expect(String(dump["file"])).toMatch(/^\/work\/recordings\/recording-.*\.spec\.js$/u);
    expect(docker("exec", CONTENEUR, "cat", String(dump["file"]))).toBe(String(dump["script"]));
    await outil("pw_session", { action: "stop", session_id: sid });
    // Trace exportée dans /work/.elpis-browser/traces.
    const tr = await outil("pw_session", {
      action: "start",
      url: "http://localhost:8080/",
      trace: true,
      isolated: true,
    });
    const trace = await outil("pw_session", { action: "trace_export", session_id: tr["session_id"] });
    expect(String(trace["file"])).toMatch(/^\/work\/\.elpis-browser\/traces\/trace_.*\.zip$/u);
    expect(docker("exec", CONTENEUR, "sh", "-c", `test -s ${String(trace["file"])} && echo ok`).trim()).toBe(
      "ok",
    );
    await outil("pw_session", { action: "stop", session_id: tr["session_id"] });
  }, 120_000);

  it("URL extérieure : refus clair du profil réseau sans réseau", async () => {
    const r = await outil("pw_session", { action: "start", url: "https://example.org/" });
    expect(r).toMatchObject({ ok: false, error: "url_blocked" });
    expect(String(r["message"])).toContain("has no network access");
  }, 60_000);

  it("web-login sur une origine http, puis https en TLS strict : connexion réussie par le relais", async () => {
    for (const origine of [`http://login.test:${port(http)}`, `https://secure.test:${port(https)}`]) {
      const s = await outil("pw_session", { action: "start", url: `${origine}/login` });
      expect(s).toMatchObject({ status: "started", tls: "strict" });
      const sid = String(s["session_id"]);
      const l = await outil("pw_login", { session_id: sid, wait_for: "role=heading|name=Tableau de bord" });
      expect(l).toMatchObject({ ok: true, status: "submitted" });
      expect(recus.at(-1)).toBe(SECRET);
      await outil("pw_session", { action: "stop", session_id: sid });
    }
  }, 180_000);

  it("http-auth Basic et Digest : défis résolus par le relais", async () => {
    for (const [hote, titre] of [
      ["basic", "Basic area"],
      ["digest", "Digest area"],
    ] as const) {
      const s = await outil("pw_session", {
        action: "start",
        url: `http://${hote}.test:${port(http)}/${hote}`,
      });
      expect(s).toMatchObject({ status: "started", secret: hote });
      const sid = String(s["session_id"]);
      expect(JSON.stringify(await outil("pw_page", { session_id: sid, action: "text" }))).toContain(titre);
      await outil("pw_session", { action: "stop", session_id: sid });
    }
  }, 120_000);

  it("la valeur n'atteint ni le modèle ni le bac", () => {
    expect(resultats.join("\n")).not.toContain(SECRET);
    const trouve = docker(
      "exec",
      "-u",
      "0:0",
      CONTENEUR,
      "sh",
      "-c",
      `grep -rlF '${SECRET}' /work /tmp /run/elpis 2>/dev/null; true`,
    );
    expect(trouve.trim()).toBe("");
  });
});
