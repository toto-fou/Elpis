// SPDX-License-Identifier: MIT
/** packages/contracts/test/emetteurs.test.ts — les clés posées par chaque émetteur Python (relevé AST) sont celles des schémas. */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { SCHEMAS_EVENEMENTS } from "../src/evenements";
import { STREAM_EVENT_TYPES } from "../src/stream-events.gen";
import type { StreamEventType } from "../src/stream-events.gen";

interface Releve {
  type: StreamEventType;
  fichier: string;
  ligne: number;
  cles: string[];
  ouvert: boolean;
  hors_fil?: string;
}

const { releves } = JSON.parse(
  readFileSync(new URL("./vecteurs/emetteurs.json", import.meta.url), "utf-8"),
) as {
  releves: Releve[];
};

interface Variante {
  cles: Set<string>;
  requises: Set<string>;
}

function variantes(type: StreamEventType): Variante[] {
  const schema = SCHEMAS_EVENEMENTS[type] as unknown as {
    options?: { shape: Record<string, z.ZodType> }[];
    shape?: Record<string, z.ZodType>;
  };
  const formes = schema.options?.map((o) => o.shape) ?? [schema.shape ?? {}];
  return formes.map((forme) => {
    const cles = Object.keys(forme).filter((k) => k !== "type" && k !== "_s");
    return {
      cles: new Set(cles),
      requises: new Set(cles.filter((k) => !forme[k]?.safeParse(undefined).success)),
    };
  });
}

function conforme(type: StreamEventType, cles: string[], ferme: boolean): boolean {
  return variantes(type).some(
    (v) => cles.every((k) => v.cles.has(k)) && (!ferme || [...v.requises].every((k) => cles.includes(k))),
  );
}

const surFil = releves.filter((r) => !r.hors_fil);

describe("émetteurs Python", () => {
  it.each(surFil.map((r) => [`${r.type} ${r.fichier}:${r.ligne}`, r] as const))("%s", (_n, r) => {
    expect(conforme(r.type, r.cles, !r.ouvert), JSON.stringify(r.cles)).toBe(true);
  });

  it("couvrent les types du registre (sinon dire pourquoi)", () => {
    const vus = new Set(surFil.map((r) => r.type));
    expect(STREAM_EVENT_TYPES.filter((t) => !vus.has(t))).toEqual([]);
  });
});

describe("événements final des goldens de route (clés relevées par le harnais)", () => {
  const dossier = new URL("../../../tests/goldens/", import.meta.url);
  const finals: [string, string[]][] = [];
  for (const f of readdirSync(dossier).filter((n) => n.startsWith("flux_route_"))) {
    const g = JSON.parse(readFileSync(new URL(f, dossier), "utf-8")) as Record<string, unknown>;
    for (const e of (g.evenements ?? []) as { type: string; cles?: string[] }[]) {
      if (e.type === "final" && e.cles) finals.push([f, e.cles.filter((k) => k !== "type")]);
    }
  }

  it("existent", () => expect(finals.length).toBeGreaterThan(5));

  it.each(finals)("%s", (_f, cles) => {
    expect(conforme("final", cles, true), JSON.stringify(cles)).toBe(true);
  });
});
