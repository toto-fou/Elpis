// SPDX-License-Identifier: MIT
/** apps/core/test/separation-processus.test.ts — invariant 1 : aucune route de la console d'administration (`/api/admin/*`) montée dans main, hors routes internes ; les routes communes aux deux process ne viennent que des familles partagées. */
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { composer } from "../src/composition";
import { installerCrochetJournal } from "../src/journal";
import { installerRelaisModeles } from "../src/llm/cache-modeles";
import { installerDiffusion } from "../src/llm/ports";
import { appTest, journalMuet } from "./aides";
import { dependancesAuth } from "./exploitation/aides";

/** Familles montées dans main et dans admin, et pourquoi. */
const PARTAGEES: Readonly<Record<string, string>> = {
  systeme: "santé et configuration publique",
  interface: "pages et statiques",
  comptes: "connexion, session et réglages du compte sur les deux ports",
  ax: "mémoire d'accessibilité lue par la console et le chat",
  evenements: "flux d'événements de chaque process",
  apparence: "skins et mascottes de chaque page",
  "admin-cycle": "redémarrage par la route interne (jeton de service, boucle locale)",
};

let t: BaseDeTest;

beforeEach(async () => {
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
});

afterEach(async () => {
  installerCrochetJournal(null);
  installerDiffusion(null);
  installerRelaisModeles(null);
  await t.fermer();
});

/** `METHODE chemin` → `famille|accès` des routes montées par le process ; `interroger` reçoit l'app avant sa fermeture. */
async function routesDu(
  mode: "main" | "admin",
  interroger?: (app: Awaited<ReturnType<typeof appTest>>) => Promise<void>,
): Promise<Map<string, string>> {
  const c = await composer(mode, t.base, journalMuet, dependancesAuth(t.base));
  const app = await appTest({ ...c, mode });
  try {
    await interroger?.(app);
    return new Map(
      app.elpis.routes.flatMap((r) => r.methodes.map((m) => [`${m} ${r.chemin}`, `${r.famille}|${r.acces}`])),
    );
  } finally {
    await app.close();
  }
}

describe("invariant 1 : séparation des process main et admin", () => {
  it("main ne monte aucune route /api/admin hors des routes internes ; les routes communes viennent des familles partagées", async () => {
    const main = await routesDu("main");
    const admin = await routesDu("admin");
    const consoleDansMain = [...main].filter(
      ([cle, v]) =>
        /^\S+ \/api\/admin(\/|$)/.test(cle) &&
        !(cle.includes(" /api/admin/internal/") && v.endsWith("|interne")),
    );
    expect(consoleDansMain).toEqual([]);
    expect([...admin.keys()].filter((cle) => /^\S+ \/api\/admin\//.test(cle)).length).toBeGreaterThan(100);
    const horsPartage = [...main]
      .filter(([cle]) => admin.has(cle))
      .map(([cle, v]) => `${cle} (${v})`)
      .filter((r) => !(r.slice(r.lastIndexOf("(") + 1).split("|")[0]! in PARTAGEES));
    expect(horsPartage).toEqual([]);
  });

  it("chaque route de la console, demandée à main avec un chemin concret, y rend 404", async () => {
    const admin = await routesDu("admin");
    const console_ = [...admin.keys()].filter(
      (cle) => / \/api\/admin\//.test(cle) && !cle.includes(" /api/admin/internal/"),
    );
    const reponses: string[] = [];
    await routesDu("main", async (app) => {
      for (const cle of console_) {
        const [methode, chemin] = cle.split(" ") as [string, string];
        const url = chemin.replace(/:[^/]+/g, "x").replace(/\*$/, "x");
        const r = await app.inject({ method: methode as "GET", url });
        if (r.statusCode !== 404) reponses.push(`${cle} → ${r.statusCode}`);
      }
    });
    expect(console_.length).toBeGreaterThan(100);
    expect(reponses).toEqual([]);
  });
});
