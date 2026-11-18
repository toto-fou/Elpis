// SPDX-License-Identifier: MIT
/** apps/core/src/identite/fournisseurs.ts — fournisseurs d'identité : liste et actifs (invariants de lecture), secret au coffre, champs figés, empreinte du dernier test réussi. */
import { createHash } from "node:crypto";

import { estDict } from "@elpis/commun";
import type { Base, Executeur } from "@elpis/db";

import { journal } from "../journal";
import { ErreurSecret } from "../secrets/erreurs";
import { hoteExact, hotes } from "../secrets/portee";
import {
  creerSecret,
  dechiffrerLigne,
  lireLigneParNom,
  modifierSecret,
  porteeDe,
  supprimerSecret,
} from "../secrets/stockage";
import type { Acteur } from "../secrets/stockage";
import { hotePortHttps, hotePortLdaps, lireReglagesAuth } from "./reglages";
import type { Fournisseur, ReglagesAuthLus } from "./reglages";

const log = journal("identite");
const POLITIQUE_SECRET = {
  subagents: false,
  routines: false,
  confirm_first_use: false,
  tls: "strict",
} as const;
const signales = new Map<string, string>();

/** Nom du secret d'instance d'un fournisseur. */
export const nomSecret = (id: string): string => `auth-${id}`;

/** Réglages relus à chaud ; fournisseur valide d'identifiant donné. */
export function fournisseurParId(
  id: string,
  reglages: ReglagesAuthLus = lireReglagesAuth(),
): Fournisseur | undefined {
  return reglages.providers.find((p) => p.id === id);
}

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

/** Pose l'empreinte du test réussi (le seul appelant de production est le test du fournisseur). */
export async function enregistrerTestReussi(
  x: Executeur,
  f: Fournisseur,
  publicUrl: string,
  maintenant: number = Date.now() / 1000,
): Promise<void> {
  await x.run(
    "INSERT INTO auth_provider_state(provider_id, tested_hash, tested_at) VALUES(?,?,?) " +
      "ON CONFLICT(provider_id) DO UPDATE SET tested_hash=excluded.tested_hash, tested_at=excluded.tested_at",
    [f.id, empreinteFournisseur(f, publicUrl), maintenant],
  );
}

/** Vrai si l'empreinte actuelle du fournisseur est celle de son dernier test réussi. */
export async function testReussiCourant(x: Executeur, f: Fournisseur, publicUrl: string): Promise<boolean> {
  const l = await x.get<{ tested_hash: string | null }>(
    "SELECT tested_hash FROM auth_provider_state WHERE provider_id=?",
    [f.id],
  );
  return typeof l?.tested_hash === "string" && l.tested_hash === empreinteFournisseur(f, publicUrl);
}

/** Hôtes `hôte:port` du fournisseur, sous la forme de la portée de son secret. */
export function hotesDuFournisseur(f: Fournisseur): string[] {
  const bruts = f.type === "ldap" ? f.urls.map(hotePortLdaps) : [hotePortHttps(f.issuer)];
  return bruts.map((h) => hoteExact(h) ?? h);
}

/** Mot de passe ou secret client du fournisseur ; `null` s'il est absent, hors de portée de l'adresse courante ou illisible, jamais une chaîne vide. */
export async function secretFournisseur(x: Executeur, f: Fournisseur): Promise<string | null> {
  const l = await lireLigneParNom(x, null, nomSecret(f.id));
  if (l === null || l.kind !== "token") return null;
  const portee = hotes(porteeDe(l));
  if (!hotesDuFournisseur(f).every((h) => portee.includes(h))) return null;
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

/** Secret rangé ou remplacé, portée = adresses courantes du fournisseur ; nom pris par un autre genre : 409. */
export async function enregistrerSecret(
  base: Base,
  f: Fournisseur,
  valeur: string,
  acteur: Acteur,
): Promise<void> {
  const nom = nomSecret(f.id);
  const portee = { hosts: hotesDuFournisseur(f) };
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
  if (avant.type === "oidc" && apres.type === "oidc")
    return (["issuer", "client_id", "subject_claim"] as const).filter((k) => avant[k] !== apres[k]);
  if (avant.type === "ldap" && apres.type === "ldap")
    return avant.attrs.id !== apres.attrs.id ? ["attrs.id"] : [];
  return ["type"];
}

/** Secret et test du fournisseur, et la raison pour laquelle un fournisseur allumé n'est pas actif (`null` s'il l'est) ; la console, l'activation et la connexion s'y fient. */
export async function etatFournisseur(
  x: Executeur,
  f: Fournisseur,
  publicUrl: string,
): Promise<{ has_secret: boolean; tested: boolean; ecart: string | null }> {
  const has_secret = (await secretFournisseur(x, f)) !== null;
  const tested = await testReussiCourant(x, f, publicUrl);
  const ecart =
    publicUrl === ""
      ? "adresse publique absente ou invalide"
      : f.required_groups.length === 0
        ? "aucun groupe requis"
        : !tested
          ? "pas de test réussi pour les réglages courants"
          : !has_secret
            ? "secret absent ou hors de portée"
            : null;
  return { has_secret, tested, ecart };
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
  for (const uid of comptes)
    await x.run(
      "UPDATE users SET session_min_ts=? WHERE id=? AND (session_min_ts IS NULL OR session_min_ts<?)",
      [t, uid, t],
    );
  return comptes;
}

function signaler(id: string, raison: string | null): void {
  if (raison === null) {
    signales.delete(id);
    return;
  }
  if (signales.get(id) === raison) return;
  signales.set(id, raison);
  log.warn(`fournisseur d'identité ${id} allumé mais écarté : ${raison}`);
}

/** Fournisseurs allumés dont tous les invariants de lecture tiennent, quoi que le fichier contienne ; chaque écart est signalé une fois au journal. */
export async function fournisseursActifs(x: Executeur): Promise<Fournisseur[]> {
  const r = lireReglagesAuth();
  const actifs: Fournisseur[] = [];
  for (const f of r.providers) {
    if (!f.enabled) {
      signales.delete(f.id);
      continue;
    }
    const raison = (await etatFournisseur(x, f, r.public_url)).ecart;
    signaler(f.id, raison);
    if (raison === null) actifs.push(f);
  }
  for (const i of r.invalides) if (i.enabled) signaler(i.id ?? "?", "réglages invalides");
  return actifs;
}
