// SPDX-License-Identifier: MIT
/** apps/toolhost/test/trames.test.ts — trames du bureau servies par l'hôte : jeton, propriétaire (strict ou non), fichier, type par octets magiques. */
import { writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { creerAppToolhost } from "../src/app";
import { creerFamilleTrames } from "../src/trames";
import { configTest, dossierTemporaire, entetes, journalMuet } from "./aides";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const JPEG = Buffer.from("ffd8ffe000104a464946", "hex");

describe("GET /api/desktop/frame/{token}", () => {
  let dossier = "";
  let fermer = (): void => undefined;

  beforeAll(() => {
    [dossier, fermer] = dossierTemporaire("elpis-trames-");
    vi.stubEnv("DESKTOP_SCREENS_DIR", dossier);
    const poser = (jeton: string, owner: string | null, octets: Buffer | null): void => {
      if (owner !== null) writeFileSync(path.join(dossier, `frame_${jeton}.owner`), owner);
      if (octets !== null) writeFileSync(path.join(dossier, `frame_${jeton}.png`), octets);
    };
    poser("trameHUGO0001", "hugo", PNG);
    poser("trameHUGO0002", "hugo", JPEG);
    poser("trameALIC0001", "alice", PNG);
    poser("trameSANS0001", null, PNG);
    poser("trameVIDE0001", "hugo", null);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    fermer();
  });

  async function app(strict = true): ReturnType<typeof creerAppToolhost> {
    return creerAppToolhost({
      tc: configTest(),
      familles: [creerFamilleTrames({ journal: journalMuet, strict: () => strict })],
      journal: journalMuet,
    });
  }

  it("trame de son compte : octets tels quels, type d'après les octets magiques, sans cache", async () => {
    const a = await app();
    const png = await a.inject({ url: "/api/desktop/frame/trameHUGO0001", headers: entetes() });
    const jpeg = await a.inject({ url: "/api/desktop/frame/trameHUGO0002", headers: entetes() });
    expect([png.statusCode, png.headers["content-type"], png.headers["cache-control"]]).toEqual([
      200,
      "image/png",
      "no-store, no-cache, must-revalidate",
    ]);
    expect(png.rawPayload).toEqual(PNG);
    expect([jpeg.statusCode, jpeg.headers["content-type"]]).toEqual([200, "image/jpeg"]);
    await a.close();
  });

  it("autre compte : 403 ; propriétaire inconnu : 404 en strict, servie sinon ; fichier absent : 404 ; jeton invalide : 400", async () => {
    const a = await app();
    const r = async (jeton: string): Promise<[number, unknown]> => {
      const x = await a.inject({ url: `/api/desktop/frame/${jeton}`, headers: entetes() });
      return [x.statusCode, x.json()];
    };
    expect(await r("trameALIC0001")).toEqual([403, { detail: "Access denied: not your frame" }]);
    expect(await r("trameSANS0001")).toEqual([404, { detail: "Frame not available" }]);
    expect(await r("trameVIDE0001")).toEqual([404, { detail: "Frame not available" }]);
    expect(await r("court")).toEqual([400, { detail: "Invalid frame token" }]);
    expect(await r("trame.HUGO0001")).toEqual([400, { detail: "Invalid frame token" }]);
    await a.close();
    const souple = await app(false);
    const x = await souple.inject({ url: "/api/desktop/frame/trameSANS0001", headers: entetes() });
    expect([x.statusCode, x.rawPayload]).toEqual([200, PNG]);
    await souple.close();
  });
});
