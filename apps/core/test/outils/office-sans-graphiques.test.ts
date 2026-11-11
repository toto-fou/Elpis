// SPDX-License-Identifier: MIT
/** apps/core/test/outils/office-sans-graphiques.test.ts — outils Office sans mention des graphiques `!id` quand aucun `chart_*` n'est offert. */
import { describe, expect, it } from "vitest";

import golden from "@elpis/outils-mcp/goldens/office.json" with { type: "json" };

import { retirerGraphiquesOffice } from "../../src/outils/office-sans-graphiques";
import type { Dict } from "../../src/python";

const OFFICE: Dict[] = (golden.outils as Dict[]).map((o) => ({
  type: "function",
  function: { name: o["name"], description: o["description"], parameters: o["inputSchema"] },
}));
const CHART: Dict = {
  type: "function",
  function: { name: "chart_bar", description: "Bar chart", parameters: {} },
};

function texte(defs: Dict[]): string {
  return JSON.stringify(defs);
}

describe("retirerGraphiquesOffice", () => {
  it("sans chart_* : plus aucune référence !id ni outil chart_* dans les outils qui écrivent", () => {
    const sans = retirerGraphiquesOffice(OFFICE);
    const ecrivent = sans.filter((d) => /_(create|edit)$/.test(String((d["function"] as Dict)["name"])));
    expect(texte(ecrivent)).not.toMatch(/chart_|!id|!a1b2c3d4e5f6/);
    const pptx = sans.find((d) => (d["function"] as Dict)["name"] === "pptx_create") as Dict;
    const diapo = ((pptx["function"] as Dict)["parameters"] as Dict)["properties"] as Dict;
    const proprietes = ((diapo["slides"] as Dict)["items"] as Dict)["properties"] as Dict;
    expect(Object.keys(proprietes)).not.toContain("chart");
    expect((proprietes["layout"] as Dict)["enum"]).not.toContain("chart");
    expect((proprietes["layout"] as Dict)["enum"]).toContain("table");
    const docx = sans.find((d) => (d["function"] as Dict)["name"] === "docx_create") as Dict;
    expect(String((docx["function"] as Dict)["description"])).toContain("> [!NOTE] Title");
    expect(texte(sans.filter((d) => (d["function"] as Dict)["name"] === "pptx_read"))).toContain("charts");
  });

  it("avec un outil chart_* : définitions inchangées", () => {
    const avec = [...OFFICE, CHART];
    expect(retirerGraphiquesOffice(avec)).toBe(avec);
  });
});
