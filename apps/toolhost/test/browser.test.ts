// SPDX-License-Identifier: MIT
/** apps/toolhost/test/browser.test.ts — famille browser de l'hôte : outils du golden, mémoire AX éteinte sans base de l'hôte, propriétaire imposé à chaque requête et propriété posée par l'outil, reprises et erreurs de pw_wait, onglets (switch, onglet actif rappelé), forme de pw_session health. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { compilerSchema, meilleureErreur } from "@elpis/mcp";
import { getPwSessionOwner, pwOwner } from "@elpis/navigateur";
import { ouvrirEnMemoire, ServeurOutils } from "@elpis/outils-mcp";
import type { ConnexionEnMemoire } from "@elpis/outils-mcp";
import goldenBrowser from "@elpis/outils-mcp/goldens/browser.json" with { type: "json" };
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ClientBrut } from "../../../packages/outils-mcp/test/aides";
import { familleBrowser } from "../src/mcp/browser";
import { journalMuet } from "./aides";
import { FauxNavigateur, SESSION, SITE } from "./faux-navigateur";
import { portLibre } from "./interop/aides-python";

const dossier = mkdtempSync(path.join(tmpdir(), "elpis-browser-"));
let faux: FauxNavigateur;
const ouvertes: ConnexionEnMemoire[] = [];

beforeAll(async () => {
  faux = await FauxNavigateur.demarrer();
});

afterEach(async () => {
  for (const c of ouvertes.splice(0)) await c.fermer();
  vi.unstubAllEnvs();
  faux.reinitialiser();
});

afterAll(async () => {
  await faux.arreter();
  rmSync(dossier, { recursive: true, force: true });
});

/** Client en mémoire de la famille telle que l'hôte la sert (base de l'hôte non ouverte : mémoire AX éteinte). */
async function client(): Promise<ClientBrut> {
  vi.stubEnv("PLAYWRIGHT_API_URL", faux.url);
  vi.stubEnv("PW_OWNERS_DIR", path.join(dossier, "owners"));
  const serveur = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
  serveur.enregistrerFamille("browser", familleBrowser({ journal: journalMuet }).outils);
  const c = await ouvrirEnMemoire(serveur);
  ouvertes.push(c);
  const b = new ClientBrut(c.transport);
  await b.demarrer();
  await b.initialiser();
  return b;
}

const contenu = (r: Dict): Dict => r["structuredContent"] as Dict;
const texte = (r: Dict): string => ((r["content"] as Dict[])[0] as Dict)["text"] as string;

describe("famille browser servie par l'hôte", () => {
  it("les 14 outils du golden Python, dans l'ordre d'enregistrement, définitions identiques", async () => {
    const b = await client();
    const liste = ((await b.requete("tools/list"))["result"] as Dict)["tools"] as Dict[];
    expect(liste.map((t) => t["name"])).toEqual(Object.keys(goldenBrowser.fonctions));
    expect(liste).toEqual(expect.arrayContaining(goldenBrowser.outils as Dict[]));
  });

  it("sans base de l'hôte : pw_memory refusé, pw_act sans relevé d'URL avant ni après le geste", async () => {
    const b = await client();
    expect(texte(await b.appeler("pw_memory", { action: "sites" }, { username: "bob" }))).toContain(
      '"error": "ax_memory_unavailable"',
    );
    await b.appeler("pw_session", { action: "start", url: `${SITE}/` }, { username: "bob" });
    faux.vues.length = 0;
    await b.appeler(
      "pw_act",
      { session_id: SESSION, action: "click", target: "role=link|name=Produits" },
      { username: "bob" },
    );
    expect(faux.vues.map((v) => `${v.methode} ${v.chemin}`)).toEqual(["POST /action", "GET /smart_inspect"]);
  });

  it("propriétaire du compte (nom assaini) imposé à chaque requête ; la session ouverte est enregistrée à son nom", async () => {
    const b = await client();
    const r = await b.appeler("pw_session", { action: "start", url: `${SITE}/` }, { username: "rené" });
    expect(contenu(r)).toMatchObject({ result: { session_id: SESSION } });
    expect(await getPwSessionOwner(SESSION)).toBe("ren");
    await b.appeler("pw_page", { session_id: SESSION, action: "tabs" }, { username: "rené" });
    await b.appeler("pw_page", { session_id: SESSION, action: "text" }, { username: "rené" });
    const owner = pwOwner("ren");
    for (const v of faux.vues)
      expect(
        v.methode === "GET"
          ? new URLSearchParams(v.requete).get("owner")
          : (JSON.parse(v.corps) as Dict)["owner"],
      ).toBe(owner);
    expect(
      texte(await b.appeler("pw_page", { session_id: SESSION, action: "tabs" }, { username: "alice" })),
    ).toContain("belongs to another user");
  });

  it("pw_wait : session occupée (423, 429) réessayée, 404 et 410 rendus, service absent signalé", async () => {
    const b = await client();
    await b.appeler("pw_session", { action: "start", url: `${SITE}/` }, { username: "bob" });
    const attendre = (): Promise<Dict> =>
      b.appeler(
        "pw_wait",
        { session_id: SESSION, target: "css=.x", condition: "visible" },
        { username: "bob" },
      );
    faux.imposees.set("POST /wait_for_dynamic", [
      [423, {}],
      [429, {}],
      [200, { status: "met", via: "locator" }],
    ]);
    expect(contenu(await attendre())["result"]).toMatchObject({ ok: true, status: "met", via: "locator" });
    expect(faux.vues.filter((v) => v.chemin === "/wait_for_dynamic")).toHaveLength(3);
    faux.imposees.set("POST /wait_for_dynamic", [[404, {}]]);
    expect(texte(await attendre())).toContain('"error": "session_not_found"');
    faux.imposees.set("POST /wait_for_dynamic", [[410, {}]]);
    expect(texte(await attendre())).toContain('"error": "session_expired"');
    faux.imposees.set("POST /wait_for_dynamic", [[500, { error: { cause: "x" } }]]);
    expect(texte(await attendre())).toContain(`"message": "{'cause': 'x'}"`);
    vi.stubEnv("PLAYWRIGHT_API_URL", `http://127.0.0.1:${await portLibre()}`);
    expect(texte(await attendre())).toContain('"message": "connection_refused"');
  });

  it("pw_wait seconds : pause bornée par PLAYWRIGHT_WAIT_MAX_S, sans session ni service", async () => {
    const b = await client();
    vi.stubEnv("PLAYWRIGHT_WAIT_MAX_S", "0");
    const t0 = performance.now();
    const r = contenu(await b.appeler("pw_wait", { seconds: 30 }, { username: "bob" }))["result"];
    expect(r).toMatchObject({ ok: true, mode: "duration" });
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(faux.vues).toEqual([]);
  });

  it("pw_page tab_new : switch=true transmis au service ; sans lui, le corps du Python (url seule)", async () => {
    const b = await client();
    await b.appeler("pw_session", { action: "start", url: `${SITE}/` }, { username: "bob" });
    faux.vues.length = 0;
    await b.appeler(
      "pw_page",
      { session_id: SESSION, action: "tab_new", value: `${SITE}/a` },
      { username: "bob" },
    );
    await b.appeler(
      "pw_page",
      { session_id: SESSION, action: "tab_new", value: `${SITE}/b`, switch: true },
      { username: "bob" },
    );
    expect(faux.vues.filter((v) => v.chemin === "/new_tab").map((v) => JSON.parse(v.corps) as Dict)).toEqual([
      { session_id: SESSION, url: `${SITE}/a`, owner: "bob" },
      { session_id: SESSION, url: `${SITE}/b`, switch: true, owner: "bob" },
    ]);
  });

  it("pw_act : délai dépassé sur une session à plusieurs onglets, onglet actif rappelé (lu sur /sessions) ; un seul onglet : message inchangé", async () => {
    const b = await client();
    await b.appeler("pw_session", { action: "start", url: `${SITE}/` }, { username: "bob" });
    const clic = async (): Promise<Dict> =>
      JSON.parse(
        texte(
          await b.appeler(
            "pw_act",
            { session_id: SESSION, action: "click", target: "css=#x", observe: false },
            { username: "bob" },
          ),
        ),
      ) as Dict;
    const delai: [number, Dict] = [500, { error: "locator.click: Timeout 10000ms exceeded." }];
    const sessions = (tabs: number): [number, Dict] => [
      200,
      { sessions: [{ session_id: SESSION, tabs, active_tab: 0, url: `${SITE}/` }] },
    ];
    faux.imposees.set("POST /action", [delai, delai]);
    faux.imposees.set("GET /sessions", [sessions(2), sessions(1)]);
    expect(await clic()).toMatchObject({
      ok: false,
      message: `locator.click: Timeout 10000ms exceeded. [Actions run on tab index 0 of 2 tabs (${SITE}/): pw_page(action="tabs") lists them, pw_page(action="tab_switch", index=N) switches.]`,
      active_tab: 0,
      total_tabs: 2,
    });
    expect(await clic()).toMatchObject({ ok: false, message: "locator.click: Timeout 10000ms exceeded." });
  });

  it("pw_session health : la forme du service (sessions = liste du compte) passe la validation du client du core ; l'ancienne (sessions = nombre) non", async () => {
    const b = await client();
    const schema = (goldenBrowser.outils as Dict[]).find((o) => o["name"] === "pw_session")?.["outputSchema"];
    const valider = compilerSchema(schema);
    const sante = async (corps: Dict): Promise<unknown> => {
      faux.imposees.set("GET /health", [[200, corps]]);
      return contenu(await b.appeler("pw_session", { action: "health" }, { username: "bob" }));
    };
    const commun = { ok: true, service: "browser", status: "running", engine: "chromium" };
    expect(
      meilleureErreur(valider, schema, await sante({ ...commun, sessions: 2, session_list: [] })),
    ).not.toBeNull();
    expect(
      meilleureErreur(
        valider,
        schema,
        await sante({ ...commun, sessions: [{ id: "abcd1234…", tabs: 2, active_tab: 0 }], session_count: 2 }),
      ),
    ).toBeNull();
  });
});
