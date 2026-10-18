// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/fs/navigation.ts — outil `code` (fs_tools.py) : plan d'un fichier ou d'un lot, symboles, définitions et références sous un dossier (préfiltre par l'agent, lectures groupées). */
import { estErreurAgent } from "@elpis/bac";
import {
  compilerPy,
  intPy,
  longueurPy,
  lowerPy,
  poserCle,
  stripPy,
  strPy,
  trouverTout,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { asList, getUsername, globMatch, ok } from "@elpis/outils-mcp";
import type { ContexteAppel } from "@elpis/outils-mcp";
import { toContainer } from "@elpis/securite";

import { Espace } from "../espace";
import { errAgent, errAgentLien, grepLots, lireLots, nomDe, PROFONDEUR, relDe, strErreur } from "./acces";
import {
  detecterLangage,
  EXTENSIONS_CODE,
  listerSymboles,
  outline,
  resumer,
  trouverDefinition,
  trouverReferences,
} from "./code";
import { decoderPy } from "./codecs";
import { errFs, estValueError } from "./edition";
import { MAX_EDIT_BYTES } from "./ecriture";
import { MAX_BATCH_PATHS } from "./lecture";
import { DEFAULT_DEP_EXCLUDES, MAX_WALK } from "./liste";
import { cleParcours, comparerCles } from "./texte";

/** Arguments validés de `code`. */
export interface ArgsCode {
  readonly action: string;
  readonly path: string;
  readonly paths: unknown;
  readonly symbol: string;
  readonly scope: string;
  readonly include_glob: string;
  readonly exclude: unknown;
  readonly max_depth: number;
  readonly max_results: number;
  readonly recursive: boolean;
}

const SEPARATEURS = compilerPy("[\\W_]+");

/** `max(re.split(r"[\W_]+", s), key=len)` : le plus long fragment alphanumérique (le premier à égalité). */
export function plusLongFragment(s: string): string {
  const morceaux: string[] = [];
  let debut = 0;
  for (const m of trouverTout(SEPARATEURS, s)) {
    morceaux.push(s.slice(debut, m.debut));
    debut = m.fin;
  }
  morceaux.push(s.slice(debut));
  let meilleur = morceaux[0] as string;
  for (const x of morceaux) if (longueurPy(x) > longueurPy(meilleur)) meilleur = x;
  return meilleur;
}

/** `_outline_one` : plan d'un fichier ; refus du chemin, de l'agent ou de la taille en enveloppe d'erreur. */
async function planDe(chemin: string, a: ArgsCode, esp: Espace): Promise<Dict> {
  let rel: string;
  try {
    rel = relDe(esp.racine, chemin);
  } catch (e) {
    if (estValueError(e)) return errFs(e.message, "", { path: chemin });
    throw e;
  }
  const pp = toContainer(rel);
  let texte: string;
  try {
    const e = await esp.stat(rel);
    if (e["kind"] === "missing") return errFs("not_found", "", { path: pp });
    if (e["kind"] === "dir") return errFs("is_directory", "outline expects a single file.", { path: pp });
    const taille = intPy(e["size"] || 0);
    if (taille > MAX_EDIT_BYTES)
      return errFs("too_large", "File too large for outline.", { size: taille, max: MAX_EDIT_BYTES });
    texte = decoderPy((await esp.lire(rel, { maxBytes: MAX_EDIT_BYTES })).data, "utf-8", "replace");
  } catch (x) {
    if (estErreurAgent(x)) return await errAgentLien(esp, x, rel);
    throw x;
  }
  const langage = detecterLangage(nomDe(esp, rel));
  if (langage === "unknown")
    return ok({
      path: pp,
      language: "unknown",
      outline: [],
      note: "extension not supported by code_intel",
      summary: "(unknown language)",
    });
  return ok({
    path: pp,
    language: langage,
    outline: outline(texte, langage, a.max_depth),
    summary: resumer(texte, langage),
  });
}

/** Outil `code` : outline, symbols, definition, references. */
export async function codeOutil(a: ArgsCode, ctx: ContexteAppel): Promise<Dict> {
  const username = getUsername(ctx);
  let lieu = "";
  try {
    const esp = await Espace.pour(username);
    const act = lowerPy(stripPy(a.action || ""));
    const chemins = asList(a.paths);
    const exclus = asList(a.exclude)
      .filter((e) => veritePy(e))
      .map((e) => strPy(e));

    if (act === "outline") {
      if (chemins.length) {
        if (a.path) return errFs("conflict", "Pass path=<single> OR paths=[...], not both.");
        if (chemins.length > MAX_BATCH_PATHS)
          return errFs("too_many_paths", `Max ${MAX_BATCH_PATHS} per call.`);
        const fichiers: Dict = {};
        let reussis = 0;
        for (const rp of chemins) {
          if (typeof rp !== "string" || !rp) {
            poserCle(fichiers, strPy(rp), errFs("bad_path"));
            continue;
          }
          const r = await planDe(rp, a, esp);
          poserCle(fichiers, rp, r);
          if (veritePy(r["ok"])) reussis++;
        }
        return ok({
          action: "batch_outline",
          count: chemins.length,
          succeeded: reussis,
          failed: chemins.length - reussis,
          files: fichiers,
        });
      }
      if (!a.path) return errFs("path_required", "Pass path=<file> or paths=[<file1>, ...].");
      return await planDe(a.path, a, esp);
    }

    if (act === "symbols") {
      if (!a.path) return errFs("path_required", "path=<file> for symbols");
      const rel = relDe(esp.racine, a.path);
      const pp = toContainer(rel);
      let texte: string;
      try {
        texte = decoderPy((await esp.lire(rel, { maxBytes: MAX_EDIT_BYTES })).data, "utf-8", "replace");
      } catch (x) {
        if (estErreurAgent(x) && ["not_found", "is_dir", "not_file"].includes(x.code))
          return errFs("not_a_file", "", { path: pp });
        if (estErreurAgent(x)) return await errAgentLien(esp, x, rel);
        throw x;
      }
      const langage = detecterLangage(nomDe(esp, rel));
      if (langage === "unknown")
        return ok({ action: "symbols", path: pp, language: "unknown", count: 0, matches: [] });
      const symboles = listerSymboles(texte, langage);
      return ok({
        action: "symbols",
        path: pp,
        language: langage,
        count: symboles.length,
        matches: symboles,
      });
    }

    if (act !== "definition" && act !== "references")
      return errFs("invalid_action", "Use: outline | symbols | definition | references");
    if (!a.symbol) return errFs("symbol_required");
    const cap = Math.max(1, Math.min(a.max_results, 5000));
    const srel = a.scope ? relDe(esp.racine, a.scope) : "";
    lieu = srel;
    if ((await esp.stat(srel))["kind"] !== "dir")
      return errFs("scope_not_a_dir", "", { scope: toContainer(srel) });
    const liste = await esp.lister(srel, {
      depth: a.recursive ? PROFONDEUR : 1,
      maxEntries: MAX_WALK,
      hidden: false,
      exclude: exclus.length ? exclus : [...DEFAULT_DEP_EXCLUDES],
    });
    const fichiers: [string, string, string][] = [];
    for (const x of liste.entries) {
      if (x["kind"] !== "file" || intPy(x["size"] || 0) > MAX_EDIT_BYTES) continue;
      const chemin = String(x["path"]);
      const rel = srel ? chemin.slice(srel.length + 1) : chemin;
      if (a.include_glob && !globMatch(rel, a.include_glob)) continue;
      const langage = detecterLangage(rel.slice(rel.lastIndexOf("/") + 1));
      if (langage !== "unknown") fichiers.push([rel, chemin, langage]);
    }
    const cles = new Map(fichiers.map((f) => [f, cleParcours(f[0], false)]));
    fichiers.sort((x, y) => comparerCles(cles.get(x) ?? [], cles.get(y) ?? []));
    const fragment = plusLongFragment(a.symbol);
    const retenus = new Set<string>();
    for (const robot of [false, true]) {
      const lot = fichiers.filter((f) => (f[2] === "robot") === robot).map((f) => f[1]);
      const aiguille = robot ? fragment : a.symbol;
      if (!lot.length) continue;
      if (!aiguille) {
        for (const c of lot) retenus.add(c);
        continue;
      }
      const [trouves] = await grepLots(esp, lot, aiguille, {
        ignoreCase: robot,
        maxFileBytes: MAX_EDIT_BYTES,
        maxHits: lot.length,
        filesOnly: true,
      });
      for (const t of trouves) retenus.add(String(t["file"]));
    }
    const parChemin = new Map(fichiers.filter((f) => retenus.has(f[1])).map((f) => [f[1], f] as const));
    const hits: Dict[] = [];
    const fin = (tronque: boolean): Dict =>
      ok({
        action: act,
        query: a.symbol,
        count: hits.length,
        files_scanned: fichiers.length,
        ...(fichiers.length
          ? {}
          : {
              hint: `No file was scanned: only these extensions are parsed (${EXTENSIONS_CODE.join(" ")})${a.include_glob ? `, then filtered by include_glob=${JSON.stringify(a.include_glob)}` : ""}. Use search_text for other file types.`,
            }),
        matches: hits,
        truncated: tronque,
        ...(liste.truncated ? { walk_truncated: true } : {}),
      });
    for await (const [chemin, data] of lireLots(esp, [...parChemin.keys()], MAX_EDIT_BYTES)) {
      if (data === null) continue;
      const [rel, , langage] = parChemin.get(chemin) as [string, string, string];
      const texte = decoderPy(data, "utf-8", "replace");
      const trouves =
        act === "definition"
          ? trouverDefinition(texte, langage, a.symbol)
          : trouverReferences(texte, langage, a.symbol, cap - hits.length);
      for (const it of trouves) {
        hits.push({ file: rel, rel: chemin, path: toContainer(chemin), ...it });
        if (hits.length >= cap) return fin(true);
      }
    }
    return fin(false);
  } catch (e) {
    if (estErreurAgent(e)) return errAgent(e, lieu);
    if (estValueError(e)) return errFs(e.message);
    return errFs(`unexpected: ${strErreur(e)}`);
  }
}
