// SPDX-License-Identifier: MIT
/** frontend/test/auth/securite-sso.test.ts — SSO : navigation seulement vers du https rendu par le serveur, codes d'erreur en liste fermée, référence validée, preuve du titulaire sans conservation du mot de passe. */
import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";

import { setupAuth } from "../../src/features/auth/auth";
import type { UtilisateurAffiche } from "../../src/features/auth/auth";
import { GestionnaireSession } from "../../src/features/auth/session";
import { setupSso } from "../../src/features/auth/sso";
import type { EnvSso } from "../../src/features/auth/sso";
import { ClientHttp } from "../../src/platform/http/client";
import { fetchManuel, json, vider } from "../aides";

interface Appel {
  url: string;
  init?: RequestInit;
}

function banc(
  table: Record<string, () => Response>,
  recherche = "",
  origine = "https://elpis.example.test",
  chemin = "/",
  console = false,
) {
  const appels: Appel[] = [];
  const naviguer = vi.fn();
  const remplacerUrl = vi.fn();
  const env: EnvSso = {
    origine: () => origine,
    chemin: () => chemin,
    recherche: () => recherche,
    naviguer,
    remplacerUrl,
  };
  const session = new GestionnaireSession();
  const http = new ClientHttp(session, (u, i) => {
    appels.push({ url: u, init: i });
    const f = table[(i?.method ?? "GET") + " " + u];
    return f ? Promise.resolve(f()) : Promise.reject(new TypeError("Failed to fetch"));
  });
  const crochets = {
    rechargerConfig: vi.fn(() => Promise.resolve()),
    depuisConsole: () => console,
  };
  const sso = setupSso(http, crochets, env);
  sso.appliquerConfig({
    login_methods: [{ id: "keycloak", label: "Keycloak" }],
    auth_origin: "https://elpis.example.test",
  });
  return { sso, appels, naviguer, remplacerUrl, crochets, env };
}

const DEPART = "POST /api/auth/oidc/keycloak/start";

describe("départ du flux SSO", () => {
  it("poste target=app puis navigue vers l'adresse https rendue", async () => {
    const b = banc({ [DEPART]: () => json({ url: "https://idp.example.test/auth?x=1" }) });
    await b.sso.startSso("keycloak");
    expect(JSON.parse(String(b.appels[0]?.init?.body))).toEqual({ target: "app" });
    expect(b.naviguer).toHaveBeenCalledWith("https://idp.example.test/auth?x=1");
  });

  it("transmet oauth_next seulement s'il a la forme attendue", async () => {
    const ok = banc(
      { [DEPART]: () => json({ url: "https://idp.example.test/a" }) },
      "?oauth_next=" + encodeURIComponent("/oauth/authorize?client_id=x"),
    );
    await ok.sso.startSso("keycloak");
    expect(JSON.parse(String(ok.appels[0]?.init?.body))).toEqual({
      target: "app",
      oauth_next: "/oauth/authorize?client_id=x",
    });
    for (const mauvais of ["//evil.test/x", "https://evil.test/", "/autre?x=1"]) {
      const b = banc(
        { [DEPART]: () => json({ url: "https://idp.example.test/a" }) },
        "?oauth_next=" + encodeURIComponent(mauvais),
      );
      await b.sso.startSso("keycloak");
      expect(JSON.parse(String(b.appels[0]?.init?.body))).toEqual({ target: "app" });
    }
  });

  it("refuse de naviguer vers une adresse qui n'est pas https", async () => {
    for (const url of [
      "http://idp.example.test/a",
      "javascript:alert(1)",
      "//idp.example.test/a",
      "/relatif",
      "",
    ]) {
      const b = banc({ [DEPART]: () => json({ url }) });
      await b.sso.startSso("keycloak");
      expect(b.naviguer).not.toHaveBeenCalled();
      expect(b.sso.ssoError.value).toBe(
        "La connexion n'a pas abouti. Réessayez ou demandez à votre administrateur.",
      );
      expect(b.sso.ssoBusy.value).toBe(false);
    }
  });

  it("hôte non canonique : navigue vers l'origine du serveur avec le chemin et les paramètres courants, sans appel", async () => {
    const b = banc({}, "?oauth_next=%2Foauth%2Fauthorize%3Fa%3D1", "https://autre.example.test", "/");
    await b.sso.startSso("keycloak");
    expect(b.appels).toEqual([]);
    expect(b.naviguer).toHaveBeenCalledWith(
      "https://elpis.example.test/?oauth_next=%2Foauth%2Fauthorize%3Fa%3D1",
    );
  });

  it("une origine canonique non https est ignorée : pas de navigation vers elle", async () => {
    const b = banc({ [DEPART]: () => json({ url: "https://idp.example.test/a" }) }, "", "http://elpis.test");
    b.sso.appliquerConfig({
      login_methods: [{ id: "keycloak", label: "K" }],
      auth_origin: "http://elpis.test",
    });
    expect(b.sso.authOrigin.value).toBe("");
    await b.sso.startSso("keycloak");
    expect(b.naviguer).toHaveBeenCalledWith("https://idp.example.test/a");
  });

  it("409 avec canonical : navigue vers cette origine si https, sinon refuse", async () => {
    const b = banc({
      [DEPART]: () => json({ detail: "Hôte", canonical: "https://canon.example.test" }, 409),
    });
    await b.sso.startSso("keycloak");
    expect(b.naviguer).toHaveBeenCalledWith("https://canon.example.test/");
    const m = banc({ [DEPART]: () => json({ detail: "Hôte", canonical: "http://canon.example.test" }, 409) });
    await m.sso.startSso("keycloak");
    expect(m.naviguer).not.toHaveBeenCalled();
    expect(m.sso.ssoError.value).not.toBe("");
  });

  it("429, 503 et 404 : messages dédiés, 404 recharge la configuration", async () => {
    const t = banc({ [DEPART]: () => json({ detail: "x" }, 429) });
    await t.sso.startSso("keycloak");
    expect(t.sso.ssoError.value).toBe("Trop de tentatives, réessayez dans un instant.");
    const s = banc({ [DEPART]: () => json({ detail: "x" }, 503) });
    await s.sso.startSso("keycloak");
    expect(s.sso.ssoError.value).toBe(
      "Le service de connexion de votre organisation ne répond pas. Réessayez plus tard ou demandez à votre administrateur.",
    );
    const n = banc({ [DEPART]: () => json({ detail: "x" }, 404) });
    await n.sso.startSso("keycloak");
    expect(n.crochets.rechargerConfig).toHaveBeenCalledTimes(1);
    expect(n.sso.ssoBusy.value).toBe(false);
  });

  it("un double clic ne lance qu'un flux", async () => {
    const m = fetchManuel();
    const session = new GestionnaireSession();
    const naviguer = vi.fn();
    const sso = setupSso(
      new ClientHttp(session, m.fetch),
      { rechargerConfig: () => Promise.resolve() },
      {
        origine: () => "https://e.test",
        chemin: () => "/",
        recherche: () => "",
        naviguer,
        remplacerUrl: vi.fn(),
      },
    );
    sso.appliquerConfig({ login_methods: [{ id: "k", label: "K" }] });
    const p1 = sso.startSso("k");
    const p2 = sso.startSso("k");
    expect(sso.ssoBusy.value).toBe(true);
    m.appels[0]?.repondre(json({ url: "https://idp.test/a" }));
    await Promise.all([p1, p2]);
    expect(m.appels).toHaveLength(1);
    expect(naviguer).toHaveBeenCalledTimes(1);
  });
});

describe("retour en erreur", () => {
  const MESSAGES: [string, string][] = [
    ["denied", "Connexion refusée par le service de votre organisation."],
    ["expired", "La connexion a pris trop de temps. Réessayez."],
    ["not_in_group", "Votre compte n'est pas autorisé à utiliser Elpis. Demandez à votre administrateur."],
    ["groups_unknown", "Votre compte n'est pas autorisé à utiliser Elpis. Demandez à votre administrateur."],
    ["conflict", "Votre compte n'est pas autorisé à utiliser Elpis. Demandez à votre administrateur."],
    ["suspended", "Votre compte n'est pas autorisé à utiliser Elpis. Demandez à votre administrateur."],
    ["mfa_required", "Une vérification en deux étapes est exigée. Reconnectez-vous en la validant."],
    ["unavailable", "Le service de connexion de votre organisation ne répond pas. Réessayez plus tard."],
    ["failed", "La connexion n'a pas abouti. Réessayez ou demandez à votre administrateur."],
  ];

  it.each(MESSAGES)("code %s : message fixe et référence valide", async (code, message) => {
    const b = banc({}, `?auth_error=${code}&ref=AbCd1234&autre=1`);
    await b.sso.lireRetour();
    expect(b.sso.authRetour.value).toEqual({ message, reference: "AbCd1234" });
    expect(b.remplacerUrl).toHaveBeenCalledWith("/?autre=1");
  });

  it("un code inconnu est traité comme failed et n'est jamais affiché", async () => {
    const b = banc({}, "?auth_error=%3Cb%3Eboom%3C%2Fb%3E&ref=ABCD1234");
    await b.sso.lireRetour();
    expect(b.sso.authRetour.value?.message).toBe(
      "La connexion n'a pas abouti. Réessayez ou demandez à votre administrateur.",
    );
    expect(JSON.stringify(b.sso.authRetour.value)).not.toContain("boom");
  });

  it("une référence base64url avec - et _ est acceptée", async () => {
    const b = banc({}, "?auth_error=groups_unknown&ref=sB-F5_xY");
    await b.sso.lireRetour();
    expect(b.sso.authRetour.value?.reference).toBe("sB-F5_xY");
  });

  it("une référence mal formée est ignorée", async () => {
    for (const ref of ["<img src=x>", "ABC", "ABCDEFGHI", "ABCD 123", ""]) {
      const b = banc({}, "?auth_error=denied&ref=" + encodeURIComponent(ref));
      await b.sso.lireRetour();
      expect(b.sso.authRetour.value?.reference).toBeNull();
    }
  });

  it("l'URL est nettoyée, même sans autre paramètre ; sans retour, rien n'est touché", async () => {
    const b = banc({}, "?auth_error=denied&ref=ABCD1234");
    await b.sso.lireRetour();
    expect(b.remplacerUrl).toHaveBeenCalledWith("/");
    const c = banc({}, "?x=1");
    await c.sso.lireRetour();
    expect(c.remplacerUrl).not.toHaveBeenCalled();
    expect(c.sso.authRetour.value).toBeNull();
    expect(c.appels).toEqual([]);
  });
});

describe("SSO depuis la console d'administration", () => {
  const CONFIG = {
    login_methods: [{ id: "keycloak", label: "Keycloak" }],
    auth_origin: "https://elpis.example.test",
  };

  it("même nom d'hôte sur un autre port : départ sur place avec target=console", async () => {
    const b = banc(
      { [DEPART]: () => json({ url: "https://idp.example.test/a" }) },
      "",
      "https://elpis.example.test:8002",
      "/",
      true,
    );
    b.sso.appliquerConfig(CONFIG);
    await b.sso.startSso("keycloak");
    expect(b.appels.map((a) => a.url)).toEqual(["/api/auth/oidc/keycloak/start"]);
    expect(JSON.parse(String(b.appels[0]?.init?.body))).toEqual({ target: "console" });
    expect(b.naviguer).toHaveBeenCalledWith("https://idp.example.test/a");
  });

  it("autre nom d'hôte : navigation vers le nom canonique, port, chemin et paramètres gardés, sans appel", async () => {
    const b = banc({}, "?x=1", "https://autre.example.test:8002", "/admin", true);
    b.sso.appliquerConfig(CONFIG);
    await b.sso.startSso("keycloak");
    expect(b.appels).toEqual([]);
    expect(b.naviguer).toHaveBeenCalledWith("https://elpis.example.test:8002/admin?x=1");
  });

  it("page non https sur un autre hôte : aucune navigation", async () => {
    const b = banc({}, "", "http://autre.example.test:8002", "/", true);
    b.sso.appliquerConfig(CONFIG);
    await b.sso.startSso("keycloak");
    expect(b.naviguer).not.toHaveBeenCalled();
    expect(b.sso.ssoError.value).not.toBe("");
  });

  it("l'application garde target=app ; la console n'envoie pas oauth_next", async () => {
    const app = banc({ [DEPART]: () => json({ url: "https://idp.example.test/a" }) });
    await app.sso.startSso("keycloak");
    expect(JSON.parse(String(app.appels[0]?.init?.body))).toEqual({ target: "app" });
    const q = "?oauth_next=" + encodeURIComponent("/oauth/authorize?client_id=x");
    const cons = banc(
      { [DEPART]: () => json({ url: "https://idp.example.test/a" }) },
      q,
      undefined,
      "/",
      true,
    );
    await cons.sso.startSso("keycloak");
    expect(JSON.parse(String(cons.appels[0]?.init?.body))).toEqual({ target: "console" });
  });
});

describe("preuve du titulaire", () => {
  const LIEN = "/api/auth/oidc/link-proof";

  it("en attente : lit le nom de compte, nettoie l'URL", async () => {
    const b = banc({ ["GET " + LIEN]: () => json({ pending: true, username: "alice" }) }, "?auth_link=1");
    await b.sso.lireRetour();
    expect(b.sso.preuveUsername.value).toBe("alice");
    expect(b.remplacerUrl).toHaveBeenCalledWith("/");
  });

  it("pas de demande en attente : message d'expiration", async () => {
    const attendu = "Cette demande a expiré. Reconnectez-vous par le service de votre organisation.";
    const a = banc({ ["GET " + LIEN]: () => json({ pending: false, username: null }) }, "?auth_link=1");
    await a.sso.lireRetour();
    expect(a.sso.preuveUsername.value).toBeNull();
    expect(a.sso.authRetour.value?.message).toBe(attendu);
  });

  it("sans auth_link, aucun appel", async () => {
    const b = banc({}, "");
    await b.sso.lireRetour();
    expect(b.appels).toEqual([]);
  });

  async function enPreuve(reponse: () => Response) {
    const b = banc(
      { ["GET " + LIEN]: () => json({ pending: true, username: "alice" }), ["POST " + LIEN]: reponse },
      "?auth_link=1",
    );
    await b.sso.lireRetour();
    b.sso.preuveMotDePasse.value = "secret-Elpis-1";
    await b.sso.envoyerPreuve();
    return b;
  }

  it("succès : le mot de passe ne part qu'à la route de preuve, est effacé, la page navigue vers la suite rendue", async () => {
    const b = await enPreuve(() => json({ ok: true, next: "/?oauth_next=%2Foauth%2Fauthorize%3Fa%3D1" }));
    const posts = b.appels.filter((a) => a.init?.method === "POST");
    expect(posts.map((a) => a.url)).toEqual([LIEN]);
    expect(JSON.parse(String(posts[0]?.init?.body))).toEqual({ password: "secret-Elpis-1" });
    expect(b.appels.filter((a) => String(a.init?.body ?? "").includes("secret-Elpis-1"))).toHaveLength(1);
    expect(b.sso.preuveMotDePasse.value).toBe("");
    expect(b.sso.preuveUsername.value).toBeNull();
    expect(b.naviguer).toHaveBeenCalledWith("/?oauth_next=%2Foauth%2Fauthorize%3Fa%3D1");
    expect(b.sso.preuveBusy.value).toBe(false);
  });

  it("la suite rendue n'est suivie que si c'est un chemin local ou une adresse https, sinon l'accueil", async () => {
    const cas: Array<[string, string]> = [
      ["/", "/"],
      ["https://console.example.test:8002/", "https://console.example.test:8002/"],
      ["//evil.example.test/", "/"],
      ["/\\evil.example.test/", "/"],
      ["http://console.example.test/", "/"],
      ["javascript:alert(1)", "/"],
      ["evil", "/"],
    ];
    for (const [next, cible] of cas) {
      const b = await enPreuve(() => json({ ok: true, next }));
      expect(b.naviguer).toHaveBeenCalledWith(cible);
    }
  });

  it("une réponse de succès sans suite est refusée sans navigation", async () => {
    const b = await enPreuve(() => json({ ok: true }));
    expect(b.naviguer).not.toHaveBeenCalled();
    expect(b.sso.preuveMotDePasse.value).toBe("");
  });

  it("401 : mot de passe incorrect, champ vidé, la carte reste", async () => {
    const b = await enPreuve(() => json({ detail: "x" }, 401));
    expect(b.sso.preuveError.value).toBe("Mot de passe incorrect.");
    expect(b.sso.preuveMotDePasse.value).toBe("");
    expect(b.sso.preuveUsername.value).toBe("alice");
    expect(b.naviguer).not.toHaveBeenCalled();
  });

  it("409 : demande plus valable, retour à l'écran de connexion ; 429 : message de débit", async () => {
    const e = await enPreuve(() => json({ detail: "x" }, 409));
    expect(e.sso.preuveUsername.value).toBeNull();
    expect(e.sso.authRetour.value?.message).toBe(
      "Cette demande n'est plus valable. Reconnectez-vous par le service de votre organisation ou demandez à votre administrateur.",
    );
    expect(e.naviguer).not.toHaveBeenCalled();
    const t = await enPreuve(() => json({ detail: "x" }, 429));
    expect(t.sso.preuveError.value).toBe("Trop de tentatives, réessayez dans un instant.");
    expect(t.sso.preuveMotDePasse.value).toBe("");
  });

  it("le mot de passe est effacé même quand le réseau échoue ; annuler efface tout", async () => {
    const b = banc({ ["GET " + LIEN]: () => json({ pending: true, username: "alice" }) }, "?auth_link=1");
    await b.sso.lireRetour();
    b.sso.preuveMotDePasse.value = "x-y-z";
    await b.sso.envoyerPreuve();
    expect(b.sso.preuveMotDePasse.value).toBe("");
    b.sso.annulerPreuve();
    expect(b.sso.preuveUsername.value).toBeNull();
  });
});

describe("déconnexion côté fournisseur", () => {
  function monterSortie(logout: () => Response | Promise<Response>, admin = false) {
    const session = new GestionnaireSession();
    const naviguer = vi.fn();
    const user = ref<UtilisateurAffiche | null>({
      id: 1,
      username: "alice",
      role: "user",
      is_admin: 0,
    } as never);
    const auth = setupAuth(
      {
        user,
        isAdminView: ref(false),
        messages: ref<unknown[]>([]),
        currentChatId: ref<unknown>(null),
        isStreaming: ref(false),
      },
      { showToast: () => undefined, fetchAuth: () => Promise.resolve(null) },
      {
        session,
        http: new ClientHttp(session, (u) =>
          u === "/api/logout-lite" ? Promise.resolve(logout()) : Promise.resolve(json({}, 404)),
        ),
        fenetre: { location: { href: "/" }, __ADMIN_ONLY_MODE__: admin },
        envSso: {
          origine: () => "https://e.test",
          chemin: () => "/",
          recherche: () => "",
          naviguer,
          remplacerUrl: vi.fn(),
        },
      },
    );
    return { auth, naviguer, user };
  }

  it("avec une adresse https : l'état local est vidé puis le navigateur y va", async () => {
    const m = monterSortie(() => json({ ok: true, logout_url: "https://idp.example.test/logout" }));
    await m.auth.logout();
    expect(m.user.value).toBeNull();
    expect(m.naviguer).toHaveBeenCalledWith("https://idp.example.test/logout");
  });

  it("sans adresse, ou adresse non https : aucune navigation, déconnexion locale faite", async () => {
    for (const corps of [
      { ok: true },
      { ok: true, logout_url: "http://idp.example.test/x" },
      { ok: true, logout_url: "//idp/x" },
      { ok: true, logout_url: "javascript:alert(1)" },
    ]) {
      const m = monterSortie(() => json(corps));
      await m.auth.logout();
      expect(m.user.value).toBeNull();
      expect(m.naviguer).not.toHaveBeenCalled();
    }
  });

  it("une navigation qui échoue ne défait pas la déconnexion locale", async () => {
    const m = monterSortie(() => json({ ok: true, logout_url: "https://idp.example.test/logout" }));
    m.naviguer.mockImplementation(() => {
      throw new Error("refusée");
    });
    await expect(m.auth.logout()).resolves.toBeUndefined();
    expect(m.user.value).toBeNull();
  });

  it("serveur injoignable : on reste connecté et on ne navigue pas", async () => {
    const m = monterSortie(() => Promise.reject(new TypeError("Failed to fetch")) as never);
    await m.auth.logout();
    expect(m.user.value).not.toBeNull();
    expect(m.naviguer).not.toHaveBeenCalled();
  });
});

describe("intégration dans setupAuth", () => {
  function monter(fetch: (u: string) => Promise<Response>) {
    const session = new GestionnaireSession();
    const env: EnvSso = {
      origine: () => "https://e.test",
      chemin: () => "/",
      recherche: () => "",
      naviguer: vi.fn(),
      remplacerUrl: vi.fn(),
    };
    return setupAuth(
      {
        user: ref<UtilisateurAffiche | null>(null),
        isAdminView: ref(false),
        messages: ref<unknown[]>([]),
        currentChatId: ref<unknown>(null),
        isStreaming: ref(false),
      },
      { showToast: () => undefined, fetchAuth: () => Promise.resolve(null) },
      { session, http: new ClientHttp(session, fetch), fenetre: { location: { href: "/" } }, envSso: env },
    );
  }

  it("sans méthode externe : aucune requête de plus que la configuration publique", async () => {
    const appels: string[] = [];
    const auth = monter((u) => {
      appels.push(u);
      return Promise.resolve(json({ login_methods: [] }));
    });
    await auth.loadPublicConfig();
    await vider();
    expect(appels).toEqual(["/api/public-config"]);
    expect(auth.loginMethods.value).toEqual([]);
  });

  it("la configuration publique alimente les méthodes et l'origine ; une forme invalide est ignorée", async () => {
    const auth = monter(() =>
      Promise.resolve(
        json({ login_methods: [{ id: "k", label: "Keycloak" }], auth_origin: "https://e.test" }),
      ),
    );
    await auth.loadPublicConfig();
    expect(auth.loginMethods.value).toEqual([{ id: "k", label: "Keycloak" }]);
    expect(auth.authOrigin.value).toBe("https://e.test");
    const mauvais = monter(() => Promise.resolve(json({ login_methods: "oups", auth_origin: 3 })));
    await mauvais.loadPublicConfig();
    expect(mauvais.loginMethods.value).toEqual([]);
  });
});
