// SPDX-License-Identifier: MIT
/** apps/toolhost/test/fs-chemins-contexte.test.ts — chemins cités par le bloc PATHS de `<runtime_context>` (harnais B-21) : chaque chemin accepté passe read_file, chaque chemin refusé rend path_outside_sandbox ; vrai agent Python, sans conteneur. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { AgentClient } from "@elpis/fichiers";
import { ouvrirEnMemoire, ServeurOutils } from "@elpis/outils-mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BacTest, dossierTemporaire, PYTHON } from "../../../packages/fichiers/test/aides";
import { Espace, installerFabriqueEspace } from "../src/mcp/espace";
import { outilsFs } from "../src/mcp/fs/famille";

const META = { username: "alice", user_id: "7" };
const SOURCE = new URL("../../core/src/contexte/assemblage.ts", import.meta.url);

let racine = "";
let nettoyer: () => void = () => undefined;
let bac: BacTest;

beforeEach(() => {
  [racine, nettoyer] = dossierTemporaire("elpis-fs-ctx-");
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

/** Chemins `path="…"` de la ligne du bloc PATHS qui commence par `marque` (✓ ou ✗). */
function cites(marque: string): string[] {
  const ligne = readFileSync(SOURCE, "utf-8")
    .split("\n")
    .find((l) => l.startsWith(`  ${marque} path=`));
  return [...(ligne ?? "").matchAll(/path="([^"]*)"/gu)].map((m) => m[1] ?? "");
}

async function appeler(c: Client, outil: string, args: Dict): Promise<Dict> {
  const rep = (await c.callTool({ name: outil, arguments: args, _meta: META })) as Dict;
  const sc = rep["structuredContent"] as Dict | undefined;
  const texte = ((rep["content"] as Dict[])[0]?.["text"] as string | undefined) ?? "{}";
  return (sc?.["result"] as Dict | undefined) ?? (JSON.parse(texte) as Dict);
}

describe.skipIf(!PYTHON)("bloc PATHS du contexte d'exécution (harnais B-21)", () => {
  it("chaque chemin cité accepté passe read_file (un dossier : list_files), chaque chemin refusé rend path_outside_sandbox", async () => {
    const acceptes = cites("✓");
    const refuses = cites("✗");
    expect(acceptes).toEqual(["src/main.py", ".", "tmp/scratch.txt", "/work/src/main.py"]);
    expect(refuses).toEqual(["/tmp/foo", "/home/x", "../up"]);
    for (const d of ["src", "tmp"]) mkdirSync(path.join(bac.sandboxPath, d), { recursive: true });
    writeFileSync(path.join(bac.sandboxPath, "src/main.py"), "print(1)\n");
    writeFileSync(path.join(bac.sandboxPath, "tmp/scratch.txt"), "x\n");
    writeFileSync(path.join(bac.sandboxPath, "file"), "racine\n");
    const serveur = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
    serveur.enregistrerFamille("fs", outilsFs());
    const cnx = await ouvrirEnMemoire(serveur, { famille: "fs" });
    const c = new Client({ name: "test", version: "1" });
    await c.connect(cnx.transport);
    try {
      for (const p of acceptes) {
        const r = await appeler(c, "read_file", { path: p });
        if (r["error"] === "is_directory")
          expect([p, (await appeler(c, "list_files", { path: p }))["ok"]]).toEqual([p, true]);
        else expect([p, r["ok"], r["error"] ?? null]).toEqual([p, true, null]);
      }
      expect(String((await appeler(c, "read_file", { path: "/work/src/main.py" }))["content"])).toContain(
        "print(1)",
      );
      for (const p of refuses)
        expect([p, (await appeler(c, "read_file", { path: p }))["error"]]).toEqual([
          p,
          "path_outside_sandbox",
        ]);
      // `~` est /work (HOME du conteneur) : ~/file n'est pas cité comme refusé
      expect(String((await appeler(c, "read_file", { path: "~/file" }))["content"])).toContain("racine");
    } finally {
      await cnx.fermer();
    }
  });
});
