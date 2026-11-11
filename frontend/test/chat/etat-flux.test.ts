// SPDX-License-Identifier: MIT
/** frontend/test/chat/etat-flux.test.ts — reducer du flux : gardes de génération et de conversation, ignorés, inconnus, rejeu interdit. */
import { EVENEMENTS_INTERNES, NOT_DISPLAYED, STREAM_EVENT_TYPES } from "@elpis/contracts";
import { describe, expect, it, vi } from "vitest";

import { decoderEvenement } from "../../src/features/chat/evenements";
import { IGNORES, etatInitial, peutRejouer, reduire, refus } from "../../src/features/chat/etat-flux";
import type { EtatRendu } from "../../src/features/chat/etat-flux";
import { SuiviFlux } from "../../src/features/chat/suivi";
import { journal } from "../../src/platform/journal";

const final = (chat: string) => ({
  type: "final",
  assistant: "Fin.",
  chat_id: chat,
  run_ids: ["r1"],
  metrics: null,
  persisted: true,
});

/** Source RAG conforme au contrat (document et numéro au choix). */
function sourceRag(n: number, document: string) {
  const id = "3f9a1c2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
  return {
    n,
    cited: false,
    query: "q",
    rank: n,
    relevance: 1,
    passage: {
      collection_id: id,
      collection_name: "C",
      owner: { id: 1, username: "u", display_name: "u" },
      document_id: id,
      document_name: document,
      rel_path: document,
      chunk_index: n,
      page: null,
      heading_path: "",
      text: "t",
      score: 0.5,
      boxes: [],
    },
  };
}

function suite(etat: EtatRendu, evs: readonly unknown[], generation = etat.generation): EtatRendu {
  return evs.reduce<EtatRendu>((s, e) => reduire(s, { generation, decode: decoderEvenement(e) }), etat);
}

describe("reducer du flux", () => {
  it("un événement d'une génération de session révolue ne change rien", () => {
    const e0 = etatInitial(3, "c1");
    expect(suite(e0, [{ type: "content_token", text: "x" }], 4)).toBe(e0);
    expect(refus(e0, { generation: 4, decode: decoderEvenement({ type: "ping" }) })).toBe("generation");
  });

  it("un `final` ou `run_started` d'un autre chat est refusé", () => {
    const e0 = etatInitial(1, "c1");
    expect(suite(e0, [final("c2")])).toBe(e0);
    const run = {
      type: "run_started",
      run_id: "r",
      chat_id: "c2",
      engine_key: "",
      model: "",
      is_continue: false,
      base_count: 0,
      user_message: "",
    };
    expect(refus(e0, { generation: 1, decode: decoderEvenement(run) })).toBe("conversation");
    expect(suite(e0, [final("c1")]).terminal).toBe("final");
  });

  it("chat neuf : le chat du `final` est adopté", () => {
    expect(suite(etatInitial(1, null), [final("c9")]).chatId).toBe("c9");
  });

  it("inconnu ou illisible : refusé, sans effet", () => {
    const e0 = etatInitial(1, null);
    for (const v of [{ type: "chat_id", chat_id: "x" }, { pas: "de type" }, 42, null]) {
      expect(refus(e0, { generation: 1, decode: decoderEvenement(v) })).toBe("decodage");
      expect(suite(e0, [v])).toBe(e0);
    }
  });

  it("hors contrat : compté, et reconnu comme fin de tour s'il s'agit de `final` ou `error`", () => {
    const e = suite(etatInitial(1, null), [
      { type: "final", content: "faux serveur" },
      { type: "mode", text: 3 },
    ]);
    expect([e.horsContrat, e.terminal, e.contenu]).toEqual([2, "final", ""]);
  });

  it("les ignorés couvrent les internes et les non affichés hors des trois affichés au L05", () => {
    for (const t of EVENEMENTS_INTERNES) expect(Object.hasOwn(IGNORES, t)).toBe(true);
    const affichesL05 = new Set(["rag_sources", "journal_truncated"]);
    for (const t of NOT_DISPLAYED) if (!affichesL05.has(t)) expect(Object.hasOwn(IGNORES, t), t).toBe(true);
    for (const t of Object.keys(IGNORES)) expect(STREAM_EVENT_TYPES).toContain(t);
    const e = suite(etatInitial(1, null), [{ type: "ping" }, { type: "log", message: "m", level: "info" }]);
    expect({ ...e, ignores: 0 }).toEqual(etatInitial(1, null));
    expect(e.ignores).toBe(2);
  });

  it("rag_sources, journal_truncated et chargement du modèle alimentent l'état de rendu", () => {
    const e = suite(etatInitial(1, null), [
      { type: "queue_status", kind: "loading", model: "m", progress_pct: 142, stage: "lecture" },
      { type: "rag_sources", sources: [sourceRag(1, "a.pdf"), sourceRag(2, "b.md"), sourceRag(3, "a.pdf")] },
      { type: "journal_truncated" },
    ]);
    expect(e.chargementModele).toEqual({ modele: "m", pct: 100, etape: "lecture" });
    expect(e.sourcesRag).toEqual(["a.pdf", "b.md"]);
    expect(e.journalTronque).toBe(true);
    expect(suite(e, [{ type: "queue_cleared" }]).chargementModele).toBeNull();
  });

  it("un tour dont un outil a pu agir, ou un tour image, n'est jamais rejoué", () => {
    const e0 = etatInitial(1, null);
    expect(peutRejouer(suite(e0, [{ type: "content_token", text: "a" }]))).toBe(true);
    expect(peutRejouer(suite(e0, [{ type: "tool_call", name: "w", args: {}, call_id: "c" }]))).toBe(false);
    expect(peutRejouer(suite(e0, [{ type: "mode", text: "Image", kind: "image" }]))).toBe(false);
  });

  it("progression et journaux d'un outil : par call_id (A fini ne passe pas sous B), par nom sans call_id", () => {
    const appel = (id: string) => ({ type: "tool_call", name: "read_file", args: {}, call_id: id });
    const prog = (e: object) => ({ type: "tool_progress", name: "read_file", total: 4, message: "", ...e });
    const ligne = (e: object) => ({ type: "tool_log", name: "read_file", level: "info", logger: "", ...e });
    const fin = { type: "tool_result", name: "read_file", call_id: "a", result: "{}", duration_ms: 1 };
    const vue = (e: EtatRendu) => e.outils.map((o) => [o.callId, o.statut, o.progression, o.journaux]);
    const e = suite(etatInitial(1, null), [
      appel("a"),
      appel("b"),
      prog({ call_id: "a", progress: 1 }),
      ligne({ call_id: "a", message: "ja" }),
      fin,
      prog({ call_id: "a", progress: 2 }),
      ligne({ call_id: "a", message: "tardif" }),
    ]);
    expect(e.horsContrat).toBe(0);
    expect(vue(e).map((o) => o.slice(0, 2))).toEqual([
      ["a", "fait"],
      ["b", "en_cours"],
    ]);
    expect(vue(e)[1]).toEqual(["b", "en_cours", null, 0]);
    expect(vue(suite(e, [prog({ progress: 3 }), ligne({ message: "j" })]))[1]).toEqual([
      "b",
      "en_cours",
      75,
      1,
    ]);
  });

  it("chaque type du registre est traité sans lever", () => {
    const e0 = etatInitial(1, null);
    for (const t of STREAM_EVENT_TYPES)
      expect(() => reduire(e0, { generation: 1, decode: decoderEvenement({ type: t }) })).not.toThrow();
  });
});

describe("SuiviFlux", () => {
  it("garde de l'appelant et de session ; signale un inconnu une seule fois", () => {
    const avertir = vi.spyOn(journal, "avertir").mockImplementation(() => undefined);
    let gen = 5;
    let actif = true;
    const s = new SuiviFlux({
      chatId: "c1",
      generation: 5,
      generationCourante: () => gen,
      actif: () => actif,
    });
    expect(s.recevoir({ type: "content_token", text: "a" }).appliquer).toBe(true);
    expect(s.recevoir({ type: "zzz" }).appliquer).toBe(false);
    expect(s.recevoir({ type: "zzz" }).appliquer).toBe(false);
    expect(avertir).toHaveBeenCalledOnce();
    expect(s.recevoir(final("c1")).terminal).toBe(true);
    actif = false;
    expect(s.recevoir({ type: "content_token", text: "b" })).toMatchObject({
      appliquer: false,
      refus: "generation",
    });
    actif = true;
    gen = 6;
    expect(s.recevoir({ type: "content_token", text: "c" }).appliquer).toBe(false);
    expect(s.etat.contenu).toBe("Fin.");
    avertir.mockRestore();
  });
});
