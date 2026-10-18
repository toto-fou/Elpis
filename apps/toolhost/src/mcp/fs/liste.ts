// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/fs/liste.ts — `list_files` (fs_tools.py) : liste, glob, recherche de texte par l'agent, métadonnées d'un fichier, filtre `since`, état Git et pagination par curseur. */
import { estErreurAgent } from "@elpis/bac";
import {
  BLANC_PY,
  clesOrdonnees,
  comparePointsDeCode,
  ErreurPython,
  floatPy,
  FlottantPy,
  intPy,
  longueurPy,
  lowerPy,
  poserCle,
  prefixePy,
  splitlinesPy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { getUsername, globMatch, ok } from "@elpis/outils-mcp";
import type { ContexteAppel } from "@elpis/outils-mcp";
import { toContainer } from "@elpis/securite";

import { Espace } from "../espace";
import {
  errAgent,
  errAgentLien,
  grand,
  grepLots,
  mime,
  nomDe,
  PROFONDEUR,
  relDe,
  statEntree,
  strErreur,
} from "./acces";
import { suffixe } from "./code";
import { decoderPy } from "./codecs";
import { errFs, estValueError } from "./edition";
import { MAX_GREP } from "./lecture";
import { cleParcours, comparerCles, encodageBom, estTexte } from "./texte";

export const MAX_LIST = 4000;
export const MAX_WALK = 50_000;
const SEARCH_MAX_BYTES = 20 * 1024 * 1024;
/** Dossiers de dépendances et de build écartés faute d'`exclude` explicite. */
export const DEFAULT_DEP_EXCLUDES = [
  "node_modules", "site-packages", "dist-info", "__pycache__", ".venv", "venv", ".tox", ".nox",
  ".mypy_cache", ".pytest_cache", ".ruff_cache", ".gradle", "vendor", "target",
] as const; // prettier-ignore

/** Arguments validés de `list_files`. */
export interface ArgsListe {
  readonly path: string;
  readonly pattern: string;
  readonly search_text: string;
  readonly recursive: boolean;
  readonly ignore_case: boolean;
  readonly max_results: number;
  readonly details: boolean;
  readonly exclude: readonly string[];
  readonly sort_by: string;
  readonly include_hidden: boolean;
  readonly summary: boolean;
  readonly cursor: string;
  readonly since: string;
  readonly include_git_status: boolean;
}

const DUREE = new RegExp(`^(\\p{Nd}+)${BLANC_PY}*([smhdw])$`, "u");
const UNITES: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
const D = "\\p{Nd}";
const JOUR = `(3[01]|[12]${D}|0[1-9]|[1-9]| [1-9])`;
const DATE = `(${D}${D}${D}${D})-(1[0-2]|0[1-9]|[1-9])-${JOUR}`;
const HEURE = `(2[0-3]|[01]${D}|${D}):([0-5]${D}|${D}):(6[01]|[0-5]${D}|${D})`;
/** Formats de `datetime.strptime` essayés (`_strptime` : regex, IGNORECASE, espace → `\s+`). */
const FORMATS_ISO = [
  new RegExp(`^${DATE}`, "iu"),
  new RegExp(`^${DATE}T${HEURE}`, "iu"),
  new RegExp(`^${DATE}${BLANC_PY}+${HEURE}`, "iu"),
];

function bissextile(a: number): boolean {
  return (a % 4 === 0 && a % 100 !== 0) || a % 400 === 0;
}

/** `datetime(...).timestamp()` d'une date locale ; `null` hors bornes de `datetime`. */
function horodatageLocal(c: readonly number[]): number | null {
  const [a, mo, j, h = 0, mi = 0, s = 0] = c as [number, number, number, number?, number?, number?];
  const jours = [31, bissextile(a) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1] ?? 0;
  if (a < 1 || j > jours || s > 59) return null;
  const d = new Date(2000, 0, 1, 0, 0, 0, 0);
  d.setFullYear(a, mo - 1, j);
  d.setHours(h, mi, s, 0);
  return d.getTime() / 1000;
}

/** `_parse_since` : epoch, durée relative (`1h`, `7d`, `30m`) ou date ISO locale ; `null` sinon. */
export function parseSince(valeur: string, maintenant = Date.now() / 1000): number | null {
  if (!valeur) return null;
  const s = stripPy(strPy(valeur));
  try {
    return floatPy(s);
  } catch (e) {
    if (!(e instanceof ErreurPython && e.type === "ValueError")) throw e;
  }
  const m = DUREE.exec(lowerPy(s));
  if (m) return maintenant - intPy(m[1]) * (UNITES[m[2] as string] as number);
  for (const f of FORMATS_ISO) {
    const r = f.exec(s);
    if (r === null || r[0].length !== s.length) continue;
    const t = horodatageLocal(r.slice(1).map((x) => intPy(x)));
    if (t !== null) return t;
  }
  return null;
}

/** `_git_status_map` : statut porcelain des chemins relatifs au dossier listé, ou la raison de son absence. */
async function etatGit(esp: Espace, rel: string): Promise<[Dict, string | null]> {
  const pourquoi = (r: { timed_out: boolean; stderr: string; returncode: number }): string => {
    if (r.timed_out) return "git status timed out";
    const lignes = splitlinesPy(stripPy(r.stderr || ""));
    return prefixePy(
      lignes.length ? (lignes[lignes.length - 1] as string) : `git exited with ${r.returncode}`,
      200,
    );
  };
  let sortie: string;
  let prefixe: string;
  try {
    const pp = await esp.git(rel, ["rev-parse", "--show-prefix"], { timeoutS: 2, maxOut: 1 << 16 });
    if (pp.returncode !== 0) return [{}, pourquoi(pp)];
    prefixe = stripPy(pp.stdout);
    const proc = await esp.git(rel, ["status", "--porcelain=v1"], { timeoutS: 2, maxOut: 4 << 20 });
    if (proc.returncode !== 0) return [{}, pourquoi(proc)];
    sortie = proc.stdout;
  } catch (e) {
    if (estErreurAgent(e)) return [{}, `git unavailable (${e.code})`];
    throw e;
  }
  const carte: Dict = {};
  for (const ligne of splitlinesPy(sortie)) {
    if (longueurPy(ligne) < 4) continue;
    const code = prefixePy(ligne, 2);
    let chemin = stripPy(ligne.slice(prefixePy(ligne, 3).length));
    const fleche = chemin.indexOf(" -> ");
    if (fleche >= 0) chemin = chemin.slice(fleche + 4);
    if (prefixe) {
      if (!chemin.startsWith(prefixe)) continue;
      chemin = chemin.slice(prefixe.length);
    }
    poserCle(carte, chemin, code);
  }
  return [carte, null];
}

type Entree = [string, Dict];

/** `stat` groupé des liens d'une page, coupé en deux quand la réponse dépasse la borne du client. */
async function statsLiens(esp: Espace, rels: readonly string[]): Promise<Dict[]> {
  try {
    return await esp.stats(rels);
  } catch (e) {
    if (!estErreurAgent(e) || e.code !== "too_large" || rels.length < 2) throw e;
    const m = rels.length >> 1;
    return [...(await statsLiens(esp, rels.slice(0, m))), ...(await statsLiens(esp, rels.slice(m)))];
  }
}

/** Cible d'un lien lue par l'agent (jamais suivi hors du bac) : `broken` vaut `null` quand la cible sort du bac. */
function lienDe(e: Dict): Dict {
  const cible = e["link"] === true && typeof e["target"] === "string" ? e["target"] : null;
  if (cible !== null && veritePy(e["outside"]))
    return { target: cible, target_in_sandbox: false, broken: null };
  if (cible === null) return { target: null, target_in_sandbox: null, broken: null };
  return { target: cible, target_in_sandbox: true, broken: e["kind"] === "link" };
}

/** `list_files` : enfants d'un dossier (ou arbre), glob, grep, ou métadonnées d'un fichier. */
export async function listFiles(a: ArgsListe, ctx: ContexteAppel): Promise<Dict> {
  const username = getUsername(ctx);
  let relRacine = "";
  let espace: Espace | null = null;
  try {
    const esp = await Espace.pour(username);
    espace = esp;
    relRacine = relDe(esp.racine, a.path);
    const racine = toContainer(relRacine);
    const eRacine = await esp.stat(relRacine);
    if (eRacine["kind"] === "missing") return errFs("not_found", "", { path: racine });
    const cap = Math.max(1, Math.min(a.max_results, MAX_LIST));

    if (eRacine["kind"] !== "dir") {
      if (eRacine["kind"] !== "file")
        return errFs(
          "not_a_regular_file",
          "FIFOs, sockets, device files and symlinks leaving /work are not read.",
        );
      const taille = intPy(eRacine["size"] || 0);
      const tete = (await esp.lire(relRacine, { length: 8192, maxBytes: 8192 })).data;
      if (a.search_text) {
        const aiguille = a.ignore_case ? lowerPy(a.search_text) : a.search_text;
        if (taille > 300_000 || !estTexte(tete))
          return errFs(
            "not_greppable",
            "Binary file or > 300 KB — use read_file(grep=…) or execute_shell grep.",
          );
        const data = decoderPy(
          (await esp.lire(relRacine, { maxBytes: 300_000 + (1 << 16) })).data,
          "utf-8",
          "replace",
        );
        const hits: Dict[] = [];
        const nom = nomDe(esp, relRacine);
        const lignes = splitlinesPy(data);
        for (let i = 0; i < lignes.length; i++) {
          const ligne = lignes[i] as string;
          if (!(a.ignore_case ? lowerPy(ligne) : ligne).includes(aiguille)) continue;
          hits.push({
            file: nom,
            rel: relRacine,
            path: racine,
            line: i + 1,
            text: longueurPy(ligne) <= 260 ? ligne : `${prefixePy(ligne, 260)}…`,
          });
          if (hits.length >= Math.min(cap, MAX_GREP))
            return ok({ action: "grep", path: racine, count: hits.length, hits, truncated: true });
        }
        return ok({ action: "grep", path: racine, count: hits.length, hits, truncated: false });
      }
      const info = statEntree(esp, relRacine, eRacine);
      if (eRacine["link"] === true) Object.assign(info, { symlink: true, target: eRacine["target"] });
      info["mime"] = mime(esp, relRacine, eRacine);
      const texte = estTexte(tete);
      info["content_type"] = texte ? "text" : "binary";
      if (texte) info["encoding"] = encodageBom(tete);
      if (a.details && taille <= 10_000_000) {
        const h = await esp.stat(relRacine, { hash: true, hashMax: 10_000_000 });
        info["sha256"] = Object.hasOwn(h, "sha256") ? h["sha256"] : "";
      }
      return ok({ action: "stat", ...info });
    }

    const explicites = a.exclude.filter((e) => e);
    const exclusParDefaut = !explicites.length;
    const motifs = explicites.length ? explicites : [...DEFAULT_DEP_EXCLUDES];
    const recursif =
      a.recursive || Boolean(a.pattern && (a.pattern.includes("/") || a.pattern.includes("**")));
    const brute = await esp.lister(relRacine, {
      depth: recursif || a.search_text ? PROFONDEUR : 1,
      maxEntries: MAX_WALK,
      hidden: a.include_hidden,
      ...(exclusParDefaut ? { prune: motifs } : { exclude: motifs }),
    });
    const nomsEcartes = new Set<string>();
    const liste = exclusParDefaut
      ? {
          ...brute,
          entries: brute.entries.filter((x) => {
            const nom = String(x["path"]).slice(String(x["path"]).lastIndexOf("/") + 1);
            if (!(DEFAULT_DEP_EXCLUDES as readonly string[]).includes(nom)) return true;
            nomsEcartes.add(nom);
            return false;
          }),
        }
      : brute;
    const parcoursTronque = liste.truncated;
    const prefixe = relRacine ? `${relRacine}/` : "";
    const entrees: Entree[] = liste.entries.map(
      (x) => [String(x["path"]).slice(prefixe.length), x] as Entree,
    );
    const cles = new Map(entrees.map((rx) => [rx, cleParcours(rx[0], rx[1]["kind"] === "dir")]));
    entrees.sort((x, y) => comparerCles(cles.get(x) ?? [], cles.get(y) ?? []));

    if (a.search_text) {
      const fichiers = entrees
        .filter(([r, x]) => x["kind"] === "file" && (!a.pattern || globMatch(r, a.pattern)))
        .map(([r]) => prefixe + r);
      const [trouves, bilan] = await grepLots(esp, fichiers, a.search_text, {
        ignoreCase: a.ignore_case,
        maxFileBytes: SEARCH_MAX_BYTES,
        maxHits: Math.min(cap, MAX_GREP),
      });
      const hits = trouves.map((h) => ({
        file: String(h["file"]).slice(prefixe.length),
        rel: String(h["file"]),
        path: toContainer(String(h["file"])),
        line: h["line"],
        text: h["text"],
      }));
      if (veritePy(bilan["hits_truncated"]))
        return ok({
          action: "grep",
          path: racine,
          count: hits.length,
          hits,
          truncated: true,
          hint: "Refine with pattern= or smaller search_text.",
        });
      const extra: Dict = {};
      if (veritePy(bilan["skipped_large"])) extra["skipped_large"] = bilan["skipped_large"];
      if (veritePy(bilan["skipped_binary"])) extra["skipped_binary"] = bilan["skipped_binary"];
      if (parcoursTronque) extra["walk_truncated"] = true;
      if (Object.keys(extra).length)
        extra["hint"] =
          "Some files were NOT searched (see skipped_large / skipped_binary / walk_truncated): narrow path= or use execute_shell with grep -rn for them.";
      return ok({
        action: "grep",
        path: racine,
        count: hits.length,
        hits,
        truncated: parcoursTronque,
        ...extra,
      });
    }

    const seuil = a.since ? parseSince(a.since) : null;
    const items = entrees.filter(
      ([r, x]) =>
        (!a.pattern || globMatch(r, a.pattern)) &&
        (seuil === null || Number(grand(x["mtime_ns"])) / 1e9 >= seuil),
    );
    const dossier = (x: Dict): boolean => x["kind"] === "dir";
    if (a.sort_by === "size") {
      const cle = (x: Dict): bigint => (dossier(x) ? 0n : -grand(x["size"]));
      items.sort((x, y) => {
        const [p, q] = [cle(x[1]), cle(y[1])];
        return p < q ? -1 : p > q ? 1 : 0;
      });
    } else if (a.sort_by === "mtime") {
      items.sort((x, y) => {
        const [p, q] = [grand(x[1]["mtime_ns"]), grand(y[1]["mtime_ns"])];
        return p > q ? -1 : p < q ? 1 : 0;
      });
    } else {
      const nom = new Map(items.map((rx) => [rx, lowerPy(rx[0].slice(rx[0].lastIndexOf("/") + 1))]));
      items.sort(
        (x, y) =>
          (dossier(x[1]) ? 0 : 1) - (dossier(y[1]) ? 0 : 1) ||
          comparePointsDeCode(nom.get(x) as string, nom.get(y) as string),
      );
    }

    let debut = 0;
    if (a.cursor) {
      const k = items.findIndex(([r]) => r === a.cursor);
      if (k >= 0) debut = k + 1;
    }
    const pageItems = items.slice(debut, debut + cap);
    const tronque = parcoursTronque || items.length > debut + cap;
    const suivant = tronque && pageItems.length ? (pageItems[pageItems.length - 1] as Entree)[0] : "";
    const [git, erreurGit] = a.include_git_status ? await etatGit(esp, relRacine) : [{} as Dict, null];

    const liensPage = pageItems.filter(([, x]) => x["kind"] === "link").map(([r]) => r);
    const liens = new Map<string, Dict>();
    if (liensPage.length) {
      const st = await statsLiens(
        esp,
        liensPage.map((r) => prefixe + r),
      );
      liensPage.forEach((r, k) => liens.set(r, lienDe(st[k] ?? {})));
    }
    let sortie: unknown[];
    if (a.details)
      sortie = pageItems.map(([r, x]) => {
        const info: Dict = { ...statEntree(esp, prefixe + r, x), ...liens.get(r) };
        if (a.include_git_status && Object.hasOwn(git, r)) info["git_status"] = git[r];
        return info;
      });
    else sortie = pageItems.map(([r, x]) => r + (dossier(x) ? "/" : ""));

    const resultat = ok({
      action: "list",
      path: racine,
      count: sortie.length,
      items: sortie,
      truncated: tronque,
    });
    if (eRacine["link"] === true) Object.assign(resultat, { symlink: true, target: eRacine["target"] });
    const speciaux = pageItems.filter(([, x]) => x["kind"] === "other").map(([r]) => r);
    if (!a.details && liens.size) resultat["symlinks"] = Object.fromEntries(liens);
    if (!a.details && speciaux.length) resultat["special_files"] = speciaux;
    if (nomsEcartes.size) {
      resultat["excluded_default"] = [...nomsEcartes].sort();
      resultat["hint_excluded"] =
        "Dependency/build folders skipped by default (listed in excluded_default). exclude=[] does NOT disable this: pass any explicit exclude list that omits them, e.g. exclude=['.git'], to list them.";
    }
    if (seuil !== null) resultat["since_cutoff"] = new FlottantPy(seuil);
    if (a.since && seuil === null)
      resultat["warning"] =
        `since=${JSON.stringify(a.since)} was not understood and the time filter was ignored. Accepted: a relative duration (30m, 1h, 7d, 2w), a date (2025-01-01 or 2025-01-01 12:30:00) or an epoch in seconds.`;
    if (!items.length && a.pattern && !recursif)
      resultat["hint"] = "0 match at depth 1; retry with recursive=True";
    if (a.include_git_status) {
      const vus = new Set(pageItems.map(([r]) => r));
      const carte: Dict = {};
      for (const q of clesOrdonnees(git)) if (vus.has(q)) poserCle(carte, q, git[q]);
      resultat["git_status"] = carte;
      if (erreurGit) resultat["git_status_error"] = erreurGit;
    }
    if (suivant) {
      resultat["next_cursor"] = suivant;
      resultat["hint"] = "Call again with cursor=next_cursor for more results.";
    }
    if (parcoursTronque) {
      resultat["walk_truncated"] = true;
      resultat["hint"] =
        `Tree too large (>${MAX_WALK} entries scanned); results are partial. Narrow with pattern= or exclude=, or list a subdirectory.`;
    }
    if (a.summary) {
      let octets = 0n;
      const parExt = new Map<string, number>();
      let nFichiers = 0;
      let nDossiers = 0;
      let nLiens = 0;
      let nSpeciaux = 0;
      for (const [r, x] of items) {
        if (dossier(x)) nDossiers++;
        else if (x["kind"] === "link") nLiens++;
        else if (x["kind"] !== "file") nSpeciaux++;
        else {
          nFichiers++;
          octets += grand(x["size"]);
          const ext = lowerPy(suffixe(r)) || "(none)";
          parExt.set(ext, (parExt.get(ext) ?? 0) + 1);
        }
      }
      resultat["summary"] = {
        total_items: items.length,
        files: nFichiers,
        dirs: nDossiers,
        total_bytes: Number(octets),
        extensions: Object.fromEntries([...parExt].sort((x, y) => y[1] - x[1]).slice(0, 20)),
        ...(nLiens ? { symlinks: nLiens } : {}),
        ...(nSpeciaux ? { special_files: nSpeciaux } : {}),
      };
    }
    return resultat;
  } catch (e) {
    if (estErreurAgent(e))
      return espace === null ? errAgent(e, relRacine) : await errAgentLien(espace, e, relRacine);
    if (estValueError(e)) return errFs(e.message);
    return errFs(`unexpected: ${strErreur(e)}`);
  }
}
