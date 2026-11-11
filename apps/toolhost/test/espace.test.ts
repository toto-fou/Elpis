// SPDX-License-Identifier: MIT
/** apps/toolhost/test/espace.test.ts — espace d'un compte et relevé des changements d'une commande contre le vrai agent Python (sans conteneur) : files_changed, historique de session, jumeau Unicode ; profil réseau partagé par les familles. */
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  definirFabriqueAgent,
  getUserSandbox,
  profilDuBac,
  profilReseauEffectif,
  resetUserSandboxCache,
} from "@elpis/bac";
import { surchargerConfig } from "@elpis/config";
import { AgentClient, fileEntry } from "@elpis/fichiers";
import { avecIdentite, creerIdentite } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  avecChangements,
  compterDiff,
  contenuRendu,
  FENETRE_MAX_MS,
  NOTE_CONCURRENTE,
  statsLignes,
  WorkChanges,
} from "../src/mcp/changements";
import { brancherRappelProfil, Espace, installerFabriqueEspace } from "../src/mcp/espace";
import { BacTest, dossierTemporaire, PYTHON } from "../../../packages/fichiers/test/aides";

let racine: string;
let nettoyer: () => void;
let bac: BacTest;

beforeEach(() => {
  [racine, nettoyer] = dossierTemporaire("elpis-espace-");
  bac = new BacTest(racine, "alice");
  vi.stubEnv("APP_FILE_HISTORY_DIR", path.join(racine, "fh"));
  installerFabriqueEspace(async () => new Espace(bac.sandboxPath, 7, new AgentClient(bac)));
});

afterEach(async () => {
  installerFabriqueEspace(null);
  brancherRappelProfil(null);
  vi.unstubAllEnvs();
  await bac.arreter();
  nettoyer();
});

describe("aides pures du relevé", () => {
  it("contenu rendu par l'agent : base64 strict, absent, trop gros, inconnu", () => {
    expect(Buffer.from(contenuRendu({ b64: "YWI=" }) as Uint8Array).toString()).toBe("ab");
    expect(typeof contenuRendu({ b64: "YW=I" })).toBe("symbol");
    expect(contenuRendu({ state: "absent" })).toBeNull();
    expect(String(contenuRendu({ state: "too_big" }))).toContain("TOO_BIG");
    expect(String(contenuRendu(null))).toContain("UNKNOWN");
  });

  it("statistiques +/- : hors UTF-8 → null, en-têtes +++/--- (et lignes qui leur ressemblent) non comptés", () => {
    expect(statsLignes(Buffer.from("a\nb\n"), Buffer.from("a\nc\nd\n"))).toEqual([2, 1]);
    expect(statsLignes(Buffer.from([0xff]), Buffer.from("x"))).toBeNull();
    expect(compterDiff(["x"], ["++y", "z"])).toEqual([1, 1]);
  });
});

describe("relevés chevauchés du même compte (harnais N-10)", () => {
  it("chaque fenêtre ouverte pendant une autre est marquée ; un autre compte, une fenêtre close ou oubliée (1 h) non", async () => {
    installerFabriqueEspace(async () => {
      throw new Error("pas de bac");
    });
    const ouvrir = (u: string) => new WorkChanges(7, u, "shell").entrer();
    const a = await ouvrir("alice");
    const b = await ouvrir("alice");
    const autre = await ouvrir("bob");
    expect([a.concurrent, b.concurrent, autre.concurrent]).toEqual([true, true, false]);
    await a.sortir();
    await b.sortir();
    await autre.sortir();
    const seul = await ouvrir("alice");
    await seul.sortir();
    expect(seul.concurrent).toBe(false);
    const t0 = Date.now();
    const oubliee = await ouvrir("carol");
    const horloge = vi.spyOn(Date, "now").mockReturnValue(t0 + FENETRE_MAX_MS + 60_000);
    try {
      const tardive = await ouvrir("carol");
      expect([oubliee.concurrent, tardive.concurrent]).toEqual([false, false]);
      await tardive.sortir();
    } finally {
      horloge.mockRestore();
      await oubliee.sortir();
    }
  });
});

describe.skipIf(!PYTHON)("relevé d'une commande (agent réel)", () => {
  it("créé, modifié, supprimé : files_changed, total, historique de session", async () => {
    writeFileSync(path.join(bac.sandboxPath, "a.txt"), "un\ndeux\n");
    writeFileSync(path.join(bac.sandboxPath, "b.txt"), "x\n");
    const wc = await new WorkChanges(7, "alice", "shell").entrer();
    writeFileSync(path.join(bac.sandboxPath, "a.txt"), "un\ntrois\nquatre\n");
    writeFileSync(path.join(bac.sandboxPath, "c.txt"), "neuf\n");
    unlinkSync(path.join(bac.sandboxPath, "b.txt"));
    await wc.sortir();
    const res = wc.attach<Record<string, unknown>>({ ok: true });
    const parChemin = Object.fromEntries(
      (res["files_changed"] as Record<string, unknown>[]).map((e) => [e["path"], e]),
    );
    expect(parChemin["/work/a.txt"]).toMatchObject({ change: "modified", lines_added: 2, lines_removed: 1 });
    expect(parChemin["/work/c.txt"]).toMatchObject({
      change: "created",
      old_sha256: null,
      lines_added: 1,
      lines_removed: 0,
    });
    expect(parChemin["/work/b.txt"]).toMatchObject({ change: "deleted", new_sha256: null });
    expect(parChemin["/work/b.txt"]).not.toHaveProperty("lines_added");
    expect(res).not.toHaveProperty("files_changed_total");
    const entree = await fileEntry(7, "a.txt");
    expect(JSON.stringify(entree?.["versions"])).toContain('"source":"shell"');
  });

  it("fenêtres chevauchées : files_changed de chacune avec la note et l'attribution incertaine ; seule, renommage exact sans l'une ni l'autre (harnais N-10)", async () => {
    writeFileSync(path.join(bac.sandboxPath, "r1.txt"), "r\n");
    const a = await new WorkChanges(7, "alice", "shell").entrer();
    const b = await new WorkChanges(7, "alice", "git").entrer();
    writeFileSync(path.join(bac.sandboxPath, "s1.txt"), "a\n");
    writeFileSync(path.join(bac.sandboxPath, "s2.txt"), "b\n");
    await b.sortir();
    await a.sortir();
    for (const w of [a, b]) {
      const r = w.attach<Record<string, unknown>>({ ok: true });
      expect(r["files_changed_note"]).toBe(NOTE_CONCURRENTE);
      expect(r["files_changed_attribution"]).toBe("uncertain");
      expect((r["files_changed"] as Record<string, unknown>[]).map((e) => e["path"])).toEqual([
        "/work/s1.txt",
        "/work/s2.txt",
      ]);
    }
    const seul = await new WorkChanges(7, "alice", "shell").entrer();
    renameSync(path.join(bac.sandboxPath, "r1.txt"), path.join(bac.sandboxPath, "r2.txt"));
    await seul.sortir();
    const r = seul.attach<Record<string, unknown>>({ ok: true });
    expect(r).not.toHaveProperty("files_changed_note");
    expect(r).not.toHaveProperty("files_changed_attribution");
    expect((r["files_changed"] as Record<string, unknown>[]).map((e) => [e["path"], e["change"]])).toEqual([
      ["/work/r1.txt", "deleted"],
      ["/work/r2.txt", "created"],
    ]);
  });

  it("liens et fichiers spéciaux (harnais B-10) : créés, cible changée, supprimés, avec leur type ; sans historique ; lien sortant jamais suivi", async () => {
    const w = (p: string): string => path.join(bac.sandboxPath, p);
    mkdirSync(w("y"));
    mkdirSync(path.join(racine, "dehors"));
    writeFileSync(path.join(racine, "dehors", "secret.txt"), "s");
    symlinkSync("a", w("y/vieux"));
    symlinkSync("b", w("y/parti"));
    const wc = await new WorkChanges(7, "alice", "shell").entrer();
    writeFileSync(w("y/r.txt"), "r\n");
    symlinkSync("r.txt", w("y/l1"));
    symlinkSync(path.join(racine, "dehors"), w("y/sortant"));
    unlinkSync(w("y/vieux"));
    symlinkSync("c", w("y/vieux"));
    unlinkSync(w("y/parti"));
    execFileSync(
      PYTHON as string,
      ["-c", "import os,socket; os.mkfifo('f1'); socket.socket(socket.AF_UNIX).bind('s1')"],
      { cwd: w("y") },
    );
    await wc.sortir();
    const res = wc.attach<Record<string, unknown>>({ ok: true });
    expect(res["files_changed"]).toEqual([
      { path: "/work/y/f1", change: "created", type: "fifo" },
      { path: "/work/y/l1", change: "created", type: "symlink", target: "r.txt" },
      { path: "/work/y/parti", change: "deleted", type: "symlink", target: "b" },
      expect.objectContaining({ path: "/work/y/r.txt", change: "created", lines_added: 1 }),
      { path: "/work/y/s1", change: "created", type: "socket" },
      { path: "/work/y/sortant", change: "created", type: "symlink", target: path.join(racine, "dehors") },
      { path: "/work/y/vieux", change: "modified", type: "symlink", target: "c", old_target: "a" },
    ]);
    expect(JSON.stringify(res)).not.toContain("secret");
    expect(await fileEntry(7, "y/l1")).toBeNull();
    expect(JSON.stringify((await fileEntry(7, "y/r.txt"))?.["versions"])).toContain('"source":"shell"');
  });

  it("relevé raté (agent arrêté) : la commande aboutit, pas de files_changed", async () => {
    installerFabriqueEspace(async () => {
      throw new Error("pas de bac");
    });
    const r = await avecChangements(
      "shell",
      async () => [7, "alice"],
      async () => ({ ok: true, sortie: 1 }),
    );
    expect(r).toEqual({ ok: true, sortie: 1 });
  });

  it("jumeau Unicode : nom voisin qui ne diffère que par les accents ou la casse", async () => {
    writeFileSync(path.join(bac.sandboxPath, "Résumé.md"), "x");
    const esp = await Espace.pour("alice");
    expect(await esp.jumeauUnicode("resume.md")).toContain("Résumé.md");
    expect(await esp.jumeauUnicode("autre.md")).toBeNull();
    expect(await esp.jumeauUnicode("Résumé.md")).toBeNull();
    rmSync(path.join(bac.sandboxPath, "Résumé.md"));
  });
});

describe("profil réseau partagé (fs, shell, git) : même bac, pas de recréation", () => {
  const rappel = (profil: string | null, actif = true) => ({
    actif,
    appels: [] as string[],
    async identityForUsername(u: string) {
      this.appels.push(u);
      if (profil === "panne") throw new Error("injoignable");
      return profil === null ? null : { network_profile_id: profil };
    },
  });

  it("imposition de l'enveloppe, profil de l'identité, main par rappel, puis « isolated »", async () => {
    const r = rappel("open");
    const id = (champs: Partial<Parameters<typeof creerIdentite>[0]>) =>
      creerIdentite({ user_id: 9, username: "zoe", ...champs });
    expect(
      await avecIdentite(id({ forced_network_profile_id: "lan", network_profile_id: "web" }), () =>
        profilReseauEffectif(9, "zoe", r),
      ),
    ).toBe("lan");
    expect(
      await avecIdentite(id({ forced_network_profile_id: "", network_profile_id: "web" }), () =>
        profilReseauEffectif(9, "zoe", r),
      ),
    ).toBe("web");
    expect(r.appels).toEqual([]);
    expect(await avecIdentite(id({ username: "Zoé.raw" }), () => profilReseauEffectif(9, "zoe", r))).toBe(
      "open",
    );
    expect(r.appels).toEqual(["Zoé.raw"]);
    expect(await profilReseauEffectif(1234567, "x", rappel(null))).toBe("isolated");
    expect(await profilReseauEffectif(1234567, "x", rappel("panne"))).toBe("isolated");
    expect(await profilReseauEffectif(1234567, "x", rappel("open", false))).toBe("isolated");
  });

  it("l'espace fs par défaut et le bac d'une autre famille : même instance, même profil, conteneur non revérifié", async () => {
    const restaurer = surchargerConfig({ SANDBOX_DIR: path.join(racine, "sb") });
    definirFabriqueAgent((b) => new AgentClient(b));
    installerFabriqueEspace(null);
    const r = rappel("web");
    brancherRappelProfil(r);
    try {
      const ident = creerIdentite({ user_id: 41, username: "bob", forced_network_profile_id: "" });
      const esp = await avecIdentite(ident, () => Espace.pour("bob"));
      expect(esp.uid).toBe(41);
      expect(esp.racine).toBe(path.join(racine, "sb", "bob", "work"));
      const sb = getUserSandbox(41, "bob", esp.racine);
      expect(sb.networkProfileId).toBe("web");
      sb.configVerified = true;
      const autre = await avecIdentite(ident, async () =>
        getUserSandbox(41, "bob", esp.racine, await profilDuBac(41, "bob", r)),
      );
      expect(autre).toBe(sb);
      expect(autre.configVerified).toBe(true);
      await avecIdentite(ident, () => Espace.pour("bob"));
      expect(sb.configVerified).toBe(true);
    } finally {
      resetUserSandboxCache(41);
      definirFabriqueAgent(null);
      restaurer();
    }
  });
});
