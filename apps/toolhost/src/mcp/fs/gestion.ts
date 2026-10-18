// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/fs/gestion.ts — `manage_files` (fs_tools.py) : copy, move, delete, chmod, mkdir et batch_delete par l'agent, verrous de fichier, historique de session et `files_changed`. */
import { estErreurAgent } from "@elpis/bac";
import { intPy, lowerPy, rstripPy, stripPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { TOO_BIG } from "@elpis/fichiers";
import { getUsername, ok } from "@elpis/outils-mcp";
import type { ContexteAppel } from "@elpis/outils-mcp";
import { toContainer } from "@elpis/securite";

import { Espace } from "../espace";
import {
  avecVerrou,
  avecVerrous,
  entreeChangee,
  errAgent,
  FC_MAX,
  instantane,
  noterDeplacement,
  noterEcriture,
  octPy,
  PROFONDEUR,
  refusDansGitReel,
  resumerChangements,
  relDe,
  strErreur,
} from "./acces";
import { errFs, estValueError } from "./edition";
import { MAX_WALK } from "./liste";

/** Arguments validés de `manage_files`. */
export interface ArgsGestion {
  readonly action: string;
  readonly path: string;
  readonly dest: string;
  readonly recursive: boolean;
  readonly paths: readonly string[];
  readonly overwrite: boolean;
  readonly dry_run: boolean;
}

type Instantane = [string, Buffer | typeof TOO_BIG][];

/** `(e.get(k), …) == (ed.get(k), …)` sur des entiers de l'agent (nombre ou bigint, absent = None). */
function memeValeur(a: unknown, b: unknown): boolean {
  const n = (v: unknown): string => (v === undefined || v === null ? "None" : String(v));
  return n(a) === n(b);
}

function genre(e: Dict): string {
  return veritePy(e["link"]) ? "symlink" : e["kind"] === "dir" ? "dir" : "file";
}

/** `manage_files`. */
export async function manageFiles(a: ArgsGestion, ctx: ContexteAppel): Promise<Dict> {
  const username = getUsername(ctx);
  let rel = "";
  try {
    const esp = await Espace.pour(username);
    const act = lowerPy(stripPy(a.action || ""));
    const suivi = esp.uid > 0;

    const enlever = async (r: string, e: Dict, missingOk = false): Promise<Instantane | null> => {
      const retire = (res: Dict): boolean => veritePy(Object.hasOwn(res, "removed") ? res["removed"] : 1);
      if (veritePy(e["link"])) {
        const res = await esp.fsop("remove", { path: r, missing_ok: missingOk });
        return retire(res) ? [] : null;
      }
      const faire = async (): Promise<Instantane | null> => {
        const instant = suivi ? await instantane(esp, r, e) : [];
        const res = await esp.fsop("remove", { path: r, recursive: true, missing_ok: missingOk });
        return retire(res) ? instant : null;
      };
      return e["kind"] === "file" ? avecVerrou(esp, r, faire) : faire();
    };
    const noterSuppressions = async (instant: Instantane | null, fc: Dict[]): Promise<void> => {
      for (const [f, b] of instant ?? []) {
        await noterEcriture(esp, f, b, null);
        const dansGit = (p: string): boolean => p.split("/").some((s) => s.toLowerCase() === ".git");
        if (dansGit(f) || fc.filter((x) => !dansGit(String(x["path"]))).length < FC_MAX)
          fc.push(entreeChangee(f, "deleted", b, null));
      }
    };

    if (act === "batch_delete") {
      if (!a.paths.length) return errFs("paths_required", "Pass paths=[...].");
      if (a.paths.length > 500) return errFs("too_many_paths", "Max 500 per call.");
      const rels: string[] = [];
      for (const rp of a.paths) {
        try {
          rels.push(relDe(esp.racine, rp, false));
        } catch (e) {
          return errFs(`bad_path '${rp}': ${strErreur(e)}`);
        }
      }
      for (const r of rels) {
        const refus = await refusDansGitReel(esp, r);
        if (refus !== null) return refus;
      }
      const entrees = await esp.stats(rels);
      for (let k = 0; k < Math.min(a.paths.length, entrees.length); k++) {
        const e = entrees[k] as Dict;
        if (e["kind"] === "error")
          return errFs(
            `bad_path '${a.paths[k] as string}': ${String(veritePy(e["message"]) ? e["message"] : e["error"])}`,
          );
      }
      const paires = rels.map((r, k) => [r, entrees[k] as Dict] as const).slice(0, entrees.length);
      const plan: Dict[] = paires.map(([r, e]) =>
        e["kind"] === "missing"
          ? { path: toContainer(r), status: "not_found" }
          : {
              path: toContainer(r),
              type: genre(e),
              size: genre(e) === "file" ? (e["size"] ?? null) : null,
              status: a.dry_run ? "would_delete" : "pending",
            },
      );
      if (a.dry_run) return ok({ action: "batch_delete", dry_run: true, plan });
      const supprimes: string[] = [];
      const fc: Dict[] = [];
      for (const [r, e] of paires) {
        rel = r;
        if (e["kind"] === "missing") continue;
        if (genre(e) === "dir" && !a.recursive)
          return errFs("is_dir", `${toContainer(r)} is dir; pass recursive=True.`, {
            already_deleted: supprimes,
          });
        const instant = await enlever(r, e, true);
        if (instant === null) continue;
        await noterSuppressions(instant, fc);
        supprimes.push(toContainer(r));
      }
      return ok({
        action: "batch_delete",
        deleted: supprimes,
        count: supprimes.length,
        ...(fc.length ? { files_changed: resumerChangements(fc) } : {}),
      });
    }

    if (!a.path) return errFs("path_required");
    rel = relDe(esp.racine, a.path);
    const p = toContainer(rel);
    const gitRefus = act === "copy" ? null : await refusDansGitReel(esp, rel);
    if (gitRefus !== null) return gitRefus;
    if ((act === "delete" || act === "move") && !rel)
      return errFs("root_refused", "Act on an item INSIDE the sandbox, not on the sandbox root itself.");
    const e = await esp.stat(rel);

    if (act === "chmod") {
      if (e["kind"] === "missing") return errFs("not_found");
      if (e["kind"] !== "file" && e["kind"] !== "dir") return errFs("not_a_regular_file");
      const cur = intPy(e["mode"] || 0);
      const nouveau = (cur | 0o111) & 0o777;
      if (a.dry_run)
        return ok({
          path: p,
          action: "chmod",
          dry_run: true,
          current_mode: octPy(cur & 0o777),
          would_set: octPy(nouveau),
        });
      await esp.fsop("chmod", { path: rel, mode: nouveau });
      return ok({ path: p, action: "chmod", mode: octPy(nouveau) });
    }

    if (act === "mkdir") {
      if (e["kind"] !== "missing" && e["kind"] !== "dir")
        return errFs("exists_not_dir", `${p} already exists and is not a directory.`);
      const existait = e["kind"] === "dir";
      const jumeau = await esp.jumeauUnicode(rel);
      const avert: Dict = jumeau ? { warning: jumeau } : {};
      if (a.dry_run)
        return ok({ path: p, action: "mkdir", dry_run: true, would_create: !existait, ...avert });
      await esp.fsop("mkdir", { path: rel, parents: true });
      return ok({ path: p, action: "mkdir", created: !existait, ...avert });
    }

    if (act === "delete") {
      if (e["kind"] === "missing") return errFs("not_found");
      if (veritePy(e["link"])) {
        if (a.dry_run) return ok({ action: "delete", dry_run: true, path: p, type: "symlink" });
        await esp.fsop("remove", { path: rel });
        return ok({ action: "delete", symlink: true, path: p });
      }
      if (e["kind"] === "dir" && !a.recursive)
        return errFs("is_dir", "Pass recursive=True to delete directory.");
      if (a.dry_run) {
        const info: Dict = { path: p, type: genre(e) };
        if (e["kind"] === "dir") {
          const liste = await esp.lister(rel, { depth: PROFONDEUR, maxEntries: MAX_WALK, hidden: true });
          info["items_inside"] = liste.entries.length;
          if (liste.truncated) info["truncated"] = true;
        } else info["size"] = intPy(e["size"] || 0);
        return ok({ action: "delete", dry_run: true, ...info });
      }
      const fc: Dict[] = [];
      await noterSuppressions(await enlever(rel, e), fc);
      return ok({
        path: p,
        action: "delete",
        ...(fc.length ? { files_changed: resumerChangements(fc) } : {}),
      });
    }

    if (act === "copy" || act === "move") {
      if (!a.dest) return errFs("dest_required");
      const lien = act === "move" && veritePy(e["link"]);
      if (e["kind"] === "missing" || (!lien && e["kind"] === "link"))
        return veritePy(e["outside"])
          ? errFs(
              "path_outside_sandbox",
              "A symlink on this path leaves /work: copy a regular file or directory.",
              {
                path: p,
              },
            )
          : errFs("not_found", "Check the path with list_files.", { path: p });
      let drel = relDe(esp.racine, a.dest);
      const gitDest = await refusDansGitReel(esp, drel);
      if (gitDest !== null) return gitDest;
      const meme = (ed: Dict): boolean => {
        if (lien) return drel === rel;
        return (
          ed["kind"] !== "missing" &&
          Object.hasOwn(e, "ino") &&
          memeValeur(e["ino"], ed["ino"]) &&
          memeValeur(e["dev"], ed["dev"])
        );
      };
      let ed = await esp.stat(drel);
      if (
        !meme(ed) &&
        (ed["kind"] === "dir" || (rstripPy(a.dest).endsWith("/") && ed["kind"] === "missing"))
      ) {
        const nom = rel.slice(rel.lastIndexOf("/") + 1);
        drel = drel ? `${drel}/${nom}` : nom;
        const gitNom = await refusDansGitReel(esp, drel);
        if (gitNom !== null) return gitNom;
        ed = await esp.stat(drel);
      }
      const etiquette = toContainer(drel);
      if (meme(ed))
        return ok({
          src: p,
          dest: etiquette,
          action: act,
          noop: true,
          hint: "Source and destination are identical: nothing was done.",
        });
      const srcDossier = e["kind"] === "dir" && !lien;
      if (srcDossier && (!rel || drel.startsWith(`${rel}/`)))
        return errFs("dest_inside_source", "Cannot copy or move a directory into itself.");
      const ecrase = ed["kind"] !== "missing";
      if (ecrase) {
        if (!a.overwrite) return errFs("dest_exists", "Pass overwrite=True to replace.", { dest: etiquette });
        if (ed["kind"] === "dir" && !veritePy(ed["link"]))
          return errFs(
            "dest_is_directory",
            "Refusing to replace an existing directory: delete it first (manage_files delete, recursive=True) or choose another destination.",
            { dest: etiquette },
          );
        if (srcDossier)
          return errFs(
            "dest_is_file",
            "Refusing to replace an existing file with a directory: delete it first or choose another destination.",
            { dest: etiquette },
          );
      }
      const jumeau = await esp.jumeauUnicode(drel);
      const avert: Dict = jumeau ? { warning: jumeau } : {};
      if (a.dry_run) {
        if (lien) return ok({ action: "move", dry_run: true, symlink: true, dest: etiquette, ...avert });
        return ok({
          action: act,
          dry_run: true,
          src: p,
          dest: etiquette,
          overwrite_target: ecrase,
          ...avert,
        });
      }
      const fichier = e["kind"] === "file" && !lien;
      let avant: Instantane = [];
      let apres: Instantane = [];
      const operer = async (): Promise<Dict | null> => {
        try {
          if (act === "copy") {
            if (fichier && suivi) {
              avant = veritePy(ed["link"]) ? [] : await instantane(esp, drel, ed);
              apres = await instantane(esp, rel, e);
            }
            await esp.fsop("copy", { src: rel, dst: drel, overwrite: true, parents: true, follow: true });
          } else await esp.fsop("rename", { src: rel, dst: drel, overwrite: true, parents: true });
        } catch (x) {
          if (estErreurAgent(x) && x.code === "is_dir")
            return errFs("dest_is_directory", "Refusing to replace an existing directory.", {
              dest: etiquette,
            });
          if (estErreurAgent(x) && x.code === "exists")
            return errFs(
              srcDossier ? "dest_is_file" : "dest_exists",
              "The destination appeared meanwhile; retry.",
              {
                dest: etiquette,
              },
            );
          throw x;
        }
        return null;
      };
      const refus = fichier ? await avecVerrous(esp, [rel, drel], operer) : await operer();
      if (refus !== null) return refus;
      if (lien) return ok({ action: "move", symlink: true, dest: etiquette, ...avert });
      const fc: Dict[] = [];
      if (act === "copy" && fichier && suivi) {
        const b = avant.length ? (avant[0] as Instantane[number])[1] : null;
        const n = apres.length ? (apres[0] as Instantane[number])[1] : null;
        await noterEcriture(esp, drel, b, n);
        fc.push(entreeChangee(drel, b === null ? "created" : "modified", b, n));
      } else if (act === "copy" && srcDossier && suivi) {
        const dansGit = (q: string): boolean => q.split("/").some((x) => x.toLowerCase() === ".git");
        for (const [f, b] of await instantane(esp, drel, { kind: "dir" })) {
          await noterEcriture(esp, f, null, b);
          if (dansGit(f) || fc.filter((x) => !dansGit(String(x["path"]))).length < FC_MAX)
            fc.push(entreeChangee(f, "created", null, b));
        }
      } else if (act === "move") {
        await noterDeplacement(esp, rel, drel);
        fc.push({ path: etiquette, change: "moved", from: p });
      }
      return ok({
        src: p,
        dest: etiquette,
        action: act,
        ...avert,
        ...(fc.length ? { files_changed: resumerChangements(fc, "created") } : {}),
      });
    }

    return errFs("invalid_action", "Use: copy|move|delete|chmod|mkdir|batch_delete");
  } catch (e) {
    if (estErreurAgent(e)) return errAgent(e, rel);
    if (estValueError(e)) return errFs(e.message);
    return errFs(`unexpected: ${strErreur(e)}`);
  }
}
