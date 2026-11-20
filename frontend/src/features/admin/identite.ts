// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/identite.ts — console › Utilisateurs & accès › Connexion d'entreprise : lecture et écritures des réglages `auth`, formulaire d'un fournisseur OpenID Connect, secret, activation. */
import {
  schemaHoteNonCanonique,
  schemaReglagesAuth,
  schemaReponseDernierEssai,
  schemaReponseEssaiFournisseur,
  schemaReponseLancementEssai,
} from "@elpis/contracts";
import type {
  FournisseurAuth,
  ReglagesAuthConsole,
  ReponseEssaiFournisseur,
  ReponseLancementEssai,
  ResultatEssaiBlanc,
} from "@elpis/contracts";
import type { Ref } from "vue";

import { maintenantServeurS } from "../../platform/horloge";
import { adresseHttps } from "../auth/sso";
import { gardeFocus as creerGardeFocus, piegerTab } from "../../utils/focus";
import { copierTexte } from "../../utils/dom";
import { corpsJson, detailErreur, lireSchema } from "../../utils/lecture-json";
import { confirmerParMot } from "./confirmation";
import type { BaseAdmin } from "./etat";
import { suivreChargement } from "./suivi-chargement";
import type { FetchAuth } from "./types";

const ENTETES_JSON = { "Content-Type": "application/json" };
const NOM_CHARGEUR = "loadEnterpriseAuth";
const BASE = "/api/admin/auth";

/** Appel JSON de l'API : statut (0 sans réponse), réponse et, en échec, corps décodé. */
export async function envoyerJson(
  fetchAuth: FetchAuth,
  methode: string,
  chemin: string,
  corps?: unknown,
): Promise<{ statut: number; res: Response | null; donnees: unknown }> {
  try {
    const res = await fetchAuth(chemin, {
      method: methode,
      headers: corps === undefined ? undefined : ENTETES_JSON,
      body: corps === undefined ? undefined : JSON.stringify(corps),
    });
    if (!res) return { statut: 0, res: null, donnees: null };
    return { statut: res.status, res, donnees: res.ok ? null : await corpsJson(res) };
  } catch {
    return { statut: 0, res: null, donnees: null };
  }
}

/** Message d'une réponse en échec : « Erreur réseau. » sans réponse, sinon le détail du serveur. */
export const erreurServeur = (statut: number, donnees: unknown): string =>
  statut === 0 ? "Erreur réseau." : detailErreur(donnees, "Demande refusée par le serveur.");

export const ALGOS_JETON = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
] as const;

const DUREE_ATTENTE_ESSAI_MS = 300000;
const PAS_ATTENTE_ESSAI_MS = 2000;

const RAISONS_REFUS: Record<string, string> = {
  denied: "refus du fournisseur",
  expired: "le parcours a pris trop de temps",
  not_in_group: "la personne n'est dans aucun groupe requis",
  groups_unknown: "les groupes de la personne ne se lisent pas",
  conflict: "un compte existe déjà pour cet identifiant",
  suspended: "le compte est suspendu",
  mfa_required: "la vérification en deux étapes exigée n'est pas satisfaite",
  unavailable: "le fournisseur ne répond pas",
  failed: "le parcours n'a pas abouti",
};

/** Décision de l'essai en une phrase ; la raison vient d'une liste fermée, jamais du fournisseur. */
export function phraseDecision(d: ResultatEssaiBlanc["decision"]): string {
  const nom = d.username ?? "";
  if (d.outcome === "login") return `Cette personne se connecterait au compte ${nom}.`;
  if (d.outcome === "create") return `Un compte ${nom} serait créé.`;
  const raison = (d.reason !== null ? RAISONS_REFUS[d.reason] : undefined) ?? "cause non précisée";
  return d.outcome === "refuse" ? `Connexion refusée : ${raison}.` : `L'essai a échoué : ${raison}.`;
}

/** Libellé d'état d'un fournisseur ; `alerte` quand il est activé mais pas encore testé. */
export function etatFournisseur(p: { enabled: boolean; active: boolean }): {
  libelle: string;
  alerte: boolean;
} {
  if (p.active) return { libelle: "Actif", alerte: false };
  return p.enabled ? { libelle: "À tester", alerte: true } : { libelle: "Éteint", alerte: false };
}

/** Revendications reçues en liste compacte (libellé, valeur). */
export function lignesRevendications(c: NonNullable<ResultatEssaiBlanc["claims"]>): [string, string][] {
  return [
    ["Émetteur", c.iss],
    ["Identifiant stable", c.subject],
    ["Identifiant", c.identifier],
    ["Nom", c.name],
    ["E-mail", c.email === "" ? "" : `${c.email} (${c.email_verified ? "vérifié" : "non vérifié"})`],
    ["acr", c.acr ?? ""],
    ["amr", c.amr.join(", ")],
    ["Groupes", c.groups === null ? "groupes non lisibles" : c.groups.join(", ")],
  ];
}

const NOMS_ROLES = { user: "utilisateur", moderator: "modérateur", admin: "administrateur" } as const;

/** Phrases de l'essai sur le rôle et les groupes Elpis que la personne d'essai obtiendrait ; rien si aucune option n'agit. */
export function lignesDroits(d: ResultatEssaiBlanc["rights"]): string[] {
  if (!d || (!d.roles_enabled && !d.groups_enabled)) return [];
  const l: string[] = [];
  if (!d.readable) l.push("Groupes non lisibles : aucun rôle ni groupe ne serait modifié.");
  else {
    if (d.roles_enabled && d.role !== null) l.push(`Rôle obtenu : ${NOMS_ROLES[d.role]}.`);
    if (d.groups_enabled)
      l.push(`Groupes Elpis : ${d.groups.length ? d.groups.map((g) => g.name).join(", ") : "aucun"}.`);
  }
  if (d.admin_ignored)
    l.push(
      "Les groupes administrateurs sont ignorés tant qu'une vérification en deux étapes n'est pas exigée.",
    );
  const n = d.missing_group_ids.length;
  if (n > 0)
    l.push(
      n === 1
        ? "1 groupe Elpis de la correspondance n'existe plus."
        : `${n} groupes Elpis de la correspondance n'existent plus.`,
    );
  return l;
}

type ModeLocal = ReglagesAuthConsole["local"]["mode"];
type Correspondance = FournisseurAuth["group_map"]["map"][number];

const GROUPES_ROLE_MAX = 20;
const CORRESPONDANCES_MAX = 50;
const MOT_CONFIRMATION_ADMIN = "administrateur";
const SAISIES = {
  required_groups: "groupe_saisi",
  admin_groups: "admin_saisi",
  moderator_groups: "moderator_saisi",
} as const;
type ListeGroupes = keyof typeof SAISIES;

/** Formulaire d'un fournisseur : tout en texte, converti à l'envoi ; le secret n'y vit que le temps de la saisie. */
interface FormFournisseur {
  nouveau: boolean;
  type: "oidc";
  id: string;
  label: string;
  ca_pem: string;
  required_groups: string[];
  groupe_saisi: string;
  droits_actifs: boolean;
  roles_enabled: boolean;
  admin_groups: string[];
  moderator_groups: string[];
  admin_saisi: string;
  moderator_saisi: string;
  map_enabled: boolean;
  map: Correspondance[];
  map_externe: string;
  map_groupe: number;
  freshness_days: string;
  secret: string;
  issuer: string;
  client_id: string;
  client_auth: string;
  id_token_alg: string;
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
const mots = (t: string): string[] => t.split(/[\s,]+/u).filter((x) => x !== "");

function formVide(): FormFournisseur {
  return {
    nouveau: true,
    type: "oidc",
    id: "",
    label: "",
    ca_pem: "",
    required_groups: [],
    groupe_saisi: "",
    droits_actifs: false,
    roles_enabled: false,
    admin_groups: [],
    moderator_groups: [],
    admin_saisi: "",
    moderator_saisi: "",
    map_enabled: false,
    map: [],
    map_externe: "",
    map_groupe: 0,
    freshness_days: "",
    secret: "",
    issuer: "",
    client_id: "",
    client_auth: "",
    id_token_alg: "RS256",
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

/** Vrai quand une option de rôles ou de groupes est allumée ou renseignée. */
function droitsPresents(f: FormFournisseur): boolean {
  return (
    f.roles_enabled ||
    f.admin_groups.length > 0 ||
    f.moderator_groups.length > 0 ||
    f.map_enabled ||
    f.map.length > 0
  );
}

/** Formulaire rempli des réglages d'un fournisseur lu (jamais de secret). */
function formDe(f: FournisseurAuth): FormFournisseur {
  const base: FormFournisseur = {
    ...formVide(),
    nouveau: false,
    id: f.id,
    label: f.label,
    ca_pem: f.ca_pem,
    required_groups: [...f.required_groups],
    roles_enabled: f.roles.enabled,
    admin_groups: [...f.roles.admin_groups],
    moderator_groups: [...f.roles.moderator_groups],
    map_enabled: f.group_map.enabled,
    map: f.group_map.map.map((c) => ({ ...c })),
    freshness_days: chiffre(f.freshness_days),
  };
  base.droits_actifs = droitsPresents(base);
  return {
    ...base,
    issuer: f.issuer,
    client_id: f.client_id,
    client_auth: f.client_auth,
    id_token_alg: f.id_token_alg,
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

const REQUIS: readonly (readonly [keyof FormFournisseur, string])[] = [
  ["id", "Identifiant"],
  ["label", "Libellé"],
  ["issuer", "Autorité"],
  ["client_id", "Identifiant client"],
];

/** Corps de création ou de modification d'un fournisseur ; une chaîne seule est un message d'erreur de saisie. */
function corpsFournisseur(f: FormFournisseur): Record<string, unknown> | string {
  if (f.nouveau)
    for (const [cle, nom] of REQUIS)
      if (String(f[cle]).trim() === "") return `Champ « ${nom} » : à renseigner.`;
  const corps: Record<string, unknown> = {
    label: f.label.trim(),
    ca_pem: f.ca_pem,
    required_groups: f.required_groups,
  };
  if (f.nouveau) {
    corps["id"] = f.id.trim();
    corps["type"] = f.type;
  }
  if (f.droits_actifs || droitsPresents(f)) {
    corps["roles"] = {
      enabled: f.roles_enabled,
      admin_groups: f.admin_groups,
      moderator_groups: f.moderator_groups,
    };
    corps["group_map"] = { enabled: f.map_enabled, map: f.map.map((c) => ({ ...c })) };
  }
  const texte = (cle: string, v: string): void => {
    if (v.trim() !== "") corps[cle] = v.trim();
  };
  const nombres: [string, string, string][] = [["freshness_days", f.freshness_days, "Fraîcheur"]];
  texte("issuer", f.issuer);
  texte("client_id", f.client_id);
  texte("client_auth", f.client_auth);
  texte("id_token_alg", f.id_token_alg);
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
  const authDrawer: Ref<HTMLElement | null> = ref(null);
  const gardeFocus = creerGardeFocus();
  const authEssai: Ref<ReponseEssaiFournisseur | null> = ref(null);
  const authEssaiEnCours = ref(false);
  const authEssaiErreur = ref("");
  const authTrial: Ref<ResultatEssaiBlanc | null> = ref(null);
  const authTrialEtapes: Ref<ReponseLancementEssai["steps"]> = ref([]);
  const authTrialEnCours = ref(false);
  const authTrialAttente = ref(false);
  const authTrialErreur = ref("");
  let sequence = 0;
  let sequenceEssai = 0;
  let sequenceTrial = 0;
  let minuteurTrial: ReturnType<typeof setTimeout> | null = null;

  const authReglagesModifies = computed(
    () =>
      authEtat.value !== null &&
      (authUrl.value.trim() !== authEtat.value.public_url || authMode.value !== authEtat.value.local.mode),
  );
  const authFournisseur = computed<FournisseurAuth | null>(() => {
    const f = authTiroir.value;
    return f && !f.nouveau ? (authEtat.value?.providers.find((p) => p.id === f.id) ?? null) : null;
  });
  /** Groupes administrateurs saisis alors que ce SSO n'exige ni niveau ni méthode d'authentification. */
  const authAdminSansSecondFacteur = computed(() => {
    const f = authTiroir.value;
    return !!f && f.admin_groups.length > 0 && f.required_acr.trim() === "" && f.required_amr.trim() === "";
  });
  /** Enregistrer est indisponible : le serveur refuse des groupes administrateurs actifs sans second facteur exigé. */
  const authRolesBloque = computed(
    () => authAdminSansSecondFacteur.value && !!authTiroir.value?.roles_enabled,
  );
  /** Vrai quand les groupes administrateurs actifs, ou la façon de les lire, sont nouveaux ou modifiés par rapport à l'état enregistré. */
  const authAdminAConfirmer = computed(() => {
    const f = authTiroir.value;
    if (!f || !f.roles_enabled || f.admin_groups.length === 0) return false;
    const p = authFournisseur.value;
    if (!p || !p.roles.enabled) return true;
    const a = [...p.roles.admin_groups].sort();
    const b = [...f.admin_groups].sort();
    if (a.length !== b.length || a.some((x, i) => x !== b[i])) return true;
    const mots_ = (t: string[]): string => [...t].sort().join(" ");
    return (
      f.groups_claim.trim() !== p.groups_claim ||
      mots_(mots(f.required_acr)) !== mots_(p.required_acr) ||
      mots_(mots(f.required_amr)) !== mots_(p.required_amr)
    );
  });
  const authActifs = computed(() => (authEtat.value?.providers ?? []).filter((p) => p.active));

  /** Recopie l'état lu ; le formulaire des réglages n'est écrasé que s'il n'a pas été modifié. */
  function appliquer(r: ReglagesAuthConsole, forcer = false): void {
    const propre = !authReglagesModifies.value || forcer;
    authEtat.value = r;
    if (propre) {
      authUrl.value = r.public_url;
      authMode.value = r.local.mode;
    }
  }

  /** Appel de l'API : état complet validé, ou message du serveur. */
  async function appeler(methode: string, chemin: string, corps?: unknown): Promise<Retour> {
    const { statut, res, donnees } = await envoyerJson(fetchAuth, methode, BASE + chemin, corps);
    if (!res?.ok) return { erreur: erreurServeur(statut, donnees) };
    if (methode === "DELETE") return {};
    const r = await lireSchema(res, schemaReglagesAuth);
    return r ? { r } : { erreur: "Réponse du serveur inattendue." };
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
        "Seuls les administrateurs pourront encore se connecter avec un mot de passe local. Les autres comptes devront passer par un fournisseur d'entreprise actif. Les jetons, accès d'outils et routines de leurs comptes locaux seront aussi suspendus ; ils reprendront au retour au mode « Tous les comptes ».",
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

  /** Arrête l'attente d'un essai de connexion et oublie son résultat. */
  function effacerTrial(): void {
    sequenceTrial += 1;
    if (minuteurTrial !== null) clearTimeout(minuteurTrial);
    minuteurTrial = null;
    authTrial.value = null;
    authTrialEtapes.value = [];
    authTrialErreur.value = "";
    authTrialEnCours.value = false;
    authTrialAttente.value = false;
  }

  function ouvrirTiroir(f: FormFournisseur): void {
    if (!authTiroir.value) gardeFocus.remember();
    effacerTrial();
    authTiroirErreur.value = "";
    authTiroir.value = f;
    effacerEssai();
    void ctx.nextTick().then(() => {
      const el = authDrawer.value;
      (el?.querySelector<HTMLElement>("input, select, textarea") ?? el)?.focus();
    });
  }
  function authNouveau(): void {
    ouvrirTiroir(formVide());
  }
  function authModifier(id: string): void {
    const f = authEtat.value?.providers.find((p) => p.id === id);
    if (f) ouvrirTiroir(formDe(f));
  }
  function authFermer(): void {
    effacerEssai();
    effacerTrial();
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
      effacerTrial();
      authTiroir.value = null;
    }
  });

  function authAjouterGroupe(cle: ListeGroupes = "required_groups"): void {
    const f = authTiroir.value;
    if (!f) return;
    const g = f[SAISIES[cle]].trim();
    if (g === "") return;
    const max =
      cle === "required_groups" ? (authEtat.value?.bounds.required_groups_max ?? 0) : GROUPES_ROLE_MAX;
    if (f[cle].length >= max) {
      authTiroirErreur.value = `${max} groupes au plus.`;
      return;
    }
    if (!f[cle].includes(g)) f[cle].push(g);
    f[SAISIES[cle]] = "";
  }
  function authRetirerGroupe(cle: ListeGroupes, i: number): void {
    authTiroir.value?.[cle].splice(i, 1);
  }
  function authAjouterCorrespondance(): void {
    const f = authTiroir.value;
    const externe = f?.map_externe.trim() ?? "";
    if (!f || externe === "" || f.map_groupe < 1) return;
    if (f.map.length >= CORRESPONDANCES_MAX) {
      authTiroirErreur.value = `${CORRESPONDANCES_MAX} correspondances au plus.`;
      return;
    }
    if (!f.map.some((c) => c.external === externe && c.group_id === f.map_groupe))
      f.map.push({ external: externe, group_id: f.map_groupe });
    f.map_externe = "";
    f.map_groupe = 0;
  }
  function authRetirerCorrespondance(i: number): void {
    authTiroir.value?.map.splice(i, 1);
  }

  /** Raison pour laquelle un champ ne se modifie pas (texte vide : modifiable). */
  function authFige(champ: string): string {
    const p = authFournisseur.value;
    if (!p) return "";
    if (p.enabled) return "Désactivez ce fournisseur pour modifier ses réglages.";
    const figes = ["issuer", "client_id", "subject_claim"];
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
    if (!p.tested) return "Lancez d'abord un essai de connexion.";
    return "";
  });

  /** Adresses à déclarer chez un fournisseur OIDC ; vides tant que l'adresse publique ou l'identifiant manque. */
  const authAdresses = computed(() => {
    const f = authTiroir.value;
    const base = authEtat.value?.public_url ?? "";
    const id = f?.id.trim() ?? "";
    if (!f || base === "" || id === "") return null;
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
    const fige = !!authFournisseur.value?.enabled;
    if (!fige && authRolesBloque.value) return false;
    const confirmer = !fige && authAdminAConfirmer.value;
    if (
      confirmer &&
      !(await confirmerParMot(
        ctx,
        "Donner le rôle d'administrateur",
        "Les membres de ces groupes du fournisseur deviendront administrateurs d'Elpis et pourront faire exécuter des commandes sur le serveur. Tapez « administrateur » pour confirmer.",
        MOT_CONFIRMATION_ADMIN,
        "Confirmer",
      ))
    )
      return false;
    if (authBusy.value) return false;
    authBusy.value = true;
    try {
      if (!fige) {
        const corps = corpsFournisseur(f);
        if (typeof corps === "string") {
          authTiroirErreur.value = corps;
          return false;
        }
        if (confirmer) corps["confirm_admin_mapping"] = true;
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

  /** Teste les réglages du formulaire tels quels ; le résultat s'efface à la moindre modification. */
  async function authTester(): Promise<void> {
    const f = authTiroir.value;
    const etat = authEtat.value;
    if (!f || !etat || authEssaiEnCours.value) return;
    const corps = corpsFournisseur({ ...f, nouveau: false });
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
    const { statut, res, donnees } = await envoyerJson(fetchAuth, "POST", `${BASE}/providers/test`, corps);
    const essai = res?.ok ? await lireSchema(res, schemaReponseEssaiFournisseur) : null;
    const erreur = essai ? "" : res?.ok ? "Réponse du serveur inattendue." : erreurServeur(statut, donnees);
    if (moi !== sequenceEssai) return;
    authEssaiEnCours.value = false;
    authEssai.value = essai;
    authEssaiErreur.value = erreur;
  }

  /** Interroge le dernier résultat toutes les 2 s, 5 minutes au plus, jusqu'à un résultat postérieur au lancement. */
  function attendreTrial(id: string, depuis: number, precedent: number): void {
    const jeton = ++sequenceTrial;
    const fin = Date.now() + DUREE_ATTENTE_ESSAI_MS;
    authTrialAttente.value = true;
    const tour = async (): Promise<void> => {
      minuteurTrial = null;
      const { res } = await envoyerJson(
        fetchAuth,
        "GET",
        `${BASE}/providers/${encodeURIComponent(id)}/trial`,
      );
      const resultat = (await lireSchema(res, schemaReponseDernierEssai))?.result ?? null;
      if (jeton !== sequenceTrial) return;
      if (resultat !== null && resultat.at >= depuis - 2 && resultat.at > precedent) {
        authTrial.value = resultat;
        authTrialAttente.value = false;
        await loadEnterpriseAuth();
        return;
      }
      if (Date.now() >= fin) {
        authTrialAttente.value = false;
        authTrialErreur.value = "L'essai n'a pas abouti à temps. Relancez-le.";
        return;
      }
      minuteurTrial = setTimeout(() => void tour(), PAS_ATTENTE_ESSAI_MS);
    };
    minuteurTrial = setTimeout(() => void tour(), PAS_ATTENTE_ESSAI_MS);
  }

  /** Lance l'essai de connexion : étapes puis, si elles passent, adresse ouverte dans un nouvel onglet. */
  async function authEssayerConnexion(): Promise<void> {
    const f = authTiroir.value;
    if (!f || f.nouveau || authTrialEnCours.value) return;
    const id = f.id;
    const precedent = authTrial.value?.at ?? 0;
    effacerTrial();
    const depuis = maintenantServeurS();
    const jeton = sequenceTrial;
    authTrialEnCours.value = true;
    try {
      const { statut, res, donnees } = await envoyerJson(
        fetchAuth,
        "POST",
        `${BASE}/providers/${encodeURIComponent(id)}/trial`,
        {},
      );
      if (jeton !== sequenceTrial) return;
      if (!res?.ok) {
        const h = statut === 409 ? schemaHoteNonCanonique.safeParse(donnees) : null;
        authTrialErreur.value = h?.success
          ? `Ouvrez la console depuis ${h.data.canonical} pour lancer l'essai.`
          : erreurServeur(statut, donnees);
        return;
      }
      const r = await lireSchema(res, schemaReponseLancementEssai);
      if (jeton !== sequenceTrial) return;
      if (!r) {
        authTrialErreur.value = "Réponse du serveur inattendue.";
        return;
      }
      authTrialEtapes.value = r.steps;
      const url = r.ok ? adresseHttps(r.url) : null;
      if (url === null) {
        if (r.ok) authTrialErreur.value = "Réponse du serveur inattendue.";
        return;
      }
      window.open(url, "_blank", "noopener");
      attendreTrial(id, depuis, precedent);
    } catch {
      if (jeton === sequenceTrial) authTrialErreur.value = "Erreur réseau.";
    } finally {
      if (jeton === sequenceTrial) authTrialEnCours.value = false;
    }
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
    authDrawer,
    authFournisseur,
    authActifs,
    authAdminSansSecondFacteur,
    authRolesBloque,
    authAjouterCorrespondance,
    authRetirerCorrespondance,
    authAdresses,
    authRaisonActiver,
    authEssai,
    authEssaiEnCours,
    authEssaiErreur,
    authTester,
    authTrial,
    authTrialEtapes,
    authTrialEnCours,
    authTrialAttente,
    authTrialErreur,
    authEssayerConnexion,
    loadEnterpriseAuth,
    authEnregistrerReglages,
    authNouveau,
    authModifier,
    authFermer,
    authTouche,
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
