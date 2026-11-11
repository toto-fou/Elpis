// SPDX-License-Identifier: MIT
/** apps/toolhost/test/browser-login-e2e.test.ts — bout en bout : outils pw_* de l'hôte (MCP en mémoire, client de confiance), vrai core (routes du coffre, base SQLite, clé de test) et vrai service navigateur (Chromium) ; le modèle ouvre la page de connexion (session ordinaire au TLS du secret) et appelle pw_login, le site reçoit le mot de passe, aucun résultat d'outil ni le journal ne le contient ; eval permis avant et après ; pw_login refusé hors d'une session ouverte pour un secret ; site qui le réaffiche ensuite : hors du périmètre. Ignoré sans Chromium. */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { creerGardes, dependancesParDefaut, installerAuth } from "@elpis/auth";
import type { Dict } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { ouvrirEnMemoire, ServeurOutils } from "@elpis/outils-mcp";
import type { ConnexionEnMemoire } from "@elpis/outils-mcp";
import { configurerCoffre, configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ClientBrut } from "../../../packages/outils-mcp/test/aides";
import { creerApp } from "../../core/src/app";
import { mergeMetaJson, upsertChat } from "../../core/src/chats/stockage";
import { creerFamilleSecrets } from "../../core/src/familles/secrets";
import { Journal } from "../../core/src/journal";
import { creerSecret } from "../../core/src/secrets/stockage";
import { familleBrowser } from "../src/mcp/browser";
import { ClientRappel } from "../src/rappel";
import { journalMuet } from "./aides";

// Le site d'essai est sur 127.0.0.1 : la garde de l'hôte (adresses de la machine) est levée ici, le service garde la sienne (ouverte au bouclage pour ses essais).
vi.mock("@elpis/navigateur", async (importer) => ({
  ...(await importer<Record<string, unknown>>()),
  refusUrl: async () => null,
}));

const SVC = "jeton-de-service-bout-en-bout";
const JETON_NAVIGATEUR = "jeton-du-service-navigateur-bout-en-bout";
const SECRET = "Mdp-Bout-En-Bout-77";
const IDENTIFIANT = "alice.essai";
const ENCODAGES = [
  SECRET,
  encodeURIComponent(SECRET),
  Buffer.from(SECRET).toString("base64").replace(/=+$/u, ""),
  Buffer.from(SECRET).toString("hex"),
];

const { demarrerService, raisonDeSauter } = (await import(
  new URL("../../../browser-service/test/aides/service.js", import.meta.url).href
)) as {
  demarrerService(o: { env?: Record<string, string> }): Promise<{ base: string; arreter(): Promise<void> }>;
  raisonDeSauter(moteur?: string): Promise<string | false>;
};
const SAUTER = await raisonDeSauter("chromium");

const formulaire = (
  action: string,
): string => `<title>Connexion</title><form method="post" action="${action}">
<label>Identifiant <input name="u" autocomplete="username"></label>
<label>Mot de passe <input name="p" type="password" autocomplete="current-password"></label>
<button>Connexion</button></form>`;
const FORMULAIRE = formulaire("/session");

let site: Server;
let origine = "";
const recus: { u: string; p: string }[] = [];
let renvoye = "";
let t: BaseDeTest;
let core: FastifyInstance;
let service: { base: string; arreter(): Promise<void> } | null = null;
let connexion: ConnexionEnMemoire | null = null;
let b: ClientBrut;
let dossier = "";
let journal = "";
let restaurer: () => void = () => undefined;
let chat = "";
const resultats: string[] = [];

/** Site d'essai : formulaire, POST qui vérifie le mot de passe puis redirige, tableau de bord derrière un cookie ; `/login-echo` dont la réponse réaffiche le dernier mot de passe reçu. */
function servirSite(req: IncomingMessage, res: ServerResponse): void {
  const morceaux: Buffer[] = [];
  req.on("data", (m: Buffer) => morceaux.push(m));
  req.on("end", () => {
    const url = req.url ?? "/";
    if (req.method === "POST" && url === "/session") {
      const p = new URLSearchParams(Buffer.concat(morceaux).toString());
      recus.push({ u: p.get("u") ?? "", p: p.get("p") ?? "" });
      if (p.get("u") === IDENTIFIANT && p.get("p") === SECRET) {
        res.writeHead(303, { location: "/tableau", "set-cookie": "sid=ok; Path=/; HttpOnly" }).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end(`${FORMULAIRE}<p role="alert">Refusé</p>`);
      return;
    }
    if (url === "/login-echo") {
      res.writeHead(200, { "content-type": "text/html" }).end(formulaire("/session-echo"));
      return;
    }
    if (url === "/session-echo") {
      if (req.method === "POST")
        renvoye = new URLSearchParams(Buffer.concat(morceaux).toString()).get("p") ?? "";
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(`<title>Bienvenue</title><h1>Bienvenue</h1><input type="text" value="${renvoye}">`);
      return;
    }
    if (url === "/tableau" && String(req.headers["cookie"] ?? "").includes("sid=ok")) {
      res
        .writeHead(200, { "content-type": "text/html" })
        .end("<title>Tableau</title><h1>Tableau de bord</h1>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(FORMULAIRE);
  });
}

beforeAll(async () => {
  if (SAUTER) return;
  dossier = mkdtempSync(path.join(tmpdir(), "elpis-login-e2e-"));
  journal = mkdtempSync(path.join(tmpdir(), "elpis-login-e2e-journal-"));
  configureAudit({ service: "main", auditDir: journal, hmacKeyPath: "/nonexistent" });
  configurerCoffre({
    cleEnv: randomBytes(32).toString("base64"),
    systeme: path.join(dossier, "absente.key"),
    repli: path.join(dossier, ".vault.key"),
  });
  site = createServer(servirSite);
  await new Promise<void>((ok) => site.listen(0, "127.0.0.1", () => ok()));
  origine = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  // Vrai core : routes du coffre, compte, conversation et secret attaché à elle.
  restaurer = surchargerConfig({ LOCAL_MCP_TOKEN: SVC });
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  const uid = await t.base.insertId(
    "INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES ('alice', '', '', 0)",
  );
  chat = "conv-bout-en-bout";
  await upsertChat(t.base, uid, chat, "T", [], 1);
  const s = await creerSecret(
    t.base,
    uid,
    {
      name: "intranet",
      kind: "web-login",
      scope: { origins: [origine] },
      username: IDENTIFIANT,
      value: SECRET,
    },
    { userId: uid, username: "alice" },
  );
  await mergeMetaJson(t.base, uid, chat, (meta) => {
    meta["secrets"] = [s.id];
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
  const urlCore = `http://127.0.0.1:${(core.server.address() as AddressInfo).port}`;
  // Vrai service navigateur (Chromium), à jeton.
  service = await demarrerService({ env: { BROWSER_SERVICE_TOKEN: JETON_NAVIGATEUR } });
  vi.stubEnv("PLAYWRIGHT_API_URL", service.base);
  vi.stubEnv("BROWSER_SERVICE_TOKEN", JETON_NAVIGATEUR);
  vi.stubEnv("PW_OWNERS_DIR", path.join(dossier, "owners"));
  // Outils de l'hôte servis en mémoire au client de confiance (l'application), rappels vers le vrai core.
  const rappel = new ClientRappel({ appUrl: urlCore, jeton: SVC, journal: journalMuet });
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
  Object.assign(globalThis, { __uidBoutEnBout: uid });
}, 90_000);

afterAll(async () => {
  if (SAUTER) return;
  await connexion?.fermer();
  await service?.arreter();
  await core?.close();
  await t?.fermer();
  await new Promise<void>((ok) => site.close(() => ok()));
  restaurer();
  vi.unstubAllEnvs();
  oublierConfigurationAudit();
  rmSync(dossier, { recursive: true, force: true });
  rmSync(journal, { recursive: true, force: true });
});

/** Appel d'outil comme le modèle le fait (`_meta` posé par le core : compte, conversation) ; le résultat est gardé pour la recherche du secret. */
async function outil(nom: string, args: Dict): Promise<Dict> {
  const uid = (globalThis as unknown as { __uidBoutEnBout: number }).__uidBoutEnBout;
  const r = await b.appeler(nom, args, { username: "alice", user_id: String(uid), chat_id: chat });
  resultats.push(JSON.stringify(r));
  return r;
}

const resultat = (r: Dict): Dict =>
  ((r["structuredContent"] as Dict | undefined)?.["result"] as Dict | undefined) ??
  (JSON.parse(((r["content"] as Dict[])[0] as Dict)["text"] as string) as Dict);

describe.skipIf(Boolean(SAUTER))("pw_login de bout en bout (core, hôte d'outils, Chromium)", () => {
  it("session ouverte pour le secret attaché, connexion réussie ; le mot de passe n'atteint jamais le modèle ni le journal", async () => {
    const debut = resultat(await outil("pw_session", { action: "start", url: `${origine}/login` }));
    expect(debut).toMatchObject({ status: "started", tls: "strict", secret: "intranet" });
    expect(debut).not.toHaveProperty("secure");
    const sid = String(debut["session_id"]);
    const login = resultat(
      await outil("pw_login", { session_id: sid, wait_for: "role=heading|name=Tableau de bord" }),
    );
    expect(login).toMatchObject({ ok: true, status: "submitted", secret: "intranet" });
    expect(["navigated", "wait_for"]).toContain(login["outcome"]);
    expect(recus).toEqual([{ u: IDENTIFIANT, p: SECRET }]);
    const page = resultat(await outil("pw_page", { session_id: sid, action: "text" }));
    expect(JSON.stringify(page)).toContain("Tableau de bord");
    // Ni les résultats d'outils (ce que reçoit le modèle), ni le journal de sécurité ne portent le secret, sous aucune forme.
    for (const r of resultats) for (const f of ENCODAGES) expect(r).not.toContain(f);
    const lignes = readdirSync(journal)
      .map((n) => readFileSync(path.join(journal, n), "utf8"))
      .join("");
    for (const f of ENCODAGES) expect(lignes).not.toContain(f);
    expect(lignes).toContain('"vault.secret.used"');
    await outil("pw_session", { action: "stop", session_id: sid });
  }, 120_000);

  it("eval permis avant et après pw_login dans la session du secret ; pw_login dans une session qui n'a pas été ouverte pour un secret refusé avant toute résolution", async () => {
    const debut = resultat(await outil("pw_session", { action: "start", url: `${origine}/login` }));
    const sid = String(debut["session_id"]);
    const titre = await outil("pw_page", { session_id: sid, action: "eval", value: "document.title" });
    expect(JSON.stringify(titre)).toContain("Connexion");
    const login = resultat(await outil("pw_login", { session_id: sid }));
    expect(login).toMatchObject({ ok: true, secret: "intranet" });
    const apres = await outil("pw_page", { session_id: sid, action: "eval", value: "document.title" });
    expect(JSON.stringify(apres)).toContain("Tableau");
    await outil("pw_session", { action: "stop", session_id: sid });
    const utilises = (): number =>
      readdirSync(journal)
        .map((n) => readFileSync(path.join(journal, n), "utf8"))
        .join("")
        .split('"vault.secret.used"').length - 1;
    const avant = utilises();
    const autre = resultat(await outil("pw_session", { action: "start", url: "about:blank" }));
    const refus = await outil("pw_login", { session_id: String(autre["session_id"]) });
    expect(JSON.stringify(refus)).toContain("secret_session_required");
    expect(utilises()).toBe(avant);
    for (const r of resultats) for (const f of ENCODAGES) expect(r).not.toContain(f);
  }, 120_000);

  it("site qui réaffiche le mot de passe après la connexion : hors du périmètre, la page reste celle du site ; sélecteur sur `value` permis", async () => {
    const debut = resultat(await outil("pw_session", { action: "start", url: `${origine}/login-echo` }));
    expect(debut).toMatchObject({ tls: "strict", secret: "intranet" });
    const sid = String(debut["session_id"]);
    const valeur = resultat(
      await outil("pw_act", { session_id: sid, action: "click", target: 'css=input[value="x"]' }),
    );
    expect(valeur["error"]).not.toBe("secret_option_refused");
    const login = resultat(await outil("pw_login", { session_id: sid }));
    expect(login).toMatchObject({ ok: true, secret: "intranet" });
    expect(login).not.toHaveProperty("secret_in_page");
    expect(renvoye).toBe(SECRET);
    const texte = await outil("pw_page", { session_id: sid, action: "text" });
    expect(JSON.stringify(texte)).toContain("Bienvenue");
    await outil("pw_session", { action: "stop", session_id: sid });
  }, 120_000);
});
