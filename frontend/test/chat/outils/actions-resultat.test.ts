// SPDX-License-Identifier: MIT
/** frontend/test/chat/outils/actions-resultat.test.ts — actions « Ouvrir dans Routines » et « Ouvrir dans Agents » sous un routine_save ou un agent_save réussi, absentes sur échec, en cours ou autre outil. */
import { describe, expect, it, vi } from "vitest";

import {
  actionResultat,
  declencherAction,
  EVT_OUVRIR_AGENT,
  EVT_OUVRIR_ROUTINE,
} from "../../../src/features/chat/outils/actions-resultat";

describe("actionResultat", () => {
  it("routine_save réussi : ouvre la routine créée", () => {
    const a = actionResultat({
      name: "routine_save",
      status: "done",
      result: JSON.stringify({ ok: true, id: 7 }),
    });
    expect(a?.libelle).toBe("Ouvrir dans Routines");
    const ecoute = vi.fn();
    window.addEventListener(EVT_OUVRIR_ROUTINE, ecoute);
    declencherAction(a!);
    window.removeEventListener(EVT_OUVRIR_ROUTINE, ecoute);
    expect((ecoute.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ id: 7 });
  });

  it("agent_save réussi : ouvre l'agent enregistré dans la page Agents ; échec : rien", () => {
    const a = actionResultat({
      name: "agent_save",
      status: "done",
      result: JSON.stringify({ ok: true, name: "revue-sql", enabled: false }),
    });
    expect(a?.libelle).toBe("Ouvrir dans Agents");
    const ecoute = vi.fn();
    window.addEventListener(EVT_OUVRIR_AGENT, ecoute);
    declencherAction(a!);
    window.removeEventListener(EVT_OUVRIR_AGENT, ecoute);
    expect((ecoute.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ name: "revue-sql" });
    const echec = JSON.stringify({ ok: false, error: "agent_exists" });
    expect(actionResultat({ name: "agent_save", status: "done", result: echec })).toBeNull();
  });

  it("aucune action sur échec, en cours, JSON illisible ou autre outil", () => {
    const echec = JSON.stringify({ ok: false, error: "invalid_argument" });
    expect(actionResultat({ name: "routine_save", status: "done", result: echec })).toBeNull();
    expect(actionResultat({ name: "routine_save", status: "running", result: "" })).toBeNull();
    expect(actionResultat({ name: "routine_save", status: "done", result: "pas du json" })).toBeNull();
    expect(
      actionResultat({ name: "read_file", status: "done", result: JSON.stringify({ ok: true, id: 1 }) }),
    ).toBeNull();
  });
});
