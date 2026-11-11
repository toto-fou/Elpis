// SPDX-License-Identifier: MIT
/** apps/toolhost/test/office-rappels.test.ts — rappels du worker Office : `lister` (entrées d'un dossier, dossier absent, sandbox muette) et `ecrire` (copie .bak au-delà de l'historique). */
import { erreurAgent } from "@elpis/bac";
import type { Dict } from "@elpis/commun";
import { Journal } from "@elpis/http";
import { describe, expect, it, vi } from "vitest";

import type { Espace } from "../src/mcp/espace";
import type * as acces from "../src/mcp/fs/acces";
import { actuel, ecrireGarde, sauvegarde } from "../src/mcp/fs/acces";
import { creerRappels } from "../src/mcp/office/rappels";
import type { DepsRappels } from "../src/mcp/office/rappels";
import { RefusRappel } from "../src/mcp/office/worker";

vi.mock("../src/mcp/fs/acces", async (importOriginal) => {
  const vrai = await importOriginal<typeof acces>();
  return { ...vrai, actuel: vi.fn(), ecrireGarde: vi.fn(), sauvegarde: vi.fn() };
});

function rappels(lister: (rel: string) => Promise<{ entries: Dict[]; truncated: boolean; errors: number }>) {
  const espace = { racine: "/sandbox/alice", lister } as unknown as Espace;
  const deps = {
    espace: () => Promise.resolve(espace),
    journal: new Journal(),
  } as unknown as DepsRappels;
  return creerRappels({ username: "alice", signal: new AbortController().signal }, deps);
}

describe("rappel lister", () => {
  it("rend les noms du dossier, relatifs à lui, et marque les sous-dossiers", async () => {
    const vus: string[] = [];
    const r = rappels((rel) => {
      vus.push(rel);
      return Promise.resolve({
        entries: [
          { path: "images/logo.png", kind: "file" },
          { path: "images/archives", kind: "dir" },
        ],
        truncated: false,
        errors: 0,
      });
    });
    const rep = await r("lister", { chemin: "images" }, Buffer.alloc(0));
    expect(vus).toEqual(["images"]);
    expect(rep.valeur).toEqual({
      entrees: [
        { nom: "logo.png", dossier: false },
        { nom: "archives", dossier: true },
      ],
    });
  });

  it("dossier absent : null ; sandbox injoignable : refus réessayable", async () => {
    const absent = rappels(() => Promise.reject(erreurAgent("not_found")));
    expect((await absent("lister", { chemin: "nulle/part" }, Buffer.alloc(0))).valeur).toEqual({
      entrees: null,
    });
    const muette = rappels(() => Promise.reject(erreurAgent("agent_unavailable")));
    const refus = muette("lister", { chemin: "" }, Buffer.alloc(0));
    await expect(refus).rejects.toBeInstanceOf(RefusRappel);
    await expect(refus).rejects.toMatchObject({ code: "sandbox_unavailable", retryable: true });
  });

  it("chemin hors de la sandbox refusé", async () => {
    const r = rappels(() => Promise.resolve({ entries: [], truncated: false, errors: 0 }));
    await expect(r("lister", { chemin: "../bob" }, Buffer.alloc(0))).rejects.toMatchObject({
      code: "bad_path",
    });
  });
});

describe("rappel ecrire", () => {
  const ecrire = async (taille: number) => {
    vi.mocked(actuel).mockResolvedValue([
      { kind: "file", size: taille },
      Buffer.from("ancien"),
      "sha-ancien",
    ]);
    vi.mocked(ecrireGarde).mockResolvedValue([{}, null]);
    vi.mocked(sauvegarde).mockReset().mockResolvedValue(null);
    const r = rappels(() => Promise.resolve({ entries: [], truncated: false, errors: 0 }));
    return r("ecrire", { chemin: "decks/comite.pptx", attendu: null }, Buffer.from("nouveau"));
  };

  it("ancienne version de plus de 5 Mo : copiée en .bak avant l'écriture", async () => {
    const rep = await ecrire(6 * 1024 * 1024);
    expect(vi.mocked(sauvegarde).mock.calls.map((c) => c[1])).toEqual(["decks/comite.pptx"]);
    expect(rep.valeur).toMatchObject({ history_kept: false, backup: "/work/decks/comite.pptx.bak" });
  });

  it("ancienne version gardée par l'historique : pas de copie", async () => {
    const rep = await ecrire(1024);
    expect(vi.mocked(sauvegarde)).not.toHaveBeenCalled();
    expect(rep.valeur).toMatchObject({ history_kept: true });
    expect(rep.valeur).not.toHaveProperty("backup");
  });
});
