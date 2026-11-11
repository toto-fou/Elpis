// SPDX-License-Identifier: MIT
/** packages/securite/test/chiffrement-publication.test.ts — publication de la clé maître : fsync du dossier, création exclusive sans lien dur (`_publish_key`). */
import * as reel from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { Fernet, loadOrCreateKey } from "../src/chiffrement";
import { brancherJournal } from "../src/ports";
import { capturerJournal } from "./aides";

const etat = vi.hoisted(() => ({
  lien: null as ((cible: string) => void) | null,
  ecriture: null as Error | null,
  cible: "",
  ouverts: new Map<number, string>(),
  synchronises: [] as string[],
}));

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof reel>();
  const espion = {
    ...fs,
    linkSync: (a: reel.PathLike, b: reel.PathLike): void => {
      if (etat.lien) etat.lien(String(b));
      else fs.linkSync(a, b);
    },
    openSync: (p: reel.PathLike, drapeaux?: reel.OpenMode, mode?: reel.Mode): number => {
      const fd = fs.openSync(p, drapeaux ?? "r", mode);
      etat.ouverts.set(fd, String(p));
      return fd;
    },
    writeSync: (fd: number, ...r: [string]): number => {
      if (etat.ecriture && etat.ouverts.get(fd) === etat.cible) throw etat.ecriture;
      return fs.writeSync(fd, ...r);
    },
    fsyncSync: (fd: number): void => {
      etat.synchronises.push(etat.ouverts.get(fd) ?? "?");
      fs.fsyncSync(fd);
    },
  };
  return { ...espion, default: espion };
});

const dossiers: string[] = [];

function fichierNeuf(): string {
  const d = reel.mkdtempSync(join(tmpdir(), "elpis-cle-"));
  dossiers.push(d);
  etat.cible = join(d, ".encryption_key");
  return etat.cible;
}

function erreurOs(code: string): Error {
  return Object.assign(new Error(`${code}: simulé`), { code });
}

function lienImpossible(): never {
  throw erreurOs("EPERM");
}

afterEach(() => {
  Object.assign(etat, { lien: null, ecriture: null, cible: "", synchronises: [] });
  etat.ouverts.clear();
  brancherJournal(null);
});

afterAll(() => {
  for (const d of dossiers) reel.rmSync(d, { recursive: true, force: true });
});

describe("publication de la clé maître (_publish_key)", () => {
  it("lien posé : le dossier est synchronisé pour rendre l'entrée durable", () => {
    const fichierCle = fichierNeuf();
    capturerJournal();
    const cle = loadOrCreateKey({ fichierCle });
    expect(reel.readFileSync(fichierCle, "utf-8")).toBe(cle);
    expect(etat.synchronises.at(-1)).toBe(dirname(fichierCle));
  });

  it("sans lien dur (EPERM) : création exclusive 0600, dossier synchronisé, aucun temporaire", () => {
    const fichierCle = fichierNeuf();
    etat.lien = lienImpossible;
    const journal = capturerJournal();
    const cle = loadOrCreateKey({ fichierCle });
    expect(cle).toMatch(/^[A-Za-z0-9_-]{43}=$/);
    expect(() => new Fernet(cle ?? "")).not.toThrow();
    expect(reel.readFileSync(fichierCle, "utf-8")).toBe(cle);
    expect(reel.statSync(fichierCle).mode & 0o777).toBe(0o600);
    expect(etat.synchronises.slice(-2)).toEqual([fichierCle, dirname(fichierCle)]);
    expect(reel.readdirSync(dirname(fichierCle))).toEqual([".encryption_key"]);
    expect(journal.map(([niveau]) => niveau)).toEqual(["WARNING"]);
  });

  it("création exclusive interrompue : le fichier n'est jamais laissé vide, chiffrement indisponible", () => {
    const fichierCle = fichierNeuf();
    etat.lien = lienImpossible;
    etat.ecriture = erreurOs("ENOSPC");
    const journal = capturerJournal();
    expect(loadOrCreateKey({ fichierCle })).toBeNull();
    expect(reel.readdirSync(dirname(fichierCle))).toEqual([]);
    expect(journal.map(([niveau]) => niveau)).toEqual(["CRITICAL"]);
    expect(journal[0]?.[1]).toMatch(/Échec d'écriture de la clé de chiffrement .*ENOSPC/);
  });

  it("une clé posée par un autre entre-temps l'emporte (EEXIST), sans création journalisée", () => {
    const fichierCle = fichierNeuf();
    const autre = Fernet.generateKey();
    etat.lien = (cible) => {
      reel.writeFileSync(cible, autre);
      throw erreurOs("EEXIST");
    };
    const journal = capturerJournal();
    expect(loadOrCreateKey({ fichierCle })).toBe(autre);
    expect(journal).toEqual([]);
    expect(reel.readdirSync(dirname(fichierCle))).toEqual([".encryption_key"]);
  });
});
