// SPDX-License-Identifier: MIT
/** apps/toolhost/test/fs-contenu-elide.test.ts — write_file et edit_file refusent un champ réduit au marqueur de contenu condensé (H-04) ou qui recopie une ligne coupée par read_file, sans écriture partielle ; un texte qui cite le marqueur passe. */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { AgentClient } from "@elpis/fichiers";
import {
  contenuElide,
  contientContenuElide,
  estContenuElide,
  ouvrirEnMemoire,
  ServeurOutils,
} from "@elpis/outils-mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BacTest, dossierTemporaire, PYTHON } from "../../../packages/fichiers/test/aides";
import { Espace, installerFabriqueEspace } from "../src/mcp/espace";
import { outilsFs } from "../src/mcp/fs/famille";

let racine = "";
let nettoyer: () => void = () => undefined;
let bac: BacTest;

beforeEach(() => {
  [racine, nettoyer] = dossierTemporaire("elpis-fs-elide-");
  bac = new BacTest(racine, "alice");
  vi.stubEnv("APP_FILE_HISTORY_DIR", path.join(racine, "fh"));
  vi.stubEnv("FSTOOLS_FLOCK", "0");
  installerFabriqueEspace(async () => new Espace(bac.sandboxPath, 7, new AgentClient(bac)));
});

afterEach(async () => {
  installerFabriqueEspace(null);
  vi.unstubAllEnvs();
  await bac.arreter();
  nettoyer();
});

async function appeler(outil: string, args: Dict): Promise<Dict> {
  const serveur = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
  serveur.enregistrerFamille("fs", outilsFs());
  const cnx = await ouvrirEnMemoire(serveur, { famille: "fs" });
  const c = new Client({ name: "test", version: "1" });
  await c.connect(cnx.transport);
  try {
    const rep = (await c.callTool({
      name: outil,
      arguments: args,
      _meta: { username: "alice", user_id: "7" },
    })) as Dict;
    const sc = rep["structuredContent"] as Dict | undefined;
    const texte = ((rep["content"] as Dict[])[0]?.["text"] as string | undefined) ?? "{}";
    return (sc?.["result"] as Dict | undefined) ?? (JSON.parse(texte) as Dict);
  } finally {
    await cnx.fermer();
  }
}

const travail = (rel: string): string => path.join(bac.sandboxPath, rel);
const MARQUEUR = contenuElide("x".repeat(20_000));
const REFUS = {
  ok: false,
  error: "elided_content",
  message: "this text is a placeholder from an elided earlier write, not real file content",
  fix: "re-read the file with read_file before writing",
};

describe("motif partagé avec l'élagage du core", () => {
  it("le marqueur émis est reconnu, un texte qui dit seulement « content elided » ne l'est pas", () => {
    expect(MARQUEUR).toMatch(
      /^\[content elided: 20000 chars, sha256 [0-9a-f]{12} — re-read the file if needed\]$/u,
    );
    expect(contientContenuElide(`avant ${MARQUEUR} après`)).toBe(true);
    expect(contientContenuElide("the content elided here was a draft")).toBe(false);
    expect(contientContenuElide("[content elided: many chars, sha256 3f2a]")).toBe(false);
    expect(contientContenuElide(42)).toBe(false);
    expect([estContenuElide(MARQUEUR), estContenuElide(`\n ${MARQUEUR} \n`)]).toEqual([true, true]);
    expect(estContenuElide(`avant ${MARQUEUR}`)).toBe(false);
    expect(estContenuElide(MARQUEUR.replace(" — re-read the file if needed", ""))).toBe(false);
  });
});

describe.skipIf(!PYTHON)("write_file et edit_file : refus du contenu condensé", () => {
  it("write_file refuse le marqueur dans content, le fichier reste intact", async () => {
    writeFileSync(travail("big.ts"), "original\n");
    const r = await appeler("write_file", { path: "big.ts", content: `${MARQUEUR}\n` });
    expect(r).toMatchObject({ ...REFUS, path: "/work/big.ts", field: "content" });
    expect(readFileSync(travail("big.ts"), "utf8")).toBe("original\n");
    expect(await appeler("write_file", { path: "neuf.ts", content: MARQUEUR })).toMatchObject(REFUS);
  });

  it("edit_file refuse le marqueur en str_replace et dans un lot multi, sans écriture partielle", async () => {
    writeFileSync(travail("e.py"), "a = 1\nb = 2\n");
    const simple = await appeler("edit_file", {
      path: "e.py",
      action: "str_replace",
      old_str: "a = 1",
      new_str: MARQUEUR,
    });
    expect(simple).toMatchObject({ ...REFUS, field: "new_str" });
    const multi = await appeler("edit_file", {
      path: "e.py",
      action: "multi",
      edits: [
        { action: "str_replace", old_str: "a = 1", new_str: "a = 10" },
        { action: "insert", start_line: 2, content: ` ${MARQUEUR}` },
      ],
    });
    expect(multi).toMatchObject({ ...REFUS, field: "edits[1].content" });
    expect(readFileSync(travail("e.py"), "utf8")).toBe("a = 1\nb = 2\n");
  });

  it("un texte qui CITE le marqueur entier (test, doc, journal) s'écrit : seul le champ réduit au marqueur est refusé", async () => {
    const cite = `expect(vue).toBe("${MARQUEUR}");\n`;
    expect(await appeler("write_file", { path: "t.test.ts", content: cite })).toMatchObject({ ok: true });
    expect(readFileSync(travail("t.test.ts"), "utf8")).toBe(cite);
    writeFileSync(travail("j.md"), "x\n");
    const r = await appeler("edit_file", {
      path: "j.md",
      action: "str_replace",
      old_str: "x",
      new_str: `log: ${MARQUEUR}`,
    });
    expect(r).toMatchObject({ ok: true });
  });

  it("un contenu normal qui dit « content elided » sans le format exact s'écrit", async () => {
    const texte = "# note: content elided in the summary above\n";
    expect(await appeler("write_file", { path: "n.md", content: texte })).toMatchObject({ ok: true });
    expect(readFileSync(travail("n.md"), "utf8")).toBe(texte);
    writeFileSync(travail("e.py"), "a = 1\n");
    const r = await appeler("edit_file", {
      path: "e.py",
      action: "str_replace",
      old_str: "a = 1",
      new_str: "a = 1  # [content elided: see notes]",
    });
    expect(r).toMatchObject({ ok: true });
    expect(readFileSync(travail("e.py"), "utf8")).toBe("a = 1  # [content elided: see notes]\n");
  });
});

describe.skipIf(!PYTHON)(
  "write_file et edit_file : refus d'une ligne coupée par read_file (…[+N chars])",
  () => {
    const longue = "{" + "k".repeat(4998) + "}";
    const coupee = `${longue.slice(0, 2000)}…[+3000 chars]`;
    const REFUS_COUPE = { ok: false, error: "cut_line_marker" };

    it("la ligne telle que read_file l'affiche est refusée, le fichier reste intact ; une mention courte du marqueur passe", async () => {
      writeFileSync(travail("d.json"), `${longue}\n`);
      const lu = await appeler("read_file", { path: "d.json", start_line: 1, end_line: 1 });
      expect(String(lu["content"])).toContain(coupee);
      expect(await appeler("write_file", { path: "d.json", content: `${coupee}\n` })).toMatchObject({
        ...REFUS_COUPE,
        field: "content",
      });
      const multi = await appeler("edit_file", {
        path: "d.json",
        action: "multi",
        edits: [{ action: "replace", start_line: 1, end_line: 1, content: coupee }],
      });
      expect(multi).toMatchObject({ ...REFUS_COUPE, field: "edits[0].content" });
      expect(readFileSync(travail("d.json"), "utf8")).toBe(`${longue}\n`);
      const doc = "Long lines end with …[+N chars], e.g. …[+3000 chars].\n";
      expect(await appeler("write_file", { path: "doc.md", content: doc })).toMatchObject({ ok: true });
    });
  },
);
