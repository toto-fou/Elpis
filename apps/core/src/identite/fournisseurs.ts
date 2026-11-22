// SPDX-License-Identifier: MIT
/** apps/core/src/identite/fournisseurs.ts — fournisseurs d'identité : liste, secret au coffre, champs figés, empreinte du dernier test réussi. */
import { createHash, createHmac } from "node:crypto";

import { estDict } from "@elpis/commun";
import { liveConfigValue } from "@elpis/config";
import type { Base, Executeur } from "@elpis/db";
import { cleCoffre } from "@elpis/securite";
import type { CleCoffre } from "@elpis/securite";

import { journal } from "../journal";
import { ErreurSecret } from "../secrets/erreurs";
import { autoriteDePortee, empreinteAutorite, hote, hoteExact } from "../secrets/portee";
import {
  creerSecret,
  dechiffrerLigne,
  lireLigneParNom,
  modifierSecret,
  porteeDe,
  supprimerSecret,
} from "../secrets/stockage";
import type { Acteur } from "../secrets/stockage";
import { compterAdminsLocaux } from "./etat";
import { hotePortHttps } from "./reglages";
import type { Fournisseur } from "./reglages";

const log = journal("identite");
const POLITIQUE_SECRET = {
  subagents: false,
  routines: false,
  confirm_first_use: false,
  tls: "strict",
} as const;

/** Nom du secret d'instance d'un fournisseur. */
export const nomSecret = (id: string): string => `auth-${id}`;

function canonique(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonique);
  if (estDict(v))
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonique(v[k])]),
    );
  return v;
}

/** SHA-256 des réglages d'un fournisseur qui comptent pour la sécurité (tout sauf libellé, activation et fraîcheur) et de l'adresse publique. */
export function empreinteFournisseur(f: Fournisseur, publicUrl: string): string {
  const { label: _l, enabled: _e, freshness_days: _f, ...reste } = f;
  return createHash("sha256")
    .update(JSON.stringify(canonique({ provider: reste, public_url: publicUrl })), "utf8")
    .digest("hex");
}

const CONTEXTE_SECRET_TESTE = "elpis.auth.tested-secret.v1";

/** HMAC-SHA256 d'une valeur sous une clé du coffre donnée, clé dérivée pour ce contexte. */
export function hmacAvecCle(c: CleCoffre, contexte: string, valeur: string): string {
  const cle = createHmac("sha256", c.cle).update(contexte, "utf8").digest();
  return createHmac("sha256", cle).update(valeur, "utf8").digest("hex");
}

/** HMAC-SHA256 d'une valeur, clé dérivée de la clé du coffre pour ce contexte ; `null` sans clé de coffre. */
export function hmacCoffre(contexte: string, valeur: string): string | null {
  const c = cleCoffre();
  return c === null ? null : hmacAvecCle(c, contexte, valeur);
}

/** Contexte du HMAC du secret testé : propre au fournisseur, deux fournisseurs au même secret n'ont pas la même valeur. */
export const contexteSecretTeste = (id: string): string => `${CONTEXTE_SECRET_TESTE}:${id}`;

function lireTest(brut: unknown): { h: string; s: string | null } | null {
  if (typeof brut !== "string") return null;
  try {
    const o = JSON.parse(brut) as { h?: unknown; s?: unknown };
    if (typeof o.h !== "string" || (o.s !== null && typeof o.s !== "string")) return null;
    return { h: o.h, s: o.s };
  } catch {
    return null;
  }
}

/** Vrai si l'empreinte actuelle du fournisseur est celle de son dernier test réussi ET que le secret enregistré est celui qu'a employé ce test (un secret absent est signalé à part). */
export async function testReussiCourant(
  x: Executeur,
  f: Fournisseur,
  publicUrl: string,
  secretEnregistre?: string | null,
): Promise<boolean> {
  const l = await x.get<{ tested_hash: string | null }>(
    "SELECT tested_hash FROM auth_provider_state WHERE provider_id=?",
    [f.id],
  );
  const test = lireTest(l?.tested_hash);
  if (test === null || test.h !== empreinteFournisseur(f, publicUrl)) return false;
  const stocke = secretEnregistre === undefined ? await secretFournisseur(x, f) : secretEnregistre;
  if (stocke === null) return true;
  const attendu = hmacCoffre(contexteSecretTeste(f.id), stocke);
  return attendu !== null && test.s === attendu;
}

/** Hôte `hôte:port` du fournisseur, sous la forme de la portée de son secret. */
export function hoteDuFournisseur(f: Fournisseur): string {
  const h = hotePortHttps(f.issuer);
  return hoteExact(h) ?? h;
}

/** Portée du secret d'un fournisseur : adresse et autorité de certification. */
export function porteeDuFournisseur(f: Fournisseur): { host: string; ca: string } {
  return {
    host: hoteDuFournisseur(f),
    ca: empreinteAutorite(f.ca_pem),
  };
}

/** Mot de passe ou secret client du fournisseur ; `null` s'il est absent, hors de portée de l'adresse ou de l'autorité courantes, ou illisible, jamais une chaîne vide. */
export async function secretFournisseur(x: Executeur, f: Fournisseur): Promise<string | null> {
  const l = await lireLigneParNom(x, null, nomSecret(f.id));
  if (l === null || l.kind !== "token") return null;
  const rangee = porteeDe(l);
  const attendue = porteeDuFournisseur(f);
  if (hote(rangee) !== attendue.host) return null;
  if (autoriteDePortee(rangee) !== attendue.ca) return null;
  try {
    const v = dechiffrerLigne(l);
    return v === "" ? null : v;
  } catch (e) {
    if (!(e instanceof ErreurSecret)) throw e;
    log.warn(
      `secret du fournisseur ${f.id} illisible dans le coffre (${e.code}) : le ressaisir dans la console`,
    );
    return null;
  }
}

/** Secret rangé ou remplacé, portée = adresse et autorité courantes du fournisseur ; nom pris par un autre genre : 409. */
export async function enregistrerSecret(
  base: Base,
  f: Fournisseur,
  valeur: string,
  acteur: Acteur,
): Promise<void> {
  const nom = nomSecret(f.id);
  const portee = porteeDuFournisseur(f);
  await base.ecriture(async () => {
    const l = await lireLigneParNom(base, null, nom);
    if (l !== null && l.kind !== "token")
      throw new ErreurSecret(
        409,
        "secret_name_taken",
        `The instance secret '${nom}' already exists with another kind.`,
      );
    if (l !== null) await modifierSecret(base, null, Number(l.id), { value: valeur, scope: portee }, acteur);
    else
      await creerSecret(
        base,
        null,
        { name: nom, kind: "token", scope: portee, value: valeur, policy: { ...POLITIQUE_SECRET } },
        acteur,
      );
  });
}

/** Secret du fournisseur supprimé (sans effet s'il n'existe pas). */
export async function supprimerSecretFournisseur(base: Base, id: string, acteur: Acteur): Promise<void> {
  await base.ecriture(async () => {
    const l = await lireLigneParNom(base, null, nomSecret(id));
    if (l !== null) await supprimerSecret(base, null, Number(l.id), acteur);
  });
}

/** Nombre d'identités rattachées au fournisseur. */
export async function nombreIdentites(x: Executeur, id: string): Promise<number> {
  const r = await x.valeurs<[number]>("SELECT COUNT(*) FROM user_identities WHERE provider_id=?", [id]);
  return Number(r[0]?.[0] ?? 0);
}

/** Champs figés tant que des identités existent, parmi ceux que `apres` change. */
export function champsFigesChanges(avant: Fournisseur, apres: Fournisseur): string[] {
  return (["issuer", "client_id", "subject_claim"] as const).filter((k) => avant[k] !== apres[k]);
}

/** Vrai si le cookie de session émis par le processus est `Secure` ET que HTTPS est en service dans la configuration (`security.https.enabled`) : `same_site: none` ne suffit jamais. */
export function connexionSecurisee(cookieSecure: boolean): boolean {
  return cookieSecure && liveConfigValue("security.https.enabled", false) === true;
}

/** Écart que révèlent l'adresse publique, le cookie, les administrateurs locaux et les groupes requis (`null` : aucun) ; le comptage des administrateurs n'a lieu que s'il reste à décider. */
async function ecartPrealable(
  f: Fournisseur,
  publicUrl: string,
  securise: boolean,
  admins: () => Promise<number>,
): Promise<string | null> {
  if (publicUrl === "") return "adresse publique absente ou invalide";
  if (!securise) return "cookie de session non sécurisé";
  if ((await admins()) === 0) return "aucun administrateur local actif";
  return f.required_groups.length === 0 ? "aucun groupe requis" : null;
}

/** Secret et test du fournisseur, avec l'écart qu'ils entraînent (`null` : aucun) ; le secret n'est lu qu'une fois. */
async function lecturesCoffre(
  x: Executeur,
  f: Fournisseur,
  publicUrl: string,
): Promise<{ has_secret: boolean; tested: boolean; ecart: string | null }> {
  const secret = await secretFournisseur(x, f);
  const has_secret = secret !== null;
  const tested = await testReussiCourant(x, f, publicUrl, secret);
  const ecart = !tested
    ? "pas de test réussi pour les réglages courants"
    : !has_secret
      ? "secret absent ou hors de portée"
      : null;
  return { has_secret, tested, ecart };
}

/** Secret et test du fournisseur, et la raison pour laquelle un fournisseur allumé n'est pas actif (`null` s'il l'est) ; la console, l'activation et la connexion s'y fient. */
export async function etatFournisseur(
  x: Executeur,
  f: Fournisseur,
  publicUrl: string,
  cookieSecure: boolean,
  admins: () => Promise<number> = () => compterAdminsLocaux(x),
): Promise<{ has_secret: boolean; tested: boolean; ecart: string | null }> {
  const { ecart, ...lu } = await lecturesCoffre(x, f, publicUrl);
  const prealable = await ecartPrealable(f, publicUrl, connexionSecurisee(cookieSecure), admins);
  return { ...lu, ecart: prealable ?? ecart };
}

/** Comptes rattachés à ces fournisseurs, dont `session_min_ts` passe à `t` : leurs sessions ouvertes sont refusées ; rend leurs identifiants. */
export async function couperSessionsDesFournisseurs(
  x: Executeur,
  ids: readonly string[],
  t: number,
): Promise<number[]> {
  if (ids.length === 0) return [];
  const marques = ids.map(() => "?").join(",");
  const comptes = (
    await x.valeurs<[number]>(
      `SELECT DISTINCT user_id FROM user_identities WHERE provider_id IN (${marques})`,
      [...ids],
    )
  ).map(([u]) => Number(u));
  if (comptes.length > 0)
    await x.run(
      `UPDATE users SET session_min_ts=? WHERE id IN (SELECT user_id FROM user_identities WHERE provider_id IN (${marques})) AND (session_min_ts IS NULL OR session_min_ts<?)`,
      [t, ...ids, t],
    );
  return comptes;
}
