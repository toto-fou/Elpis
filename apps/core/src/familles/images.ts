// SPDX-License-Identifier: MIT
/** apps/core/src/familles/images.ts — routes utilisateur des images : état proposé au compte, galerie, fichier (vignette), suppression ; images d'autrui en 404 (shared_infra/image/routes.py). */
import {
  ErreurLecturePy,
  estAlnumPy,
  getOu,
  getPy,
  HttpError,
  longueurPy,
  pyJsonLoads,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Base } from "@elpis/db";
import type { FastifyReply } from "fastify";

import { ImageError } from "../images/base";
import { cleanPrefs, enabledIn, readSettings, readyFor, toolEnabledIn } from "../images/acces";
import { getImageConfig, publicStatus } from "../images/config";
import type { ConfigImage } from "../images/config";
import { countForUser, deleteImage, getImage, listImages } from "../images/magasin";
import { capabilities, modelName } from "../images/service";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import { utilisateur } from "./comptes";
import { entrees, py, repondreAnnote, reponseFichier } from "@elpis/http";

export interface DependancesImages {
  readonly base: Base;
}

const EXT: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
/** Attente maximale de la sonde de sd-server par la route d'état (secondes). */
const STATUS_PROBE_S = 3.0;
const INTROUVABLE = "Image introuvable ou expirée.";

/** Nom proposé au téléchargement, celui de l'interface : `<description>-<graine>.<ext>`, les 8 premiers caractères de l'id à défaut de graine. */
export function downloadName(prompt: string, seed: unknown, mime: string, imageId = ""): string {
  let slug = "";
  let tiret = false;
  for (const c of prompt || "") {
    if (estAlnumPy(c)) {
      slug += c;
      tiret = false;
    } else if (!tiret) {
      slug += "-";
      tiret = true;
    }
  }
  slug = Array.from(slug.replace(/^-+|-+$/g, ""))
    .slice(0, 40)
    .join("")
    .replace(/-+$/, "");
  slug ||= "image";
  const entier =
    (typeof seed === "number" && Number.isInteger(seed)) ||
    typeof seed === "bigint" ||
    typeof seed === "boolean";
  const tag = entier
    ? strPy(seed)
    : Array.from(imageId || "")
        .slice(0, 8)
        .join("");
  const ext = EXT[mime] ?? "png";
  return tag ? `${slug}-${tag}.${ext}` : `${slug}.${ext}`;
}

/** Ce que le compte peut se voir proposer (groupes, réglages, compteur relus en base). */
export async function statusFor(base: Base, uid: number): Promise<Dict> {
  const cfg = getImageConfig();
  if (!(await readyFor(base, uid, cfg))) return { ready: false, available: false };
  const settings = await readSettings(base, uid);
  const out: Dict = {
    ready: true,
    available: enabledIn(settings),
    tool_enabled: toolEnabledIn(settings),
    ...publicStatus(cfg),
  };
  out["prefs"] = cleanPrefs(getOu(settings ?? {}, "image_prefs", null), cfg);
  out["stored"] = await countForUser(base, uid);
  return out;
}

/** sd-server sert le modèle qu'il a chargé : son nom vient de ses capacités (en cache) ; moteur muet ou lent : vide. */
async function announcedModel(cfg: ConfigImage): Promise<string> {
  const controle = new AbortController();
  const minuterie = setTimeout(() => controle.abort(), STATUS_PROBE_S * 1000);
  const delai = new Promise<never>((_, refus) =>
    controle.signal.addEventListener("abort", () => refus(controle.signal.reason), { once: true }),
  );
  delai.catch(() => undefined);
  try {
    return modelName({}, await Promise.race([capabilities(cfg, controle.signal), delai]));
  } catch (e) {
    if (e instanceof ImageError || controle.signal.aborted) return "";
    throw e;
  } finally {
    clearTimeout(minuterie);
  }
}

/** `json.loads(params_json or "{}").get("seed")` : JSON illisible → `null`, autre chose qu'un objet → AttributeError. */
function graine(paramsJson: unknown): unknown {
  let params: unknown;
  try {
    params = pyJsonLoads(strPy(veritePy(paramsJson) ? paramsJson : "{}"));
  } catch (e) {
    if (e instanceof SyntaxError || (e instanceof ErreurLecturePy && e.nature !== "RecursionError"))
      return null;
    throw e;
  }
  return getPy(params, "seed");
}

/** Fichier purgé entre la lecture de la ligne et l'envoi : 404 comme une image expirée (Python : 500). */
async function envoyerImage(...args: Parameters<typeof reponseFichier>): Promise<FastifyReply> {
  try {
    return await reponseFichier(...args);
  } catch (e) {
    if ((e as { cause?: { code?: unknown } }).cause?.code === "ENOENT") throw new HttpError(404, INTROUVABLE);
    throw e;
  }
}

function route(methode: DefinitionRoute["methode"], chemin: string, traiter: Traitement): DefinitionRoute {
  return { methode, chemin, processus: ["main"], acces: "session", traiter };
}

/** Lire et effacer SES images ne demande que d'en être le propriétaire : celle d'un autre compte répond 404, comme une image inexistante. */
export function creerFamilleImages(dep: DependancesImages): Famille {
  const base = dep.base;
  return {
    nom: "images",
    routes: [
      route("GET", "/api/image/status", async (req, rep) => {
        const uid = utilisateur(req);
        const out = await statusFor(base, uid);
        if (veritePy(out["ready"]) && out["provider"] === "sdcpp")
          out["model"] = await announcedModel(getImageConfig());
        return repondreAnnote(rep, out);
      }),
      route("GET", "/api/images", async (req, rep) => {
        const uid = utilisateur(req);
        const { query } = entrees(req, {
          query: {
            before: py.optional(py.float()).defaut(null),
            limit: py.int().defaut(50),
            chat_id: py.optional(py.str()).defaut(null),
          },
        });
        const chatId = query.chat_id;
        if (chatId !== null && !(0 < longueurPy(chatId) && longueurPy(chatId) <= 191))
          throw new HttpError(400, "Conversation invalide.");
        if (query.before !== null && !Number.isFinite(query.before))
          throw new HttpError(400, "Curseur invalide.");
        const [items, suite, total] = await listImages(base, uid, {
          before: query.before,
          limit: query.limit,
          chatId,
        });
        return repondreAnnote(rep, {
          items,
          next_before: suite,
          total,
          keep: getImageConfig().keep_per_user,
        });
      }),
      route("GET", "/api/images/:image_id", async (req, rep) => {
        const uid = utilisateur(req);
        const { path, query } = entrees(req, {
          path: { image_id: py.str() },
          query: { thumb: py.int().defaut(0) },
        });
        const imageId = path.image_id;
        const row = await getImage(base, uid, imageId);
        if (!row) throw new HttpError(404, INTROUVABLE);
        const headers = {
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        };
        if (query.thumb && row.thumb_path)
          return envoyerImage(req, rep, row.thumb_path, { mediaType: "image/webp", headers });
        const seed = graine(row["params_json"]);
        const prompt = veritePy(row["prompt"]) ? strPy(row["prompt"]) : "";
        return envoyerImage(req, rep, row.path, {
          mediaType: row.mime,
          filename: downloadName(prompt, seed, row.mime, imageId),
          contentDispositionType: "inline",
          headers,
        });
      }),
      route("DELETE", "/api/images/:image_id", async (req, rep) => {
        const uid = utilisateur(req);
        const { path } = entrees(req, { path: { image_id: py.str() } });
        if (!(await deleteImage(base, uid, path.image_id))) throw new HttpError(404, INTROUVABLE);
        return repondreAnnote(rep, { ok: true });
      }),
    ],
  };
}
