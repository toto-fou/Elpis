// SPDX-License-Identifier: MIT
/** apps/core/src/git/connecteurs.ts — comptes git (connecteurs) par compte (shared_infra/git/connectors.py) : jeton en écriture seule dans le coffre « Secrets » (genre `git`, portée : l'hôte, avec un chemin d'organisation ou de dépôt facultatif), relu côté serveur seulement, jamais rendu par les vues publiques ; le compte le plus précis qui couvre un dépôt le sert. */
import {
  hostname,
  lowerPy,
  port,
  rstripPy,
  stripPy,
  strPy,
  urlsplit,
  veritePy,
  versFlottantPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { nomDeriveCoffre } from "@elpis/db";
import type { Base, Executeur, Valeur } from "@elpis/db";
import { urlNonAmbigue } from "@elpis/securite";

import { ErreurSecret } from "../secrets/erreurs";
import { cheminCouvre, cheminExact, hoteExact, porteeGit, validerIdentifiant } from "../secrets/portee";
import {
  creerSecret,
  dechiffrerLigne,
  lignesDe,
  lireLigne,
  modifierSecret,
  porteeDe,
  supprimerSecret,
  verifierSecret,
} from "../secrets/stockage";
import type { Acteur, LigneSecret } from "../secrets/stockage";
import { lireSecretPourUsage, permisPourContexte } from "../secrets/usage";
import { detectProvider } from "./detection";
import { getProvider, hostIsPrivate } from "./fournisseurs";

export const PROVIDER_TYPES: readonly string[] = [
  "github",
  "gitlab",
  "bitbucket-cloud",
  "bitbucket-server",
  "gitea",
  "generic",
];

const COLONNES_PUBLIQUES = [
  "id",
  "owner_user_id",
  "provider_type",
  "host",
  "path",
  "api_base",
  "label",
  "username",
  "token_scheme",
  "created_at",
  "updated_at",
  "last_used",
] as const;
const REELS: ReadonlySet<string> = new Set(["created_at", "updated_at", "last_used"]);
/** Schéma du jeton : toujours dans le coffre (`token_enc` reste vide). */
const SCHEMA_COFFRE = "vault";
/** Politique des secrets git : sous-agents et routines s'en servent, comme des comptes git d'avant le coffre (même règle que la migration 0027). */
const POLITIQUE_GIT = { subagents: true, routines: true } as const;

/** Compte git lu côté serveur, sans jeton ; `secret_id` : son secret du coffre. */
export interface LigneConnecteur {
  id: number;
  owner_user_id: number;
  provider_type: string;
  host: string;
  /** Portée sur l'hôte : `""` tout l'hôte, le chemin d'une organisation ou d'un dépôt, `null` sans portée (compte inactif). */
  path: string | null;
  api_base: string;
  label: string;
  username: string;
  secret_id: number | null;
  [colonne: string]: unknown;
}

/** Un autre compte git du même propriétaire a déjà exactement cette portée. */
export class PorteePrise extends Error {
  override readonly name = "PorteePrise";
  readonly hote: string;
  readonly chemin: string;

  constructor(hote: string, chemin: string) {
    super(`portée déjà prise : ${chemin ? `${hote}/${chemin}` : hote}`);
    this.hote = hote;
    this.chemin = chemin;
  }
}

/** Contexte d'une lecture du jeton (politique et journal du coffre) : acteur, conversation, run de routine, sous-agent, routine ; le propriétaire est celui du compte git. */
export interface ContexteGit {
  readonly acteur: Acteur;
  readonly chatId: string | null;
  readonly run: string | null;
  readonly sousAgent: boolean;
  readonly routine: boolean;
}

/** Lecture par l'utilisateur lui-même (page Comptes Git) : ni conversation, ni sous-agent, ni routine. */
export function contexteUtilisateur(acteur: Acteur): ContexteGit {
  return { acteur, chatId: null, run: null, sousAgent: false, routine: false };
}

/** Provenance d'un jeton qu'aucun humain n'a saisi : le fichier `/work/.git-credentials.json` du bac, que l'agent peut écrire. */
export type SourceJeton = "sandbox-file";

function colonnes(r: Record<string, unknown>): Dict {
  const d: Dict = {};
  for (const k of COLONNES_PUBLIQUES) {
    const v = r[k];
    d[k] = REELS.has(k) && typeof v === "number" ? versFlottantPy(v) : (v ?? null);
  }
  return d;
}

function ligneDe(r: Record<string, unknown>): LigneConnecteur {
  const sid = r["secret_id"];
  const chemin = r["path"];
  return {
    ...r,
    id: Number(r["id"]),
    owner_user_id: Number(r["owner_user_id"]),
    provider_type: strPy(r["provider_type"] ?? ""),
    host: strPy(r["host"] ?? ""),
    path: chemin === null || chemin === undefined ? null : strPy(chemin),
    api_base: strPy(r["api_base"] ?? ""),
    label: strPy(r["label"] ?? ""),
    username: strPy(r["username"] ?? ""),
    secret_id: sid === null || sid === undefined ? null : Number(sid),
  };
}

type PorteeCompte = Pick<LigneConnecteur, "host" | "path">;

/** Portée du coffre d'un compte git : son hôte, et son chemin s'il en a un. */
function porteeDuCompte(l: PorteeCompte): { host: string; path?: string } {
  return l.path ? { host: l.host, path: l.path } : { host: l.host };
}

/** Cible d'une lecture du jeton : le dépôt joint (`chemin`), sinon la portée même du compte (test, liste des dépôts). */
function cibleDuCompte(l: PorteeCompte, chemin?: string | null): string {
  const c = chemin === undefined ? l.path : chemin;
  return c ? `${l.host}/${c}` : l.host;
}

/** Secret utilisable par ce compte git : genre `git`, actif, portée sur son hôte et son chemin (un compte sans portée garde celle du secret), déchiffrable par la clé courante. */
function jetonLisible(s: LigneSecret | undefined, l: PorteeCompte): boolean {
  if (s === undefined || s.kind !== "git" || s.state !== "active") return false;
  const p = porteeGit(porteeDe(s));
  if (p.host !== hoteExact(l.host) || (l.path !== null && p.path !== l.path)) return false;
  try {
    return dechiffrerLigne(s) !== "";
  } catch {
    return false;
  }
}

/** `_public` : vue sans jeton (réponses HTTP) ; `has_token` vrai seulement si le jeton du coffre est utilisable. */
function publique(r: Record<string, unknown>, secrets: ReadonlyMap<number, LigneSecret>): Dict {
  const l = ligneDe(r);
  const s = l.secret_id === null ? undefined : secrets.get(l.secret_id);
  return { ...colonnes(r), has_token: jetonLisible(s, l) };
}

function maintenant(): number {
  return Date.now() / 1000;
}

export async function listConnectors(x: Executeur, uid: number): Promise<Dict[]> {
  const lignes = await x.all<Record<string, unknown>>(
    "SELECT * FROM git_connectors WHERE owner_user_id=? ORDER BY host ASC, COALESCE(path, '') ASC, label ASC",
    [uid],
  );
  const secrets = new Map((await lignesDe(x, uid, "git")).map((s) => [Number(s.id), s] as const));
  return lignes.map((r) => publique(r, secrets));
}

/** Compte git du compte `uid`, sans jeton ; `null` s'il n'existe pas. */
export async function getConnector(x: Executeur, uid: number, cid: number): Promise<LigneConnecteur | null> {
  const r = await x.get<Record<string, unknown>>(
    "SELECT * FROM git_connectors WHERE id=? AND owner_user_id=?",
    [cid, uid],
  );
  return r ? ligneDe(r) : null;
}

/** Identifiant (non secret) recopié dans le coffre ; refusé par ses règles : aucun. */
function identifiant(u: string): string | null {
  try {
    return validerIdentifiant(u);
  } catch {
    return null;
  }
}

/** Nom libre dérivé de l'hôte, du chemin et du libellé (`git-<hôte>-<chemin>-<libellé>`), hors celui du secret `sauf`. */
async function nomLibre(x: Executeur, l: LigneConnecteur, sauf?: string): Promise<string> {
  const lus = await x.all<{ name: string }>("SELECT name FROM vault_secrets WHERE user_id = ?", [
    l.owner_user_id,
  ]);
  return nomDeriveCoffre(
    ["git", l.host, l.path ?? "", l.label],
    new Set(lus.map((r) => r.name).filter((n) => n !== sauf)),
  );
}

/** Refuse (`PorteePrise`) la portée qu'un autre compte git du propriétaire a déjà. */
async function exigerPorteeLibre(
  x: Executeur,
  uid: number,
  hote: string,
  chemin: string,
  sauf = 0,
): Promise<void> {
  const pris = await x.get<{ id: number }>(
    "SELECT id FROM git_connectors WHERE owner_user_id=? AND host=? AND path=? AND id<>?",
    [uid, hote, chemin, sauf],
  );
  if (pris) throw new PorteePrise(hote, chemin);
}

/** Secret git du compte git, s'il existe encore (supprimé dans Secrets : `null`). */
async function secretDe(x: Executeur, l: LigneConnecteur): Promise<LigneSecret | null> {
  if (l.secret_id === null) return null;
  const s = await lireLigne(x, l.owner_user_id, l.secret_id);
  return s !== null && s.kind === "git" ? s : null;
}

/** Jeton écrit dans le coffre : secret du compte git mis à jour (valeur, portée sur l'hôte et le chemin, identifiant ; renommé si l'hôte change ; saisi par l'humain, un secret à vérifier devient utilisable), sinon créé et relié ; d'une `source` sans humain, créé à vérifier (`unverified`). */
async function ecrireJeton(
  base: Base,
  l: LigneConnecteur,
  jeton: string,
  acteur: Acteur,
  source?: SourceJeton,
): Promise<void> {
  const uid = l.owner_user_id;
  const s = await secretDe(base, l);
  if (s !== null) {
    if (source !== undefined) return;
    const hoteChange = porteeGit(porteeDe(s)).host !== hoteExact(l.host);
    const nom = hoteChange ? await nomLibre(base, l, s.name) : s.name;
    const aVerifier = s.state === "unverified";
    await modifierSecret(
      base,
      uid,
      Number(s.id),
      {
        value: jeton,
        scope: porteeDuCompte(l),
        username: identifiant(l.username),
        ...(nom === s.name ? {} : { name: nom }),
        ...(aVerifier ? { meta: { connector_id: l.id } } : {}),
      },
      acteur,
    );
    if (aVerifier) await verifierSecret(base, uid, Number(s.id), acteur);
    return;
  }
  const cree = await creerSecret(
    base,
    uid,
    {
      kind: "git",
      name: await nomLibre(base, l),
      scope: porteeDuCompte(l),
      username: identifiant(l.username),
      value: jeton,
      policy: POLITIQUE_GIT,
      meta: { connector_id: l.id, ...(source === undefined ? {} : { source }) },
      ...(source === undefined ? {} : { state: "unverified" as const }),
    },
    acteur,
  );
  await base.run("UPDATE git_connectors SET secret_id=?, token_enc='', token_scheme=? WHERE id=?", [
    cree.id,
    SCHEMA_COFFRE,
    l.id,
  ]);
}

/** Compte git créé pour sa portée (`path` en forme, mis à la casse de son type ; absent : tout l'hôte ; déjà prise : `PorteePrise`), son jeton écrit dans le coffre (une seule transaction ; à vérifier s'il vient d'une `source` sans humain) ; son id. */
export async function createConnector(
  base: Base,
  uid: number,
  providerType: string,
  host: string,
  champs: {
    token: string;
    path?: string;
    apiBase?: string;
    label?: string;
    username?: string;
    source?: SourceJeton;
  },
  acteur: Acteur,
): Promise<number> {
  const t = maintenant();
  const hote = lowerPy(host || "");
  const chemin = cheminPourType(champs.path ?? "", providerType);
  return base.ecriture(async () => {
    await exigerPorteeLibre(base, uid, hote, chemin);
    const id = await base.insertId(
      "INSERT INTO git_connectors(owner_user_id, provider_type, host, path, api_base, label, username, token_enc, token_scheme, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      [
        uid,
        providerType,
        hote,
        chemin,
        champs.apiBase || "",
        champs.label || "",
        champs.username || "",
        "",
        SCHEMA_COFFRE,
        t,
        t,
      ],
    );
    if (champs.token)
      await ecrireJeton(
        base,
        (await getConnector(base, uid, id)) as LigneConnecteur,
        champs.token,
        acteur,
        champs.source,
      );
    return id;
  });
}

export type ChampsConnecteur = Partial<
  Record<"provider_type" | "host" | "path" | "api_base" | "label" | "username" | "token", string | null>
>;

/** API que joint le jeton d'un compte git : celle de son type pour son hôte (surcharge comprise). */
function apiEffective(l: LigneConnecteur): string {
  return getProvider(l.provider_type).apiBase(l.host, l.api_base || "");
}

/** `update_connector` : champs non nuls remplacés (`path` en forme, mis à la casse du type ; portée prise par un autre compte : `PorteePrise`), jeton seulement s'il est non vide (dans le coffre) ; l'hôte ou l'API effective (type compris) changés sans nouveau jeton effacent le jeton (secret du coffre ou ancien clair pas encore migré), qui ne suit jamais le compte ailleurs ; un chemin élargi sans nouveau jeton est refusé par le coffre (`secret_value_required`) ; faux si rien à faire ou introuvable. */
export async function updateConnector(
  base: Base,
  uid: number,
  cid: number,
  champs: ChampsConnecteur,
  acteur: Acteur,
): Promise<boolean> {
  return base.ecriture(async () => {
    const avant = await getConnector(base, uid, cid);
    if (avant === null) return false;
    const sets: string[] = [];
    const vals: Valeur[] = [];
    const apres: LigneConnecteur = { ...avant };
    for (const k of ["provider_type", "host", "api_base", "label", "username"] as const) {
      const v = champs[k];
      if (v === null || v === undefined) continue;
      sets.push(`${k}=?`);
      vals.push(k === "host" ? lowerPy(v) : v);
      apres[k] = k === "host" ? lowerPy(v) : v;
    }
    const voulu = champs.path === null || champs.path === undefined ? avant.path : champs.path;
    apres.path = voulu === null ? null : cheminPourType(voulu, apres.provider_type);
    if (apres.path !== avant.path) {
      sets.push("path=?");
      vals.push(apres.path);
    }
    const jeton = champs.token || "";
    if (sets.length === 0 && !jeton) return false;
    const porteeChange = apres.path !== null && (apres.host !== avant.host || apres.path !== avant.path);
    if (porteeChange) await exigerPorteeLibre(base, uid, apres.host, apres.path as string, cid);
    const secret = await secretDe(base, avant);
    const ailleurs = apres.host !== avant.host || apiEffective(apres) !== apiEffective(avant);
    const effacer = !jeton && ailleurs && (secret !== null || strPy(avant["token_enc"] ?? "") !== "");
    if (effacer) sets.push("secret_id=NULL", "token_enc=''", `token_scheme='${SCHEMA_COFFRE}'`);
    if (sets.length > 0) {
      sets.push("updated_at=?");
      vals.push(maintenant(), cid, uid);
      await base.run(`UPDATE git_connectors SET ${sets.join(", ")} WHERE id=? AND owner_user_id=?`, vals);
    } else await base.run("UPDATE git_connectors SET updated_at=? WHERE id=?", [maintenant(), cid]);
    if (jeton) await ecrireJeton(base, apres, jeton, acteur);
    else if (effacer) {
      if (secret !== null) await supprimerSecret(base, uid, Number(secret.id), acteur);
    } else if (secret !== null) {
      const chemin = apres.path !== avant.path && apres.path !== null;
      const login = apres.username !== avant.username && jetonLisible(secret, avant);
      if (chemin || login)
        await modifierSecret(
          base,
          uid,
          Number(secret.id),
          {
            ...(chemin ? { scope: porteeDuCompte(apres) } : {}),
            ...(login ? { username: identifiant(apres.username) } : {}),
          },
          acteur,
        );
    }
    return true;
  });
}

/** Compte git supprimé avec son secret du coffre ; faux s'il est introuvable. */
export async function deleteConnector(
  base: Base,
  uid: number,
  cid: number,
  acteur: Acteur,
): Promise<boolean> {
  return base.ecriture(async () => {
    const l = await getConnector(base, uid, cid);
    if (l === null) return false;
    const s = await secretDe(base, l);
    await base.run("DELETE FROM git_connectors WHERE id=? AND owner_user_id=?", [cid, uid]);
    if (s !== null) await supprimerSecret(base, uid, Number(s.id), acteur);
    return true;
  });
}

/** Comptes git de l'hôte (toutes portées, comptes sans portée compris), sans jeton, le plus récemment utilisé d'abord. */
export async function findForHost(x: Executeur, uid: number, host: string): Promise<LigneConnecteur[]> {
  const lignes = await x.all<Record<string, unknown>>(
    "SELECT * FROM git_connectors WHERE owner_user_id=? AND host=? ORDER BY COALESCE(last_used,0) DESC, created_at DESC",
    [uid, lowerPy(host || "")],
  );
  return lignes.map(ligneDe);
}

/** Hôte exact (port compris) déjà enregistré par le compte ou par un admin (`is_admin = 1`). */
export async function hoteEnregistre(x: Executeur, uid: number, host: string): Promise<boolean> {
  const r = await x.get<{ un: unknown }>(
    "SELECT 1 AS un FROM git_connectors c LEFT JOIN users u ON u.id = c.owner_user_id WHERE c.host=? AND (c.owner_user_id=? OR u.is_admin=1) LIMIT 1",
    [lowerPy(host || ""), uid],
  );
  return r !== undefined && r !== null;
}

/** Jeton du compte git lu dans le coffre pour le dépôt joint (`chemin` ; absent : la portée même du compte), compté et journalisé ; absent, illisible, hors de sa portée ou refusé (journalisé) : `""`. */
export async function jetonDuConnecteur(
  base: Base,
  l: LigneConnecteur,
  contexte: ContexteGit,
  chemin?: string | null,
): Promise<string> {
  const s = await secretDe(base, l);
  if (s === null) return "";
  try {
    const r = await lireSecretPourUsage(
      base,
      { usage: "git", cible: cibleDuCompte(l, chemin), nom: s.name },
      { ...contexte, proprietaire: l.owner_user_id, exigeAttachement: false },
    );
    return r.secret;
  } catch (e) {
    if (e instanceof ErreurSecret) return "";
    throw e;
  }
}

/** `list_connector_hosts` : hôtes enregistrés (liste blanche SSRF) ; le rappel vers l'app n'existe que sur un hôte d'outils. */
export async function listConnectorHosts(x: Executeur, uid: number): Promise<string[]> {
  const lignes = await x.all<{ host: unknown }>(
    "SELECT DISTINCT host FROM git_connectors WHERE owner_user_id=?",
    [uid],
  );
  return lignes.filter((r) => veritePy(r.host)).map((r) => r.host as string);
}

/** `bump_last_used` : au mieux, une écriture manquée ne gêne jamais la résolution. */
export async function bumpLastUsed(x: Executeur, cid: number): Promise<void> {
  await x.run("UPDATE git_connectors SET last_used=? WHERE id=?", [maintenant(), cid]).catch(() => undefined);
}

export interface IdentifiantGit {
  username: string;
  token: string;
  provider_type: string;
  host: string;
  api_base: string;
  connector_id: number;
}

/** Hôte détecté s'il est celui que joint une connexion à l'URL (`hôte[:port]` d'`urlsplit`, même lecture par WHATWG), sinon `""`. */
export function hoteJoint(remoteUrl: string, detecte: string): string {
  const url = stripPy(remoteUrl);
  if (!url.includes("://")) return detecte;
  try {
    const p = urlsplit(url);
    const h = hostname(p) ?? "";
    const n = port(p);
    const joint = `${h.includes(":") ? `[${h}]` : h}${n === null ? "" : `:${n}`}`;
    return joint === detecte && urlNonAmbigue(url) ? detecte : "";
  } catch {
    return "";
  }
}

/** Dépôt en `http://` : l'identifiant ne part en clair que vers un hôte du réseau local ou un connecteur dont l'API est en http. */
function clairPermis(remoteUrl: string, host: string, apiBase: string): boolean {
  return (
    !stripPy(remoteUrl).toLowerCase().startsWith("http://") ||
    hostIsPrivate(host) ||
    apiBase.startsWith("http://")
  );
}

/** Chemin tel que le compare un compte de ce type : sans la casse pour les forges qui l'ignorent, exact pour un service générique. */
export function cheminPourType(chemin: string, type: string): string {
  return type === "generic" ? chemin : chemin.toLowerCase();
}

/** Chemin du dépôt d'une URL, lu comme le relais git le joint (chemin de l'URL, barres finales et un `.git` retirés, rien d'autre), casse gardée ; forme SSH : celui de `detectProvider` ; `null` s'il n'est pas fait de segments simples (requête, encodage, `@`, segment vide, second `.git`) ou n'en a qu'un. */
export function cheminDeLUrl(remoteUrl: string): string | null {
  const url = stripPy(remoteUrl || "");
  let brut: string;
  if (url.includes("://")) {
    let chemin: string;
    try {
      const p = urlsplit(url);
      if (p.query || p.fragment || !p.path.startsWith("/")) return null;
      chemin = rstripPy(p.path, "/");
    } catch {
      return null;
    }
    brut = (chemin.endsWith(".git") ? chemin.slice(0, -4) : chemin).slice(1);
  } else {
    const info = detectProvider(url);
    if (!info) return null;
    brut = `${info.owner}/${info.repo}`;
  }
  const lu = cheminExact(brut);
  return lu !== null && lu.includes("/") ? lu : null;
}

/** Compte le plus précis qui couvre `chemin` parmi ceux d'un hôte : le plus long chemin, comparé selon le type de chaque compte ; un compte sans portée ne sert pas ; un dépôt illisible (`null`) n'a de compte que si aucun compte de l'hôte n'est borné à un chemin ; `undefined` si aucun. */
export function compteCouvrant(
  comptes: readonly LigneConnecteur[],
  chemin: string | null,
): LigneConnecteur | undefined {
  if (chemin === null && comptes.some((l) => Boolean(l.path))) return undefined;
  let retenu: LigneConnecteur | undefined;
  for (const l of comptes) {
    if (l.path === null) continue;
    if (!cheminCouvre(l.path, chemin === null ? null : cheminPourType(chemin, l.provider_type))) continue;
    if (retenu === undefined || l.path.length > (retenu.path ?? "").length) retenu = l;
  }
  return retenu;
}

/** Compte git de l'hôte exact du dépôt, port compris (aucun repli par type), le plus précis qui couvre son chemin, et son API ; `null` sans compte, ou si l'identifiant partirait en clair vers un hôte public. */
async function compteDuDepot(
  base: Base,
  uid: number,
  remoteUrl: string,
): Promise<{ l: LigneConnecteur; host: string; apiBase: string; chemin: string | null } | null> {
  if (!uid || !remoteUrl) return null;
  const info = detectProvider(remoteUrl);
  if (!info) return null;
  const host = hoteJoint(remoteUrl, lowerPy(info.host || ""));
  const chemin = cheminDeLUrl(remoteUrl);
  const l = host ? compteCouvrant(await findForHost(base, uid, host), chemin) : undefined;
  if (!l) return null;
  const apiBase = getProvider(l.provider_type).apiBase(host, l.api_base || "");
  const cible = chemin === null ? null : cheminPourType(chemin, l.provider_type);
  return clairPermis(remoteUrl, host, apiBase) ? { l, host, apiBase, chemin: cible } : null;
}

/** `resolve_git_credential` : compte git de l'hôte exact du dépôt qui couvre son chemin, jamais en clair vers un hôte public ; jeton lu dans le coffre pour ce dépôt (compté, journalisé), `last_used` mis à jour ; `null` sans compte ni jeton utilisable. */
export async function resolveGitCredential(
  base: Base,
  uid: number,
  remoteUrl: string,
  contexte: ContexteGit,
): Promise<IdentifiantGit | null> {
  const c = await compteDuDepot(base, uid, remoteUrl);
  if (c === null) return null;
  const token = await jetonDuConnecteur(base, c.l, contexte, c.chemin);
  if (!token) return null;
  await bumpLastUsed(base, c.l.id);
  return {
    username: strPy(c.l.username || ""),
    token,
    provider_type: c.l.provider_type,
    host: c.host,
    api_base: c.apiBase,
    connector_id: c.l.id,
  };
}

/** Un jeton que `resolveGitCredential` rendrait à ce contexte existe (compte de l'hôte exact, secret actif, portée, politique, attachement, clé courante), sans être lu : rien n'est compté ni journalisé. */
export async function identifiantGitDisponible(
  base: Base,
  uid: number,
  remoteUrl: string,
  contexte: ContexteGit,
): Promise<boolean> {
  const c = await compteDuDepot(base, uid, remoteUrl);
  const s = c === null ? null : await secretDe(base, c.l);
  if (c === null || s === null || !jetonLisible(s, c.l)) return false;
  return permisPourContexte(base, s, {
    ...contexte,
    proprietaire: c.l.owner_user_id,
    exigeAttachement: false,
  });
}
