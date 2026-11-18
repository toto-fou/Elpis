// SPDX-License-Identifier: MIT
/** apps/core/test/identite/annuaire/presets.test.ts — les quatre préréglages enregistrables sont acceptés par le validateur et rendent des filtres lisibles. */
import { describe, expect, it } from "vitest";

import { verifierFiltre } from "../../../src/identite/annuaire/client";
import { rendreFiltre } from "../../../src/identite/annuaire/filtre";
import { PRESETS, presetDe } from "../../../src/identite/annuaire/presets";
import type { IdPreset } from "../../../src/identite/annuaire/presets";
import { fournisseur } from "./faux";

describe("préréglages", () => {
  it("n'expose que les quatre identifiants attendus", () => {
    expect(Object.keys(PRESETS).sort()).toEqual(["active-directory", "freeipa", "openldap", "other"]);
  });

  it.each(Object.keys(PRESETS) as IdPreset[])(
    "%s : réglages acceptés par le validateur et filtre lisible",
    (id) => {
      const p = PRESETS[id];
      const f = fournisseur({ preset: id, user_filter: p.filtre, attrs: p.attrs, groups: { mode: p.mode } });
      expect(f.preset).toBe(id);
      verifierFiltre(rendreFiltre(p.filtre, "jdupont"));
    },
  );

  it("presetDe ignore un identifiant inconnu ou hérité de l'objet", () => {
    expect(presetDe("")).toBeUndefined();
    expect(presetDe("toString")).toBeUndefined();
    expect(presetDe("freeipa")?.famille).toBe("freeipa");
  });
});
