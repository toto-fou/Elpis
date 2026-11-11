// SPDX-License-Identifier: MIT
/** apps/core/test/outils/mcp/famille-skill-ecritures.test.ts — écritures des outils skill : verrou croisé avec les routes et avec un autre processus, bascule de l'entrée du manifeste. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { load, oublierManifeste } from "@elpis/mcp";
import { tenirParAutreProcessus } from "@elpis/verrous/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resoudreClientMcp } from "../../../src/outils/mcp/clients";
import {
  avecVerrouEcriture,
  discoverSkillsBySource,
  invalidateSkillsScanCache,
  saveUserSkill,
  SkillSaveError,
} from "../../../src/skills/bibliotheque";
import { rglob } from "../../../src/skills/chemins";
import { skillAddFile, skillGet, skillReadFile, skillSave } from "../../../src/skills/outils";
import type { AppelSkill } from "../../../src/skills/outils";
import { poserEnv } from "../../skills/arbre";

const dossiers: string[] = [];
const remises: (() => void)[] = [];

function racine(): string {
  const r = mkdtempSync(path.join(os.tmpdir(), "elpis-skill-ecritures-"));
  dossiers.push(r);
  remises.push(
    poserEnv({
      APP_SKILLS_DIR: path.join(r, "global"),
      APP_USER_SKILLS_DIR: path.join(r, "user_skills"),
      APP_SANDBOX_DIR: path.join(r, "sandboxes"),
      SKILLS_LOCK_PATH: path.join(r, ".skills_write.lock"),
      SKILLS_FILELOCK: "1",
    }),
  );
  return r;
}

function appel(username: string): AppelSkill & { infos: string[] } {
  const infos: string[] = [];
  return {
    username,
    infos,
    info: (m) => {
      infos.push(m);
      return Promise.resolve();
    },
  };
}

afterEach(() => {
  for (const r of remises.splice(0).reverse()) r();
  invalidateSkillsScanCache();
  for (const d of dossiers.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllEnvs();
  oublierManifeste();
});

const attendre = (ms: number): Promise<void> => new Promise((fin) => setTimeout(fin, ms));

describe("écriture sous le verrou des routes", () => {
  it("un écrivain de route qui tient le verrou fait attendre skill_save et skill_add_file", async () => {
    racine();
    let libere: () => void = () => undefined;
    const tenu = new Promise<void>((fin) => {
      libere = fin;
    });
    const route = avecVerrouEcriture(() => tenu);
    await attendre(50);
    let sauve = false;
    const a = appel("alice");
    const save = skillSave(
      { name: "attendu", description: "d", body: "corps", tags: null, domain: null },
      a,
    ).then((r) => {
      sauve = true;
      return r;
    });
    await attendre(200);
    expect(sauve).toBe(false);
    libere();
    await route;
    expect((await save)["ok"]).toBe(true);
    let ajoute = false;
    const route2 = avecVerrouEcriture(() => attendre(200));
    await attendre(30);
    const add = skillAddFile({ name: "attendu", path: "scripts/a.sh", content: "x" }, a).then((r) => {
      ajoute = true;
      return r;
    });
    await attendre(60);
    expect(ajoute).toBe(false);
    await route2;
    expect((await add)["ok"]).toBe(true);
  });

  it("outils et routes écrivent le même magasin en même temps : rien de perdu, aucun temporaire", async () => {
    const r = racine();
    const store = path.join(r, "user_skills", "alice");
    const a = appel("alice");
    const outils = async (): Promise<void> => {
      for (let i = 0; i < 8; i++) {
        await skillSave({ name: `outil-${i}`, description: "d", body: `c${i}`, tags: null, domain: null }, a);
        await skillSave(
          { name: "partage", description: `outil ${i}`, body: `outil ${i}`, tags: null, domain: null },
          a,
        );
      }
    };
    const routes = async (): Promise<void> => {
      for (let i = 0; i < 8; i++) {
        await saveUserSkill(store, `route-${i}`, "d", `c${i}`, ["t"]);
        await saveUserSkill(store, "partage", `route ${i}`, `route ${i}`, []);
      }
    };
    await Promise.all([outils(), routes()]);
    invalidateSkillsScanCache();
    const ids = (await discoverSkillsBySource("user", store)).map((s) => s.id).sort();
    expect(ids).toEqual(
      [
        "partage",
        ...Array.from({ length: 8 }, (_v, i) => `outil-${i}`),
        ...Array.from({ length: 8 }, (_v, i) => `route-${i}`),
      ].sort(),
    );
    expect(await rglob(store, (n) => n.endsWith(".tmp") || n.endsWith(".lock"))).toEqual([]);
  }, 60_000);

  it("même erreur d'écriture : français pour l'interface (message), anglais pour le modèle (outil)", async () => {
    const r = racine();
    const store = path.join(r, "user_skills", "alice");
    const erreur = await saveUserSkill(store, "vide", "d", "").catch((e: unknown) => e);
    expect(erreur).toBeInstanceOf(SkillSaveError);
    expect((erreur as SkillSaveError).message).toBe("body requis (la procédure ne peut pas être vide)");
    const res = await skillSave(
      { name: "vide", description: "d", body: "", tags: null, domain: null },
      appel("alice"),
    );
    expect(res).toMatchObject({
      error: "skill_save_rejected",
      message: "body required (the procedure cannot be empty)",
    });
  });

  it("nom inconnu : les 3 noms les plus proches dans `fix`, champs null de l'enveloppe inchangés (B-20)", async () => {
    const r = racine();
    const store = path.join(r, "user_skills", "alice");
    const a = appel("alice");
    for (const n of ["jenkins-deploy", "jenkins-build", "docker-clean"])
      await saveUserSkill(store, n, "d", "corps");
    for (const res of [
      await skillGet({ name: "jenkins-deplo" }, a),
      await skillReadFile({ name: "jenkins-deplo", path: "scripts/x.sh" }, a),
    ]) {
      expect(res["error"]).toBe("skill_not_found");
      expect(String(res["fix"])).toMatch(/Closest names: jenkins-deploy/);
      expect(res).toMatchObject({ next_action: null, retryable: null });
    }
    expect((await skillGet({ name: "zzzzzz" }, a))["fix"]).toBe("Use a name present in the skills index.");
  });

  it("une écriture de route est vue tout de suite par skill_get (cache de scan invalidé), et réciproquement", async () => {
    const r = racine();
    const store = path.join(r, "user_skills", "alice");
    const a = appel("alice");
    expect((await skillGet({ name: "via-route" }, a))["error"]).toBe("skill_not_found");
    await saveUserSkill(store, "via-route", "d", "écrit par la route");
    expect(await skillGet({ name: "via-route" }, a)).toMatchObject({ ok: true, body: "écrit par la route" });
    await skillSave(
      { name: "via-outil", description: "d", body: "écrit par l'outil", tags: null, domain: null },
      a,
    );
    expect((await discoverSkillsBySource("user", store)).map((s) => s.id).sort()).toEqual([
      "via-outil",
      "via-route",
    ]);
  });

  it(
    "un autre processus qui tient .skills_write.lock fait attendre skill_save (verrou de fichier commun)",
    { timeout: 60_000 },
    async () => {
      const r = racine();
      const detenteur = await tenirParAutreProcessus(
        path.join(r, ".skills_write.lock"),
        path.join(r, "compteur"),
        1.5,
      );
      const debut = performance.now();
      const res = await skillSave(
        { name: "attendu", description: "d", body: "corps", tags: null, domain: null },
        appel("alice"),
      );
      expect(performance.now() - debut).toBeGreaterThanOrEqual(800);
      expect(res["ok"]).toBe(true);
      expect(await detenteur.fin).toBe(0);
    },
  );
});

describe("entrée du manifeste : bascule en processus et retour arrière", () => {
  function manifeste(entree: Record<string, unknown>): void {
    const dossier = mkdtempSync(path.join(os.tmpdir(), "elpis-skill-manifeste-"));
    dossiers.push(dossier);
    writeFileSync(
      path.join(dossier, "mcp.json"),
      JSON.stringify({ version: 1, mcpServers: { "elpis-skill": entree } }),
    );
    vi.stubEnv("APP_MCP_MANIFEST", path.join(dossier, "mcp.json"));
    oublierManifeste();
  }
  const X = { "x-elpis": { role: "app", families: ["skill"] } };
  const RESEAU = {
    type: "http",
    url: "http://127.0.0.1:8766/mcp/skill",
    headers: { Authorization: "Bearer jeton-de-service" },
  };

  it.each([
    ["sans url ni type", X],
    ["type inprocess explicite", { type: "inprocess", ...X }],
  ])("%s : entrée inprocess, sans réseau", (_nom, entree) => {
    manifeste(entree);
    const e = load().get("elpis-skill");
    expect([e?.type, e?.isNetwork]).toEqual(["inprocess", false]);
  });

  it("entrée app avec une URL réseau : client HTTP, plus de client en processus", () => {
    manifeste({ ...X, ...RESEAU });
    const e = load().get("elpis-skill");
    expect([e?.type, e?.isNetwork]).toEqual(["http", true]);
    expect(resoudreClientMcp(e?.clientCfg() ?? {})?.constructor.name).toBe("ClientMcpHttp");
  });
});
