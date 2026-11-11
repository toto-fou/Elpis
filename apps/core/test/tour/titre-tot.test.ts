// SPDX-License-Identifier: MIT
/** apps/core/test/tour/titre-tot.test.ts — titre du modèle d'un chat neuf : posé et diffusé dès son arrivée, gardé après un arrêt, jamais sur un renommage. */
import "../moteur-environnement";

import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CancelledError } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getChat, renameChat, upsertChat } from "../../src/chats/stockage";
import { cibleDuContexte } from "../../src/llm/cible";
import { viderAdmissionPourTests } from "../../src/tour/admission";
import { viderEtatPourTests } from "../../src/tour/etat";
import { reglerExecutionPourTests, runTurn } from "../../src/tour/execution";
import type { ReglagesExecution } from "../../src/tour/execution";
import { reglerJournalPourTests } from "../../src/tour/journal-run";
import { ouvrirTour } from "../../src/tour/ouverture";

const PROVISOIRE = "Bonjour, une question";

let t: BaseDeTest;
let dossier = "";

beforeEach(async () => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-titre-tot-"));
  chmodSync(dossier, 0o700);
  reglerJournalPourTests({ dossier: join(dossier, "runs"), balayage: false });
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  await t.base.run(
    "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES('alice', 's', 'h', 0, 0)",
  );
  await upsertChat(t.base, 1, "c1", "Nouveau chat", [], 100);
});

afterEach(async () => {
  await t.fermer();
  reglerExecutionPourTests(null);
  reglerJournalPourTests(null);
  viderEtatPourTests();
  viderAdmissionPourTests();
  rmSync(dossier, { recursive: true, force: true });
});

const titreEnBase = async (): Promise<unknown> => (await getChat(t.base, 1, "c1"))?.["title"];

async function attendreTitre(attendu: string): Promise<void> {
  for (let i = 0; i < 200 && (await titreEnBase()) !== attendu; i++)
    await new Promise((ok) => setTimeout(ok, 5));
}

/** Premier tour du chat neuf `c1` ; rend les événements du flux. */
async function tour(r: Partial<ReglagesExecution>): Promise<Dict[]> {
  reglerExecutionPourTests({
    etatFile: async () => ({ kind: "ready" }),
    contexteModele: async () => 0,
    admission: async (_o, fn) => fn(null),
    ...r,
  });
  const ouvert = await ouvrirTour({ base: t.base }, 1, {
    chat_id: "c1",
    resumable: true,
    messages: [{ role: "user", content: PROVISOIRE }],
  });
  const evs: Dict[] = [];
  const flux = runTurn({ base: t.base }, ouvert.plan, ouvert.res, ouvert.base, new AbortController().signal);
  for await (const ev of flux) evs.push(ev as Dict);
  return evs;
}

const promesseTitre = (): { p: Promise<string | null>; donner: (v: string) => void } => {
  let donner: (v: string) => void = () => undefined;
  const p = new Promise<string | null>((ok) => (donner = ok));
  return { p, donner };
};

describe("titre d'un chat neuf", () => {
  it("posé en base et diffusé pendant le tour, avant le final", async () => {
    let pendant: unknown = null;
    const evs = await tour({
      titre: async () => "Titre du modèle",
      boucle: async () => {
        await attendreTitre("Titre du modèle");
        pendant = await titreEnBase();
        return ["Bonjour.", [], {}];
      },
    });
    expect(pendant).toBe("Titre du modèle");
    const types = evs.map((e) => e["type"]);
    expect(evs).toContainEqual({ type: "title", chat_id: "c1", title: "Titre du modèle" });
    expect(types.indexOf("title")).toBeLessThan(types.indexOf("final"));
    expect(evs.at(-1)).toMatchObject({ type: "final", persisted: true, title: "Titre du modèle" });
    expect(await titreEnBase()).toBe("Titre du modèle");
  });

  it("arrêt avant l'arrivée du titre : le titre arrive ensuite et remplace le provisoire", async () => {
    const titre = promesseTitre();
    const evs = await tour({
      titre: () => titre.p,
      boucle: async () => {
        throw new CancelledError("stop");
      },
    });
    expect(evs.at(-1)).toMatchObject({ type: "final", cancelled: true, title: PROVISOIRE });
    expect(evs.some((e) => e["type"] === "title")).toBe(false);
    expect(await titreEnBase()).toBe(PROVISOIRE);
    titre.donner("Titre du modèle");
    await attendreTitre("Titre du modèle");
    expect(await titreEnBase()).toBe("Titre du modèle");
  });

  it("renommage pendant le tour : le titre du modèle ne l'écrase pas et n'est pas diffusé", async () => {
    const titre = promesseTitre();
    const evs = await tour({
      titre: () => titre.p,
      boucle: async () => {
        // La garde optimiste compare `updated_at` à la milliseconde : un renommage réel vient toujours après.
        await new Promise((ok) => setTimeout(ok, 5));
        await renameChat(t.base, 1, "c1", "Mon titre");
        titre.donner("Titre du modèle");
        await new Promise((ok) => setTimeout(ok, 20));
        return ["Bonjour.", [], {}];
      },
    });
    expect(evs.some((e) => e["type"] === "title")).toBe(false);
    expect(evs.at(-1)).toMatchObject({ type: "final", persisted: true });
    expect(await titreEnBase()).toBe("Mon titre");
  });

  it("titre demandé après la lecture de la file : sa requête n'y apparaît pas comme une attente du tour", async () => {
    const ordre: string[] = [];
    await tour({
      etatFile: async () => (ordre.push("file"), { kind: "ready" }),
      titre: async () => (ordre.push("titre"), "Titre du modèle"),
      boucle: async () => ["Bonjour.", [], {}],
    });
    expect(ordre).toEqual(["file", "titre"]);
  });

  it("titre demandé au moteur du tour, comme la boucle, et non au moteur par défaut", async () => {
    let cibleTitre: unknown;
    let cibleBoucle: unknown;
    await tour({
      titre: async () => ((cibleTitre = cibleDuContexte()), "Titre du modèle"),
      boucle: async () => ((cibleBoucle = cibleDuContexte()), ["Bonjour.", [], {}]),
    });
    expect(cibleTitre).not.toBeNull();
    expect(cibleTitre).toBe(cibleBoucle);
  });

  it("titre arrivé après le final : posé en base sans être diffusé", async () => {
    const titre = promesseTitre();
    const evs = await tour({ titre: () => titre.p, boucle: async () => ["Bonjour.", [], {}] });
    expect(evs.some((e) => e["type"] === "title")).toBe(false);
    expect(await titreEnBase()).toBe(PROVISOIRE);
    titre.donner("Titre du modèle");
    await attendreTitre("Titre du modèle");
    expect(await titreEnBase()).toBe("Titre du modèle");
  });
});
