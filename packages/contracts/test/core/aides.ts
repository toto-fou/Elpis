// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/aides.ts — core TS réel (composition main, SQLite de test, vraie connexion) et vérification des réponses contre le registre des contrats. */
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createUser } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { reinitialiserCaches, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import type { Base } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import { configurerCoffre } from "@elpis/securite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { expect } from "vitest";

import { remplacerBase } from "../../../../apps/core/src/base";
import { composer } from "../../../../apps/core/src/composition";
import type { Composition } from "../../../../apps/core/src/composition";
import { installerCrochetJournal } from "../../../../apps/core/src/journal";
import { invalidateSkillsScanCache } from "../../../../apps/core/src/skills/bibliotheque";
import { installerRelaisModeles } from "../../../../apps/core/src/llm/cache-modeles";
import { installerDiffusion } from "../../../../apps/core/src/llm/ports";
import { appTest, journalMuet } from "../../../../apps/core/test/aides";
import { contratDe, schemaErreurApi, schemaErreurBureau } from "../../src";
import type { ContratRoute } from "../../src";

export interface CoreDeTest {
  readonly app: FastifyInstance;
  readonly base: Base;
  readonly composition: Composition;
  /** Routes du registre effectivement interrogées (`METHODE chemin`). */
  readonly couvertes: Set<string>;
  connecter(username: string, password: string): Promise<string>;
  appeler(
    methode: string,
    url: string,
    options?: { cookie?: string; corps?: unknown; entetes?: Record<string, string> },
  ): Promise<unknown>;
  /** Envoi multipart d'un fichier sous le champ `file`. */
  televerser(
    url: string,
    options: { cookie: string; fichier: Buffer; nom?: string; type?: string },
  ): Promise<unknown>;
  fermer(): Promise<void>;
}

export function cle(r: ContratRoute): string {
  return `${r.methode} ${r.chemin}`;
}

/** Corps validé par le contrat de la route : succès par sa réponse (rien d'ajouté ni de retiré), erreur par `{"detail"}` ; un 500 non rattrapé est du texte brut. */
export function verifierReponse(
  methode: string,
  url: string,
  statut: number,
  texte: string,
  couvertes?: Set<string>,
): unknown {
  const contrat = contratDe(methode, url);
  expect(contrat, `${methode} ${url} sans contrat`).toBeDefined();
  if (contrat === undefined) return undefined;
  couvertes?.add(cle(contrat));
  if (statut >= 500 && texte === "Internal Server Error") return undefined;
  if (statut >= 400) {
    const erreur: unknown = JSON.parse(texte);
    const ancienne = schemaErreurBureau.safeParse(erreur).success;
    expect(schemaErreurApi.safeParse(erreur).success || ancienne, `${methode} ${url} : ${texte}`).toBe(true);
    return erreur;
  }
  if (contrat.reponse === null) {
    expect([statut, texte]).toEqual([204, ""]);
    return undefined;
  }
  expect(statut, `${methode} ${url} : ${texte}`).toBe(contrat.statut ?? 200);
  const corps: unknown = JSON.parse(texte);
  const r = contrat.reponse.safeParse(corps);
  expect(r.success ? null : r.error.issues, `${methode} ${url} : ${texte.slice(0, 400)}`).toBeNull();
  expect(r.data, `${methode} ${url} : champ hors contrat`).toEqual(corps);
  return corps;
}

export const CONFIG_COOKIE = {
  cookie_name: "mcpwebui_session",
  same_site: "lax",
  https_only: false,
  max_age: 86400,
} as const;

/** Clé du coffre des essais, posée une fois par fichier (jamais /etc/elpis ni de repli créé) ; un test peut en poser une autre. */
configurerCoffre({
  cleEnv: randomBytes(32).toString("base64"),
  systeme: "/nonexistent/elpis-vault.key",
  repli: "/nonexistent/elpis/.vault.key",
});

/** Process main composé comme en production, sur une base SQLite neuve. */
export async function demarrerCore(mode: "main" | "admin" = "main"): Promise<CoreDeTest> {
  const racine = mkdtempSync(join(tmpdir(), "elpis-contrats-"));
  symlinkSync(fileURLToPath(new URL("../../../../docs", import.meta.url)), join(racine, "docs"));
  mkdirSync(join(racine, "sandboxes"));
  const restaurerConfig = surchargerConfig({
    SANDBOX_DIR: join(racine, "sandboxes"),
    MEMORY_DIR: join(racine, "sandboxes"),
    USER_SKILLS_DIR: join(racine, "user_skills"),
    CONFIG_JSON_PATH: join(racine, "config.json"),
    SKINS_DIR: join(racine, "skins_utilisateur"),
    DB_PATH: join(racine, "app.db"),
    LLAMA_IP: "127.0.0.1",
    LLAMA_PORT: "1",
    LLAMA_URL: "http://127.0.0.1:1/v1/chat/completions",
  });
  const env = { APP_SKILLS_DIR: join(racine, "skills"), SKILLS_LOCK_PATH: join(racine, ".skills.lock") };
  const avant = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  mkdirSync(env.APP_SKILLS_DIR);
  reinitialiserCaches();
  invalidateSkillsScanCache();
  const t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  remplacerBase(t.base);
  const dep: DependancesAuth & DependancesJetons = {
    base: t.base,
    config: () => ({}),
    attributsCookie: () => ({ ...CONFIG_COOKIE }),
    secret: () => "secret-de-test-contrats",
    jetonService: () => "",
  };
  const composition = await composer(mode, t.base, journalMuet, dep, racine);
  const app = await appTest({ ...composition, mode });
  const couvertes = new Set<string>();
  const appeler = async (
    methode: string,
    url: string,
    options: { cookie?: string; corps?: unknown; entetes?: Record<string, string> } = {},
  ): Promise<unknown> => {
    const r: LightMyRequestResponse = await app.inject({
      method: methode as "GET",
      url,
      headers: { ...(options.cookie ? { cookie: options.cookie } : {}), ...options.entetes },
      ...(options.corps === undefined ? {} : { payload: options.corps as object }),
    });
    return verifierReponse(methode, url, r.statusCode, r.body, couvertes);
  };
  const televerser: CoreDeTest["televerser"] = async (url, o) => {
    const b = "frontiere-contrats";
    const r = await app.inject({
      method: "POST",
      url,
      headers: { cookie: o.cookie, "content-type": `multipart/form-data; boundary=${b}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${o.nom ?? "a.png"}"\r\nContent-Type: ${o.type ?? "image/png"}\r\n\r\n`,
        ),
        o.fichier,
        Buffer.from(`\r\n--${b}--\r\n`),
      ]),
    });
    return verifierReponse("POST", url, r.statusCode, r.body, couvertes);
  };
  return {
    app,
    base: t.base,
    televerser,
    composition,
    couvertes,
    appeler,
    connecter: async (username, password) => {
      const r = await app.inject({ method: "POST", url: "/api/login-lite", payload: { username, password } });
      verifierReponse("POST", "/api/login-lite", r.statusCode, r.body, couvertes);
      const brut = r.headers["set-cookie"];
      const ligne = (Array.isArray(brut) ? brut[0] : brut) ?? "";
      return ligne.split(";")[0] ?? "";
    },
    fermer: async () => {
      await app.close();
      installerCrochetJournal(null);
      installerDiffusion(null);
      installerRelaisModeles(null);
      remplacerBase(undefined);
      await t.fermer();
      restaurerConfig();
      for (const [k, v] of Object.entries(avant)) {
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      }
      invalidateSkillsScanCache();
      rmSync(racine, { recursive: true, force: true });
    },
  };
}

/** PNG minimal accepté comme avatar (la signature suffit). */
export const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(40, 7)]);

export async function creerCompte(base: Base, nom: string, motDePasse: string, admin = 0): Promise<number> {
  return createUser(base, nom, motDePasse, { isAdmin: admin });
}
