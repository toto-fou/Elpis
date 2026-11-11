// SPDX-License-Identifier: MIT
/** frontend/test/auth/auth.test.ts — `setupAuth` porté : me-lite, connexion (statuts), réponse tardive, déconnexion volontaire. */
import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";

import { setupAuth } from "../../src/features/auth/auth";
import type { CtxAuth, FenetreElpis, UtilisateurAffiche } from "../../src/features/auth/auth";
import { GestionnaireSession } from "../../src/features/auth/session";
import { ClientHttp } from "../../src/platform/http/client";
import { creerHttpLegacy } from "../../src/platform/http/legacy";
import { fetchManuel, json, texte } from "../aides";

const MOI_A = { logged_in: true, id: 1, username: "alice", is_admin: false, role: "user", avatar: null };

function monter(
  fetch: (u: string, i?: RequestInit) => Promise<Response>,
  fenetre: Partial<FenetreElpis> = {},
) {
  const session = new GestionnaireSession();
  const http = new ClientHttp(session, fetch);
  const refs = {
    user: ref<UtilisateurAffiche | null>(null),
    isAdminView: ref(false),
    messages: ref<unknown[]>(["m"]),
    currentChatId: ref<unknown>("c1"),
    isStreaming: ref(true),
  };
  const toasts: string[] = [];
  const showToast = (m: string) => toasts.push(m);
  const legacy = creerHttpLegacy({
    session,
    fetch,
    showToast,
    deconnecterAffichage: () => (refs.user.value = null),
    exigerMotDePasse: () => true,
  });
  const resetChat = vi.fn();
  const ctx: CtxAuth = {
    showToast,
    fetchAuth: legacy.fetchAuth,
    loadChatsList: vi.fn(),
    loadSettingsData: vi.fn(),
    loadSandboxFiles: vi.fn(),
    resetChatOnLogout: resetChat,
  };
  const fen: FenetreElpis = { location: { href: "/" }, ...fenetre };
  const auth = setupAuth(refs, ctx, { session, http, fenetre: fen });
  return { session, refs, toasts, auth, ctx, resetChat };
}

const reponses =
  (table: Record<string, () => Response>) =>
  (u: string): Promise<Response> => {
    const f = table[u];
    return f ? Promise.resolve(f()) : Promise.reject(new TypeError("Failed to fetch"));
  };

describe("checkAuth", () => {
  it("connecté : compte affiché, session ouverte, chargements lancés", async () => {
    const { auth, refs, session, ctx } = monter(reponses({ "/api/me-lite": () => json(MOI_A) }));
    await auth.checkAuth();
    expect(refs.user.value).toEqual({
      id: 1,
      username: "alice",
      is_admin: false,
      role: "user",
      avatar: null,
    });
    expect(session.compte?.id).toBe(1);
    expect(ctx.loadChatsList).toHaveBeenCalled();
  });

  it("mot de passe à changer, puis déconnecté", async () => {
    const a = monter(
      reponses({
        "/api/me-lite": () => json({ logged_in: false, must_change_password: true, id: 1, username: "a" }),
      }),
    );
    await a.auth.checkAuth();
    expect(a.auth.mustChangePassword.value).toBe(true);
    expect(a.session.etat.statut).toBe("mot_de_passe_a_changer");
    const b = monter(reponses({ "/api/me-lite": () => json({ logged_in: false }) }));
    await b.auth.checkAuth();
    expect(b.refs.user.value).toBeNull();
    expect(b.session.etat).toMatchObject({ statut: "deconnecte", raison: null });
  });

  it("me-lite parti avant une déconnexion : jamais réinjecté", async () => {
    const m = fetchManuel();
    const { auth, refs, session } = monter(m.fetch);
    session.ouvrir({ id: 1, username: "alice", is_admin: false, role: "user", avatar: null });
    const p = auth.checkAuth();
    session.fermer("deconnexion");
    m.appels[0]?.repondre(json(MOI_A));
    await p;
    expect(refs.user.value).toBeNull();
    expect(session.etat.statut).toBe("deconnecte");
  });

  it("payload invalide : état inchangé", async () => {
    const { auth, refs, session } = monter(
      reponses({ "/api/me-lite": () => json({ logged_in: "peut-être" }) }),
    );
    await auth.checkAuth();
    expect(refs.user.value).toBeNull();
    expect(session.etat.statut).toBe("inconnu");
  });
});

describe("login", () => {
  const essai = async (rep: () => Response) => {
    const x = monter(reponses({ "/api/login-lite": rep, "/api/me-lite": () => json(MOI_A) }));
    x.auth.loginForm.value = { username: "alice", password: "pw" };
    await x.auth.login();
    return x;
  };

  it("succès : session ouverte, Bienvenue", async () => {
    const { refs, toasts } = await essai(() =>
      json({ ok: true, is_admin: false, must_change_password: false }),
    );
    expect(refs.user.value?.username).toBe("alice");
    expect(toasts).toContain("Bienvenue");
  });

  it("succès : le mot de passe saisi ne reste pas dans l'état, le nom si", async () => {
    const { auth } = await essai(() => json({ ok: true, is_admin: false, must_change_password: false }));
    expect(auth.loginForm.value).toEqual({ username: "alice", password: "" });
  });

  it("échec : le mot de passe reste saisi pour corriger", async () => {
    const { auth } = await essai(() => json({ detail: "Identifiants invalides" }, 401));
    expect(auth.loginForm.value.password).toBe("pw");
  });

  it("401 et 403 : identifiants refusés, sans expiration", async () => {
    for (const s of [401, 403]) {
      const { auth, session } = await essai(() => json({ detail: "Identifiants invalides" }, s));
      expect(auth.loginError.value).toBe("Identifiant ou mot de passe incorrect.");
      expect(session.etat.statut).toBe("inconnu");
    }
  });

  it("429, 500 et réseau : messages distincts", async () => {
    expect((await essai(() => json({ detail: "x" }, 429))).auth.loginError.value).toMatch(
      /^Trop de tentatives/,
    );
    expect((await essai(() => texte("Internal Server Error", 500))).auth.loginError.value).toMatch(
      /erreur 500/,
    );
    const r = monter(() => Promise.reject(new TypeError("Failed to fetch")));
    await r.auth.login();
    expect(r.auth.loginError.value).toMatch(/^Serveur injoignable/);
    expect(r.auth.isLoading.value).toBe(false);
  });

  it("mot de passe imposé changé : la saisie est effacée", async () => {
    const x = monter(
      reponses({
        "/api/login-lite": () => json({ ok: true, is_admin: false, must_change_password: true }),
        "/api/users/change-password": () => json({ ok: true }),
        "/api/me-lite": () => json(MOI_A),
      }),
    );
    x.auth.loginForm.value = { username: "alice", password: "pw" };
    await x.auth.login();
    x.auth.newPasswordForce.value = "Nouveau-mot-1";
    await x.auth.submitForcePasswordChange();
    expect(x.auth.mustChangePassword.value).toBe(false);
    expect(x.auth.newPasswordForce.value).toBe("");
  });

  it("must_change_password à la connexion", async () => {
    const { auth, session } = await essai(() =>
      json({ ok: true, is_admin: false, must_change_password: true }),
    );
    expect(auth.mustChangePassword.value).toBe(true);
    expect(session.etat.statut).toBe("mot_de_passe_a_changer");
  });
});

describe("logout", () => {
  it("volontaire : session fermée en « deconnexion », génération arrêtée (explicit = true), état purgé", async () => {
    const { auth, refs, session, resetChat, toasts } = monter(
      reponses({ "/api/me-lite": () => json(MOI_A), "/api/logout-lite": () => json({ ok: true }) }),
    );
    await auth.checkAuth();
    await auth.logout();
    expect(session.etat).toMatchObject({ statut: "deconnecte", raison: "deconnexion" });
    expect(refs.user.value).toBeNull();
    expect(refs.messages.value).toEqual([]);
    expect(refs.isStreaming.value).toBe(false);
    expect(resetChat).toHaveBeenCalledWith(true);
    expect(toasts).toContain("Déconnecté");
  });

  it("serveur injoignable : rien n'est purgé ni rejoué", async () => {
    let n = 0;
    const { auth, refs, session } = monter((u) => {
      if (u === "/api/me-lite") return Promise.resolve(json(MOI_A));
      if (u === "/api/logout-lite") n += 1;
      return Promise.reject(new TypeError("Failed to fetch"));
    });
    await auth.checkAuth();
    await auth.logout();
    expect(n).toBe(1);
    expect(session.etat.statut).toBe("connecte");
    expect(refs.user.value).not.toBeNull();
  });
});

describe("configuration publique : logo de l'application", () => {
  const charger = async (app_logo_url: unknown) => {
    const { auth, ctx } = monter(
      reponses({
        "/api/public-config": () => json({ app_info: { name: "Elpis" }, app_logo_url }),
      }),
    );
    const appInfo = ref<unknown>({});
    Object.assign(ctx, { appInfo });
    await auth.loadPublicConfig();
    return (appInfo.value as { logoUrl?: string }).logoUrl;
  };

  it("adresse à empreinte du core reprise telle quelle, toute autre forme donne le logo d'Elpis", async () => {
    expect(await charger("/api/app-logo?v=0123456789abcdef")).toBe("/api/app-logo?v=0123456789abcdef");
    expect(await charger("static/elpis-256.png")).toBe("static/elpis-256.png");
    for (const autre of [
      undefined,
      3,
      "javascript:alert(1)",
      "https://ailleurs/logo.png",
      "/api/app-logo?v=x",
    ])
      expect(await charger(autre), String(autre)).toBe("static/elpis-256.png");
  });
});
