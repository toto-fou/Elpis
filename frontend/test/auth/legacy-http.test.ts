// SPDX-License-Identifier: MIT
/** frontend/test/auth/legacy-http.test.ts — `fetchAuth`/`fetchJsonAuth` historiques : null, toasts, 401 unique, 403, réseau, réponse tardive. */
import { describe, expect, it, vi } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { ClientHttp } from "../../src/platform/http/client";
import { creerHttpLegacy } from "../../src/platform/http/legacy";
import { abandon, COMPTE_A, COMPTE_B, fetchManuel, json, texte } from "../aides";

function monter(fetch: (u: string, i?: RequestInit) => Promise<Response>) {
  const session = new GestionnaireSession();
  session.ouvrir(COMPTE_A);
  const toasts: string[] = [];
  const affichage = { user: true as boolean, mdp: false };
  const h = creerHttpLegacy({
    session,
    fetch,
    showToast: (m) => toasts.push(m),
    deconnecterAffichage: () => (affichage.user = false),
    exigerMotDePasse: () => {
      if (affichage.mdp) return false;
      affichage.mdp = true;
      return true;
    },
  });
  return { session, toasts, affichage, h };
}

describe("fetchAuth", () => {
  it("rend la Response telle quelle (y compris 404 et 403 ordinaire)", async () => {
    const r404 = json({ detail: "introuvable" }, 404);
    const { h, session } = monter(() => Promise.resolve(r404));
    expect(await h.fetchAuth("/x")).toBe(r404);
    const r403 = json({ detail: "refusé" }, 403);
    const b = monter(() => Promise.resolve(r403));
    expect(await b.h.fetchAuth("/x")).toBe(r403);
    expect(session.etat.statut).toBe("connecte");
    expect(b.affichage.user).toBe(true);
  });

  it("401 concurrents : un seul toast, affichage déconnecté, session expirée", async () => {
    const m = fetchManuel();
    const { h, toasts, affichage, session } = monter(m.fetch);
    const ps = [h.fetchAuth("/a", {}, true), h.fetchAuth("/b", {}, true), h.fetchAuth("/c")];
    for (const a of m.appels) a.repondre(json({ detail: "not logged in" }, 401));
    expect(await Promise.all(ps)).toEqual([null, null, null]);
    expect(toasts.filter((t) => t.startsWith("Session expirée"))).toHaveLength(1);
    expect(affichage.user).toBe(false);
    expect(session.etat).toMatchObject({ statut: "deconnecte", raison: "expiration" });
  });

  it("panne réseau : toast sauf en mode soft, pas d'expiration", async () => {
    const { h, toasts, session } = monter(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await h.fetchAuth("/x")).toBeNull();
    expect(await h.fetchAuth("/x", {}, true)).toBeNull();
    expect(toasts).toEqual(["Erreur réseau"]);
    expect(session.etat.statut).toBe("connecte");
  });

  it("abandon : null, ou l'AbortError avec rethrowAbort", async () => {
    const { h, toasts } = monter(() => Promise.reject(abandon()));
    expect(await h.fetchAuth("/x")).toBeNull();
    await expect(h.fetchAuth("/x", { rethrowAbort: true })).rejects.toThrow("aborted");
    expect(toasts).toEqual([]);
  });

  it("403 must_change_password : carte de changement, un toast", async () => {
    const { h, toasts, affichage, session } = monter(() =>
      Promise.resolve(json({ detail: "must_change_password" }, 403)),
    );
    expect(await h.fetchAuth("/x")).toBeNull();
    expect(await h.fetchAuth("/y")).toBeNull();
    expect(affichage).toEqual({ user: false, mdp: true });
    expect(toasts).toEqual(["Votre mot de passe doit être changé avant de continuer."]);
    expect(session.etat.statut).toBe("mot_de_passe_a_changer");
  });

  it("réponse tardive d'un ancien compte : null, le nouveau compte n'est pas déconnecté", async () => {
    const m = fetchManuel();
    const { h, session, affichage, toasts } = monter(m.fetch);
    const p = h.fetchAuth("/api/saved/chats");
    session.fermer("deconnexion");
    session.ouvrir(COMPTE_B);
    m.appels[0]?.repondre(json({ detail: "not logged in" }, 401));
    expect(await p).toBeNull();
    expect(affichage.user).toBe(true);
    expect(session.compte?.id).toBe(2);
    expect(toasts).toEqual([]);
  });

  it("expiration vue par le client typé : même toast et même détachement", async () => {
    const { session, toasts, affichage } = monter(() => Promise.resolve(json({}, 200)));
    const http = new ClientHttp(session, () => Promise.resolve(json({ detail: "not logged in" }, 401)));
    await http.requete("/x");
    expect(toasts).toHaveLength(1);
    expect(affichage.user).toBe(false);
  });

  it("handleSessionExpired répété (SSE puis WS) : un seul toast", () => {
    const { h, toasts } = monter(() => Promise.resolve(json({})));
    h.handleSessionExpired();
    h.handleSessionExpired();
    expect(toasts).toHaveLength(1);
  });
});

describe("fetchJsonAuth", () => {
  it("objet JSON, ou null avec toast (HTTP, JSON invalide), silencieux sur demande", async () => {
    const ok = monter(() => Promise.resolve(json({ a: 1 })));
    expect(await ok.h.fetchJsonAuth("/x")).toEqual({ a: 1 });
    const ko = monter(() => Promise.resolve(texte("Internal Server Error", 500)));
    expect(await ko.h.fetchJsonAuth("/x")).toBeNull();
    expect(await ko.h.fetchJsonAuth("/x", {}, { errorMsg: "Échec" })).toBeNull();
    expect(await ko.h.fetchJsonAuth("/x", {}, { silent: true })).toBeNull();
    expect(ko.toasts).toEqual(["Erreur serveur (HTTP 500)", "Échec"]);
    const inv = monter(() => Promise.resolve(texte("pas du json", 200)));
    expect(await inv.h.fetchJsonAuth("/x")).toBeNull();
    expect(inv.toasts).toEqual(["Réponse serveur invalide"]);
  });

  it("aucune mutation rejouée après une erreur ambiguë", async () => {
    const f = vi.fn(() => Promise.reject(new TypeError("reset")));
    const { h } = monter(f);
    expect(await h.fetchJsonAuth("/api/chat/cancel", { method: "POST" })).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });
});
