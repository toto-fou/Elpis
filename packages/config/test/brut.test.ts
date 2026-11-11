// SPDX-License-Identifier: MIT
/** packages/config/test/brut.test.ts — emplacement de config.json (et son repli), lecture tolérante, JSON et chemins à la Python. */
import { DOSSIER_TEST } from "./environnement";

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { ErreurPython } from "@elpis/commun";

import {
  existePy,
  getPy,
  lireTextePy,
  parseJsonPy,
  readJsonFile,
  realpathPy,
  resolveConfigJsonPath,
} from "../src/brut";

afterAll(() => {
  rmSync(DOSSIER_TEST, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function dossier(): string {
  return realpathSync(mkdtempSync(path.join(DOSSIER_TEST, "brut-")));
}

function racineSimulee(): { racine: string; ancien: string } {
  const racine = dossier();
  const ancien = path.join(racine, "shared_infra");
  mkdirSync(ancien);
  return { racine, ancien };
}

function sortieStandard(): { texte: () => string } {
  let texte = "";
  vi.spyOn(process.stdout, "write").mockImplementation(((morceau: string) => {
    texte += morceau;
    return true;
  }) as typeof process.stdout.write);
  return { texte: () => texte };
}

describe("emplacement de config.json", () => {
  it("la racine du dépôt est le défaut", () => {
    const { racine } = racineSimulee();
    writeFileSync(path.join(racine, "config.json"), "{}");
    expect(resolveConfigJsonPath({}, racine)).toBe(path.join(racine, "config.json"));
  });

  it("un config.json resté sous shared_infra/ n'est plus lu, sans avertissement", () => {
    const { racine, ancien } = racineSimulee();
    writeFileSync(path.join(ancien, "config.json"), '{"security": {}}');
    const sortie = sortieStandard();
    expect(resolveConfigJsonPath({}, racine)).toBe(path.join(racine, "config.json"));
    expect(sortie.texte()).toBe("");
  });

  it("APP_CONFIG_PATH prime sur tout ; un lien est résolu, un relatif part du dossier courant", () => {
    const { racine, ancien } = racineSimulee();
    writeFileSync(path.join(racine, "config.json"), "{}");
    writeFileSync(path.join(ancien, "config.json"), "{}");
    const ailleurs = path.join(dossier(), "ailleurs.json");
    writeFileSync(ailleurs, "{}");
    const lien = path.join(dossier(), "lien.json");
    symlinkSync(ailleurs, lien);
    expect(resolveConfigJsonPath({ APP_CONFIG_PATH: ailleurs }, racine)).toBe(ailleurs);
    expect(resolveConfigJsonPath({ APP_CONFIG_PATH: lien }, racine)).toBe(ailleurs);
    expect(resolveConfigJsonPath({ APP_CONFIG_PATH: "x/../y.json" }, racine)).toBe(
      path.join(realpathSync(process.cwd()), "y.json"),
    );
  });

  it("absent des deux côtés : la racine fait foi", () => {
    const { racine } = racineSimulee();
    expect(resolveConfigJsonPath({ APP_CONFIG_PATH: "" }, racine)).toBe(path.join(racine, "config.json"));
  });
});

describe("lecture tolérante de config.json", () => {
  const ecrire = (contenu: string | Buffer): string => {
    const fichier = path.join(dossier(), "config.json");
    writeFileSync(fichier, contenu);
    return fichier;
  };

  it("{} si le fichier manque, n'est pas du JSON ou pas un objet", () => {
    expect(readJsonFile(path.join(dossier(), "absent.json"))).toEqual({});
    expect(readJsonFile(ecrire("{ pas du json"))).toEqual({});
    expect(readJsonFile(ecrire("[1, 2]"))).toEqual({});
    expect(readJsonFile(ecrire("null"))).toEqual({});
    expect(readJsonFile(dossier())).toEqual({});
  });

  it("refuse un BOM et un UTF-8 invalide, comme open(encoding='utf-8') + json.load", () => {
    expect(readJsonFile(ecrire(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])))).toEqual({});
    expect(readJsonFile(ecrire(Buffer.from('{"a": "\xff"}', "latin1")))).toEqual({});
  });

  it("accepte NaN et les infinis que Python écrit et relit", () => {
    const donnees = readJsonFile(ecrire('{"a": NaN, "b": [Infinity, -Infinity], "c": "x"}'));
    expect(donnees).toEqual({ a: Number.NaN, b: [Infinity, -Infinity], c: "x" });
  });

  it("clé en double : la dernière valeur l'emporte ; __proto__ reste une clé", () => {
    const donnees = readJsonFile(ecrire('{"a": 1, "__proto__": {"x": 1}, "a": 2, "n": NaN}'));
    expect(donnees["a"]).toBe(2);
    expect(Object.hasOwn(donnees, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(donnees)).toBe(Object.prototype);
  });
});

describe("analyseur JSON de Python (repli de JSON.parse)", () => {
  it("NaN, Infinity et -Infinity seulement en position de valeur", () => {
    expect(parseJsonPy("[NaN, Infinity, -Infinity]")).toEqual([Number.NaN, Infinity, -Infinity]);
    for (const texte of [
      "{NaN: 1}",
      "[-NaN]",
      "[infinity]",
      "[1, NaN,]",
      '{"a": NaN,}',
      "[NaN] x",
      "[01, NaN]",
    ]) {
      expect(() => parseJsonPy(texte), texte).toThrow(SyntaxError);
    }
  });

  it("échappements, demi-paires et caractères de contrôle comme json.loads", () => {
    const resultat = parseJsonPy('[NaN, "a\\u00e9\\n\\"b\\"\\/\\ud83d\\ude00", "\\ud800"]') as unknown[];
    expect(resultat[1]).toBe(`aé\n"b"/${String.fromCodePoint(0x1f600)}`);
    expect(resultat[2]).toBe(String.fromCharCode(0xd800));
    expect(() => parseJsonPy('[NaN, "a\tb"]')).toThrow(SyntaxError);
    expect(() => parseJsonPy('[NaN, "\\x41"]')).toThrow(SyntaxError);
  });

  it("objets et listes imbriqués, blancs JSON seulement", () => {
    expect(parseJsonPy(' \r\n{"a": [1, {"b": -Infinity}], "c": {}}\t')).toEqual({
      a: [1, { b: -Infinity }],
      c: {},
    });
    expect(() => parseJsonPy(" {}")).toThrow(SyntaxError);
  });
});

describe("chemins à la Python", () => {
  it("realpathPy suit les liens, relatifs ou absolus, et traite .. après résolution", () => {
    const base = dossier();
    mkdirSync(path.join(base, "reel", "sous"), { recursive: true });
    symlinkSync("reel/sous", path.join(base, "lien"));
    symlinkSync(path.join(base, "reel"), path.join(base, "abs"));
    expect(realpathPy(path.join(base, "lien"))).toBe(path.join(base, "reel", "sous"));
    expect(realpathPy(`${base}/lien/../x`)).toBe(path.join(base, "reel", "x"));
    expect(realpathPy(`${base}/abs/./sous//y`)).toBe(path.join(base, "reel", "sous", "y"));
    expect(realpathPy(`${base}/absent/../z`)).toBe(path.join(base, "z"));
  });

  it("une boucle de liens s'arrête sans lever", () => {
    const base = dossier();
    symlinkSync("b", path.join(base, "a"));
    symlinkSync("a", path.join(base, "b"));
    expect(realpathPy(path.join(base, "a", "x"))).toBe(path.join(base, "a", "x"));
  });

  it("un octet nul ou une demi-paire UTF-16 lèvent ValueError comme os.lstat", () => {
    expect(() => realpathPy("/tmp/a\0b")).toThrow(ErreurPython);
    expect(() => realpathPy(`/tmp/x${String.fromCharCode(0xd800)}`)).toThrow(ErreurPython);
  });

  it("les messages sont ceux de Python (position en points de code, chemin à demi-paire après un caractère hors BMP)", () => {
    expect(() => realpathPy("/tmp/base/a\0b")).toThrow("lstat: embedded null character in path");
    expect(() => realpathPy("/tmp/base/a\ud800b")).toThrow(
      "'utf-8' codec can't encode character '\\ud800' in position 11: surrogates not allowed",
    );
    expect(() => realpathPy("/tmp/\u{1F600}/\udfff")).toThrow(
      "'utf-8' codec can't encode character '\\udfff' in position 7: surrogates not allowed",
    );
  });
});

describe("existePy : Path.exists() de Python 3.13", () => {
  it("faux pour un chemin absent, sous un fichier, en boucle, ou non encodable", () => {
    const base = dossier();
    writeFileSync(path.join(base, "f"), "x");
    symlinkSync("boucle", path.join(base, "boucle"));
    expect(existePy(path.join(base, "f"))).toBe(true);
    expect(existePy(path.join(base, "absent"))).toBe(false);
    expect(existePy(path.join(base, "f", "sous"))).toBe(false);
    expect(existePy(path.join(base, "boucle"))).toBe(false);
    expect(existePy(`${base}/a\0b`)).toBe(false);
    expect(existePy(`${base}/${String.fromCharCode(0xdc80)}`)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    "un dossier illisible lève (l'import Python échoue au lieu de partir sur {})",
    () => {
      const base = dossier();
      const ferme = path.join(base, "ferme");
      mkdirSync(ferme);
      writeFileSync(path.join(ferme, "config.json"), '{"llama": {}}');
      chmodSync(ferme, 0o000);
      try {
        expect(() => existePy(path.join(ferme, "config.json"))).toThrow(
          expect.objectContaining({ code: "EACCES" }),
        );
        expect(() => readJsonFile(path.join(ferme, "config.json"))).toThrow();
      } finally {
        chmodSync(ferme, 0o700);
      }
    },
  );
});

describe("lecture de texte et dict.get", () => {
  it("lireTextePy : fins de ligne universelles, BOM gardé, UTF-8 strict", () => {
    const fichier = path.join(dossier(), "t.md");
    writeFileSync(fichier, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\r\nb\rc\n")]));
    expect(lireTextePy(fichier)).toBe(`${String.fromCharCode(0xfeff)}a\nb\nc\n`);
    writeFileSync(fichier, Buffer.from([0x61, 0xff]));
    expect(() => lireTextePy(fichier)).toThrow(ErreurPython);
    expect(() => lireTextePy(path.join(path.dirname(fichier), "absent"))).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("getPy lève AttributeError hors d'un dict", () => {
    expect(getPy({ a: 1 }, "a")).toBe(1);
    expect(getPy({ a: 1 }, "b", 2)).toBe(2);
    expect(getPy({}, "constructor")).toBeNull();
    for (const valeur of [null, [1], "texte", 3]) {
      expect(() => getPy(valeur, "a")).toThrow(ErreurPython);
    }
  });
});
