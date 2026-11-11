// SPDX-License-Identifier: MIT
/** frontend/test/admin/hotes-outils.test.ts — console › Hôtes d'outils : lecture validée, affectation et migration confirmées, refus du serveur. */
import { describe, expect, it } from "vitest";

import { setupAdminHotesOutils } from "../../src/features/admin/hotes-outils";
import { GestionnaireSession } from "../../src/features/auth/session";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const HOTES = { ok: true, hosts: [], placement: {}, placements: [] };

function monter(route: (u: string, o?: RequestInit) => Response, confirme = true) {
  const vus: Array<[string, string, unknown]> = [];
  const toasts: string[] = [];
  const fetch = (u: string, o?: RequestInit): Promise<Response> => {
    vus.push([u, o?.method ?? "GET", o?.body]);
    return Promise.resolve(route(u, o));
  };
  const H = setupAdminHotesOutils(
    { showToast: (m) => toasts.push(m), openConfirm: () => Promise.resolve(confirme) },
    new ClientHttp(new GestionnaireSession(), fetch),
  );
  return { H, vus, toasts };
}

describe("setupAdminHotesOutils", () => {
  it("lit les hôtes ; réponse hors contrat : null", async () => {
    const bon = monter(() => json(HOTES));
    await bon.H.loadToolhosts();
    expect(bon.H.toolhosts.value?.ok).toBe(true);
    const mauvais = monter(() => json({}));
    await mauvais.H.loadToolhosts();
    expect(mauvais.H.toolhosts.value).toBeNull();
  });

  it("migration : POST /migrate, toast du nombre de fichiers, cible vidée, relecture", async () => {
    const { H, vus, toasts } = monter((u) =>
      u.endsWith("/migrate") ? json({ ok: true, files: 4 }) : json(HOTES),
    );
    H.toolhostMoveTarget.value["7"] = "h2";
    await H.migrateToolhostPlacement(7);
    expect(vus[0]).toEqual([
      "/api/admin/toolhosts/placements/7/migrate",
      "POST",
      JSON.stringify({ host_id: "h2" }),
    ]);
    expect(toasts).toEqual(["Migré : 4 fichiers"]);
    expect(H.toolhostMoveTarget.value["7"]).toBe("");
    expect(vus.at(-1)![0]).toBe("/api/admin/toolhosts");
    expect(H.toolhostBusy.value).toBe(false);
  });

  it("affectation refusée : détail du serveur ; sans cible ou sans confirmation : aucun appel", async () => {
    const { H, toasts } = monter((u) =>
      u.includes("placements") ? json({ detail: "Hôte inconnu." }, 404) : json(HOTES),
    );
    H.toolhostMoveTarget.value["3"] = "x";
    await H.assignToolhostPlacement(3);
    expect(toasts).toEqual(["Hôte inconnu."]);
    const vide = monter(() => json(HOTES));
    await vide.H.assignToolhostPlacement(9);
    const non = monter(() => json(HOTES), false);
    non.H.toolhostMoveTarget.value["1"] = "h";
    await non.H.assignToolhostPlacement(1);
    expect(vide.vus).toEqual([]);
    expect(non.vus).toEqual([]);
  });
});
