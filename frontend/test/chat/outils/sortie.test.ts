// SPDX-License-Identifier: MIT
/** frontend/test/chat/outils/sortie.test.ts — ce qu'une étape a produit, dit court : dernières lignes de sortie vivante, résumé du résultat. */
import { describe, expect, it } from "vitest";

import { dernieresLignes, resumeResultat } from "../../../src/features/chat/outils/sortie";
import type { EtapeOutil } from "../../../src/features/chat/outils/types";

const etape = (extra: Partial<EtapeOutil>): EtapeOutil => ({
  name: "execute_shell",
  status: "done",
  ...extra,
});

describe("resumeResultat", () => {
  it.each<[string, Partial<EtapeOutil>, string]>([
    ["en cours : rien", { status: "running", result: "x" }, ""],
    ["arrêtée", { status: "stopped" }, "arrêtée"],
    [
      "erreur JSON : première ligne du message",
      { _is_error: true, result: '{"error":"Fichier introuvable\\ndétail"}' },
      "Fichier introuvable",
    ],
    ["code et dernière ligne de stdout", { result: { exit_code: 0, stdout: "a\nb\n" } }, "code 0 · b"],
    [
      "stdout vide : dernière ligne de stderr",
      { result: '{"exit_code":2,"stdout":"","stderr":"boom"}' },
      "code 2 · boom",
    ],
    ["code seul", { result: { exit_code: 1 } }, "code 1"],
    ["résumé de l'outil", { result: { summary: "3 fichiers trouvés" } }, "3 fichiers trouvés"],
    ["texte : première ligne non vide", { result: "\n  ligne 1\nligne 2" }, "ligne 1"],
    ["rien de lisible, réussie", { result: {} }, "fait"],
    ["rien de lisible, en échec", { _is_error: true, result: null }, "échec"],
  ])("%s", (_cas, extra, attendu) => {
    expect(resumeResultat(etape(extra))).toBe(attendu);
  });

  it("coupé à 90 caractères avec une ellipse", () => {
    const r = resumeResultat(etape({ result: "x".repeat(200) }));
    expect(r).toHaveLength(90);
    expect(r.endsWith("…")).toBe(true);
  });
});

describe("dernieresLignes", () => {
  it("console d'abord, sans séquences ANSI ni lignes vides", () => {
    const s = etape({
      status: "running",
      shellOut: "\u001b[32mun\u001b[0m\n\ndeux\ntrois\n",
      logs: [{ level: "info", message: "x" }],
    });
    expect(dernieresLignes(s)).toEqual(["deux", "trois"]);
    expect(dernieresLignes(s, 1)).toEqual(["trois"]);
  });

  it("sinon le journal, sinon la progression, sinon rien", () => {
    const logs = [
      { level: "info", message: "a" },
      { level: "info", message: "" },
      { level: "info", message: "b" },
      { level: "info", message: "c" },
    ];
    expect(dernieresLignes(etape({ status: "running", logs }))).toEqual(["b", "c"]);
    expect(dernieresLignes(etape({ status: "running", progressInfo: { pct: 40, message: "40 %" } }))).toEqual(
      ["40 %"],
    );
    expect(dernieresLignes(etape({ status: "running" }))).toEqual([]);
  });
});
