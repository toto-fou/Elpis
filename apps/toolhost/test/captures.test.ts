// SPDX-License-Identifier: MIT
/** apps/toolhost/test/captures.test.ts — capture Playwright servie par l'hôte depuis le service du bac du compte (socket) : nom, propriétaire, essais, erreurs du service. */
import { chmodSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { creerFamilleCaptures, sessionDeLaCapture } from "../src/captures";
import { creerAppToolhost } from "../src/app";
import { injectionsNavigateurBac } from "../src/mcp/browser/bac";
import { configTest, dossierTemporaire, entetes, journalMuet } from "./aides";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("noms de capture", () => {
  it("motifs : étape JPEG (PNG de l'historique), vision JPEG, capture, vue ; 400 pour le reste", () => {
    expect(sessionDeLaCapture("shot_sessAAAA1111_12.png")).toBe("sessAAAA1111");
    expect(sessionDeLaCapture("step_sess-BBB-2222_0.png")).toBe("sess-BBB-2222");
    expect(sessionDeLaCapture("step_sess-BBB-2222_7.jpg")).toBe("sess-BBB-2222");
    expect(sessionDeLaCapture("vision_sessAAAA1111_3.jpg")).toBe("sessAAAA1111");
    expect(sessionDeLaCapture("view_sessCCCC3333.png")).toBe("sessCCCC3333");
    for (const [nom, detail] of [
      ["shot_sessAAAA1111_1.gif", "Invalid filename"],
      ["shot_sessAAAA1111_1.jpg", "Invalid screenshot filename pattern"],
      ["vision_sessAAAA1111_1.png", "Invalid screenshot filename pattern"],
      ["vision_sessAAAA1111.jpg", "Invalid screenshot filename pattern"],
      ["step_sessAAAA1111_1.JPG", "Invalid screenshot filename pattern"],
      ["view_sessCCCC3333.jpg", "Invalid screenshot filename pattern"],
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
  let socket = "";
  const recu: string[] = [];
  const comptes: string[] = [];
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
    [proprietaires, fermerDossier] = dossierTemporaire("elpis-pw-proprietaires-");
    socket = path.join(proprietaires, "browser.sock");
    await new Promise<void>((fin) => service.listen(socket, fin));
    chmodSync(proprietaires, 0o700);
    writeFileSync(path.join(proprietaires, "sessAAAA1111.owner"), "hugo");
    writeFileSync(path.join(proprietaires, "sessBBBB2222.owner"), "alice");
    vi.stubEnv("PW_OWNERS_DIR", proprietaires);
  });
  afterAll(async () => {
    injectionsNavigateurBac.service = null;
    vi.unstubAllEnvs();
    await new Promise<void>((fin) => service.close(() => fin()));
    fermerDossier();
  });

  /** Hôte dont le service du bac de chaque compte est le faux service (ou un socket absent). */
  async function app(absent = false): ReturnType<typeof creerAppToolhost> {
    injectionsNavigateurBac.service = (compte) => {
      comptes.push(compte);
      return { socket: absent ? `${socket}.absent` : socket, jeton: "" };
    };
    return creerAppToolhost({
      tc: configTest(),
      familles: [
        creerFamilleCaptures({ journal: journalMuet, attendre: async (ms) => void attentes.push(ms) }),
      ],
      journal: journalMuet,
    });
  }

  it("capture de son compte : PNG sans cache, relisible (le ménage reste au service)", async () => {
    const a = await app();
    recu.length = 0;
    comptes.length = 0;
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
    expect(comptes).toEqual(["hugo", "hugo"]);
    await a.close();
  });

  it("étape et vision en JPEG servies en image/jpeg ; vision d'une session d'un autre compte : 403", async () => {
    const a = await app();
    recu.length = 0;
    const etape = await a.inject({
      url: "/api/playwright/screenshot/step_sessAAAA1111_4.jpg",
      headers: entetes(),
    });
    const vision = await a.inject({
      url: "/api/playwright/screenshot/vision_sessAAAA1111_5.jpg",
      headers: entetes(),
    });
    const autre = await a.inject({
      url: "/api/playwright/screenshot/vision_sessBBBB2222_5.jpg",
      headers: entetes(),
    });
    expect([etape.statusCode, etape.headers["content-type"]]).toEqual([200, "image/jpeg"]);
    expect([vision.statusCode, vision.headers["content-type"]]).toEqual([200, "image/jpeg"]);
    expect(autre.statusCode).toBe(403);
    expect(recu).toEqual([
      "GET /screenshots/step_sessAAAA1111_4.jpg",
      "GET /screenshots/vision_sessAAAA1111_5.jpg",
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

  it("service navigateur du bac arrêté : 503 avec le message d'httpx", async () => {
    const a = await app(true);
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
