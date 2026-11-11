// SPDX-License-Identifier: MIT
/** apps/core/src/git/connecteurs.ts — comptes git (connecteurs) par compte (shared_infra/git/connectors.py) : jeton en écriture seule dans le coffre « Secrets » (genre `git`, portée : l'hôte), relu côté serveur seulement, jamais rendu par les vues publiques. */
import { hostname, lowerPy, port, stripPy, strPy, urlsplit, veritePy, versFlottantPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Base, Executeur, Valeur } from "@elpis/db";
import { nomDeriveCoffre, urlNonAmbigue } from "@elpis/securite";

import { ErreurSecret } from "../secrets/erreurs";
import { hoteExact, validerIdentifiant } from "../secrets/portee";
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
  api_base: string;
  label: string;
  username: string;
  secret_id: number | null;
  [colonne: string]: unknown;
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
  return {
    ...r,
    id: Number(r["id"]),
    owner_user_id: Number(r["owner_user_id"]),
    provider_type: strPy(r["provider_type"] ?? ""),
    host: strPy(r["host"] ?? ""),
    api_base: strPy(r["api_base"] ?? ""),
    label: strPy(r["label"] ?? ""),
    username: strPy(r["username"] ?? ""),
    secret_id: sid === null || sid === undefined ? null : Number(sid),
  };
}

/** Secret utilisable par ce compte git : genre `git`, actif, portée sur son hôte, déchiffrable par la clé courante. */
function jetonLisible(s: LigneSecret | undefined, hote: string): boolean {
  if (s === undefined || s.kind !== "git" || s.state !== "active") return false;
  if ((porteeDe(s) as { host?: unknown }).host !== hoteExact(hote)) return false;
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
  return { ...colonnes(r), has_token: jetonLisible(s, l.host) };
}

function maintenant(): number {
  return Date.now() / 1000;
}

export async function listConnectors(x: Executeur, uid: number): Promise<Dict[]> {
  const lignes = await x.all<Record<string, unknown>>(
    "SELECT * FROM git_connectors WHERE owner_user_id=? ORDER BY host ASC, label ASC",
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

/** Nom libre dérivé de l'hôte et du libellé (`git-<hôte>-<libellé>`), hors celui du secret `sauf`. */
async function nomLibre(
  x: Executeur,
  uid: number,
  hote: string,
  libelle: string,
  sauf?: string,
): Promise<string> {
  const lus = await x.all<{ name: string }>("SELECT name FROM vault_secrets WHERE user_id = ?", [uid]);
  return nomDeriveCoffre(["git", hote, libelle], new Set(lus.map((r) => r.name).filter((n) => n !== sauf)));
}

/** Secret git du compte git, s'il existe encore (supprimé dans Secrets : `null`). */
async function secretDe(x: Executeur, l: LigneConnecteur): Promise<LigneSecret | null> {
  if (l.secret_id === null) return null;
  const s = await lireLigne(x, l.owner_user_id, l.secret_id);
  return s !== null && s.kind === "git" ? s : null;
}

/** Jeton écrit dans le coffre : secret du compte git mis à jour (valeur, portée, identifiant ; renommé si l'hôte change ; saisi par l'humain, un secret à vérifier devient utilisable), sinon créé et relié ; d'une `source` sans humain, créé à vérifier (`unverified`). */
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
    const hoteChange = (porteeDe(s) as { host?: unknown }).host !== hoteExact(l.host);
    const nom = hoteChange ? await nomLibre(base, uid, l.host, l.label, s.name) : s.name;
    const aVerifier = s.state === "unverified";
    await modifierSecret(
      base,
      uid,
      Number(s.id),
      {
        value: jeton,
        scope: { host: l.host },
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
      name: await nomLibre(base, uid, l.host, l.label),
      scope: { host: l.host },
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

/** Compte git créé, son jeton écrit dans le coffre (une seule transaction ; à vérifier s'il vient d'une `source` sans humain) ; son id. */
export async function createConnector(
  base: Base,
  uid: number,
  providerType: string,
  host: string,
  champs: { token: string; apiBase?: string; label?: string; username?: string; source?: SourceJeton },
  acteur: Acteur,
): Promise<number> {
  const t = maintenant();
  return base.ecriture(async () => {
    const id = await base.insertId(
      "INSERT INTO git_connectors(owner_user_id, provider_type, host, api_base, label, username, token_enc, token_scheme, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [
        uid,
        providerType,
        lowerPy(host || ""),
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
  Record<"provider_type" | "host" | "api_base" | "label" | "username" | "token", string | null>
>;

/** API que joint le jeton d'un compte git : celle de son type pour son hôte (surcharge comprise). */
function apiEffective(l: LigneConnecteur): string {
  return getProvider(l.provider_type).apiBase(l.host, l.api_base || "");
}

/** `update_connector` : champs non nuls remplacés, jeton seulement s'il est non vide (dans le coffre) ; l'hôte ou l'API effective (type compris) changés sans nouveau jeton effacent le jeton (secret du coffre ou ancien clair pas encore migré), qui ne suit jamais le compte ailleurs ; faux si rien à faire ou introuvable. */
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
    const jeton = champs.token || "";
    if (sets.length === 0 && !jeton) return false;
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
    } else if (secret !== null && apres.username !== avant.username && jetonLisible(secret, avant.host))
      await modifierSecret(base, uid, Number(secret.id), { username: identifiant(apres.username) }, acteur);
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

/** Comptes git de l'hôte, sans jeton, le plus récemment utilisé d'abord. */
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

/** Jeton du compte git lu dans le coffre (portée : son hôte), compté et journalisé ; absent, illisible ou refusé (journalisé) : `""`. */
export async function jetonDuConnecteur(
  base: Base,
  l: LigneConnecteur,
  contexte: ContexteGit,
): Promise<string> {
  const s = await secretDe(base, l);
  if (s === null) return "";
  try {
    const r = await lireSecretPourUsage(
      base,
      { usage: "git", cible: l.host, nom: s.name },
      { ...contexte, proprietaire: l.owner_user_id },
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

/** Compte git de l'hôte exact du dépôt, port compris (aucun repli par type), et son API ; `null` sans compte, ou si l'identifiant partirait en clair vers un hôte public. */
async function compteDuDepot(
  base: Base,
  uid: number,
  remoteUrl: string,
): Promise<{ l: LigneConnecteur; host: string; apiBase: string } | null> {
  if (!uid || !remoteUrl) return null;
  const info = detectProvider(remoteUrl);
  if (!info) return null;
  const host = hoteJoint(remoteUrl, lowerPy(info.host || ""));
  const l = host ? (await findForHost(base, uid, host))[0] : undefined;
  if (!l) return null;
  const apiBase = getProvider(l.provider_type).apiBase(host, l.api_base || "");
  return clairPermis(remoteUrl, host, apiBase) ? { l, host, apiBase } : null;
}

/** `resolve_git_credential` : compte git de l'hôte exact du dépôt, jamais en clair vers un hôte public ; jeton lu dans le coffre (compté, journalisé), `last_used` mis à jour ; `null` sans compte ni jeton utilisable. */
export async function resolveGitCredential(
  base: Base,
  uid: number,
  remoteUrl: string,
  contexte: ContexteGit,
): Promise<IdentifiantGit | null> {
  const c = await compteDuDepot(base, uid, remoteUrl);
  if (c === null) return null;
  const token = await jetonDuConnecteur(base, c.l, contexte);
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
  if (c === null || s === null || !jetonLisible(s, c.l.host)) return false;
  return permisPourContexte(base, s, { ...contexte, proprietaire: c.l.owner_user_id });
}
