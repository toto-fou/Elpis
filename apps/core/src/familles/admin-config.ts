// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-config.ts — console : compression, fichier config.json et écritures champ par champ (admin/config.py). */
import { copyFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  egalPy,
  ErreurJsonPy,
  ErreurPython,
  estDict,
  floatPy,
  getOu,
  getPy,
  HttpError,
  lireTextePy,
  lowerPy,
  maxPy,
  messageErreurOs,
  minPy,
  nomTypePy,
  ouPy,
  poserCle,
  pyJsonDumps,
  pyJsonLoads,
  reprPy,
  rstripPy,
  stripPy,
  veritePy,
  versFlottantPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import {
  config,
  CONFIG_ILLISIBLE,
  invalidateConfigCache,
  marquerCompressionAJour,
  reloadCompressionConfigFromDisk,
  sousVerrouConfigJson,
  writeConfigJson,
  writeTextAtomic,
} from "@elpis/config";
import type { FastifyReply, FastifyRequest } from "fastify";

import { entierPy, exigerTexte, lireConfigPourEcrire } from "../admin/aides";
import {
  applySectionOwnership,
  dig,
  estSecretMasque,
  MASQUE_SECRET,
  masquerSecrets,
  masquerSecretsTexte,
  PATCH_MAX_CHANGES,
  PATCH_PATH_RE,
  plant,
  removePath,
  restaurerSecretsMasques,
  sameValue,
  touchesOwned,
} from "../admin/config";
import { sectionDict } from "../admin/securite";
import { existePy } from "../apparence/skins";
import { closeEndpointClient } from "../contexte/compresseur";
import type { Journal } from "../journal";
import type { Acces, DefinitionRoute, Famille, Traitement } from "../routes";
import { corpsJsonValeurs, entrees, py, reponseJsonPy } from "@elpis/http";

export interface DependancesAdminConfig {
  readonly journal: Journal;
  /** `close_endpoint_client` du compresseur (client HTTP recréé avec la nouvelle adresse). */
  readonly fermerClientCompression?: () => Promise<void>;
}

const MORTES = ["trigger_after_turns", "compress_every", "pct_of_ctx", "cooldown_iters", "min_growth_tokens"];

function route(
  methode: "GET" | "POST" | "PATCH",
  chemin: string,
  acces: Acces,
  traiter: Traitement,
): DefinitionRoute {
  return { methode, chemin, processus: ["admin"], acces, traiter };
}

/** `_bounded` : `int(val)` borné, la valeur courante si la conversion échoue. */
function borneEntier(v: unknown, bas: number, haut: number, defaut: number): number {
  let n: number | bigint;
  try {
    n = entierPy(v);
  } catch (e) {
    if (e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError")) return defaut;
    throw e;
  }
  if (typeof n === "bigint") return n > BigInt(haut) ? haut : n < BigInt(bas) ? bas : Number(n);
  return maxPy(bas, minPy(haut, n));
}

/** `_bounded_float` : `max(lo, min(hi, float(val)))` (NaN donne `hi`, comme `min` de Python). */
function borneFlottant(v: unknown, bas: number, haut: number, defaut: number): number {
  let x: number;
  try {
    x = floatPy(v);
  } catch (e) {
    if (e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError")) return defaut;
    throw e;
  }
  return maxPy(bas, minPy(haut, x));
}

/** `(body.get(cle) or "").strip()`. */
function texteNettoye(corps: unknown, cle: string): string {
  return stripPy(exigerTexte(ouPy(getPy(corps, cle, null), "")));
}

function champsCompression(c: typeof config = config): Dict {
  return {
    enabled: c.COMPRESSION_ENABLED,
    keep_recent_turns: c.COMPRESSION_KEEP_RECENT,
    keep_bridge_turns: c.COMPRESSION_KEEP_BRIDGE,
    external_model: c.COMPRESSION_EXTERNAL_MODEL,
    endpoint_url: c.COMPRESSION_ENDPOINT_URL,
    endpoint_model: c.COMPRESSION_ENDPOINT_MODEL,
    endpoint_timeout_sec: c.COMPRESSION_ENDPOINT_TIMEOUT_SEC,
    max_per_chat: c.COMPRESSION_MAX_PER_CHAT,
    buffer_tokens: c.COMPACTION_BUFFER_TOKENS,
    partial_target_ratio: versFlottantPy(c.COMPACTION_PARTIAL_TARGET_RATIO),
    threshold_pct: c.COMPACTION_THRESHOLD_PCT,
    threshold_tokens: c.COMPACTION_THRESHOLD_TOKENS,
  };
}

/** `Path.with_suffix(".json.bak")`. */
function cheminSauvegarde(chemin: string): string {
  const nom = basename(chemin);
  const point = nom.lastIndexOf(".");
  return join(dirname(chemin), `${point > 0 ? nom.slice(0, point) : nom}.json.bak`);
}

function messageDe(e: unknown, chemin: string): string {
  return typeof (e as { code?: unknown }).code === "string"
    ? messageErreurOs(e, chemin)
    : e instanceof Error
      ? e.message
      : String(e);
}

export function creerFamilleAdminConfig(dep: DependancesAdminConfig): Famille {
  const fermerClient = dep.fermerClientCompression ?? closeEndpointClient;

  function recharger(contexte: string): void {
    try {
      reloadCompressionConfigFromDisk();
    } catch (e) {
      dep.journal.warn(`[admin] ${contexte} : ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function lireCompression(_req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> {
    recharger("reload_compression_config_from_disk échoué");
    return reponseJsonPy(rep, champsCompression(), { "Cache-Control": "no-cache" });
  }

  async function ecrireCompression(req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> {
    let corps: unknown;
    try {
      corps = corpsJsonValeurs(req);
    } catch {
      throw new HttpError(400, "JSON body requis");
    }
    recharger("reload avant POST échoué");
    const c = { ...config };
    c.COMPRESSION_ENABLED = veritePy(getPy(corps, "enabled", c.COMPRESSION_ENABLED));
    c.COMPRESSION_KEEP_RECENT = borneEntier(
      getPy(corps, "keep_recent_turns"),
      2,
      50,
      c.COMPRESSION_KEEP_RECENT,
    );
    c.COMPRESSION_KEEP_BRIDGE = borneEntier(
      getPy(corps, "keep_bridge_turns"),
      0,
      20,
      c.COMPRESSION_KEEP_BRIDGE,
    );
    c.COMPRESSION_EXTERNAL_MODEL = texteNettoye(corps, "external_model");
    let url = texteNettoye(corps, "endpoint_url");
    if (url) {
      const bas = lowerPy(url);
      if (!bas.includes("/v1/chat/completions") && !bas.includes("/chat/completions"))
        url = `${rstripPy(url, "/")}/v1/chat/completions`;
    }
    c.COMPRESSION_ENDPOINT_URL = url;
    c.COMPRESSION_ENDPOINT_MODEL = texteNettoye(corps, "endpoint_model");
    c.COMPRESSION_ENDPOINT_TIMEOUT_SEC = borneEntier(
      getPy(corps, "endpoint_timeout_sec"),
      10,
      600,
      c.COMPRESSION_ENDPOINT_TIMEOUT_SEC,
    );
    c.COMPRESSION_MAX_PER_CHAT = borneEntier(getPy(corps, "max_per_chat"), 0, 10, c.COMPRESSION_MAX_PER_CHAT);
    c.COMPACTION_BUFFER_TOKENS = maxPy(
      0,
      borneEntier(getPy(corps, "buffer_tokens"), 0, 1_000_000, c.COMPACTION_BUFFER_TOKENS),
    );
    c.COMPACTION_PARTIAL_TARGET_RATIO = borneFlottant(
      getPy(corps, "partial_target_ratio"),
      0.2,
      0.9,
      c.COMPACTION_PARTIAL_TARGET_RATIO,
    );
    if (Object.hasOwn(corps as Dict, "threshold_pct")) {
      const v = borneEntier(getPy(corps, "threshold_pct"), 0, 100, c.COMPACTION_THRESHOLD_PCT);
      c.COMPACTION_THRESHOLD_PCT = v <= 0 ? 0 : maxPy(30, v);
    }
    if (Object.hasOwn(corps as Dict, "threshold_tokens")) {
      const v = borneEntier(getPy(corps, "threshold_tokens"), 0, 4_000_000, c.COMPACTION_THRESHOLD_TOKENS);
      c.COMPACTION_THRESHOLD_TOKENS = v <= 0 ? 0 : maxPy(2_048, v);
    }
    await fermerClient().catch(() => undefined);
    try {
      await sousVerrouConfigJson(() => {
        const cfg = lireConfigPourEcrire();
        const llm = sectionDict(cfg, "llm");
        const comp = sectionDict(llm, "compression");
        const champs = champsCompression(c);
        for (const cle of [
          "enabled",
          "keep_recent_turns",
          "keep_bridge_turns",
          "external_model",
          "endpoint_url",
          "endpoint_model",
          "endpoint_timeout_sec",
          "max_per_chat",
        ])
          poserCle(comp, cle, champs[cle]);
        for (const morte of MORTES) delete comp[morte];
        const compaction = sectionDict(llm, "compaction");
        for (const cle of ["buffer_tokens", "partial_target_ratio", "threshold_pct", "threshold_tokens"])
          poserCle(compaction, cle, champs[cle]);
        writeConfigJson(cfg);
      });
      marquerCompressionAJour();
    } catch (e) {
      if (e instanceof HttpError) throw e;
      dep.journal.warn(
        `[admin] persist compression_config échoué : ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    for (const k of Object.keys(c))
      if (k.startsWith("COMPRESSION_") || k.startsWith("COMPACTION_")) (config as Dict)[k] = (c as Dict)[k];
    return reponseJsonPy(rep, champsCompression());
  }

  async function lireFichier(req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> {
    const { type } = entrees(req, { query: { type: py.str() } }).query;
    if (type !== "main") throw new HttpError(400, "Unknown config type");
    const chemin = config.CONFIG_JSON_PATH;
    if (!existePy(chemin)) return reponseJsonPy(rep, { content: "{}" });
    let contenu: string;
    try {
      contenu = lireTextePy(chemin);
    } catch (e) {
      throw new HttpError(500, `Error reading file: ${messageDe(e, chemin)}`);
    }
    return reponseJsonPy(rep, { content: contenuSansSecret(contenu) });
  }

  /** Le texte tel quel, sauf les secrets de `SECRETS_MASQUES` remplacés par un masque (réécrit au format des écritures de la console). */
  function contenuSansSecret(contenu: string): string {
    let cfg: unknown;
    try {
      cfg = pyJsonLoads(contenu);
    } catch {
      return masquerSecretsTexte(contenu);
    }
    if (!estDict(cfg)) return contenu;
    const [masque, change] = masquerSecrets(cfg);
    return change ? pyJsonDumps(masque, { ensureAscii: false, indent: 2 }) : contenu;
  }

  async function ecrireFichier(req: FastifyRequest): Promise<Dict> {
    const data = corpsJsonValeurs(req);
    const type = getPy(data, "type");
    const contenu = getPy(data, "content");
    if (typeof contenu !== "string")
      throw new ErreurPython(
        "TypeError",
        `the JSON object must be str, bytes or bytearray, not ${nomTypePy(contenu)}`,
      );
    let entrant: unknown;
    try {
      entrant = pyJsonLoads(contenu);
    } catch (e) {
      if (e instanceof ErreurJsonPy) throw new HttpError(400, "Syntaxe JSON invalide.");
      throw e;
    }
    if (!estDict(entrant)) throw new HttpError(400, "Le contenu doit être un objet JSON.");
    if (type !== "main") throw new HttpError(400, "Unknown config type");
    const chemin = config.CONFIG_JSON_PATH;
    await sousVerrouConfigJson(() => {
      let texte = contenu;
      try {
        let disque: unknown = {};
        if (existePy(chemin)) {
          try {
            disque = pyJsonLoads(lireTextePy(chemin));
          } catch {
            disque = {};
          }
          if (!estDict(disque)) disque = {};
        }
        restaurerSecretsMasques(entrant, disque as Dict);
        if (Object.hasOwn(entrant, "llm") && !estDict(entrant["llm"])) poserCle(entrant, "llm", {});
        const restaures = applySectionOwnership(entrant, disque as Dict);
        if (restaures.length)
          dep.journal.info(
            `[admin] save config-file : ${restaures.length} section(s) restaurée(s) depuis le disque (le formulaire en portait une copie périmée) : ${restaures.join(", ")}`,
          );
        if (egalPy(getOu(entrant, "llm", null), {})) delete entrant["llm"];
        texte = pyJsonDumps(entrant, { ensureAscii: false, indent: 2 });
      } catch (e) {
        dep.journal.warn(
          `[admin] save config-file : merge propriété échoué (${(e instanceof Error ? e.message : String(e)).slice(0, 200)}) — écriture du payload tel quel en fallback`,
        );
      }
      try {
        if (existePy(chemin)) copyFileSync(chemin, cheminSauvegarde(chemin));
        writeTextAtomic(chemin, texte);
      } catch (e) {
        throw new HttpError(500, `Error writing file: ${messageDe(e, chemin)}`);
      }
    });
    invalidateConfigCache();
    return { ok: true };
  }

  async function modifierChamps(req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> {
    const corps = corpsJsonValeurs(req);
    if (!estDict(corps)) throw new HttpError(400, "Le contenu doit être un objet JSON.");
    const changements = getPy(corps, "changes", null);
    const force = veritePy(getPy(corps, "force", null));
    if (!Array.isArray(changements) || !changements.length)
      throw new HttpError(400, "Aucune modification à enregistrer.");
    if (changements.length > PATCH_MAX_CHANGES)
      throw new HttpError(400, "Trop de modifications en une fois.");
    const lus: [string[], Dict][] = [];
    for (const c of changements) {
      if (!estDict(c)) throw new HttpError(400, "Modification mal formée.");
      const chemin = getPy(c, "path", null);
      if (typeof chemin !== "string" || !PATCH_PATH_RE.test(chemin))
        throw new HttpError(400, `Chemin de réglage invalide : ${reprPy(chemin)}`);
      if (!Object.hasOwn(c, "to") && !veritePy(getPy(c, "delete", null)))
        throw new HttpError(400, `Valeur manquante pour ${chemin}.`);
      lus.push([chemin.split("."), c]);
    }
    const possedes = lus.filter(([p]) => touchesOwned(p)).map(([p]) => p.join("."));
    if (possedes.length)
      return reponseJsonPy(rep.code(400), {
        detail: `Réglé par un autre écran : ${possedes.join(", ")}.`,
        paths: possedes,
      });
    const chemin = config.CONFIG_JSON_PATH;
    const issue = await sousVerrouConfigJson((): ["illisible"] | ["conflit", Dict[]] | ["ok", number] => {
      let disque: unknown = {};
      if (existePy(chemin)) {
        try {
          disque = pyJsonLoads(lireTextePy(chemin) || "{}");
        } catch (e) {
          if (e instanceof ErreurJsonPy) return ["illisible"];
          throw e;
        }
        if (!estDict(disque)) disque = {};
      }
      const d = disque as Dict;
      if (!force) {
        const conflits: Dict[] = [];
        for (const [parties, c] of lus) {
          if (estSecretMasque(parties)) continue;
          const [trouve, actuel] = dig(d, parties);
          if (veritePy(getPy(c, "from_absent", null))) {
            if (trouve) conflits.push({ path: parties.join("."), current: actuel });
          } else if (Object.hasOwn(c, "from")) {
            if (!trouve || !sameValue(actuel, c["from"]))
              conflits.push({ path: parties.join("."), current: trouve ? actuel : null, absent: !trouve });
          }
        }
        if (conflits.length) return ["conflit", conflits];
      }
      for (const [parties, c] of lus) {
        if (veritePy(getPy(c, "delete", null))) removePath(d, parties);
        else if (!(estSecretMasque(parties) && c["to"] === MASQUE_SECRET)) plant(d, parties, c["to"]);
      }
      if (existePy(chemin)) copyFileSync(chemin, cheminSauvegarde(chemin));
      writeTextAtomic(chemin, pyJsonDumps(d, { ensureAscii: false, indent: 2 }));
      return ["ok", lus.length];
    });
    if (issue[0] === "illisible") throw new HttpError(500, CONFIG_ILLISIBLE);
    if (issue[0] === "conflit")
      return reponseJsonPy(rep.code(409), { detail: "Modifié ailleurs entre-temps.", conflicts: issue[1] });
    invalidateConfigCache();
    dep.journal.info(
      `[admin] config PATCH${force ? " (forcé)" : ""} : ${issue[1]} champ(s) — ${lus
        .map(([p]) => p.join("."))
        .join(", ")
        .slice(0, 400)}`,
    );
    return reponseJsonPy(rep, { ok: true, applied: issue[1] });
  }

  return {
    nom: "admin-config",
    routes: [
      route("GET", "/api/admin/compression-config", "staff", lireCompression),
      route("POST", "/api/admin/compression-config", "admin", ecrireCompression),
      route("GET", "/api/admin/config-file", "admin", lireFichier),
      route("POST", "/api/admin/config-file", "admin", ecrireFichier),
      route("PATCH", "/api/admin/config", "admin", modifierChamps),
    ],
  };
}
