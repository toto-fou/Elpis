// SPDX-License-Identifier: MIT
/** apps/toolhost/test/browser-interne.test.ts — routes internes du navigateur des bacs pour main : sessions d'enfants orphelines fermées par le service du bac du compte, URL courante d'une session ; porte de l'enveloppe, services muets. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { RequestListener, Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { surchargerConfig } from "@elpis/config";
import { cheminsNavigateurBac } from "@elpis/navigateur";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { entetes, hoteTest } from "./aides";
import type { HoteTest } from "./aides";

const tmp = mkdtempSync(path.join(tmpdir(), "nav-interne-"));
const ancienRun = process.env["RUNTIME_DIRECTORY"];
let restaurer: () => void = () => undefined;
let h: HoteTest;
const serveurs: Server[] = [];
const vus: { url: string; auth: unknown; corps: string }[] = [];

beforeAll(async () => {
  restaurer = surchargerConfig({ SANDBOX_DIR: path.join(tmp, "sb") });
  process.env["RUNTIME_DIRECTORY"] = path.join(tmp, "run");
  h = await hoteTest();
});

afterEach(async () => {
  vus.length = 0;
  for (const s of serveurs.splice(0))
    await new Promise<void>((ok) => (s.closeAllConnections(), s.close(() => ok())));
});

afterAll(async () => {
  await h.fermer();
  restaurer();
  if (ancienRun === undefined) delete process.env["RUNTIME_DIRECTORY"];
  else process.env["RUNTIME_DIRECTORY"] = ancienRun;
  rmSync(tmp, { recursive: true, force: true });
});

/** Faux service navigateur du bac de `compte`, avec son jeton dans le dossier privé de l'hôte. */
async function lancerService(compte: string, jeton: string, repondre: RequestListener): Promise<void> {
  const c = cheminsNavigateurBac(compte);
  mkdirSync(path.dirname(c.socket), { recursive: true });
  mkdirSync(path.dirname(c.jeton), { recursive: true });
  writeFileSync(c.jeton, `${jeton}\n`);
  const s = createServer((req, res) => {
    let corps = "";
    req.on("data", (b: Buffer) => (corps += b.toString()));
    req.on("end", () => {
      vus.push({ url: `${req.method} ${req.url}`, auth: req.headers.authorization, corps });
      repondre(req, res);
    });
  });
  serveurs.push(s);
  await new Promise<void>((ok) => s.listen(c.socket, ok));
}

const json = (res: Parameters<RequestListener>[1], d: unknown, statut = 200): void => {
  res.writeHead(statut, { "content-type": "application/json" }).end(JSON.stringify(d));
};

describe("/api/internal/browser/cleanup-children", () => {
  it("un POST au seul service du bac du compte de l'enveloppe, avec son jeton ; service d'un autre compte jamais joint ; service muet : 0", async () => {
    await lancerService("hugo", "jeton-h", (_q, res) => json(res, { cleaned: 2 }));
    await lancerService("alice", "jeton-a", (_q, res) => json(res, { cleaned: 5 }));
    const r = await h.app.inject({
      method: "POST",
      url: "/api/internal/browser/cleanup-children",
      headers: entetes(7, "hugo"),
      payload: { older_than_ms: 7 },
    });
    expect([r.statusCode, r.json()]).toEqual([200, { cleaned: 2 }]);
    expect(vus).toEqual([
      { url: "POST /cleanup_children", auth: "Bearer jeton-h", corps: JSON.stringify({ older_than_ms: 7 }) },
    ]);
    await lancerService("dave", "jeton-d", (q) => void q.socket.destroy());
    const muet = await h.app.inject({
      method: "POST",
      url: "/api/internal/browser/cleanup-children",
      headers: entetes(9, "dave"),
      payload: { older_than_ms: 7 },
    });
    expect([muet.statusCode, muet.json()]).toEqual([200, { cleaned: 0 }]);
    const sansBac = await h.app.inject({
      method: "POST",
      url: "/api/internal/browser/cleanup-children",
      headers: entetes(11, "carol"),
      payload: { older_than_ms: 7 },
    });
    expect([sansBac.statusCode, sansBac.json()]).toEqual([200, { cleaned: 0 }]);
  });

  it("401 sans enveloppe ou avec une enveloppe sans compte, 400 sur un âge invalide", async () => {
    const sans = await h.app.inject({
      method: "POST",
      url: "/api/internal/browser/cleanup-children",
      payload: { older_than_ms: 1 },
    });
    expect(sans.statusCode).toBe(401);
    const sansCompte = await h.app.inject({
      method: "POST",
      url: "/api/internal/browser/cleanup-children",
      headers: entetes(0, ""),
      payload: { older_than_ms: 1 },
    });
    expect(sansCompte.statusCode).toBe(401);
    for (const payload of [{}, { older_than_ms: "x" }, { older_than_ms: -1 }]) {
      const r = await h.app.inject({
        method: "POST",
        url: "/api/internal/browser/cleanup-children",
        headers: entetes(),
        payload,
      });
      expect(r.statusCode).toBe(400);
    }
  });
});

describe("/api/internal/browser/session-url", () => {
  const demander = (payload: unknown, enveloppe = true) =>
    h.app.inject({
      method: "POST",
      url: "/api/internal/browser/session-url",
      ...(enveloppe ? { headers: entetes(7, "hugo") } : {}),
      payload: payload as object,
    });

  it("URL courante lue au service du compte de l'enveloppe, propriétaire Playwright de ce compte", async () => {
    await lancerService("hugo", "jeton-h", (_q, res) => json(res, { url: "https://exemple.test/page" }));
    const r = await demander({ session_id: "s1" });
    expect([r.statusCode, r.json()]).toEqual([200, { url: "https://exemple.test/page" }]);
    expect(vus).toHaveLength(1);
    expect(vus[0]?.auth).toBe("Bearer jeton-h");
    expect(vus[0]?.url).toMatch(
      /^GET \/smart_inspect\?session_id=s1&owner=.*&skip_screenshot=true&level=lite$/u,
    );
  });

  it("champ current_url accepté ; refus du service, service arrêté : url nul", async () => {
    await lancerService("hugo", "jeton-h", (_q, res) => json(res, { current_url: "https://b.test/" }));
    expect((await demander({ session_id: "s1" })).json()).toEqual({ url: "https://b.test/" });
    for (const s of serveurs.splice(0))
      await new Promise<void>((ok) => (s.closeAllConnections(), s.close(() => ok())));
    expect((await demander({ session_id: "s1" })).json()).toEqual({ url: null });
    await lancerService("hugo", "jeton-h", (_q, res) => json(res, {}, 500));
    expect((await demander({ session_id: "s1" })).json()).toEqual({ url: null });
  });

  it("401 sans enveloppe, 400 sans identifiant de session", async () => {
    expect((await demander({ session_id: "s1" }, false)).statusCode).toBe(401);
    expect((await demander({})).statusCode).toBe(400);
  });
});
