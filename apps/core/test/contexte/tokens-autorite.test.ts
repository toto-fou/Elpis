// SPDX-License-Identifier: MIT
/** apps/core/test/contexte/tokens-autorite.test.ts — invariant 3 : le lint refuse une requête /tokenize ou /apply-template (chemin absolu ou URL relative) hors de contexte/tokens.ts et un ratio chars/token redéfini hors de @elpis/config ; un message qui cite /tokenize passe. */
import { readFileSync } from "node:fs";
import path from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const RACINE = path.resolve(import.meta.dirname, "../../../..");
const eslint = new ESLint({ cwd: RACINE });

/** Messages de la règle pour `rel` augmenté de `ajout`, réduits à leur préfixe (« invariant 3 »). */
async function refus(rel: string, ajout: string): Promise<string[]> {
  const fichier = path.join(RACINE, rel);
  const [r] = await eslint.lintText(`${readFileSync(fichier, "utf8")}\n${ajout}\n`, { filePath: fichier });
  return (r?.messages ?? [])
    .filter((m) => m.ruleId === "no-restricted-syntax")
    .map((m) => m.message.split(" : ")[0] ?? "");
}

describe("invariant 3 : un seul module compte les tokens", { timeout: 120_000 }, () => {
  it("requête au moteur hors du compteur refusée, permise dans le compteur ; message de journal accepté", async () => {
    const requete = 'export const _sonde = ["/tokenize", `${"http://x"}/apply-template`];';
    expect(await refus("apps/core/src/llm/cible.ts", requete)).toEqual(["invariant 3", "invariant 3"]);
    expect(await refus("packages/config/src/contexte.ts", requete)).toEqual(["invariant 3", "invariant 3"]);
    expect(await refus("apps/core/src/contexte/tokens.ts", requete)).toEqual([]);
    expect(
      await refus(
        "apps/core/src/llm/cible.ts",
        'export const _note = "/tokenize indisponible : repli estimé";',
      ),
    ).toEqual([]);
  });

  it('URL relative au moteur (new URL("tokenize", base)) refusée hors du compteur ; un autre fichier du même nom passe', async () => {
    const url =
      'export const _u = (b: string) => [new URL("tokenize", b), new URL(`./apply-template?x=${b}`, b)];';
    expect(await refus("apps/core/src/llm/cible.ts", url)).toEqual(["invariant 3", "invariant 3"]);
    expect(await refus("apps/core/src/contexte/tokens.ts", url)).toEqual([]);
    expect(
      await refus(
        "apps/core/src/llm/cible.ts",
        'export const _v = (b: string) => new URL("tokenizer.json", b);',
      ),
    ).toEqual([]);
  });

  it("chemin relatif ou préfixé du moteur, URL construite par concaténation ou URL.parse : refusés ; texte avec espaces ou nom nu hors URL : acceptés", async () => {
    const refuses = [
      'export const _a = ["../tokenize", "/v1/tokenize", "http://h:8080/v1/detokenize?x=1"];',
      'export const _b = (b: string) => [new URL(`${b}tokenize`), new URL(b + "apply-template"), URL.parse("tokenize", b), new globalThis.URL("detokenize", b)];',
    ].join("\n");
    expect(await refus("apps/core/src/llm/cible.ts", refuses)).toEqual(Array(7).fill("invariant 3"));
    expect(await refus("apps/core/src/contexte/tokens.ts", refuses)).toEqual([]);
    expect(
      await refus(
        "apps/core/src/llm/cible.ts",
        'export const _c = ["repli : /tokenize indisponible", "tokenize", "./tokenize-guide", "apply-templates"];',
      ),
    ).toEqual([]);
  });

  it("ratio chars/token redéfini refusé partout, compteur compris", async () => {
    expect(
      await refus("apps/toolhost/src/mcp/shell/budget.ts", "export const CHARS_PER_TOKEN_SHELL = 4;"),
    ).toEqual(["invariant 3"]);
    expect(await refus("apps/core/src/contexte/tokens.ts", "export const TOKENS_PER_CHAR = 0.3;")).toEqual([
      "invariant 3",
    ]);
    expect(await refus("apps/core/src/llm/cible.ts", "export const charsPerToken = 4;")).toEqual([
      "invariant 3",
    ]);
  });
});
