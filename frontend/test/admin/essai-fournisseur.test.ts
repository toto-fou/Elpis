// SPDX-License-Identifier: MIT
/** frontend/test/admin/essai-fournisseur.test.ts — console › Connexion d'entreprise : étapes d'un test (niveaux, regroupement par cible, liste vide) et bouton Tester du tiroir (réglages non enregistrés sans secret, effacement à la saisie, test incomplet, 429). */
import * as Vue from "vue";
import { createApp, defineComponent, h, reactive, ref } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import EtapesEssai from "../../src/components/admin/EtapesEssai.vue";
import PageConnexionEntreprise from "../../src/components/admin/PageConnexionEntreprise.vue";
import { setupAdmin } from "../../src/features/admin/console";
import { CLE_ADMIN } from "../../src/features/admin/domaine";
import type { DomaineAdmin } from "../../src/features/admin/domaine";
import { reinitialiserSuiviChargement } from "../../src/features/admin/suivi-chargement";
import type { CtxAdmin, RefsAdmin } from "../../src/features/admin/types";
import { GestionnaireSession } from "../../src/features/auth/session";
import { ClientHttp } from "../../src/platform/http/client";
import { json, vider } from "../aides";

const BORNES = {
  providers_max: 10,
  label_max: 40,
  ca_pem_max: 65536,
  required_groups_max: 20,
  ldap_urls_max: 3,
  secret_max: 16384,
  freshness_days: { min: 1, max: 90, default: 14 },
  max_failures: { min: 1, max: 20, default: 4 },
  failure_window_sec: { min: 60, max: 86400, default: 900 },
  timeout_sec: { min: 2, max: 30, default: 10 },
  clock_skew_sec: { min: 0, max: 300, default: 60 },
};

const COMMUN = {
  enabled: false,
  preset: "",
  ca_pem: "",
  required_groups: ["elpis"],
  roles: { enabled: false, admin_groups: [], moderator_groups: [] },
  group_map: { enabled: false, map: [] },
  freshness_days: 14,
  has_secret: true,
  tested: false,
  active: false,
  identities: 0,
};
const LDAP = {
  ...COMMUN,
  type: "ldap" as const,
  id: "ipa",
  label: "Annuaire siège",
  urls: ["ldaps://ipa.example.lan"],
  bind_dn: "uid=elpis,cn=users",
  user_base_dn: "cn=users,dc=example",
  user_filter: "(uid={username})",
  attrs: { id: "ipaUniqueID", username: "uid", email: "mail", name: "displayName" },
  groups: { mode: "memberof" as const },
  max_failures: 4,
  failure_window_sec: 900,
  timeout_sec: 10,
};

function etat(over: Record<string, unknown> = {}) {
  return {
    public_url: "https://elpis.example.lan",
    local: { mode: "all" },
    providers: [],
    invalid_providers: [],
    prerequisites: { public_url_https: true, cookie_secure: true, local_admins: 1 },
    bounds: BORNES,
    ...over,
  };
}

const ETAPES = [
  { id: "settings", label: "Réglages", level: "ok", detail: "Réglages valides.", target: null },
  { id: "tcp", label: "Connexion", level: "warn", detail: "Réponse lente.", target: "ipa.example.lan:636" },
  {
    id: "tls",
    label: "Certificat",
    level: "fail",
    detail: "Certificat non reconnu.",
    target: "ipa.example.lan:636",
  },
] as const;
const TEST = "POST /api/admin/auth/providers/test";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
  reinitialiserSuiviChargement();
});

function monterEtapes(steps: unknown[]): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp(defineComponent({ setup: () => () => h(EtapesEssai, { steps: steps as never }) }));
  app.mount(hote);
  return hote;
}

type Reponse = Response | (() => Promise<Response>);
function monter(initial: unknown = etat()) {
  const appels: string[] = [];
  const corps: Record<string, unknown[]> = {};
  const reponses: Record<string, Reponse[]> = {};
  const fetchFaux = (url: string, init?: RequestInit): Promise<Response> => {
    const cle = (init?.method ?? "GET") + " " + url;
    appels.push(cle);
    if (init?.body) (corps[cle] ??= []).push(JSON.parse(String(init.body)));
    const file = reponses[cle];
    const r = file && file.length > 1 ? file.shift() : file?.[0];
    if (r) return typeof r === "function" ? r() : Promise.resolve(r);
    if (cle === "GET /api/admin/auth") return Promise.resolve(json(initial));
    return Promise.resolve(json({}, 404));
  };
  const refs: RefsAdmin = {
    user: ref({ id: 1, username: "root", role: "admin", is_admin: 1 }),
    isAdminView: ref(true),
  };
  const ctx: CtxAdmin = {
    showToast: () => undefined,
    fetchAuth: (url, options) => fetchFaux(url, options),
    openConfirm: () => Promise.resolve(true),
    openTypedConfirm: () => Promise.resolve(true),
    openChoice: () => Promise.resolve("save"),
    nextTick: () => Vue.nextTick(),
    loadPublicConfig: () => undefined,
    systemAlert: ref(""),
  };
  const A = setupAdmin(Vue, refs, ctx, new ClientHttp(new GestionnaireSession(), fetchFaux));
  A.adminTab.value = "enterprise-login";
  const adm = reactive({ ...A }) as unknown as DomaineAdmin;
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp(defineComponent({ setup: () => () => h(PageConnexionEntreprise) }));
  app.provide(CLE_ADMIN, adm);
  app.mount(hote);
  return {
    A,
    hote,
    appels,
    corps,
    reponses,
  };
}

const el = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
const clic = async (id: string): Promise<void> => {
  el(id)?.click();
  await vider();
};
async function saisir(id: string, valeur: string): Promise<void> {
  const c = el<HTMLInputElement>(id);
  if (!c) throw new Error("champ absent : " + id);
  c.value = valeur;
  c.dispatchEvent(new Event("input", { bubbles: true }));
  await vider();
}
async function ouvrirTiroir(m: ReturnType<typeof monter>): Promise<void> {
  await m.A.loadEnterpriseAuth();
  m.A.authModifier("ipa");
  await vider();
}

describe("EtapesEssai", () => {
  it("rend les trois niveaux avec leur pictogramme et leur phrase", () => {
    const hote = monterEtapes([ETAPES[0], { ...ETAPES[1], target: null }, { ...ETAPES[2], target: null }]);
    const niveaux = [...hote.querySelectorAll("[data-etape]")].map((n) => n.getAttribute("data-niveau"));
    expect(niveaux).toEqual(["ok", "warn", "fail"]);
    const texte = hote.textContent ?? "";
    expect(texte).toContain("✓");
    expect(texte).toContain("⚠");
    expect(texte).toContain("✗");
    expect(texte).toContain("Certificat non reconnu.");
    expect(hote.querySelector('[data-niveau="fail"]')?.className).toContain("text-red-600");
    expect(hote.querySelector('[data-niveau="ok"]')?.className).not.toMatch(/red|amber|emerald/u);
    expect(hote.querySelector("[data-etapes-essai]")?.getAttribute("aria-live")).toBe("polite");
  });

  it("une seule cible : affichée discrètement sur chaque ligne, sans regroupement", () => {
    const hote = monterEtapes([ETAPES[0], ETAPES[1], ETAPES[2]]);
    expect(hote.querySelectorAll("[data-cible-groupe]")).toHaveLength(0);
    expect(hote.textContent).toContain("ipa.example.lan:636");
  });

  it("plusieurs cibles : les étapes d'une même cible sont regroupées sous elle", () => {
    const hote = monterEtapes([
      ETAPES[0],
      { id: "a1", label: "Connexion", level: "ok", detail: "ok", target: "a.example.lan:636" },
      { id: "b1", label: "Connexion", level: "fail", detail: "refusée", target: "b.example.lan:636" },
      { id: "a2", label: "Certificat", level: "ok", detail: "ok", target: "a.example.lan:636" },
    ]);
    const cibles = [...hote.querySelectorAll("[data-cible-groupe]")].map((n) => n.textContent?.trim());
    expect(cibles).toEqual(["a.example.lan:636", "b.example.lan:636"]);
    const groupeA = hote.querySelectorAll("[data-groupe-essai]")[1];
    expect(groupeA?.querySelectorAll("[data-etape]")).toHaveLength(2);
  });

  it("liste vide : une phrase, aucune ligne", () => {
    const hote = monterEtapes([]);
    expect(hote.querySelector("[data-etapes-vide]")).not.toBeNull();
    expect(hote.querySelectorAll("[data-etape]")).toHaveLength(0);
  });
});

describe("Connexion d'entreprise : bouton Tester", () => {
  it("envoie les réglages du formulaire non enregistrés, le secret saisi seulement dans la clé secret", async () => {
    const m = monter(etat({ providers: [LDAP] }));
    m.reponses[TEST] = [json({ ok: true, complete: false, steps: [ETAPES[0]] })];
    await ouvrirTiroir(m);
    await saisir("ent-label", "Annuaire modifié");
    await saisir("ent-secret", "jamais-envoye");
    await clic("ent-tester");
    expect(m.appels.filter((a) => a === TEST)).toHaveLength(1);
    expect(m.appels.some((a) => a.startsWith("PUT "))).toBe(false);
    const corps = m.corps[TEST]?.[0] as Record<string, unknown>;
    expect(corps["label"]).toBe("Annuaire modifié");
    expect(corps["type"]).toBe("ldap");
    expect(corps["id"]).toBe("ipa");
    expect(corps["urls"]).toEqual(["ldaps://ipa.example.lan"]);
    expect(corps["secret"]).toBe("jamais-envoye");
    expect(JSON.stringify({ ...corps, secret: undefined })).not.toContain("jamais-envoye");
  });

  it("test réussi : synthèse verte ; la phrase d'incomplétude ne concerne que le SSO", async () => {
    const m = monter(etat({ providers: [LDAP] }));
    m.reponses[TEST] = [json({ ok: true, complete: false, steps: [ETAPES[0]] })];
    await ouvrirTiroir(m);
    await clic("ent-tester");
    expect(el("ent-essai-synthese")?.textContent).toBe("Les contrôles réseau et de certificat passent.");
    expect(el("ent-essai-incomplet")).toBeNull();
    expect(document.querySelectorAll("[data-etape]")).toHaveLength(1);
    expect(el<HTMLButtonElement>("ent-activer")?.disabled).toBe(true);
  });

  it("un SSO : aucun utilisateur d'essai ni secret envoyés, phrase d'incomplétude gardée", async () => {
    const OIDC = {
      ...COMMUN,
      type: "oidc" as const,
      id: "sso",
      label: "SSO",
      issuer: "https://idp.example.lan",
      client_id: "elpis",
      client_auth: "basic",
      scopes: ["openid"],
      subject_claim: "sub",
      username_claim: "preferred_username",
      email_claim: "email",
      name_claim: "name",
      groups_claim: "groups",
      required_acr: [],
      required_amr: [],
      max_age_sec: 0,
      clock_skew_sec: 60,
      session_max_age_sec: 0,
      logout: { rp_initiated: false, backchannel: false },
    };
    const m = monter(etat({ providers: [OIDC] }));
    m.reponses[TEST] = [json({ ok: true, complete: false, steps: [ETAPES[0]] })];
    await m.A.loadEnterpriseAuth();
    m.A.authModifier("sso");
    await vider();
    expect(el("ent-test-user")).toBeNull();
    await saisir("ent-secret", "secret-sso");
    await clic("ent-tester");
    const corps = m.corps[TEST]?.[0] as Record<string, unknown>;
    expect(corps).not.toHaveProperty("secret");
    expect(corps).not.toHaveProperty("test_user");
    expect(JSON.stringify(corps)).not.toContain("secret-sso");
    expect(el("ent-essai-incomplet")).not.toBeNull();
  });

  it("un test raté reste affiché avec « Un contrôle a échoué. »", async () => {
    const m = monter(etat({ providers: [LDAP] }));
    m.reponses[TEST] = [json({ ok: false, complete: false, steps: ETAPES })];
    await ouvrirTiroir(m);
    await clic("ent-tester");
    expect(el("ent-essai-synthese")?.textContent).toBe("Un contrôle a échoué.");
    expect(document.querySelectorAll("[data-etape]")).toHaveLength(3);
  });

  it("un simple avertissement n'est pas annoncé comme un échec", async () => {
    const m = monter(etat({ providers: [LDAP] }));
    const avert = [
      { id: "tls", label: "Certificat", level: "warn", detail: "Échéance dans 12 jours.", target: null },
    ];
    m.reponses[TEST] = [json({ ok: true, complete: false, steps: avert })];
    await ouvrirTiroir(m);
    await clic("ent-tester");
    expect(el("ent-essai-synthese")?.textContent).toBe(
      "Les contrôles passent, avec des avertissements à lire.",
    );
  });

  it("complete vrai : plus de mention d'incomplétude", async () => {
    const m = monter(etat({ providers: [LDAP] }));
    m.reponses[TEST] = [json({ ok: true, complete: true, steps: [ETAPES[0]] })];
    await ouvrirTiroir(m);
    await clic("ent-tester");
    expect(el("ent-essai-synthese")).not.toBeNull();
    expect(el("ent-essai-incomplet")).toBeNull();
  });

  it("l'utilisateur d'essai part dans test_user, avec sa phrase d'aide, sans être enregistré", async () => {
    const m = monter(etat({ providers: [LDAP] }));
    m.reponses[TEST] = [json({ ok: true, complete: false, steps: [ETAPES[0]] })];
    await ouvrirTiroir(m);
    expect(el("ent-test-user")?.closest("label")?.textContent).toContain(
      "Un compte de l'annuaire qui doit pouvoir se connecter. Il est seulement cherché, son mot de passe n'est jamais demandé.",
    );
    await saisir("ent-test-user", " alice ");
    await clic("ent-tester");
    expect((m.corps[TEST]?.[0] as Record<string, unknown>)["test_user"]).toBe("alice");
    await clic("ent-enregistrer-fournisseur");
    const ecritures = m.appels.filter(
      (a) => a.startsWith("PUT ") || a.startsWith("POST /api/admin/auth/providers"),
    );
    expect(ecritures.every((a) => a === TEST || a.startsWith("PUT "))).toBe(true);
    for (const cle of Object.keys(m.corps))
      if (cle !== TEST) expect(JSON.stringify(m.corps[cle])).not.toContain("alice");
  });

  it("rien saisi : ni secret ni test_user dans la requête", async () => {
    const m = monter(etat({ providers: [LDAP] }));
    m.reponses[TEST] = [json({ ok: true, complete: false, steps: [ETAPES[0]] })];
    await ouvrirTiroir(m);
    await clic("ent-tester");
    const corps = m.corps[TEST]?.[0] as Record<string, unknown>;
    expect(corps).not.toHaveProperty("secret");
    expect(corps).not.toHaveProperty("test_user");
  });

  it("le secret saisi ne part que dans la requête de test, n'est ni affiché ni gardé, et disparaît avec le tiroir", async () => {
    const SECRET = "S3cret-d-essai-unique";
    const journal: string[] = [];
    const espions = (["log", "info", "warn", "error", "debug"] as const).map((n) =>
      vi
        .spyOn(console, n)
        .mockImplementation((...a: unknown[]) => void journal.push(a.map(String).join(" "))),
    );
    try {
      const m = monter(etat({ providers: [LDAP] }));
      m.reponses[TEST] = [json({ ok: true, complete: false, steps: [ETAPES[0]] })];
      await ouvrirTiroir(m);
      await saisir("ent-secret", SECRET);
      await clic("ent-tester");
      const corps = m.corps[TEST]?.[0] as Record<string, unknown>;
      expect(corps["secret"]).toBe(SECRET);
      for (const cle of Object.keys(m.corps))
        if (cle !== TEST) expect(JSON.stringify(m.corps[cle])).not.toContain(SECRET);
      expect(m.appels.some((a) => a.includes(SECRET))).toBe(false);
      expect(JSON.stringify(m.A.authEssai.value)).not.toContain(SECRET);
      expect(JSON.stringify(m.A.authEtat.value)).not.toContain(SECRET);
      expect(document.body.textContent).not.toContain(SECRET);
      expect(el<HTMLInputElement>("ent-secret")?.type).toBe("password");
      m.A.authFermer();
      await vider();
      expect(m.A.authTiroir.value).toBeNull();
      expect(JSON.stringify(m.A.authEssai.value)).not.toContain(SECRET);
      m.A.authModifier("ipa");
      await vider();
      expect(el<HTMLInputElement>("ent-secret")?.value).toBe("");
      expect(JSON.stringify(m.A.authTiroir.value)).not.toContain(SECRET);
      expect(document.body.innerHTML).not.toContain(SECRET);
      expect(window.location.href).not.toContain(SECRET);
      expect(JSON.stringify({ ...window.localStorage })).not.toContain(SECRET);
      expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(SECRET);
      expect(journal.join("\n")).not.toContain(SECRET);
    } finally {
      espions.forEach((x) => x.mockRestore());
    }
  });

  it("test complet : synthèse, rechargement de l'état et bouton Activer dégrisé", async () => {
    const m = monter(etat({ providers: [LDAP] }));
    m.reponses["GET /api/admin/auth"] = [
      json(etat({ providers: [LDAP] })),
      json(etat({ providers: [{ ...LDAP, tested: true }] })),
    ];
    m.reponses[TEST] = [json({ ok: true, complete: true, steps: [ETAPES[0]] })];
    await ouvrirTiroir(m);
    expect(el<HTMLButtonElement>("ent-activer")?.disabled).toBe(true);
    await saisir("ent-test-user", "alice");
    await clic("ent-tester");
    expect(el("ent-essai-synthese")?.textContent).toBe("Test complet : vous pouvez activer ce fournisseur.");
    expect(m.appels.filter((a) => a === "GET /api/admin/auth")).toHaveLength(2);
    expect(el<HTMLButtonElement>("ent-activer")?.disabled).toBe(false);
    expect(el("ent-essai-enregistrer")).toBeNull();
  });

  it("un test incomplet ne recharge pas l'état", async () => {
    const m = monter(etat({ providers: [LDAP] }));
    m.reponses[TEST] = [json({ ok: true, complete: false, steps: [ETAPES[0]] })];
    await ouvrirTiroir(m);
    await clic("ent-tester");
    expect(m.appels.filter((a) => a === "GET /api/admin/auth")).toHaveLength(1);
  });

  it("test complet de réglages non enregistrés : « Enregistrez ces réglages pour pouvoir activer. »", async () => {
    const m = monter(etat({ providers: [LDAP] }));
    m.reponses[TEST] = [json({ ok: true, complete: true, steps: [ETAPES[0]] })];
    await ouvrirTiroir(m);
    await saisir("ent-label", "Annuaire modifié");
    await clic("ent-tester");
    expect(el("ent-essai-enregistrer")?.textContent?.trim()).toBe(
      "Enregistrez ces réglages pour pouvoir activer.",
    );
  });

  it("pendant le test : bouton grisé avec indicateur d'attente, un seul envoi", async () => {
    const m = monter(etat({ providers: [LDAP] }));
    let fin: (r: Response) => void = () => undefined;
    m.reponses[TEST] = [() => new Promise<Response>((r) => (fin = r))];
    await ouvrirTiroir(m);
    await clic("ent-tester");
    const b = el<HTMLButtonElement>("ent-tester");
    expect(b?.disabled).toBe(true);
    expect(b?.textContent).toContain("Test en cours");
    expect(b?.querySelector(".animate-spin")).not.toBeNull();
    await clic("ent-tester");
    expect(m.appels.filter((a) => a === TEST)).toHaveLength(1);
    fin(json({ ok: true, complete: false, steps: [ETAPES[0]] }));
    await vider();
    expect(el<HTMLButtonElement>("ent-tester")?.disabled).toBe(false);
    expect(el("ent-essai-synthese")).not.toBeNull();
  });

  it("le résultat s'efface dès qu'un champ change", async () => {
    const m = monter(etat({ providers: [LDAP] }));
    m.reponses[TEST] = [json({ ok: true, complete: false, steps: [ETAPES[0]] })];
    await ouvrirTiroir(m);
    await clic("ent-tester");
    expect(el("ent-essai-synthese")).not.toBeNull();
    await saisir("ent-label", "Autre libellé");
    expect(el("ent-essai-synthese")).toBeNull();
    expect(document.querySelectorAll("[data-etape]")).toHaveLength(0);
  });

  it("une réponse arrivée après une modification du formulaire est ignorée", async () => {
    const m = monter(etat({ providers: [LDAP] }));
    let fin: (r: Response) => void = () => undefined;
    m.reponses[TEST] = [() => new Promise<Response>((r) => (fin = r))];
    await ouvrirTiroir(m);
    await clic("ent-tester");
    await saisir("ent-label", "Autre libellé");
    fin(json({ ok: true, complete: false, steps: [ETAPES[0]] }));
    await vider();
    expect(el("ent-essai-synthese")).toBeNull();
    expect(el<HTMLButtonElement>("ent-tester")?.disabled).toBe(false);
  });

  it("un 429 affiche le message du serveur", async () => {
    const m = monter(etat({ providers: [LDAP] }));
    const detail = "Deux tests sont déjà en cours, réessayez dans un instant.";
    m.reponses[TEST] = [json({ detail }, 429)];
    await ouvrirTiroir(m);
    await clic("ent-tester");
    expect(el("ent-essai-erreur")?.textContent?.trim()).toBe(detail);
    expect(el("ent-essai-synthese")).toBeNull();
  });

  it("la carte Fournisseurs ne dit plus que le test est indisponible", async () => {
    const m = monter(etat({ providers: [LDAP] }));
    await m.A.loadEnterpriseAuth();
    await vider();
    expect(m.hote.textContent).not.toContain("pas encore disponible");
  });
});
