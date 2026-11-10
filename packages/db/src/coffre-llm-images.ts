// SPDX-License-Identifier: MIT
/** packages/db/src/coffre-llm-images.ts — migration 0028_vault_llm_images : clés des connecteurs LLM (Fernet ou en clair) et clé du moteur d'images (config.json) rangées dans le coffre par le core ; une clé illisible est gardée et signalée, jamais perdue. */
import { configView } from "@elpis/config";
import { CleCoffreIndisponible, decryptStrict, EncryptionUnavailable, InvalidToken } from "@elpis/securite";

import type { Executeur } from "./base";
import { MigrationDifferee } from "./migration";
import type { Migration } from "./migration";

/** Secret d'instance qui porte la clé du moteur d'images. */
export const NOM_CLE_IMAGES = "image-engine";
/** `key_scheme` d'une clé rangée dans le coffre, et d'une ancienne clé Fernet illisible gardée telle quelle. */
export const SCHEMA_COFFRE = "vault";
export const SCHEMA_ILLISIBLE = "unreadable";
/** Clés employées par le moteur pour tout appel permis (sous-agents et routines compris), jamais désignées par le modèle. */
export const POLITIQUE_CLE_MOTEUR = {
  subagents: true,
  routines: true,
  confirm_first_use: false,
  tls: "strict",
} as const;

/** Secret à ranger : le core le valide, le chiffre comme `creerSecret` (même AAD) et l'insère ; rend son id. */
export interface SecretARanger {
  proprietaire: number | null;
  genre: "llm" | "token";
  nom: string;
  portee: Record<string, unknown>;
  valeur: string;
}
export type RangerSecret = (x: Executeur, s: SecretARanger) => Promise<number>;

let ranger: RangerSecret | null = null;

/** Posé par le core avant d'ouvrir sa base ; sans lui (hôte d'outils, assistant, commandes), la migration lui est laissée. */
export function installerRangementCoffre(f: RangerSecret | null): void {
  ranger = f;
}

function rangement(): RangerSecret {
  if (ranger === null) throw new Error("rangement du coffre non installé (installerRangementCoffre)");
  return ranger;
}

interface LigneHeritee {
  id: number;
  owner_user_id: number | null;
  scope: string;
  provider_type: string | null;
  api_key_enc: string;
  key_scheme: string | null;
}

/** Notes d'une reprise pour le journal du démarrage ; `restantes` : clés gardées illisibles. */
export interface BilanReprise {
  infos: string[];
  avertissements: string[];
  restantes: number;
}

const bilanVide = (): BilanReprise => ({ infos: [], avertissements: [], restantes: 0 });

/** Propriétaire du secret d'un connecteur : son compte, ou l'instance (`null`) pour un connecteur partagé. */
export function proprietaireConnecteur(scope: unknown, owner: unknown): number | null {
  return scope === "shared" || owner === null || owner === undefined ? null : Number(owner);
}

/** Nom du secret d'un connecteur : `llm-<type>-<id>`, suffixé `-<n>` au n-ième essai (slug du coffre, 48 caractères au plus). */
export function nomCleConnecteur(type: unknown, id: number, essai = 1): string {
  const t =
    String(type ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, "-")
      .slice(0, 20) || "connector";
  return `llm-${t}-${id}${essai > 1 ? `-${essai}` : ""}`;
}

async function nomPris(x: Executeur, proprietaire: number | null, nom: string): Promise<boolean> {
  const ligne = await x.get(
    `SELECT id FROM vault_secrets WHERE name = ? AND ${proprietaire === null ? "user_id IS NULL" : "user_id = ?"}`,
    proprietaire === null ? [nom] : [nom, proprietaire],
  );
  return ligne !== undefined;
}

/** Connecteurs dont la clé n'est pas encore dans le coffre. */
async function lignesHeritees(x: Executeur): Promise<LigneHeritee[]> {
  return x.all<LigneHeritee & Record<string, unknown>>(
    "SELECT id, owner_user_id, scope, provider_type, api_key_enc, key_scheme FROM llm_connectors " +
      "WHERE secret_id IS NULL AND api_key_enc <> '' ORDER BY id",
  );
}

/** Ancienne clé lue : son texte, ou le motif pour lequel elle ne peut pas l'être (elle est alors gardée et signalée). */
export type CleLue = { clair: string } | { motif: string };

const MOTIF_ILLISIBLE = "illisible avec la clé de chiffrement actuelle";

/** Jeton Fernet de la clé maître déchiffré ; jeton illisible ou clé maître indisponible : le motif, jamais d'échec de la reprise entière. */
function ouvrirFernet(enc: string): CleLue {
  try {
    return { clair: decryptStrict(enc) };
  } catch (e) {
    if (e instanceof InvalidToken) return { motif: MOTIF_ILLISIBLE };
    if (e instanceof EncryptionUnavailable)
      return { motif: "clé de chiffrement indisponible (APP_ENCRYPTION_KEY, user_db/.encryption_key)" };
    throw e;
  }
}

/** Ancienne clé d'un connecteur : jeton Fernet déchiffré, sinon le texte tel quel (schéma `plain`). */
export function cleHeritee(enc: string, schema: unknown): CleLue {
  if (schema !== "fernet" && schema !== SCHEMA_ILLISIBLE) return { clair: enc };
  const r = ouvrirFernet(enc);
  return "clair" in r && !r.clair.isWellFormed() ? { motif: MOTIF_ILLISIBLE } : r;
}

/** `f` avec `secure_delete` sur la connexion SQLite (anciennes clés effacées des pages, pas seulement libérées), réglage d'avant remis ensuite ; PostgreSQL : tel quel. */
export async function avecEffacementSur<T>(x: Executeur, f: () => Promise<T>): Promise<T> {
  if (x.dialecte !== "sqlite") return f();
  const avant = Number((await x.get<{ secure_delete: number }>("PRAGMA secure_delete"))?.secure_delete ?? 0);
  await x.run("PRAGMA secure_delete = 1");
  try {
    return await f();
  } finally {
    await x.run(`PRAGMA secure_delete = ${[0, 1, 2].includes(avant) ? avant : 0}`);
  }
}

/** Clés héritées des connecteurs LLM rangées dans le coffre et liées (`secret_id`) ; une clé illisible reste en place, marquée `unreadable`. */
export async function reprendreClesLlm(x: Executeur, lignes?: LigneHeritee[]): Promise<BilanReprise> {
  const b = bilanVide();
  const rangees: number[] = [];
  for (const l of lignes ?? (await lignesHeritees(x))) {
    const id = Number(l.id);
    const proprietaire = proprietaireConnecteur(l.scope, l.owner_user_id);
    const lue = cleHeritee(l.api_key_enc, l.key_scheme);
    if ("motif" in lue) {
      b.restantes += 1;
      if (l.key_scheme !== SCHEMA_ILLISIBLE)
        await x.run("UPDATE llm_connectors SET key_scheme = ? WHERE id = ?", [SCHEMA_ILLISIBLE, id]);
      b.avertissements.push(
        `connecteur LLM #${id} (${l.provider_type ?? "?"}, ${proprietaire === null ? "partagé" : `compte ${proprietaire}`}) : ` +
          `ancienne clé ${lue.motif}, gardée et signalée (has_key faux) : ` +
          "la ressaisir, ou rétablir l'ancienne clé de chiffrement puis redémarrer",
      );
      continue;
    }
    const clair = lue.clair;
    if (!clair) {
      await x.run("UPDATE llm_connectors SET api_key_enc = '', key_scheme = 'plain' WHERE id = ?", [id]);
      continue;
    }
    let essai = 1;
    while (await nomPris(x, proprietaire, nomCleConnecteur(l.provider_type, id, essai))) essai += 1;
    const sid = await rangement()(x, {
      proprietaire,
      genre: "llm",
      nom: nomCleConnecteur(l.provider_type, id, essai),
      portee: { connector_id: id },
      valeur: clair,
    });
    await x.run("UPDATE llm_connectors SET secret_id = ?, api_key_enc = '', key_scheme = ? WHERE id = ?", [
      sid,
      SCHEMA_COFFRE,
      id,
    ]);
    rangees.push(id);
  }
  if (rangees.length)
    b.infos.push(
      `${rangees.length} clé(s) de connecteurs LLM rangée(s) dans le coffre (connecteurs ${rangees.join(", ")})`,
    );
  return b;
}

/** `image.api_key_enc` de config.json (Fernet de `{k, o}` écrit par l'ancienne console), `""` s'il n'y en a pas. */
export function cleImagesHeritee(vue: unknown = configView()): string {
  const image = vue !== null && typeof vue === "object" ? (vue as Record<string, unknown>)["image"] : null;
  const enc =
    image !== null && typeof image === "object" && !Array.isArray(image)
      ? (image as Record<string, unknown>)["api_key_enc"]
      : null;
  return typeof enc === "string" ? enc.trim() : "";
}

/** Origine WHATWG d'une origine scellée (`schéma://hôte:port`, hôte IPv6 sans crochets) ; `null` si illisible. */
function origineScellee(o: string): string | null {
  const m = /^(https?):\/\/(.+):(\d{1,5})$/u.exec(o);
  if (m === null) return null;
  const hote = m[2] ?? "";
  const adresse = `${m[1] ?? ""}://${hote.includes(":") && !hote.startsWith("[") ? `[${hote}]` : hote}:${m[3] ?? ""}/`;
  return URL.canParse(adresse) ? new URL(adresse).origin : null;
}

/** Clé et origine WHATWG du moteur scellées par l'ancienne console ; jeton ou contenu illisible, clé maître indisponible : le motif. */
export function ouvrirSceauImages(enc: string): { cle: string; origine: string } | { motif: string } {
  const lue = ouvrirFernet(enc);
  if ("motif" in lue) return lue;
  const illisible = { motif: MOTIF_ILLISIBLE };
  let d: unknown;
  try {
    d = JSON.parse(lue.clair);
  } catch {
    return illisible;
  }
  if (d === null || typeof d !== "object" || Array.isArray(d)) return illisible;
  const { k, o } = d as Record<string, unknown>;
  if (typeof k !== "string" || typeof o !== "string" || !k.isWellFormed()) return illisible;
  const origine = origineScellee(o);
  return origine === null ? illisible : { cle: k, origine };
}

/** Genre du secret d'instance `image-engine`, `null` s'il n'existe pas. */
export async function genreCleImages(x: Executeur): Promise<string | null> {
  const l = await x.get<{ kind: string }>(
    "SELECT kind FROM vault_secrets WHERE user_id IS NULL AND name = ?",
    [NOM_CLE_IMAGES],
  );
  return l?.kind ?? null;
}

/** Clé du moteur d'images de config.json semée dans le coffre (secret d'instance `image-engine`, portée `{origins: [origine du moteur]}`) s'il n'en a pas ; config.json n'est jamais touché ici. */
export async function semerCleImages(x: Executeur, enc = cleImagesHeritee()): Promise<BilanReprise> {
  const b = bilanVide();
  if (!enc) return b;
  const genre = await genreCleImages(x);
  if (genre === "token") return b;
  const sceau = genre === null ? ouvrirSceauImages(enc) : null;
  if (sceau === null || "motif" in sceau) {
    b.restantes = 1;
    b.avertissements.push(
      sceau === null
        ? `clé du moteur d'images (config.json › image.api_key_enc) gardée : le nom ${NOM_CLE_IMAGES} est déjà pris dans le coffre par un secret ${genre ?? "?"}`
        : `clé du moteur d'images (config.json › image.api_key_enc) ${sceau.motif} : laissée en place, à ressaisir (console › Images)`,
    );
    return b;
  }
  if (!sceau.cle) return b;
  await rangement()(x, {
    proprietaire: null,
    genre: "token",
    nom: NOM_CLE_IMAGES,
    portee: { origins: [sceau.origine] },
    valeur: sceau.cle,
  });
  b.infos.push(`clé du moteur d'images rangée dans le coffre (${NOM_CLE_IMAGES})`);
  return b;
}

/** Laissée au core quand ce process n'a pas son rangement (hôte d'outils, assistant) et qu'il y a des clés de connecteurs à ranger (la clé du moteur d'images seule ne la retient pas : main la sème à son démarrage) ; clé du coffre illisible ou absente devant des secrets (le rangement lève `CleCoffreIndisponible`) : échec bruyant, rien de changé. */
export const MIGRATION_COFFRE_LLM_IMAGES: Migration = {
  name: "0028_vault_llm_images",
  async migrer(x) {
    const lignes = await lignesHeritees(x);
    const image = cleImagesHeritee();
    const aSemer = image !== "" && (await genreCleImages(x)) !== "token";
    if (lignes.length === 0 && !aSemer) return;
    if (ranger === null) {
      if (lignes.length > 0)
        throw new MigrationDifferee(
          "clés de connecteurs à ranger dans le coffre : laissée au core, qui en a la clé",
        );
      return { infos: ["clé du moteur d'images (config.json) laissée au prochain démarrage de main"] };
    }
    try {
      return await avecEffacementSur(x, async () => {
        const llm = await reprendreClesLlm(x, lignes);
        const img = aSemer ? await semerCleImages(x, image) : bilanVide();
        return {
          infos: [...llm.infos, ...img.infos],
          avertissements: [...llm.avertissements, ...img.avertissements],
        };
      });
    } catch (e) {
      if (e instanceof CleCoffreIndisponible)
        throw new Error(
          `clé du coffre indisponible, clés des connecteurs LLM et du moteur d'images non migrées (./elpis doctor) : ${e.message}`,
          { cause: e },
        );
      throw e;
    }
  },
};
