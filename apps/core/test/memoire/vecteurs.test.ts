// SPDX-License-Identifier: MIT
/** apps/core/test/memoire/vecteurs.test.ts — mémoire Markdown rejouée sur les vecteurs Python (migration-kit/vecteurs/memoire.py), octets des fichiers compris. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  blocsCorrespondants,
  casefoldPy,
  ErreurPython,
  FlottantPy,
  nfcPy,
  pyJsonDumps,
  pyJsonLoads,
} from "@elpis/commun";

import { CTX } from "../../src/contexte/config-contexte";
import * as journalMemoire from "../../src/memoire/journal";
import type { Ecriture } from "../../src/memoire/journal";
import {
  computeEntryId,
  decouperReecriture,
  entryIds,
  MarkdownStore,
  normalizeForMatch,
  parseEntries,
  resolveTarget,
  sanitizeEntryText,
  serialize,
} from "../../src/memoire/magasin";
import type { StoreOpResult } from "../../src/memoire/magasin";
import { resolvePaths, safeUsername, scopeHash } from "../../src/memoire/portee";

type Etape = { op: unknown[]; fichier: string | null } & ({ resultat: unknown } | { erreur: string });

interface Vecteurs {
  parse: { brut: string; entrees: string[] }[];
  reecritures: { contenu: string; parties: string[] }[];
  serialisation: { entrees: string[]; texte: string }[];
  normalisation: { texte: string; norme: string }[];
  ids: { texte: string; longueur: number; id: string }[];
  listes_ids: { entrees: string[]; ids: string[] }[];
  assainissement: { texte: string; sain: string }[];
  cibles: ({ entries: string[]; cible: string } & Record<string, unknown>)[];
  blocs: { a: string; b: string; blocs: number[][] }[];
  scenarios: { limite: number; initial?: string | null; initial_octets?: string; etapes: Etape[] }[];
  rendus: { brut: string; limite: number; label: string; gabarit: string; rendu: string }[];
  journal_ecrit: {
    ajouts: Record<string, unknown>[];
    ops: (string | null)[];
    fichier: string;
    rogne: string;
    purge: boolean[];
  };
  journal_lu: {
    texte: string;
    records: unknown[];
    get: Record<string, unknown>;
    undone_by: Record<string, unknown>;
    diff: unknown[];
    origins: { store: string; entries: string[]; origins: unknown[] }[];
  };
  origines_illisibles: { after: string; erreur: string; message: string }[];
  portees: {
    username: string | null;
    scope: string | null;
    dossier: string;
    safe: string;
    chemins: string[];
  }[];
  hash_portees: Record<string, string>;
  empreintes: { casefold: string; nfc: string };
}

const V = pyJsonLoads(
  readFileSync(new URL("../vecteurs/memoire.json", import.meta.url), "utf-8"),
) as Vecteurs;
/** Classe Python → `type` d'`ErreurPython` (UnicodeEncodeError est une ValueError). */
const TYPES: Readonly<Record<string, string>> = { UnicodeEncodeError: "ValueError" };
const json = (x: unknown): string => pyJsonDumps(x);
const dossiers: string[] = [];

async function dossierTemporaire(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), "elpis-memoire-"));
  dossiers.push(d);
  return d;
}

afterAll(async () => {
  await Promise.all(dossiers.map((d) => rm(d, { recursive: true, force: true })));
});

async function octets(chemin: string): Promise<string | null> {
  try {
    return (await readFile(chemin)).toString("hex");
  } catch {
    return null;
  }
}

function appliquer(store: MarkdownStore, op: unknown[]): Promise<StoreOpResult> {
  const [nom, a, b] = op as [string, unknown, unknown];
  if (nom === "add") return store.add(a as string);
  if (nom === "replace") return store.replace(a as string, b as string);
  if (nom === "remove") return store.remove(a as string);
  if (nom === "rewrite") return store.rewrite(a as string);
  if (nom === "set_entries") return store.setEntries(a as unknown[]);
  if (nom === "restore") return store.restore(a as unknown[], b as unknown[]);
  throw new Error(`opération inconnue ${nom}`);
}

describe("magasin : découpage, ids, normalisation (vecteurs Python)", () => {
  it("découpe les documents comme parse_entries", () => {
    for (const c of V.parse) expect(parseEntries(c.brut), json(c.brut)).toEqual(c.entrees);
  });

  it("découpe les réécritures sur --- et §", () => {
    for (const c of V.reecritures) expect(decouperReecriture(c.contenu), json(c.contenu)).toEqual(c.parties);
  });

  it("sérialise les entrées", () => {
    for (const c of V.serialisation) expect(serialize(c.entrees)).toBe(c.texte);
  });

  it("normalise les cibles (NFC, casefold, blancs, ellipses)", () => {
    for (const c of V.normalisation) expect(normalizeForMatch(c.texte), json(c.texte)).toBe(c.norme);
  });

  it("calcule les ids et allonge les seules collisions", () => {
    for (const c of V.ids) expect(computeEntryId(c.texte, c.longueur), json(c)).toBe(c.id);
    for (const c of V.listes_ids) expect(entryIds(c.entrees), json(c.entrees)).toEqual(c.ids);
  });

  it("neutralise les lignes § nues", () => {
    for (const c of V.assainissement) expect(sanitizeEntryText(c.texte), json(c.texte)).toBe(c.sain);
  });

  it("résout les cibles (id, extrait, plus proche) au score près", () => {
    for (const { entries, cible, ...attendu } of V.cibles) {
      const r = resolveTarget(entries, cible);
      expect(json({ ...r, closest_score: new FlottantPy(r.closest_score) }), json([entries, cible])).toBe(
        json({
          index: attendu["index"],
          matched_by: attendu["matched_by"],
          candidates: attendu["candidates"],
          closest_index: attendu["closest_index"],
          closest_score: attendu["closest_score"],
        }),
      );
    }
  });

  it("rend les blocs communs de difflib", () => {
    for (const c of V.blocs)
      expect(blocsCorrespondants(Array.from(c.a), Array.from(c.b)), json(c)).toEqual(c.blocs);
  });
});

describe("magasin : scénarios d'écriture (résultats et octets du fichier)", () => {
  it.each(V.scenarios.map((s, i) => [i, s] as const))("scénario %i", async (_i, sc) => {
    const chemin = path.join(await dossierTemporaire(), "MEMORY.md");
    if (sc.initial !== null && sc.initial !== undefined) await writeFile(chemin, sc.initial, "utf8");
    if (sc.initial_octets) await writeFile(chemin, Buffer.from(sc.initial_octets, "hex"));
    const store = new MarkdownStore(chemin, sc.limite, { label: "MEMORY.md" });
    for (const etape of sc.etapes) {
      const contexte = json(etape.op);
      if ("erreur" in etape) {
        const levee: unknown = await appliquer(store, etape.op).then(
          () => null,
          (e: unknown) => e,
        );
        expect(levee, contexte).toBeInstanceOf(Error);
        expect((levee as ErreurPython).type, contexte).toBe(TYPES[etape.erreur] ?? etape.erreur);
      } else {
        expect(json(await appliquer(store, etape.op)), contexte).toBe(json(etape.resultat));
      }
      expect(await octets(chemin), contexte).toBe(etape.fichier);
    }
  });
});

describe("magasin : bloc du prompt système", () => {
  it("rend l'en-tête (gabarit compris) et les entrées préfixées", async () => {
    const espion = vi.spyOn(CTX, "override");
    try {
      for (const c of V.rendus) {
        espion.mockImplementation((chemin: string, defaut = "") =>
          chemin === "memory.header_template" ? c.gabarit : defaut,
        );
        const chemin = path.join(await dossierTemporaire(), c.label);
        if (c.brut) await writeFile(chemin, c.brut, "utf8");
        expect(await new MarkdownStore(chemin, c.limite, { label: c.label }).renderBlock(), json(c)).toBe(
          c.rendu,
        );
      }
    } finally {
      espion.mockRestore();
    }
  });
});

describe("journal (vecteurs Python)", () => {
  it("écrit les lignes JSONL, ignore les écritures sans effet, rogne et purge", async () => {
    const d = await dossierTemporaire();
    const horloges = [1759830000.0, 1759830000.5, 1759830001.25, 1e9 + 0.1];
    for (let i = 0; i < 300; i++) horloges.push(1759830100.0 + i);
    let n = 0;
    const remettre = journalMemoire.reglerJournalPourTests({
      horloge: () => horloges.shift() ?? Number.NaN,
      jeton: () => (++n).toString(16).padStart(8, "0"),
    });
    try {
      const ops: (string | null)[] = [];
      for (const a of V.journal_ecrit.ajouts)
        ops.push(await journalMemoire.append(d, a as unknown as Ecriture));
      expect(ops).toEqual(V.journal_ecrit.ops);
      expect(await readFile(journalMemoire.journalPath(d), "utf8")).toBe(V.journal_ecrit.fichier);
      for (let i = 0; i < 251; i++)
        await journalMemoire.append(d, { action: "add", store: "memory", before: [], after: [`n${i}`] });
      expect(await readFile(journalMemoire.journalPath(d), "utf8")).toBe(V.journal_ecrit.rogne);
      const purges = [
        await journalMemoire.purge(d),
        await journalMemoire.purge(d),
        await journalMemoire.purge(path.join(d, "absent")),
      ];
      expect(purges).toEqual(V.journal_ecrit.purge);
    } finally {
      remettre();
    }
  });

  it("relit, cherche, différencie et date les écritures", async () => {
    const d = await dossierTemporaire();
    const L = V.journal_lu;
    await writeFile(journalMemoire.journalPath(d), L.texte, "utf8");
    const recs = await journalMemoire.records(d);
    expect(json(recs)).toBe(json(L.records));
    for (const [op, attendu] of Object.entries(L.get))
      expect(json(await journalMemoire.get(d, op)), op).toBe(json(attendu));
    for (const [op, attendu] of Object.entries(L.undone_by))
      expect(json(await journalMemoire.undoneBy(d, op)), op).toBe(json(attendu));
    expect(json(recs.map((r) => journalMemoire.diff(r)))).toBe(json(L.diff));
    for (const o of L.origins)
      expect(json(await journalMemoire.origins(d, o.store, o.entries)), o.store).toBe(json(o.origins));
  });
});

describe("journal corrompu", () => {
  it("origins : un « after » numérique ou booléen lève TypeError comme Python", async () => {
    for (const c of V.origines_illisibles) {
      const d = await dossierTemporaire();
      const ligne = `{"op": "a1", "store": "memory", "before": [], "after": ${c.after}}\n`;
      await writeFile(journalMemoire.journalPath(d), ligne, "utf8");
      const levee: unknown = await journalMemoire.origins(d, "memory", ["x"]).then(
        () => null,
        (e: unknown) => e,
      );
      expect(levee, c.after).toBeInstanceOf(ErreurPython);
      expect([(levee as ErreurPython).type, (levee as Error).message], c.after).toEqual([
        c.erreur,
        c.message,
      ]);
    }
  });
});

describe("portées et chemins par compte", () => {
  it("résout les chemins et les noms sûrs comme pathlib", () => {
    for (const c of V.portees) {
      expect(safeUsername(c.username), json(c)).toBe(c.safe);
      expect(resolvePaths(c.username, c.scope, c.dossier), json(c)).toEqual(c.chemins);
    }
    for (const [portee, h] of Object.entries(V.hash_portees)) expect(scopeHash(portee)).toBe(h);
  });
});

describe("Unicode de Python 3.13 (tous les points de code)", () => {
  const empreinte = (f: (s: string) => string): string => {
    const valeurs: string[] = [];
    for (let c = 0; c < 0x110000; c++) if (c < 0xd800 || c > 0xdfff) valeurs.push(f(String.fromCodePoint(c)));
    return createHash("sha256").update(pyJsonDumps(valeurs), "ascii").digest("hex");
  };

  it("casefold", () => {
    expect(empreinte(casefoldPy)).toBe(V.empreintes.casefold);
  });

  it("NFC", () => {
    expect(empreinte(nfcPy)).toBe(V.empreintes.nfc);
  });
});
