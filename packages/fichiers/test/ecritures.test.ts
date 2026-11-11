// SPDX-License-Identifier: MIT
/** packages/fichiers/test/ecritures.test.ts — écritures de l'éditeur par l'agent (exec_bridge.py) : refus traduits en HTTP, chemins validés avant l'agent, opérations sur le vrai agent. */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { HttpError } from "@elpis/commun";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentClient, AgentError } from "../src/agent";
import {
  agentHttp,
  sandboxAppendChunk,
  sandboxClear,
  sandboxCopy,
  sandboxDelete,
  sandboxMkdir,
  sandboxRename,
  sandboxStatMtime,
  sandboxWriteBytes,
  sandboxWriteText,
  validateRelPath,
} from "../src/ecritures";
import { BacTest, dossierTemporaire, PYTHON } from "./aides";

async function http(p: Promise<unknown>): Promise<[number, unknown]> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError) return [e.statusCode, e.detail];
    throw e;
  }
  throw new Error("HttpError attendue");
}

describe("traduction des refus et validation des chemins", () => {
  it("agent_http : pannes 503, réponse invalide 502, délai 504, table, inconnu 500", () => {
    const t = (code: string): [number, unknown] => {
      const e = agentHttp(new AgentError(code, "m"), "Sauvegarde");
      return [e.statusCode, e.detail];
    };
    for (const c of ["agent_unavailable", "container_down", "transport"])
      expect(t(c)).toEqual([
        503,
        "Environnement sandbox arrêté — nouvelle tentative dans quelques instants.",
      ]);
    expect(t("bad_response")).toEqual([502, "Sauvegarde : réponse invalide de l'environnement sandbox"]);
    expect(t("timeout")).toEqual([504, "Sauvegarde : délai dépassé"]);
    expect(t("not_found")).toEqual([404, "Introuvable"]);
    expect(t("changed")).toEqual([412, { code: "conflict", message: "Le fichier a changé sur le disque" }]);
    expect(t("no_space")).toEqual([507, "Espace disque de la sandbox épuisé"]);
    expect(t("quoi")).toEqual([500, "Sauvegarde : quoi"]);
    expect(t("__proto__")).toEqual([500, "Sauvegarde : __proto__"]);
  });

  it("_validate_rel_path : vide, absolu, `..` ; forme /work ramenée au relatif", () => {
    const refus = (x: unknown): [number, unknown] => {
      try {
        validateRelPath(x);
      } catch (e) {
        if (e instanceof HttpError) return [e.statusCode, e.detail];
      }
      return [0, null];
    };
    expect(refus("")).toEqual([400, "Chemin requis"]);
    expect(refus(" /work ")).toEqual([400, "Chemin requis"]);
    expect(refus(5)).toEqual([400, "Chemin requis"]);
    expect(refus("/etc/passwd")).toEqual([400, "Chemin absolu refusé — utiliser un chemin relatif"]);
    expect(refus("\\x")).toEqual([400, "Chemin absolu refusé — utiliser un chemin relatif"]);
    expect(refus("a/../b")).toEqual([403, "Chemin avec '..' refusé"]);
    expect(refus("a\\..\\b")).toEqual([403, "Chemin avec '..' refusé"]);
    expect(validateRelPath("/work/src/x")).toBe("src/x");
    expect(validateRelPath("./work/a b")).toBe("a b");
  });
});

describe.skipIf(!PYTHON)("par le vrai agent", () => {
  let racine: string;
  let nettoyer: () => void;
  let bac: BacTest;
  let agent: AgentClient;

  beforeEach(() => {
    [racine, nettoyer] = dossierTemporaire("elpis-ecritures-");
    bac = new BacTest(racine);
    agent = new AgentClient(bac);
  });

  afterEach(async () => {
    await bac.arreter();
    nettoyer();
  });

  it("écritures, ajout par morceaux, dossiers, renommage, copie, suppression, vidage, mtime", async () => {
    const w = (p: string): string => path.join(bac.sandboxPath, p);
    await sandboxWriteText(agent, "/work/d/a.txt", "été\n");
    expect(readFileSync(w("d/a.txt"), "utf-8")).toBe("été\n");
    expect(await http(sandboxWriteText(agent, "b.txt", "x\ud800"))).toEqual([
      400,
      "Contenu invalide (caractère non encodable)",
    ]);
    await sandboxWriteBytes(agent, "c.bin", Buffer.from([0, 1, 2]));
    expect(await sandboxAppendChunk(agent, "up/x.part", Buffer.from("ab"), { truncate: true })).toBe(2);
    expect(await sandboxAppendChunk(agent, "up/x.part", Buffer.from("cde"), { truncate: false })).toBe(5);
    expect(
      (await http(sandboxAppendChunk(agent, "absent.part", Buffer.from("z"), { truncate: false })))[0],
    ).toBe(404);
    await sandboxMkdir(agent, "e/f");
    expect(statSync(w("e/f")).isDirectory()).toBe(true);
    expect(await http(sandboxRename(agent, "c.bin", "d"))).toEqual([409, "Un élément porte déjà ce nom"]);
    await sandboxRename(agent, "up/x.part", "up/x");
    writeFileSync(w("up/y"), "vieux");
    await sandboxRename(agent, "up/x", "up/y", { overwrite: true });
    expect(readFileSync(w("up/y"), "utf-8")).toBe("abcde");
    await sandboxCopy(agent, "d", "d2");
    expect(readFileSync(w("d2/a.txt"), "utf-8")).toBe("été\n");
    for (const racineAlias of ["/work", "work", "./work", "", " . "])
      expect(await http(sandboxDelete(agent, racineAlias))).toEqual([400, "Cible invalide pour suppression"]);
    await sandboxDelete(agent, "d2");
    await sandboxDelete(agent, "d2");
    const mtime = await sandboxStatMtime(agent, "d/a.txt");
    expect(mtime).toBeCloseTo(statSync(w("d/a.txt")).mtimeMs / 1000, 2);
    expect(await sandboxStatMtime(agent, "absent")).toBeNull();
    expect(await sandboxClear(agent, 1)).toBeGreaterThan(0);
    expect(await sandboxStatMtime(agent, "d/a.txt")).toBeNull();
  });

  it("conteneur arrêté : 503 de l'éditeur", async () => {
    bac.running = false;
    expect(await http(sandboxMkdir(agent, "x"))).toEqual([
      503,
      "Environnement sandbox arrêté — nouvelle tentative dans quelques instants.",
    ]);
  });
});
