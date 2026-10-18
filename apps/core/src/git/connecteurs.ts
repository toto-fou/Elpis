// SPDX-License-Identifier: MIT
/** apps/core/src/git/connecteurs.ts — connecteurs git par compte (shared_infra/git/connectors.py) : jeton jamais rendu par les vues publiques, lu côté serveur seulement. */
import { hostname, lowerPy, port, stripPy, strPy, urlsplit, veritePy, versFlottantPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Executeur } from "@elpis/db";
import { urlNonAmbigue } from "@elpis/securite";

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

/** Connecteur lu côté serveur, jeton compris : jamais rendu tel quel par une route. */
export interface ConnecteurSecret {
  id: number;
  owner_user_id: number;
  provider_type: string;
  host: string;
  api_base: string;
  label: string;
  username: string;
  token: string;
  [colonne: string]: unknown;
}

/** `_encode_token` : schéma `plain` comme le Python (les lecteurs Python lisent `token_enc` tel quel). */
function encoderJeton(token: string): [string, string] {
  return [token || "", "plain"];
}

function colonnes(r: Record<string, unknown>): Dict {
  const d: Dict = {};
  for (const k of COLONNES_PUBLIQUES) {
    const v = r[k];
    d[k] = REELS.has(k) && typeof v === "number" ? versFlottantPy(v) : (v ?? null);
  }
  return d;
}

/** `_public` : vue sans jeton (réponses HTTP). */
function publique(r: Record<string, unknown>): Dict {
  return { ...colonnes(r), has_token: veritePy(r["token_enc"]) };
}

/** `_with_token` : vue avec le jeton lu (`_decode_token` : tel quel). */
function avecJeton(r: Record<string, unknown>): ConnecteurSecret {
  return { ...colonnes(r), token: strPy(r["token_enc"] || "") } as ConnecteurSecret;
}

function maintenant(): number {
  return Date.now() / 1000;
}

export async function listConnectors(x: Executeur, uid: number): Promise<Dict[]> {
  const lignes = await x.all<Record<string, unknown>>(
    "SELECT * FROM git_connectors WHERE owner_user_id=? ORDER BY host ASC, label ASC",
    [uid],
  );
  return lignes.map(publique);
}

export async function createConnector(
  x: Executeur,
  uid: number,
  providerType: string,
  host: string,
  champs: { token: string; apiBase?: string; label?: string; username?: string },
): Promise<number> {
  const [enc, schema] = encoderJeton(champs.token);
  const t = maintenant();
  return x.insertId(
    "INSERT INTO git_connectors(owner_user_id, provider_type, host, api_base, label, username, token_enc, token_scheme, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [
      uid,
      providerType,
      lowerPy(host || ""),
      champs.apiBase || "",
      champs.label || "",
      champs.username || "",
      enc,
      schema,
      t,
      t,
    ],
  );
}

export type ChampsConnecteur = Partial<
  Record<"provider_type" | "host" | "api_base" | "label" | "username" | "token", string | null>
>;

/** `update_connector` : champs non nuls remplacés, jeton seulement s'il est non vide ; faux si rien à faire ou introuvable. */
export async function updateConnector(
  x: Executeur,
  uid: number,
  cid: number,
  champs: ChampsConnecteur,
): Promise<boolean> {
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  for (const k of ["provider_type", "host", "api_base", "label", "username"] as const) {
    const v = champs[k];
    if (v === null || v === undefined) continue;
    sets.push(`${k}=?`);
    vals.push(k === "host" ? lowerPy(v) : v);
  }
  if (champs.token) {
    const [enc, schema] = encoderJeton(champs.token);
    sets.push("token_enc=?", "token_scheme=?");
    vals.push(enc, schema);
  }
  if (sets.length === 0) return false;
  sets.push("updated_at=?");
  vals.push(maintenant(), cid, uid);
  const r = await x.run(`UPDATE git_connectors SET ${sets.join(", ")} WHERE id=? AND owner_user_id=?`, vals);
  return r.changes > 0;
}

export async function deleteConnector(x: Executeur, uid: number, cid: number): Promise<boolean> {
  return (await x.run("DELETE FROM git_connectors WHERE id=? AND owner_user_id=?", [cid, uid])).changes > 0;
}

/** Connecteurs de l'hôte, jeton compris, le plus récemment utilisé d'abord. */
export async function findForHost(x: Executeur, uid: number, host: string): Promise<ConnecteurSecret[]> {
  const lignes = await x.all<Record<string, unknown>>(
    "SELECT * FROM git_connectors WHERE owner_user_id=? AND host=? ORDER BY COALESCE(last_used,0) DESC, created_at DESC",
    [uid, lowerPy(host || "")],
  );
  return lignes.map(avecJeton);
}

/** Hôte exact (port compris) déjà enregistré par le compte ou par un admin (`is_admin = 1`). */
export async function hoteEnregistre(x: Executeur, uid: number, host: string): Promise<boolean> {
  const r = await x.get<{ un: unknown }>(
    "SELECT 1 AS un FROM git_connectors c LEFT JOIN users u ON u.id = c.owner_user_id WHERE c.host=? AND (c.owner_user_id=? OR u.is_admin=1) LIMIT 1",
    [lowerPy(host || ""), uid],
  );
  return r !== undefined && r !== null;
}

export async function getConnectorSecret(
  x: Executeur,
  uid: number,
  cid: number,
): Promise<ConnecteurSecret | null> {
  const r = await x.get<Record<string, unknown>>(
    "SELECT * FROM git_connectors WHERE id=? AND owner_user_id=?",
    [cid, uid],
  );
  return r ? avecJeton(r) : null;
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

/** `resolve_git_credential` : connecteur de l'hôte exact du dépôt, port compris (aucun repli par type), jamais en clair vers un hôte public ; `last_used` mis à jour ; `null` sinon. */
export async function resolveGitCredential(
  x: Executeur,
  uid: number,
  remoteUrl: string,
): Promise<IdentifiantGit | null> {
  if (!uid || !remoteUrl) return null;
  const info = detectProvider(remoteUrl);
  if (!info) return null;
  const host = hoteJoint(remoteUrl, lowerPy(info.host || ""));
  const lignes = host ? await findForHost(x, uid, host) : [];
  const l = lignes[0];
  if (!l) return null;
  const apiBase = getProvider(l.provider_type).apiBase(host, l.api_base || "");
  if (!clairPermis(remoteUrl, host, apiBase)) return null;
  await bumpLastUsed(x, l.id);
  return {
    username: strPy(l.username || ""),
    token: l.token || "",
    provider_type: l.provider_type,
    host,
    api_base: apiBase,
    connector_id: l.id,
  };
}
