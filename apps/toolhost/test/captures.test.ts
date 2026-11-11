// SPDX-License-Identifier: MIT
/** apps/toolhost/test/captures.test.ts — capture Playwright servie par l'hôte : nom, propriétaire, essais, suppression après service, erreurs du service. */
import { chmodSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { creerFamilleCaptures, sessionDeLaCapture } from "../src/captures";
import { creerAppToolhost } from "../src/app";
import { configTest, dossierTemporaire, entetes, journalMuet } from "./aides";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("noms de capture", () => {
  it("motifs du Python : étape, capture, vue ; 400 pour le reste", () => {
    expect(sessionDeLaCapture("shot_sessAAAA1111_12.png")).toBe("sessAAAA1111");
    expect(sessionDeLaCapture("step_sess-BBB-2222_0.png")).toBe("sess-BBB-2222");
    expect(sessionDeLaCapture("view_sessCCCC3333.png")).toBe("sessCCCC3333");
    for (const [nom, detail] of [
      ["shot_sessAAAA1111_1.jpg", "Invalid filename"],
      ["..shot_sessAAAA1111_1.png", "Invalid filename"],
      ["a/shot_sessAAAA1111_1.png", "Invalid filename"],
      ["shot_court_1.png", "Invalid screenshot filename pattern"],
      ["shot_sessAAAA1111_1.PNG", "Invalid screenshot filename pattern"],
      ["autre_sessAAAA1111.png", "Invalid screenshot filename pattern"],
    ] as const)
      expect(() => sessionDeLaCapture(nom), nom).toThrow(detail);
  });
});

describe("GET /api/playwright/screenshot/{filename}", () => {
  let service: Server;
  let base = "";
  const recu: string[] = [];
  let proprietaires = "";
  let fermerDossier = (): void => undefined;
  const attentes: number[] = [];

  beforeAll(async () => {
    service = createServer((req, rep) => {
      recu.push(`${req.method ?? ""} ${req.url ?? ""}`);
      const nom = req.url ?? "";
      if (req.method === "DELETE") {
        rep.writeHead(200).end("{}");
        return;
      }
      if (nom.endsWith("_404.png")) {
        rep.writeHead(404).end("absent");
        return;
      }
      if (nom.endsWith("_500.png")) {
        rep.writeHead(500).end("boom");
        return;
      }
      rep.writeHead(200, { "content-type": "image/png" }).end(PNG);
      return;
    });
    await new Promise<void>((fin) => service.listen(0, "127.0.0.1", fin));
    base = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
    [proprietaires, fermerDossier] = dossierTemporaire("elpis-pw-proprietaires-");
    chmodSync(proprietaires, 0o700);
    writeFileSync(path.join(proprietaires, "sessAAAA1111.owner"), "hugo");
    writeFileSync(path.join(proprietaires, "sessBBBB2222.owner"), "alice");
    vi.stubEnv("PW_OWNERS_DIR", proprietaires);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    fermerDossier();
    await new Promise<void>((fin) => service.close(() => fin()));
  });

  async function app(playwrightApi = base): ReturnType<typeof creerAppToolhost> {
    return creerAppToolhost({
      tc: configTest(),
      familles: [
        creerFamilleCaptures({
          journal: journalMuet,
          playwrightApi,
          attendre: async (ms) => void attentes.push(ms),
        }),
      ],
      journal: journalMuet,
    });
  }

  it("capture de son compte : PNG sans cache, relisible (le ménage reste au service)", async () => {
    const a = await app();
    recu.length = 0;
    const r = await a.inject({
      url: "/api/playwright/screenshot/shot_sessAAAA1111_1.png",
      headers: entetes(),
    });
    const relue = await a.inject({
      url: "/api/playwright/screenshot/shot_sessAAAA1111_1.png",
      headers: entetes(),
    });
    expect(relue.statusCode).toBe(200);
    expect([
      r.statusCode,
      r.headers["content-type"],
      r.headers["cache-control"],
      r.headers["pragma"],
    ]).toEqual([200, "image/png", "no-store, no-cache, must-revalidate", "no-cache"]);
    expect(r.rawPayload).toEqual(PNG);
    expect(recu).toEqual([
      "GET /screenshots/shot_sessAAAA1111_1.png",
      "GET /screenshots/shot_sessAAAA1111_1.png",
    ]);
    await a.close();
  });

  it("session d'un autre compte ou inconnue : 403, le service n'est pas appelé", async () => {
    const a = await app();
    recu.length = 0;
    const autre = await a.inject({
      url: "/api/playwright/screenshot/view_sessBBBB2222.png",
      headers: entetes(),
    });
    const inconnue = await a.inject({
      url: "/api/playwright/screenshot/view_sessZZZZ9999.png",
      headers: entetes(),
    });
    expect([autre.statusCode, autre.json()]).toEqual([403, { detail: "Access denied: not your session" }]);
    expect([inconnue.statusCode, inconnue.json()]).toEqual([
      403,
      { detail: "Access denied: unknown session" },
    ]);
    expect(recu).toEqual([]);
    await a.close();
  });

  it("404 du service : quatre essais espacés de 0,3·n s, puis 404 « pas prête » ; autre statut : 502", async () => {
    const a = await app();
    attentes.length = 0;
    recu.length = 0;
    const r = await a.inject({
      url: "/api/playwright/screenshot/shot_sessAAAA1111_404.png",
      headers: entetes(),
    });
    expect([r.statusCode, r.json()]).toEqual([404, { detail: "Screenshot not ready" }]);
    expect(attentes).toEqual([300, 600, 900, 1200]);
    expect(recu).toHaveLength(4);
    const e = await a.inject({
      url: "/api/playwright/screenshot/shot_sessAAAA1111_500.png",
      headers: entetes(),
    });
    expect([e.statusCode, e.json()]).toEqual([502, { detail: "Playwright returned 500" }]);
    await a.close();
  });

  it("service navigateur absent : 503 avec le message d'httpx", async () => {
    const a = await app("http://127.0.0.1:1");
    const r = await a.inject({
      url: "/api/playwright/screenshot/shot_sessAAAA1111_1.png",
      headers: entetes(),
    });
    expect([r.statusCode, r.json()]).toEqual([
      503,
      { detail: "Playwright unreachable: All connection attempts failed" },
    ]);
    await a.close();
  });

  it("sans enveloppe d'identité : 401 de la porte, rien n'est lu", async () => {
    const a = await app();
    const r = await a.inject({ url: "/api/playwright/screenshot/shot_sessAAAA1111_1.png" });
    expect(r.statusCode).toBe(401);
    await a.close();
  });
});
