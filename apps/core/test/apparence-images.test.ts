// SPDX-License-Identifier: MIT
/** apps/core/test/apparence-images.test.ts — images d'un habillage servies par descripteur : un lien, un tube ou un fichier trop gros répondent 404 sans bloquer le process. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HttpError } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { createUser } from "@elpis/auth";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MAX_ASSET_BYTES, viderCachesSkins } from "../src/apparence/skins";
import { creerFamilleApparence } from "../src/familles/apparence";
import { appTest } from "./aides";

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(24, 7)]);
const gardes = {
  session: (req: { headers: Record<string, unknown>; utilisateur?: unknown }) => {
    const uid = req.headers["x-uid"];
    if (!uid) throw new HttpError(401, "not logged in");
    req.utilisateur = { id: Number(uid), username: null };
  },
};

describe("images d'un habillage", () => {
  let dossier: string;
  let t: BaseDeTest;
  let app: FastifyInstance;
  let restaurer: () => void;

  beforeAll(async () => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-skins-img-"));
    const images = join(dossier, "user_skins", "brume", "assets");
    mkdirSync(images, { recursive: true });
    writeFileSync(join(dossier, "config.json"), "{}");
    writeFileSync(join(images, "bonne.png"), PNG);
    writeFileSync(join(images, "grosse.png"), Buffer.concat([PNG, Buffer.alloc(MAX_ASSET_BYTES)]));
    symlinkSync(join(images, "bonne.png"), join(images, "lien.png"));
    execFileSync("mkfifo", [join(images, "tube.png")]);
    restaurer = surchargerConfig({
      CONFIG_JSON_PATH: join(dossier, "config.json"),
      SKINS_DIR: join(dossier, "user_skins"),
    });
    viderCachesSkins();
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await createUser(t.base, "admin", "mdp-admin", { isAdmin: 1 });
    app = await appTest({ familles: [creerFamilleApparence({ base: t.base, mode: "admin" })], gardes });
  });

  afterAll(async () => {
    restaurer();
    viderCachesSkins();
    await app.close();
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("une image ordinaire est servie ; lien, tube et fichier trop gros : 404", async () => {
    const lire = async (nom: string): Promise<number> =>
      (
        await app.inject({
          method: "GET",
          url: `/api/skins/brume/assets/${nom}`,
          headers: { "x-uid": "1" },
        })
      ).statusCode;
    expect(await lire("bonne.png")).toBe(200);
    for (const nom of ["lien.png", "tube.png", "grosse.png"]) expect(await lire(nom), nom).toBe(404);
  }, 10_000);
});
