// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/identite.ts — console › Utilisateurs & accès › Connexion d'entreprise : lecture et écritures des réglages `auth`, formulaire d'un fournisseur (LDAP, OIDC), secret, activation. */
import { schemaReglagesAuth, schemaReponseEssaiFournisseur } from "@elpis/contracts";
import type { FournisseurAuth, ReglagesAuthConsole, ReponseEssaiFournisseur } from "@elpis/contracts";
import type { Ref } from "vue";

import { gardeFocus as creerGardeFocus, piegerTab } from "../../utils/focus";
import { copierTexte } from "../../utils/dom";
import { corpsJson, detailErreur, lireSchema } from "../../utils/lecture-json";
import { confirmerParMot } from "./confirmation";
import type { BaseAdmin } from "./etat";
import { suivreChargement } from "./suivi-chargement";

const ENTETES_JSON = { "Content-Type": "application/json" };
const NOM_CHARGEUR = "loadEnterpriseAuth";
const BASE = "/api/admin/auth";

export type TypeFournisseur = "ldap" | "oidc";
export type ModeLocal = "all" | "admins";

export interface PresetLdap {
  id: string;
  label: string;
  filtre: string;
  attrs: { id: string; username: string; email: string; name: string };
  groupes: string;
}

export const PRESETS_LDAP: readonly PresetLdap[] = [
  {
    id: "freeipa",
    label: "FreeIPA",
    filtre: "(&(objectClass=person)(uid={username}))",
    attrs: { id: "ipaUniqueID", username: "uid", email: "mail", name: "displayName" },
    groupes: "memberof",
  },
  {
    id: "active-directory",
    label: "Active Directory",
    filtre: "(&(objectCategory=person)(objectClass=user)(sAMAccountName={username}))",
    attrs: { id: "objectGUID", username: "sAMAccountName", email: "mail", name: "displayName" },
    groupes: "chain",
  },
  {
    id: "openldap",
    label: "OpenLDAP",
    filtre: "(&(objectClass=inetOrgPerson)(uid={username}))",
    attrs: { id: "entryUUID", username: "uid", email: "mail", name: "cn" },
    groupes: "member",
  },
  {
    id: "other",
    label: "Autre",
    filtre: "",
    attrs: { id: "", username: "", email: "", name: "" },
    groupes: "",
  },
];

/** Formulaire d'un fournisseur : tout en texte, converti à l'envoi ; le secret n'y vit que le temps de la saisie. */
export interface FormFournisseur {
  nouveau: boolean;
  type: TypeFournisseur;
  id: string;
  label: string;
  preset: string;
  ca_pem: string;
  required_groups: string[];
  groupe_saisi: string;
  freshness_days: string;
  secret: string;
  urls: string;
  bind_dn: string;
  user_base_dn: string;
  user_filter: string;
  attr_id: string;
  attr_username: string;
  attr_email: string;
  attr_name: string;
  groups_mode: string;
  max_failures: string;
  failure_window_sec: string;
  timeout_sec: string;
  issuer: string;
  client_id: string;
  client_auth: string;
  scopes: string;
  subject_claim: string;
  username_claim: string;
  email_claim: string;
  name_claim: string;
  groups_claim: string;
  required_acr: string;
  required_amr: string;
  max_age_sec: string;
  clock_skew_sec: string;
  session_max_age_sec: string;
  rp_initiated: boolean;
  backchannel: boolean;
}

const chiffre = (n: number): string => String(n);
const lignes = (l: readonly string[]): string => l.join("\n");
const mots = (t: string): string[] => t.split(/[\s,]+/u).filter((x) => x !== "");

function formVide(type: TypeFournisseur): FormFournisseur {
  return {
    nouveau: true,
    type,
    id: "",
    label: "",
    preset: "",
    ca_pem: "",
    required_groups: [],
    groupe_saisi: "",
    freshness_days: "",
    secret: "",
    urls: "",
    bind_dn: "",
    user_base_dn: "",
    user_filter: "",
    attr_id: "",
    attr_username: "",
    attr_email: "",
    attr_name: "",
    groups_mode: "",
    max_failures: "",
    failure_window_sec: "",
    timeout_sec: "",
    issuer: "",
    client_id: "",
    client_auth: "",
    scopes: "",
    subject_claim: "",
    username_claim: "",
    email_claim: "",
    name_claim: "",
    groups_claim: "",
    required_acr: "",
    required_amr: "",
    max_age_sec: "",
    clock_skew_sec: "",
    session_max_age_sec: "",
    rp_initiated: false,
    backchannel: false,
  };
}

/** Formulaire rempli des réglages d'un fournisseur lu (jamais de secret). */
function formDe(f: FournisseurAuth): FormFournisseur {
  const base: FormFournisseur = {
    ...formVide(f.type),
    nouveau: false,
    id: f.id,
    label: f.label,
    preset: f.preset,
    ca_pem: f.ca_pem,
    required_groups: [...f.required_groups],
    freshness_days: chiffre(f.freshness_days),
  };
  if (f.type === "ldap")
    return {
      ...base,
      urls: lignes(f.urls),
      bind_dn: f.bind_dn,
      user_base_dn: f.user_base_dn,
      user_filter: f.user_filter,
      attr_id: f.attrs.id,
      attr_username: f.attrs.username,
      attr_email: f.attrs.email,
      attr_name: f.attrs.name,
      groups_mode: f.groups.mode,
      max_failures: chiffre(f.max_failures),
      failure_window_sec: chiffre(f.failure_window_sec),
      timeout_sec: chiffre(f.timeout_sec),
    };
  return {
    ...base,
    issuer: f.issuer,
    client_id: f.client_id,
    client_auth: f.client_auth,
    scopes: f.scopes.join(" "),
    subject_claim: f.subject_claim,
    username_claim: f.username_claim,
    email_claim: f.email_claim,
    name_claim: f.name_claim,
    groups_claim: f.groups_claim,
    required_acr: f.required_acr.join(" "),
    required_amr: f.required_amr.join(" "),
    max_age_sec: chiffre(f.max_age_sec),
    clock_skew_sec: chiffre(f.clock_skew_sec),
    session_max_age_sec: chiffre(f.session_max_age_sec),
    rp_initiated: f.logout.rp_initiated,
    backchannel: f.logout.backchannel,
  };
}

/** Entier saisi : `undefined` si vide, message d'erreur si ce n'est pas un entier. */
function entierSaisi(v: string, nom: string): number | undefined | string {
  const t = v.trim();
  if (t === "") return undefined;
  return /^\d{1,9}$/u.test(t) ? Number(t) : `Champ « ${nom} » : nombre entier attendu.`;
}

const REQUIS: Record<TypeFournisseur, readonly (readonly [keyof FormFournisseur, string])[]> = {
  ldap: [
    ["id", "Identifiant"],
    ["label", "Libellé"],
    ["urls", "Adresses"],
    ["bind_dn", "Compte de service"],
    ["user_base_dn", "Base des comptes"],
    ["user_filter", "Filtre"],
  ],
  oidc: [
    ["id", "Identifiant"],
    ["label", "Libellé"],
    ["issuer", "Autorité"],
    ["client_id", "Identifiant client"],
  ],
};

/** Corps de création ou de modification d'un fournisseur ; une chaîne seule est un message d'erreur de saisie. */
export function corpsFournisseur(f: FormFournisseur, urlsMax: number): Record<string, unknown> | string {
  if (f.nouveau)
    for (const [cle, nom] of REQUIS[f.type])
      if (String(f[cle]).trim() === "") return `Champ « ${nom} » : à renseigner.`;
  const corps: Record<string, unknown> = {
    label: f.label.trim(),
    preset: f.preset,
    ca_pem: f.ca_pem,
    required_groups: f.required_groups,
  };
  if (f.nouveau) {
    corps["id"] = f.id.trim();
    corps["type"] = f.type;
  }
  const texte = (cle: string, v: string): void => {
    if (v.trim() !== "") corps[cle] = v.trim();
  };
  const nombres: [string, string, string][] = [["freshness_days", f.freshness_days, "Fraîcheur"]];
  if (f.type === "ldap") {
    const urls = f.urls
      .split("\n")
      .map((u) => u.trim())
      .filter((u) => u !== "");
    if (urls.length > urlsMax) return `Champ « Adresses » : ${urlsMax} au plus.`;
    if (urls.length > 0) corps["urls"] = urls;
    texte("bind_dn", f.bind_dn);
    texte("user_base_dn", f.user_base_dn);
    texte("user_filter", f.user_filter);
    const attrs: Record<string, string> = {};
    for (const [k, v] of [
      ["id", f.attr_id],
      ["username", f.attr_username],
      ["email", f.attr_email],
      ["name", f.attr_name],
    ] as const)
      if (v.trim() !== "") attrs[k] = v.trim();
    if (Object.keys(attrs).length > 0) corps["attrs"] = attrs;
    if (f.groups_mode !== "") corps["groups"] = { mode: f.groups_mode };
    nombres.push(
      ["max_failures", f.max_failures, "Essais"],
      ["failure_window_sec", f.failure_window_sec, "Fenêtre"],
      ["timeout_sec", f.timeout_sec, "Délai"],
    );
  } else {
    texte("issuer", f.issuer);
    texte("client_id", f.client_id);
    texte("client_auth", f.client_auth);
    for (const k of ["subject_claim", "username_claim", "email_claim", "name_claim", "groups_claim"] as const)
      texte(k, f[k]);
    if (mots(f.scopes).length > 0) corps["scopes"] = mots(f.scopes);
    corps["required_acr"] = mots(f.required_acr);
    corps["required_amr"] = mots(f.required_amr);
    corps["logout"] = { rp_initiated: f.rp_initiated, backchannel: f.backchannel };
    nombres.push(
      ["max_age_sec", f.max_age_sec, "Âge maximal"],
      ["clock_skew_sec", f.clock_skew_sec, "Écart d'horloge"],
      ["session_max_age_sec", f.session_max_age_sec, "Durée de session"],
    );
  }
  for (const [cle, v, nom] of nombres) {
    const n = entierSaisi(v, nom);
    if (typeof n === "string") return n;
    if (n !== undefined) corps[cle] = n;
  }
  return corps;
}

interface Retour {
  r?: ReglagesAuthConsole;
  erreur?: string;
}

export function creerIdentite(b: BaseAdmin) {
  const { vue, ctx, e } = b;
  const { computed, ref, watch } = vue;
  const { fetchAuth, showToast } = ctx;

  const authEtat: Ref<ReglagesAuthConsole | null> = ref(null);
  const authUrl = ref("");
  const authMode: Ref<ModeLocal> = ref("all");
  const authReglagesErreur = ref("");
  const authBusy = ref(false);
  const authTiroir: Ref<FormFournisseur | null> = ref(null);
  const authTiroirErreur = ref("");
  const authAjoutOuvert = ref(false);
  const authDrawer: Ref<HTMLElement | null> = ref(null);
  const gardeFocus = creerGardeFocus();
  const authEssai: Ref<ReponseEssaiFournisseur | null> = ref(null);
  const authEssaiEnCours = ref(false);
  const authEssaiErreur = ref("");
  let sequence = 0;
  let sequenceEssai = 0;

  const bornes = computed(() => authEtat.value?.bounds ?? null);
  const authReglagesModifies = computed(
    () =>
      authEtat.value !== null &&
      (authUrl.value.trim() !== authEtat.value.public_url || authMode.value !== authEtat.value.local.mode),
  );
  const authFournisseur = computed<FournisseurAuth | null>(() => {
    const f = authTiroir.value;
    return f && !f.nouveau ? (authEtat.value?.providers.find((p) => p.id === f.id) ?? null) : null;
  });
  const authActifs = computed(() => (authEtat.value?.providers ?? []).filter((p) => p.active));
  const authAdressePublique = computed(() => authEtat.value?.public_url ?? "");

  function synchroniserReglages(): void {
    if (!authEtat.value) return;
    authUrl.value = authEtat.value.public_url;
    authMode.value = authEtat.value.local.mode;
  }

  /** Recopie l'état lu ; le formulaire des réglages n'est écrasé que s'il n'a pas été modifié. */
  function appliquer(r: ReglagesAuthConsole, forcer = false): void {
    const propre = !authReglagesModifies.value || forcer;
    authEtat.value = r;
    if (propre) synchroniserReglages();
  }

  /** Appel de l'API : état complet validé, ou message du serveur. */
  async function appeler(methode: string, chemin: string, corps?: unknown): Promise<Retour> {
    try {
      const res = await fetchAuth(BASE + chemin, {
        method: methode,
        headers: corps === undefined ? undefined : ENTETES_JSON,
        body: corps === undefined ? undefined : JSON.stringify(corps),
      });
      if (!res) return { erreur: "Erreur réseau." };
      if (!res.ok) return { erreur: detailErreur(await corpsJson(res), "Demande refusée par le serveur.") };
      if (methode === "DELETE") return {};
      const r = await lireSchema(res, schemaReglagesAuth);
      return r ? { r } : { erreur: "Réponse du serveur inattendue." };
    } catch {
      return { erreur: "Erreur réseau." };
    }
  }

  async function loadEnterpriseAuth(): Promise<void> {
    const moi = ++sequence;
    await suivreChargement(
      NOM_CHARGEUR,
      async () => {
        const r = await fetchAuth(BASE).then((x) => lireSchema(x, schemaReglagesAuth));
        if (moi !== sequence) return true;
        if (!r) return false;
        appliquer(r);
        return true;
      },
      loadEnterpriseAuth,
    );
  }

  async function authEnregistrerReglages(): Promise<boolean> {
    const etat = authEtat.value;
    if (!etat || authBusy.value) return false;
    const corps: Record<string, unknown> = {};
    if (authUrl.value.trim() !== etat.public_url) corps["public_url"] = authUrl.value.trim();
    if (authMode.value !== etat.local.mode) corps["local"] = { mode: authMode.value };
    if (Object.keys(corps).length === 0) return true;
    if (corps["local"] && authMode.value === "admins") {
      const ok = await ctx.openConfirm(
        "Connexion locale réservée aux administrateurs",
        "Seuls les administrateurs pourront encore se connecter avec un mot de passe local. Les autres comptes devront passer par un fournisseur d'entreprise actif.",
        true,
        "Confirmer",
      );
      if (!ok) return false;
    }
    authBusy.value = true;
    authReglagesErreur.value = "";
    try {
      const { r, erreur } = await appeler("PUT", "/settings", corps);
      if (!r) {
        authReglagesErreur.value = erreur ?? "";
        return false;
      }
      appliquer(r, true);
      showToast("Réglages enregistrés", "success");
      return true;
    } finally {
      authBusy.value = false;
    }
  }

  /** Oublie le résultat du test (et la réponse d'un test encore en vol). */
  function effacerEssai(): void {
    sequenceEssai += 1;
    authEssai.value = null;
    authEssaiErreur.value = "";
    authEssaiEnCours.value = false;
  }

  function ouvrirTiroir(f: FormFournisseur): void {
    if (!authTiroir.value) gardeFocus.remember();
    authTiroirErreur.value = "";
    authTiroir.value = f;
    effacerEssai();
    void ctx.nextTick().then(() => {
      const el = authDrawer.value;
      (el?.querySelector<HTMLElement>("input, select, textarea") ?? el)?.focus();
    });
  }
  function authNouveau(type: TypeFournisseur): void {
    authAjoutOuvert.value = false;
    ouvrirTiroir(formVide(type));
  }
  function authModifier(id: string): void {
    const f = authEtat.value?.providers.find((p) => p.id === id);
    if (f) ouvrirTiroir(formDe(f));
  }
  function authFermer(): void {
    effacerEssai();
    const ouvert = authTiroir.value !== null;
    authTiroir.value = null;
    authTiroirErreur.value = "";
    if (ouvert) gardeFocus.restore();
  }
  function authTouche(ev: KeyboardEvent): void {
    piegerTab(ev, authDrawer.value);
  }

  watch(authTiroir, effacerEssai, { deep: true });

  watch(e.adminTab, (page) => {
    if (page !== "enterprise-login") {
      authTiroir.value = null;
      authAjoutOuvert.value = false;
    }
  });

  /** Préremplit les champs vides d'après le préréglage LDAP choisi ; une saisie n'est jamais écrasée. */
  function authAppliquerPreset(): void {
    const f = authTiroir.value;
    const p = PRESETS_LDAP.find((x) => x.id === f?.preset);
    if (!f || !p) return;
    if (f.user_filter.trim() === "") f.user_filter = p.filtre;
    if (f.attr_id.trim() === "") f.attr_id = p.attrs.id;
    if (f.attr_username.trim() === "") f.attr_username = p.attrs.username;
    if (f.attr_email.trim() === "") f.attr_email = p.attrs.email;
    if (f.attr_name.trim() === "") f.attr_name = p.attrs.name;
    if (f.groups_mode === "") f.groups_mode = p.groupes;
  }

  function authAjouterGroupe(): void {
    const f = authTiroir.value;
    const g = f?.groupe_saisi.trim() ?? "";
    if (!f || g === "") return;
    const max = bornes.value?.required_groups_max ?? 0;
    if (f.required_groups.length >= max) {
      authTiroirErreur.value = `${max} groupes au plus.`;
      return;
    }
    if (!f.required_groups.includes(g)) f.required_groups.push(g);
    f.groupe_saisi = "";
  }
  function authRetirerGroupe(i: number): void {
    authTiroir.value?.required_groups.splice(i, 1);
  }

  /** Raison pour laquelle un champ ne se modifie pas (texte vide : modifiable). */
  function authFige(champ: string): string {
    const p = authFournisseur.value;
    if (!p) return "";
    if (p.enabled) return "Désactivez ce fournisseur pour modifier ses réglages.";
    const figes = p.type === "oidc" ? ["issuer", "client_id", "subject_claim"] : ["attrs.id"];
    return p.identities > 0 && figes.includes(champ)
      ? "Ce réglage ne se modifie plus : des comptes sont rattachés à ce fournisseur."
      : "";
  }

  /** Raison pour laquelle le fournisseur ne peut pas être activé (texte vide : activable). */
  const authRaisonActiver = computed(() => {
    const p = authFournisseur.value;
    const etat = authEtat.value;
    if (!p || !etat) return "";
    if (etat.public_url === "") return "Renseignez d'abord l'adresse publique en https.";
    if (!etat.prerequisites.cookie_secure) return "Activez d'abord l'accès HTTPS.";
    if (etat.prerequisites.local_admins < 1) return "Un administrateur avec mot de passe local est requis.";
    if (p.required_groups.length === 0) return "Indiquez d'abord au moins un groupe requis.";
    if (!p.has_secret) return "Enregistrez d'abord le secret.";
    if (!p.tested) return "Testez d'abord ce fournisseur.";
    return "";
  });

  /** Adresses à déclarer chez un fournisseur OIDC ; vides tant que l'adresse publique ou l'identifiant manque. */
  const authAdresses = computed(() => {
    const f = authTiroir.value;
    const base = authAdressePublique.value;
    const id = f?.id.trim() ?? "";
    if (!f || f.type !== "oidc" || base === "" || id === "") return null;
    return {
      retour: `${base}/api/auth/oidc/${id}/callback`,
      deconnexion: `${base}/api/auth/oidc/${id}/backchannel-logout`,
    };
  });

  async function envoyerSecret(id: string, secret: string): Promise<boolean> {
    const { r, erreur } = await appeler("PUT", `/providers/${encodeURIComponent(id)}/secret`, { secret });
    if (!r) {
      authTiroirErreur.value = erreur ?? "";
      return false;
    }
    appliquer(r);
    return true;
  }

  /** Crée ou modifie le fournisseur du tiroir, puis range le secret saisi ; le tiroir reste ouvert en cas d'échec. */
  async function authEnregistrer(): Promise<boolean> {
    const f = authTiroir.value;
    const etat = authEtat.value;
    if (!f || !etat || authBusy.value) return false;
    authTiroirErreur.value = "";
    authBusy.value = true;
    try {
      const enCours = authFournisseur.value;
      if (!enCours?.enabled) {
        const corps = corpsFournisseur(f, etat.bounds.ldap_urls_max);
        if (typeof corps === "string") {
          authTiroirErreur.value = corps;
          return false;
        }
        const { r, erreur } = f.nouveau
          ? await appeler("POST", "/providers", corps)
          : await appeler("PUT", `/providers/${encodeURIComponent(f.id)}`, corps);
        if (!r) {
          authTiroirErreur.value = erreur ?? "";
          return false;
        }
        appliquer(r);
        f.nouveau = false;
        f.id = f.id.trim();
      }
      if (f.secret !== "") {
        if (!(await envoyerSecret(f.id, f.secret))) return false;
        f.secret = "";
      }
      showToast("Fournisseur enregistré", "success");
      authFermer();
      return true;
    } finally {
      authBusy.value = false;
    }
  }

  async function authSupprimerSecret(): Promise<void> {
    const f = authTiroir.value;
    if (!f || f.nouveau || authBusy.value) return;
    const ok = await ctx.openConfirm(
      "Supprimer le secret",
      "Le secret enregistré sera effacé : ce fournisseur ne pourra plus être activé tant qu'un nouveau secret n'est pas saisi.",
      true,
      "Supprimer",
    );
    if (!ok) return;
    authBusy.value = true;
    authTiroirErreur.value = "";
    try {
      await envoyerSecret(f.id, "");
    } finally {
      authBusy.value = false;
    }
  }

  /** Teste les réglages du formulaire tels quels (enregistrés ou non), sans le secret ; le résultat s'efface à la moindre modification. */
  async function authTester(): Promise<void> {
    const f = authTiroir.value;
    const etat = authEtat.value;
    if (!f || !etat || authEssaiEnCours.value) return;
    const corps = corpsFournisseur({ ...f, nouveau: false }, etat.bounds.ldap_urls_max);
    if (typeof corps === "string") {
      authEssaiErreur.value = corps;
      authEssai.value = null;
      return;
    }
    corps["id"] = f.id.trim();
    corps["type"] = f.type;
    const moi = ++sequenceEssai;
    authEssai.value = null;
    authEssaiErreur.value = "";
    authEssaiEnCours.value = true;
    let essai: ReponseEssaiFournisseur | null = null;
    let erreur = "";
    try {
      const res = await fetchAuth(`${BASE}/providers/test`, {
        method: "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify(corps),
      });
      if (!res) erreur = "Erreur réseau.";
      else if (!res.ok) erreur = detailErreur(await corpsJson(res), "Demande refusée par le serveur.");
      else {
        essai = await lireSchema(res, schemaReponseEssaiFournisseur);
        if (!essai) erreur = "Réponse du serveur inattendue.";
      }
    } catch {
      erreur = "Erreur réseau.";
    }
    if (moi !== sequenceEssai) return;
    authEssaiEnCours.value = false;
    authEssai.value = essai;
    authEssaiErreur.value = erreur;
  }

  async function authBasculer(activer: boolean): Promise<boolean> {
    const f = authTiroir.value;
    const p = authFournisseur.value;
    if (!f || !p || authBusy.value) return false;
    if (activer && authRaisonActiver.value !== "") return false;
    if (!activer) {
      const ok = await ctx.openConfirm(
        "Désactiver ce fournisseur",
        `Les sessions des comptes rattachés à « ${p.label} » seront fermées : ces personnes devront se reconnecter autrement.`,
        true,
        "Désactiver",
      );
      if (!ok) return false;
    }
    authBusy.value = true;
    authTiroirErreur.value = "";
    try {
      const { r, erreur } = await appeler(
        "POST",
        `/providers/${encodeURIComponent(f.id)}/${activer ? "enable" : "disable"}`,
      );
      if (!r) {
        authTiroirErreur.value = erreur ?? "";
        return false;
      }
      appliquer(r);
      return true;
    } finally {
      authBusy.value = false;
    }
  }

  /** Supprime un fournisseur après saisie de son identifiant ; `ouvert` : appelé depuis le tiroir. */
  async function authSupprimer(id: string, ouvert = true): Promise<boolean> {
    if (authBusy.value || id === "") return false;
    const ok = await confirmerParMot(
      ctx,
      "Supprimer ce fournisseur",
      `Le fournisseur « ${id} » et son secret seront supprimés. Tapez son identifiant pour confirmer.`,
      id,
      "Supprimer",
    );
    if (!ok) return false;
    authBusy.value = true;
    authTiroirErreur.value = "";
    authReglagesErreur.value = "";
    try {
      const { erreur } = await appeler("DELETE", `/providers/${encodeURIComponent(id)}`);
      if (erreur !== undefined) {
        if (ouvert) authTiroirErreur.value = erreur;
        else authReglagesErreur.value = erreur;
        return false;
      }
      if (ouvert) authFermer();
      showToast("Fournisseur supprimé", "success");
    } finally {
      authBusy.value = false;
    }
    await loadEnterpriseAuth();
    return true;
  }

  async function authCopier(texte: string): Promise<void> {
    try {
      await copierTexte(texte);
      showToast("Adresse copiée", "success");
    } catch {
      showToast("Copie impossible : sélectionnez l'adresse", "error");
    }
  }

  return {
    authEtat,
    authUrl,
    authMode,
    authReglagesErreur,
    authReglagesModifies,
    authBusy,
    authTiroir,
    authTiroirErreur,
    authAjoutOuvert,
    authDrawer,
    authFournisseur,
    authActifs,
    authAdresses,
    authRaisonActiver,
    authEssai,
    authEssaiEnCours,
    authEssaiErreur,
    authTester,
    loadEnterpriseAuth,
    authEnregistrerReglages,
    authNouveau,
    authModifier,
    authFermer,
    authTouche,
    authAppliquerPreset,
    authAjouterGroupe,
    authRetirerGroupe,
    authFige,
    authEnregistrer,
    authSupprimerSecret,
    authBasculer,
    authSupprimer,
    authCopier,
  };
}
