// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/skill-run/outil.ts — famille `skill_run` servie par l'hôte (llm_core/tools/skill_tools.py `register_run`) : script d'un skill du compte exécuté dans SON conteneur par le pont d'exécution du shell, définition figée par le golden. */
import { racineTravail } from "@elpis/bac";
import type { PortProfilRappel } from "@elpis/bac";
import {
  clesOrdonnees,
  estDict,
  estDossierPy,
  estFichierPy,
  existePy,
  intPy,
  lowerPy,
  messageErreurOs,
  messageErreurPy,
  prefixePy,
  reprPy,
  stripPy,
  veritePy,
} from "@elpis/commun";
import type { Dict, Journal } from "@elpis/commun";
import { config, realpathPy, safeSandboxName } from "@elpis/config";
import { py } from "@elpis/http";
import { asList, asStr, getUsername, outilDuGolden, readMetaField } from "@elpis/outils-mcp";
import type { ContexteAppel, DefinitionOutil, Golden } from "@elpis/outils-mcp";
import goldenSkillRun from "@elpis/outils-mcp/goldens/skill_run.json" with { type: "json" };
import { fichierSousSkill, pyJoin, resoudre, resoudreSkill, suffixeDe } from "@elpis/skills";
import type { SkillSpec } from "@elpis/skills";
import { userIdFor } from "@elpis/securite";

import { uidFor, WorkChanges } from "../changements";
import { brancherRappelProfil } from "../espace";
import { enveloppeAnnulee, PontExec, strErreur } from "../shell/pont";
import type { OptionsShell } from "../shell/pont";
import type { ReleveCommande } from "../shell/outil";
import { archiverDossier, ErreurArchive, tailleDossier } from "./archive";

export const SKILL_RUN_MAX_BYTES = 8 * 1024 * 1024;
export const SKILL_RUN_MAX_OUTPUT = 64 * 1024;
export const SKILL_RUN_DEFAULT_TIMEOUT = 60;
export const SKILL_RUN_MAX_TIMEOUT = 300;
export const SKILL_RUN_MAX_ENV = 16;
export const SKILL_ENV_VAL_CAP = 4096;
/** Interprètes présents dans l'image du bac (pas de ruby). */
export const SKILL_INTERP: Readonly<Record<string, string>> = {
  ".py": "python3",
  ".sh": "bash",
  ".bash": "bash",
  ".js": "node",
  ".mjs": "node",
  ".pl": "perl",
};
const SKILL_ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SKILL_ENV_DENYLIST: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "IFS",
  "ENV",
  "BASH_ENV",
  "SHELL",
  "SKILL_DIR",
]);
/** `$1` = interprète, `$2` = script relatif ; archive du skill sur l'entrée standard, extraite hors de /work, script lancé depuis /work, dossier retiré même après `timeout`. */
export const RUNNER =
  'i="$1"; r="$2"; shift 2; ' +
  "d=$(mktemp -d /tmp/.skill-run.XXXXXX) || exit 96; " +
  "trap 'cd /; rm -rf \"$d\"' EXIT; " +
  'tar -xf - -C "$d" || exit 95; ' +
  "cd /work || exit 94; " +
  'SKILL_DIR="$d" "$i" "$d/$r" "$@" </dev/null; rc=$?; ' +
  'cd /; rm -rf "$d"; trap - EXIT; exit $rc';

/** Arguments validés de `skill_run_script` (signature du golden). */
export interface ArgsSkillRun {
  readonly name: string;
  readonly script: string;
  readonly args: unknown[] | null;
  readonly env: Dict | null;
  readonly timeout_sec: number | null;
}

/** Points d'appui de l'outil (doublés par les tests comme les `monkeypatch` du Python). */
export interface AppuisSkillRun {
  /** Dossier des skills perso du compte : magasin protégé, sinon miroir poussé par main. */
  dossierPerso(username: string): string;
  racine(username: string): Promise<string>;
  userIdFor(username: string): Promise<number>;
  uidFor(username: string): Promise<number | null>;
  releve(uid: number | null, username: string, racine: string): ReleveCommande;
  executer(o: OptionsShell): Promise<Dict>;
}

/** `ErrEnvelope(...)` dumpé : tous les champs du modèle, dans son ordre. */
function enveloppe(error: string, message: string, o: { fix?: string; retryable?: boolean } = {}): Dict {
  return { ok: false, error, message, fix: o.fix ?? null, next_action: null, retryable: o.retryable ?? null };
}

/** Une erreur d'OS sort comme l'`OSError` que Python laisse remonter de l'outil. */
function osVersPython(e: unknown, chemin: string): unknown {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^E[A-Z0-9]+$/u.test(code) ? new Error(messageErreurPy(e, chemin)) : e;
}

function estDossier(p: string): boolean {
  try {
    return estDossierPy(p);
  } catch (e) {
    throw osVersPython(e, p);
  }
}

function estFichier(p: string): boolean {
  try {
    return estFichierPy(p);
  } catch (e) {
    throw osVersPython(e, p);
  }
}

/** `_user_skills_dir` côté hôte : le magasin protégé s'il existe (hôte local, comme le Python), sinon le miroir `<compte>/skills` que main pousse, lu sur place (écart : le Python le déplaçait dans un magasin propre à l'hôte, figé ensuite). */
export function dossierPersoDuCompte(username: string): string {
  const nom = safeSandboxName(username);
  const magasin = pyJoin(resoudre(process.env["APP_USER_SKILLS_DIR"] || config.USER_SKILLS_DIR), nom);
  try {
    if (existePy(magasin)) return magasin;
    const miroir = pyJoin(realpathPy(pyJoin(config.SANDBOX_DIR, nom)), "skills");
    return estDossierPy(miroir) ? miroir : magasin;
  } catch {
    return magasin;
  }
}

/** Environnement du script : `null` et l'enveloppe de refus, ou les variables retenues (valeurs coupées à 4 096 caractères). */
function environnement(env: Dict | null): [Dict | null, Record<string, string>] {
  const retenu = Object.create(null) as Record<string, string>;
  if (!estDict(env)) return [null, retenu];
  const cles = clesOrdonnees(env);
  if (cles.length > SKILL_RUN_MAX_ENV)
    return [
      enveloppe("skill_run_rejected", `too many env vars (${cles.length} > ${SKILL_RUN_MAX_ENV}).`, {
        fix: "Pass only the knobs documented by the skill.",
      }),
      retenu,
    ];
  for (const k of cles) {
    const cle = asStr(k);
    if (!SKILL_ENV_KEY_RE.test(cle) || SKILL_ENV_DENYLIST.has(cle) || cle.startsWith("LD_"))
      return [
        enveloppe("skill_run_rejected", `env var rejected: ${reprPy(cle)}`, {
          fix: "UPPER_SNAKE_CASE only; PATH/HOME/IFS/ENV/BASH_ENV/SHELL/LD_* cannot be overridden.",
        }),
        retenu,
      ];
    retenu[cle] = prefixePy(asStr(env[k]), SKILL_ENV_VAL_CAP);
  }
  return [null, retenu];
}

/** Skill demandé et script du skill, vérifiés sur l'hôte : `[spec, relatif, interprète]` ou l'enveloppe de refus. */
async function scriptDuSkill(
  args: ArgsSkillRun,
  username: string,
  a: AppuisSkillRun,
): Promise<Dict | [SkillSpec, string, string]> {
  let spec: SkillSpec | null;
  try {
    [spec] = await resoudreSkill(a.dossierPerso(username), args.name);
  } catch (e) {
    return enveloppe("skill_run_failed", `resolution failed: ${strErreur(e)}`, { retryable: true });
  }
  if (spec === null)
    return enveloppe("skill_not_found", `no skill named '${asStr(args.name)}'.`, {
      fix: "Use a name present in the skills index.",
    });
  if (!spec.skillDir || !estDossier(spec.skillDir))
    return enveloppe("skill_no_files", "this skill bundles no executable scripts.", {
      fix: "skill_get(name) renvoie le corps (SKILL.md) du skill.",
    });
  const rel = stripPy(asStr(args.script)).replace(/^\/+/u, "");
  const sous = fichierSousSkill(spec.skillDir, rel);
  if ("erreur" in sous)
    return enveloppe("skill_run_rejected", sous.erreur, {
      fix: "script relatif au dossier du skill, ex. 'scripts/run.py'.",
    });
  if ("tropLong" in sous) throw new Error(messageErreurOs({ code: "ENAMETOOLONG" }, sous.tropLong));
  if (!estFichier(sous.chemin))
    return enveloppe("skill_script_not_found", `script not found: ${rel}`, {
      fix: "Use a path from `files` (skill_get) ending in .py/.sh/.js…",
    });
  const suffixe = suffixeDe(sous.chemin);
  const interp = SKILL_INTERP[lowerPy(suffixe)];
  if (interp === undefined)
    return enveloppe("skill_run_unsupported", `unsupported script type: ${suffixe || "(no extension)"}`, {
      fix: "Supported extensions: .py .sh .bash .js .pl.",
    });
  return [spec, rel, interp];
}

/** Dossier entier du skill en archive pour le conteneur, ou l'enveloppe d'échec (trop gros, erreur d'OS). */
async function archiveDuSkill(dossier: string): Promise<Dict | Buffer> {
  let total: number;
  let archive: Buffer;
  try {
    total = await tailleDossier(dossier);
    if (total > SKILL_RUN_MAX_BYTES)
      return enveloppe(
        "skill_run_too_large",
        `dossier du skill trop volumineux (${total} octets) pour le staging.`,
        { fix: `Shrink the bundled files (limit ~${SKILL_RUN_MAX_BYTES} bytes).` },
      );
    archive = await archiverDossier(dossier);
  } catch (e) {
    const texte = e instanceof ErreurArchive ? e.message : strErreur(e);
    return enveloppe("skill_run_failed", `staging failed: ${texte}`, { retryable: true });
  }
  return archive;
}

/** Note lisible d'un code de sortie du runner. */
function noteDuCode(rc: number, delai: number): string | null {
  if (rc === 124) return `Script interrompu (timeout ${delai}s).`;
  if (rc === 95 || rc === 96) return "Skill staging into the container failed (retry).";
  if (rc === 94) return "/work unavailable in the container (sandbox to recreate?).";
  return null;
}

/** `skill_run_script` : dossier du skill (magasin ou miroir du compte, ou bibliothèque globale) archivé, extrait hors de /work dans le conteneur du compte, script lancé depuis /work par son interprète. */
export async function skillRunScript(
  args: ArgsSkillRun,
  ctx: ContexteAppel,
  a: AppuisSkillRun,
): Promise<Dict> {
  const username = getUsername(ctx);
  const trouve = await scriptDuSkill(args, username, a);
  if (!Array.isArray(trouve)) return trouve;
  const [spec, rel, interp] = trouve;
  const archive = await archiveDuSkill(spec.skillDir ?? "");
  if (!Buffer.isBuffer(archive)) return archive;
  const argList = Array.isArray(args.args) ? asList(args.args).map((x) => asStr(x)) : [];
  const [refus, env] = environnement(args.env);
  if (refus !== null) return refus;
  const delai = Math.max(
    1,
    Math.min(args.timeout_sec ? intPy(args.timeout_sec) : SKILL_RUN_DEFAULT_TIMEOUT, SKILL_RUN_MAX_TIMEOUT),
  );
  const tokens = ["bash", "-c", RUNNER, "skill_run", interp, rel, ...argList];
  const racine = await a.racine(username);
  const live = readMetaField(ctx, "live_shell") === "1";
  const wc = a.releve(await a.uidFor(username), username, racine);
  await wc.debut();
  let res: Dict;
  try {
    res = await a.executer({
      tokens,
      sandboxRoot: racine,
      envExtra: env,
      timeoutS: delai,
      maxOutput: SKILL_RUN_MAX_OUTPUT,
      stdin: archive,
      userId: await a.userIdFor(username),
      username,
      auditKind: "tools.skill_run",
      ctx,
      streamLive: live,
      signal: ctx.signal,
    });
  } catch (e) {
    if (ctx.signal?.aborted) return enveloppeAnnulee("skill_run_script");
    return enveloppe("skill_run_failed", `execution failed: ${strErreur(e)}`, { retryable: true });
  } finally {
    await wc.fin();
  }
  const rc = Object.hasOwn(res, "returncode") ? intPy(res["returncode"]) : -1;
  await ctx.info(`skill_run_script: ${spec.name}/${rel} rc=${rc}`);
  return wc.attacher({
    ok: rc === 0,
    name: spec.name,
    script: rel,
    returncode: rc,
    stdout: asStr(Object.hasOwn(res, "stdout") ? res["stdout"] : ""),
    stderr: asStr(Object.hasOwn(res, "stderr") ? res["stderr"] : ""),
    truncated: veritePy(Object.hasOwn(res, "truncated") ? res["truncated"] : false),
    note: noteDuCode(rc, delai),
  });
}

/** Points d'appui réels : magasin ou miroir du compte, `/work` du bac, identité de l'enveloppe, relevé par l'agent, pont d'exécution du shell. */
export function appuisParDefaut(pont: PontExec): AppuisSkillRun {
  return {
    dossierPerso: dossierPersoDuCompte,
    racine: racineTravail,
    userIdFor,
    uidFor,
    releve: (uid, username) => {
      const wc = new WorkChanges(uid, username, "shell");
      return {
        debut: async () => void (await wc.entrer()),
        fin: () => wc.sortir(),
        attacher: (r) => wc.attach(r),
      };
    },
    executer: (o) => pont.runShell(o),
  };
}

const SIGNATURE: DefinitionOutil["signature"] = {
  name: py.str(),
  script: py.str(),
  args: py.optional(py.list(py.any())).defaut(null),
  env: py.optional(py.dict(py.any(), py.any())).defaut(null),
  timeout_sec: py.optional(py.int()).defaut(null),
};

/** `args` et `env` sous leur forme reçue (`1.0`, entier long) : pydantic les rend tels quels (`list`, `dict` sans type d'élément). */
function formeRecue(valeurs: Dict, brut: Dict): ArgsSkillRun {
  const args = Array.isArray(brut["args"]) ? brut["args"] : valeurs["args"];
  const env = estDict(brut["env"]) ? brut["env"] : valeurs["env"];
  return { ...valeurs, args, env } as unknown as ArgsSkillRun;
}

/** Outil de la famille `skill_run` sur ses points d'appui. */
export function outilsSkillRun(a: AppuisSkillRun): DefinitionOutil[] {
  return [
    outilDuGolden(goldenSkillRun as Golden, "skill_run_script", {
      signature: SIGNATURE,
      traiter: (valeurs, ctx, brut) => skillRunScript(formeRecue(valeurs, brut), ctx, a),
    }),
  ];
}

/** Famille `skill_run` de l'hôte (forme `FabriqueNative`) : même pont et même bac que le shell (profil effectif par rappel au core). */
export function familleSkillRun(o: {
  readonly rappel?: PortProfilRappel | null;
  readonly journal?: Pick<Journal, "info" | "warn"> | null;
}): { famille: string; outils: readonly DefinitionOutil[] } {
  if (o.rappel) brancherRappelProfil(o.rappel);
  const pont = new PontExec({ rappel: o.rappel ?? null, journal: o.journal ?? null });
  return { famille: "skill_run", outils: outilsSkillRun(appuisParDefaut(pont)) };
}
