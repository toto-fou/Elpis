// SPDX-License-Identifier: MIT
/** apps/toolhost/test/browser-secrets.test.ts — outils pw_* et coffre : pw_session sans identifiants (schéma), session ordinaire ouverte pour un secret attaché qui couvre l'origine (TLS de sa politique, secret lié au relais du bac, http-auth par la clé de la session sans HAR ni trace, web-login sans valeur, ambiguïté, refus nommés), pw_login (pré-contrôle, substitut armé au relais, /login, jamais de valeur ni de résolution avant le relais), refus `secret_*` du coffre et de la connexion réécrits pour le modèle, autres erreurs du service rendues telles quelles, enveloppe signée avec la conversation, client externe sans secret. */
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { chargerAutorite, RelaisNavigateur } from "@elpis/navigateur";
import type { Autorite } from "@elpis/navigateur";
import { ouvrirEnMemoire, ServeurOutils } from "@elpis/outils-mcp";
import type { ConnexionEnMemoire, JetonAcces } from "@elpis/outils-mcp";
import { IDENTITY_HEADER, verify } from "@elpis/securite";
import type { Identity } from "@elpis/securite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ClientBrut } from "../../../packages/outils-mcp/test/aides";
import { familleBrowser } from "../src/mcp/browser";
import { arreterNavigateursBac, poserRelaisPourTests } from "../src/mcp/browser/bac";
import { oublierTout } from "../src/mcp/browser/liaisons";
import { ClientRappel } from "../src/rappel";
import { journalMuet, SVC } from "./aides";
import { FauxNavigateur, SESSION, SITE } from "./faux-navigateur";

const VALEUR = "Mdp-Du-Coffre-Secret-42";
const SUBSTITUT = /^Ep\.[0-9a-f]{16}-X$/u;
const dossier = mkdtempSync(path.join(tmpdir(), "elpis-browser-secrets-"));
const DE_CONFIANCE: JetonAcces = {
  token: "",
  client_id: "elpis-app",
  scopes: [],
  expires_at: null,
  claims: { trusted_meta: true },
};
const EXTERNE: JetonAcces = {
  token: "pcr_x",
  client_id: "opencode",
  scopes: [],
  expires_at: null,
  claims: { trusted_meta: false, username: "alice" },
};
const META = { username: "alice", user_id: "7", chat_id: "c1" };

type Reponse = [number, Dict];

/** Faux core : enveloppe vérifiée au jeton de service, réponses scriptées par route, requêtes relevées. */
class FauxCore {
  readonly vues: { chemin: string; corps: Dict; identite: Identity | null; bearer: string }[] = [];
  readonly reponses = new Map<string, Reponse[]>();
  private readonly serveur: Server;

  private constructor(serveur: Server) {
    this.serveur = serveur;
  }

  static async demarrer(): Promise<FauxCore> {
    let faux: FauxCore | null = null;
    const serveur = createServer((req, res) => {
      const morceaux: Buffer[] = [];
      req.on("data", (m: Buffer) => morceaux.push(m));
      req.on("end", () => {
        const texte = Buffer.concat(morceaux).toString();
        const chemin = (req.url ?? "/").split("?")[0] ?? "/";
        const entete = req.headers[IDENTITY_HEADER];
        (faux as FauxCore).vues.push({
          chemin,
          corps: texte ? (JSON.parse(texte) as Dict) : {},
          identite: typeof entete === "string" ? verify(entete, SVC) : null,
          bearer: String(req.headers["authorization"] ?? ""),
        });
        const [statut, corps] = (faux as FauxCore).reponses.get(chemin)?.shift() ?? [
          404,
          { detail: "absent" },
        ];
        res.writeHead(statut, { "content-type": "application/json" }).end(JSON.stringify(corps));
      });
    });
    faux = new FauxCore(serveur);
    await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", () => ok()));
    return faux;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.serveur.address() as AddressInfo).port}`;
  }

  repondre(chemin: string, ...r: Reponse[]): void {
    this.reponses.set(chemin, r);
  }

  async arreter(): Promise<void> {
    this.serveur.closeAllConnections();
    await new Promise<void>((ok) => this.serveur.close(() => ok()));
  }
}

let navigateur: FauxNavigateur;
let core: FauxCore;
let autorite: Autorite;
/** Relais des secrets du bac d'alice (sans trafic : ses liaisons et ses fenêtres seulement). */
let relais: RelaisNavigateur;
const ouvertes: ConnexionEnMemoire[] = [];

beforeAll(async () => {
  navigateur = await FauxNavigateur.demarrer();
  core = await FauxCore.demarrer();
  autorite = chargerAutorite(path.join(dossier, "ca"));
});

beforeEach(() => {
  navigateur.brancher();
  vi.stubEnv("PW_OWNERS_DIR", path.join(dossier, "owners"));
  relais = new RelaisNavigateur({
    socket: path.join(dossier, "relais.sock"),
    jeton: "j",
    juger: async () => ({ ok: false, motif: "non" }),
    autorite,
  });
  poserRelaisPourTests("alice", relais, Date.now());
});

afterEach(async () => {
  oublierTout();
  await arreterNavigateursBac();
  FauxNavigateur.debrancher();
  for (const c of ouvertes.splice(0)) await c.fermer();
  vi.unstubAllEnvs();
  navigateur.reinitialiser();
  core.vues.length = 0;
  core.reponses.clear();
});

afterAll(async () => {
  await navigateur.arreter();
  await core.arreter();
  rmSync(dossier, { recursive: true, force: true });
});

async function client(jeton: JetonAcces | null = DE_CONFIANCE): Promise<ClientBrut> {
  const rappel = new ClientRappel({ appUrl: core.url, jeton: SVC, journal: journalMuet });
  const serveur = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
  serveur.enregistrerFamille("browser", familleBrowser({ journal: journalMuet, rappel }).outils);
  const c = await ouvrirEnMemoire(serveur, { jeton });
  ouvertes.push(c);
  const b = new ClientBrut(c.transport);
  await b.demarrer();
  await b.initialiser();
  return b;
}

const contenu = (r: Dict): Dict => r["structuredContent"] as Dict;
const texte = (r: Dict): string => JSON.stringify(r);
const resultat = (r: Dict): Dict => (contenu(r)["result"] as Dict | undefined) ?? contenu(r);
/** Enveloppe d'erreur d'un appel refusé (`isError`), lue dans son texte. */
const erreur = (r: Dict): Dict => JSON.parse(((r["content"] as Dict[])[0] as Dict)["text"] as string) as Dict;

/** Corps des requêtes reçues par le faux service pour une route. */
function corpsRecus(route: string): Dict[] {
  return navigateur.vues
    .filter((v) => `${v.methode} ${v.chemin}` === route)
    .map((v) => JSON.parse(v.corps) as Dict);
}

const applicable = (name: string, kind = "web-login", tls = "strict", autres: Dict = {}): Dict => ({
  name,
  kind,
  username: "admin",
  origins: [SITE],
  tls,
  subagents: true,
  ...autres,
});

describe("pw_session : plus aucun identifiant passé par le modèle", () => {
  it("username et password ne font plus partie du schéma : refusés à la validation, rien n'est envoyé", async () => {
    const b = await client();
    const liste = ((await b.requete("tools/list"))["result"] as Dict)["tools"] as Dict[];
    const schema = (liste.find((t) => t["name"] === "pw_session") as Dict)["inputSchema"] as Dict;
    expect(Object.keys(schema["properties"] as Dict)).not.toEqual(expect.arrayContaining(["username"]));
    expect(Object.keys(schema["properties"] as Dict)).toContain("secret");
    expect(liste.map((t) => t["name"])).toContain("pw_login");
    const r = await b.appeler("pw_session", { action: "start", url: `${SITE}/`, password: "x" }, META);
    expect(r["isError"]).toBe(true);
    expect(corpsRecus("POST /start")).toEqual([]);
  });
});

describe("pw_session : session ouverte pour un secret attaché", () => {
  it("aucun secret ne couvre l'origine : session ordinaire, sans headless ni identifiants ; enveloppe signée avec la conversation", async () => {
    core.repondre("/api/internal/secrets/match", [200, { secrets: [] }]);
    const b = await client();
    const r = await b.appeler("pw_session", { action: "start", url: `${SITE}/page` }, META);
    expect(r["isError"]).not.toBe(true);
    const corps = corpsRecus("POST /start")[0] as Dict;
    expect(corps).not.toHaveProperty("secure");
    expect(corps).not.toHaveProperty("headless");
    expect(corps).not.toHaveProperty("username");
    expect(corps).not.toHaveProperty("password");
    expect(core.vues[0]).toMatchObject({
      chemin: "/api/internal/secrets/match",
      corps: { origin: SITE, name: null },
      bearer: `Bearer ${SVC}`,
      identite: { user_id: 7, username: "alice", chat_id: "c1" },
    });
  });

  it("http-auth : secret lié au relais du bac avec la clé de la session ; aucune valeur résolue ni passée au service, rien rendu au modèle", async () => {
    core.repondre("/api/internal/secrets/match", [
      200,
      { secrets: [applicable("proxy", "http-auth", "insecure")] },
    ]);
    navigateur.imposees.set("POST /start", [
      [200, { status: "started", session_id: SESSION, url: `${SITE}/`, tls: "insecure" }],
    ]);
    const b = await client();
    const r = await b.appeler(
      "pw_session",
      { action: "start", url: `${SITE}/`, secret: "proxy" },
      { ...META, chat_id: "c1#task-t1", subagent: { type: "web", id: "t1" } },
    );
    expect(resultat(r)).toMatchObject({ session_id: SESSION, secret: "proxy" });
    const corps = corpsRecus("POST /start")[0] as Dict;
    expect(corps).toMatchObject({
      url: `${SITE}/`,
      tls: "insecure",
      relay_binding: { key: expect.stringMatching(/^[0-9a-f]{48}$/u), origins: [SITE] },
    });
    for (const k of ["secure", "credentials_origin", "username", "password"])
      expect(corps).not.toHaveProperty(k);
    expect(relais.ids()).toEqual([expect.stringMatching(/^http-auth-[0-9a-f]{16}$/u)]);
    expect(core.vues.map((v) => [v.chemin, v.corps])).toEqual([
      ["/api/internal/secrets/match", { origin: SITE, name: "proxy" }],
    ]);
    expect(core.vues[0]?.identite).toMatchObject({
      chat_id: "c1#task-t1",
      subagent: { type: "web", id: "t1" },
    });
  });

  it("http-auth avec record_har ou trace : refus avant toute résolution, rien d'ouvert", async () => {
    const proxy: [number, Dict] = [200, { secrets: [applicable("proxy", "http-auth")] }];
    core.repondre("/api/internal/secrets/match", proxy, proxy);
    const b = await client();
    for (const option of [{ record_har: true }, { trace: true }]) {
      const r = await b.appeler("pw_session", { action: "start", url: `${SITE}/`, ...option }, META);
      expect(erreur(r)).toMatchObject({ error: "recording_with_credentials" });
      expect(String(erreur(r)["fix"])).toContain("without record_har and trace");
    }
    expect(core.vues.map((v) => v.chemin)).toEqual([
      "/api/internal/secrets/match",
      "/api/internal/secrets/match",
    ]);
    expect(corpsRecus("POST /start")).toEqual([]);
  });

  it("web-login : session ordinaire au TLS du secret, sans valeur (aucune résolution), conseil pw_login ; plusieurs secrets : secret_ambiguous", async () => {
    core.repondre(
      "/api/internal/secrets/match",
      [200, { secrets: [applicable("intranet")] }],
      [200, { secrets: [applicable("a"), applicable("b")] }],
    );
    const b = await client();
    const r = await b.appeler("pw_session", { action: "start", url: `${SITE}/login` }, META);
    expect(resultat(r)).toMatchObject({ secret: "intranet" });
    expect(String(resultat(r)["secret_note"])).toContain('pw_login(session_id, secret="intranet")');
    expect(String(resultat(r)["secret_note"])).toContain("every other tool works as usual");
    expect(corpsRecus("POST /start")[0]).toMatchObject({ tls: "strict" });
    expect(corpsRecus("POST /start")[0]).not.toHaveProperty("secure");
    expect(corpsRecus("POST /start")[0]).not.toHaveProperty("password");
    expect(corpsRecus("POST /start")[0]).not.toHaveProperty("relay_binding");
    expect(relais.ids()).toEqual([expect.stringMatching(/^web-login-[0-9a-f]{16}$/u)]);
    expect(core.vues.map((v) => v.chemin)).toEqual(["/api/internal/secrets/match"]);
    const deux = await b.appeler("pw_session", { action: "start", url: `${SITE}/login` }, META);
    expect(deux["isError"]).toBe(true);
    expect(erreur(deux)).toMatchObject({ error: "secret_ambiguous" });
    expect(String(erreur(deux)["fix"])).toContain('secret="<name>"');
    expect(corpsRecus("POST /start")).toHaveLength(1);
  });

  it("secret nommé refusé par le coffre : refus codé rendu, rien d'ouvert ; core muet : session ordinaire avec avertissement", async () => {
    core.repondre("/api/internal/secrets/match", [
      422,
      { detail: "Secret 'rh' is not attached to this conversation.", code: "secret_not_attached" },
    ]);
    const b = await client();
    const r = await b.appeler("pw_session", { action: "start", url: `${SITE}/`, secret: "rh" }, META);
    expect(r["isError"]).toBe(true);
    expect(erreur(r)).toMatchObject({
      error: "secret_not_attached",
      message: "Secret 'rh' is not attached to this conversation.",
    });
    expect(String(erreur(r)["fix"])).toContain("/secret attach");
    expect(corpsRecus("POST /start")).toEqual([]);
    core.repondre("/api/internal/secrets/match", [500, { detail: "panne" }]);
    const muet = await b.appeler("pw_session", { action: "start", url: `${SITE}/` }, META);
    expect(resultat(muet)["secret_warning"]).toBeTruthy();
    expect(corpsRecus("POST /start")[0]).not.toHaveProperty("tls");
  });

  it("client externe ou sans conversation : aucun appel au coffre ; un secret nommé est refusé", async () => {
    for (const [jeton, meta] of [
      [EXTERNE, META],
      [DE_CONFIANCE, { username: "alice", user_id: "7" }],
    ] as const) {
      const b = await client(jeton);
      const r = await b.appeler("pw_session", { action: "start", url: `${SITE}/` }, meta);
      expect(r["isError"]).not.toBe(true);
      const n = await b.appeler("pw_session", { action: "start", url: `${SITE}/`, secret: "x" }, meta);
      expect(texte(n)).toContain("secret_not_attached");
    }
    expect(core.vues).toEqual([]);
  });
});

describe("pw_login", () => {
  const PRE: Dict = {
    ok: true,
    frame_origin: SITE,
    fields: ["username", "password"],
    detected: ["username", "password"],
    submit: false,
    targets: {},
  };

  /** Session de l'appelant enregistrée à son nom (pw_session start sur le faux service). */
  async function session(b: ClientBrut): Promise<void> {
    core.repondre("/api/internal/secrets/match", [200, { secrets: [applicable("intranet")] }]);
    await b.appeler("pw_session", { action: "start", url: `${SITE}/login` }, META);
    core.vues.length = 0;
  }

  it("pré-contrôle sans valeur, /login avec un substitut armé au relais, sans résolution par le core (le relais la demande au besoin) ; rien de la valeur ne revient", async () => {
    const b = await client();
    await session(b);
    navigateur.imposees.set("POST /login_precheck", [[200, PRE]]);
    navigateur.imposees.set("POST /login", [
      [
        200,
        {
          ok: true,
          status: "submitted",
          outcome: "navigated",
          url: `${SITE}/dashboard`,
          documents_replaced: 1,
        },
      ],
    ]);
    core.repondre("/api/internal/secrets/match", [200, { secrets: [applicable("intranet")] }]);
    const r = await b.appeler(
      "pw_login",
      {
        session_id: SESSION,
        secret: "intranet",
        username_target: "label=Email",
        submit_target: "role=button|name=Sign in",
        wait_for: "role=heading|name=Dashboard",
      },
      META,
    );
    expect(r["isError"]).not.toBe(true);
    expect(texte(r)).not.toContain(VALEUR);
    expect(resultat(r)).toMatchObject({ ok: true, outcome: "navigated", secret: "intranet" });
    const pre = corpsRecus("POST /login_precheck")[0] as Dict;
    expect(pre).toMatchObject({
      session_id: SESSION,
      username_target: { by_label: "Email" },
      submit_target: { by_role: "button", by_name: "Sign in" },
      wait_for: { by_role: "heading", by_name: "Dashboard" },
    });
    expect(JSON.stringify(pre)).not.toContain(VALEUR);
    expect(corpsRecus("POST /login")[0]).toMatchObject({
      secret_origin: SITE,
      username_value: "admin",
      password_value: expect.stringMatching(SUBSTITUT),
      username_target: { by_label: "Email" },
    });
    expect(core.vues.map((v) => [v.chemin, v.corps])).toEqual([
      ["/api/internal/secrets/match", { origin: SITE, name: "intranet" }],
    ]);
    expect(relais.ids()).toEqual([
      expect.stringMatching(/^web-login-[0-9a-f]{16}$/u),
      expect.stringMatching(/^login-[0-9a-f]{16}$/u),
    ]);
    const ordre = navigateur.vues.map((v) => v.chemin).filter((c) => c.startsWith("/login"));
    expect(ordre).toEqual(["/login_precheck", "/login"]);
  });

  it("identifiant seul : son échec rendu avec le code du service ; mot de passe jamais substitué par le relais : secret_not_substituted, avec l'issue", async () => {
    const b = await client();
    await session(b);
    navigateur.imposees.set("POST /login_precheck", [
      [200, { ...PRE, fields: ["username"], detected: ["username"] }],
      [200, { ...PRE, fields: ["password"], detected: ["password"] }],
    ]);
    const echec: [number, Dict] = [
      422,
      {
        ok: false,
        outcome: "login_form_shown_again",
        code: "secret_login_failed",
        error:
          "The login did not succeed: the login form came back after submission (credentials refused?). The fields were cleared.",
        page_message: "Mot de passe incorrect",
      },
    ];
    navigateur.imposees.set("POST /login", [echec, echec]);
    const vu: [number, Dict] = [200, { secrets: [applicable("intranet")] }];
    core.repondre("/api/internal/secrets/match", vu, vu);
    const identifiant = await b.appeler("pw_login", { session_id: SESSION }, META);
    expect(erreur(identifiant)).toMatchObject({
      error: "secret_login_failed",
      page_message: "Mot de passe incorrect",
    });
    expect(String(erreur(identifiant)["fix"])).toContain("Do not retry in a loop");
    const r = await b.appeler("pw_login", { session_id: SESSION }, META);
    expect(r["isError"]).toBe(true);
    expect(erreur(r)).toMatchObject({ error: "secret_not_substituted", outcome: "login_form_shown_again" });
    expect(String(erreur(r)["message"])).toContain("never sent the typed password");
    expect(texte(r)).not.toContain(VALEUR);
    expect(corpsRecus("POST /login").map((c) => [c["username_value"], c["password_value"]])).toEqual([
      ["admin", ""],
      ["", expect.stringMatching(SUBSTITUT)],
    ]);
    expect(core.vues.map((v) => v.corps)).toEqual([
      { origin: SITE, name: "intranet" },
      { origin: SITE, name: "intranet" },
    ]);
  });

  it("refus du coffre au choix du secret (hors de portée) : rendu tel quel, rien saisi", async () => {
    const b = await client();
    await session(b);
    navigateur.imposees.set("POST /login_precheck", [[200, PRE]]);
    core.repondre("/api/internal/secrets/match", [
      422,
      { detail: "Secret 'intranet' does not apply to http://93.184.216.34.", code: "secret_scope_mismatch" },
    ]);
    const refus = await b.appeler("pw_login", { session_id: SESSION, secret: "intranet" }, META);
    expect(erreur(refus)).toMatchObject({
      error: "secret_scope_mismatch",
      message: "Secret 'intranet' does not apply to http://93.184.216.34.",
    });
    expect(corpsRecus("POST /login")).toEqual([]);
  });

  it("cible inutilisable (xpath seul) : secret_target_required avant tout appel ; session d'autrui : refusée", async () => {
    const b = await client();
    await session(b);
    const r = await b.appeler("pw_login", { session_id: SESSION, password_target: "xpath=//input" }, META);
    expect(texte(r)).toContain("secret_target_required");
    expect(corpsRecus("POST /login_precheck")).toEqual([]);
    const autre = await b.appeler("pw_login", { session_id: "sessZZZZ9999" }, META);
    expect(texte(autre)).toContain("not_your_session");
    const sans = await b.appeler("pw_login", { session_id: "" }, META);
    expect(texte(sans)).toContain("session_id_required");
  });
});

describe("refus `secret_*` réécrits pour le modèle", () => {
  it("hors pw_login, les erreurs du service sont rendues telles quelles : connexion en cours (409), sélecteur sur `value` envoyé au service", async () => {
    const b = await client();
    navigateur.imposees.set("POST /action", [
      [
        409,
        {
          error: "A login is in progress on this session: retry once it has finished.",
          code: "secret_login_busy",
          retryable: true,
        },
      ],
    ]);
    const occupe = await b.appeler(
      "pw_act",
      { session_id: SESSION, action: "click", target: "text=Go" },
      META,
    );
    expect(erreur(occupe)).toMatchObject({
      error: "secret_login_busy",
      message: "A login is in progress on this session: retry once it has finished.",
    });
    const valeur = await b.appeler(
      "pw_act",
      { session_id: SESSION, action: "click", target: 'css=input[value="a"]' },
      META,
    );
    expect(valeur["isError"]).not.toBe(true);
    expect(corpsRecus("POST /action").at(-1)).toMatchObject({ selector: 'input[value="a"]' });
  });

  it("pw_login : origine des frames (403), champ qui perd le focus (400) ; succès sans avertissement ni valeur", async () => {
    const b = await client();
    core.repondre("/api/internal/secrets/match", [200, { secrets: [applicable("intranet")] }]);
    await b.appeler("pw_session", { action: "start", url: `${SITE}/login` }, META);
    navigateur.imposees.set("POST /login_precheck", [
      [
        403,
        {
          error:
            "The field's frame is embedded in a page of another origin (https://autre.lan): input refused.",
          code: "secret_scope_mismatch",
        },
      ],
      [200, { ok: true, frame_origin: SITE, fields: ["username"], detected: ["username"], targets: {} }],
      [200, { ok: true, frame_origin: SITE, fields: ["password"], detected: ["password"], targets: {} }],
    ]);
    navigateur.imposees.set("POST /login", [
      [
        400,
        {
          error: "The user name field lost the focus while typing: it was cleared.",
          code: "secret_target_required",
        },
      ],
      [
        200,
        {
          ok: true,
          status: "submitted",
          outcome: "navigated",
          documents_replaced: 1,
        },
      ],
    ]);
    const vu: [number, Dict] = [200, { secrets: [applicable("intranet")] }];
    core.repondre("/api/internal/secrets/match", vu, vu);
    const cadre = await b.appeler("pw_login", { session_id: SESSION }, META);
    expect(erreur(cadre)).toMatchObject({ error: "secret_scope_mismatch" });
    expect(String(erreur(cadre)["message"])).toContain("another origin");
    expect(String(erreur(cadre)["fix"])).toContain("not inside a frame embedded by another site");
    const focus = await b.appeler("pw_login", { session_id: SESSION }, META);
    expect(erreur(focus)).toMatchObject({ error: "secret_target_required" });
    expect(String(erreur(focus)["fix"])).toContain("keeps the focus");
    const ok = resultat(await b.appeler("pw_login", { session_id: SESSION }, META));
    expect(ok).toMatchObject({ ok: true, documents_replaced: 1, secret: "intranet" });
    expect(ok).not.toHaveProperty("warning");
    expect(JSON.stringify(ok)).not.toContain(VALEUR);
  });

  it("refus du coffre : correctif propre au code (non vérifié, genre, clé absente), message du core gardé", async () => {
    const b = await client();
    const attendus: [string, string, string][] = [
      [
        "secret_unverified",
        "Secret 'rh' is unverified: its owner must verify it in Settings › Secrets.",
        "verify this imported secret",
      ],
      [
        "secret_type_mismatch",
        "Secret 'rh' is a web-login secret, not http-auth.",
        "pw_login uses a web-login secret",
      ],
      [
        "secret_key_unavailable",
        "The vault key is missing while secrets exist.",
        "an administrator must check the vault",
      ],
    ];
    core.repondre(
      "/api/internal/secrets/match",
      ...attendus.map(([code, detail]): [number, Dict] => [
        code === "secret_key_unavailable" ? 503 : 422,
        { detail, code },
      ]),
    );
    for (const [code, detail, fix] of attendus) {
      const r = await b.appeler("pw_session", { action: "start", url: `${SITE}/`, secret: "rh" }, META);
      expect(erreur(r)).toMatchObject({ error: code, message: detail });
      expect(String(erreur(r)["fix"])).toContain(fix);
    }
    expect(corpsRecus("POST /start")).toEqual([]);
  });
});

describe("session liée au secret qui l'a ouverte (hôte d'outils)", () => {
  const PRE: Dict = {
    ok: true,
    frame_origin: SITE,
    fields: ["password"],
    detected: ["password"],
    targets: {},
  };

  it("pw_login : session non liée refusée avant tout appel ; TLS vérifié dans une session ouverte sans : refus sans résolution ; secret à TLS souple, de la session ou d'autres origines : admis", async () => {
    const b = await client();
    core.repondre("/api/internal/secrets/match", [200, { secrets: [] }]);
    await b.appeler("pw_session", { action: "start", url: `${SITE}/` }, META);
    core.vues.length = 0;
    const libre = await b.appeler("pw_login", { session_id: SESSION }, META);
    expect(erreur(libre)).toMatchObject({ error: "secret_session_required" });
    expect(String(erreur(libre)["message"])).toContain("not opened for a vault secret");
    expect([core.vues, corpsRecus("POST /login_precheck")]).toEqual([[], []]);
    core.repondre(
      "/api/internal/secrets/match",
      [200, { secrets: [applicable("proxy", "http-auth", "insecure")] }],
      [200, { secrets: [applicable("intranet")] }],
      [
        200,
        { secrets: [applicable("large", "web-login", "insecure", { origins: [SITE, "https://autre.lan"] })] },
      ],
      [200, { secrets: [applicable("meme", "web-login", "insecure")] }],
    );
    await b.appeler("pw_session", { action: "start", url: `${SITE}/`, secret: "proxy" }, META);
    navigateur.imposees.set("POST /login_precheck", [
      [200, PRE],
      [200, PRE],
      [200, PRE],
    ]);
    const soumis: [number, Dict] = [200, { ok: true, status: "submitted", outcome: "navigated" }];
    navigateur.imposees.set("POST /login", [soumis, soumis]);
    core.vues.length = 0;
    const tls = await b.appeler("pw_login", { session_id: SESSION, secret: "intranet" }, META);
    expect(erreur(tls)).toMatchObject({ error: "secret_scope_mismatch" });
    expect(String(erreur(tls)["message"])).toContain("requires verified certificates");
    const large = await b.appeler("pw_login", { session_id: SESSION, secret: "large" }, META);
    expect(resultat(large)).toMatchObject({ ok: true, secret: "large" });
    const meme = await b.appeler("pw_login", { session_id: SESSION, secret: "meme" }, META);
    expect(resultat(meme)).toMatchObject({ ok: true, secret: "meme" });
    expect(core.vues.map((v) => v.chemin)).toEqual([
      "/api/internal/secrets/match",
      "/api/internal/secrets/match",
      "/api/internal/secrets/match",
    ]);
    expect(corpsRecus("POST /login")).toHaveLength(2);
  });

  it("sous-agent sur la session du compte ouverte pour un secret qui exclut les sous-agents : refusé ; le chat : admis", async () => {
    const b = await client();
    core.repondre("/api/internal/secrets/match", [
      200,
      { secrets: [applicable("intranet", "web-login", "strict", { subagents: false })] },
    ]);
    await b.appeler("pw_session", { action: "start", url: `${SITE}/login` }, META);
    const sousAgent = {
      ...META,
      chat_id: "c1#task-t1",
      subagent: { type: "web", id: "t1", browser_session: "user" },
    };
    const r = await b.appeler(
      "pw_act",
      { session_id: SESSION, action: "click", target: "text=Go" },
      sousAgent,
    );
    expect(erreur(r)).toMatchObject({ error: "secret_not_attached" });
    expect(String(erreur(r)["message"])).toContain("sub-agents may not use");
    expect(corpsRecus("POST /action")).toEqual([]);
    const chat = await b.appeler("pw_act", { session_id: SESSION, action: "click", target: "text=Go" }, META);
    expect(chat["isError"]).not.toBe(true);
  });

  it("start à nouveau pour le même secret et la même origine : session reprise (ni /start ni résolution) ; disparue : rouverte ; http-auth sans nom d'utilisateur : refus sans résolution", async () => {
    const b = await client();
    const proxy: [number, Dict] = [200, { secrets: [applicable("proxy", "http-auth")] }];
    core.repondre("/api/internal/secrets/match", proxy, proxy, proxy);
    await b.appeler("pw_session", { action: "start", url: `${SITE}/a` }, META);
    const encore = resultat(await b.appeler("pw_session", { action: "start", url: `${SITE}/b` }, META));
    expect(encore).toMatchObject({ session_id: SESSION, reused: true, tls: "strict", secret: "proxy" });
    expect(encore).not.toHaveProperty("secure");
    expect(corpsRecus("POST /start")).toHaveLength(1);
    expect(corpsRecus("POST /action")).toEqual([
      expect.objectContaining({ session_id: SESSION, type: "goto", url: `${SITE}/b` }),
    ]);
    navigateur.imposees.set("POST /action", [
      [404, { error: "Session not found", code: "session_not_found" }],
    ]);
    await b.appeler("pw_session", { action: "start", url: `${SITE}/c` }, META);
    expect(corpsRecus("POST /start")).toHaveLength(2);
    expect(core.vues.filter((v) => v.chemin.endsWith("/resolve"))).toEqual([]);
    core.repondre("/api/internal/secrets/match", [
      200,
      { secrets: [applicable("anonyme", "http-auth", "strict", { username: null })] },
    ]);
    core.vues.length = 0;
    const sans = await b.appeler("pw_session", { action: "start", url: `${SITE}/`, secret: "anonyme" }, META);
    expect(erreur(sans)).toMatchObject({ error: "secret_username_required" });
    expect(String(erreur(sans)["message"])).toContain("has no user name");
    expect(core.vues.map((v) => v.chemin)).toEqual(["/api/internal/secrets/match"]);
    expect(corpsRecus("POST /start")).toHaveLength(2);
  });

  it("start à nouveau pour un secret déjà ouvert avec record_har, trace ou émulation : refus explicite, rien d'ouvert ; http-auth : le refus documenté", async () => {
    const b = await client();
    const intranet: [number, Dict] = [200, { secrets: [applicable("intranet", "web-login")] }];
    core.repondre("/api/internal/secrets/match", intranet, intranet, intranet);
    await b.appeler("pw_session", { action: "start", url: `${SITE}/login` }, META);
    const r = await b.appeler(
      "pw_session",
      { action: "start", url: `${SITE}/b`, trace: true, device: "iPhone 13" },
      META,
    );
    expect(erreur(r)).toMatchObject({ error: "session_options_need_new_session" });
    expect(String(erreur(r)["message"])).toContain("trace, device");
    expect(String(erreur(r)["fix"])).toContain("pw_session action='stop'");
    expect(corpsRecus("POST /action")).toEqual([]);
    const sans = resultat(await b.appeler("pw_session", { action: "start", url: `${SITE}/b` }, META));
    expect(sans).toMatchObject({ reused: true });
    const proxy: [number, Dict] = [200, { secrets: [applicable("proxy", "http-auth")] }];
    core.repondre("/api/internal/secrets/match", proxy);
    await b.appeler("pw_session", { action: "start", url: `${SITE}/a` }, META);
    core.repondre("/api/internal/secrets/match", proxy);
    const har = await b.appeler("pw_session", { action: "start", url: `${SITE}/a`, record_har: true }, META);
    expect(erreur(har)).toMatchObject({ error: "recording_with_credentials" });
  });

  it("session fermée sur un déclencheur (409 secret_session_closed) : le core détache le secret, erreur en clair, liaison oubliée", async () => {
    const b = await client();
    core.repondre("/api/internal/secrets/match", [200, { secrets: [applicable("intranet")] }]);
    await b.appeler("pw_session", { action: "start", url: `${SITE}/login` }, META);
    core.vues.length = 0;
    navigateur.imposees.set("POST /action", [
      [409, { error: "The secure session was closed: tripwire.", code: "secret_session_closed" }],
    ]);
    core.repondre("/api/internal/secrets/tripwire", [200, { ok: true, detached: true }]);
    const r = await b.appeler("pw_act", { session_id: SESSION, action: "click", target: "text=Go" }, META);
    expect(erreur(r)).toMatchObject({ error: "secret_session_closed", session_closed: true });
    expect(String(erreur(r)["message"])).toContain("Secret 'intranet' was detached from this conversation");
    expect(String(erreur(r)["fix"])).toContain("Do not retry the login");
    expect(core.vues).toEqual([
      expect.objectContaining({
        chemin: "/api/internal/secrets/tripwire",
        corps: { name: "intranet" },
        identite: expect.objectContaining({ user_id: 7, chat_id: "c1" }),
      }),
    ]);
    const apres = await b.appeler("pw_login", { session_id: SESSION }, META);
    expect(String(erreur(apres)["message"])).toContain("not opened for a vault secret");
  });
});
