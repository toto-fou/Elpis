// SPDX-License-Identifier: MIT
/** frontend/test/admin/prometheus.test.ts — console › Prometheus : lecture du jeton, génération, révocation confirmée, copie. */
import { describe, expect, it } from "vitest";

import { setupAdminPrometheus } from "../../src/features/admin/prometheus";
import { GestionnaireSession } from "../../src/features/auth/session";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

function monter(route: (u: string, o?: RequestInit) => Response, confirme = true) {
  const vus: Array<[string, string, unknown]> = [];
  const toasts: string[] = [];
  const fetch = (u: string, o?: RequestInit): Promise<Response> => {
    vus.push([u, o?.method ?? "GET", o?.body]);
    return Promise.resolve(route(u, o));
  };
  const P = setupAdminPrometheus(
    { showToast: (m) => toasts.push(m), openConfirm: () => Promise.resolve(confirme) },
    new ClientHttp(new GestionnaireSession(), fetch),
  );
  return { P, vus, toasts };
}

describe("setupAdminPrometheus", () => {
  it("lit l'état ; échec : chargement levé, état inchangé", async () => {
    const { P } = monter(() => json({ configured: true, token: "pm_abc" }));
    await P.loadScrapeToken();
    expect(P.scrapeToken.value).toEqual({ configured: true, token: "pm_abc", loading: false });
    const ko = monter(() => json({ detail: "non" }, 500));
    await ko.P.loadScrapeToken();
    expect(ko.P.scrapeToken.value).toEqual({ configured: false, token: null, loading: false });
  });

  it("génération puis révocation : action envoyée, révocation confirmée", async () => {
    const { P, vus, toasts } = monter((_u, o) =>
      json(
        JSON.parse(String(o?.body)).action === "revoke"
          ? { configured: false, token: null }
          : { configured: true, token: "t" },
      ),
    );
    await P.setScrapeToken("generate");
    expect(P.scrapeToken.value.token).toBe("t");
    await P.setScrapeToken("revoke");
    expect(P.scrapeToken.value.configured).toBe(false);
    expect(vus.map((v) => JSON.parse(String(v[2])).action)).toEqual(["generate", "revoke"]);
    expect(toasts).toEqual(["Jeton généré", "Jeton révoqué"]);
    const non = monter(() => json({}), false);
    await non.P.setScrapeToken("revoke");
    expect(non.vus).toEqual([]);
  });

  it("refus : toast d'erreur ; URL de scrape à l'origine de la page", async () => {
    const { P, toasts } = monter(() => json({ detail: "non" }, 403));
    await P.setScrapeToken("generate");
    expect(toasts).toEqual(["Opération refusée"]);
    expect(P.prometheusUrl()).toBe(window.location.origin + "/api/admin/metrics/prometheus");
  });
});
