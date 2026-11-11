// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/registre.test.ts — registre des contrats REST : routes montées par main, résolution des chemins, réponses enregistrées des vecteurs du core. */
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST, contratDe, schemasJson } from "../../src";
import { cle, demarrerCore, verifierReponse } from "./aides";
import type { CoreDeTest } from "./aides";

interface Reponse {
  statut: number;
  corps: string;
}

function vecteurs<T>(nom: string): T {
  return JSON.parse(
    readFileSync(new URL(`../../../../apps/core/test/vecteurs/${nom}.json`, import.meta.url), "utf-8"),
  ) as T;
}

let core: CoreDeTest;
let admin: CoreDeTest;

beforeAll(async () => {
  core = await demarrerCore();
  admin = await demarrerCore("admin");
});

afterAll(async () => {
  await admin.fermer();
  await core.fermer();
});

describe("registre des contrats REST", () => {
  it("chaque route sous contrat est montée par son process (main, admin pour la console) avec la même méthode et le même chemin", () => {
    const montees = (c: CoreDeTest): Set<string> =>
      new Set(c.app.elpis.routes.flatMap((r) => r.methodes.map((m) => `${m} ${r.chemin}`)));
    const main = montees(core);
    const console = montees(admin);
    expect(
      CONTRATS_REST.filter((r) => !(r.chemin.startsWith("/api/admin/") ? console : main).has(cle(r))).map(
        cle,
      ),
    ).toEqual([]);
    expect(new Set(CONTRATS_REST.map(cle)).size).toBe(CONTRATS_REST.length);
  });

  it("un chemin fixe l'emporte sur un chemin paramétré ; la chaîne de requête est ignorée", () => {
    expect(contratDe("GET", "/api/saved/chats/search?q=x")?.chemin).toBe("/api/saved/chats/search");
    expect(contratDe("POST", "/api/saved/chats/clear-all")?.chemin).toBe("/api/saved/chats/clear-all");
    expect(contratDe("GET", "/api/saved/chats/abc")?.chemin).toBe("/api/saved/chats/:chat_id");
    expect(contratDe("GET", "/api/runs/a/b/c")).toBeUndefined();
    expect(contratDe("PUT", "/api/health")).toBeUndefined();
  });
});

describe("réponses enregistrées (vecteurs du core, rejoués à l'identique par ses tests)", () => {
  it("conversations : chaque réponse d'une route sous contrat respecte le contrat", () => {
    const v = vecteurs<{ etapes: [string, string, string, unknown][]; reponses: Reponse[] }>("chats");
    let n = 0;
    v.etapes.forEach(([, methode, chemin], i) => {
      const r = v.reponses[i];
      if (r === undefined || contratDe(methode, chemin) === undefined) return;
      verifierReponse(methode, chemin, r.statut, r.corps);
      n++;
    });
    expect(n).toBeGreaterThan(30);
  });

  it("exécutions : ligne, chronologie, export", () => {
    const v = vecteurs<{ requetes: [number, string][]; reponses: Reponse[] }>("executions-chronologie");
    v.requetes.forEach(([, chemin], i) => {
      const r = v.reponses[i];
      if (r !== undefined) verifierReponse("GET", chemin, r.statut, r.corps);
    });
    expect(v.requetes.length).toBeGreaterThan(3);
  });

  it("état de génération, runs repris compris", () => {
    const v = vecteurs<{ requetes: [number, string, string, unknown][]; reponses: Reponse[] }>(
      "tour-journal",
    );
    let reprises = 0;
    v.requetes.forEach(([, methode, chemin], i) => {
      const r = v.reponses[i];
      if (r === undefined || r.corps === null || contratDe(methode, chemin) === undefined) return;
      const corps = verifierReponse(methode, chemin, r.statut, r.corps) as
        { resumable?: boolean } | undefined;
      if (corps?.resumable) reprises++;
    });
    expect(reprises).toBeGreaterThan(0);
  });
});

describe("schémas JSON des contrats REST", () => {
  it("une réponse et, s'il y a lieu, un corps par route ; l'exécution récursive passe par $defs", () => {
    const s = schemasJson();
    for (const r of CONTRATS_REST) {
      const nom = `rest-${r.methode.toLowerCase()}${r.chemin.replace(/[/:]+/gu, "-")}`;
      expect(Object.hasOwn(s, nom), nom).toBe(r.reponse !== null);
      expect(Object.hasOwn(s, `${nom}-corps`), nom).toBe(r.corps !== undefined);
    }
    expect(JSON.stringify(s["rest-get-api-runs-run_id"])).toContain("$ref");
    expect(Object.keys(s)).toEqual(
      expect.arrayContaining(["evenement-systeme", "terminal-trame-serveur", "terminal-controle"]),
    );
  });
});
