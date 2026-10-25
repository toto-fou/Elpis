// SPDX-License-Identifier: MIT
/** apps/core/src/skills/outils.ts — corps des outils skill_save, skill_add_file, skill_get et skill_read_file (llm_core/tools/skill_tools.py, register_library) sur la bibliothèque de skills. */
import { open, stat } from "node:fs/promises";

import { messageErreurOs, stripPy } from "@elpis/commun";
import { config, safeSandboxName } from "@elpis/config";
import { asList, asStr } from "@elpis/outils-mcp";
import { fichierSousSkill, resoudreSkill as resoudreSkillVisible } from "@elpis/skills";

import { getCloseMatches } from "../graphiques/moteur/difflib";
import { longueurPy, prefixePy } from "../python";
import type { Dict } from "../python";

import {
  addUserSkillFile,
  ensureUserSkillsStore,
  MAX_BODY_LEN,
  MAX_DESC_LEN,
  MAX_NAME_LEN,
  saveUserSkill,
  SkillSaveError,
  syncUserSkillsMirror,
} from "./bibliotheque";
import type { SkillSpec } from "./bibliotheque";
import { pousserMiroirDuCompte } from "./miroir-distant";
import { estErreurOs, nomDe, parentDe, pyJoin, resoudre, stemDe } from "./chemins";

/** Octets rendus au modèle par `skill_read_file`. */
export const SKILL_FILE_READ_CAP = 256 * 1024;

const UTF8_REMPLACEMENT = new TextDecoder("utf-8", { ignoreBOM: true });

/** Ce que les quatre outils savent de l'appel : compte et notification `ctx.info`. */
export interface AppelSkill {
  readonly username: string;
  /** Login reçu avant mise au nom sûr (jeton client ou `_meta.username`), pour retrouver le compte. */
  readonly login?: string | null;
  readonly info: (message: string) => Promise<void>;
}

export interface ArgsSkillSave {
  name: string;
  description: string;
  body: string;
  tags: string[] | null;
  domain: string | null;
}

/** `ErrEnvelope(...)` dumpé : tous les champs du modèle, dans son ordre. */
export function enveloppe(
  error: string,
  message: string,
  o: { fix?: string; retryable?: boolean } = {},
): Dict {
  return {
    ok: false,
    error,
    message,
    fix: o.fix ?? null,
    next_action: null,
    retryable: o.retryable ?? null,
  };
}

/** `str(e)` : message d'une erreur du système de fichiers à la Python, texte de l'exception sinon. */
function texteExc(e: unknown, chemin = ""): string {
  if (e instanceof Error && estErreurOs(e)) {
    const p = (e as { path?: unknown }).path;
    return messageErreurOs(e, typeof p === "string" ? p : chemin);
  }
  return e instanceof Error ? e.message : String(e);
}

/** `<SANDBOX_DIR>/<compte sûr>` (APP_SANDBOX_DIR prime), racine du miroir `skills/`. */
export function racineSandboxDuCompte(username: string): string {
  return pyJoin(resoudre(process.env["APP_SANDBOX_DIR"] || config.SANDBOX_DIR), safeSandboxName(username));
}

/** Magasin perso protégé du compte (`APP_USER_SKILLS_DIR` prime), ancien emplacement migré ; la même racine que les routes. */
export async function magasinPerso(username: string): Promise<string> {
  const base = resoudre(process.env["APP_USER_SKILLS_DIR"] || config.USER_SKILLS_DIR);
  return ensureUserSkillsStore(pyJoin(base, safeSandboxName(username)), racineSandboxDuCompte(username));
}

export async function skillSave(args: ArgsSkillSave, a: AppelSkill): Promise<Dict> {
  const nom = prefixePy(asStr(args.name), MAX_NAME_LEN);
  const description = prefixePy(asStr(args.description), MAX_DESC_LEN);
  const corps = prefixePy(asStr(args.body), MAX_BODY_LEN);
  const tags = asList(args.tags)
    .map((t) => asStr(t))
    .filter((t) => t);
  const domaine = prefixePy(asStr(args.domain), MAX_NAME_LEN) || null;
  let magasin: string;
  let chemin: string;
  try {
    magasin = await magasinPerso(a.username);
    chemin = await saveUserSkill(magasin, nom, description, corps, tags, domaine);
  } catch (e) {
    if (e instanceof SkillSaveError)
      return enveloppe("skill_save_rejected", e.en, {
        fix: "Check name (non-empty) and body (non-empty procedure).",
      });
    return enveloppe("skill_save_failed", `write failed: ${texteExc(e)}`, { retryable: true });
  }
  await syncUserSkillsMirror(magasin, racineSandboxDuCompte(a.username));
  pousserMiroirDuCompte(a.username, magasin, a.login ?? null);
  await a.info(`skill_save: personal skill written to ${chemin}`);
  return {
    ok: true,
    name: nomDe(chemin) === "SKILL.md" ? nomDe(parentDe(chemin)) : stemDe(chemin),
    path: chemin,
    source: "user",
    domain: domaine ?? "",
    description,
    tags,
    note:
      "Personal skill saved (visible in your future sessions). " +
      "An admin can promote it to the curated shared library.",
  };
}

export async function skillAddFile(
  args: { name: string; path: string; content: string },
  a: AppelSkill,
): Promise<Dict> {
  let magasin: string;
  let cible: string;
  try {
    magasin = await magasinPerso(a.username);
    cible = await addUserSkillFile(magasin, asStr(args.name), asStr(args.path), asStr(args.content));
  } catch (e) {
    if (e instanceof SkillSaveError)
      return enveloppe("skill_add_file_rejected", e.en, {
        fix:
          "Check name (existing personal skill, created via skill_save) " +
          "and path (relative, e.g. scripts/run.sh).",
      });
    return enveloppe("skill_add_file_failed", `write failed: ${texteExc(e)}`, { retryable: true });
  }
  await syncUserSkillsMirror(magasin, racineSandboxDuCompte(a.username));
  pousserMiroirDuCompte(a.username, magasin, a.login ?? null);
  const relatif = stripPy(asStr(args.path).replaceAll("\\", "/")).replace(/^\/+/u, "");
  await a.info(`skill_add_file: ${relatif} written to user store`);
  const nom = asStr(args.name);
  return {
    ok: true,
    name: nom,
    path: cible,
    source: "user",
    domain: "",
    description: "",
    tags: [],
    note:
      `File bundled into skill '${nom}' (protected store, outside /work). ` +
      `At usage time: \`skill_read_file('${nom}', '${relatif}')\` to read it, ` +
      "`skill_run_script(...)` to execute it if it is a script.",
  };
}

/** Skill visible de l'appelant (perso > global ; learned exclu) : id qualifié, puis nom exact, puis slug. */
async function resoudreSkill(username: string, nom: string): Promise<[SkillSpec | null, SkillSpec[]]> {
  return resoudreSkillVisible(await magasinPerso(username), nom);
}

/** `fix` d'un nom inconnu : les 3 noms visibles les plus proches, sinon la consigne d'origine. */
function fixNomInconnu(nom: string, skills: readonly SkillSpec[]): string {
  const proches = getCloseMatches(nom, [...new Set(skills.map((s) => s.name))], 3, 0.4);
  return proches.length > 0
    ? `Closest names: ${proches.join(", ")}. Use a name present in the skills index.`
    : "Use a name present in the skills index.";
}

export async function skillGet(args: { name: string }, a: AppelSkill): Promise<Dict> {
  let trouve: [SkillSpec | null, SkillSpec[]];
  try {
    trouve = await resoudreSkill(a.username, args.name);
  } catch (e) {
    return enveloppe("skill_get_failed", `read failed: ${texteExc(e)}`, { retryable: true });
  }
  const [spec, skills] = trouve;
  if (spec === null)
    return enveloppe("skill_not_found", `no skill named '${asStr(args.name)}'.`, {
      fix: fixNomInconnu(asStr(args.name), skills),
    });
  let note: string | null = null;
  if (spec.isFolder && spec.files.length > 0)
    note =
      "This skill bundles files (field `files`). Read one with " +
      `\`skill_read_file('${spec.name}', '<path>')\` and run a ` +
      `script with \`skill_run_script('${spec.name}', 'scripts/<x>.py')\`` +
      " — the files are NOT in /work, do not try read_file/" +
      "execute_shell on them.";
  const id = spec.id || spec.name;
  const enfants = skills.filter((s) => s.parentId === id);
  if (enfants.length > 0) {
    const noms = enfants.map((c) => `\`${c.id || c.name}\``).join(", ");
    const sous = `Sub-skills (load them via skill_get): ${noms}.`;
    note = note !== null ? `${note}\n${sous}` : sous;
  }
  await a.info(
    `skill_get: loaded '${spec.name}' (${longueurPy(spec.body)} chars, ${spec.isFolder ? "folder" : "file"})`,
  );
  return {
    ok: true,
    name: spec.name,
    body: spec.body,
    description: spec.description || "",
    domain: spec.domain || "",
    tags: [...spec.tags],
    source: spec.source,
    is_folder: spec.isFolder,
    files: spec.files.length > 0 ? [...spec.files] : null,
    sandbox_path: null,
    note,
  };
}

/** `Path.is_file()` de Python 3.13 : seuls ENOENT, ENOTDIR, EBADF et ELOOP donnent faux, toute autre erreur système sort comme `OSError`. */
async function estFichierPy(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EBADF" || code === "ELOOP") return false;
    if (estErreurOs(e)) throw new Error(messageErreurOs(e, p), { cause: e });
    throw e;
  }
}

/** Taille réelle puis au plus `SKILL_FILE_READ_CAP` octets, décodés en UTF-8 avec remplacement. */
async function lirePlafonne(cible: string): Promise<{ taille: number; contenu: string }> {
  const taille = (await stat(cible)).size;
  const fh = await open(cible, "r");
  try {
    const tampon = Buffer.alloc(SKILL_FILE_READ_CAP);
    let lus = 0;
    while (lus < SKILL_FILE_READ_CAP) {
      const { bytesRead } = await fh.read(tampon, lus, SKILL_FILE_READ_CAP - lus, null);
      if (bytesRead === 0) break;
      lus += bytesRead;
    }
    return { taille, contenu: UTF8_REMPLACEMENT.decode(tampon.subarray(0, lus)) };
  } finally {
    await fh.close();
  }
}

export async function skillReadFile(args: { name: string; path: string }, a: AppelSkill): Promise<Dict> {
  let spec: SkillSpec | null;
  let visibles: SkillSpec[];
  try {
    [spec, visibles] = await resoudreSkill(a.username, args.name);
  } catch (e) {
    return enveloppe("skill_read_failed", `read failed: ${texteExc(e)}`, { retryable: true });
  }
  if (spec === null)
    return enveloppe("skill_not_found", `no skill named '${asStr(args.name)}'.`, {
      fix: fixNomInconnu(asStr(args.name), visibles),
    });
  if (!spec.skillDir)
    return enveloppe("skill_no_files", "this skill bundles no files.", {
      fix: "skill_get(name) already returns its body (SKILL.md).",
    });
  const sous = fichierSousSkill(spec.skillDir, args.path);
  if ("erreur" in sous)
    return enveloppe("skill_read_rejected", sous.erreur, {
      fix: "path relative to the skill folder (e.g. 'scripts/run.py'), taken from the `files` list of skill_get.",
    });
  if ("tropLong" in sous) throw new Error(messageErreurOs({ code: "ENAMETOOLONG" }, sous.tropLong));
  if (!(await estFichierPy(sous.chemin)))
    return enveloppe("skill_file_not_found", `file not found: ${asStr(args.path)}`, {
      fix: "Use a path listed in `files` (skill_get).",
    });
  let lu: { taille: number; contenu: string };
  try {
    lu = await lirePlafonne(sous.chemin);
  } catch (e) {
    if (!estErreurOs(e)) throw e;
    return enveloppe("skill_read_failed", `read failed: ${texteExc(e, sous.chemin)}`, { retryable: true });
  }
  await a.info(`skill_read_file: ${spec.name}/${asStr(args.path)} (${lu.taille} bytes)`);
  return {
    ok: true,
    name: spec.name,
    path: asStr(args.path),
    content: lu.contenu,
    size: lu.taille,
    truncated: lu.taille > SKILL_FILE_READ_CAP,
  };
}
