// SPDX-License-Identifier: MIT
/** apps/core/src/skills/bibliotheque.ts — bibliothèque de skills (mémoire procédurale) : découverte global/learned/user, matching lexical, écritures folder-aware sous verrou, magasin perso protégé et son miroir, paquets .zip ; port de llm_core/skills.py. */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";

import {
  ArchiveZip,
  comparePointsDeCode,
  dateHeureLocale,
  ecrireZip,
  ErreurPython,
  ErreurZip,
  fixePy,
  FlottantPy as FlottantJson,
  reprPy,
  sansAccentsPy,
  stripPy,
  strPy,
} from "@elpis/commun";
import type { EntreeZipEcrite, MembreZip } from "@elpis/commun";
import { config, safeSandboxName } from "@elpis/config";
import {
  comparerChemins,
  copytree,
  deplacer,
  estDossier,
  estErreurOs,
  estFichier,
  estSous,
  existe,
  FlottantPy as FlottantFrontmatter,
  invalidateSkillsScanCache,
  nomDe,
  parentDe,
  parseTags,
  partiesRelatives,
  pyJoin,
  pyPath,
  racineSkillsApprises,
  racineSkillsGlobale,
  resoudre,
  rglob,
  rglobTrie,
  rmtree,
  scanTree,
  slugifyName,
  splitFrontmatter,
  stemDe,
  strFrontmatter,
  validateFrontmatter,
  veriteFrontmatter,
  verrouEcriture,
} from "@elpis/skills";
import type { Frontmatter, SkillSpec, ValeurFrontmatter } from "@elpis/skills";

import { journal } from "../journal";
import { exigerUtf8, lireTextePy } from "../memoire/magasin";
import { BLANC_PY, entierPy, longueurPy, lowerPy, poser, prefixePy } from "../python";
import type { Dict } from "../python";
import { pousserMiroir } from "./miroir-distant";
import { comptesSkills } from "./ports";

export {
  avecVerrouEcriture,
  discoverSkills,
  discoverSkillsBySource,
  invalidateSkillsScanCache,
  parseTags,
  racineSkillsApprises,
  racineSkillsGlobale,
  SCAN_CACHE_TTL_S,
  SkillSpec,
  slugifyName,
  verrouEcriture,
} from "@elpis/skills";

const log = (): ReturnType<typeof journal> => journal("skills");
const texteErreur = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const ERRNO: Readonly<Record<string, [number, string]>> = {
  EPERM: [1, "Operation not permitted"],
  ENOENT: [2, "No such file or directory"],
  EIO: [5, "Input/output error"],
  EACCES: [13, "Permission denied"],
  EBUSY: [16, "Device or resource busy"],
  EEXIST: [17, "File exists"],
  EXDEV: [18, "Invalid cross-device link"],
  ENOTDIR: [20, "Not a directory"],
  EISDIR: [21, "Is a directory"],
  EINVAL: [22, "Invalid argument"],
  ENOSPC: [28, "No space left on device"],
  EROFS: [30, "Read-only file system"],
  ENAMETOOLONG: [36, "File name too long"],
  ENOTEMPTY: [39, "Directory not empty"],
  ELOOP: [40, "Too many levels of symbolic links"],
};

/** `str(OSError)` : « [Errno 39] Directory not empty: 'a' -> 'b' ». */
function messageOs(e: unknown, chemin: string, chemin2?: string): string {
  const code = String((e as { code?: unknown }).code ?? "");
  const [numero, raison] = ERRNO[code] ?? [Math.abs(Number((e as { errno?: unknown }).errno) || 0), code];
  return `[Errno ${numero}] ${raison}: ${reprPy(chemin)}${chemin2 === undefined ? "" : ` -> ${reprPy(chemin2)}`}`;
}

/** `s.strip(jeu)` (ou `lstrip`) sur un jeu de caractères. */
function stripJeu(s: string, jeu: string, debutSeul = false): string {
  let debut = 0;
  let fin = s.length;
  while (debut < fin && jeu.includes(s.charAt(debut))) debut++;
  while (!debutSeul && fin > debut && jeu.includes(s.charAt(fin - 1))) fin--;
  return s.slice(debut, fin);
}

/** `a or b` sur une valeur de frontmatter. */
function ou(a: unknown, b: unknown): unknown {
  return veriteFrontmatter(a) ? a : b;
}

/** Frontmatter vers valeur JSON de Python (`dict` en objet, `float` gardé flottant). */
function versJsonPy(v: unknown): unknown {
  if (v instanceof FlottantFrontmatter) return new FlottantJson(v.valeur);
  if (v instanceof Map) {
    const out: Dict = {};
    for (const [k, x] of v) poser(out, String(k), versJsonPy(x));
    return out;
  }
  return Array.isArray(v) ? v.map(versJsonPy) : v;
}

/** `to_summary_dict()` : listing léger, sans le corps complet. */
export function resumeSkill(s: SkillSpec): Dict {
  return {
    name: s.name,
    description: s.description,
    tags: [...s.tags],
    source: s.source,
    domain: s.domain,
    path: s.path,
    body_preview: prefixePy(s.body, 500),
    body_length: longueurPy(s.body),
    is_folder: s.skillDir !== null,
    skill_dir: s.skillDir,
    files: [...s.files],
    license: s.license,
    compatibility: s.compatibility,
    metadata: versJsonPy(s.metadata),
    allowed_tools: s.allowedTools,
    id: s.id || s.name,
    parent_id: s.parentId,
    depth: s.depth,
  };
}

// ── Matching lexical ─────────────────────────────────────────────────────

const JETON = /[a-z0-9]+/g;
const MOTS_VIDES: ReadonlySet<string> = new Set(
  (
    "a à au aux avec ce ces dans de des du elle en et eux il je la le les leur lui ma " +
    "mais me même mes moi mon ne nos notre nous on ou où par pas pour qu que qui sa se " +
    "ses son sur ta te tes toi ton tu un une vos votre vous y comment quel quelle " +
    "the a an and or of to in on for with how do does is are be can i you my your it " +
    "this that these those use using make get set"
  ).split(" "),
);
const [POIDS_NOM, POIDS_TAGS, POIDS_DOMAINE, POIDS_DESC] = [3.0, 2.0, 1.5, 1.0];
const FACTEUR_RADICAL = 0.5;
const PREFIXE_MIN = 4;
const LONGUEUR_RADICAL_MIN = 4;

/** `_strip_accents` : NFKD sans marques combinantes (« déploiement » → « deploiement »). */
export function stripAccents(texte: string): string {
  return sansAccentsPy(texte);
}

export function tokenize(texte: string | null | undefined): string[] {
  return (lowerPy(sansAccentsPy(texte || "")).match(JETON) ?? []).filter(
    (t) => t.length >= 2 && !MOTS_VIDES.has(t),
  );
}

function prefixeCommun(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** 1 si `qt` est un jeton du champ, 0,5 s'il partage un radical de 4 lettres ou plus, 0 sinon. */
function toucheChamp(qt: string, jetons: ReadonlySet<string>): number {
  if (jetons.has(qt)) return 1.0;
  if (qt.length >= LONGUEUR_RADICAL_MIN)
    for (const ft of jetons)
      if (ft.length >= LONGUEUR_RADICAL_MIN && prefixeCommun(qt, ft) >= PREFIXE_MIN) return FACTEUR_RADICAL;
  return 0.0;
}

/** Score lexical (meilleur champ par jeton) et nombre de touches « fortes » (nom ou tags). */
function scoreSkill(requete: ReadonlySet<string>, s: SkillSpec): [number, number] {
  if (requete.size === 0) return [0, 0];
  const nom = new Set(tokenize(s.name.replaceAll("-", " ").replaceAll("_", " ")));
  const tags = new Set(tokenize(s.tags.join(" ")));
  const domaine = new Set(tokenize(s.domain.replaceAll("-", " ")));
  const desc = new Set(tokenize(s.description));
  let score = 0;
  let forts = 0;
  for (const qt of requete) {
    const hNom = POIDS_NOM * toucheChamp(qt, nom);
    const hTags = POIDS_TAGS * toucheChamp(qt, tags);
    const meilleur = Math.max(
      hNom,
      hTags,
      POIDS_DOMAINE * toucheChamp(qt, domaine),
      POIDS_DESC * toucheChamp(qt, desc),
    );
    if (meilleur > 0) {
      score += meilleur;
      if (hNom > 0 || hTags > 0) forts++;
    }
  }
  return [score, forts];
}

/** Skills pertinents pour `query` : score ≥ `minScore`, tri score puis spécificité puis nom, `topN` au plus. */
export function matchSkills(
  query: string,
  skills: readonly SkillSpec[],
  options: { topN?: number; minScore?: number } = {},
): SkillSpec[] {
  const topN = options.topN ?? 3;
  const minScore = options.minScore ?? 1.0;
  if (skills.length === 0 || topN <= 0) return [];
  const requete = new Set(tokenize(query));
  if (requete.size === 0) return [];
  const notes: [SkillSpec, number, number][] = [];
  for (const s of skills) {
    const [score, forts] = scoreSkill(requete, s);
    if (score >= minScore) notes.push([s, score, forts]);
  }
  notes.sort((a, b) => b[1] - a[1] || b[2] - a[2] || comparePointsDeCode(a[0].name, b[0].name));
  return notes.slice(0, topN).map(([s]) => s);
}

// ── Écritures ────────────────────────────────────────────────────────────

/** Erreur métier d'écriture (message destiné à l'agent ou à l'UI). */
export class SkillSaveError extends Error {
  override name = "SkillSaveError";
  /** Texte anglais pour le modèle (outils) ; `message` reste le français des routes de l'interface. */
  readonly en: string;

  constructor(message: string, en?: string) {
    super(message);
    this.en = en ?? message;
  }
}

/** Import refusé : dossiers-skills cibles déjà présents sans `overwrite` (409 côté route). */
export class SkillExistsError extends SkillSaveError {
  override name = "SkillExistsError";
  readonly names: string[];

  constructor(names: readonly string[]) {
    super(
      names.length === 1
        ? `skill existe déjà : ${names[0] ?? ""}`
        : `skills existent déjà : ${names.join(", ")}`,
    );
    this.names = [...names];
  }
}

export const MAX_NAME_LEN = 80;
export const MAX_DESC_LEN = 300;
export const MAX_BODY_LEN = 20000;
export const MAX_TAGS = 20;
export const MAX_TAG_LEN = 40;
/** Toute coupure de ligne au sens de `splitlines` (une valeur mono-ligne ne doit pas créer de fausse clé). */
const FINS_DE_LIGNE = "\\r\\n\\v\\f\\x1c-\\x1f\\x85\\u2028\\u2029";
const COUPURES = new RegExp(`[${FINS_DE_LIGNE}]+`, "g");
const BLANCS_REPETES = new RegExp(`${BLANC_PY}{2,}`, "g");
const CROCHETS_VIRGULES = /[[\],]+/g;

/** `_one_line` : valeur de frontmatter aplatie sur une ligne. */
export function uneLigne(v: unknown): string {
  return stripPy(strFrontmatter(ou(v, "")).replace(COUPURES, " ").replace(BLANCS_REPETES, " "));
}

/** `_sanitize_tags` : coupures, crochets et virgules neutralisés, bornés en nombre et en longueur. */
export function assainirTags(tags: unknown): string[] {
  const out: string[] = [];
  for (const t of parseTags(tags)) {
    const u = uneLigne(t.replace(CROCHETS_VIRGULES, " "));
    if (u) out.push(prefixePy(u, MAX_TAG_LEN));
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** `_prepare_fields` : `[slug, description, body, tags]` validés et bornés. */
export function preparerChamps(
  name: string | null | undefined,
  description: string | null | undefined,
  body: string | null | undefined,
  tags: unknown,
): [string, string, string, string[]] {
  const slug = slugifyName(prefixePy(name || "", MAX_NAME_LEN));
  if (!slug)
    throw new SkillSaveError(
      "name invalide (vide après normalisation)",
      "invalid name (empty after normalisation)",
    );
  const corps = stripPy(body || "");
  if (!corps)
    throw new SkillSaveError(
      "body requis (la procédure ne peut pas être vide)",
      "body required (the procedure cannot be empty)",
    );
  return [
    slug,
    prefixePy(stripPy(description || ""), MAX_DESC_LEN),
    prefixePy(corps, MAX_BODY_LEN),
    assainirTags(tags),
  ];
}

/** `_render_skill_md` : frontmatter minimal puis corps (écrivains legacy). */
export function rendreSkillMd(
  slug: string,
  description: string,
  body: string,
  tags: unknown,
  domaineSlug = "",
): string {
  const lignes = [
    "---",
    `name: ${slug}`,
    `description: ${uneLigne(description)}`,
    `tags: [${assainirTags(tags).join(", ")}]`,
  ];
  if (domaineSlug) lignes.push(`domain: ${domaineSlug}`);
  lignes.push("---");
  return `${lignes.join("\n")}\n\n${stripPy(body)}\n`;
}

/** `_atomic_write` : temporaire `<nom>.md.tmp` puis remplacement, jamais de temporaire orphelin. */
async function ecrireAtomique(dest: string, contenu: string): Promise<void> {
  await mkdir(parentDe(dest), { recursive: true });
  const tmp = pyJoin(parentDe(dest), `${stemDe(dest)}.md.tmp`);
  try {
    exigerUtf8(contenu);
    await writeFile(tmp, contenu, "utf8");
    await rename(tmp, dest);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

const ORDRE_GERE = [
  "name",
  "description",
  "tags",
  "domain",
  "license",
  "compatibility",
  "allowed-tools",
] as const;

function videAuRendu(v: ValeurFrontmatter | undefined, dictCompris: boolean): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  return dictCompris && v instanceof Map && v.size === 0;
}

/** `_render_frontmatter` : bloc `---…---` complet, clés gérées dans l'ordre canonique, inconnues gardées, `metadata` en dernier. */
export function rendreFrontmatter(fm: Frontmatter): string {
  const lignes = ["---"];
  const emettre = (cle: string, v: ValeurFrontmatter): void => {
    if (Array.isArray(v)) {
      const items = v
        .map((t) => uneLigne(strFrontmatter(t).replace(CROCHETS_VIRGULES, " ")))
        .filter((t) => t);
      lignes.push(`${cle}: [${items.join(", ")}]`);
    } else lignes.push(`${cle}: ${uneLigne(v)}`);
  };
  const vus = new Set<string>();
  for (const cle of ORDRE_GERE) {
    const v = fm.get(cle);
    if (v === undefined || videAuRendu(v, true)) continue;
    emettre(cle, v);
    vus.add(cle);
  }
  for (const [cle, v] of fm) {
    if (vus.has(cle) || cle === "metadata" || v instanceof Map || videAuRendu(v, false)) continue;
    const k = uneLigne(cle);
    if (k) emettre(k, v);
  }
  const meta = fm.get("metadata");
  if (meta instanceof Map && meta.size > 0) {
    lignes.push("metadata:");
    for (const [k, v] of meta) {
      const k2 = uneLigne(k);
      if (k2) lignes.push(`  ${k2}: ${uneLigne(v)}`);
    }
  }
  lignes.push("---");
  return `${lignes.join("\n")}\n`;
}

/** `_update_skill_md_in_place` : champs du formulaire écrasés, reste du frontmatter préservé ; `domain` null = clé intacte. */
async function majSkillMd(
  skillmd: string,
  nameSlug: string,
  description: string,
  body: string,
  tags: readonly string[],
  domain: string | null,
): Promise<void> {
  let precedent: Frontmatter = new Map();
  try {
    precedent = splitFrontmatter(await lireTextePy(skillmd))[0];
  } catch (e) {
    if (!estErreurOs(e)) throw e;
  }
  const fm: Frontmatter = new Map(precedent);
  fm.set("name", nameSlug);
  fm.set("description", description);
  fm.set("tags", [...tags]);
  if (domain !== null) {
    if (domain) fm.set("domain", domain);
    else fm.delete("domain");
  }
  await ecrireAtomique(skillmd, `${rendreFrontmatter(fm)}\n${stripPy(body)}\n`);
}

/** `_find_entry` : id qualifié, nom exact, puis slug du dernier segment (dossier avant legacy, moins profond, id). */
async function trouverEntree(
  racine: string | null,
  source: string,
  ident: string | null | undefined,
  exclusions: readonly string[] = [],
): Promise<SkillSpec | null> {
  const id = stripJeu(stripPy(ident || ""), "/");
  if (!id || !racine || !(await estDossier(racine))) return null;
  const specs = await scanTree(racine, source, exclusions);
  const exact = specs.find((sp) => sp.id === id);
  if (exact !== undefined) return exact;
  let candidats = specs.filter((sp) => sp.name === id);
  if (candidats.length === 0) {
    const feuille = slugifyName(id.split("/").at(-1));
    if (feuille) candidats = specs.filter((sp) => slugifyName(sp.name) === feuille);
  }
  candidats.sort(
    (a, b) =>
      (a.skillDir !== null ? 0 : 1) - (b.skillDir !== null ? 0 : 1) ||
      a.depth - b.depth ||
      comparePointsDeCode(a.id, b.id),
  );
  return candidats[0] ?? null;
}

async function globalNameExists(name: string): Promise<boolean> {
  return (await trouverEntree(racineSkillsGlobale(), "global", name, ["learned"])) !== null;
}

/** Skill GLOBAL par ident (`_find_global_entry`). */
export function findGlobalEntry(ident: string): Promise<SkillSpec | null> {
  return trouverEntree(racineSkillsGlobale(), "global", ident, ["learned"]);
}

/** Skill LEARNED par ident (`_find_learned_entry`). */
export function findLearnedEntry(ident: string): Promise<SkillSpec | null> {
  return trouverEntree(racineSkillsApprises(), "learned", ident);
}

/** Skill PERSO par ident (`find_user_entry`). */
export function findUserEntry(userSkillsDir: string | null, ident: string): Promise<SkillSpec | null> {
  return userSkillsDir === null ? Promise.resolve(null) : trouverEntree(pyPath(userSkillsDir), "user", ident);
}

/** Résout `p` relativement à la racine `learned` résolue ; faux hors de `learned` ou sans exclusion. */
function dansApprises(p: string, apprises: string | null): boolean {
  if (apprises === null) return false;
  try {
    return partiesRelatives(resoudre(p), apprises) !== null;
  } catch {
    return false;
  }
}

/** `_purge_slug_entries` : toute autre entrée du slug que `garder` (legacy et dossiers), jamais la racine ni un ancêtre. */
async function purgerEntreesSlug(
  racine: string,
  slug: string,
  garder: string,
  exclureApprises = false,
): Promise<void> {
  if (!(await estDossier(racine))) return;
  const garderReel = resoudre(garder);
  const apprises = exclureApprises ? resoudre(racineSkillsApprises()) : null;
  for (const p of await rglobTrie(racine, (n) => n === `${slug}.md`)) {
    if (!(await estFichier(p)) || dansApprises(p, apprises)) continue;
    if (resoudre(p) === garderReel) continue;
    await unlink(p).catch(() => undefined);
  }
  const racineReelle = resoudre(racine);
  for (const sm of await rglobTrie(racine, (n) => n === "SKILL.md")) {
    const d = parentDe(sm);
    if (nomDe(d) !== slug || dansApprises(d, apprises)) continue;
    if (resoudre(d) === racineReelle || !estSous(d, racine)) continue;
    if (resoudre(sm) === garderReel || estSous(garder, d)) continue;
    await rmtree(d).catch(() => undefined);
  }
}

/** `_delete_slug_copies` : toutes les copies `<slug>.md` (hors `learned` si demandé). */
async function supprimerCopiesSlug(racine: string, slug: string, exclureApprises = false): Promise<boolean> {
  if (!(await estDossier(racine))) return false;
  const apprises = exclureApprises ? resoudre(racineSkillsApprises()) : null;
  let supprime = false;
  for (const p of await rglobTrie(racine, (n) => n === `${slug}.md`)) {
    if (!(await estFichier(p)) || dansApprises(p, apprises)) continue;
    try {
      await unlink(p);
      supprime = true;
    } catch (e) {
      if (!estErreurOs(e)) throw e;
    }
  }
  return supprime;
}

/** `_delete_slug_entries` : id qualifié = cette seule entrée ; slug = toutes ses copies, legacy et dossiers. */
async function supprimerEntreesSlug(
  racine: string,
  source: string,
  ident: string | null | undefined,
  exclureApprises = false,
): Promise<boolean> {
  if (!(await estDossier(racine))) return false;
  const id = stripJeu(stripPy(ident || ""), "/");
  if (!id) return false;
  if (id.includes("/")) {
    const spec = await trouverEntree(racine, source, id, exclureApprises ? ["learned"] : []);
    if (spec === null) return false;
    const cible = spec.skillDir ?? spec.path;
    if (cible === null || !estSous(cible, racine) || resoudre(cible) === resoudre(racine)) return false;
    try {
      if (await estDossier(cible)) await rmtree(cible);
      else await unlink(cible);
      invalidateSkillsScanCache();
      return true;
    } catch (e) {
      if (estErreurOs(e)) return false;
      throw e;
    }
  }
  const slug = slugifyName(id);
  if (!slug) return false;
  let supprime = await supprimerCopiesSlug(racine, slug, exclureApprises);
  const apprises = exclureApprises ? resoudre(racineSkillsApprises()) : null;
  const racineReelle = resoudre(racine);
  for (const sm of await rglobTrie(racine, (n) => n === "SKILL.md")) {
    const d = parentDe(sm);
    if (nomDe(d) !== slug || dansApprises(d, apprises)) continue;
    if (resoudre(d) === racineReelle || !estSous(d, racine)) continue;
    try {
      await rmtree(d);
      supprime = true;
    } catch (e) {
      if (!estErreurOs(e)) throw e;
    }
  }
  if (supprime) invalidateSkillsScanCache();
  return supprime;
}

interface OptionsEntree {
  prevName?: string | null | undefined;
  exclureApprises?: boolean;
  interdireApprises?: boolean;
}

/** `_save_skill_entry` : renommage, mise à jour selon le modèle existant, sinon création en dossier ; purge du slug ensuite. */
async function enregistrerEntree(
  racine: string,
  source: string,
  name: string | null | undefined,
  description: string | null | undefined,
  body: string | null | undefined,
  tags: unknown,
  domain: string | null | undefined,
  o: OptionsEntree = {},
): Promise<string> {
  const [slug, desc, corps, etiquettes] = preparerChamps(name, description, body, tags);
  const domaineSlug = domain ? slugifyName(domain) : "";
  if (o.interdireApprises && (slug === "learned" || domaineSlug === "learned"))
    throw new SkillSaveError(
      "'learned' est réservé (SAS de curation) — choisis un autre name/domaine",
      "'learned' is reserved (curation staging area): choose another name/domain",
    );
  const exclusions = o.exclureApprises ? ["learned"] : [];
  const finir = async (dest: string): Promise<string> => {
    await purgerEntreesSlug(racine, slug, dest, o.exclureApprises);
    invalidateSkillsScanCache();
    return dest;
  };
  if (o.prevName) {
    const precedente = slugifyName(o.prevName.split("/").at(-1));
    if (precedente && precedente !== slug) {
      const ancien = await trouverEntree(racine, source, o.prevName, exclusions);
      if (ancien?.skillDir) {
        const nouveau = pyJoin(parentDe(ancien.skillDir), slug);
        if (await existe(nouveau))
          throw new SkillSaveError(
            `'${slug}' existe déjà à cet emplacement — renommage refusé`,
            `'${slug}' already exists at this location: rename refused`,
          );
        try {
          await rename(ancien.skillDir, nouveau);
        } catch (e) {
          if (!estErreurOs(e)) throw e;
          throw new SkillSaveError(
            `renommage du dossier impossible : ${messageOs(e, ancien.skillDir, nouveau)}`,
            `cannot rename the folder: ${messageOs(e, ancien.skillDir, nouveau)}`,
          );
        }
        const dest = pyJoin(nouveau, "SKILL.md");
        await majSkillMd(dest, slug, desc, corps, etiquettes, ancien.depth === 0 ? domaineSlug : null);
        return finir(dest);
      }
      if (ancien?.path) {
        const dest = pyJoin(domaineSlug ? pyJoin(racine, domaineSlug) : racine, `${slug}.md`);
        await ecrireAtomique(dest, rendreSkillMd(slug, desc, corps, etiquettes, domaineSlug));
        await unlink(ancien.path).catch(() => undefined);
        return finir(dest);
      }
    }
  }
  const existant = await trouverEntree(racine, source, slug, exclusions);
  if (existant?.skillDir) {
    const dest = pyJoin(existant.skillDir, "SKILL.md");
    await majSkillMd(dest, existant.name, desc, corps, etiquettes, existant.depth === 0 ? domaineSlug : null);
    return finir(dest);
  }
  if (existant?.path) {
    const dest = pyJoin(domaineSlug ? pyJoin(racine, domaineSlug) : racine, `${slug}.md`);
    await ecrireAtomique(dest, rendreSkillMd(slug, desc, corps, etiquettes, domaineSlug));
    return finir(dest);
  }
  const dossier = domaineSlug ? pyJoin(pyJoin(racine, domaineSlug), slug) : pyJoin(racine, slug);
  if (await estDossier(dossier))
    for (const p of await rglob(dossier, (n) => n.endsWith(".md")))
      if ((await estFichier(p)) && nomDe(p) !== "SKILL.md")
        throw new SkillSaveError(
          `un dossier '${slug}' existe déjà et contient des skills mono-fichier — choisis un autre name (ou migre d'abord ce dossier en package)`,
          `a folder '${slug}' already exists and holds single-file skills: choose another name (or first migrate that folder to a package)`,
        );
  const dest = pyJoin(dossier, "SKILL.md");
  const fm: Frontmatter = new Map<string, ValeurFrontmatter>([
    ["name", slug],
    ["description", desc],
    ["tags", etiquettes],
  ]);
  await ecrireAtomique(dest, `${rendreFrontmatter(fm)}\n${stripPy(corps)}\n`);
  return finir(dest);
}

export interface OptionsSauvegarde {
  prevName?: string | null;
}

/** Brouillon ADMIN dans `learned/` ; refusé s'il masquerait un skill global. */
export async function saveLearnedSkill(
  name: string,
  description: string,
  body: string,
  tags: unknown = null,
  domain: string | null = null,
  options: OptionsSauvegarde = {},
): Promise<string> {
  const [slug, desc, corps, etiquettes] = preparerChamps(name, description, body, tags);
  const dest = await verrouEcriture.avec(async () => {
    if (await globalNameExists(slug))
      throw new SkillSaveError(
        `un skill global '${slug}' existe déjà — édite-le directement ou choisis un autre name (les learned ne peuvent pas masquer un skill curé)`,
        `a global skill '${slug}' already exists: edit it directly or choose another name (learned skills cannot shadow a curated skill)`,
      );
    return enregistrerEntree(racineSkillsApprises(), "learned", slug, desc, corps, etiquettes, domain, {
      prevName: options.prevName,
      interdireApprises: true,
    });
  });
  log().info(`learned skill saved: ${dest}`);
  return dest;
}

/** Promeut un learned vers `skills/` (fichier ou dossier entier, sous-dossier de domaine gardé) ; rend le chemin déplacé. */
export async function promoteLearnedSkill(name: string): Promise<string> {
  const slug = slugifyName(name);
  if (!slug) throw new SkillSaveError("name invalide");
  const dest = await verrouEcriture.avec(async () => {
    const spec = await findLearnedEntry(name);
    if (spec === null) throw new SkillSaveError(`skill learned introuvable : ${slug}`);
    if (spec.depth > 0)
      throw new SkillSaveError(
        `'${spec.id}' est un sous-skill — promeus son package racine ('${spec.id.split("/")[0] ?? ""}')`,
      );
    if (await globalNameExists(spec.name))
      throw new SkillSaveError(`un skill global '${spec.name}' existe déjà — résous le conflit à la main`);
    const src = spec.skillDir ?? spec.path ?? "";
    const rel = partiesRelatives(src, racineSkillsApprises());
    if (rel === null)
      throw new ErreurPython(
        "ValueError",
        `${reprPy(src)} is not in the subpath of ${reprPy(racineSkillsApprises())}`,
      );
    const relatif = rel.join("/") || ".";
    const cible = pyJoin(racineSkillsGlobale(), relatif);
    if (await existe(cible))
      throw new SkillSaveError(`'${relatif}' existe déjà côté global — résous le conflit à la main`);
    await mkdir(parentDe(cible), { recursive: true });
    await rename(src, cible);
    return cible;
  });
  log().info(`promoted learned → global: ${dest}`);
  invalidateSkillsScanCache();
  return dest;
}

/** Crée ou met à jour un skill PERSO (peut surcharger un global). */
export async function saveUserSkill(
  userSkillsDir: string,
  name: string,
  description: string,
  body: string,
  tags: unknown = null,
  domain: string | null = null,
  options: OptionsSauvegarde = {},
): Promise<string> {
  const dest = await verrouEcriture.avec(() =>
    enregistrerEntree(pyPath(userSkillsDir), "user", name, description, body, tags, domain, {
      prevName: options.prevName,
    }),
  );
  log().info(`user skill saved: ${dest}`);
  return dest;
}

/** Supprime un skill perso (id qualifié : ce seul sous-skill ; slug : toutes ses copies). */
export async function deleteUserSkill(userSkillsDir: string, name: string): Promise<boolean> {
  const supprime = await verrouEcriture.avec(() => supprimerEntreesSlug(pyPath(userSkillsDir), "user", name));
  if (supprime) log().info(`user skill deleted: ${name}`);
  return supprime;
}

/** Crée ou met à jour un skill GLOBAL curé (`learned` réservé). */
export async function saveGlobalSkill(
  name: string,
  description: string,
  body: string,
  tags: unknown = null,
  domain: string | null = null,
  options: OptionsSauvegarde = {},
): Promise<string> {
  const dest = await verrouEcriture.avec(() =>
    enregistrerEntree(racineSkillsGlobale(), "global", name, description, body, tags, domain, {
      prevName: options.prevName,
      exclureApprises: true,
      interdireApprises: true,
    }),
  );
  log().info(`global skill saved: ${dest}`);
  return dest;
}

/** Rejette un learned non promu. */
export async function deleteLearnedSkill(name: string): Promise<boolean> {
  const supprime = await verrouEcriture.avec(() =>
    supprimerEntreesSlug(racineSkillsApprises(), "learned", name),
  );
  if (supprime) log().info(`learned skill deleted: ${name}`);
  return supprime;
}

/** Supprime un skill GLOBAL (jamais sous `learned/`). */
export async function deleteGlobalSkill(name: string): Promise<boolean> {
  const supprime = await verrouEcriture.avec(() =>
    supprimerEntreesSlug(racineSkillsGlobale(), "global", name, true),
  );
  if (supprime) log().info(`global skill deleted: ${name}`);
  return supprime;
}

// ── Magasin perso protégé et miroir sandbox ──────────────────────────────

/** Garantit le magasin (hors sandbox) et y déplace une fois l'ancien `<sandbox>/skills` ; ne lève jamais. */
export async function ensureUserSkillsStore(
  storeDir: string,
  sandboxDir: string | null = null,
): Promise<string> {
  const store = pyPath(storeDir);
  let migre = false;
  try {
    const ancien = sandboxDir ? pyJoin(sandboxDir, "skills") : null;
    if (ancien !== null && !(await existe(store)) && (await estDossier(ancien))) {
      await verrouEcriture.avec(async () => {
        if (!(await existe(store)) && (await estDossier(ancien))) {
          await mkdir(parentDe(store), { recursive: true });
          await deplacer(ancien, store);
          migre = true;
        }
      });
      if (migre) log().info(`store perso migré hors sandbox : ${ancien} → ${store}`);
    }
  } catch (e) {
    log().warn(`migration du store perso échouée (${store}) : ${texteErreur(e)}`);
  }
  if (migre && sandboxDir) await syncUserSkillsMirror(store, sandboxDir);
  return store;
}

/** Reconstruit la copie jetable `<sandbox>/skills/` depuis le magasin (bascule par temporaire) ; `null` en échec. */
export async function syncUserSkillsMirror(
  storeDir: string | null,
  sandboxDir: string | null,
): Promise<string | null> {
  if (!sandboxDir) return null;
  const miroir = pyJoin(sandboxDir, "skills");
  const store = storeDir ? pyPath(storeDir) : null;
  const tmp = pyJoin(sandboxDir, ".skills-mirror.tmp");
  try {
    await verrouEcriture.avec(async () => {
      await rmtree(tmp, true);
      if (store !== null && (await estDossier(store)) && (await readdir(store)).length > 0) {
        await copytree(store, tmp);
        await rmtree(miroir, true);
        await rename(tmp, miroir);
      } else await rmtree(miroir, true);
    });
    return miroir;
  } catch (e) {
    log().warn(`sync du miroir sandbox échoué (${miroir}) : ${texteErreur(e)}`);
    await rmtree(tmp, true);
    return null;
  }
}

/** Racine de la sandbox du compte (`_user_sandbox_root` des routes) ; `null` si inconnue. */
export async function userSandboxRoot(uid: number | null): Promise<string | null> {
  if (uid === null) return null;
  try {
    const racine = await comptesSkills().racineSandbox(uid);
    return racine ? pyPath(racine) : null;
  } catch (e) {
    log().debug(`sandbox du compte ${uid} inconnue : ${texteErreur(e)}`);
    return null;
  }
}

/** Magasin perso protégé du compte (`USER_SKILLS_DIR/<nom sûr>`, ancien emplacement migré) ; `null` en échec. */
export async function userSkillsDir(uid: number | null): Promise<string | null> {
  if (uid === null) return null;
  try {
    const nom = (await comptesSkills().nomUtilisateur(uid)) || `user_${uid}`;
    return await ensureUserSkillsStore(
      pyJoin(config.USER_SKILLS_DIR, safeSandboxName(nom)),
      await userSandboxRoot(uid),
    );
  } catch (e) {
    log().debug(`magasin de skills du compte ${uid} introuvable : ${texteErreur(e)}`);
    return null;
  }
}

/** `_sync_user_mirror` : après chaque mutation du magasin perso, copie sandbox régénérée puis poussée vers l'hôte d'outils distant (un envoi à la fois par compte). */
export async function syncUserMirror(uid: number | null): Promise<void> {
  try {
    await syncUserSkillsMirror(await userSkillsDir(uid), await userSandboxRoot(uid));
  } catch (e) {
    log().debug(`miroir local non régénéré : ${texteErreur(e)}`);
  }
  if (uid === null) return;
  try {
    const dossier = await userSkillsDir(uid);
    if (dossier !== null) await pousserMiroir(uid, dossier);
  } catch (e) {
    log().debug(`miroir non poussé : ${texteErreur(e)}`);
  }
}

/** Dossier d'un skill perso par slug ou id qualifié ; le chemin finissant par l'id gagne, sinon le premier trié. */
export async function findUserSkillDir(userSkillsDir: string, ident: unknown): Promise<string | null> {
  const store = pyPath(userSkillsDir);
  const parts = strPy(veriteFrontmatter(ident) ? ident : "")
    .split("/")
    .filter((p) => stripPy(p))
    .map((p) => slugifyName(p));
  const feuille = parts.at(-1);
  if (feuille === undefined || !(await estDossier(store))) return null;
  const trouves =
    feuille === "" ? [store, ...(await rglob(store, () => true))] : await rglob(store, (n) => n === feuille);
  const candidats: string[] = [];
  for (const d of trouves) {
    if (
      feuille === "" &&
      d !== store &&
      !(await lstat(d).then(
        (x) => x.isDirectory(),
        () => false,
      ))
    )
      continue;
    if ((await estDossier(d)) && (await estFichier(pyJoin(d, "SKILL.md")))) candidats.push(d);
  }
  candidats.sort(comparerChemins);
  if (candidats.length === 0) return null;
  const suffixe = parts.join("/");
  for (const d of candidats) {
    const rel = (partiesRelatives(d, store) ?? []).join("/") || ".";
    if (rel === suffixe || rel.endsWith(`/${suffixe}`)) return d;
  }
  return candidats[0] ?? null;
}

/** Plafond d'un fichier groupé ajouté par `skill_add_file`. */
export const SKILL_FILE_MAX_BYTES = entierPy(process.env["SKILL_FILE_MAX_BYTES"] ?? String(256 * 1024));

/** Écrit un fichier groupé (script, référence…) dans un skill perso existant, au format dossier. */
export async function addUserSkillFile(
  userSkillsDir: string,
  name: string,
  relpath: string,
  content: string,
): Promise<string> {
  const rel = stripJeu(stripPy((relpath || "").replaceAll("\\", "/")), "/", true);
  const parts = rel.split("/").filter((p) => p);
  if (parts.length === 0 || longueurPy(rel) > 300 || parts.some((p) => p.startsWith(".")))
    throw new SkillSaveError(
      "chemin invalide : relatif au dossier du skill (ex. scripts/run.sh), sans '..' ni segments cachés",
      "invalid path: relative to the skill folder (e.g. scripts/run.sh), without '..' or hidden segments",
    );
  if (parts.at(-1) === "SKILL.md")
    throw new SkillSaveError(
      "SKILL.md se met à jour via skill_save, pas via skill_add_file",
      "SKILL.md is updated via skill_save, not via skill_add_file",
    );
  exigerUtf8(content || "");
  const donnees = Buffer.from(content || "", "utf8");
  if (donnees.length === 0)
    throw new SkillSaveError("content requis (fichier vide refusé)", "content required (empty file refused)");
  if (donnees.length > SKILL_FILE_MAX_BYTES)
    throw new SkillSaveError(
      `fichier trop gros (${donnees.length} > ${SKILL_FILE_MAX_BYTES} octets)`,
      `file too large (${donnees.length} > ${SKILL_FILE_MAX_BYTES} bytes)`,
    );
  const cible = await verrouEcriture.avec(async () => {
    const d = await findUserSkillDir(userSkillsDir, name);
    if (d === null)
      throw new SkillSaveError(
        `skill perso « ${name} » introuvable au format dossier — crée-le d'abord avec skill_save`,
        `personal skill « ${name} » not found in folder format: create it first with skill_save`,
      );
    const c = pyJoin(d, rel);
    if (!resoudre(c).startsWith(`${resoudre(d)}/`))
      throw new SkillSaveError("chemin hors du dossier du skill", "path outside the skill folder");
    await mkdir(parentDe(c), { recursive: true });
    await writeFile(c, donnees);
    return c;
  });
  log().info(`user skill file written: ${cible}`);
  return cible;
}

// ── Paquets .zip ─────────────────────────────────────────────────────────

export const SKILL_ZIP_MAX_BYTES = entierPy(process.env["SKILL_ZIP_MAX_BYTES"] ?? String(25 * 1024 * 1024));
export const SKILL_ZIP_MAX_UNCOMPRESSED = entierPy(
  process.env["SKILL_ZIP_MAX_UNCOMPRESSED"] ?? String(25 * 1024 * 1024),
);
export const SKILL_ZIP_MAX_FILES = entierPy(process.env["SKILL_ZIP_MAX_FILES"] ?? "500");

const UTF8_REMPLACEMENT = new TextDecoder("utf-8", { ignoreBOM: true });

/** Slug du `name:` d'un SKILL.md (`""` si illisible) : nomme le dossier d'un import « en vrac ». */
export function slugFromSkillMd(octets: Uint8Array): string {
  try {
    const [fm] = splitFrontmatter(UTF8_REMPLACEMENT.decode(octets));
    return slugifyName(prefixePy(strFrontmatter(ou(fm.get("name"), "")), MAX_NAME_LEN));
  } catch {
    return "";
  }
}

/** Zippe un skill au layout `<name>/…` ; un legacy part en `<name>/SKILL.md`. */
export async function exportSkillZip(spec: SkillSpec): Promise<Buffer> {
  const entrees: EntreeZipEcrite[] = [];
  if (spec.skillDir !== null) {
    for (const f of await rglobTrie(spec.skillDir, () => true)) {
      if (!(await estFichier(f))) continue;
      const rel = partiesRelatives(f, spec.skillDir) ?? [];
      if (rel.some((p) => p.startsWith("."))) continue;
      const s = await stat(f);
      entrees.push({
        nom: `${spec.name}/${rel.join("/")}`,
        donnees: await readFile(f),
        dateHeure: dateHeureLocale(s.mtimeMs),
        attributsExternes: ((s.mode & 0xffff) << 16) >>> 0,
      });
    }
  } else if (spec.path !== null) {
    let texte: string;
    try {
      texte = await lireTextePy(spec.path);
    } catch (e) {
      if (!estErreurOs(e)) throw e;
      throw new SkillSaveError(`lecture du skill échouée : ${messageOs(e, spec.path)}`);
    }
    entrees.push({
      nom: `${spec.name}/SKILL.md`,
      donnees: Buffer.from(texte, "utf8"),
      dateHeure: dateHeureLocale(Date.now()),
      attributsExternes: (0o600 << 16) >>> 0,
    });
  }
  return ecrireZip(entrees);
}

/** `_zip_safe_members` : refus du zip-slip et des dépassements ; cachés ignorés ; plusieurs racines admises. */
function membresSurs(zf: ArchiveZip, maxFichiers: number, maxDecompresse: number): [string, MembreZip][] {
  const infos = zf.membres.filter((i) => !i.nom.endsWith("/"));
  if (infos.length === 0) throw new SkillSaveError("archive vide");
  if (infos.length > maxFichiers)
    throw new SkillSaveError(`trop de fichiers (${infos.length} > ${maxFichiers})`);
  if (infos.reduce((s, i) => s + Math.max(0, i.taille), 0) > maxDecompresse)
    throw new SkillSaveError(
      `contenu décompressé trop volumineux (> ${Math.floor(maxDecompresse / 1048576)} Mo)`,
    );
  const membres: [string, MembreZip][] = [];
  for (const i of infos) {
    const arc = i.nom.replaceAll("\\", "/");
    if (arc.includes("\0")) throw new SkillSaveError(`chemin d'archive invalide : ${reprPy(arc)}`);
    const absolu = arc.startsWith("/");
    const parts = arc.split("/").filter((p) => p !== "" && p !== ".");
    if (parts.length === 0 && !absolu) continue;
    if (absolu || parts.includes(".."))
      throw new SkillSaveError(`chemin d'archive dangereux (zip-slip) : ${arc}`);
    if (parts.some((p) => p.startsWith("."))) continue;
    membres.push([arc, i]);
  }
  if (membres.length === 0) throw new SkillSaveError("archive sans fichier exploitable");
  return membres;
}

export interface OptionsInstallation {
  source?: string;
  strict?: boolean;
  overwrite?: boolean;
}

/** Installe un ou plusieurs skills d'un .zip sous `destRoot` (arborescence gardée) ; rend les dossiers-skills installés. */
export async function installSkillZip(
  octets: Uint8Array,
  destRoot: string,
  options: OptionsInstallation = {},
): Promise<string[]> {
  const source = options.source ?? "global";
  if (octets.length === 0) throw new SkillSaveError("fichier .zip vide");
  if (octets.length > SKILL_ZIP_MAX_BYTES)
    throw new SkillSaveError(
      `archive trop volumineuse (${fixePy(octets.length / 1048576, 1)} Mo > ${fixePy(SKILL_ZIP_MAX_BYTES / 1048576, 0)} Mo)`,
    );
  let zf: ArchiveZip;
  try {
    zf = new ArchiveZip(octets);
  } catch (e) {
    if (e instanceof ErreurZip && e.type === "BadZipFile")
      throw new SkillSaveError("fichier invalide : ce n'est pas une archive .zip");
    throw e;
  }
  let membres = membresSurs(zf, SKILL_ZIP_MAX_FILES, SKILL_ZIP_MAX_UNCOMPRESSED);
  if (!membres.some(([arc]) => arc === "SKILL.md" || arc.endsWith("/SKILL.md"))) {
    const remappes = membres.map(([arc, info]): [string, MembreZip] => {
      const parts = arc.split("/");
      if (lowerPy(parts.at(-1) ?? "") === "skill.md") parts[parts.length - 1] = "SKILL.md";
      return [parts.join("/"), info];
    });
    if (new Set(remappes.map(([a]) => a)).size !== remappes.length)
      throw new SkillSaveError("plusieurs SKILL.md avec des casses différentes dans le même dossier");
    membres = remappes;
  }
  const manifesteRacine = membres.find(([arc]) => arc === "SKILL.md")?.[1];
  if (manifesteRacine !== undefined) {
    const dossier = slugFromSkillMd(zf.lire(manifesteRacine)) || "skill-importe";
    membres = membres.map(([arc, info]) => [`${dossier}/${arc}`, info]);
  }
  const parArc = new Map(membres);
  const dossiersSkills = [
    ...new Set(
      membres.filter(([arc]) => arc.endsWith("/SKILL.md")).map(([arc]) => arc.slice(0, -"/SKILL.md".length)),
    ),
  ].sort(comparePointsDeCode);
  if (dossiersSkills.length === 0)
    throw new SkillSaveError(
      "aucun fichier SKILL.md trouvé — l'archive ou le dossier doit contenir un SKILL.md (à la racine ou dans un dossier de skill)",
    );
  if (options.strict ?? true)
    for (const d of dossiersSkills) {
      const info = parArc.get(`${d}/SKILL.md`);
      if (info === undefined) throw new SkillSaveError(`SKILL.md illisible : ${d}/SKILL.md`);
      const [fm] = splitFrontmatter(UTF8_REMPLACEMENT.decode(zf.lire(info)));
      const errs = validateFrontmatter(fm, { dirName: d.split("/").at(-1) ?? "" });
      if (errs.length > 0) throw new SkillSaveError(`${d}/SKILL.md non conforme : ${errs.join(" ; ")}`);
    }
  const garder = membres.filter(([arc]) =>
    dossiersSkills.some((d) => arc === `${d}/SKILL.md` || arc.startsWith(`${d}/`)),
  );
  const racine = pyPath(destRoot);
  const racineReelle = resoudre(racine);
  await verrouEcriture.avec(async () => {
    const cibles: [string, string][] = [];
    for (const r of [...new Set(dossiersSkills.map((d) => d.split("/")[0] ?? ""))].sort(
      comparePointsDeCode,
    )) {
      const cible = resoudre(pyJoin(racine, r));
      if (parentDe(cible) !== racineReelle)
        throw new SkillSaveError(`dossier de skill invalide : ${r} (chemin résolu hors de la bibliothèque)`);
      cibles.push([r, cible]);
    }
    const existants: string[] = [];
    for (const [r, c] of cibles) if (await existe(c)) existants.push(r);
    if (existants.length > 0 && !options.overwrite) throw new SkillExistsError(existants);
    const miseDeCote: [string, string][] = [];
    const presentes = new Set<string>();
    for (const [, c] of cibles) if (await existe(c)) presentes.add(c);
    try {
      for (const [, c] of cibles)
        if (presentes.has(c)) {
          const bak = pyJoin(parentDe(c), `.${nomDe(c)}.bak-${randomBytes(4).toString("hex")}`);
          await rename(c, bak);
          miseDeCote.push([c, bak]);
        }
      for (const [arc, info] of garder) {
        const sortie = resoudre(pyJoin(racine, arc));
        if (!estSous(sortie, racine)) throw new SkillSaveError(`chemin d'extraction hors cible : ${arc}`);
        await mkdir(parentDe(sortie), { recursive: true });
        await writeFile(sortie, zf.lire(info));
      }
    } catch (e) {
      const deCote = new Set(miseDeCote.map(([c]) => c));
      for (const [, c] of cibles)
        if (!presentes.has(c) || deCote.has(c)) await rmtree(c, true).catch(() => undefined);
      for (const [c, bak] of miseDeCote) await rename(bak, c).catch(() => undefined);
      throw e;
    }
    for (const [, bak] of miseDeCote) await rmtree(bak, true);
  });
  log().info(`installed ${dossiersSkills.length} skill(s) (${source}) → ${reprPy(dossiersSkills)}`);
  invalidateSkillsScanCache();
  return dossiersSkills;
}
