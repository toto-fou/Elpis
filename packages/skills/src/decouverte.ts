// SPDX-License-Identifier: MIT
/** packages/skills/src/decouverte.ts — découverte des skills partagée par le core et l'hôte d'outils (llm_core/skills.py) : racines, verrou des écritures, chargement des dossiers et des `.md`, scan mis en cache, fusion par id, slug. */
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { comparePointsDeCode, ErreurPython, lowerPy, reprPy, sansAccentsPy, stripPy } from "@elpis/commun";
import { racineDepot } from "@elpis/config";
import { journal } from "@elpis/http";

import {
  ancetres,
  estDossier,
  estErreurOs,
  estFichier,
  estSous,
  nomDe,
  parentDe,
  partiesRelatives,
  pyJoin,
  pyPath,
  resoudre,
  rglob,
  rglobTrie,
  stemDe,
  suffixeDe,
} from "./chemins";
import { splitFrontmatter, strFrontmatter, veriteFrontmatter } from "./frontmatter";
import type { Frontmatter } from "./frontmatter";
import { validateFrontmatter } from "./validation";
import { cheminVerrouSkills, VerrouEcritureSkills } from "./verrou";

const log = (): ReturnType<typeof journal> => journal("skills");
const texteErreur = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const DECODEUR = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** `Path.read_text(encoding="utf-8")` : UTF-8 strict, fins de ligne ramenées à `\n`. */
async function lireTexte(chemin: string): Promise<string> {
  return DECODEUR.decode(await readFile(chemin)).replace(/\r\n?/g, "\n");
}

/** `s.strip(jeu)` sur un jeu de caractères. */
function stripJeu(s: string, jeu: string): string {
  let debut = 0;
  let fin = s.length;
  while (debut < fin && jeu.includes(s.charAt(debut))) debut++;
  while (fin > debut && jeu.includes(s.charAt(fin - 1))) fin--;
  return s.slice(debut, fin);
}

/** `a or b` sur une valeur de frontmatter. */
function ou(a: unknown, b: unknown): unknown {
  return veriteFrontmatter(a) ? a : b;
}

/** `str(x or "").strip()`. */
function texteFm(v: unknown): string {
  return stripPy(strFrontmatter(ou(v, "")));
}

// ── Racines ───────────────────────────────────────────────────────────────

/** `_global_skills_root()` : `APP_SKILLS_DIR`, sinon `<dépôt>/skills` s'il existe, sinon `skills` (cwd). */
export function racineSkillsGlobale(): string {
  const surcharge = stripPy(process.env["APP_SKILLS_DIR"] ?? "");
  if (surcharge) return pyPath(surcharge);
  const candidat = pyJoin(racineDepot(), "skills");
  try {
    if (statSync(candidat).isDirectory()) return candidat;
  } catch {
    /* absent : repli relatif */
  }
  return "skills";
}

/** SAS de curation admin : brouillons non injectés avant promotion. */
export function racineSkillsApprises(): string {
  return pyJoin(racineSkillsGlobale(), "learned");
}

/** Verrou des mutations (`_write_lock`) : les routes le tiennent autour de « contrôle + écriture ». */
export const verrouEcriture = new VerrouEcritureSkills(() => cheminVerrouSkills(racineSkillsGlobale));

/** `with _write_lock:` ; réentrant (les écrivains le reprennent). */
export function avecVerrouEcriture<T>(f: () => Promise<T>): Promise<T> {
  return verrouEcriture.avec(f);
}

// ── Modèle ───────────────────────────────────────────────────────────────

/** Une procédure chargée d'un `.md` (legacy) ou d'un dossier `<nom>/SKILL.md` (Agent Skill). */
export class SkillSpec {
  name: string;
  description = "";
  body = "";
  tags: string[] = [];
  /** `global`, `learned` ou `user`. */
  source = "global";
  domain = "";
  path: string | null = null;
  skillDir: string | null = null;
  files: string[] = [];
  license = "";
  compatibility = "";
  metadata: Frontmatter = new Map();
  allowedTools = "";
  /** Chaîne de noms depuis la racine (`pkg/child`), `name` au niveau 0. */
  id = "";
  parentId: string | null = null;
  depth = 0;

  constructor(champs: Partial<SkillSpec> & { name: string }) {
    this.name = champs.name;
    Object.assign(this, champs);
  }

  get isFolder(): boolean {
    return this.skillDir !== null;
  }
}

// ── Chargement ───────────────────────────────────────────────────────────

/** `_is_skill_file` : `.md` hors README, _TEMPLATE, `_…` et cachés. */
function estFichierSkill(p: string): boolean {
  if (lowerPy(suffixeDe(p)) !== ".md") return false;
  const nom = stemDe(p);
  if (lowerPy(nom) === "readme" || lowerPy(nom) === "_template") return false;
  return !nom.startsWith("_") && !nom.startsWith(".");
}

/** Domaine = premier sous-dossier sous `racine` ; `""` à la racine. */
function domaineDuChemin(p: string, racine: string): string {
  const rel = partiesRelatives(p, racine);
  return rel !== null && rel.length > 1 ? (rel[0] ?? "") : "";
}

/** `_parse_tags` : liste ou CSV en liste de textes non vides. */
export function parseTags(brut: unknown): string[] {
  if (typeof brut === "string")
    return brut
      .split(",")
      .map(stripPy)
      .filter((t) => t);
  if (Array.isArray(brut)) return brut.map((t) => stripPy(strFrontmatter(t))).filter((t) => t);
  return [];
}

async function chargerFichier(p: string, source: string, domaine = ""): Promise<SkillSpec | null> {
  let contenu: string;
  try {
    contenu = await lireTexte(p);
  } catch (e) {
    log().debug(`read échoué pour ${p} : ${texteErreur(e)}`);
    return null;
  }
  const [fm, brut] = splitFrontmatter(contenu);
  const body = stripPy(brut);
  if (!body) {
    log().debug(`corps vide pour ${nomDe(p)}`);
    return null;
  }
  const name = stripPy(strFrontmatter(ou(fm.get("name"), stemDe(p))));
  if (!name) return null;
  return new SkillSpec({
    name,
    description: texteFm(fm.get("description")),
    body,
    tags: parseTags(fm.get("tags")),
    source,
    domain: stripPy(strFrontmatter(ou(fm.get("domain"), ou(domaine, "")))),
    path: p,
  });
}

/** `_load_spec_from_dir` : `name` = nom du dossier ; fichiers groupés sans ceux des sous-skills. */
async function chargerDossier(d: string, source: string, domaine = ""): Promise<SkillSpec | null> {
  const skillmd = pyJoin(d, "SKILL.md");
  let contenu: string;
  try {
    contenu = await lireTexte(skillmd);
  } catch (e) {
    log().debug(`read échoué pour ${skillmd} : ${texteErreur(e)}`);
    return null;
  }
  const [fm, brut] = splitFrontmatter(contenu);
  const name = stripPy(nomDe(d));
  if (!name) return null;
  const md = fm.get("metadata");
  const files: string[] = [];
  try {
    const dReel = resoudre(d);
    const enfants = (await rglob(d, (n) => n === "SKILL.md"))
      .map(parentDe)
      .filter((p) => resoudre(p) !== dReel);
    for (const f of await rglobTrie(d, () => true)) {
      if (!(await estFichier(f)) || nomDe(f) === "SKILL.md") continue;
      const rel = partiesRelatives(f, d) ?? [];
      if (rel.some((x) => x.startsWith("."))) continue;
      if (enfants.some((c) => estSous(f, c))) continue;
      files.push(rel.join("/"));
    }
  } catch (e) {
    if (!estErreurOs(e)) throw e;
  }
  try {
    const errs = validateFrontmatter(new Map([...fm, ["name", name]]), { dirName: name });
    if (errs.length > 0) log().warn(`${skillmd} non conforme (gardé) : ${errs.join("; ")}`);
  } catch (e) {
    log().debug(`validation de ${skillmd} impossible : ${texteErreur(e)}`);
  }
  return new SkillSpec({
    name,
    description: texteFm(fm.get("description")),
    body: stripPy(brut),
    tags: parseTags(fm.get("tags")),
    source,
    domain: stripPy(strFrontmatter(ou(fm.get("domain"), ou(domaine, "")))),
    path: skillmd,
    skillDir: d,
    files,
    license: texteFm(fm.get("license")),
    compatibility: texteFm(fm.get("compatibility")),
    metadata: md instanceof Map ? new Map(md) : new Map(),
    allowedTools: stripPy(strFrontmatter(ou(fm.get("allowed-tools"), ou(fm.get("allowed_tools"), "")))),
  });
}

/** TTL du cache de scan : ne couvre que les mutations d'autres processus (les écrivains l'invalident). */
export const SCAN_CACHE_TTL_S = 15.0;
const cacheScan = new Map<string, { t: number; specs: SkillSpec[] }>();

/** À appeler après toute mutation d'un magasin (les écrivains du module le font). */
export function invalidateSkillsScanCache(): void {
  cacheScan.clear();
}

/** Sous le verrou d'écriture, le disque (que d'autres processus ont pu changer) ; sinon le cache. */
export async function scanTree(
  racine: string,
  source: string,
  exclusions: readonly string[] = [],
): Promise<SkillSpec[]> {
  if (verrouEcriture.tenuIci()) return scanTreeSansCache(pyPath(racine), source, exclusions);
  const cle = JSON.stringify([pyPath(racine), source, exclusions]);
  const maintenant = performance.now() / 1000;
  const touche = cacheScan.get(cle);
  if (touche !== undefined && maintenant - touche.t < SCAN_CACHE_TTL_S) return [...touche.specs];
  const specs = await scanTreeSansCache(pyPath(racine), source, exclusions);
  if (cacheScan.size > 32)
    for (const [k, v] of cacheScan) if (maintenant - v.t >= SCAN_CACHE_TTL_S) cacheScan.delete(k);
  cacheScan.set(cle, { t: maintenant, specs });
  return [...specs];
}

/** Scan récursif, sans échec global : dossiers-skills, puis `.md` legacy hors dossiers, puis hiérarchie. */
async function scanTreeSansCache(
  racine: string,
  source: string,
  exclusions: readonly string[],
): Promise<SkillSpec[]> {
  if (!(await estDossier(racine))) return [];
  const racineReelle = resoudre(racine);
  const specs: SkillSpec[] = [];
  const dossiersSkills = new Set<string>();
  for (const skillmd of await rglobTrie(racine, (n) => n === "SKILL.md")) {
    const d = parentDe(skillmd);
    if (resoudre(d) === racineReelle) continue;
    const rel = partiesRelatives(d, racine) ?? [];
    if (rel.length > 0 && exclusions.includes(rel[0] ?? "")) continue;
    if (rel.some((x) => x.startsWith(".") || x.startsWith("_"))) continue;
    try {
      const spec = await chargerDossier(d, source, domaineDuChemin(d, racine));
      if (spec !== null) {
        specs.push(spec);
        dossiersSkills.add(resoudre(d));
      }
    } catch (e) {
      log().warn(`parse error (dir) ${d}: ${texteErreur(e)}`);
    }
  }
  for (const entree of await rglobTrie(racine, (n) => n.endsWith(".md"))) {
    if (nomDe(entree) === "SKILL.md") continue;
    const rel = partiesRelatives(entree, racine) ?? [];
    if (rel.length > 0 && exclusions.includes(rel[0] ?? "")) continue;
    if (dossiersSkills.size > 0 && ancetres(resoudre(entree)).some((a) => dossiersSkills.has(a))) continue;
    if (!estFichierSkill(entree)) continue;
    try {
      const spec = await chargerFichier(entree, source, domaineDuChemin(entree, racine));
      if (spec !== null) specs.push(spec);
    } catch (e) {
      log().warn(`parse error ${nomDe(entree)}: ${texteErreur(e)}`);
    }
  }
  const parDossier = new Map<string, SkillSpec>();
  for (const s of specs) if (s.skillDir !== null) parDossier.set(resoudre(s.skillDir), s);
  const assigner = (sp: SkillSpec): void => {
    if (sp.id) return;
    const parent = ancetres(resoudre(sp.skillDir ?? "")).find((a) => parDossier.has(a));
    const psp = parent === undefined ? undefined : parDossier.get(parent);
    if (psp === undefined) {
      [sp.parentId, sp.id, sp.depth] = [null, sp.name, 0];
      return;
    }
    assigner(psp);
    [sp.parentId, sp.id, sp.depth] = [psp.id, `${psp.id}/${sp.name}`, psp.depth + 1];
    if (sp.depth > 2) log().warn(`sous-skill au-delà de 3 niveaux (depth=${sp.depth}): ${sp.id}`);
  };
  for (const sp of specs) if (sp.skillDir !== null) assigner(sp);
  for (const sp of specs) if (!sp.id) [sp.parentId, sp.id, sp.depth] = [null, sp.name, 0];
  return specs;
}

/** Tous les skills, fusionnés par id (user > learned > global), triés par (domaine, id). */
export async function discoverSkills(
  userSkillsDir: string | null = null,
  options: { includeLearned?: boolean } = {},
): Promise<SkillSpec[]> {
  const parId = new Map<string, SkillSpec>();
  for (const s of await scanTree(racineSkillsGlobale(), "global", ["learned"])) parId.set(s.id, s);
  if (options.includeLearned ?? true)
    for (const s of await scanTree(racineSkillsApprises(), "learned")) parId.set(s.id, s);
  if (userSkillsDir !== null) for (const s of await scanTree(userSkillsDir, "user")) parId.set(s.id, s);
  return [...parId.values()].sort(
    (a, b) => comparePointsDeCode(a.domain, b.domain) || comparePointsDeCode(a.id, b.id),
  );
}

/** Inventaire réel d'UNE source, sans fusion, trié par (domaine, nom). */
export async function discoverSkillsBySource(
  source: string,
  userSkillsDir: string | null = null,
): Promise<SkillSpec[]> {
  let specs: SkillSpec[];
  if (source === "global") specs = await scanTree(racineSkillsGlobale(), "global", ["learned"]);
  else if (source === "learned") specs = await scanTree(racineSkillsApprises(), "learned");
  else if (source === "user") specs = userSkillsDir !== null ? await scanTree(userSkillsDir, "user") : [];
  else throw new ErreurPython("ValueError", `source invalide : ${reprPy(source)}`);
  return specs.sort((a, b) => comparePointsDeCode(a.domain, b.domain) || comparePointsDeCode(a.name, b.name));
}

/** Slug sûr pour un nom de dossier ou de fichier. */
export function slugifyName(name: string | null | undefined): string {
  const s = lowerPy(stripPy(sansAccentsPy(name || "")))
    .replaceAll(" ", "-")
    .replace(/[^a-z0-9_-]+/g, "")
    .replace(/-{2,}/g, "-");
  return stripJeu(s, "-_");
}
