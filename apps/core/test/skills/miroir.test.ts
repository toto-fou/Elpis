// SPDX-License-Identifier: MIT
/** apps/core/test/skills/miroir.test.ts — magasin perso par compte, migration de l'ancien emplacement et miroir sandbox poussé par le relais après une mutation. */
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { surchargerConfig } from "@elpis/config";
import { avecIdentite, creerIdentite, forgetAll, remember } from "@elpis/securite";

import { saveUserSkill, syncUserMirror, userSandboxRoot, userSkillsDir } from "../../src/skills/bibliotheque";
import { pousserMiroir, uidDuMagasin } from "../../src/skills/miroir-distant";
import { skillAddFile, skillSave } from "../../src/skills/outils";
import { installerComptesSkills } from "../../src/skills/ports";
import { empreinteArbre, poserEnv } from "./arbre";

const pousse = vi.hoisted(() => vi.fn(async (_uid: number, _dossier: string) => true));
vi.mock("../../src/relais/services", () => ({ pushSkillsMirror: pousse }));

const dossiers: string[] = [];
const remises: (() => void)[] = [];
let racine = "";

beforeEach(async () => {
  racine = await mkdtemp(path.join(os.tmpdir(), "elpis-skills-miroir-"));
  dossiers.push(racine);
  remises.push(
    surchargerConfig({ USER_SKILLS_DIR: path.join(racine, "user_skills") }),
    poserEnv({
      APP_SKILLS_DIR: path.join(racine, "global"),
      SKILLS_LOCK_PATH: `${racine}.skills_write.lock`,
    }),
  );
  installerComptesSkills({
    nomUtilisateur: async (uid) => (uid === 1 ? "Jean.Dupont" : null),
    racineSandbox: async (uid) => path.join(racine, "sandbox", String(uid)),
  });
  pousse.mockClear();
});

afterEach(() => {
  installerComptesSkills(null);
  forgetAll();
  pousse.mockImplementation(async () => true);
  for (const r of remises.splice(0).reverse()) r();
});

afterAll(async () => {
  await Promise.all(dossiers.map((d) => rm(d, { recursive: true, force: true })));
});

describe("magasin perso et miroir", () => {
  it("magasin USER_SKILLS_DIR/<nom sûr> ; « user_<uid> » si le compte est inconnu ; null sans uid", async () => {
    expect(await userSkillsDir(1)).toBe(path.join(racine, "user_skills", "JeanDupont"));
    expect(await userSkillsDir(7)).toBe(path.join(racine, "user_skills", "user_7"));
    expect(await userSkillsDir(null)).toBeNull();
    expect(await userSandboxRoot(1)).toBe(path.join(racine, "sandbox", "1"));
  });

  it("migre une fois l'ancien <sandbox>/skills vers le magasin puis régénère le miroir", async () => {
    await mkdir(path.join(racine, "sandbox", "1", "skills"), { recursive: true });
    await writeFile(
      path.join(racine, "sandbox", "1", "skills", "vieux.md"),
      "---\nname: vieux\n---\nAncien\n",
    );
    const store = await userSkillsDir(1);
    expect(store).toBe(path.join(racine, "user_skills", "JeanDupont"));
    expect(await readFile(path.join(store ?? "", "vieux.md"), "utf8")).toBe(
      "---\nname: vieux\n---\nAncien\n",
    );
    expect(await readFile(path.join(racine, "sandbox", "1", "skills", "vieux.md"), "utf8")).toContain(
      "Ancien",
    );
  });

  it("après une mutation : miroir local reconstruit et magasin poussé vers l'hôte d'outils", async () => {
    const store = (await userSkillsDir(1)) ?? "";
    await saveUserSkill(store, "Mon skill", "d", "corps", ["t"]);
    await syncUserMirror(1);
    expect(await empreinteArbre(path.join(racine, "sandbox", "1", "skills"))).toEqual(
      await empreinteArbre(store),
    );
    expect(pousse).toHaveBeenCalledWith(1, store);
  });

  it("sans port de comptes ni uid : rien n'est lu ni poussé, sans lever", async () => {
    installerComptesSkills(null);
    expect(await userSkillsDir(1)).toBeNull();
    await syncUserMirror(1);
    await syncUserMirror(null);
    expect(pousse).not.toHaveBeenCalled();
  });
});

/** Promesse résolue de l'extérieur. */
function differe(): { promesse: Promise<boolean>; resoudre: (v: boolean) => void } {
  let resoudre: (v: boolean) => void = () => undefined;
  const promesse = new Promise<boolean>((r) => {
    resoudre = r;
  });
  return { promesse, resoudre };
}

describe("miroir de l'hôte distant : un envoi à la fois par compte", () => {
  it("les demandes faites pendant un envoi n'en font qu'un, du dernier état ; un autre compte n'attend pas", async () => {
    const enCours = differe();
    pousse.mockImplementationOnce(() => enCours.promesse);
    const premier = pousserMiroir(41, "/m/v1");
    await vi.waitFor(() => expect(pousse).toHaveBeenCalledWith(41, "/m/v1"));
    const deuxieme = pousserMiroir(41, "/m/v2");
    const troisieme = pousserMiroir(41, "/m/v3");
    expect(troisieme).toBe(deuxieme);
    expect(deuxieme).not.toBe(premier);
    const autre = pousserMiroir(42, "/m/autre");
    await vi.waitFor(() => expect(pousse).toHaveBeenCalledWith(42, "/m/autre"));
    expect(pousse.mock.calls.filter(([u]) => u === 41)).toEqual([[41, "/m/v1"]]);
    enCours.resoudre(true);
    expect(await premier).toBe(true);
    expect(await deuxieme).toBe(true);
    expect(await autre).toBe(true);
    expect(pousse.mock.calls.filter(([u]) => u === 41)).toEqual([
      [41, "/m/v1"],
      [41, "/m/v3"],
    ]);
  });

  it("un échec de l'envoi rend faux sans casser la file du compte", async () => {
    pousse.mockRejectedValueOnce(new Error("hôte injoignable"));
    expect(await pousserMiroir(43, "/m/a")).toBe(false);
    expect(await pousserMiroir(43, "/m/b")).toBe(true);
    expect(pousse).toHaveBeenLastCalledWith(43, "/m/b");
  });

  it("skill_save et skill_add_file poussent le magasin du compte résolu, sans attendre l'envoi", async () => {
    vi.stubEnv("APP_SANDBOX_DIR", path.join(racine, "sb"));
    vi.stubEnv("APP_USER_SKILLS_DIR", path.join(racine, "user_skills"));
    remember(creerIdentite({ user_id: 9, username: "alice" }));
    const enCours = differe();
    pousse.mockImplementationOnce(() => enCours.promesse);
    const appel = { username: "alice", info: async () => undefined };
    const r = await skillSave({ name: "proc", description: "d", body: "B", tags: null, domain: null }, appel);
    expect(r["ok"]).toBe(true);
    const magasin = path.join(racine, "user_skills", "alice");
    await vi.waitFor(() => expect(pousse).toHaveBeenCalledWith(9, magasin));
    const ajout = await skillAddFile({ name: "proc", path: "scripts/run.sh", content: "echo ok\n" }, appel);
    expect(ajout["ok"]).toBe(true);
    expect(pousse).toHaveBeenCalledTimes(1);
    enCours.resoudre(true);
    await vi.waitFor(() => expect(pousse).toHaveBeenCalledTimes(2));
    expect(pousse).toHaveBeenLastCalledWith(9, magasin);
    vi.unstubAllEnvs();
  });

  it("login replié en nom sûr (« Jean.Dupont » → JeanDupont) : compte de l'appel, jamais l'homonyme « JeanDupont »", async () => {
    remember(creerIdentite({ user_id: 99, username: "JeanDupont" }));
    remember(creerIdentite({ user_id: 12, username: "Jean.Dupont" }));
    expect(await uidDuMagasin("JeanDupont", "Jean.Dupont")).toBe(12);
    const appelant = creerIdentite({ user_id: 12, username: "Jean.Dupont" });
    expect(await avecIdentite(appelant, () => uidDuMagasin("JeanDupont", null))).toBe(12);
    expect(await uidDuMagasin("JeanDupont", "autre.compte")).toBe(99);
    expect(
      await avecIdentite(creerIdentite({ user_id: 5, username: "bob" }), () => uidDuMagasin("alice", null)),
    ).toBe(0);
    vi.stubEnv("APP_SANDBOX_DIR", path.join(racine, "sb"));
    vi.stubEnv("APP_USER_SKILLS_DIR", path.join(racine, "user_skills"));
    const r = await avecIdentite(appelant, () =>
      skillSave(
        { name: "proc", description: "d", body: "B", tags: null, domain: null },
        { username: "JeanDupont", login: "Jean.Dupont", info: async () => undefined },
      ),
    );
    expect(r["ok"]).toBe(true);
    await vi.waitFor(() =>
      expect(pousse).toHaveBeenCalledWith(12, path.join(racine, "user_skills", "JeanDupont")),
    );
    vi.unstubAllEnvs();
  });

  it("compte inconnu (uid 0) : rien n'est poussé", async () => {
    vi.stubEnv("APP_SANDBOX_DIR", path.join(racine, "sb"));
    vi.stubEnv("APP_USER_SKILLS_DIR", path.join(racine, "user_skills"));
    const r = await skillSave(
      { name: "proc", description: "d", body: "B", tags: null, domain: null },
      { username: "inconnu", info: async () => undefined },
    );
    expect(r["ok"]).toBe(true);
    await new Promise((fin) => setTimeout(fin, 50));
    expect(pousse).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
