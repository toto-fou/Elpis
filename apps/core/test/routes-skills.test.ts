// SPDX-License-Identifier: MIT
/** apps/core/test/routes-skills.test.ts — routes des skills rejouées contre le routeur Python (vecteurs, miroir sandbox après chaque étape), miroir hors verrou, réponses non finies. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getUsernameById, ligneUtilisateur } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { ArchiveZip, HttpError } from "@elpis/commun";
import { reinitialiserCaches, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import type { Base } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { composer, installerPortsSkills } from "../src/composition";
import { creerFamilleSkills } from "../src/familles/skills";
import type { DependancesSkills } from "../src/familles/skills";
import { avecVerrouEcriture, invalidateSkillsScanCache, verrouEcriture } from "../src/skills/bibliotheque";
import { comptesSkills, installerComptesSkills } from "../src/skills/ports";
import { appTest, journalMuet } from "./aides";
import { ecrireArbre, empreinteArbre, poserEnv } from "./skills/arbre";
import type { ContenuArbre } from "./skills/arbre";

type Reponse = {
  statut: number;
  miroir_bob: string[][];
  corps?: string;
  zip?: [string, string][];
  disposition?: string;
};

const V = JSON.parse(readFileSync(new URL("./vecteurs/routes-skills.json", import.meta.url), "utf-8")) as {
  comptes: [string, number][];
  global: Record<string, ContenuArbre>;
  perso_bob: Record<string, ContenuArbre>;
  borne: string;
  etapes: [string, string, string, unknown, number?][];
  ids: Record<string, number>;
  reponses: Reponse[];
  arbres_finaux: Record<string, string[][]>;
};

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

interface Banc {
  t: BaseDeTest;
  racine: string;
  app: FastifyInstance;
  fermer: () => Promise<void>;
}

/** Bibliothèque, magasins et sandbox sous un dossier neuf ; ports du démarrage posés comme dans `composer`. */
async function monterBanc(
  moteur: "sqlite" | "postgres",
  dep: Partial<DependancesSkills> = {},
): Promise<Banc> {
  const t = ouvrirBaseDeTest(moteur);
  await initialiserBase(t.base);
  for (const [nom, admin] of V.comptes)
    await t.base.run(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES(?,?,?,?,?)",
      [nom, "s", "h", 0, admin],
    );
  const racine = mkdtempSync(join(tmpdir(), "elpis-skills-routes-"));
  await ecrireArbre(join(racine, "global"), V.global);
  await ecrireArbre(join(racine, "user_skills", "bob"), V.perso_bob);
  const remettreEnv = poserEnv({
    APP_SKILLS_DIR: join(racine, "global"),
    SKILLS_LOCK_PATH: join(racine, ".skills_write.lock"),
  });
  const remettreConfig = surchargerConfig({
    USER_SKILLS_DIR: join(racine, "user_skills"),
    SANDBOX_DIR: join(racine, "sb"),
  });
  reinitialiserCaches();
  invalidateSkillsScanCache();
  installerPortsSkills(t.base);
  const app = await appSkills(t.base, dep);
  return {
    t,
    racine,
    app,
    fermer: async () => {
      await app.close();
      remettreConfig();
      remettreEnv();
      invalidateSkillsScanCache();
      await t.fermer();
      rmSync(racine, { recursive: true, force: true });
    },
  };
}

function appSkills(base: Base, dep: Partial<DependancesSkills>): Promise<FastifyInstance> {
  const identifier = async (req: FastifyRequest): Promise<number> => {
    const id = Number(req.headers["x-uid"]);
    req.utilisateur = { id, username: await getUsernameById(base, id) };
    return id;
  };
  return appTest({
    familles: [creerFamilleSkills({ base, ...dep })],
    gardes: {
      session: async (req) => {
        await identifier(req);
      },
      admin: async (req) => {
        const ligne = await ligneUtilisateur(base, await identifier(req));
        if (!ligne || Number(ligne.is_admin) !== 1) throw new HttpError(403, "Admin required");
      },
    },
  });
}

function requete(nom: string, methode: string, chemin: string, corps: unknown) {
  const headers: Record<string, string> = { "x-uid": String(V.ids[nom]) };
  let payload: Buffer | undefined;
  if (typeof corps === "string" && corps.startsWith("<<MP>>")) {
    payload = Buffer.from(corps.slice(6), "hex");
    headers["content-type"] = `multipart/form-data; boundary=${V.borne}`;
  } else if (typeof corps === "string" && corps.startsWith("<<")) {
    payload = Buffer.from(corps.slice(2, -2), "utf8");
    headers["content-type"] = "application/json";
  } else if (corps !== null) {
    payload = Buffer.from(JSON.stringify(corps), "utf8");
    headers["content-type"] = "application/json";
  }
  return { method: methode as "GET", url: chemin, headers, ...(payload ? { payload } : {}) };
}

describe.each(MOTEURS)("routes des skills (%s)", (moteur) => {
  let banc: Banc;

  beforeAll(async () => {
    banc = await monterBanc(moteur);
  });

  afterAll(async () => {
    await banc.fermer();
  });

  it(
    "rejoue les étapes : mêmes réponses au texte près, même miroir sandbox après chaque étape (vecteurs)",
    {
      timeout: 120_000,
    },
    async () => {
      const { app, racine } = banc;
      for (const [i, [nom, methode, chemin, corps, statutTs]] of V.etapes.entries()) {
        const r = await app.inject(requete(nom, methode, chemin, corps));
        const attendu = V.reponses[i] as Reponse;
        if (statutTs !== undefined) {
          expect(r.statusCode, `étape ${i} (écart du socle) : ${methode} ${chemin}`).toBe(statutTs);
          continue;
        }
        const vu: Reponse = {
          statut: r.statusCode,
          miroir_bob: await empreinteArbre(join(racine, "sb", "bob", "skills")),
        };
        if (r.headers["content-type"] === "application/zip") {
          const zip = new ArchiveZip(r.rawPayload);
          vu.zip = zip.membres.map((m) => [m.nom, zip.lire(m).toString("utf8")]);
          vu.disposition = String(r.headers["content-disposition"]);
        } else vu.corps = r.body.replaceAll(racine, "<R>");
        expect(vu, `étape ${i} : ${nom} ${methode} ${chemin}`).toEqual(attendu);
      }
    },
  );

  it("bibliothèque, magasins perso et miroirs finaux identiques au Python", async () => {
    for (const [nom, attendu] of Object.entries(V.arbres_finaux))
      expect(await empreinteArbre(join(banc.racine, nom)), nom).toEqual(attendu);
  });
});

describe("miroir sandbox et réponses", () => {
  it("le miroir se synchronise après chaque mutation du magasin perso, hors du verrou d'écriture", async () => {
    const appels: { tenu: boolean; libre: boolean }[] = [];
    const banc = await monterBanc("sqlite", {
      synchroniserMiroir: async () => {
        const libre = await Promise.race([
          avecVerrouEcriture(async () => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), 2_000)),
        ]);
        appels.push({ tenu: verrouEcriture.tenuIci(), libre });
      },
    });
    try {
      const bob = (m: string, u: string, c: unknown = null) => banc.app.inject(requete("bob", m, u, c));
      const statuts = [
        (await bob("POST", "/api/skills", { name: "Un", body: "corps" })).statusCode,
        (await bob("POST", "/api/skills", { name: "Un", body: "doublon" })).statusCode,
        (await bob("PUT", "/api/skills/un", { name: "Deux", body: "corps" })).statusCode,
        (await bob("DELETE", "/api/skills/deux")).statusCode,
        (await bob("DELETE", "/api/skills/deux")).statusCode,
        (await bob("GET", "/api/skills")).statusCode,
      ];
      expect(statuts).toEqual([200, 409, 200, 200, 404, 200]);
      expect(appels).toEqual([
        { tenu: false, libre: true },
        { tenu: false, libre: true },
        { tenu: false, libre: true },
      ]);
    } finally {
      await banc.fermer();
    }
  });

  it("aucun appel au miroir pour un scope partagé (learned, global)", async () => {
    let appels = 0;
    const banc = await monterBanc("sqlite", {
      synchroniserMiroir: async () => {
        appels++;
      },
    });
    try {
      const r = await banc.app.inject(
        requete("admin", "POST", "/api/skills", { scope: "global", name: "Commun", body: "b" }),
      );
      expect(r.statusCode).toBe(200);
      expect(appels).toBe(0);
    } finally {
      await banc.fermer();
    }
  });

  it("composer pose le port des comptes des skills : nom du compte, sandbox créée sous SANDBOX_DIR", async () => {
    const banc = await monterBanc("sqlite");
    installerComptesSkills(null);
    const remettre = process.env["ELPIS_AUDIT_DIR"];
    process.env["ELPIS_AUDIT_DIR"] = join(banc.racine, "audit");
    try {
      const dep: DependancesAuth & DependancesJetons = {
        base: banc.t.base,
        config: () => ({}),
        attributsCookie: () => ({ cookie_name: "s", same_site: "lax", https_only: false, max_age: 60 }),
        secret: () => "secret-de-test",
        jetonService: () => "",
      };
      await composer("main", banc.t.base, journalMuet, dep);
      expect(await comptesSkills().nomUtilisateur(V.ids["bob"] ?? 0)).toBe("bob");
      const racine = await comptesSkills().racineSandbox(V.ids["bob"] ?? 0);
      expect(racine).toBe(join(banc.racine, "sb", "bob"));
      expect((await stat(racine ?? "")).isDirectory()).toBe(true);
      expect(await comptesSkills().racineSandbox(999)).toBe(join(banc.racine, "sb", "user_999"));
    } finally {
      if (remettre === undefined) delete process.env["ELPIS_AUDIT_DIR"];
      else process.env["ELPIS_AUDIT_DIR"] = remettre;
      oublierConfigurationAudit();
      await banc.fermer();
    }
  });

  it("métadonnées non finies du frontmatter rendues `null` comme le modèle de réponse de FastAPI", async () => {
    const banc = await monterBanc("sqlite");
    try {
      const r = await banc.app.inject(requete("bob", "GET", "/api/skills/backup", null));
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('"metadata":{"version":null,"auteur":"équipe","n":2.0,"moins":null}');
    } finally {
      await banc.fermer();
    }
  });
});
