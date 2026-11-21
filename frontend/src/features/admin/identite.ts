// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/identite.ts — console › Utilisateurs & accès › SSO OpenID Connect : lecture et écritures des réglages `auth`, formulaire d'un fournisseur OpenID Connect, secret, activation. */
import {
  adminsToujoursRefuses,
  AMR_MULTI_FACTEUR,
  amrFortExige,
  amrNormal,
  REGEX_ID_FOURNISSEUR,
  schemaHoteNonCanonique,
  schemaReglagesAuth,
  schemaReponseDernierEssai,
  schemaReponseEssaiFournisseur,
  schemaReponseLancementEssai,
  secondFacteurDemande,
  secondFacteurPourTous,
} from "@elpis/contracts";
import type {
  ExigencesSecondFacteur,
  FournisseurAuth,
  RaisonEssai,
  ReglagesAuthConsole,
  ReponseEssaiFournisseur,
  ReponseLancementEssai,
  ResultatEssaiBlanc,
} from "@elpis/contracts";
import type { Ref } from "vue";

import { maintenantServeurS } from "../../platform/horloge";
import { mouvementReduit } from "../../platform/mouvement";
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

/** Phrase de chaque raison que le serveur peut rendre à l'essai (liste fermée des contrats) : la cause, puis ce qu'il faut faire et où. */
export const RAISONS_ESSAI_PHRASES: Readonly<Record<RaisonEssai, string>> = {
  denied:
    "refus du fournisseur ; la personne a annulé, ou ce compte n'a pas accès à ce client chez le fournisseur",
  expired: "le parcours a pris trop de temps ; relancez l'essai",
  not_in_group: "la personne n'est dans aucun groupe requis",
  groups_unknown: "groupes absents ou illisibles (aucune liste de groupes lisible reçue pour cette personne)",
  conflict: "un compte existe déjà pour cet identifiant",
  suspended: "le compte est suspendu",
  mfa_required: "le second facteur exigé n'est pas prouvé",
  unavailable: "le fournisseur ne répond pas ; relancez « Contrôler les réglages »",
  failed: "le parcours n'a pas abouti ; la cause est notée dans Supervision › Journaux (ligne « essai SSO »)",
  issuer_mismatch:
    "l'identité de ce compte a été rattachée sous un autre émetteur ; détachez le compte (page Comptes), puis préparez de nouveau son rattachement",
  name_invalid:
    "l'identifiant reçu ne donne pas de nom de compte valable (vide, réservé, trop long ou e-mail non vérifié) ; vérifiez « Revendication nom (preferred_username) », section 6",
  account_conflict:
    "un compte local porte déjà ce nom ; préparez son rattachement (carte « 3. Comptes existants »)",
  no_local_admin: "aucun administrateur à mot de passe local ; rétablissez-en un dans la page Comptes",
  prelink_invalid:
    "le rattachement préparé ne vaut plus (échu, compte privilégié sans preuve ou dernier administrateur local) ; préparez-le de nouveau (carte « 3. Comptes existants »)",
  settings_changed: "les réglages ont changé pendant l'essai ; relancez « Se connecter pour essayer »",
  secret_missing:
    "aucun secret client enregistré ; saisissez-le en section 3, enregistrez, puis relancez l'essai",
  client_auth_rejected:
    "le fournisseur refuse l'authentification du client ; vérifiez le secret client (section 3) et la méthode d'authentification du client (token_endpoint_auth_method, section 6) tels que réglés chez le fournisseur",
  code_rejected:
    "le fournisseur refuse d'échanger le code d'autorisation ; vérifiez l'adresse de retour déclarée chez lui (section 2) et que ce client y autorise le flux par code",
  alg_unexpected:
    "le jeton est signé avec un autre algorithme que celui réglé ; choisissez en section 6 (id_token_signed_response_alg) celui du client chez le fournisseur",
  signing_key:
    "aucune clé publiée par le fournisseur ne vérifie le jeton ; relancez « Contrôler les réglages » (clés de signature) et vérifiez l'algorithme réglé (section 6)",
  aud_untrusted:
    "le jeton d'identité vise aussi d'autres clients (aud) ; retirez chez le fournisseur les audiences ajoutées à ce client",
  token_mismatch:
    "le jeton ou la réponse ne viennent pas de l'émetteur ou du client réglés ; vérifiez l'adresse de l'émetteur (issuer, section 1) et l'identifiant client (client_id, section 3)",
  clock:
    "le jeton d'identité est hors de sa période de validité ; vérifiez l'heure de ce serveur et celle du fournisseur, puis l'écart d'horloge et l'âge maximal (max_age) en section 6",
  subject_invalid:
    "le sujet du jeton est absent ou trop long ; vérifiez « Revendication sujet (sub) », section 6",
  id_token_missing:
    "le fournisseur n'a pas rendu de jeton d'identité ; vérifiez la portée openid (scope, section 6) et que ce client est un client OpenID Connect chez le fournisseur",
};

/** Conflit de nom avec un compte déjà rattaché : il ne peut pas être préparé, car un compte ne porte qu'une identité. */
export const PHRASE_CONFLIT_RATTACHE =
  "un compte rattaché à un fournisseur porte déjà ce nom, et une personne n'a qu'une identité ; renommez son identifiant chez l'un des fournisseurs, ou supprimez dans Comptes le compte Elpis en trop (voir le guide)";

/** Décision de l'essai en une phrase ; la raison vient d'une liste fermée, jamais du fournisseur. */
export function phraseDecision(d: ResultatEssaiBlanc["decision"]): string {
  const nom = d.username ?? "";
  if (d.outcome === "login") return `Cette personne se connecterait au compte ${nom}.`;
  if (d.outcome === "link")
    return `Cette personne serait rattachée au compte ${nom} sans ancien mot de passe (dispense), puis connectée.`;
  if (d.outcome === "proof")
    return `Cette personne devrait d'abord saisir l'ancien mot de passe du compte ${nom} pour s'y rattacher ; à cette première connexion, ses droits ne peuvent que baisser.`;
  if (d.outcome === "create") return `Un compte ${nom} serait créé.`;
  const phrases: Readonly<Record<string, string | undefined>> = RAISONS_ESSAI_PHRASES;
  const raison =
    d.reason === "account_conflict" && d.conflict_linked === true
      ? PHRASE_CONFLIT_RATTACHE
      : ((d.reason !== null ? phrases[d.reason] : undefined) ?? "cause non précisée");
  if (d.outcome === "error") return `L'essai a échoué : ${raison}.`;
  return d.username === null
    ? `Connexion refusée : ${raison}.`
    : `Connexion refusée pour le compte ${nom} : ${raison}.`;
}

/** Libellé d'état d'un fournisseur ; `alerte` quand il est activé mais pas actif (inopérant). */
export function etatFournisseur(p: { enabled: boolean; active: boolean }): {
  libelle: string;
  alerte: boolean;
} {
  if (p.active) return { libelle: "Actif", alerte: false };
  return p.enabled ? { libelle: "Inopérant", alerte: true } : { libelle: "Éteint", alerte: false };
}

export interface ConditionActivation {
  id: "public_url" | "https" | "local_admin" | "required_group" | "secret" | "trial" | "saved";
  libelle: string;
  ok: boolean;
  /** Ce qu'il faut faire avant d'activer. */
  raison: string;
  /** Cause et remède quand le fournisseur est déjà activé mais inopérant (seul ce qui reste faisable est proposé). */
  inoperant: string;
}

/** Les six conditions d'activation d'un fournisseur enregistré, dans l'ordre où le serveur les vérifie. */
export function conditionsActivation(
  etat: ReglagesAuthConsole,
  p: FournisseurAuth | null,
): ConditionActivation[] {
  return [
    {
      id: "public_url",
      libelle: "Adresse publique en https",
      ok: etat.public_url !== "",
      raison: "Renseignez d'abord l'adresse publique en https.",
      inoperant: "Adresse publique manquante : désactivez les fournisseurs pour la renseigner.",
    },
    {
      id: "https",
      libelle: "Accès HTTPS en service",
      ok: etat.prerequisites.cookie_secure,
      raison: "Activez d'abord l'accès HTTPS.",
      inoperant: "Accès HTTPS hors service : rétablissez-le depuis la carte « 1. Prérequis ».",
    },
    {
      id: "local_admin",
      libelle: "Administrateur à mot de passe local",
      ok: etat.prerequisites.local_admins >= 1,
      raison: "Un administrateur avec mot de passe local est requis.",
      inoperant: "Aucun administrateur à mot de passe local : rétablissez-en un dans la page Comptes.",
    },
    {
      id: "required_group",
      libelle: "Au moins un groupe requis",
      ok: (p?.required_groups.length ?? 0) > 0,
      raison: "Indiquez d'abord au moins un groupe requis.",
      inoperant: "Aucun groupe requis : désactivez-le pour en indiquer un.",
    },
    {
      id: "secret",
      libelle: "Secret client enregistré",
      ok: p?.has_secret ?? false,
      raison: "Enregistrez d'abord le secret.",
      inoperant: "Secret client manquant : désactivez-le pour l'enregistrer.",
    },
    {
      id: "trial",
      libelle: "Connexion d'essai réussie",
      ok: p?.tested ?? false,
      raison: "Réussissez d'abord « Se connecter pour essayer ».",
      inoperant: "Connexion d'essai à refaire : désactivez-le pour refaire « Se connecter pour essayer ».",
    },
  ];
}

/** Raison écrite dans la ligne d'un fournisseur activé mais inopérant : la cause et ce qui la corrige. */
export function raisonInoperant(etat: ReglagesAuthConsole, p: FournisseurAuth): string {
  return (
    conditionsActivation(etat, p).find((c) => !c.ok)?.inoperant ??
    "Condition d'activation manquante : désactivez-le, puis vérifiez sa section « 8. Activation »."
  );
}

const IDENTIFIANT_MAX = 31;

/** Identifiant déduit d'un libellé : sans accent, en minuscules, chaque suite d'autres caractères devient un tiret. */
export function identifiantDe(libelle: string): string {
  return libelle
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+/u, "")
    .slice(0, IDENTIFIANT_MAX)
    .replace(/-+$/u, "");
}

const PREUVES = { acr: "prouvé par le niveau acr", amr: "prouvé par les méthodes amr" } as const;

/** Ce qui manque quand le jeton ne prouve pas de second facteur : avec des niveaux déclarés, le niveau `acr` ET les méthodes `amr` (qui prouvent toujours), sinon les méthodes seules. */
function preuveManquante(c: NonNullable<ResultatEssaiBlanc["claims"]>, e: ExigencesSecondFacteur): string {
  const parAcr = e.mfa_acr.length > 0;
  const parAmr = amrFortExige(e);
  const amrInsuffisantes =
    c.amr.length > 0
      ? "les méthodes amr reçues ne suffisent pas (mfa, mca, ou deux familles comme pwd et otp)"
      : "aucune méthode amr reçue";
  const acrNonDeclare =
    c.acr !== null && c.acr !== ""
      ? "le niveau acr reçu n'est pas déclaré comme second facteur"
      : "aucun niveau acr reçu";
  if (parAcr) return `non prouvé : ${acrNonDeclare} ; ${amrInsuffisantes}`;
  if (parAmr) return `non prouvé : ${amrInsuffisantes}`;
  return "non prouvé : aucun second facteur n'est demandé à ce fournisseur (section 4)";
}

/** Revendications reçues en liste compacte (libellé, valeur) ; `e` : exigences de second facteur des réglages essayés. */
export function lignesRevendications(
  c: NonNullable<ResultatEssaiBlanc["claims"]>,
  e: ExigencesSecondFacteur,
): [string, string][] {
  return [
    ["Émetteur", c.iss],
    ["Identifiant stable", c.subject],
    ["Identifiant", c.identifier],
    ["Nom", c.name],
    ["E-mail", c.email === "" ? "" : `${c.email} (${c.email_verified ? "vérifié" : "non vérifié"})`],
    ["acr", c.acr ?? ""],
    ["amr", c.amr.join(", ")],
    ["Second facteur", c.second_factor === null ? preuveManquante(c, e) : PREUVES[c.second_factor]],
    ["Groupes", c.groups === null ? "groupes absents ou illisibles" : c.groups.join(", ")],
  ];
}

const NOMS_ROLES = { user: "utilisateur", moderator: "modérateur", admin: "administrateur" } as const;

/** Phrases de l'essai sur le rôle et les groupes Elpis que la personne d'essai obtiendrait ; rien si aucune option n'agit. */
export function lignesDroits(d: ResultatEssaiBlanc["rights"]): string[] {
  if (!d || (!d.roles_enabled && !d.groups_enabled)) return [];
  const l: string[] = [];
  if (!d.readable) l.push("Groupes absents ou illisibles : aucun rôle ni groupe ne serait modifié.");
  else {
    if (d.roles_enabled && d.role !== null) l.push(`Rôle obtenu : ${NOMS_ROLES[d.role]}.`);
    if (d.groups_enabled)
      l.push(`Groupes Elpis : ${d.groups.length ? d.groups.map((g) => g.name).join(", ") : "aucun"}.`);
  }
  if (d.admin_ignored)
    l.push("Les groupes administrateurs sont ignorés tant qu'un second facteur n'est pas exigé.");
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
const FIGES_PAR_COMPTES = ["issuer", "client_id", "subject_claim"];
const MODIFIABLES_ACTIF = ["label", "freshness_days"];
const CORRESPONDANCES_MAX = 50;
const MOT_CONFIRMATION_ADMIN = "administrateur";
export const SAISIES = {
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
  /** Vrai dès que l'administrateur saisit l'identifiant : il n'est plus déduit du libellé. */
  id_touche: boolean;
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
  mfa_acr: string;
  max_age_sec: string;
  clock_skew_sec: string;
  session_max_age_sec: string;
  rp_initiated: boolean;
  backchannel: boolean;
}

const chiffre = (n: number): string => String(n);
const mots = (t: string): string[] => t.split(/[\s,]+/u).filter((x) => x !== "");

/** Exigences en clair : `acr` et `amr` vont ensemble, une valeur de chaque liste suffit. */
const exigences = (acr: readonly string[], amr: readonly string[]): string =>
  [
    ...(acr.length ? [`acr ${acr.join(" ou ")}`] : []),
    ...(amr.length ? [`amr ${amr.join(" ou ")}`] : []),
  ].join(" et ");

/** Champs du formulaire qui disent le second facteur. */
export type SaisieSecondFacteur = Pick<FormFournisseur, "required_acr" | "required_amr" | "mfa_acr">;

/** Exigences de second facteur saisies dans le formulaire. */
const exigencesSaisies = (f: SaisieSecondFacteur): ExigencesSecondFacteur => ({
  required_acr: mots(f.required_acr),
  required_amr: mots(f.required_amr),
  mfa_acr: mots(f.mfa_acr),
});

/** Ligne d'état du second facteur, toujours affichée, selon la règle du serveur : prouvé à chaque connexion, prouvé seulement par qui reçoit un groupe administrateur (`groupesAdmin`), ou jamais. */
export function phraseSecondFacteur(f: SaisieSecondFacteur, groupesAdmin: boolean): string {
  const e = exigencesSaisies(f);
  if (secondFacteurPourTous(e))
    return `Second facteur exigé pour tous les comptes : ${exigences(e.required_acr, e.required_amr)}.`;
  if (!groupesAdmin || !secondFacteurDemande(e)) return "⚠ Aucun second facteur garanti par Elpis.";
  if (adminsToujoursRefuses(e))
    return "⚠ Administrateurs toujours refusés : aucun des niveaux exigés (acr) n'est déclaré comme second facteur, et aucune méthode forte (amr) n'est exigée.";
  const faibles = exigences(
    e.required_acr.filter((a) => !e.mfa_acr.includes(a)),
    e.required_amr.filter((m) => !AMR_MULTI_FACTEUR.has(amrNormal(m))),
  );
  return `⚠ Second facteur exigé des administrateurs seulement : les autres comptes peuvent entrer ${faibles ? `avec ${faibles}` : "sans second facteur"}.`;
}

function formVide(): FormFournisseur {
  return {
    nouveau: true,
    type: "oidc",
    id: "",
    id_touche: false,
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
    mfa_acr: "",
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
    id_touche: true,
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
    mfa_acr: f.mfa_acr.join(" "),
    max_age_sec: chiffre(f.max_age_sec),
    clock_skew_sec: chiffre(f.clock_skew_sec),
    session_max_age_sec: chiffre(f.session_max_age_sec),
    rp_initiated: f.logout.rp_initiated,
    backchannel: f.logout.backchannel,
  };
}

/** Formulaire relu des réglages enregistrés `p` ; le libellé et la fraîcheur modifiés à l'écran depuis `avant` (les seuls modifiables d'un fournisseur activé) sont gardés. */
function relire(p: FournisseurAuth, f: FormFournisseur, avant: FournisseurAuth): FormFournisseur {
  const relu = formDe(p);
  if (f.label.trim() !== avant.label) relu.label = f.label;
  if (String(f.freshness_days).trim() !== chiffre(avant.freshness_days))
    relu.freshness_days = f.freshness_days;
  return relu;
}

/** Entier saisi (texte, ou nombre rendu par un champ `type="number"`) : `undefined` si vide, message d'erreur si ce n'est pas un entier. */
function entierSaisi(v: string | number, nom: string): number | undefined | string {
  const t = String(v).trim();
  if (t === "") return undefined;
  return /^\d{1,9}$/u.test(t) ? Number(t) : `Champ « ${nom} » : nombre entier attendu.`;
}

const REQUIS: readonly (readonly [keyof FormFournisseur, string])[] = [
  ["id", "Identifiant dans Elpis"],
  ["label", "Libellé"],
  ["issuer", "Adresse de l'émetteur"],
  ["client_id", "Identifiant client (client_id)"],
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
  corps["mfa_acr"] = mots(f.mfa_acr);
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

/** Réglages tels que « Contrôler les réglages » les envoie : jamais le secret, seulement qu'un secret est saisi sans être enregistré ; une chaîne seule est un message d'erreur de saisie. */
function corpsControle(f: FormFournisseur): Record<string, unknown> | string {
  const corps = corpsFournisseur({ ...f, nouveau: false });
  if (typeof corps === "string") return corps;
  return { ...corps, id: f.id.trim(), type: f.type, ...(f.secret !== "" ? { secret_entered: true } : {}) };
}

/** Corps d'un fournisseur activé : le libellé et la fraîcheur, seuls modifiables sans le désactiver ; `null` si rien ne change. */
function corpsActif(f: FormFournisseur, p: FournisseurAuth): Record<string, unknown> | string | null {
  const corps: Record<string, unknown> = {};
  if (f.label.trim() !== p.label) corps["label"] = f.label.trim();
  const n = entierSaisi(f.freshness_days, "Fraîcheur");
  if (typeof n === "string") return n;
  if (n !== undefined && n !== p.freshness_days) corps["freshness_days"] = n;
  return Object.keys(corps).length ? corps : null;
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
  const authUrlErreur = ref("");
  const authModeErreur = ref("");
  const authListeErreur = ref("");
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
  /** Réglages contrôlés par le dernier « Contrôler les réglages » : son résultat ne vaut que pour eux. */
  let cleEssai = "";
  const cleControle = (f: FormFournisseur | null): string => (f ? JSON.stringify(corpsControle(f)) : "");

  const authUrlModifiee = computed(
    () => authEtat.value !== null && authUrl.value.trim() !== authEtat.value.public_url,
  );
  const authModeModifie = computed(
    () => authEtat.value !== null && authMode.value !== authEtat.value.local.mode,
  );
  const authFournisseur = computed<FournisseurAuth | null>(() => {
    const f = authTiroir.value;
    return f && !f.nouveau ? (authEtat.value?.providers.find((p) => p.id === f.id) ?? null) : null;
  });
  /** Groupes administrateurs saisis alors que ce SSO ne demande pas de second facteur (même règle que le serveur). */
  const authAdminSansSecondFacteur = computed(() => {
    const f = authTiroir.value;
    return !!f && f.admin_groups.length > 0 && !secondFacteurDemande(exigencesSaisies(f));
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
      mots_(mots(f.required_amr)) !== mots_(p.required_amr) ||
      mots_(mots(f.mfa_acr)) !== mots_(p.mfa_acr)
    );
  });
  const authActifs = computed(() => (authEtat.value?.providers ?? []).filter((p) => p.active));
  /** Raison pour laquelle l'adresse publique ne se modifie pas (texte vide : modifiable). */
  const authUrlFigee = computed(() =>
    authEtat.value?.providers.some((p) => p.enabled)
      ? "Désactivez d'abord les fournisseurs pour changer l'adresse publique."
      : "",
  );
  /** Raison pour laquelle « Administrateurs seulement » ne se choisit pas : aucun fournisseur actif (revenir à « Tous les comptes » reste possible). */
  const authModeAdminsRaison = computed(() => {
    const etat = authEtat.value;
    if (!etat || etat.local.mode === "admins" || authActifs.value.length > 0) return "";
    return "Indisponible tant qu'aucun fournisseur n'est actif : les autres comptes ne pourraient plus se connecter.";
  });
  /** Ligne d'aide de la carte « Mots de passe locaux » : la raison du grisé, ou l'effet du mode enregistré. */
  const authModeAide = computed(() => {
    if (authModeAdminsRaison.value) return authModeAdminsRaison.value;
    if (authEtat.value?.local.mode === "admins" && authActifs.value.length === 0)
      return "⚠ Aucun fournisseur actif : seuls les administrateurs peuvent se connecter. Revenez à « Tous les comptes ».";
    return "Avec « Administrateurs seulement », les autres comptes se connectent par un fournisseur actif.";
  });

  /** Recopie l'état lu ; un champ des réglages modifié à l'écran n'est écrasé que pour la carte enregistrée (`forcer`). */
  function appliquer(r: ReglagesAuthConsole, forcer: "url" | "mode" | null = null): void {
    const garderUrl = authUrlModifiee.value && forcer !== "url";
    const garderMode = authModeModifie.value && forcer !== "mode";
    authEtat.value = r;
    if (!garderUrl) authUrl.value = r.public_url;
    if (!garderMode) authMode.value = r.local.mode;
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

  /** Enregistre la carte « Adresse publique » ou « Mots de passe locaux » : seul son champ part. */
  async function authEnregistrerReglages(partie: "url" | "mode"): Promise<boolean> {
    const etat = authEtat.value;
    if (!etat || authBusy.value) return false;
    const corps: Record<string, unknown> = {};
    if (partie === "url" && authUrlModifiee.value) corps["public_url"] = authUrl.value.trim();
    if (partie === "mode" && authModeModifie.value) corps["local"] = { mode: authMode.value };
    if (Object.keys(corps).length === 0) return true;
    if (corps["local"] && authMode.value === "admins") {
      if (authModeAdminsRaison.value !== "") return false;
      const ok = await ctx.openConfirm(
        "Connexion locale réservée aux administrateurs",
        "Seuls les administrateurs pourront encore se connecter avec un mot de passe local. Les autres comptes devront passer par un fournisseur SSO OpenID Connect actif. Les jetons, accès d'outils et routines de leurs comptes locaux seront aussi suspendus ; ils reprendront au retour au mode « Tous les comptes ».",
        true,
        "Confirmer",
      );
      if (!ok) return false;
    }
    const erreurCarte = partie === "url" ? authUrlErreur : authModeErreur;
    authBusy.value = true;
    erreurCarte.value = "";
    try {
      const { r, erreur } = await appeler("PUT", "/settings", corps);
      if (!r) {
        erreurCarte.value = erreur ?? "";
        return false;
      }
      appliquer(r, partie);
      showToast("Réglages enregistrés", "success");
      return true;
    } finally {
      authBusy.value = false;
    }
  }

  /** Oublie le résultat du test (et la réponse d'un test encore en vol). */
  function effacerEssai(): void {
    sequenceEssai += 1;
    cleEssai = "";
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

  /** Après le rendu, met le focus sur un contrôle du tiroir (sur le tiroir lui-même s'il est grisé), en faisant défiler jusqu'à sa section si `defiler`. */
  function focaliserDansTiroir(selecteur: string, defiler = false): void {
    void ctx.nextTick().then(() => {
      const tiroir = authDrawer.value;
      const cible = tiroir?.querySelector<HTMLButtonElement>(selecteur) ?? null;
      if (defiler)
        cible
          ?.closest("section")
          ?.scrollIntoView({ block: "start", behavior: mouvementReduit() ? "auto" : "smooth" });
      (cible && !cible.disabled ? cible : tiroir)?.focus({ preventScroll: defiler });
    });
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

  // Le résultat du contrôle s'efface dès que les réglages contrôlés changent à l'écran.
  watch(
    () => cleControle(authTiroir.value),
    (cle) => {
      if (cle !== cleEssai) effacerEssai();
    },
  );

  // Activé, même depuis une autre session : le tiroir est relu du serveur (libellé et fraîcheur saisis gardés) ; jamais de secret saisi.
  watch(authFournisseur, (p, avant) => {
    const f = authTiroir.value;
    if (!f || !p?.enabled) return;
    if (avant?.id === p.id && !avant.enabled) authTiroir.value = relire(p, f, avant);
    else f.secret = "";
  });

  // Identifiant d'un nouveau fournisseur déduit du libellé tant que l'administrateur ne l'a pas saisi.
  watch(
    () => authTiroir.value?.label,
    (libelle) => {
      const f = authTiroir.value;
      if (f && f.nouveau && !f.id_touche) f.id = identifiantDe(libelle ?? "");
    },
  );

  watch(e.adminTab, (page) => {
    if (page !== "oidc") {
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

  /** Raison pour laquelle un champ ne se modifie pas (texte vide : modifiable) : comptes rattachés, puis fournisseur activé (libellé et fraîcheur exceptés). */
  function authFige(champ: string): string {
    const p = authFournisseur.value;
    if (!p) return "";
    if (p.identities > 0 && FIGES_PAR_COMPTES.includes(champ))
      return "Ce réglage ne se modifie plus : des comptes sont rattachés à ce fournisseur.";
    return p.enabled && !MODIFIABLES_ACTIF.includes(champ)
      ? "Désactivez d'abord ce fournisseur pour modifier ce réglage."
      : "";
  }

  /** Phrase d'état en tête du tiroir : ce qui se modifie selon que le fournisseur est nouveau, éteint ou activé. */
  const authEtatTiroir = computed(() => {
    const f = authTiroir.value;
    const p = authFournisseur.value;
    if (!f) return "";
    if (f.nouveau || !p) return "Nouveau fournisseur : il reste éteint jusqu'à son activation (section 8).";
    if (p.enabled)
      return "Fournisseur activé : seuls le libellé (section 1) et la fraîcheur (section 6) se modifient. Pour le reste, désactivez-le (section 8) ; les sessions des comptes rattachés seront fermées.";
    return p.identities > 0
      ? "Fournisseur éteint : ses réglages se modifient, sauf l'adresse de l'émetteur, l'identifiant client et la revendication sujet, figés par les comptes rattachés."
      : "Fournisseur éteint : ses réglages se modifient.";
  });

  /** Vrai quand le tiroir diffère des réglages enregistrés (secret saisi compris) : ce qui partirait à l'enregistrement. */
  const authModifie = computed(() => {
    const f = authTiroir.value;
    const p = authFournisseur.value;
    if (!f || !p) return true;
    return (
      f.secret !== "" || JSON.stringify(corpsFournisseur(f)) !== JSON.stringify(corpsFournisseur(formDe(p)))
    );
  });

  /** Conditions d'activation d'après les réglages enregistrés, puis celle du tiroir : rien en attente d'enregistrement. */
  const authConditions = computed((): ConditionActivation[] =>
    authEtat.value
      ? [
          ...conditionsActivation(authEtat.value, authFournisseur.value),
          {
            id: "saved",
            libelle: "Modifications enregistrées",
            ok: !authModifie.value,
            raison: "Enregistrez d'abord vos modifications.",
            inoperant: "",
          },
        ]
      : [],
  );

  /** Raison pour laquelle le fournisseur ne peut pas être activé (texte vide : activable). */
  const authRaisonActiver = computed(() => {
    if (!authEtat.value || !authTiroir.value) return "";
    if (!authFournisseur.value) return "Enregistrez d'abord ce fournisseur.";
    return authConditions.value.find((c) => !c.ok)?.raison ?? "";
  });

  /** Raison pour laquelle « Se connecter pour essayer » est indisponible (texte vide : disponible). */
  const authRaisonTrial = computed(() => {
    const f = authTiroir.value;
    if (!f) return "";
    if (f.nouveau || !authFournisseur.value)
      return "Enregistrez d'abord ce fournisseur : l'essai part des réglages enregistrés.";
    if (authFournisseur.value.enabled) return "Désactivez d'abord ce fournisseur pour l'essayer.";
    return authEtat.value?.public_url === "" ? "Renseignez d'abord l'adresse publique en https." : "";
  });

  /** Adresses à déclarer chez un fournisseur OIDC ; vides tant que l'adresse publique ou l'identifiant manque. */
  const authAdresses = computed(() => {
    const f = authTiroir.value;
    const base = authEtat.value?.public_url ?? "";
    const id = f?.id.trim() ?? "";
    if (!f || base === "" || !REGEX_ID_FOURNISSEUR.test(id)) return null;
    return {
      retour: `${base}/api/auth/oidc/${id}/callback`,
      deconnexion: `${base}/api/auth/oidc/${id}/backchannel-logout`,
    };
  });
  /** Ce qui manque pour écrire les adresses à déclarer (texte vide : rien). */
  const authAdressesManque = computed(() => {
    const id = authTiroir.value?.id.trim() ?? "";
    if ((authEtat.value?.public_url ?? "") === "")
      return "Adresse publique manquante : renseignez-la dans la carte « 1. Prérequis ».";
    if (id === "") return "Identifiant dans Elpis manquant : renseignez-le en section 1.";
    return REGEX_ID_FOURNISSEUR.test(id)
      ? ""
      : "Identifiant dans Elpis invalide : minuscules, chiffres et tirets, 31 caractères au plus.";
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

  /** Crée ou modifie le fournisseur du tiroir, puis range le secret saisi s'il reste désactivé ; après un ajout, le tiroir reste ouvert sur lui pour la vérification et l'activation, et en cas d'échec. */
  async function authEnregistrer(): Promise<boolean> {
    const f = authTiroir.value;
    const etat = authEtat.value;
    if (!f || !etat || authBusy.value) return false;
    authTiroirErreur.value = "";
    const actif = authFournisseur.value?.enabled ? authFournisseur.value : null;
    if (!actif && authRolesBloque.value) return false;
    const confirmer = !actif && authAdminAConfirmer.value;
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
    const ajout = f.nouveau;
    const cleAvant = cleControle(f);
    let secretParti = false;
    try {
      if (actif) {
        const corps = corpsActif(f, actif);
        if (typeof corps === "string") {
          authTiroirErreur.value = corps;
          return false;
        }
        const enregistre = { ...formDe(actif), label: f.label, freshness_days: f.freshness_days };
        const ecarte =
          f.secret !== "" ||
          JSON.stringify(corpsFournisseur(enregistre)) !== JSON.stringify(corpsFournisseur(f));
        if (corps) {
          const { r, erreur } = await appeler("PUT", `/providers/${encodeURIComponent(f.id)}`, corps);
          if (!r) {
            authTiroirErreur.value = erreur ?? "";
            return false;
          }
          appliquer(r);
        }
        if (ecarte) {
          const p = authFournisseur.value;
          if (p && authTiroir.value === f) authTiroir.value = relire(p, f, actif);
          authTiroirErreur.value =
            "Seuls le libellé et la fraîcheur s'enregistrent tant que ce fournisseur est activé : vos autres modifications n'ont pas été envoyées. Désactivez-le pour les faire.";
          return false;
        }
      } else {
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
        if (f.secret !== "") {
          if (authFournisseur.value?.enabled) {
            authTiroirErreur.value =
              "Réglages enregistrés, sauf le secret : ce fournisseur vient d'être activé. Désactivez-le pour changer le secret.";
            return false;
          }
          if (!(await envoyerSecret(f.id, f.secret))) return false;
          f.secret = "";
          secretParti = true;
        }
      }
      showToast("Fournisseur enregistré", "success");
      const cree = ajout ? authFournisseur.value : null;
      if (!cree) {
        authFermer();
        return true;
      }
      if (authTiroir.value === f) {
        authTiroir.value = formDe(cree);
        if (secretParti) effacerEssai();
        else if (cleEssai === cleAvant) cleEssai = cleControle(authTiroir.value);
      }
      focaliserDansTiroir("#ent-trial", true);
      return true;
    } finally {
      authBusy.value = false;
    }
  }

  async function authSupprimerSecret(): Promise<void> {
    const f = authTiroir.value;
    if (!f || f.nouveau || authBusy.value || authFournisseur.value?.enabled !== false) return;
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

  /** Teste les réglages du formulaire tels quels ; le résultat s'efface dès que ces réglages changent à l'écran. */
  async function authTester(): Promise<void> {
    const f = authTiroir.value;
    const etat = authEtat.value;
    if (!f || !etat || authEssaiEnCours.value) return;
    const corps = corpsControle(f);
    if (typeof corps === "string") {
      authEssaiErreur.value = corps;
      authEssai.value = null;
      return;
    }
    const moi = ++sequenceEssai;
    cleEssai = JSON.stringify(corps);
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
    } finally {
      if (jeton === sequenceTrial) authTrialEnCours.value = false;
    }
  }

  /** Active ou désactive le fournisseur du tiroir, puis recharge le tiroir depuis l'état rendu ; le focus reste sur le bouton. */
  async function authBasculer(activer: boolean): Promise<boolean> {
    const f = authTiroir.value;
    const p = authFournisseur.value;
    if (!f || !p || authBusy.value) return false;
    if (activer && authRaisonActiver.value !== "") return false;
    if (!activer) {
      const ok = await ctx.openConfirm(
        "Désactiver ce fournisseur",
        `Les sessions des comptes rattachés à « ${p.label} » seront fermées : ces personnes devront se reconnecter autrement.${authModifie.value ? " Vos modifications non enregistrées seront perdues." : ""}`,
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
      const relu = r.providers.find((x) => x.id === f.id);
      if (relu && authTiroir.value === f) authTiroir.value = formDe(relu);
      return true;
    } finally {
      authBusy.value = false;
      focaliserDansTiroir("[data-bascule] button");
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
    authListeErreur.value = "";
    try {
      const { erreur } = await appeler("DELETE", `/providers/${encodeURIComponent(id)}`);
      if (erreur !== undefined) {
        if (ouvert) authTiroirErreur.value = erreur;
        else authListeErreur.value = erreur;
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
    authUrlErreur,
    authModeErreur,
    authListeErreur,
    authUrlModifiee,
    authModeModifie,
    authUrlFigee,
    authModeAdminsRaison,
    authModeAide,
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
    authAdressesManque,
    authEtatTiroir,
    authConditions,
    authRaisonActiver,
    authRaisonTrial,
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
