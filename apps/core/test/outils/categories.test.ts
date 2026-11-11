// SPDX-License-Identifier: MIT
/** apps/core/test/outils/categories.test.ts — registre des catégories d'outils et traits : extraction, scénarios d'ingestion et de cache disque (vecteurs Python). */
import { DOSSIER_MOTEUR } from "../moteur-environnement";

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { comparePointsDeCode } from "@elpis/commun";

import { LLAMA_TOOL_SERIAL_PREFIXES } from "../../src/llm/constantes";
import {
  allToolNames,
  categorize,
  cheminCacheCategories,
  extractAnnotations,
  extractCategory,
  extractPolicy,
  getCategories,
  getHiddenCategories,
  getRegistry,
  getToolCategoriesDict,
  ingestTools,
  isHidden,
  normalizeDescriptor,
  registrySource,
  reinitialiserRegistre,
  toolInfo,
  toolPolicy,
  toolsDeniedFor,
} from "../../src/outils/categories";
import { installerManifesteMcp } from "../../src/outils/ports";
import { toolTraits } from "../../src/outils/traits";
import { decoder, lireVecteurs, rejouer } from "../vecteurs-moteur";
import type { Attendu } from "../vecteurs-moteur";

type Dict = Record<string, unknown>;
type Paire<T> = [T, Attendu];

interface Etat {
  etape:
    "initial" | ["ingest", unknown[], string | null] | ["cache", string] | ["manifeste", string[] | "leve"];
  retour?: Attendu;
  registre: Attendu;
  categories: Attendu;
  categories_toutes: Attendu;
  dict: Attendu;
  dict_visibles: Attendu;
  noms: Attendu;
  noms_visibles: Attendu;
  caches: Attendu;
  source: Attendu;
  categorize: Paire<string | null>[];
  is_hidden: Paire<string | null>[];
  policy: Paire<string | null>[];
  info: Paire<string | null>[];
  refuses: Paire<string | null>[];
  refuses_sans_repli: Attendu;
  traits: Paire<string | null>[];
  fichier: unknown;
}

interface Vecteurs {
  prefixes_seriels: string[];
  extractions: { outil: unknown; categorie: unknown; annotations: unknown; politique: unknown }[];
  descripteurs: { nom: string; expedie: Dict | null; descripteur: unknown }[];
  traits_objets: ({ nom: string; outil: unknown } & Attendu)[];
  scenarios: { nom: string; etapes: Etat[] }[];
}

const v = lireVecteurs<Vecteurs>("outils-categories");

afterEach(() => {
  installerManifesteMcp(null);
  vi.restoreAllMocks();
});

function trie(ensemble: Set<string>): string[] {
  return [...ensemble].sort(comparePointsDeCode);
}

function traits(nom: string | null, outil: unknown = null): Dict {
  const t = toolTraits(nom, outil);
  return { serial: t.serial, replay_safe: t.replaySafe, read_only: t.readOnly, mutates: t.mutates };
}

/** Le fichier de cache tel que `json.loads` le lit (NaN et ±Infinity compris), `"illisible"` sinon. */
function lireFichier(chemin: string): unknown {
  if (!existsSync(chemin)) return null;
  const texte = readFileSync(chemin, "utf-8")
    .replace(/-Infinity/g, '{"$flottant":"-inf"}')
    .replace(/Infinity/g, '{"$flottant":"inf"}')
    .replace(/NaN/g, '{"$flottant":"nan"}');
  try {
    return decoder(JSON.parse(texte));
  } catch {
    return "illisible";
  }
}

function verifier(etat: Etat, fichier: string, contexte: string): void {
  const c = (quoi: string): string => `${contexte} › ${quoi}`;
  rejouer(() => getRegistry(), etat.registre, c("registre"));
  rejouer(() => getCategories(), etat.categories, c("categories"));
  rejouer(() => getCategories(true), etat.categories_toutes, c("categories_toutes"));
  rejouer(() => getToolCategoriesDict(), etat.dict, c("dict"));
  rejouer(() => getToolCategoriesDict(false), etat.dict_visibles, c("dict_visibles"));
  rejouer(() => trie(allToolNames()), etat.noms, c("noms"));
  rejouer(() => trie(allToolNames(false)), etat.noms_visibles, c("noms_visibles"));
  rejouer(() => getHiddenCategories(), etat.caches, c("caches"));
  rejouer(() => registrySource(), etat.source, c("source"));
  for (const [n, a] of etat.categorize) rejouer(() => categorize(n), a, c(`categorize ${n}`));
  for (const [n, a] of etat.is_hidden) rejouer(() => isHidden(n), a, c(`is_hidden ${n}`));
  for (const [n, a] of etat.policy) rejouer(() => toolPolicy(n), a, c(`policy ${n}`));
  for (const [n, a] of etat.info) rejouer(() => toolInfo(n), a, c(`info ${n}`));
  for (const [r, a] of etat.refuses)
    rejouer(() => trie(toolsDeniedFor(r, ["ask_user", "repli"])), a, c(`refuses ${r}`));
  rejouer(() => trie(toolsDeniedFor("subagent")), etat.refuses_sans_repli, c("refuses sans repli"));
  for (const [n, a] of etat.traits) rejouer(() => traits(n), a, c(`traits ${n}`));
  const attendu = etat.fichier === "= registre" ? getRegistry() : decoder(etat.fichier);
  expect(lireFichier(fichier), c("fichier")).toEqual(attendu);
}

describe("vecteurs Python de llm_core/_mcp_categories.py et _tool_traits.py", () => {
  it("préfixes sériels par défaut identiques", () => {
    expect(LLAMA_TOOL_SERIAL_PREFIXES).toEqual(v.prefixes_seriels);
  });

  it("extraction de catégorie, d'annotations et de politique", () => {
    for (const e of v.extractions) {
      const contexte = JSON.stringify(e.outil);
      expect(extractCategory(e.outil), contexte).toEqual(decoder(e.categorie));
      expect(extractAnnotations(e.outil), contexte).toEqual(decoder(e.annotations));
      expect(extractPolicy(e.outil), contexte).toEqual(decoder(e.politique));
    }
  });

  it("descripteurs canoniques", () => {
    for (const d of v.descripteurs) expect(normalizeDescriptor(d.nom, d.expedie)).toEqual(d.descripteur);
  });

  it("traits d'un objet de list_tools()", () => {
    reinitialiserRegistre({ cheminCache: path.join(DOSSIER_MOTEUR, "traits", "cache.json") });
    for (const t of v.traits_objets) rejouer(() => traits(t.nom, t.outil), t, JSON.stringify(t.outil));
  });

  for (const scenario of v.scenarios) {
    it(`scénario ${scenario.nom}`, () => {
      const fichier = path.join(DOSSIER_MOTEUR, scenario.nom, "user_db", ".tool_categories_cache.json");
      reinitialiserRegistre({ cheminCache: fichier });
      installerManifesteMcp({ defaultOnCategories: () => [] });
      for (const etat of scenario.etapes) {
        const etape = etat.etape;
        if (etape !== "initial" && etape[0] === "ingest") {
          const retour = ingestTools(etape[1], etape[2]);
          expect(retour, `${scenario.nom} › retour`).toEqual(
            decoder((etat.retour as { valeur: unknown }).valeur),
          );
        } else if (etape !== "initial" && etape[0] === "cache") {
          mkdirSync(path.dirname(fichier), { recursive: true });
          writeFileSync(fichier, etape[1], "utf-8");
          reinitialiserRegistre();
        } else if (etape !== "initial") {
          const actives = etape[1];
          installerManifesteMcp({
            defaultOnCategories: () => {
              if (actives === "leve") throw new Error("mcp.json illisible");
              return actives;
            },
          });
        }
        verifier(etat, fichier, `${scenario.nom} › ${JSON.stringify(etape).slice(0, 60)}`);
      }
    });
  }
});

describe("cache disque partagé avec l'admin", () => {
  const outil = (nom: string, cat: string): Dict => ({ name: nom, meta: { category: { name: cat } } });

  it("écrit un JSON complet par renommage, sans temporaire laissé", () => {
    const dossier = path.join(DOSSIER_MOTEUR, "ecriture");
    reinitialiserRegistre({ cheminCache: path.join(dossier, "sous", "cache.json") });
    for (let i = 0; i < 20; i++) ingestTools([outil(`a${i}`, "fs"), outil(`b${i}`, "git")], `s${i % 3}`);
    expect(cheminCacheCategories()).toBe(path.join(dossier, "sous", "cache.json"));
    expect(readdirSync(path.join(dossier, "sous"))).toEqual(["cache.json"]);
    expect(JSON.parse(readFileSync(cheminCacheCategories(), "utf-8")).source).toBe("live");
  });

  it("un process sans pool lit le cache d'un autre, mémorisé 5 s", () => {
    const fichier = path.join(DOSSIER_MOTEUR, "ttl", "cache.json");
    reinitialiserRegistre({ cheminCache: fichier });
    ingestTools([outil("x", "fs")]);
    reinitialiserRegistre();
    let maintenant = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => maintenant);
    expect(categorize("x")).toBe("fs");
    writeFileSync(fichier, JSON.stringify({ descriptors: {}, tool_to_category: { x: "git" } }));
    maintenant += 4_999;
    expect(categorize("x")).toBe("fs");
    maintenant += 2;
    expect(categorize("x")).toBe("git");
  });

  it("un fichier de cache illisible ou absent laisse un registre vide (« inconnu »)", () => {
    const fichier = path.join(DOSSIER_MOTEUR, "illisible", "cache.json");
    mkdirSync(path.dirname(fichier), { recursive: true });
    writeFileSync(fichier, "{tronqué");
    reinitialiserRegistre({ cheminCache: fichier });
    expect(registrySource()).toBe("empty");
    expect(getToolCategoriesDict()).toEqual({});
    expect(toolsDeniedFor("subagent", ["ask_user"])).toEqual(new Set(["ask_user"]));
  });
});

describe("catégorie servie par deux services intégrés (écart au Python)", () => {
  const outil = (nom: string, cat: string): Dict => ({ name: nom, meta: { category: { name: cat } } });

  it("skill (familles du compte) et skill_run (hôte d'outils) : les outils des deux restent listés, quel que soit l'ordre", () => {
    for (const ordre of [
      ["elpis-skill", "elpis-skill-run"],
      ["elpis-skill-run", "elpis-skill"],
    ]) {
      reinitialiserRegistre({ cheminCache: path.join(DOSSIER_MOTEUR, "deux-sources", "cache.json") });
      const lots: Record<string, Dict[]> = {
        "elpis-skill": [outil("skill_save", "skill"), outil("ask_user", "skill")],
        "elpis-skill-run": [outil("skill_run_script", "skill"), outil("read_file", "fs")],
      };
      for (const source of ordre) ingestTools(lots[source], source);
      const outils = new Set(getToolCategoriesDict()["skill"]);
      expect(outils, ordre.join(" puis ")).toEqual(new Set(["skill_save", "ask_user", "skill_run_script"]));
      expect(getCategories().find((c) => c.name === "skill")?.tools.length, ordre.join(" puis ")).toBe(3);
    }
  });

  it("un service qui se relit remplace sa seule part de la catégorie", () => {
    reinitialiserRegistre({ cheminCache: path.join(DOSSIER_MOTEUR, "deux-sources-relu", "cache.json") });
    ingestTools([outil("skill_save", "skill"), outil("ask_user", "skill")], "elpis-skill");
    ingestTools([outil("skill_run_script", "skill")], "elpis-skill-run");
    ingestTools([outil("skill_save", "skill")], "elpis-skill");
    expect(getToolCategoriesDict()["skill"]).toEqual(["skill_save", "skill_run_script"]);
  });
});
