// SPDX-License-Identifier: MIT
/** apps/toolhost/test/securite-regex-fil.test.ts — motifs reçus des outils : exécutés dans un thread tué à l'échéance, la boucle de l'hôte reste libre et les résultats ordinaires restent ceux de Python. */
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import path from "node:path";

import { chercher, compilerPy, ErreurRe, subn, trouverTout } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import {
  checkExpect,
  installerPrimitivesBureau,
  installerRechercheRegex,
  primitivesBureau,
  valueMatches,
} from "@elpis/bureau";
import { AgentClient } from "@elpis/fichiers";
import { ouvrirEnMemoire, ServeurOutils } from "@elpis/outils-mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BacTest, dossierTemporaire, PYTHON } from "../../../packages/fichiers/test/aides";
import * as calcul from "../src/fichiers/calcul-execution";
import { Espace, installerFabriqueEspace } from "../src/mcp/espace";
import { outilsFs } from "../src/mcp/fs/famille";
import { familleGit } from "../src/mcp/git/famille";
import { configTest, hoteTest } from "./aides";

/** Backtracking exponentiel que `verifierRegexSure` laisse passer : une vingtaine de secondes sur place sur ce poste, fini (un échec, jamais un blocage du test). */
const LENT = "(a|a)*$";
const CHARGE = `${"a".repeat(28)}!`;
/** Le même, sans correspondance sur les lignes ordinaires : tout le fichier est parcouru. */
const LENT_SANS_TOUCHE = "(a|a)*b";
const DELAI_MS = 1500;
/** Bien au-delà des à-coups d'un poste chargé, bien en deçà du blocage d'une exécution sur place. */
const TROU_MAX_MS = 3000;
const MARGE_MS = 8000;

const META = { username: "alice", user_id: "7" };

let racine = "";
let nettoyer: () => void = () => undefined;
let bac: BacTest;

beforeEach(() => {
  [racine, nettoyer] = dossierTemporaire("elpis-securite-regex-");
  bac = new BacTest(racine, "alice");
  vi.stubEnv("APP_FILE_HISTORY_DIR", path.join(racine, "fh"));
  vi.stubEnv("FSTOOLS_FLOCK", "0");
  installerFabriqueEspace(async () => new Espace(bac.sandboxPath, 7, new AgentClient(bac)));
  calcul.installerDelaiRegex?.(DELAI_MS);
});

afterEach(async () => {
  calcul.installerDelaiRegex?.(null);
  installerFabriqueEspace(null);
  vi.unstubAllEnvs();
  await bac.arreter();
  nettoyer();
});

async function clientDe(
  serveur: ServeurOutils,
  famille: string,
): Promise<{ c: Client; fermer: () => Promise<void> }> {
  const cnx = await ouvrirEnMemoire(serveur, { famille });
  const c = new Client({ name: "test", version: "1" });
  await c.connect(cnx.transport);
  return { c, fermer: () => cnx.fermer() };
}

function clientFs(): ReturnType<typeof clientDe> {
  const serveur = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
  serveur.enregistrerFamille("fs", outilsFs());
  return clientDe(serveur, "fs");
}

async function appeler(c: Client, outil: string, args: Dict): Promise<Dict> {
  const rep = (await c.callTool({ name: outil, arguments: args, _meta: META })) as Dict;
  const sc = rep["structuredContent"] as Dict | undefined;
  const texte = ((rep["content"] as Dict[])[0]?.["text"] as string | undefined) ?? "{}";
  return (sc?.["result"] as Dict | undefined) ?? (JSON.parse(texte) as Dict);
}

const travail = (rel: string): string => path.join(bac.sandboxPath, rel);

/** `f` sous un minuteur : la boucle a-t-elle tourné pendant l'appel, et combien de temps a-t-il pris ? */
async function surveiller<T>(
  f: () => Promise<T>,
): Promise<{ r: T; ms: number; trou: number; tours: number }> {
  const debut = performance.now();
  let dernier = debut;
  let trou = 0;
  let tours = 0;
  const h = setInterval(() => {
    const n = performance.now();
    trou = Math.max(trou, n - dernier);
    dernier = n;
    tours++;
  }, 10);
  try {
    const r = await f();
    return { r, ms: performance.now() - debut, trou, tours };
  } finally {
    clearInterval(h);
  }
}

function boucleLibre(s: { ms: number; trou: number; tours: number }): void {
  expect(s.trou).toBeLessThan(TROU_MAX_MS);
  expect(s.tours).toBeGreaterThan(10);
  expect(s.ms).toBeLessThan(DELAI_MS + MARGE_MS);
}

function erreurLente(r: unknown): void {
  expect(r).toMatchObject({ ok: false, error: "regex_timeout" });
  expect((r as Dict)["message"]).toContain("Simplify");
}

describe.skipIf(!PYTHON)("read_file grep", () => {
  it("motif pathologique : erreur à l'échéance, boucle libre, un autre appel servi pendant ce temps", async () => {
    writeFileSync(travail("lent.txt"), `${CHARGE}\n`);
    writeFileSync(travail("autre.txt"), "alpha\nbeta\n");
    const { c, fermer } = await clientFs();
    try {
      const s = await surveiller(async () => {
        const lent = appeler(c, "read_file", { path: "lent.txt", grep: LENT });
        const fini = await Promise.race([
          appeler(c, "read_file", { path: "autre.txt", grep: "^b" }),
          lent.then(() => null),
        ]);
        return { lent: await lent, fini };
      });
      boucleLibre(s);
      erreurLente(s.r.lent);
      expect(s.r.fini).toMatchObject({ ok: true, format: "grep", matches: 1, content: "2:beta" });
      const apres = await appeler(c, "read_file", { path: "lent.txt", grep: "a+!" });
      expect(apres).toMatchObject({ ok: true, matches: 1 });
    } finally {
      await fermer();
    }
  }, 60_000);

  it("lot de fichiers : le premier dépassement arrête les recherches de l'appel, sans cumuler les délais", async () => {
    writeFileSync(travail("a.txt"), `${CHARGE}\n`);
    writeFileSync(travail("b.txt"), `${CHARGE}\n`);
    const { c, fermer } = await clientFs();
    try {
      const s = await surveiller(() => appeler(c, "read_file", { paths: ["a.txt", "b.txt"], grep: LENT }));
      boucleLibre(s);
      const fichiers = s.r["files"] as Dict;
      erreurLente(fichiers["a.txt"]);
      erreurLente(fichiers["b.txt"]);
      expect(s.r).toMatchObject({ succeeded: 0, failed: 2 });
    } finally {
      await fermer();
    }
  }, 60_000);

  it("gros fichier en flux : motif pathologique arrêté ; contexte juste de part et d'autre d'un paquet", async () => {
    const lignes = Array.from({ length: 400_000 }, (_, i) => `ligne numéro ${i + 1} ${"x".repeat(30)}`);
    let somme = 0;
    const fin = lignes.findIndex((l) => (somme += l.length) >= 1 << 20);
    writeFileSync(travail("gros.log"), `${lignes.join("\n")}\n${CHARGE}\n`);
    const { c, fermer } = await clientFs();
    try {
      const debut = await appeler(c, "read_file", {
        path: "gros.log",
        grep: `numéro ${fin + 2} x`,
        grep_context: 1,
      });
      expect(debut).toMatchObject({ streamed: true, format: "grep", matches: 1, truncated: false });
      expect(debut["content"]).toBe(
        [
          `${fin + 1}-${lignes[fin] as string}`,
          `${fin + 2}:${lignes[fin + 1] as string}`,
          `${fin + 3}-${lignes[fin + 2] as string}`,
        ].join("\n"),
      );
      const queue = await appeler(c, "read_file", {
        path: "gros.log",
        grep: `numéro ${fin + 1} x`,
        grep_context: 1,
      });
      expect(queue["content"]).toBe(
        [
          `${fin}-${lignes[fin - 1] as string}`,
          `${fin + 1}:${lignes[fin] as string}`,
          `${fin + 2}-${lignes[fin + 1] as string}`,
        ].join("\n"),
      );
      const coupe = await appeler(c, "read_file", { path: "gros.log", grep: "numéro", max_chars: 300 });
      expect(coupe).toMatchObject({ truncated: true });
      const s = await surveiller(() => appeler(c, "read_file", { path: "gros.log", grep: LENT_SANS_TOUCHE }));
      expect(s.trou).toBeLessThan(TROU_MAX_MS);
      expect(s.tours).toBeGreaterThan(10);
      erreurLente(s.r);
    } finally {
      await fermer();
    }
  }, 120_000);
});

describe.skipIf(!PYTHON)("edit_file", () => {
  it("regex, anchor_re et multi : erreur à l'échéance, boucle libre, fichier intact", async () => {
    const contenu = `${CHARGE}\nfin\n`;
    writeFileSync(travail("lent.txt"), contenu);
    const { c, fermer } = await clientFs();
    try {
      for (const args of [
        { action: "regex", pattern: LENT, replacement: "x" },
        { action: "anchor", anchor_re: LENT, content: "x" },
        { action: "multi", edits: [{ action: "regex", pattern: LENT, replacement: "x" }] },
      ]) {
        const s = await surveiller(() => appeler(c, "edit_file", { path: "lent.txt", ...args }));
        boucleLibre(s);
        erreurLente(s.r);
        expect(readFileSync(travail("lent.txt"), "utf-8")).toBe(contenu);
      }
    } finally {
      await fermer();
    }
  }, 90_000);

  it("motifs ordinaires : même résultat, et le refus du gabarit reste celui de Python", async () => {
    writeFileSync(travail("n.txt"), "foo 1\nbar 2\nfoo 3\n");
    const { c, fermer } = await clientFs();
    try {
      const r = await appeler(c, "edit_file", {
        path: "n.txt",
        action: "regex",
        pattern: "foo (\\d)",
        replacement: "baz \\1",
        count: 1,
      });
      expect(r).toMatchObject({ ok: true, applied: [{ action: "regex", replacements: 1 }] });
      expect(readFileSync(travail("n.txt"), "utf-8")).toBe("baz 1\nbar 2\nfoo 3\n");
      const a = await appeler(c, "edit_file", {
        path: "n.txt",
        action: "anchor",
        anchor_re: "^(?:baz|foo)",
        occurrence: -1,
        position: "before",
        content: "avant",
      });
      expect(a).toMatchObject({ ok: true, applied: [{ action: "anchor", anchor_line: 3, occurrence: -1 }] });
      expect(readFileSync(travail("n.txt"), "utf-8")).toBe("baz 1\nbar 2\navant\nfoo 3\n");
      const hors = await appeler(c, "edit_file", {
        path: "n.txt",
        action: "anchor",
        anchor_re: "^foo",
        occurrence: 2,
        content: "x",
      });
      expect(hors).toMatchObject({ ok: false, error: "occurrence_out_of_range" });
      expect(hors["message"]).toContain("(1..1)");
      const absente = await appeler(c, "edit_file", {
        path: "n.txt",
        action: "regex",
        pattern: "absent",
        replacement: "x",
      });
      expect(absente).toMatchObject({ ok: false, error: "old_str_not_found" });
      const gabarit = await appeler(c, "edit_file", {
        path: "n.txt",
        action: "regex",
        pattern: "foo",
        replacement: "\\9",
      });
      expect(gabarit).toMatchObject({ ok: false });
      expect(gabarit["message"]).toContain("invalid group reference 9");
    } finally {
      await fermer();
    }
  }, 60_000);
});

describe.skipIf(!PYTHON)("git_write", () => {
  it("find en regex : erreur à l'échéance, boucle libre, fichier intact ; motif ordinaire appliqué", async () => {
    const serveur = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
    const fam = familleGit({ rappel: null });
    serveur.enregistrerFamille(fam.famille, fam.outils);
    const { c, fermer } = await clientDe(serveur, "git");
    try {
      expect(await appeler(c, "git_action", { repo: "proj", action: "init" })).toMatchObject({ ok: true });
      const ecrit = await appeler(c, "git_write", {
        repo: "proj",
        action: "write",
        path: "a.txt",
        content: `${CHARGE}\nfoo 1\n`,
      });
      expect(ecrit).toMatchObject({ ok: true });
      const s = await surveiller(() =>
        appeler(c, "git_write", {
          repo: "proj",
          action: "replace",
          path: "a.txt",
          find: LENT,
          replace: "x",
          regex: true,
        }),
      );
      boucleLibre(s);
      erreurLente(s.r);
      expect(readFileSync(travail("proj/a.txt"), "utf-8")).toBe(`${CHARGE}\nfoo 1\n`);
      const r = await appeler(c, "git_write", {
        repo: "proj",
        action: "replace",
        path: "a.txt",
        find: "foo (\\d)",
        replace: "bar \\1",
        regex: true,
      });
      expect(r).toMatchObject({ ok: true, replacements: 1, changed: true });
      expect(readFileSync(travail("proj/a.txt"), "utf-8")).toBe(`${CHARGE}\nbar 1\n`);
    } finally {
      await fermer();
    }
  }, 60_000);
});

describe("desktop_wait(match=true)", () => {
  it("l'hôte branche le port : motif pathologique en erreur à l'échéance, boucle libre ; motif ordinaire et motif refusé inchangés", async () => {
    const h = await hoteTest(configTest({ families: ["desktop"], familles_natives: ["desktop"] }));
    const installees = primitivesBureau();
    installerPrimitivesBureau({
      ...installees,
      grab: () => Promise.resolve({ sig: "0" }),
      readText: () => Promise.resolve({ text: CHARGE }),
    });
    try {
      const s = await surveiller(() =>
        checkExpect("alice", "poste", { kind: "text", query: LENT, match: true }, 100).then(
          () => null,
          (e: unknown) => e as Error,
        ),
      );
      boucleLibre(s);
      expect(s.r?.message).toContain("regex_timeout");
      expect(s.r?.message).toContain("Simplify");
      expect(await valueMatches("version 1.2", "^version \\d", "regex")).toBe(true);
      expect(await valueMatches("version 1.2", "^\\d", "regex")).toBe(false);
      expect(await valueMatches("a(b", "a(", "regex")).toBe(true);
      expect(await valueMatches("x".repeat(3000), "x".repeat(2001), "regex")).toBe(true);
    } finally {
      installerPrimitivesBureau(null);
      installerRechercheRegex?.(null);
      await h.fermer();
    }
  }, 60_000);
});

describe("SessionCalcul : recherches de motifs", () => {
  it("le thread en plein calcul est tué à l'échéance ; l'appel ne relance plus rien, le suivant repart", async () => {
    const m = compilerPy(LENT);
    const fil = new calcul.SessionCalcul();
    try {
      expect(await fil.present(m, "!")).toBe(true);
      const s = await surveiller(() =>
        fil.present(m, CHARGE).then(
          () => null,
          (e: unknown) => e as Error,
        ),
      );
      boucleLibre(s);
      expect(s.ms).toBeGreaterThanOrEqual(DELAI_MS - 50);
      expect(s.r?.message).toBe(calcul.REGEX_LENTE);
      const t = performance.now();
      await expect(fil.present(m, "!")).rejects.toThrow(calcul.REGEX_LENTE);
      expect(performance.now() - t).toBeLessThan(200);
    } finally {
      await fil.fermer();
    }
    await expect(calcul.avecFilCalcul((f) => f.present(m, "!"))).resolves.toBe(true);
  }, 60_000);

  it("mêmes résultats que sur place sur les vecteurs de Python (recherche, finditer, subn, lignes, refus)", async () => {
    calcul.installerDelaiRegex(30_000);
    const V = JSON.parse(readFileSync(new URL("./vecteurs/fs-regex.json", import.meta.url), "utf-8")) as {
      cas: { motif: string; flags: number; textes?: { texte: string }[] }[];
    };
    let vus = 0;
    await calcul.avecFilCalcul(async (fil) => {
      for (const cas of V.cas) {
        if (cas.textes === undefined) continue;
        let m;
        try {
          m = compilerPy(cas.motif, cas.flags);
        } catch (e) {
          if (e instanceof ErreurRe) continue;
          throw e;
        }
        for (const { texte } of cas.textes) {
          vus++;
          expect(await fil.present(m, texte)).toBe(chercher(m, texte) !== null);
          expect([...(await fil.occurrences(m, texte))]).toEqual(
            [...trouverTout(m, texte)].flatMap((c) => [c.debut, c.fin]),
          );
          expect(await fil.subn(m, "<\\g<0>>", texte)).toEqual(subn(m, "<\\g<0>>", texte));
          expect(await fil.subn(m, "X", texte, 1)).toEqual(subn(m, "X", texte, 1));
          const lignes = texte.split("\n");
          const sur = lignes.flatMap((l, k) => (chercher(m, l) !== null ? [k] : []));
          expect([...(await fil.lignes(m, lignes))]).toEqual(sur);
        }
      }
      await expect(fil.subn(compilerPy("a"), "\\9", "a")).rejects.toThrow(ErreurRe);
      expect([...(await fil.lignes(compilerPy("a"), []))]).toEqual([]);
    });
    expect(vus).toBeGreaterThan(500);
  }, 120_000);
});
