// SPDX-License-Identifier: MIT
/** apps/core/test/skills/bibliotheque.test.ts — bibliothèque de skills rejouée sur les vecteurs Python (migration-kit/vecteurs/skills_bibliotheque.py). */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type FsPromises = typeof import("node:fs/promises"); // eslint-disable-line @typescript-eslint/consistent-type-imports
const echecRename = vi.hoisted(() => ({ motif: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const reel = await importOriginal<FsPromises>();
  const rename: typeof reel.rename = async (de, vers) => {
    if (echecRename.motif && String(de).endsWith(echecRename.motif)) throw new Error("ENOSPC simulé");
    return reel.rename(de, vers);
  };
  return { ...reel, default: { ...reel, rename }, rename };
});

import {
  ArchiveZip,
  ecrireZip,
  ErreurPython,
  FlottantPy as FlottantJson,
  pyJsonDumps,
  pyJsonLoads,
} from "@elpis/commun";
import type { EntreeZipEcrite } from "@elpis/commun";

import {
  addUserSkillFile,
  assainirTags,
  avecVerrouEcriture,
  deleteGlobalSkill,
  deleteLearnedSkill,
  deleteUserSkill,
  discoverSkills,
  discoverSkillsBySource,
  ensureUserSkillsStore,
  exportSkillZip,
  findGlobalEntry,
  findLearnedEntry,
  findUserEntry,
  findUserSkillDir,
  installSkillZip,
  invalidateSkillsScanCache,
  matchSkills,
  parseTags,
  preparerChamps,
  promoteLearnedSkill,
  rendreFrontmatter,
  rendreSkillMd,
  resumeSkill,
  saveGlobalSkill,
  saveLearnedSkill,
  saveUserSkill,
  SCAN_CACHE_TTL_S,
  SKILL_FILE_MAX_BYTES,
  SKILL_ZIP_MAX_BYTES,
  SKILL_ZIP_MAX_FILES,
  SKILL_ZIP_MAX_UNCOMPRESSED,
  SkillSaveError,
  slugFromSkillMd,
  slugifyName,
  stripAccents,
  syncUserSkillsMirror,
  tokenize,
  uneLigne,
} from "../../src/skills/bibliotheque";
import type { SkillSpec } from "../../src/skills/bibliotheque";
import { pyJoin } from "../../src/skills/chemins";
import { FlottantPy as FlottantFrontmatter } from "../../src/skills/frontmatter";
import type { Frontmatter } from "../../src/skills/frontmatter";
import { VERROU_DELAI_S } from "../../src/skills/verrou";
import { ecrireArbre, empreinteArbre, poserEnv, relatif } from "./arbre";
import type { ContenuArbre } from "./arbre";

type Issue = { valeur: unknown } | { erreur: string; message: string };
type Etape = { op: unknown[]; arbre: string[][] } & Issue;

interface Vecteurs {
  arbre: Record<string, ContenuArbre>;
  decouverte: Record<string, unknown>;
  recherches: Record<string, unknown>[];
  matching: { requete: string; top_n: number; min_score: number; ids: string[] }[];
  slugs: { texte: string; slug: string }[];
  jetons: { texte: string; jetons: string[]; sans_accents: string }[];
  une_ligne: { entree: unknown; sortie: string }[];
  tags: { entree: unknown; parse: string[]; assainis: string[] }[];
  preparer: ({ entree: unknown[] } & Issue)[];
  frontmatters: { entree: unknown; rendu: string }[];
  skill_md: { entree: unknown[]; rendu: string }[];
  slug_skill_md: { octets: string; slug: string }[];
  scenarios: { ops: unknown[][]; etapes: Etape[] }[];
  zips: ({ nom: string; zip: string; options: Record<string, boolean>; arbre: string[][] } & Issue)[];
  exports: { id: string; entrees: Record<string, unknown>[] }[];
  empreinte_sans_accents: string;
  constantes: Record<string, unknown>;
}

const V = pyJsonLoads(
  readFileSync(new URL("../vecteurs/skills-bibliotheque.json", import.meta.url), "utf-8"),
) as Vecteurs;
const json = (x: unknown): string => pyJsonDumps(x);
const nombre = (v: unknown): number => (v instanceof FlottantJson ? v.valeur : Number(v));
const dossiers: string[] = [];
let remettreEnv: () => void = () => undefined;

async function nouvelleRacine(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), "elpis-skills-"));
  dossiers.push(d);
  return d;
}

/** Racine globale et verrou hors de l'arbre, comme `_Env` du générateur. */
function environnement(racine: string): void {
  remettreEnv();
  remettreEnv = poserEnv({
    APP_SKILLS_DIR: pyJoin(racine, "global"),
    SKILLS_LOCK_PATH: `${racine}.skills_write.lock`,
  });
  invalidateSkillsScanCache();
}

beforeAll(() => {
  remettreEnv = poserEnv({ SKILLS_FILELOCK: "1" });
});

afterAll(async () => {
  remettreEnv();
  invalidateSkillsScanCache();
  await Promise.all(dossiers.map((d) => rm(d, { recursive: true, force: true })));
});

/** Valeur de frontmatter des vecteurs (`$dict` en Map, `$float` en flottant du parseur). */
function decoderFm(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decoderFm);
  if (v instanceof FlottantJson) return new FlottantFrontmatter(v.valeur);
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if ("$dict" in o) return new Map((o["$dict"] as [string, unknown][]).map(([k, x]) => [k, decoderFm(x)]));
    if ("$float" in o) return new FlottantFrontmatter(Number(o["$float"]));
  }
  return v;
}

function nomErreur(e: unknown): string {
  if (e instanceof ErreurPython) return e.type;
  return e instanceof Error ? e.name : String(e);
}

async function issue(f: () => Promise<unknown>, racine: string | null): Promise<Issue> {
  try {
    const v = await f();
    return { valeur: racine === null ? v : relatif(v, racine) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      erreur: nomErreur(e),
      message: racine === null ? message : (relatif(message, racine) as string),
    };
  }
}

function resumes(specs: readonly SkillSpec[], racine: string): unknown[] {
  return specs.map((s) => relatif(resumeSkill(s), racine));
}

describe("découverte, recherche et matching (vecteurs Python)", () => {
  let racine = "";

  beforeAll(async () => {
    racine = await nouvelleRacine();
    await ecrireArbre(racine, V.arbre);
  });

  it("découvre et résume les skills comme discover_skills", async () => {
    environnement(racine);
    const user = pyJoin(racine, "user_skills/alice");
    const obtenu = {
      tout: resumes(await discoverSkills(null), racine),
      avec_user: resumes(await discoverSkills(user), racine),
      sans_learned: resumes(await discoverSkills(user, { includeLearned: false }), racine),
      global: resumes(await discoverSkillsBySource("global"), racine),
      learned: resumes(await discoverSkillsBySource("learned"), racine),
      user: resumes(await discoverSkillsBySource("user", user), racine),
      user_sans_dossier: resumes(await discoverSkillsBySource("user", null), racine),
      source_invalide: await issue(() => discoverSkillsBySource("autre"), racine),
      user_absent: resumes(await discoverSkills(pyJoin(racine, "user_skills/absent")), racine),
    };
    for (const [cle, attendu] of Object.entries(V.decouverte))
      expect(json(obtenu[cle as keyof typeof obtenu]), cle).toBe(json(attendu));
  });

  it("retrouve les entrées par id, nom ou slug", async () => {
    environnement(racine);
    const user = pyJoin(racine, "user_skills/alice");
    for (const r of V.recherches) {
      const ident = r["ident"] as string;
      const forme = (s: SkillSpec | null): unknown => (s === null ? null : [s.id, relatif(s.path, racine)]);
      const obtenu = {
        ident,
        global: forme(await findGlobalEntry(ident)),
        learned: forme(await findLearnedEntry(ident)),
        user: forme(await findUserEntry(user, ident)),
      };
      expect(json(obtenu), ident).toBe(json(r));
    }
  });

  it("classe les skills pertinents comme match_skills", async () => {
    environnement(racine);
    const specs = await discoverSkills(pyJoin(racine, "user_skills/alice"));
    for (const c of V.matching) {
      const ids = matchSkills(c.requete, specs, { topN: nombre(c.top_n), minScore: nombre(c.min_score) }).map(
        (s) => s.id,
      );
      expect(ids, json([c.requete, c.top_n, c.min_score])).toEqual(c.ids);
    }
  });
});

describe("slugs, jetons et rendus (vecteurs Python)", () => {
  it("slugify_name, _tokenize et _strip_accents", () => {
    for (const c of V.slugs) expect(slugifyName(c.texte), json(c.texte)).toBe(c.slug);
    for (const c of V.jetons) {
      expect(tokenize(c.texte), json(c.texte)).toEqual(c.jetons);
      expect(stripAccents(c.texte), json(c.texte)).toBe(c.sans_accents);
    }
  });

  it("_one_line, _parse_tags, _sanitize_tags et _prepare_fields", async () => {
    for (const c of V.une_ligne) expect(uneLigne(decoderFm(c.entree)), json(c.entree)).toBe(c.sortie);
    for (const c of V.tags) {
      expect(parseTags(c.entree), json(c.entree)).toEqual(c.parse);
      expect(assainirTags(c.entree), json(c.entree)).toEqual(c.assainis);
    }
    for (const c of V.preparer) {
      const [n, d, b, t] = c.entree as [string, string, string, unknown];
      const { entree: _e, ...attendu } = c;
      expect(json(await issue(async () => preparerChamps(n, d, b, t), null)), json(c.entree)).toBe(
        json(attendu),
      );
    }
  });

  it("_render_frontmatter, _render_skill_md et _slug_from_skill_md", () => {
    for (const c of V.frontmatters)
      expect(rendreFrontmatter(decoderFm(c.entree) as Frontmatter), json(c.entree)).toBe(c.rendu);
    for (const c of V.skill_md) {
      const [slug, d, b, t, dom] = c.entree as [string, string, string, unknown, string];
      expect(rendreSkillMd(slug, d, b, t, dom), json(c.entree)).toBe(c.rendu);
    }
    for (const c of V.slug_skill_md)
      expect(slugFromSkillMd(Buffer.from(c.octets, "hex")), c.octets).toBe(c.slug);
  });

  it("NFKD sans marques combinantes sur tous les points de code (Unicode 15.1)", () => {
    const valeurs: string[] = [];
    for (let c = 0; c < 0x110000; c++)
      if (c < 0xd800 || c > 0xdfff) valeurs.push(stripAccents(String.fromCodePoint(c)));
    expect(createHash("sha256").update(pyJsonDumps(valeurs), "ascii").digest("hex")).toBe(
      V.empreinte_sans_accents,
    );
  });

  it("constantes", () => {
    expect([
      SKILL_ZIP_MAX_BYTES,
      SKILL_ZIP_MAX_UNCOMPRESSED,
      SKILL_ZIP_MAX_FILES,
      SKILL_FILE_MAX_BYTES,
      SCAN_CACHE_TTL_S,
      VERROU_DELAI_S,
    ]).toEqual(Object.values(V.constantes).map(nombre));
  });
});

/** Opération d'un scénario du générateur, chemins relatifs à `racine`. */
function operation(op: unknown[], racine: string): () => Promise<unknown> {
  const [nom, ...a] = op as [string, ...unknown[]];
  const chemin = (r: unknown): string | null => (r === null ? null : pyJoin(racine, r as string));
  const s = (i: number): string => a[i] as string;
  const o = (i: number): string | null => a[i] as string | null;
  switch (nom) {
    case "save_user":
      return () => saveUserSkill(chemin(a[0]) ?? "", s(1), s(2), s(3), a[4], o(5), { prevName: o(6) });
    case "save_global":
      return () => saveGlobalSkill(s(0), s(1), s(2), a[3], o(4), { prevName: o(5) });
    case "save_learned":
      return () => saveLearnedSkill(s(0), s(1), s(2), a[3], o(4), { prevName: o(5) });
    case "promote":
      return () => promoteLearnedSkill(s(0));
    case "delete_user":
      return () => deleteUserSkill(chemin(a[0]) ?? "", s(1));
    case "delete_learned":
      return () => deleteLearnedSkill(s(0));
    case "delete_global":
      return () => deleteGlobalSkill(s(0));
    case "add_file":
      return () => addUserSkillFile(chemin(a[0]) ?? "", s(1), s(2), s(3));
    case "find_dir":
      return () => findUserSkillDir(chemin(a[0]) ?? "", a[1]);
    case "ensure_store":
      return () => ensureUserSkillsStore(chemin(a[0]) ?? "", chemin(a[1]));
    case "sync_mirror":
      return () => syncUserSkillsMirror(chemin(a[0]), chemin(a[1]));
    default:
      throw new Error(`opération inconnue ${nom}`);
  }
}

describe("écritures (résultats et arbre après chaque opération)", () => {
  it.each(V.scenarios.map((sc, i) => [i, sc] as const))(
    "scénario %i",
    { timeout: 120_000 },
    async (_i, sc) => {
      const racine = await nouvelleRacine();
      await ecrireArbre(racine, V.arbre);
      environnement(racine);
      for (const etape of sc.etapes) {
        const { op, arbre, ...attendu } = etape;
        expect(json(await issue(operation(op, racine), racine)), json(op)).toBe(json(attendu));
        expect(await empreinteArbre(racine), json(op)).toEqual(arbre);
        invalidateSkillsScanCache();
      }
    },
  );
});

describe("renommage vers un slug déjà pris ailleurs", () => {
  it("refuse sans toucher au skill-dossier qui porte déjà ce slug", async () => {
    const racine = await nouvelleRacine();
    environnement(racine);
    const global = pyJoin(racine, "global");
    await mkdir(pyJoin(global, "pack/deploy/scripts"), { recursive: true });
    await writeFile(pyJoin(global, "pack/deploy/SKILL.md"), "---\nname: deploy\ndescription: d\n---\nb\n");
    await writeFile(pyJoin(global, "pack/deploy/scripts/run.sh"), "echo ok\n");
    await mkdir(pyJoin(global, "foo"));
    await writeFile(pyJoin(global, "foo/SKILL.md"), "---\nname: foo\ndescription: f\n---\nb\n");
    invalidateSkillsScanCache();
    await expect(saveGlobalSkill("deploy", "f", "b", [], null, { prevName: "foo" })).rejects.toThrow(
      SkillSaveError,
    );
    expect(readFileSync(pyJoin(global, "pack/deploy/scripts/run.sh"), "utf-8")).toBe("echo ok\n");
    expect(readFileSync(pyJoin(global, "foo/SKILL.md"), "utf-8")).toContain("name: foo");
  });
});

/** Skill écrit directement sur le disque, comme par un autre processus. */
async function ecritAilleurs(dossier: string, rel: string): Promise<string> {
  const d = pyJoin(dossier, rel);
  await mkdir(d, { recursive: true });
  const nom = rel.slice(rel.lastIndexOf("/") + 1);
  await writeFile(
    pyJoin(d, "SKILL.md"),
    `---\nname: ${nom}\ndescription: écrit par un autre processus\n---\nb\n`,
  );
  return d;
}

describe("sous le verrou d'écriture, l'inventaire vient du disque (51dd654)", () => {
  let racine = "";
  let globale = "";

  beforeAll(async () => {
    racine = await nouvelleRacine();
  });

  async function cacheChaud(): Promise<void> {
    environnement(racine);
    await rm(pyJoin(racine, "global"), { recursive: true, force: true });
    globale = pyJoin(racine, "global");
    await mkdir(pyJoin(globale, "learned"), { recursive: true });
    expect(await discoverSkillsBySource("global")).toEqual([]);
    expect(await discoverSkillsBySource("learned")).toEqual([]);
  }

  it("un brouillon learned voit un global écrit par un autre processus", async () => {
    await cacheChaud();
    await ecritAilleurs(globale, "outils/bilan");
    await expect(saveLearnedSkill("bilan", "d", "b")).rejects.toThrow(SkillSaveError);
    await expect(stat(pyJoin(globale, "learned/bilan"))).rejects.toThrow();
  });

  it("la promotion relit les deux inventaires", async () => {
    await cacheChaud();
    await ecritAilleurs(pyJoin(globale, "learned"), "bilan");
    await ecritAilleurs(globale, "outils/bilan");
    await expect(promoteLearnedSkill("bilan")).rejects.toThrow(/existe déjà/u);
    await ecritAilleurs(pyJoin(globale, "learned"), "resume");
    expect(await promoteLearnedSkill("resume")).toBe(pyJoin(globale, "resume"));
    expect((await stat(pyJoin(globale, "resume/SKILL.md"))).isFile()).toBe(true);
  });

  it("la suppression d'un id qualifié voit un sous-skill écrit par un autre processus", async () => {
    await cacheChaud();
    const d = await ecritAilleurs(globale, "outils/bilan");
    await ecritAilleurs(d, "detail");
    expect(await deleteGlobalSkill("bilan/detail")).toBe(true);
    await expect(stat(pyJoin(d, "detail"))).rejects.toThrow();
  });

  it("hors verrou et dans les autres contextes, le cache sert ; le scan sous verrou ne le remplit pas", async () => {
    await cacheChaud();
    await ecritAilleurs(globale, "bilan");
    expect(await discoverSkillsBySource("global")).toEqual([]);
    let signaler: () => void = () => undefined;
    let liberer: () => void = () => undefined;
    const dedans = new Promise<void>((r) => (signaler = r));
    const tenu = new Promise<void>((r) => (liberer = r));
    const pendant = avecVerrouEcriture(async () => {
      const ici = await discoverSkillsBySource("global");
      signaler();
      await tenu;
      return ici;
    });
    await dedans;
    expect(await discoverSkillsBySource("global")).toEqual([]);
    liberer();
    expect((await pendant).map((s) => s.id)).toEqual(["bilan"]);
    expect(await discoverSkillsBySource("global")).toEqual([]);
  });

  it("hiérarchie profonde : parent = ancêtre le plus proche, .md internes écartés", async () => {
    await cacheChaud();
    const a = await ecritAilleurs(globale, "dom/a");
    const b = await ecritAilleurs(a, "b");
    await ecritAilleurs(b, "c");
    await ecritAilleurs(pyJoin(a, "z"), "d");
    await writeFile(pyJoin(b, "interne.md"), "---\nname: interne\ndescription: x\n---\nb\n");
    await writeFile(pyJoin(globale, "dom/legacy.md"), "---\nname: legacy\ndescription: x\n---\nb\n");
    invalidateSkillsScanCache();
    const ids = (await discoverSkillsBySource("global")).map((s) => [s.id, s.parentId, s.depth]);
    expect(ids.sort()).toEqual([
      ["a", null, 0],
      ["a/b", "a", 1],
      ["a/b/c", "a/b", 2],
      ["a/d", "a", 1],
      ["legacy", null, 0],
    ]);
  });
});

describe("import .zip", () => {
  it.each(V.zips.map((z) => [z.nom, z] as const))("%s", async (_nom, z) => {
    const racine = await nouvelleRacine();
    const dest = pyJoin(racine, "import");
    await mkdir(dest);
    await mkdir(pyJoin(racine, "ailleurs"));
    if (z.nom.startsWith("existant")) {
      await mkdir(pyJoin(dest, "existe"));
      await writeFile(pyJoin(dest, "existe/ancien.txt"), "ancien");
    }
    if (z.nom === "lien_hors") await symlink("../ailleurs", pyJoin(dest, "evasion"));
    environnement(racine);
    const { nom: _n, zip, options, arbre, ...attendu } = z;
    const obtenu = await issue(
      () => installSkillZip(Buffer.from(zip, "base64"), dest, { source: "global", ...options }),
      racine,
    );
    expect(json(obtenu)).toBe(json(attendu));
    expect(await empreinteArbre(racine)).toEqual(arbre);
  });
});

describe("import .zip en écrasement", () => {
  it("une extraction qui échoue laisse l'ancien skill intact", async () => {
    const racine = await nouvelleRacine();
    const dest = pyJoin(racine, "import");
    await mkdir(pyJoin(dest, "a"), { recursive: true });
    await writeFile(pyJoin(dest, "a/ancien.txt"), "ancien");
    environnement(racine);
    const entree = (nom: string): EntreeZipEcrite => ({
      nom,
      donnees: Buffer.from("---\nname: a\ndescription: d\n---\nb\n"),
      dateHeure: [2026, 1, 1, 0, 0, 0],
      attributsExternes: (0o600 << 16) >>> 0,
    });
    const zip = ecrireZip([entree("a/SKILL.md"), entree("a/SKILL.md/x")]);
    await expect(installSkillZip(zip, dest, { source: "global", overwrite: true })).rejects.toThrow();
    expect(readFileSync(pyJoin(dest, "a/ancien.txt"), "utf-8")).toBe("ancien");
    expect(readdirSync(dest)).toEqual(["a"]);
  });
});

describe("import .zip en écrasement, mise de côté en échec", () => {
  it("une cible pas encore mise de côté reste intacte quand une mise de côté échoue", async () => {
    const racine = await nouvelleRacine();
    const dest = pyJoin(racine, "import");
    for (const n of ["a", "b", "c"]) {
      await mkdir(pyJoin(dest, n), { recursive: true });
      await writeFile(pyJoin(dest, `${n}/ancien.txt`), n);
    }
    environnement(racine);
    const entree = (nom: string): EntreeZipEcrite => ({
      nom,
      donnees: Buffer.from(`---\nname: ${nom[0]}\ndescription: d\n---\nb\n`),
      dateHeure: [2026, 1, 1, 0, 0, 0],
      attributsExternes: (0o600 << 16) >>> 0,
    });
    const zip = ecrireZip(["a", "b", "c"].map((n) => entree(`${n}/SKILL.md`)));
    echecRename.motif = "/import/b";
    try {
      await expect(installSkillZip(zip, dest, { source: "global", overwrite: true })).rejects.toThrow();
    } finally {
      echecRename.motif = "";
    }
    expect(readFileSync(pyJoin(dest, "a/ancien.txt"), "utf-8")).toBe("a");
    expect(readFileSync(pyJoin(dest, "b/ancien.txt"), "utf-8")).toBe("b");
    expect(readFileSync(pyJoin(dest, "c/ancien.txt"), "utf-8")).toBe("c");
    expect(readdirSync(dest).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("export .zip (relu comme zipfile)", () => {
  it("en-têtes, contenus, attributs et dates (UTC) des membres", async () => {
    const remettreTz = poserEnv({ TZ: "UTC" });
    try {
      const racine = await nouvelleRacine();
      await ecrireArbre(racine, V.arbre);
      const fichiers = Object.keys(V.arbre).filter(
        (r) => r.startsWith("global/") && typeof V.arbre[r] !== "object" && V.arbre[r] !== "<dir>",
      );
      for (const r of [
        ...fichiers,
        ...Object.keys(V.arbre).filter(
          (k) => typeof V.arbre[k] === "object" && "hex" in (V.arbre[k] as object),
        ),
      ]) {
        const p = pyJoin(racine, r);
        await chmod(p, r.endsWith(".sh") ? 0o755 : 0o644);
        await utimes(p, 1767323046, 1767323046);
      }
      environnement(racine);
      const specs = new Map((await discoverSkills(null)).map((s) => [s.id, s]));
      for (const ex of V.exports) {
        const spec = specs.get(ex.id);
        expect(spec, ex.id).toBeDefined();
        if (spec === undefined) continue;
        const zf = new ArchiveZip(await exportSkillZip(spec));
        const liste = zf.membres.map((m) => ({
          nom: m.nom,
          donnees: zf.lire(m).toString("hex"),
          methode: m.methode,
          drapeaux: m.drapeaux,
          attributs: m.attributsExternes,
          systeme: m.systemeCreation,
          version: m.versionCreation,
          extraction: m.versionExtraction,
          date: spec.skillDir === null ? null : m.dateHeure,
        }));
        expect(json(liste), ex.id).toBe(json(ex.entrees));
      }
    } finally {
      remettreTz();
    }
  });

  it("relit les archives produites par zipfile (tous les imports des vecteurs)", () => {
    for (const z of V.zips) {
      let zf: ArchiveZip;
      try {
        zf = new ArchiveZip(Buffer.from(z.zip, "base64"));
      } catch {
        continue;
      }
      for (const m of zf.membres) {
        const lu = zf.lire(m);
        if (z.nom !== "taille_declaree") expect(lu.length, `${z.nom}:${m.nom}`).toBe(m.taille);
      }
    }
  });
});
