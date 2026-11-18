// SPDX-License-Identifier: MIT
/** frontend/test/admin/connexion-entreprise.test.ts — console › Connexion d'entreprise : page vide, création LDAP et OIDC, secret en écriture seule, préréglage sans écrasement, Activer grisé, erreurs du serveur, champs figés, confirmations. */
import * as Vue from "vue";
import { createApp, defineComponent, h, reactive, ref } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

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
const OIDC = {
  ...COMMUN,
  type: "oidc" as const,
  id: "sso",
  label: "SSO siège",
  issuer: "https://sso.example.lan/realms/x",
  client_id: "elpis",
  client_auth: "basic" as const,
  scopes: ["openid", "profile", "email"],
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

type Reponse = Response | (() => Response);
let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
  reinitialiserSuiviChargement();
});

function monter(initial: unknown = etat()) {
  const appels: string[] = [];
  const corps: Record<string, unknown[]> = {};
  const reponses: Record<string, Reponse[]> = {};
  const confirmations: string[] = [];
  const mots: string[] = [];
  let accepter = true;
  const fetchFaux = (url: string, init?: RequestInit): Promise<Response> => {
    const cle = (init?.method ?? "GET") + " " + url;
    appels.push(cle);
    if (init?.body) (corps[cle] ??= []).push(JSON.parse(String(init.body)));
    const file = reponses[cle];
    const r = file && file.length > 1 ? file.shift() : file?.[0];
    if (r) return Promise.resolve(typeof r === "function" ? r() : r);
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
    openConfirm: (titre) => {
      confirmations.push(titre);
      return Promise.resolve(accepter);
    },
    openTypedConfirm: (_t, _x, mot) => {
      mots.push(mot);
      return Promise.resolve(accepter);
    },
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
    confirmations,
    mots,
    refuser: () => {
      accepter = false;
    },
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
  c.dispatchEvent(new Event(c.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  await vider();
}
async function ouvrir(m: ReturnType<typeof monter>): Promise<void> {
  await m.A.loadEnterpriseAuth();
  await vider();
}

describe("Connexion d'entreprise : page vide", () => {
  it("dit « Connexion locale seule » et liste les prérequis", async () => {
    const m = monter(
      etat({ prerequisites: { public_url_https: false, cookie_secure: false, local_admins: 0 } }),
    );
    expect(m.hote.querySelector('[aria-busy="true"]')).not.toBeNull();
    await ouvrir(m);
    const t = m.hote.textContent ?? "";
    expect(t).toContain("Connexion locale seule");
    expect(t).toContain("Rien ne change tant qu'aucun fournisseur n'est activé");
    expect(t).toContain("✗ Adresse publique en https");
    expect(t).toContain("Activez l'accès HTTPS, puis redémarrez.");
    expect(t).toContain("Aucun fournisseur déclaré.");
  });

  it("« Administrateurs seulement » demande une confirmation avant l'écriture", async () => {
    const m = monter();
    await ouvrir(m);
    m.A.authMode.value = "admins";
    m.refuser();
    await m.A.authEnregistrerReglages();
    expect(m.confirmations).toHaveLength(1);
    expect(m.appels.some((a) => a.startsWith("PUT"))).toBe(false);
  });

  it("enregistre l'adresse publique et recharge l'état de la réponse", async () => {
    const m = monter();
    m.reponses["PUT /api/admin/auth/settings"] = [json(etat({ public_url: "https://autre.example.lan" }))];
    await ouvrir(m);
    await saisir("ent-url", "https://autre.example.lan");
    await clic("ent-enregistrer");
    expect(m.corps["PUT /api/admin/auth/settings"]).toEqual([{ public_url: "https://autre.example.lan" }]);
    expect(m.A.authEtat.value?.public_url).toBe("https://autre.example.lan");
    expect(m.A.authReglagesModifies.value).toBe(false);
  });
});

describe("Connexion d'entreprise : création", () => {
  it("annuaire LDAP : corps à plat, puis secret rangé à part et jamais affiché", async () => {
    const m = monter();
    m.reponses["POST /api/admin/auth/providers"] = [
      json(etat({ providers: [{ ...LDAP, has_secret: false }] })),
    ];
    m.reponses["PUT /api/admin/auth/providers/ipa/secret"] = [json(etat({ providers: [LDAP] }))];
    await ouvrir(m);
    await clic("ent-ajouter");
    await clic("ent-ajouter-ldap");
    await saisir("ent-id", "ipa");
    await saisir("ent-label", "Annuaire siège");
    await saisir("ent-urls", "ldaps://ipa.example.lan");
    await saisir("ent-bind", "uid=elpis,cn=users");
    await saisir("ent-base", "cn=users,dc=example");
    await saisir("ent-filtre", "(uid={username})");
    await saisir("ent-secret", "s3cr3t-valeur");
    expect(el<HTMLInputElement>("ent-secret")?.type).toBe("password");
    await clic("ent-enregistrer-fournisseur");
    const [creation] = m.corps["POST /api/admin/auth/providers"] ?? [];
    expect(creation).toMatchObject({
      id: "ipa",
      type: "ldap",
      label: "Annuaire siège",
      urls: ["ldaps://ipa.example.lan"],
      bind_dn: "uid=elpis,cn=users",
      user_base_dn: "cn=users,dc=example",
      user_filter: "(uid={username})",
    });
    expect(creation).not.toHaveProperty("enabled");
    expect(creation).not.toHaveProperty("secret");
    expect(m.corps["PUT /api/admin/auth/providers/ipa/secret"]).toEqual([{ secret: "s3cr3t-valeur" }]);
    expect(m.A.authTiroir.value).toBeNull();
    expect(document.body.innerHTML).not.toContain("s3cr3t-valeur");
    expect(m.hote.textContent).toContain("Annuaire siège");
  });

  it("SSO OpenID Connect : corps, adresses à déclarer et Copier", async () => {
    const m = monter();
    m.reponses["POST /api/admin/auth/providers"] = [json(etat({ providers: [OIDC] }))];
    await ouvrir(m);
    await clic("ent-ajouter");
    await clic("ent-ajouter-oidc");
    expect(el("ent-retour")).toBeNull();
    await saisir("ent-id", "sso");
    await saisir("ent-label", "SSO siège");
    await saisir("ent-issuer", "https://sso.example.lan/realms/x");
    await saisir("ent-client", "elpis");
    expect(el("ent-retour")?.textContent).toBe("https://elpis.example.lan/api/auth/oidc/sso/callback");
    expect(el("ent-deconnexion")?.textContent).toBe(
      "https://elpis.example.lan/api/auth/oidc/sso/backchannel-logout",
    );
    await clic("ent-enregistrer-fournisseur");
    const [creation] = m.corps["POST /api/admin/auth/providers"] ?? [];
    expect(creation).toMatchObject({
      id: "sso",
      type: "oidc",
      issuer: "https://sso.example.lan/realms/x",
      client_id: "elpis",
    });
    expect(m.appels).not.toContain("PUT /api/admin/auth/providers/sso/secret");
  });

  it("sans adresse publique, aucune adresse à déclarer", async () => {
    const m = monter(etat({ public_url: "" }));
    await ouvrir(m);
    await clic("ent-ajouter");
    await clic("ent-ajouter-oidc");
    await saisir("ent-id", "sso");
    expect(el("ent-retour")).toBeNull();
  });

  it("un champ obligatoire vide n'est pas envoyé", async () => {
    const m = monter();
    await ouvrir(m);
    await clic("ent-ajouter");
    await clic("ent-ajouter-ldap");
    await clic("ent-enregistrer-fournisseur");
    expect(m.appels.some((a) => a.startsWith("POST"))).toBe(false);
    expect(document.body.textContent).toContain("à renseigner");
  });

  it("le préréglage remplit les champs vides sans écraser une saisie", async () => {
    const m = monter();
    await ouvrir(m);
    await clic("ent-ajouter");
    await clic("ent-ajouter-ldap");
    await saisir("ent-filtre", "(&(uid={username})(memberOf=x))");
    await saisir("ent-preset", "freeipa");
    expect(m.A.authTiroir.value?.user_filter).toBe("(&(uid={username})(memberOf=x))");
    expect(m.A.authTiroir.value?.attr_id).toBe("ipaUniqueID");
    expect(m.A.authTiroir.value?.groups_mode).toBe("memberof");
    await saisir("ent-preset", "active-directory");
    expect(m.A.authTiroir.value?.attr_id).toBe("ipaUniqueID");
    expect(m.A.authTiroir.value?.user_filter).toBe("(&(uid={username})(memberOf=x))");
  });
});

describe("Connexion d'entreprise : fournisseur existant", () => {
  it("le secret enregistré n'est jamais réaffiché ni renvoyé à l'enregistrement", async () => {
    const m = monter(etat({ providers: [LDAP] }));
    m.reponses["PUT /api/admin/auth/providers/ipa"] = [json(etat({ providers: [LDAP] }))];
    await ouvrir(m);
    m.hote.querySelector<HTMLButtonElement>('button[aria-label="Modifier Annuaire siège"]')?.click();
    await vider();
    const champ = el<HTMLInputElement>("ent-secret");
    expect(champ?.value).toBe("");
    expect(champ?.placeholder).toBe("Inchangé");
    expect(el("ent-secret-etat")?.textContent).toContain("Enregistré");
    await clic("ent-enregistrer-fournisseur");
    expect(m.corps["PUT /api/admin/auth/providers/ipa"]?.[0]).not.toHaveProperty("secret");
    expect(m.appels).not.toContain("PUT /api/admin/auth/providers/ipa/secret");
    expect(m.corps["PUT /api/admin/auth/providers/ipa"]?.[0]).not.toHaveProperty("id");
    expect(m.corps["PUT /api/admin/auth/providers/ipa"]?.[0]).not.toHaveProperty("enabled");
  });

  it("Activer est grisé tant que le fournisseur n'est pas testé", async () => {
    const m = monter(etat({ providers: [LDAP] }));
    await ouvrir(m);
    m.A.authModifier("ipa");
    await vider();
    const b = el<HTMLButtonElement>("ent-activer");
    expect(b?.disabled).toBe(true);
    expect(b?.title).toBe("Testez d'abord ce fournisseur.");
    await clic("ent-activer");
    expect(m.appels.some((a) => a.includes("/enable"))).toBe(false);
  });

  it("le message d'un 409 du serveur est affiché tel quel", async () => {
    const m = monter(etat({ providers: [LDAP] }));
    m.reponses["PUT /api/admin/auth/providers/ipa"] = [
      json({ detail: "Ce réglage ne se modifie plus : des comptes sont rattachés à ce fournisseur." }, 409),
    ];
    await ouvrir(m);
    m.A.authModifier("ipa");
    await vider();
    await clic("ent-enregistrer-fournisseur");
    expect(document.body.textContent).toContain("des comptes sont rattachés à ce fournisseur");
    expect(el("ent-label")).not.toBeNull();
  });

  it("des comptes rattachés figent l'autorité et l'identifiant client avec leur raison", async () => {
    const m = monter(
      etat({
        providers: [
          { ...OIDC, identities: 3 },
          { ...LDAP, identities: 2 },
        ],
      }),
    );
    await ouvrir(m);
    m.A.authModifier("sso");
    await vider();
    const issuer = el<HTMLInputElement>("ent-issuer");
    expect(issuer?.disabled).toBe(true);
    expect(issuer?.title).toContain("des comptes sont rattachés");
    expect(el<HTMLInputElement>("ent-client")?.disabled).toBe(true);
    expect(el<HTMLInputElement>("ent-label")?.disabled).toBe(false);
    expect(el<HTMLInputElement>("ent-id")?.disabled).toBe(true);
    m.A.authFermer();
    await vider();
    m.A.authModifier("ipa");
    await vider();
    expect(m.A.authFige("attrs.id")).toContain("des comptes sont rattachés");
    expect(m.A.authFige("user_filter")).toBe("");
  });

  it("un fournisseur actif a tous ses réglages grisés et propose Désactiver", async () => {
    const m = monter(etat({ providers: [{ ...LDAP, enabled: true, active: true, tested: true }] }));
    await ouvrir(m);
    expect(m.hote.textContent).toContain("Connexion d'entreprise active");
    m.A.authModifier("ipa");
    await vider();
    expect(el<HTMLInputElement>("ent-label")?.disabled).toBe(true);
    expect(el("ent-activer")).toBeNull();
    expect(el("ent-desactiver")).not.toBeNull();
    expect(el<HTMLButtonElement>("ent-supprimer")?.disabled).toBe(true);
  });

  it("désactiver demande une confirmation qui dit que les sessions seront fermées", async () => {
    const m = monter(etat({ providers: [{ ...LDAP, enabled: true, active: true, tested: true }] }));
    m.reponses["POST /api/admin/auth/providers/ipa/disable"] = [json(etat({ providers: [LDAP] }))];
    await ouvrir(m);
    m.A.authModifier("ipa");
    await vider();
    m.refuser();
    await clic("ent-desactiver");
    expect(m.confirmations).toEqual(["Désactiver ce fournisseur"]);
    expect(m.appels).not.toContain("POST /api/admin/auth/providers/ipa/disable");
    expect(m.A.authFournisseur.value?.active).toBe(true);
  });

  it("désactiver confirmé envoie la demande et reprend l'état rendu", async () => {
    const m = monter(etat({ providers: [{ ...LDAP, enabled: true, active: true, tested: true }] }));
    m.reponses["POST /api/admin/auth/providers/ipa/disable"] = [json(etat({ providers: [LDAP] }))];
    await ouvrir(m);
    m.A.authModifier("ipa");
    await vider();
    await clic("ent-desactiver");
    expect(m.appels).toContain("POST /api/admin/auth/providers/ipa/disable");
    expect(m.A.authActifs.value).toHaveLength(0);
    expect(el("ent-activer")).not.toBeNull();
  });

  it("supprimer demande de taper l'identifiant, puis recharge", async () => {
    const m = monter(etat({ providers: [LDAP] }));
    m.reponses["DELETE /api/admin/auth/providers/ipa"] = [json({ ok: true })];
    m.reponses["GET /api/admin/auth"] = [json(etat({ providers: [LDAP] })), json(etat())];
    await ouvrir(m);
    m.A.authModifier("ipa");
    await vider();
    m.refuser();
    await clic("ent-supprimer");
    expect(m.mots).toEqual(["ipa"]);
    expect(m.appels).not.toContain("DELETE /api/admin/auth/providers/ipa");
  });

  it("un fournisseur illisible est listé, jamais actif, et seulement supprimable", async () => {
    const m = monter(
      etat({
        invalid_providers: [
          { id: "vieux", label: "Ancien", enabled: true },
          { id: null, label: null, enabled: false },
        ],
      }),
    );
    m.reponses["DELETE /api/admin/auth/providers/vieux"] = [json({ ok: true })];
    await ouvrir(m);
    expect(m.hote.textContent).toContain("Illisible");
    expect(m.hote.textContent).toContain("Connexion locale seule");
    const supprimer = [...m.hote.querySelectorAll("button")].filter((b) =>
      b.textContent?.includes("Supprimer"),
    );
    expect(supprimer).toHaveLength(1);
    supprimer[0]?.click();
    await vider();
    expect(m.mots).toEqual(["vieux"]);
    expect(m.appels).toContain("DELETE /api/admin/auth/providers/vieux");
  });
});
