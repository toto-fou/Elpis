// SPDX-License-Identifier: MIT
/** packages/securite/test/confinement.test.ts — accès par descripteurs aux parties de P qui appartiennent à l'hôte (paths.py) : aucun lien suivi, fichiers spéciaux refusés sans être ouverts, dossiers traversés sans droit de lecture. */
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
  constants,
  existsSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ecrireSous,
  ErreurCheminBac,
  modeEntree,
  ouvrirDossierSous,
  ouvrirFeuille,
  parcourirSous,
  rouvrir,
  saisirEntree,
  supprimerArbreSous,
} from "../src/confinement";

let racine: string;

beforeEach(() => {
  racine = mkdtempSync(path.join(tmpdir(), "elpis-confinement-"));
});

afterEach(() => {
  rmSync(racine, { recursive: true, force: true });
});

function lire(fd: number): string {
  const b = Buffer.alloc(4096);
  const n = readSync(fd, b, 0, b.length, 0);
  closeSync(fd);
  return b.subarray(0, n).toString();
}

/** Lecture gardée : dossier sans suivre de lien, puis la feuille (fichier régulier seulement). */
function ouvrir(rel: string): number {
  const i = rel.lastIndexOf("/");
  const dfd = ouvrirDossierSous(racine, i < 0 ? "" : rel.slice(0, i));
  try {
    return ouvrirFeuille(dfd, rel.slice(i + 1));
  } finally {
    closeSync(dfd);
  }
}

describe("primitives par descripteurs", () => {
  it("lien, FIFO et socket refusés sans être ouverts ; fichier régulier lu", async () => {
    writeFileSync(path.join(racine, "f.txt"), "ok");
    symlinkSync("/etc", path.join(racine, "lien"));
    spawnSync("mkfifo", [path.join(racine, "fifo")]);
    const s = createServer();
    await new Promise<void>((ok) => s.listen(path.join(racine, "sock"), ok));
    try {
      expect(lire(ouvrir("f.txt"))).toBe("ok");
      for (const mauvais of ["lien", "lien/hostname", "fifo", "sock"])
        expect(() => closeSync(ouvrir(mauvais)), mauvais).toThrow();
      expect(() => ouvrir("lien/hostname")).toThrow(ErreurCheminBac);
    } finally {
      await new Promise((ok) => s.close(ok));
    }
  });

  it("antislash : un caractère de nom, jamais un séparateur", () => {
    mkdirSync(path.join(racine, "d"));
    writeFileSync(path.join(racine, "d", "f"), "autre");
    ecrireSous(racine, "d\\f", Buffer.from("bon"));
    expect(lire(ouvrir("d\\f"))).toBe("bon");
    expect(readFileSync(path.join(racine, "d", "f"), "utf-8")).toBe("autre");
  });

  it("dossier traversé sans droit de lecture (O_PATH) ; listé seulement s'il est ouvert lisible", () => {
    mkdirSync(path.join(racine, "priv", "pub"), { recursive: true });
    writeFileSync(path.join(racine, "priv", "pub", "f"), "x");
    chmodSync(path.join(racine, "priv"), 0o311);
    try {
      expect(lire(ouvrir("priv/pub/f"))).toBe("x");
      const fd = ouvrirDossierSous(racine, "priv/pub", { lisible: true });
      try {
        expect(readdirSync(`/proc/self/fd/${fd}`)).toEqual(["f"]);
      } finally {
        closeSync(fd);
      }
    } finally {
      chmodSync(path.join(racine, "priv"), 0o755);
    }
  });

  it("l'écriture ne traverse aucun lien ; dossiers créés au mode demandé", () => {
    symlinkSync(path.dirname(racine), path.join(racine, "lien"));
    expect(() => ecrireSous(racine, "lien/x.txt", Buffer.from("x"))).toThrow(ErreurCheminBac);
    expect(existsSync(path.join(path.dirname(racine), "x.txt"))).toBe(false);
    ecrireSous(racine, "a/b/c.txt", Buffer.from("c"), { modeDossier: 0o700 });
    expect(modeEntree(ouvrirDossierSous(racine), "a") & 0o777).toBe(0o700);
  });

  it("open_path_at, reopen, leaf_mode, open_leaf(allow_dir)", () => {
    mkdirSync(path.join(racine, "d"));
    writeFileSync(path.join(racine, "d", "f"), "contenu");
    symlinkSync("f", path.join(racine, "d", "l"));
    const dfd = ouvrirDossierSous(racine, "d");
    try {
      const pfd = saisirEntree(dfd, "l");
      try {
        expect(() => rouvrir(pfd)).toThrow();
      } finally {
        closeSync(pfd);
      }
      const ffd = saisirEntree(dfd, "f");
      expect(lire(rouvrir(ffd, constants.O_RDONLY))).toBe("contenu");
      closeSync(ffd);
      expect(modeEntree(dfd, "l") & constants.S_IFMT).toBe(constants.S_IFLNK);
      expect(modeEntree(dfd, "absent")).toBe(0);
      expect(() => ouvrirFeuille(ouvrirDossierSous(racine), "d")).toThrow("Is a directory");
      const r = ouvrirDossierSous(racine);
      const dossier = ouvrirFeuille(r, "d", { dossierPermis: true });
      expect(readdirSync(`/proc/self/fd/${dossier}`).sort()).toEqual(["f", "l"]);
      closeSync(dossier);
      closeSync(r);
    } finally {
      closeSync(dfd);
    }
  });

  it("walk_beneath : un lien vers un dossier n'est ni descendu ni rendu (os.fwalk le classe en dossier, puis il est élagué)", () => {
    mkdirSync(path.join(racine, "a", "b"), { recursive: true });
    writeFileSync(path.join(racine, "a", "b", "f"), "");
    symlinkSync("/etc", path.join(racine, "a", "vers-etc"));
    const vus = [...parcourirSous(racine)].map((d) => [
      d.relDir,
      [...d.dossiers].sort(),
      [...d.fichiers].sort(),
    ]);
    expect(vus).toEqual([
      ["", ["a"], []],
      ["a", ["b"], []],
      ["a/b", [], ["f"]],
    ]);
  });
});

describe("suppression par descripteurs (shutil.rmtree, _rmtree_safe_fd)", () => {
  /** Arbre `P/work` à supprimer et dossier « hôte » voisin qui doit survivre. */
  function arbre(): [string, string] {
    const travail = path.join(racine, "P", "work");
    const hote = path.join(racine, "hote");
    mkdirSync(path.join(travail, "a", "b"), { recursive: true });
    mkdirSync(path.join(travail, "sous"));
    writeFileSync(path.join(travail, "a", "b", "f"), "x");
    writeFileSync(path.join(travail, "sous", "g"), "y");
    mkdirSync(hote);
    writeFileSync(path.join(hote, "precieux"), "z");
    symlinkSync(hote, path.join(travail, "a", "vers-hote"));
    return [travail, hote];
  }

  it("arbre supprimé, lien interne retiré sans être suivi", async () => {
    const [travail, hote] = arbre();
    await supprimerArbreSous(travail);
    expect(existsSync(travail)).toBe(false);
    expect(readFileSync(path.join(hote, "precieux"), "utf8")).toBe("z");
  });

  it("dossier échangé contre un lien vers l'hôte entre le listage et l'ouverture : le lien est retiré, l'hôte intact", async () => {
    const [travail, hote] = arbre();
    const fs = createRequire(import.meta.url)("node:fs") as { promises: Record<string, unknown> };
    const original = fs.promises["readdir"] as (...a: unknown[]) => Promise<{ name: Buffer | string }[]>;
    let echange = false;
    fs.promises["readdir"] = async (...a: unknown[]) => {
      const r = await original(...a);
      if (!echange && r.some((e) => e.name.toString() === "sous")) {
        echange = true;
        rmSync(path.join(travail, "sous"), { recursive: true });
        symlinkSync(hote, path.join(travail, "sous"));
      }
      return r;
    };
    syncBuiltinESMExports();
    try {
      await supprimerArbreSous(travail);
    } finally {
      fs.promises["readdir"] = original;
      syncBuiltinESMExports();
    }
    expect(echange).toBe(true);
    expect(existsSync(travail)).toBe(false);
    expect(readdirSync(hote)).toEqual(["precieux"]);
  });

  it("nom hors UTF-8 supprimé tel quel ; entrée disparue en cours de route ignorée", async () => {
    const [travail] = arbre();
    writeFileSync(Buffer.concat([Buffer.from(`${travail}/f`), Buffer.from([0xff]), Buffer.from("g")]), "x");
    writeFileSync(path.join(travail, "h"), "x");
    const fs = createRequire(import.meta.url)("node:fs") as { promises: Record<string, unknown> };
    const original = fs.promises["readdir"] as (...a: unknown[]) => Promise<{ name: Buffer | string }[]>;
    fs.promises["readdir"] = async (...a: unknown[]) => {
      const r = await original(...a);
      if (r.some((e) => e.name.toString() === "sous")) {
        rmSync(path.join(travail, "sous"), { recursive: true });
        rmSync(path.join(travail, "h"));
      }
      return r;
    };
    syncBuiltinESMExports();
    try {
      await supprimerArbreSous(travail);
    } finally {
      fs.promises["readdir"] = original;
      syncBuiltinESMExports();
    }
    expect(existsSync(travail)).toBe(false);
  });

  it("refus : l'erreur porte le chemin réel, pas /proc/self/fd", async () => {
    const [travail] = arbre();
    chmodSync(path.join(travail, "sous"), 0o500);
    try {
      await expect(supprimerArbreSous(travail)).rejects.toMatchObject({
        code: "EACCES",
        path: path.join(travail, "sous", "g"),
      });
    } finally {
      chmodSync(path.join(travail, "sous"), 0o700);
    }
  });
});
