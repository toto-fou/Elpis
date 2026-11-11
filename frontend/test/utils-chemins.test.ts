// SPDX-License-Identifier: MIT
/** frontend/test/utils-chemins.test.ts — chemins de fichier plausibles : ligne et colonne, préfixes de la sandbox, faux positifs écartés. */
import { strict as assert } from "node:assert";
import { it } from "vitest";

import { looksLikePath, parsePath } from "../src/utils/utils-purs";

const parse = parsePath;
const looks = looksLikePath;

it("chemins avec ligne et colonne", () => {
  assert.deepStrictEqual(parse("src/app.py:12"), { path: "src/app.py", line: 12, col: 0 });
  assert.deepStrictEqual(parse("src/app.py:12:7"), { path: "src/app.py", line: 12, col: 7 });
  assert.deepStrictEqual(parse("src/app.py"), { path: "src/app.py", line: 0, col: 0 });
});

it("préfixes ./ et /work/ ramenés au chemin de la sandbox", () => {
  assert.strictEqual(parse("./src/a.js")?.path, "src/a.js");
  assert.strictEqual(parse("/work/proj/main.go:3")?.path, "proj/main.go");
  assert.strictEqual(parse("/work/proj/main.go:3")?.line, 3);
});

it("nom seul accepté si l'extension est connue", () => {
  assert.ok(looks("main.py"));
  assert.ok(looks("README.md"));
  assert.ok(looks("Dockerfile"));
  assert.ok(looks("config.yaml:4"));
  // extensions « faibles » : liens seulement avec un chemin
  assert.ok(looks("logs/app.log"));
  assert.ok(looks("./.env"));
  assert.ok(looks(".env"));
  assert.ok(looks(".github/workflows/ci.yml"));
  assert.ok(!looks(".gitignore"), "sans chemin, un fichier caché inconnu n'est pas lié");
  assert.ok(looks("./.gitignore"));
  assert.ok(looks("server-2026.log"));
});

it("faux positifs écartés", () => {
  // (« a.b.c » reste un nom de fichier C plausible : pas dans cette liste —
  // le clic vérifie de toute façon que le fichier existe.)
  for (const s of [
    "os.path",
    "v1.2",
    "self.value",
    "http://x.io/a.py",
    "https://github.com/a/b.js",
    "src/utils",
    "deux mots.py",
    "",
    "   ",
    "x".repeat(301) + ".py",
    "console.log",
    "process.env",
    "logger.log",
  ]) {
    assert.ok(!looks(s), "ne devrait pas être un lien : " + JSON.stringify(s));
  }
});

it("chemins avec tirets, points et arobase", () => {
  assert.strictEqual(parse("node_modules/@scope/pkg/index.d.ts")?.path, "node_modules/@scope/pkg/index.d.ts");
  assert.strictEqual(parse(".github/workflows/ci.yml")?.path, ".github/workflows/ci.yml");
  assert.strictEqual(parse("my-app/src/App.vue:10")?.line, 10);
});
