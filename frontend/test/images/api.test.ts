// SPDX-License-Identifier: MIT
/** frontend/test/images/api.test.ts — accès REST aux images : validation C2, paramètres de la galerie, suppression, préférences. */
import { describe, expect, it } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { creerApiImages } from "../../src/features/images/api";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

function api(fetch: (u: string, i?: RequestInit) => Promise<Response>) {
  return creerApiImages(new ClientHttp(new GestionnaireSession(), fetch));
}

describe("api images", () => {
  it("lit le statut du moteur indisponible", async () => {
    const a = api(() => Promise.resolve(json({ ready: false, available: false })));
    expect(await a.statut()).toEqual({ ready: false, available: false });
  });

  it("rend null pour un statut hors contrat ou une erreur", async () => {
    expect(await api(() => Promise.resolve(json({ ready: "oui" }))).statut()).toBeNull();
    expect(await api(() => Promise.resolve(json({ detail: "x" }, 500))).statut()).toBeNull();
  });

  it("construit la requête de galerie (limite, curseur, conversation)", async () => {
    const urls: string[] = [];
    const a = api((u) => {
      urls.push(u);
      return Promise.resolve(json({ items: [], next_before: null, total: 0, keep: 0 }));
    });
    await a.galerie({ limite: 48 });
    await a.galerie({ limite: 48, avant: 900.5, chat: "c42" });
    expect(urls).toEqual(["/api/images?limit=48", "/api/images?limit=48&before=900.5&chat_id=c42"]);
  });

  it("distingue suppression réussie, image absente et échec", async () => {
    const statuts = [200, 404, 500];
    const a = api(() => {
      const s = statuts.shift() ?? 200;
      return Promise.resolve(s === 200 ? json({ ok: true }) : json({ detail: "non" }, s));
    });
    expect(await a.supprimer("a1")).toBe("ok");
    expect(await a.supprimer("a1")).toBe("absente");
    expect(await a.supprimer("a1")).toBe("echec");
  });

  it("enregistre les préférences par un PUT ciblé", async () => {
    const appels: Array<[string, RequestInit | undefined]> = [];
    const a = api((u, i) => {
      appels.push([u, i]);
      return Promise.resolve(json({ ok: true }));
    });
    await a.enregistrerPreferences({ ratio: "4:3", side: 1024, n: 2, enhance: true });
    expect(appels[0]?.[0]).toBe("/api/settings");
    expect(appels[0]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(appels[0]?.[1]?.body))).toEqual({
      image_prefs: { ratio: "4:3", side: 1024, n: 2, enhance: true },
    });
  });
});
