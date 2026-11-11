// SPDX-License-Identifier: MIT
/** apps/core/test/admin-config.test.ts — propriété des sections de config.json et égalités à la Python (admin/config.py). */
import { egalPy, FlottantPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { describe, expect, it } from "vitest";

import { applySectionOwnership, dig, plant, removePath, sameValue, touchesOwned } from "../src/admin/config";

describe("égalités", () => {
  it("`==` de Python : 1 == 1.0 == True, dicts sans ordre, NaN jamais égal, grands entiers exacts", () => {
    expect(egalPy(1, new FlottantPy(1))).toBe(true);
    expect(egalPy(true, 1)).toBe(true);
    expect(egalPy(false, new FlottantPy(0))).toBe(true);
    expect(egalPy(new FlottantPy(Number.NaN), new FlottantPy(Number.NaN))).toBe(false);
    expect(egalPy({ a: 1, b: [1, "x"] }, { b: [true, "x"], a: 1 })).toBe(true);
    expect(egalPy([1], [1, 1])).toBe(false);
    expect(egalPy(2n ** 64n, new FlottantPy(2 ** 64))).toBe(true);
    expect(egalPy(2n ** 53n + 1n, new FlottantPy(2 ** 53))).toBe(false);
    expect(egalPy("1", 1)).toBe(false);
    expect(egalPy(null, {})).toBe(false);
  });

  it("`_same_value` : True et 1 différents, nombres en flottants, le reste en JSON trié", () => {
    expect(sameValue(true, 1)).toBe(false);
    expect(sameValue(true, true)).toBe(true);
    expect(sameValue(3600, new FlottantPy(3600))).toBe(true);
    expect(sameValue({ b: 1, a: 2 }, { a: 2, b: 1 })).toBe(true);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    expect(sameValue(null, null)).toBe(true);
  });
});

describe("chemins", () => {
  it("dig, plant (intermédiaires remplacés) et removePath", () => {
    const d: Dict = { a: { b: 1 }, x: "texte" };
    expect(dig(d, ["a", "b"])).toEqual([true, 1]);
    expect(dig(d, ["x", "y"])).toEqual([false, null]);
    plant(d, ["x", "y", "z"], 2);
    expect(d).toEqual({ a: { b: 1 }, x: { y: { z: 2 } } });
    removePath(d, ["a", "b"]);
    removePath(d, ["absent", "b"]);
    expect(d).toEqual({ a: {}, x: { y: { z: 2 } } });
  });

  it("zones possédées : le chemin, un enfant ou un parent", () => {
    expect(touchesOwned(["security", "https"])).toBe(true);
    expect(touchesOwned(["security", "https", "enabled"])).toBe(true);
    expect(touchesOwned(["security"])).toBe(true);
    expect(touchesOwned(["security", "session", "max_age_sec"])).toBe(false);
    expect(touchesOwned(["image", "url"])).toBe(false);
  });
});

describe("propriété des sections", () => {
  it("le disque gagne sur les zones possédées, les sections préservées ne reviennent que si le formulaire ne les porte pas", () => {
    const disque: Dict = {
      security: { https: { enabled: true }, session: { https_only: true, global_min_ts: 12.5 } },
      llm: { compression: { enabled: true } },
      backup: { remote: {} },
      skins: {},
    };
    const entrant: Dict = {
      security: { https: { enabled: false }, session: { https_only: false, max_age_sec: 60 } },
      llm: { compression: { enabled: false } },
      backup: "",
    };
    expect(applySectionOwnership(entrant, disque)).toEqual([
      "security.https",
      "security.session.https_only",
      "security.session.global_min_ts",
      "backup",
    ]);
    expect(entrant).toEqual({
      security: {
        https: { enabled: true },
        session: { https_only: true, max_age_sec: 60, global_min_ts: 12.5 },
      },
      llm: { compression: { enabled: false } },
      backup: { remote: {} },
    });
  });

  it("instance neuve : rien à restaurer", () => {
    const entrant: Dict = { security: { https: { enabled: false } } };
    expect(applySectionOwnership(entrant, {})).toEqual([]);
  });
});
