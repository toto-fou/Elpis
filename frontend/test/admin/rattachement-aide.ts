// SPDX-License-Identifier: MIT
/** frontend/test/admin/rattachement-aide.ts — montage de la page Connexion d'entreprise (et du tiroir de rattachement) avec un faux serveur, pour les tests du balayage, de l'assistant et des rattachements préparés. */
import * as Vue from "vue";
import { createApp, defineComponent, h, reactive, ref } from "vue";
import type { App } from "vue";

import ModalesConsole from "../../src/components/admin/ModalesConsole.vue";
import PageComptes from "../../src/components/admin/PageComptes.vue";
import PageConnexionEntreprise from "../../src/components/admin/PageConnexionEntreprise.vue";
import { setupAdmin } from "../../src/features/admin/console";
import { CLE_ADMIN } from "../../src/features/admin/domaine";
import type { DomaineAdmin } from "../../src/features/admin/domaine";
import type { CtxAdmin, RefsAdmin } from "../../src/features/admin/types";
import { GestionnaireSession } from "../../src/features/auth/session";
import { ClientHttp } from "../../src/platform/http/client";
import { json, vider } from "../aides";

export const BORNES = {
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
  enabled: true,
  preset: "",
  ca_pem: "",
  required_groups: ["elpis"],
  roles: { enabled: false, admin_groups: [], moderator_groups: [] },
  group_map: { enabled: false, map: [] },
  freshness_days: 14,
  has_secret: true,
  tested: true,
  active: true,
  identities: 0,
};
export const LDAP = {
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
export const OIDC = {
  ...COMMUN,
  enabled: false,
  tested: false,
  active: false,
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

export function retenus(n: number, debut = 1) {
  return Array.from({ length: n }, (_, i) => ({
    user_id: debut + i,
    username: "compte" + (debut + i),
    reason: "entry_missing",
  }));
}

export function sweep(over: Record<string, unknown> = {}) {
  return {
    at: Math.floor(Date.now() / 1000) - 600,
    seen: 120,
    suspended: 2,
    reactivated: 1,
    unknown: 3,
    aborted: null,
    pending: 0,
    held: [],
    held_total: 0,
    observed: [],
    ok_at: null,
    ...over,
  };
}

export function etat(providers: unknown[], over: Record<string, unknown> = {}) {
  return {
    public_url: "https://elpis.example.lan",
    local: { mode: "all" },
    providers,
    invalid_providers: [],
    prerequisites: { public_url_https: true, cookie_secure: true, local_admins: 1 },
    bounds: BORNES,
    ...over,
  };
}

export function proposition(over: Record<string, unknown> = {}) {
  return {
    subject: "uid-1",
    dn: "uid=alice,cn=users,dc=example",
    ext_username: "alice",
    ext_name: "Alice Martin",
    ext_email: "alice@example.lan",
    state: "active",
    in_required_group: true,
    ...over,
  };
}

export function aMigrer(id: number, nom: string, role = "user", prop: unknown = null) {
  return { user_id: id, username: nom, role, last_login_at: null, suspended: false, proposal: prop };
}

export function compteConsole(id: number, nom: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    username: nom,
    is_admin: 0,
    created_at: 1,
    avatar: null,
    suspended_at: 0,
    suspended_by: null,
    group_names: "",
    group_ids: [],
    sandbox_quota_mb: 0,
    network_profile_id: "",
    forced_network_profile_id: "",
    sandbox_used_mb: 0,
    identity: null,
    has_local_password: true,
    llm_engine_keys: null,
    llm_can_manage_models: null,
    llm_effective_engine_keys: null,
    llm_engine_source: "default",
    llm_effective_can_manage_models: true,
    llm_manage_source: "default",
    ...extra,
  };
}

type Reponse = Response | (() => Response);
let app: App | null = null;
export function demonter(): void {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
}

export function monter(
  initial: unknown,
  opts: { page?: "enterprise-login" | "accounts"; utilisateurs?: unknown[]; accepter?: boolean } = {},
) {
  const appels: string[] = [];
  const corps: Record<string, unknown[]> = {};
  const reponses: Record<string, Reponse[]> = {};
  const confirmations: string[] = [];
  const mots: string[] = [];
  const textes: string[] = [];
  const toasts: string[] = [];
  const fetchFaux = (url: string, init?: RequestInit): Promise<Response> => {
    const cle = (init?.method ?? "GET") + " " + url.split("?")[0];
    appels.push((init?.method ?? "GET") + " " + url);
    if (init?.body) (corps[cle] ??= []).push(JSON.parse(String(init.body)));
    const file = reponses[cle];
    const r = file && file.length > 1 ? file.shift() : file?.[0];
    if (r) return Promise.resolve(typeof r === "function" ? r() : r.clone());
    if (cle === "GET /api/admin/auth") return Promise.resolve(json(initial));
    if (cle === "GET /api/admin/users-with-groups")
      return Promise.resolve(
        json({ users: opts.utilisateurs ?? [], groups: [], network_profiles: [], desktop_targets: [] }),
      );
    return Promise.resolve(json({}, 404));
  };
  const refs: RefsAdmin = {
    user: ref({ id: 1, username: "root", role: "admin", is_admin: 1 }),
    isAdminView: ref(true),
  };
  const ctx: CtxAdmin = {
    showToast: (m: string) => {
      toasts.push(m);
    },
    fetchAuth: (url, options) => fetchFaux(url, options),
    openConfirm: (titre) => {
      confirmations.push(titre);
      return Promise.resolve(opts.accepter ?? true);
    },
    openTypedConfirm: (_t, texte, mot) => {
      textes.push(texte);
      mots.push(mot);
      return Promise.resolve(opts.accepter ?? true);
    },
    openChoice: () => Promise.resolve("save"),
    nextTick: () => Vue.nextTick(),
    loadPublicConfig: () => undefined,
    systemAlert: ref(""),
  };
  const A = setupAdmin(Vue, refs, ctx, new ClientHttp(new GestionnaireSession(), fetchFaux));
  A.adminTab.value = opts.page ?? "enterprise-login";
  const adm = reactive({ ...A, user: { id: 1, username: "root" } }) as unknown as DomaineAdmin;
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp(
    defineComponent({
      setup: () => () =>
        h("div", [h(opts.page === "accounts" ? PageComptes : PageConnexionEntreprise), h(ModalesConsole)]),
    }),
  );
  app.provide(CLE_ADMIN, adm);
  app.mount(hote);
  return { A, hote, appels, corps, reponses, confirmations, mots, textes, toasts };
}

export const el = <T extends HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
export const tous = <T extends HTMLElement>(sel: string): T[] => [...document.querySelectorAll<T>(sel)];
export async function clic(sel: string): Promise<void> {
  el(sel)?.click();
  await vider();
}
export async function saisir(sel: string, valeur: string): Promise<void> {
  const c = el<HTMLInputElement | HTMLSelectElement>(sel);
  if (!c) throw new Error("champ absent : " + sel);
  c.value = valeur;
  c.dispatchEvent(new Event(c.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  await vider();
}
export async function cocher(c: HTMLInputElement | null): Promise<void> {
  if (!c) throw new Error("case absente");
  c.click();
  await vider();
}
export { vider };
