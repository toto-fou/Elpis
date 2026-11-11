// SPDX-License-Identifier: MIT
/** packages/contracts/test/toolhost/registre.test.ts — registre des contrats de l'hôte d'outils : chaque route sous contrat est montée par l'hôte, résolution des chemins. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST_TOOLHOST, contratToolhostDe } from "../../src";
import { configTest, hoteTest } from "../../../../apps/toolhost/test/aides";
import type { HoteTest } from "../../../../apps/toolhost/test/aides";
import { cleToolhost } from "./aides";

let h: HoteTest;

beforeAll(async () => {
  h = await hoteTest(configTest());
});

afterAll(async () => {
  await h.fermer();
});

describe("registre des contrats de l'hôte d'outils", () => {
  it("chaque route sous contrat est montée par l'hôte avec la même méthode et le même chemin", () => {
    const montees = new Set(
      h.composition.familles.flatMap((f) =>
        f.routes.flatMap((r) =>
          (Array.isArray(r.methode) ? r.methode : [r.methode]).map((m) => `${m} ${r.chemin}`),
        ),
      ),
    );
    expect(CONTRATS_REST_TOOLHOST.filter((r) => !montees.has(cleToolhost(r))).map(cleToolhost)).toEqual([]);
    expect(new Set(CONTRATS_REST_TOOLHOST.map(cleToolhost)).size).toBe(CONTRATS_REST_TOOLHOST.length);
  });

  it("un chemin fixe l'emporte sur un chemin paramétré ; la chaîne de requête est ignorée", () => {
    expect(contratToolhostDe("DELETE", "/api/sandbox/snapshots/restore-marker")?.chemin).toBe(
      "/api/sandbox/snapshots/restore-marker",
    );
    expect(contratToolhostDe("DELETE", "/api/sandbox/snapshots/abc")?.chemin).toBe(
      "/api/sandbox/snapshots/:snap_id",
    );
    expect(contratToolhostDe("GET", "/api/sandbox/tree?include_hidden=true")?.chemin).toBe(
      "/api/sandbox/tree",
    );
    expect(contratToolhostDe("GET", "/api/sandbox/serve/a/b")).toBeUndefined();
  });
});
