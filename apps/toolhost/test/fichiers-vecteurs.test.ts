// SPDX-License-Identifier: MIT
/** apps/toolhost/test/fichiers-vecteurs.test.ts — vecteurs du vrai Python (migration-kit/vecteurs/toolhost_fichiers.py) : remplacement (re.subn et gabarits), champ, chemins, tailles, arbre, conflits de sauvegarde, aperçus de recherche, archives tar, envois par morceaux. */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { HttpError, pyJsonDumps } from "@elpis/commun";
import { describe, expect, it } from "vitest";

import { arbre } from "../src/fichiers/commun";
import { conflictDetail, fmtOctets, saveConflict, uploadTmpRel } from "../src/fichiers/ecriture";
import type { Etat } from "../src/fichiers/aides";
import { apercuRecherche, nomDe, suffixeDe } from "../src/fichiers/lecture";
import {
  dansLeChamp,
  posix,
  preparerRemplaceur,
  remplacement,
  remplacerDansTexte,
} from "../src/fichiers/remplacement";
import { ArchiveTropGrosse, ErreurTar, extraireTarBorne } from "../src/fichiers/tar";

type Dict = Record<string, unknown>;
const V = JSON.parse(readFileSync(new URL("./vecteurs/fichiers.json", import.meta.url), "utf-8")) as Record<
  string,
  Dict[]
>;

/** Motifs valides en Python que la traduction RegExp ne rend pas à l'identique (écarts consignés). */
const ECARTS_MOTIFS = new Set<string>();

const json = (x: unknown): unknown => JSON.parse(pyJsonDumps(x));

describe("remplacement : re.subn de Python", () => {
  it(`${V["remplacements"]!.length} cas : même texte, même nombre, mêmes échantillons, mêmes refus`, () => {
    const ecarts: string[] = [];
    for (const c of V["remplacements"]!) {
      const spec = {
        query: c["query"] as string,
        replacement: c["replacement"] as string,
        regex: c["regex"] as boolean,
        caseSensitive: c["case_sensitive"] as boolean,
      };
      if (ECARTS_MOTIFS.has(spec.query)) continue;
      const ctx = JSON.stringify([spec, c["texte"]]);
      const r = preparerRemplaceur(spec);
      if (c["erreur"] === null) {
        if ("erreur" in r) ecarts.push(`${ctx} : refusé (${r.erreur})`);
        continue;
      }
      if (c["erreur"] !== undefined) {
        if (!("erreur" in r)) {
          ecarts.push(`${ctx} : refus attendu ${String(c["erreur"])}`);
          continue;
        }
        if (r.erreur !== c["erreur"]) ecarts.push(`${ctx} : ${r.erreur} ≠ ${String(c["erreur"])}`);
        continue;
      }
      if ("erreur" in r) {
        ecarts.push(`${ctx} : refusé (${r.erreur})`);
        continue;
      }
      const [nouveau, n, echantillons] = remplacerDansTexte(c["texte"] as string, r);
      if (
        nouveau !== c["nouveau"] ||
        n !== c["n"] ||
        JSON.stringify(echantillons) !== JSON.stringify(c["echantillons"])
      )
        ecarts.push(
          `${ctx} : ${JSON.stringify([nouveau, n, echantillons])} ≠ ${JSON.stringify([c["nouveau"], c["n"], c["echantillons"]])}`,
        );
    }
    expect(ecarts).toEqual([]);
  });

  it("_remplacement : binaire, UTF-8 invalide, BOM, liens et fichiers spéciaux", () => {
    const r = preparerRemplaceur({ query: "a", replacement: "A", regex: false, caseSensitive: false });
    if ("erreur" in r) throw new Error(r.erreur);
    for (const c of V["fichiers_remplaces"]!) {
      const entree = (c["entree"] as { kind: unknown; link?: unknown } | undefined) ?? { kind: "file" };
      const brut =
        c["b64"] === undefined && c["brut"] === undefined ? null : Buffer.from(String(c["brut"]), "base64");
      const res = remplacement(entree, brut, r);
      const rendu =
        res !== null && typeof res === "object"
          ? { nouveau: res.nouveau, n: res.n, echantillons: res.echantillons }
          : res;
      expect(rendu, JSON.stringify(c)).toEqual(c["resultat"]);
    }
  });
});

describe("chemins, champ et tailles", () => {
  it("_replace_path_in_scope", () => {
    for (const c of V["champs"]!)
      expect(
        dansLeChamp(c["rel"] as string, c["caches"] as boolean, c["glob"] as string),
        JSON.stringify(c),
      ).toBe(c["attendu"]);
  });

  it("PurePosixPath : name, suffix, as_posix", () => {
    for (const c of V["chemins"]!) {
      const p = c["p"] as string;
      expect([nomDe(p), suffixeDe(p), posix(p)], p).toEqual([c["nom"], c["suffixe"], c["posix"]]);
    }
  });

  it("_fmt_octets", () => {
    for (const c of V["octets"]!) expect(fmtOctets(c["n"] as number), String(c["n"])).toBe(c["texte"]);
  });

  it("_upload_tmp_rel", () => {
    for (const c of V["envois"]!) {
      if (c["erreur"] !== undefined) {
        let statut = 0;
        try {
          uploadTmpRel(c["chemin"] as string, c["id"] as string);
        } catch (e) {
          statut = e instanceof HttpError ? e.statusCode : -1;
        }
        expect(statut, JSON.stringify(c)).toBe(c["erreur"]);
      } else expect(uploadTmpRel(c["chemin"] as string, c["id"] as string)).toBe(c["tmp"]);
    }
  });
});

describe("arbre, conflits, aperçus", () => {
  it("_arbre", () => {
    for (const c of V["arbres"]!) expect(json(arbre(c["entrees"] as Dict[]))).toEqual(c["arbre"]);
  });

  it("_save_conflict", () => {
    for (const c of V["conflits"]!) {
      const r = saveConflict(c["etat"] as Etat, c["mtime"] as number | null, c["sha"] as string | null);
      expect(json(r), JSON.stringify(c)).toEqual(c["resultat"]);
    }
    expect(json(conflictDetail(true, null, "m", { x: 1 }))).toEqual({
      code: "conflict",
      missing: true,
      mtime: null,
      sha256: null,
      message: "m",
      x: 1,
    });
  });

  it("aperçu de la recherche par contenu", () => {
    for (const c of V["apercus"]!)
      expect(apercuRecherche(c["hit"] as Dict), JSON.stringify(c["hit"])).toEqual(c["item"]);
  });
});

/** Contenu d'un dossier comme `os.walk` du vecteur : `[chemin relatif, base64 ou null]`, trié. */
function contenu(d: string): [string, string | null][] {
  const sortie: [string, string | null][] = [];
  for (const nom of readdirSync(d, { recursive: true }) as string[]) {
    const p = path.join(d, nom);
    sortie.push([nom, statSync(p).isDirectory() ? null : readFileSync(p).toString("base64")]);
  }
  return sortie.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

describe("archives tar du miroir des skills", () => {
  it("extraction bornée : mêmes fichiers, mêmes refus", async () => {
    for (const c of V["archives"]!) {
      const d = mkdtempSync(path.join(tmpdir(), "elpis-tar-"));
      try {
        const t = path.join(d, "t");
        mkdirSync(t);
        let n: number | string;
        try {
          n = await extraireTarBorne(Buffer.from(c["b64"] as string, "base64"), t, {
            maxTotal: c["max_total"] as number,
            maxMembres: c["max_membres"] as number,
          });
        } catch (e) {
          n =
            e instanceof ArchiveTropGrosse
              ? "trop"
              : e instanceof ErreurTar
                ? "lecture"
                : `inattendu ${String(e)}`;
        }
        if (c["erreur"] !== undefined) {
          expect(n, String(c["nom"])).toBe(c["erreur"]);
          continue;
        }
        expect(n, String(c["nom"])).toBe(c["n"]);
        expect(contenu(t), String(c["nom"])).toEqual(c["contenu"]);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });
});
