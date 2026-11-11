// SPDX-License-Identifier: MIT
/** apps/core/test/outils/integres/task/concurrence.test.ts — drapeau `concurrent` : traces gardées tant qu'un run actif peut les croiser, boucle parente comptée pour un enfant en fond seulement. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  debutBoucle,
  debutTrace,
  finTrace,
  oublierTraces,
  traceEnFond,
  tracesSuivies,
} from "../../../../src/outils/integres/task/concurrence";

const ecrivain = { type: "implement", read_only: false };
const MIN = 60_000;

beforeEach(() => {
  oublierTraces();
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
  oublierTraces();
});

describe("traces du compte", () => {
  it("une boucle finie depuis plus de 30 min reste comptée pour un enfant en fond qui l'a croisée", () => {
    const finAutre = debutBoucle("alice", "c2", true);
    vi.setSystemTime(30_000);
    debutTrace("alice", "alice:c1", "t1", ecrivain);
    traceEnFond("alice", "t1");
    vi.setSystemTime(MIN);
    finAutre();
    vi.setSystemTime(40 * MIN);
    debutBoucle("alice", "c3", false)();
    vi.setSystemTime(50 * MIN);
    expect(finTrace("alice", "t1")).toBe(true);
  });

  it("une trace finie part dès qu'aucun run actif n'a commencé avant sa fin, et toute trace après le délai maximal du fond", () => {
    debutBoucle("alice", "c2", true)();
    vi.setSystemTime(1000);
    debutTrace("alice", "alice:c1", "t1", ecrivain);
    expect(tracesSuivies("alice")).toBe(1);
    expect(finTrace("alice", "t1")).toBe(false);
    const finActive = debutBoucle("alice", "c3", true);
    vi.setSystemTime(2000);
    debutTrace("alice", "alice:c1", "t2", ecrivain);
    finTrace("alice", "t2");
    expect(tracesSuivies("alice")).toBe(2);
    vi.setSystemTime(2000 + (21_600 + 601) * 1000);
    expect(tracesSuivies("alice")).toBe(0);
    finActive();
  });

  it("la boucle de la conversation compte pour un enfant en fond, pas pour un enfant au premier plan", () => {
    const parente = debutBoucle("alice", "c1", true);
    debutTrace("alice", "alice:c1", "premier", ecrivain);
    expect(finTrace("alice", "premier")).toBe(false);
    debutTrace("alice", "alice:c1", "fond", ecrivain);
    traceEnFond("alice", "fond");
    expect(finTrace("alice", "fond")).toBe(true);
    parente();
  });
});
