// SPDX-License-Identifier: MIT
/** packages/navigateur/test/client.test.ts — client du service navigateur : vecteurs Python (fonctions pures, points d'entrée), transport contre un faux service, propriétaire imposé. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";

import {
  avecProprietaire,
  axExtractNodesFromInspect,
  classerErreur,
  buildLocatorPayload,
  clampItems,
  ClientNavigateur,
  clipResult,
  dslToByKw,
  dslToSelector,
  echapperDsl,
  encoderParams,
  errPw,
  first,
  mergeTarget,
  mergeValue,
  parseTargetDsl,
  POINTS_D_ENTREE,
  pwVerb,
  refusSessionDAutrui,
  refusUrl,
  screenshotResult,
  urlServiceNavigateur,
  waitPayload,
} from "../src/client";
import type { Locateur } from "../src/client";
import { registerPwSessionOwner, unregisterPwSessionOwner } from "../src/session";
import { refusMessageAnglais } from "../src/url";

interface Appel {
  m: string;
  e: string;
  json?: unknown;
  params?: Dict;
  timeout?: number;
  ferme?: boolean;
}
interface Recu {
  methode: string;
  chemin: string;
  query: [string, string][];
  json: unknown;
  type: string | null;
}
const v = pyJsonLoads(
  readFileSync(new URL("./vecteurs/navigateur_client.json", import.meta.url), "utf-8"),
) as {
  budget: number;
  timeout: number;
  erreurs: { msg: unknown; kw: Dict; valeur: Dict }[];
  dsl: { target: string; parse: Dict; selecteur: string; by: Dict }[];
  waits: { v: unknown; valeur: Dict }[];
  clamps: { v: unknown; defaut?: number; valeur: number }[];
  firsts: { v: unknown[]; valeur: string }[];
  merges: { v: unknown[]; valeur: string }[];
  targets: { target: string; selector: string; valeur: string }[];
  verbes: { outil: string; args: unknown; valeur: string }[];
  locateurs: { kw: Locateur; valeur: [Dict, Dict] }[];
  captures: { r: unknown; kw: { full_page?: unknown; target?: string }; valeur: unknown }[];
  inspections: { r: unknown; valeur: Dict[] }[];
  clips: { obj: unknown; valeur: unknown }[];
  proprietaires: {
    owner: string;
    methode: string;
    json: unknown;
    params: Dict | null;
    valeur: [unknown, Dict | null];
  }[];
  points_d_entree: [string, string][];
  params: { params: Dict; valeur: string }[];
  script: Record<string, [number, string, string, number]>;
  transport: Record<"req" | "req_status", { appel: Appel; resultat: unknown; recu: Recu[] }[]>;
};

/** Écart voulu (ecarts-python.md de la v0.1.2, « Outils web ») : code fixe à la place du slug Python d'un message porteur de données. */
const CODES_TS: Readonly<Record<string, string>> = {
  playwright_error_500: "service_error",
  playwright_error_503: "service_error",
  expecting_value_line_1_column_1_char_0: "invalid_response",
  navigation_chou_e_vers_x_net_err_name: "navigation_failed",
  timeout_0_3s: "timeout",
};

/** Écart voulu (ecarts-python.md de la v0.1.2, « Outils web ») : un `|` qui n'annonce pas une clé reste dans la valeur (le Python coupait toute cible sur `|`). */
const DSL_TS: Readonly<Record<string, { parse: Dict; selecteur: string; by: Dict }>> = {
  "text=a|b": {
    parse: { text: "a|b" },
    selecteur: "a|b",
    by: {
      by_role: null,
      by_name: null,
      by_text: "a|b",
      by_label: null,
      by_placeholder: null,
      by_test_id: null,
      by_css: null,
      by_xpath: null,
      by_alt: null,
      by_title: null,
      ref: null,
      nth: null,
    },
  },
};

/** Résultat Python attendu ramené à l'écart voulu du TS (codes d'erreur). */
function versTs(r: unknown): unknown {
  if (r === null || typeof r !== "object" || Array.isArray(r)) return r;
  const e = (r as Dict)["error"];
  return typeof e === "string" && Object.hasOwn(CODES_TS, e) ? { ...(r as Dict), error: CODES_TS[e] } : r;
}

describe("vecteurs Python de firefox_tools", () => {
  it("_err : code dérivé du message, message, correctif (indice ou fix) ; code fixe pour un message porteur de données (écart)", () => {
    for (const c of v.erreurs) {
      const { hint, ...reste } = c.kw;
      expect(errPw(c.msg, hint === undefined ? "" : (hint as string | null), reste), String(c.msg)).toEqual(
        versTs(c.valeur),
      );
    }
  });

  it("codes fixes sans donnée : action et condition inconnues, délai, message ANSI nettoyé", () => {
    expect(errPw("unknown action 'bof'")["error"]).toBe("unknown_action");
    expect(errPw("action='voler' unknown")["error"]).toBe("unknown_action");
    expect(errPw("condition='bof' unknown")["error"]).toBe("unknown_condition");
    expect(errPw("Timeout (10s)")["error"]).toBe("timeout");
    expect(errPw("target or selector required for a condition wait")["error"]).toBe("target_required");
    expect(errPw("x", "", { message: "\u001b[2m- waiting\u001b[22m" })["message"]).toBe("- waiting");
    expect(errPw("path requires site= and to_path=")["error"]).toBe("path_requires_site_and_to_path");
  });

  it("DSL des cibles : analyse, sélecteur unique, paramètres by_*", () => {
    for (const c0 of v.dsl) {
      const c = { ...c0, ...DSL_TS[c0.target] };
      expect(parseTargetDsl(c.target), c.target).toEqual(c.parse);
      expect(dslToSelector(c.target), c.target).toBe(c.selecteur);
      expect(dslToByKw(c.target), c.target).toEqual(c.by);
    }
  });

  it("DSL : un | dans une valeur ne coupe plus la cible, \\| l'y garde toujours ; cible générée relue telle quelle (écart)", () => {
    expect(parseTargetDsl('css=a:has-text("Docs | Produit")')).toEqual({
      css: 'a:has-text("Docs | Produit")',
    });
    expect(parseTargetDsl("role=link|name=Accueil | Contact|nth=1")).toEqual({
      role: "link",
      name: "Accueil | Contact",
      nth: 1,
    });
    expect(parseTargetDsl("css=[lang|=fr]")).toEqual({ css: "[lang|=fr]" });
    expect(parseTargetDsl("text=a\\|name=b")).toEqual({ text: "a|name=b" });
    const nom = "Trier | name=prix";
    expect(echapperDsl(nom)).toBe("Trier \\| name=prix");
    expect(parseTargetDsl(`role=button|name=${echapperDsl(nom)}`)).toEqual({ role: "button", name: nom });
    expect(echapperDsl("Docs | Produit")).toBe("Docs | Produit");
    expect(dslToSelector('css=a:has-text("Docs | Produit")')).toBe('a:has-text("Docs | Produit")');
    expect(mergeTarget("", "[lang|=fr]")).toBe("css=[lang|=fr]");
  });

  it("attente, bornes, synonymes, cible fusionnée, verbe", () => {
    for (const c of v.waits) expect(waitPayload(c.v), JSON.stringify(c.v)).toEqual(c.valeur);
    for (const c of v.clamps) expect(clampItems(c.v, c.defaut ?? 25), JSON.stringify(c.v)).toBe(c.valeur);
    for (const c of v.firsts) expect(first(...c.v)).toBe(c.valeur);
    for (const c of v.merges) expect(mergeValue(...c.v)).toBe(c.valeur);
    for (const c of v.targets) expect(mergeTarget(c.target, c.selector)).toBe(c.valeur);
    for (const c of v.verbes) expect(pwVerb(c.outil, c.args)).toBe(c.valeur);
  });

  it("charge du locateur, capture d'écran, nœuds AX", () => {
    for (const c of v.locateurs) expect(buildLocatorPayload(c.kw), JSON.stringify(c.kw)).toEqual(c.valeur);
    for (const c of v.captures)
      expect(
        screenshotResult(c.r, { fullPage: c.kw.full_page, target: c.kw.target }),
        JSON.stringify(c.r),
      ).toEqual(c.valeur);
    for (const c of v.inspections)
      expect(axExtractNodesFromInspect(c.r), JSON.stringify(c.r)).toEqual(c.valeur);
  });

  it(`résultats rognés au budget (${v.budget} caractères JSON), enveloppe partielle au-delà du double`, () => {
    for (const c of v.clips) expect(clipResult(c.obj)).toEqual(c.valeur);
  });

  it("paramètres de requête encodés comme requests (urlencode doseq, quote_plus, None omis)", () => {
    for (const c of v.params) expect(encoderParams(c.params), JSON.stringify(c.params)).toBe(c.valeur);
  });

  it("points d'entrée : la liste du paquet est celle du source Python", () => {
    expect(POINTS_D_ENTREE.map(([m, e]) => [m, e])).toEqual(v.points_d_entree);
  });

  it("propriétaire : ajouté au corps (POST) ou aux paramètres (GET) ; IMPOSÉ quand l'appelant en donne un autre (écart)", () => {
    for (const c of v.proprietaires) {
      const attendu = c.valeur;
      const dejaLa =
        (c.methode === "GET" && c.params !== null && "owner" in c.params) ||
        (c.methode !== "GET" && typeof c.json === "object" && c.json !== null && "owner" in c.json);
      const r = avecProprietaire(c.owner, c.json, c.params, c.methode);
      if (!dejaLa) expect(r, JSON.stringify(c)).toEqual(attendu);
      else expect(c.methode === "GET" ? r[1]?.["owner"] : (r[0] as Dict)["owner"]).toBe(c.owner);
    }
  });
});

/** Réponses du service absentes des vecteurs Python : code stable hors 404 (écart voulu, ecarts-python.md de la v0.1.2 « Outils web »). */
const SCRIPT_TS: Record<string, [number, string, string, number]> = {
  "/nav-code": [
    502,
    "application/json",
    JSON.stringify({
      status: "nav_error",
      code: "navigation_failed",
      error: "Navigation to https://x.invalid/ failed: net::ERR_TUNNEL_CONNECTION_FAILED",
      fix: "The session and the current tab are intact.",
    }),
    0,
  ],
  "/refus-code": [
    403,
    "application/json",
    JSON.stringify({ code: "url_blocked", error: "Adresse refusée" }),
    0,
  ],
  "/onglet": [
    500,
    "application/json",
    JSON.stringify({
      error: "Timeout 300ms exceeded.",
      tab_hint: "Actions run on tab index 1.",
      active_tab: 1,
      total_tabs: 2,
    }),
    0,
  ],
};

describe("transport contre un faux service navigateur", () => {
  let serveur: Server;
  let base = "";
  let ferme = "";
  let recu: Recu[] = [];

  beforeAll(async () => {
    serveur = createServer((req, rep) => {
      const morceaux: Buffer[] = [];
      req.on("data", (d: Buffer) => morceaux.push(d));
      req.on("end", () => {
        const u = new URL(req.url ?? "/", "http://x");
        const corps = Buffer.concat(morceaux).toString("utf-8");
        recu.push({
          methode: req.method ?? "",
          chemin: u.pathname,
          query: [...u.searchParams],
          json: corps ? (JSON.parse(corps) as unknown) : null,
          type: req.headers["content-type"] ?? null,
        });
        const cle = u.pathname === "/smart_inspect" ? "/ok" : u.pathname;
        const [statut, type, texte, delai] = v.script[cle] ?? SCRIPT_TS[cle] ?? [500, "text/plain", "?", 0];
        setTimeout(() => {
          if (rep.destroyed) return;
          rep.writeHead(statut, { "content-type": type, "content-length": Buffer.byteLength(texte) });
          rep.end(texte);
        }, delai * 1000);
      });
    });
    await new Promise<void>((fin) => serveur.listen(0, "127.0.0.1", fin));
    base = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`;
    const sonde = createServer();
    await new Promise<void>((fin) => sonde.listen(0, "127.0.0.1", fin));
    ferme = `http://127.0.0.1:${(sonde.address() as AddressInfo).port}`;
    await new Promise<void>((fin) => sonde.close(() => fin()));
  });
  afterAll(async () => {
    serveur.closeAllConnections();
    await new Promise<void>((fin) => serveur.close(() => fin()));
  });

  const client = (a: Appel): ClientNavigateur =>
    new ClientNavigateur({ owner: "alice", base: a.ferme ? ferme : base, delaiS: v.timeout });

  it("req : mêmes résultats et mêmes requêtes reçues que _req (propriétaire imposé)", async () => {
    for (const c of v.transport.req) {
      recu = [];
      const r = await client(c.appel).req(c.appel.m, c.appel.e, {
        json: c.appel.json,
        params: c.appel.params,
        timeout: c.appel.timeout,
      });
      expect(r, JSON.stringify(c.appel)).toEqual(versTs(c.resultat));
      const attendu = c.recu.map((x) =>
        typeof x.json === "object" && x.json !== null
          ? { ...x, json: { ...(x.json as Dict), owner: "alice" } }
          : x,
      );
      expect(recu, JSON.stringify(c.appel)).toEqual(attendu);
    }
  }, 30_000);

  it("req_status : statut et corps bruts, -1 sur échec de transport", async () => {
    for (const c of v.transport.req_status) {
      recu = [];
      const r = await client(c.appel).reqStatus(c.appel.m, c.appel.e, {
        json: c.appel.json,
        params: c.appel.params,
        timeout: c.appel.timeout,
      });
      expect(r, JSON.stringify(c.appel)).toEqual(c.resultat);
      expect(recu, JSON.stringify(c.appel)).toEqual(c.recu);
    }
  }, 30_000);

  it("finishAct joint l'instantané léger ; axGetCurrentUrl lit l'URL ; un service absent ne casse rien", async () => {
    const c = new ClientNavigateur({ owner: "alice", base });
    recu = [];
    expect(await c.finishAct({ ok: true }, "s1", true, 500)).toEqual({
      ok: true,
      page_after: pyJsonLoads(v.script["/ok"]![2]),
    });
    expect(recu[0]?.query).toEqual([
      ["session_id", "s1"],
      ["level", "lite"],
      ["viewport_only", "true"],
      ["max_items", "200"],
      ["skip_screenshot", "true"],
      ["owner", "alice"],
    ]);
    expect(await c.finishAct({ error: "x" }, "s1", true)).toEqual({ error: "x" });
    expect(await c.axGetCurrentUrl("s1")).toBe("http://a/");
    const absent = new ClientNavigateur({ owner: "alice", base: ferme });
    expect(await absent.finishAct({ ok: true }, "s1", true)).toEqual({ ok: true });
    expect(await absent.axGetCurrentUrl("s1")).toBe("");
  });

  it("relecture : paramètre illisible et délai nul rendent une enveloppe ; erreurs DNS et TLS rangées « service absent »", async () => {
    const c = new ClientNavigateur({ owner: "alice", base });
    const illisible = (await c.req("GET", "/ok", { params: { filter: "\ud800" } })) as Dict;
    expect(illisible["ok"]).toBe(false);
    expect((await c.reqStatus("GET", "/ok", { params: { filter: "\ud800" } }))[0]).toBe(-1);
    const message =
      "Attempted to set connect timeout to 0, but the timeout cannot be set to a value less than or equal to 0.";
    expect((await c.req("GET", "/lent", { timeout: 0 })) as Dict).toMatchObject({ ok: false, message });
    expect(await c.reqStatus("GET", "/lent", { timeout: 0 })).toEqual([-1, { error: message }]);
    const avecCode = (code: string): Error => Object.assign(new Error(code), { code });
    for (const code of [
      "EAI_AGAIN",
      "ENOTFOUND",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "ERR_SOCKET_CONNECTION_TIMEOUT",
    ])
      expect(classerErreur(avecCode(code)).genre, code).toBe("connexion");
    for (const code of ["ERR_INVALID_URL", "UND_ERR_INVALID_ARG"])
      expect(classerErreur(avecCode(code)).genre, code).toBe("autre");
    expect(classerErreur(avecCode("UND_ERR_HEADERS_TIMEOUT")).genre).toBe("delai");
  });

  it("code stable du service rendu à tout statut (écart : Python ne le lisait qu'en 404) ; sans code, code fixe sans donnée (écart) ; onglet actif rappelé (tab_hint)", async () => {
    const c = new ClientNavigateur({ owner: "alice", base });
    expect(await c.req("POST", "/nav-code", { json: { session_id: "s1" } })).toEqual({
      ok: false,
      error: "navigation_failed",
      message: "Navigation to https://x.invalid/ failed: net::ERR_TUNNEL_CONNECTION_FAILED",
      fix: "The session and the current tab are intact.",
    });
    expect(await c.req("POST", "/refus-code")).toEqual({
      ok: false,
      error: "url_blocked",
      message: "Adresse refusée",
    });
    expect(((await c.req("POST", "/nav")) as Dict)["error"]).toBe("navigation_failed");
    expect(await c.req("POST", "/onglet")).toEqual({
      ok: false,
      error: "timeout",
      message: "Timeout 300ms exceeded. [Actions run on tab index 1.]",
      active_tab: 1,
      total_tabs: 2,
    });
  });

  it("aucun client sans propriétaire", () => {
    expect(() => new ClientNavigateur({ owner: "" })).toThrow("sans propriétaire");
  });
});

describe("refus anticipés", () => {
  it("URL refusée : enveloppe url_blocked avec le message du service ; garde en échec : null (le service tranche)", async () => {
    const hote = { adresses: [], reseaux: [] };
    expect(await refusUrl("http://127.0.0.1/", { allowlist: [], hote })).toEqual({
      ok: false,
      error: "url_blocked",
      message:
        "Address refused by the browser policy: address reserved to the host or its local network (blocked_ip (127.0.0.1)). URL: http://127.0.0.1/. The browser can only reach http/https sites outside the machine hosting Elpis.",
      fix: "pick an http(s) address of a site outside the machine hosting Elpis",
    });
    expect(
      await refusUrl("https://example.com/", {
        allowlist: [],
        hote,
        resoudre: async () => ["93.184.216.34"],
      }),
    ).toBeNull();
    expect(
      await refusUrl("https://example.com/", { allowlist: 5, hote, resoudre: async () => ["10.0.0.1"] }),
    ).toBeNull();
    expect((await refusUrl(null, { allowlist: [], hote }))?.["message"]).toBe(
      refusMessageAnglais("", "adresse vide"),
    );
  });

  it("session d'un autre compte ou inconnue : refusée ; la sienne : acceptée ; sans identifiant : rien", async () => {
    const dossier = mkdtempSync(join(tmpdir(), "elpis-pw-client-"));
    const avant = process.env["PW_OWNERS_DIR"];
    process.env["PW_OWNERS_DIR"] = dossier;
    onTestFinished(() => {
      if (avant === undefined) delete process.env["PW_OWNERS_DIR"];
      else process.env["PW_OWNERS_DIR"] = avant;
      rmSync(dossier, { recursive: true, force: true });
    });
    await registerPwSessionOwner("sessAAAA1111", "alice");
    expect(await refusSessionDAutrui("sessAAAA1111", "alice")).toBeNull();
    expect((await refusSessionDAutrui("sessAAAA1111", "bob"))?.["message"]).toBe(
      "this browser session belongs to another user",
    );
    expect(await refusSessionDAutrui("sessZZZZ9999", "alice")).toEqual({
      ok: false,
      error: "not_your_session",
      message: "unknown browser session for this account",
      fix: "pw_session(action='start', url=…) opens (or finds) your own",
    });
    expect(await refusSessionDAutrui("", "alice")).toBeNull();
    await unregisterPwSessionOwner("sessAAAA1111");
  });
});

describe("adresse du service navigateur", () => {
  it("PLAYWRIGHT_API_URL, sinon http://localhost:3000 ; le client la reprend", () => {
    const avant = process.env["PLAYWRIGHT_API_URL"];
    onTestFinished(() => {
      if (avant === undefined) delete process.env["PLAYWRIGHT_API_URL"];
      else process.env["PLAYWRIGHT_API_URL"] = avant;
    });
    delete process.env["PLAYWRIGHT_API_URL"];
    expect(urlServiceNavigateur()).toBe("http://localhost:3000");
    process.env["PLAYWRIGHT_API_URL"] = "http://127.0.0.1:3999";
    expect(urlServiceNavigateur()).toBe("http://127.0.0.1:3999");
    expect(new ClientNavigateur({ owner: "alice" }).base).toBe("http://127.0.0.1:3999");
  });
});
