// SPDX-License-Identifier: MIT
/** frontend/test/admin/horodatage.test.ts — les formateurs paresseux donnent la même sortie que `toLocaleString` (à lancer sous TZ=Europe/Paris et TZ=UTC ; séries autour des changements d'heure). */
import { describe, expect, it } from "vitest";

import { nombre, octets } from "../../src/features/admin/formats";
import { courtLocal, formateurDate, heureLocale, heureCourte } from "../../src/features/admin/horodatage";

const SERIE = [
  0.5, 1, 1762513800, 1711846799, 1711846800, 1730008799, 1730008800, 1735689599, 1735689600, 1709251200,
  1782864000, 1767225600, 1774915200, 1700000000,
];

describe("formateurs de date", () => {
  it("heureLocale et heureCourte égalent l'ancien toLocaleString", () => {
    for (const ts of SERIE) {
      const d = new Date(ts * 1000);
      expect(heureLocale(ts)).toBe(d.toLocaleString("fr-FR", { hour12: false }));
      expect(heureCourte(ts)).toBe(d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }));
      expect(courtLocal(ts * 1000)).toBe(heureCourte(ts));
    }
  });

  it("les autres formats de la console égalent l'ancien code", () => {
    const heure = formateurDate({ hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const jourHeure = formateurDate({ day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    const court = formateurDate({ timeStyle: "short" });
    for (const ts of SERIE) {
      const d = new Date(ts * 1000);
      expect(heure(d)).toBe(
        d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      );
      expect(jourHeure(d)).toBe(
        d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
      );
      expect(court(d)).toBe(d.toLocaleTimeString("fr-FR", { timeStyle: "short" }));
      expect(formateurDate({ year: "numeric", month: "numeric", day: "numeric" })(d)).toBe(
        d.toLocaleDateString("fr-FR"),
      );
    }
  });

  it("nombre et octets égalent l'ancien toLocaleString", () => {
    for (const n of [0, 1, 999, 1284, 1234567, 1536, 5 * 1024 ** 3 + 123456]) {
      expect(nombre(n)).toBe(n.toLocaleString("fr-FR"));
    }
    expect(octets(1536)).toBe("1,5 Kio");
    expect(octets(10)).toBe("10 o");
  });

  it("valeurs vides ou illisibles", () => {
    expect(heureLocale(0)).toBe("");
    expect(heureCourte("x")).toBe("—");
  });
});
