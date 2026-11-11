// SPDX-License-Identifier: MIT
/** packages/commun/test/annulation.test.ts — annulation coopérative, annulation demandée par l'appelant, attente annulable et aides UTF-8. */
import { describe, expect, it } from "vitest";

import {
  CancelledError,
  dormirMs,
  estAnnulationDemandee,
  estErreurAnnulation,
  raisonAnnulation,
} from "../src/annulation";
import { encoderUtf8Py, ErreurPython, estErreurPython, utf8Remplace } from "../src/python";

const abandonne = (raison?: unknown): AbortSignal => {
  const ctl = new AbortController();
  ctl.abort(raison);
  return ctl.signal;
};

describe("annulation", () => {
  it("erreur d'annulation : CancelledError ou AbortError, sans regarder le signal", () => {
    expect(estErreurAnnulation(new CancelledError("stop"))).toBe(true);
    expect(estErreurAnnulation(new DOMException("x", "AbortError"))).toBe(true);
    expect(estErreurAnnulation(new Error("x"))).toBe(false);
    expect(estErreurAnnulation({ name: "AbortError" })).toBe(false);
  });

  it("annulation demandée : seulement si le signal de l'appelant est abandonné", () => {
    const raison = new Error("stop");
    expect(estAnnulationDemandee(raison, abandonne(raison))).toBe(true);
    expect(estAnnulationDemandee({ name: "AbortError" }, abandonne(raison))).toBe(true);
    expect(estAnnulationDemandee(new Error("autre"), abandonne(raison))).toBe(false);
    expect(estAnnulationDemandee(new DOMException("x", "AbortError"), new AbortController().signal)).toBe(
      false,
    );
    expect(estAnnulationDemandee(new DOMException("x", "AbortError"))).toBe(false);
  });

  it("raison d'un signal : la sienne, sinon une AbortError", () => {
    const ctl = new AbortController();
    Object.defineProperty(ctl.signal, "reason", { value: undefined });
    expect((raisonAnnulation(ctl.signal) as DOMException).name).toBe("AbortError");
    expect(raisonAnnulation(abandonne("motif"))).toBe("motif");
  });

  it("attente annulable : rejette avec la raison du signal", async () => {
    await expect(dormirMs(0)).resolves.toBeUndefined();
    await expect(dormirMs(10_000, abandonne("deja"))).rejects.toBe("deja");
    const ctl = new AbortController();
    const attente = dormirMs(10_000, ctl.signal);
    ctl.abort("pendant");
    await expect(attente).rejects.toBe("pendant");
  });
});

describe("aides UTF-8 et erreurs Python", () => {
  it("encode('utf-8') strict, encode('utf-8', 'replace') et tri des erreurs", () => {
    expect(encoderUtf8Py("é")).toEqual(Buffer.from([0xc3, 0xa9]));
    expect(() => encoderUtf8Py("a\ud800")).toThrow(ErreurPython);
    expect(utf8Remplace("a\ud800b\udfff")).toEqual(Buffer.from("a?b?"));
    expect(utf8Remplace("😀")).toEqual(Buffer.from("\u{1f600}"));
    expect(estErreurPython(new ErreurPython("ValueError", "x"), "TypeError", "ValueError")).toBe(true);
    expect(estErreurPython(new ErreurPython("OverflowError", "x"), "TypeError", "ValueError")).toBe(false);
    expect(estErreurPython(new Error("x"), "ValueError")).toBe(false);
  });
});
