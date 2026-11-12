// SPDX-License-Identifier: MIT
/** apps/core/src/llm/connecteurs.ts — connecteurs LLM en base (`shared_infra/llm/connectors.py`) : clés rangées dans le coffre et jamais renvoyées, vues publiques, champs de création, port du moteur. */
import {
  ErreurPython,
  getPy,
  HttpError,
  intPy,
  itemPy,
  nomTypePy,
  prefixePy,
  reprPy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { readConfigJson } from "@elpis/config";
import type { Base, Executeur } from "@elpis/db";

import type { Acteur } from "../secrets/stockage";
import { ACTEUR_SYSTEME, ecrireCle, lireCle, lireLien, SELECT_CONNECTEUR, supprimerCle } from "./cle-coffre";
import type { ConnecteurPublic, ConnecteurSecret, PortConnecteurs } from "./ports";

export const PROVIDER_TYPES = [
  "llamacpp",
  "vllm",
  "sglang",
  "openai",
  "anthropic",
  "mistral",
  "groq",
  "openrouter",
  "deepseek",
  "moonshot",
  "opencode",
  "generic",
] as const;

export interface Preset {
  readonly wire: string;
  readonly base_url: string;
  readonly label: string;
  readonly admin_only: boolean;
  readonly user_base_locked: boolean;
}

const nuage = (wire: string, base_url: string, label: string): Preset => ({
  wire,
  base_url,
  label,
  admin_only: false,
  user_base_locked: true,
});
const local = (label: string): Preset => ({
  wire: "openai",
  base_url: "",
  label,
  admin_only: true,
  user_base_locked: false,
});

/** Dans l'ordre du Python (le message d'erreur de `provider_type` les liste). */
export const PROVIDER_PRESETS: Readonly<Record<string, Preset>> = Object.freeze({
  anthropic: nuage("anthropic", "https://api.anthropic.com", "Anthropic (Claude)"),
  openai: nuage("openai", "https://api.openai.com/v1", "OpenAI (GPT)"),
  mistral: nuage("openai", "https://api.mistral.ai/v1", "Mistral"),
  groq: nuage("openai", "https://api.groq.com/openai/v1", "Groq"),
  openrouter: nuage("openai", "https://openrouter.ai/api/v1", "OpenRouter"),
  deepseek: nuage("openai", "https://api.deepseek.com/v1", "DeepSeek"),
  moonshot: nuage("openai", "https://api.moonshot.ai/v1", "Moonshot (Kimi)"),
  opencode: nuage("openai", "https://opencode.ai/zen/v1", "OpenCode Zen"),
  llamacpp: local("llama.cpp (local)"),
  vllm: local("vLLM (local)"),
  sglang: local("SGLang (local)"),
  generic: local("OpenAI-compatible (custom)"),
});

/** `p in PROVIDER_PRESETS` : un texte est cherché, une liste ou un dict lève (non hachable), le reste est absent. */
function estPreset(p: unknown): p is string {
  if (Array.isArray(p) || (typeof p === "object" && p !== null))
    throw new ErreurPython("TypeError", `unhashable type: '${nomTypePy(p)}'`);
  return typeof p === "string" && Object.hasOwn(PROVIDER_PRESETS, p);
}

/** Types ajoutables par un compte : fournisseurs cloud, base_url verrouillée par le preset. */
export function cloudProviderTypes(): string[] {
  return Object.entries(PROVIDER_PRESETS)
    .filter(([, v]) => !v.admin_only)
    .map(([p]) => p);
}

/** `llm.allowed_provider_types` (config donnée, sinon relue à chaud) : types ouverts aux comptes non admin ; absente, vide ou illisible = aucun (écart au Python : tous). */
export function allowedProviderTypes(cfg: unknown = null): string[] {
  let conf = cfg;
  if (conf === null || conf === undefined) {
    try {
      const lue = readConfigJson();
      conf = veritePy(lue) ? lue : {};
    } catch {
      return [];
    }
  }
  const llm = getPy(conf, "llm");
  const val = getPy(veritePy(llm) ? llm : {}, "allowed_provider_types");
  return Array.isArray(val) ? val.filter(estPreset) : [];
}

/** Types de connecteur personnel permis à un compte : tous les cloud pour un administrateur, la liste blanche sinon. */
export function typesOuverts(admin: boolean, cfg: unknown = null): string[] {
  return admin ? cloudProviderTypes() : allowedProviderTypes(cfg);
}

/** Compte administrateur (`users.is_admin` = 1, modérateurs exclus) ; base illisible = non. */
export async function compteAdmin(base: Executeur, userId: number): Promise<boolean> {
  try {
    const role = await base.valeurs("SELECT is_admin FROM users WHERE id=?", [userId]);
    return role[0] !== undefined && Number(role[0][0]) === 1;
  } catch {
    return false;
  }
}

const PUBLIC_COLS = [
  "id",
  "owner_user_id",
  "scope",
  "provider_type",
  "wire",
  "label",
  "base_url",
  "default_model",
  "models_json",
  "enabled",
  "key_scheme",
  "created_at",
  "updated_at",
  "last_used",
] as const;
const LIMIT_COLS = ["context_window", "max_models", "max_concurrency"] as const;

/** `int(v)` ; `null` là où Python lève TypeError ou ValueError. */
function entierOuNul(v: unknown): number | null {
  try {
    return intPy(v);
  } catch (e) {
    if (e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError")) return null;
    throw e;
  }
}

/** Entier > 0, sinon `null` (découverte automatique). */
export function posOrNone(v: unknown): number | null {
  const n = entierOuNul(v);
  return n !== null && n > 0 ? n : null;
}

/** Réglages de capacité (migration 0019) ; une colonne absente vaut `null`. */
export function limitsOf(row: Dict): Dict {
  const out: Dict = {};
  for (const k of LIMIT_COLS) {
    const v = Object.hasOwn(row, k) ? row[k] : null;
    out[k] = v === null || v === undefined ? null : posOrNone(v);
  }
  return out;
}

function colonnesPubliques(row: Dict): Dict {
  const d: Dict = {};
  for (const k of PUBLIC_COLS) d[k] = itemPy(row, k);
  return d;
}

/** Vue SANS clé (`_public`) : `has_key` vrai pour une clé du coffre déchiffrable avec la clé courante, sinon `key_error` dit pourquoi. */
export function vuePublique(row: Dict): Dict {
  const d = colonnesPubliques(row);
  const { cle, erreur } = lireCle(row);
  d["has_key"] = erreur === null && cle !== "";
  d["key_error"] = erreur;
  d["enabled"] = veritePy(d["enabled"]);
  return { ...d, ...limitsOf(row) };
}

/** Vue AVEC clé déchiffrée du coffre (`_with_key`) : côté serveur seulement, jamais sérialisée vers HTTP ; clé inutilisable : `api_key` vide et `key_error`. */
export function vueAvecCle(row: Dict): Dict {
  const d = colonnesPubliques(row);
  d["enabled"] = veritePy(d["enabled"]);
  const { cle, erreur } = lireCle(row);
  return { ...d, ...limitsOf(row), api_key: cle, key_error: erreur };
}

export async function listUserConnectors(base: Executeur, ownerUserId: number): Promise<Dict[]> {
  const lignes = await base.all(
    `${SELECT_CONNECTEUR} WHERE c.owner_user_id=? AND c.scope='user' ORDER BY c.label ASC, c.id ASC`,
    [ownerUserId],
  );
  return lignes.map(vuePublique);
}

export async function listSharedConnectors(base: Executeur): Promise<Dict[]> {
  const lignes = await base.all(`${SELECT_CONNECTEUR} WHERE c.scope='shared' ORDER BY c.label ASC, c.id ASC`);
  return lignes.map(vuePublique);
}

/** Identifiants des connecteurs (toutes portées) qui parlent `wire`. */
export async function connectorIdsByWire(base: Executeur, wire: unknown): Promise<number[]> {
  const lignes = await base.valeurs("SELECT id FROM llm_connectors WHERE wire=? ORDER BY id", [strPy(wire)]);
  return lignes.map((r) => intPy(r[0]));
}

/** Vue publique d'un connecteur quelle que soit sa portée (réglages lus côté serveur, sans contrôle d'accès). */
export async function getMeta(base: Executeur, connectorId: unknown): Promise<Dict | null> {
  const r = await base.get(`${SELECT_CONNECTEUR} WHERE c.id=?`, [intPy(connectorId)]);
  return r ? vuePublique(r) : null;
}

export interface ChampsConnecteur {
  scope: string;
  provider_type: string;
  wire: string;
  owner_user_id?: number | null;
  base_url?: string;
  api_key?: string;
  label?: string;
  default_model?: string;
  models_json?: string;
  enabled?: boolean;
  context_window?: unknown;
  max_models?: unknown;
  max_concurrency?: unknown;
}

/** Création, clé rangée dans le coffre dans la même transaction (coffre indisponible : rien n'est créé, jamais de stockage en clair). */
export async function createConnector(
  base: Base,
  c: ChampsConnecteur,
  acteur: Acteur = ACTEUR_SYSTEME,
): Promise<number> {
  const maintenant = Date.now() / 1000;
  const cols = [
    "owner_user_id",
    "scope",
    "provider_type",
    "wire",
    "label",
    "base_url",
    "api_key_enc",
    "key_scheme",
    "default_model",
    "models_json",
    "enabled",
    "created_at",
    "updated_at",
  ];
  const vals: (string | number | null)[] = [
    c.owner_user_id ?? null,
    c.scope,
    c.provider_type,
    c.wire,
    c.label || "",
    c.base_url || "",
    "",
    "plain",
    c.default_model || "",
    c.models_json || "",
    (c.enabled ?? true) ? 1 : 0,
    maintenant,
    maintenant,
  ];
  for (const k of LIMIT_COLS) {
    const v = posOrNone(c[k] ?? null);
    if (v === null) continue;
    cols.push(k);
    vals.push(v);
  }
  return base.ecriture(async () => {
    const id = await base.insertId(
      `INSERT INTO llm_connectors(${cols.join(", ")}) VALUES(${cols.map(() => "?").join(", ")})`,
      vals,
    );
    if (c.api_key) {
      const lien = { id, scope: c.scope, owner_user_id: c.owner_user_id ?? null, secret_id: null };
      await ecrireCle(base, { ...lien, provider_type: c.provider_type }, c.api_key, acteur);
    }
    return id;
  });
}

/** Champs d'une mise à jour : une clé absente n'est pas touchée ; limites présentes = écrites (vide ⇒ NULL). */
export type ChampsMiseAJour = Partial<
  Record<
    "provider_type" | "wire" | "label" | "base_url" | "default_model" | "models_json" | "api_key",
    string | null
  >
> &
  Partial<Record<"enabled", boolean | null>> &
  Partial<Record<(typeof LIMIT_COLS)[number], unknown>>;

/** Mise à jour sous la condition d'accès ; une nouvelle clé va au coffre dans la même transaction. */
async function mettreAJour(
  base: Base,
  connectorId: number,
  whereExtra: string,
  whereVals: readonly (string | number)[],
  champs: ChampsMiseAJour,
  acteur: Acteur,
): Promise<boolean> {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const k of ["provider_type", "wire", "label", "base_url", "default_model", "models_json"] as const) {
    const v = champs[k];
    if (v !== null && v !== undefined) {
      sets.push(`${k}=?`);
      vals.push(v);
    }
  }
  if (champs.enabled !== null && champs.enabled !== undefined) {
    sets.push("enabled=?");
    vals.push(champs.enabled ? 1 : 0);
  }
  for (const k of LIMIT_COLS) {
    if (!Object.hasOwn(champs, k)) continue;
    sets.push(`${k}=?`);
    vals.push(posOrNone(champs[k] ?? null));
  }
  const cle = champs.api_key;
  if (sets.length === 0 && !cle) return false;
  return base.ecriture(async () => {
    const lien = await lireLien(base, connectorId, whereExtra, whereVals);
    if (lien === null) return false;
    if (cle) await ecrireCle(base, lien, cle, acteur);
    sets.push("updated_at=?");
    vals.push(Date.now() / 1000, connectorId, ...whereVals);
    const r = await base.run(`UPDATE llm_connectors SET ${sets.join(", ")} WHERE id=? ${whereExtra}`, vals);
    return r.changes > 0;
  });
}

export function updateUserConnector(
  base: Base,
  ownerUserId: number,
  connectorId: number,
  champs: ChampsMiseAJour,
  acteur: Acteur = ACTEUR_SYSTEME,
): Promise<boolean> {
  return mettreAJour(
    base,
    connectorId,
    "AND owner_user_id=? AND scope='user'",
    [ownerUserId],
    champs,
    acteur,
  );
}

export function updateSharedConnector(
  base: Base,
  connectorId: number,
  champs: ChampsMiseAJour,
  acteur: Acteur = ACTEUR_SYSTEME,
): Promise<boolean> {
  return mettreAJour(base, connectorId, "AND scope='shared'", [], champs, acteur);
}

/** Suppression sous la condition d'accès, avec le secret lié du coffre, dans une transaction. */
async function supprimer(
  base: Base,
  connectorId: number,
  whereExtra: string,
  whereVals: readonly (string | number)[],
  acteur: Acteur,
): Promise<boolean> {
  return base.ecriture(async () => {
    const lien = await lireLien(base, connectorId, whereExtra, whereVals);
    if (lien === null) return false;
    await supprimerCle(base, lien, acteur);
    const r = await base.run(`DELETE FROM llm_connectors WHERE id=? ${whereExtra}`, [
      connectorId,
      ...whereVals,
    ]);
    return r.changes > 0;
  });
}

export function deleteUserConnector(
  base: Base,
  ownerUserId: number,
  connectorId: number,
  acteur: Acteur = ACTEUR_SYSTEME,
): Promise<boolean> {
  return supprimer(base, connectorId, "AND owner_user_id=? AND scope='user'", [ownerUserId], acteur);
}

export function deleteSharedConnector(
  base: Base,
  connectorId: number,
  acteur: Acteur = ACTEUR_SYSTEME,
): Promise<boolean> {
  return supprimer(base, connectorId, "AND scope='shared'", [], acteur);
}

/** Connecteur utilisable par ce compte (perso ou partagé) AVEC clé : résolution de cible, jamais sérialisé. */
export async function getSecretForUser(
  base: Executeur,
  userId: number,
  connectorId: number,
): Promise<Dict | null> {
  const r = await base.get(
    `${SELECT_CONNECTEUR} WHERE c.id=? AND (c.scope='shared' OR (c.scope='user' AND c.owner_user_id=?))`,
    [connectorId, userId],
  );
  return r ? vueAvecCle(r) : null;
}

/** Connecteur perso AVEC clé (test de connexion du compte). */
export async function getUserSecret(
  base: Executeur,
  ownerUserId: number,
  connectorId: number,
): Promise<Dict | null> {
  const r = await base.get(`${SELECT_CONNECTEUR} WHERE c.id=? AND c.owner_user_id=? AND c.scope='user'`, [
    connectorId,
    ownerUserId,
  ]);
  return r ? vueAvecCle(r) : null;
}

/** Connecteur partagé AVEC clé (test de connexion de l'administration). */
export async function getSharedSecret(base: Executeur, connectorId: number): Promise<Dict | null> {
  const r = await base.get(`${SELECT_CONNECTEUR} WHERE c.id=? AND c.scope='shared'`, [connectorId]);
  return r ? vueAvecCle(r) : null;
}

/** Dernier usage du connecteur et de son secret du coffre, au mieux : jamais d'erreur. */
export async function bumpLastUsed(base: Executeur, connectorId: number): Promise<void> {
  const t = Date.now() / 1000;
  try {
    await base.run("UPDATE llm_connectors SET last_used=? WHERE id=?", [t, connectorId]);
    await base.run(
      "UPDATE vault_secrets SET use_count = use_count + 1, last_used_at = ? " +
        "WHERE id = (SELECT secret_id FROM llm_connectors WHERE id = ?)",
      [t, connectorId],
    );
  } catch {
    return;
  }
}

/** Le port du moteur (B1-14) branché sur la base : résolution de cible, dernier usage, fenêtre déclarée, liste blanche relue à chaud. */
export function portConnecteurs(base: Executeur): PortConnecteurs {
  return {
    getSecretForUser: async (userId, connectorId) =>
      (await getSecretForUser(base, userId, connectorId)) as ConnecteurSecret | null,
    bumpLastUsed: (connectorId) => bumpLastUsed(base, connectorId),
    getMeta: async (connectorId) => (await getMeta(base, connectorId)) as ConnecteurPublic | null,
    allowedProviderTypes: async (userId) => typesOuverts(await compteAdmin(base, userId)),
  };
}

// ── Champs reçus par les routes (routes_connectors.py) ──────────────────────

export const MAX_CHAMP = 300;

/** `_clean` : `str(s).strip()[:n]`, `None` = vide. */
export function nettoyer(s: unknown, n = MAX_CHAMP): string {
  return prefixePy(stripPy(s === null || s === undefined ? "" : strPy(s)), n);
}

/** Presets montrés au navigateur (aucun secret). */
export function presetsPublics(): Record<string, Preset> {
  return Object.fromEntries(Object.entries(PROVIDER_PRESETS).map(([p, v]) => [p, { ...v }]));
}

/** `_resolve_create_fields` : type, liste blanche et réservation admin, base_url verrouillée pour un compte. */
export function champsDeCreation(data: unknown, admin: boolean, autorises: () => readonly string[]): Dict {
  const ptype = nettoyer(getPy(data, "provider_type"));
  if (!Object.hasOwn(PROVIDER_PRESETS, ptype))
    throw new HttpError(400, `provider_type invalide (${reprPy(Object.keys(PROVIDER_PRESETS))})`);
  const preset = PROVIDER_PRESETS[ptype] as Preset;
  if (!admin) {
    if (!autorises().includes(ptype))
      throw new HttpError(403, "Ce fournisseur n'est pas autorisé pour les utilisateurs");
    if (preset.admin_only) throw new HttpError(403, "Connecteur réservé à l'administrateur");
  }
  const baseUrl =
    !admin && preset.user_base_locked
      ? preset.base_url
      : nettoyer(getPy(data, "base_url"), 500) || preset.base_url;
  if (!baseUrl) throw new HttpError(400, "base_url requise (ex. http://llm.example.lan:8000/v1)");
  const out: Dict = {
    provider_type: ptype,
    wire: preset.wire,
    base_url: baseUrl,
    label: nettoyer(getPy(data, "label")) || preset.label,
    default_model: nettoyer(getPy(data, "default_model")),
    models_json: nettoyer(getPy(data, "models_json"), 4000),
  };
  return admin ? { ...out, ...champsDeLimites(data) } : out;
}

const BORNES_LIMITES: readonly (readonly [(typeof LIMIT_COLS)[number], number])[] = [
  ["context_window", 10_000_000],
  ["max_models", 64],
  ["max_concurrency", 256],
];

/** `_limit_fields` (administration) : seules les clés présentes ; vide ou 0 = découverte automatique. */
export function champsDeLimites(data: unknown): Dict {
  const out: Dict = {};
  for (const [k, max] of BORNES_LIMITES) {
    if (!Object.hasOwn(data as object, k)) continue;
    const brut = getPy(data, k);
    if (brut === null || brut === "") {
      out[k] = null;
      continue;
    }
    const v = entierOuNul(brut);
    if (v === null) throw new HttpError(400, `${k} doit être un entier`);
    if (v < 0 || v > max) throw new HttpError(400, `${k} hors bornes (0-${max})`);
    out[k] = v || null;
  }
  return out;
}
