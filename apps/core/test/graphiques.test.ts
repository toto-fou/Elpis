// SPDX-License-Identifier: MIT
/** apps/core/test/graphiques.test.ts — route du graphique rejouée contre le Python (vecteurs), cache lu sans suivre les liens vu depuis la route. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser } from "@elpis/auth";
import { HttpError, pyJsonLoads } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { upsertChat } from "../src/chats/stockage";
import { creerFamilleGraphiques } from "../src/familles/graphiques";
import { appTest } from "./aides";

const V = pyJsonLoads(readFileSync(new URL("./vecteurs/graphiques.json", import.meta.url), "utf-8"), {
  mode: "natif",
}) as {
  comptes: string[];
  cache: Record<string, Record<string, string>>;
  chats: [string, string, unknown[], string | null][];
  etapes: [string | number | null, string, number?][];
  ids: Record<string, number>;
  reponses: { statut: number; corps: string }[];
};

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

const gardes = {
  session: (req: { headers: Record<string, unknown>; utilisateur?: unknown }) => {
    const uid = req.headers["x-uid"];
    if (!uid) throw new HttpError(401, "not logged in");
    req.utilisateur = { id: Number(uid), username: null };
  },
};

function ecrireCache(dossier: string, cache: Record<string, Record<string, string>>): void {
  for (const [nom, fichiers] of Object.entries(cache)) {
    mkdirSync(join(dossier, nom), { recursive: true, mode: 0o700 });
    for (const [fichier, hex] of Object.entries(fichiers))
      writeFileSync(join(dossier, nom, fichier), Buffer.from(hex, "hex"));
  }
}

describe.each(MOTEURS)("route du graphique rejouée contre le Python (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let cache: string;

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    for (const nom of V.comptes) await createUser(t.base, nom, `mdp-${nom}`);
    for (const [nom, id, messages, brut] of V.chats) {
      await upsertChat(t.base, V.ids[nom] ?? 0, id, "Titre", messages, 1_800_000_000);
      if (brut !== null) await t.base.run("UPDATE chats SET messages_json=? WHERE id=?", [brut, id]);
    }
    cache = mkdtempSync(join(tmpdir(), "elpis-graphiques-route-"));
    ecrireCache(cache, V.cache);
    vi.stubEnv("CHART_CACHE_DIR", cache);
    app = await appTest({ familles: [creerFamilleGraphiques({ base: t.base })], gardes });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await app.close();
    await t.fermer();
    rmSync(cache, { recursive: true, force: true });
  });

  it("mêmes statuts et mêmes corps, au texte près (vecteurs)", async () => {
    for (const [i, [qui, chemin]] of V.etapes.entries()) {
      const uid = typeof qui === "string" ? V.ids[qui] : qui;
      const r = await app.inject({
        method: "GET",
        url: chemin,
        headers: uid === null || uid === undefined ? {} : { "x-uid": String(uid) },
      });
      expect({ statut: r.statusCode, corps: r.body }, `étape ${i} : ${chemin}`).toEqual(V.reponses[i]);
    }
  });
});

describe("route : cache lu sans suivre les liens", () => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let cache: string;

  beforeEach(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await createUser(t.base, "bob", "mdp-bob");
    await createUser(t.base, "onetime", "mdp-onetime");
    cache = mkdtempSync(join(tmpdir(), "elpis-graphiques-route-durci-"));
    mkdirSync(join(cache, "bob"), { mode: 0o700 });
    writeFileSync(join(cache, "bob", "aaaaaaaaaaaa.json"), '{"ok": 1}');
    symlinkSync(join(cache, "bob", "aaaaaaaaaaaa.json"), join(cache, "bob", "bbbbbbbbbbbb.json"));
    vi.stubEnv("CHART_CACHE_DIR", cache);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    app = await appTest({ familles: [creerFamilleGraphiques({ base: t.base })], gardes });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await app.close();
    await t.fermer();
    rmSync(cache, { recursive: true, force: true });
  });

  const lire = (id: string, uid = 1) =>
    app.inject({ method: "GET", url: `/api/charts/${id}`, headers: { "x-uid": String(uid) } });

  it("fichier ordinaire servi ; lien symbolique écarté (404, faute de copie durable)", async () => {
    expect((await lire("aaaaaaaaaaaa")).json()).toEqual({
      ok: true,
      chart_id: "aaaaaaaaaaaa",
      config: { ok: 1 },
      source: "cache",
    });
    expect((await lire("bbbbbbbbbbbb")).json()).toEqual({ detail: "chart 'bbbbbbbbbbbb' not found" });
  });

  it.skipIf((process.geteuid?.() ?? 0) === 0 || !existsSync("/usr/share/nodejs/onetime/package.json"))(
    "fichier d'un autre propriétaire : 404",
    async () => {
      vi.stubEnv("CHART_CACHE_DIR", "/usr/share/nodejs");
      expect((await lire("package", 2)).statusCode).toBe(404);
    },
  );
});
