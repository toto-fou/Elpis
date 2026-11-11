// SPDX-License-Identifier: MIT
/** frontend/test/editor/apercu.test.ts — aperçu web : saisie libre de l'URL serveur, URL de l'iframe, jeton lié à la génération de session (oublié à la fin, réponse tardive ignorée), mode live au chemin figé. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { analyserUrlServeur, setupEditorPreview } from "../../src/features/editor/apercu";
import { COMPTE_A, COMPTE_B, fetchManuel, json } from "../aides";

describe("saisie de l'URL du serveur (cas de l'ancien preview-url-unit.mjs)", () => {
  it.each([
    ["8080", { port: 8080, path: "/", host: "" }],
    ["  3000  ", { port: 3000, path: "/", host: "" }],
    ["localhost:8080", { port: 8080, path: "/", host: "localhost" }],
    ["localhost:8080/", { port: 8080, path: "/", host: "localhost" }],
    ["127.0.0.1:5000/api", { port: 5000, path: "/api", host: "127.0.0.1" }],
    ["0.0.0.0:8000/docs", { port: 8000, path: "/docs", host: "0.0.0.0" }],
    ["http://localhost:5173/app", { port: 5173, path: "/app", host: "localhost" }],
    ["https://localhost:8443/x", { port: 8443, path: "/x", host: "localhost" }],
    ["http://localhost:8000/docs?debug=1&v=2", { port: 8000, path: "/docs?debug=1&v=2", host: "localhost" }],
    ["/docs", { port: null, path: "/docs", host: "" }],
    ["", { port: null, path: "/", host: "" }],
    ["   ", { port: null, path: "/", host: "" }],
    ["localhost", { port: null, path: "/", host: "localhost" }],
    ["http://localhost/x", { port: null, path: "/x", host: "localhost" }],
    ["[::1]:8080/x", { port: 8080, path: "/x", host: "[::1]" }],
    ["http://[::1]:9000", { port: 9000, path: "/", host: "[::1]" }],
    ["0", { port: null, path: "/", host: "" }],
    ["70000", { port: null, path: "/", host: "" }],
    ["localhost:99999/x", { port: null, path: "/x", host: "localhost" }],
    ["http://example.com:8080/x", { port: 8080, path: "/x", host: "example.com" }],
  ])("%s", (brut, attendu) => {
    expect(analyserUrlServeur(brut)).toEqual(attendu);
  });
});

function monde() {
  const session = new GestionnaireSession();
  session.ouvrir(COMPTE_A);
  const f = fetchManuel();
  const enregistrements: string[] = [];
  let actif: string | null = "index.html";
  const a = setupEditorPreview(session, {
    fetchAuth: (url, init) => f.fetch(url, init),
    ongletActif: () => actif,
    apercuScinde: () => true,
    enregistrer: (o) => {
      enregistrements.push(o.path);
      return Promise.resolve();
    },
  });
  return {
    session,
    f,
    a,
    enregistrements,
    activer: (p: string) => {
      actif = p;
    },
  };
}

describe("jeton et URL de l'aperçu", () => {
  it("URL fichier et serveur portent le jeton ; la saisie validée affiche la cible réelle et signale un hôte étranger", async () => {
    const m = monde();
    expect(m.a.previewSrc.value).toBe("about:blank");
    m.f.appels[0]?.repondre(json({ token: "T1", expires: Math.floor(Date.now() / 1000) + 3600 }));
    await vi.waitFor(() => expect(m.a.previewSrc.value).toBe("/api/sandbox/pv/T1/index.html"));
    m.a.previewPath.value = "dossier/une page.html";
    expect(m.a.previewSrc.value).toBe("/api/sandbox/pv/T1/dossier/une%20page.html");
    m.a.previewSource.value = "server";
    m.a.previewServerUrl.value = "http://exemple.fr:5173/app";
    m.a.commitPreviewServerUrl();
    expect(m.a.previewServerUrl.value).toBe("localhost:5173/app");
    expect(m.a.previewServerHostWarn.value).toBe("exemple.fr");
    expect(m.a.previewSrc.value).toBe("/api/sandbox/pvs/T1/5173/app");
  });

  it("fin de session : le jeton est oublié ; une réponse partie avant la fin n'est jamais adoptée", async () => {
    const m = monde();
    void m.a.previewSrc.value;
    m.f.appels[0]?.repondre(json({ token: "TA", expires: Math.floor(Date.now() / 1000) + 3600 }));
    await vi.waitFor(() => expect(m.a.previewToken.value).toBe("TA"));
    m.session.fermer("deconnexion");
    expect(m.a.previewToken.value).toBe("");
    const tardif = m.a._ensurePreviewToken();
    m.session.ouvrir(COMPTE_B);
    m.f.appels[1]?.repondre(json({ token: "TA-tardif", expires: Math.floor(Date.now() / 1000) + 3600 }));
    await tardif;
    expect(m.a.previewToken.value).toBe("");
    expect(m.a.previewSrc.value).toBe("about:blank");
  });

  it("jeton proche de l'expiration : renouvelé ; un seul appel pour des demandes concurrentes", async () => {
    const m = monde();
    const p1 = m.a._ensurePreviewToken();
    const p2 = m.a._ensurePreviewToken();
    expect(m.f.appels).toHaveLength(1);
    m.f.appels[0]?.repondre(json({ token: "court", expires: Math.floor(Date.now() / 1000) + 60 }));
    await Promise.all([p1, p2]);
    void m.a._ensurePreviewToken();
    expect(m.f.appels).toHaveLength(2);
  });
});

describe("mode live", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("enregistre le fichier actif au moment de la frappe, même après un changement d'onglet, puis recharge", async () => {
    const m = monde();
    m.a.togglePreviewLive();
    m.a._schedulePreviewLive();
    m.activer("autre.html");
    await vi.advanceTimersByTimeAsync(700);
    expect(m.enregistrements).toEqual(["index.html"]);
    m.a.togglePreviewLive();
    m.a._schedulePreviewLive();
    await vi.advanceTimersByTimeAsync(700);
    expect(m.enregistrements).toEqual(["index.html"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
