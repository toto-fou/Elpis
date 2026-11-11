// SPDX-License-Identifier: MIT
/** apps/core/test/routines/vecteurs.test.ts — fonctions pures des routines rejouées contre le Python : validate_cron, normalisations et désérialisation du magasin. */
import { readFileSync } from "node:fs";

import { HttpError, pyJsonDumps } from "@elpis/commun";
import { describe, expect, it } from "vitest";

import { validateCron } from "../../src/routines/cron";
import {
  KEEP_MAX,
  MCP_SECRET_KEYS,
  normKeep,
  normNotifyOn,
  NOTIFY_ON_VALUES,
  routineNotificationTitle,
  rowToRoutine,
  RUN_FILE_PATH_MAX,
  RUN_FILES_MAX,
  sanitizeRunFiles,
  sanitizeSkills,
  stripMcpSecrets,
} from "../../src/routines/magasin";
import { sansAgentsDeRoutine } from "../ecart-routines-sans-agents";

type Cas<E, S> = { entree: E; sortie: S };

const V = JSON.parse(readFileSync(new URL("../vecteurs/routines.json", import.meta.url), "utf-8")) as {
  constantes: {
    keep_max: number;
    notify_on: string[];
    fichiers_max: number;
    chemin_max: number;
    cles_secretes: string[];
  };
  cron: { expr: string; ok?: string; statut?: number; detail?: string }[];
  skills: Cas<unknown, string[]>[];
  keep: Cas<unknown, number>[];
  notify_on: Cas<unknown, string>[];
  titres: Cas<[string | null, number, boolean], string>[];
  fichiers: (Cas<unknown, string[]> & { tuple: boolean })[];
  serveurs: Cas<unknown, string>[];
  lignes: Cas<string, string>[];
};

const texte = (v: unknown): string => pyJsonDumps(v, { ensureAscii: false });

describe("routines : constantes", () => {
  it("bornes et clés secrètes identiques, plus la référence au coffre et le drapeau de la migration 0029", () => {
    expect([KEEP_MAX, [...NOTIFY_ON_VALUES], RUN_FILES_MAX, RUN_FILE_PATH_MAX, [...MCP_SECRET_KEYS]]).toEqual(
      [
        V.constantes.keep_max,
        V.constantes.notify_on,
        V.constantes.fichiers_max,
        V.constantes.chemin_max,
        [...V.constantes.cles_secretes, "secret_id", "secret_error"],
      ],
    );
  });
});

describe("validate_cron", () => {
  it(`${V.cron.length} expressions : même normalisation, même 400 au même message`, () => {
    const obtenu = V.cron.map(({ expr }) => {
      try {
        return { expr, ok: validateCron(expr) };
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        return { expr, statut: e.statusCode, detail: e.detail };
      }
    });
    expect(obtenu).toEqual(V.cron);
  });
});

describe("normalisations du magasin", () => {
  it("skills, compteurs, politique de notification, titres", () => {
    expect(V.skills.map((c) => sanitizeSkills(c.entree))).toEqual(V.skills.map((c) => c.sortie));
    expect(V.keep.map((c) => normKeep(c.entree))).toEqual(V.keep.map((c) => c.sortie));
    expect(V.notify_on.map((c) => normNotifyOn(c.entree))).toEqual(V.notify_on.map((c) => c.sortie));
    expect(V.titres.map((c) => routineNotificationTitle(c.entree[0], c.entree[1], c.entree[2]))).toEqual(
      V.titres.map((c) => c.sortie),
    );
  });

  it("fichiers produits (listes ; un tuple Python est une liste JS) et secrets MCP retirés", () => {
    expect(V.fichiers.map((c) => sanitizeRunFiles(c.entree))).toEqual(V.fichiers.map((c) => c.sortie));
    expect(V.serveurs.map((c) => texte(stripMcpSecrets(c.entree)))).toEqual(V.serveurs.map((c) => c.sortie));
  });

  it(`${V.lignes.length} lignes désérialisées comme _row_to_routine (ordre des clés, flottants, secret retiré)`, () => {
    // Écart voulu : le secret que le Python gardait en clair est chiffré par le coffre (`webhook_secret_enc`).
    const chiffree = (l: Record<string, unknown>): Record<string, unknown> =>
      Object.hasOwn(l, "webhook_secret")
        ? { ...l, webhook_secret: null, webhook_secret_enc: l["webhook_secret"] }
        : l;
    expect(
      V.lignes.map((c) => texte(rowToRoutine(chiffree(JSON.parse(c.entree) as Record<string, unknown>)))),
    ).toEqual(V.lignes.map((c) => sansAgentsDeRoutine(c.sortie)));
  });
});
