// SPDX-License-Identifier: MIT
/** packages/bac/test/arbre-bac.test.ts — arbre d'un bac vu de l'hôte d'outils : dossier de l'agent en 01777 rechmodé seulement s'il le faut et qu'il est à ce compte, montages refusés avec un compte par service si un lien ou un autre compte peut changer l'arbre, marqueurs lus et écrits sans suivre de lien. */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { brancherJournal, journalStderr } from "@elpis/commun";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dossierAgentPret, exigerMontagesSurs, ExecError } from "../src/conteneur";
import { ecrireMarqueur, lireMarqueur } from "../src/travail";
import { dossierTemporaire } from "./aides";

const espions = vi.hoisted(() => ({ chmod: vi.fn(), refus: { actif: false } }));

/** chmodSync et fchmodSync tracés ; « autre compte » simulé : ils lèvent EPERM, comme pour un dossier qui n'est pas à ce compte. */
vi.mock("node:fs", async (importOriginal) => {
  const reel = await importOriginal<Record<string, unknown>>();
  const enveloppe =
    (nom: string) =>
    (cible: unknown, mode: number): void => {
      espions.chmod(nom, mode);
      if (espions.refus.actif) throw Object.assign(new Error(`EPERM: ${nom}`), { code: "EPERM" });
      (reel[nom] as (c: unknown, m: number) => void)(cible, mode);
    };
  const chmodSync = enveloppe("chmodSync");
  const fchmodSync = enveloppe("fchmodSync");
  return {
    ...reel,
    default: { ...(reel["default"] as object), chmodSync, fchmodSync },
    chmodSync,
    fchmodSync,
  };
});

const DEMARRAGE_IMPOSSIBLE = "La sandbox ne peut pas démarrer. Demandez à votre administrateur.";
let tmp = "";
let nettoyer: () => void = () => undefined;
let avertis: string[] = [];

const mode = (p: string): number => statSync(p).mode & 0o7777;
/** Le processus se voit sous un autre compte que celui des dossiers de l'essai, qui ne se laissent plus rechmoder. */
const autreCompte = (): void => {
  const moi = process.geteuid?.() ?? 0;
  vi.spyOn(process, "geteuid").mockReturnValue(moi + 1);
  espions.refus.actif = true;
};

beforeEach(() => {
  [tmp, nettoyer] = dossierTemporaire("elpis-bac-arbre-");
  avertis = [];
  espions.chmod.mockClear();
  espions.refus.actif = false;
  brancherJournal((d) => ({ ...journalStderr(d), warn: (...a: unknown[]) => avertis.push(a.join(" ")) }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  espions.refus.actif = false;
  brancherJournal(null);
  nettoyer();
});

describe("dossierAgentPret", () => {
  it("absent : créé en 01777", () => {
    const d = path.join(tmp, ".elpis-agent");
    dossierAgentPret(d);
    expect(mode(d)).toBe(0o1777);
  });

  it("déjà en 01777, à un autre compte : aucun chmod tenté", () => {
    const d = path.join(tmp, ".elpis-agent");
    mkdirSync(d);
    chmodSync(d, 0o1777);
    espions.chmod.mockClear();
    autreCompte();
    dossierAgentPret(d);
    expect(espions.chmod).not.toHaveBeenCalled();
    expect([mode(d), avertis]).toEqual([0o1777, []]);
  });

  it("à ce compte, en 0700 ou en 0777 : remis en 01777", () => {
    const d = path.join(tmp, ".elpis-agent");
    mkdirSync(d);
    for (const m of [0o700, 0o777]) {
      chmodSync(d, m);
      espions.chmod.mockClear();
      dossierAgentPret(d);
      expect([mode(d), espions.chmod.mock.calls]).toEqual([0o1777, [["fchmodSync", 0o1777]]]);
    }
  });

  it("à un autre compte, pas en 01777 : refus sobre, installateur à relancer au journal, aucun chmod tenté", () => {
    const d = path.join(tmp, ".elpis-agent");
    mkdirSync(d);
    chmodSync(d, 0o777);
    espions.chmod.mockClear();
    autreCompte();
    expect(() => dossierAgentPret(d)).toThrow(new ExecError(DEMARRAGE_IMPOSSIBLE));
    expect(espions.chmod).not.toHaveBeenCalled();
    expect(mode(d)).toBe(0o777);
    expect(avertis).toHaveLength(1);
    expect(avertis[0]).toContain(`${d} en 0777 au lieu de 1777`);
    expect(avertis[0]).toContain("relancez sudo ./elpis service install");
  });

  it("lien à la place du dossier : refusé, sa cible intacte", () => {
    const cible = path.join(tmp, "ailleurs");
    mkdirSync(cible);
    chmodSync(cible, 0o700);
    const d = path.join(tmp, ".elpis-agent");
    symlinkSync(cible, d);
    espions.chmod.mockClear();
    expect(() => dossierAgentPret(d)).toThrow(ExecError);
    expect(espions.chmod).not.toHaveBeenCalled();
    expect(mode(cible)).toBe(0o700);
  });
});

describe("exigerMontagesSurs", () => {
  let S = "";
  let P = "";

  /** Arbre d'un compte tel que l'installation le laisse : `<S>` et `<P>` en 2750, /work, dossier de l'agent, relais. */
  beforeEach(() => {
    S = path.join(tmp, "bacs");
    P = path.join(S, "alice");
    for (const d of [path.join(P, "work"), path.join(P, ".elpis-agent"), path.join(S, ".elpis-relay")])
      mkdirSync(d, { recursive: true });
    for (const d of [S, P]) chmodSync(d, 0o2750);
    vi.stubEnv("ELPIS_GROUPE_DONNEES", String(process.getgid?.() ?? 0));
  });

  const refuse = (): string => {
    expect(() => exigerMontagesSurs(path.join(P, "work"), S)).toThrow(new ExecError(DEMARRAGE_IMPOSSIBLE));
    expect(avertis.at(-1)).toContain("relancez sudo ./elpis service install");
    return avertis.at(-1) ?? "";
  };

  it("arbre de ce compte, sans lien : montages permis", () => {
    exigerMontagesSurs(path.join(P, "work"), S);
    expect(avertis).toEqual([]);
  });

  it("racine ou dossier du compte inscriptibles par le groupe ou les autres : refusé", () => {
    for (const [d, m] of [
      [S, 0o2770],
      [P, 0o2770],
      [P, 0o2757],
    ] as const) {
      chmodSync(d, m);
      expect(refuse()).toContain("modifiable par un autre compte");
      chmodSync(d, 0o2750);
    }
  });

  it("dossier du compte à un autre compte : refusé", () => {
    vi.spyOn(process, "geteuid").mockReturnValue((process.geteuid?.() ?? 0) + 1);
    if (statSync(P).uid !== 0) expect(refuse()).toContain("modifiable par un autre compte");
  });

  it("lien à la place du dossier du compte, de /work, du dossier de l'agent ou du relais : refusé", () => {
    const ailleurs = path.join(tmp, "ailleurs");
    mkdirSync(ailleurs);
    for (const d of [path.join(P, "work"), path.join(P, ".elpis-agent"), path.join(S, ".elpis-relay"), P]) {
      const garde = `${d}.garde`;
      renameSync(d, garde);
      symlinkSync(ailleurs, d);
      expect(refuse()).toContain("lien ou entrée inattendue");
      unlinkSync(d);
      renameSync(garde, d);
    }
    exigerMontagesSurs(path.join(P, "work"), S);
  });

  it("/work hors de `<S>/<compte>/work` : refusé ; compte unique : aucun contrôle", () => {
    mkdirSync(path.join(tmp, "autre", "work"), { recursive: true });
    expect(() => exigerMontagesSurs(path.join(tmp, "autre", "work"), S)).toThrow(
      new ExecError(DEMARRAGE_IMPOSSIBLE),
    );
    expect(avertis.at(-1)).toContain("hors de");
    vi.unstubAllEnvs();
    symlinkSync(path.join(tmp, "ailleurs-absent"), path.join(S, "lien"));
    exigerMontagesSurs(path.join(S, "lien", "work"), S);
  });
});

describe("marqueurs de P", () => {
  it("lus et écrits sans suivre de lien ; fichier spécial ou lien : absent pour la lecture, refusé pour l'écriture", () => {
    const m = path.join(tmp, ".work-modes-v1");
    expect(lireMarqueur(m)).toBeNull();
    ecrireMarqueur(m, "10001:10001");
    expect(lireMarqueur(m)?.toString("utf8")).toBe("10001:10001");
    ecrireMarqueur(m, "1");
    expect(readFileSync(m, "utf8")).toBe("1");
    const cible = path.join(tmp, "cible");
    writeFileSync(cible, "intact");
    const lien = path.join(tmp, ".work-migrated");
    symlinkSync(cible, lien);
    expect(lireMarqueur(lien)).toBeNull();
    expect(() => ecrireMarqueur(lien, "1")).toThrow();
    const fifo = path.join(tmp, "fifo");
    execFileSync("mkfifo", [fifo]);
    expect(lireMarqueur(fifo)).toBeNull();
    expect(() => ecrireMarqueur(fifo, "1")).toThrow();
    expect(readFileSync(cible, "utf8")).toBe("intact");
  });
});
