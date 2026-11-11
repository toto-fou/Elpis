// SPDX-License-Identifier: MIT
/** packages/contracts/test/evenements.test.ts — chaque type du registre a son schéma, et les goldens Python le respectent. */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { EVENEMENTS_INTERNES, SCHEMAS_EVENEMENTS, schemaEvenementFlux } from "../src/evenements";
import { schemasJson } from "../src/schemas";
import { STREAM_EVENT_TYPES } from "../src/stream-events.gen";

const GOLDENS = new URL("../../../tests/goldens/", import.meta.url);

// Champs retirés par le harnais Python (VOLATILS de goldens_harness.py) : rétablis pour valider la forme.
const VOLATILS: Readonly<Record<string, Record<string, number>>> = {
  tool_result: { duration_ms: 0 },
  prompt_progress: { time_ms: 0 },
  annotation_frame: { ts: 0 },
  image_progress: { elapsed_s: 0 },
};
// Événements simulés ou normalisés par tests/chatbot/test_flux_route.py : pas des formes du fil.
const SIMULES_ROUTE = new Set(["final", "queue_status", "tool_call", "tool_result"]);

type Evenement = { type: string } & Record<string, unknown>;

function evenementsGoldens(): [string, Evenement][] {
  const out: [string, Evenement][] = [];
  for (const f of readdirSync(GOLDENS)
    .filter((n) => n.endsWith(".json"))
    .sort()) {
    const contenu = JSON.parse(readFileSync(new URL(f, GOLDENS), "utf-8")) as Record<string, unknown>;
    if (Array.isArray(contenu)) continue;
    const route = f.startsWith("flux_route_");
    for (const cle of ["evenements", "evenements_avant_depart"]) {
      const liste = contenu[cle];
      if (!Array.isArray(liste)) continue;
      liste.forEach((e: Evenement, i) => {
        if (route && SIMULES_ROUTE.has(e.type)) return;
        out.push([`${f} › ${cle}[${i}] ${e.type}`, { ...VOLATILS[e.type], ...e }]);
      });
    }
  }
  return out;
}

describe("registre", () => {
  it("un schéma par type, avec son littéral", () => {
    expect(Object.keys(SCHEMAS_EVENEMENTS).sort()).toEqual([...STREAM_EVENT_TYPES].sort());
    expect([...EVENEMENTS_INTERNES].every((t) => (STREAM_EVENT_TYPES as readonly string[]).includes(t))).toBe(
      true,
    );
  });

  it("refuse un type hors registre et un champ inconnu", () => {
    expect(schemaEvenementFlux.safeParse({ type: "inconnu" }).success).toBe(false);
    expect(schemaEvenementFlux.safeParse({ type: "ping", extra: 1 }).success).toBe(false);
    expect(schemaEvenementFlux.safeParse({ type: "ping", _s: 3 }).success).toBe(true);
  });

  it("schémas JSON générés pour chaque type", () => {
    const s = schemasJson();
    for (const type of STREAM_EVENT_TYPES) expect(s[`evenement-${type}`]).toBeTypeOf("object");
    expect(JSON.stringify(s["evenement-flux"])).toContain("session_expired");
  });
});

const evenements = evenementsGoldens();

describe("goldens Python", () => {
  it("couvrent assez d'événements", () => {
    expect(evenements.length).toBeGreaterThan(250);
  });

  it.each(evenements)("%s", (_nom, e) => {
    const r = schemaEvenementFlux.safeParse(e);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
});
