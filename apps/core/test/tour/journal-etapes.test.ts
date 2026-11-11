// SPDX-License-Identifier: MIT
/** apps/core/test/tour/journal-etapes.test.ts — `tool_meta` et `error` d'un message : relevé des étapes pendant le tour, arrêt, nettoyage au retour du client, fusion d'un « Continuer », persistance du complet et du partiel. */
import type { Dict } from "@elpis/commun";
import { describe, expect, it } from "vitest";

import { mergePrevSegmentLists, normalizeClientMessages } from "../../src/tour/historique";
import {
  erreurPourMessage,
  erreurPropre,
  fusionnerMetaOutils,
  JournalEtapes,
  metaOutilsPropre,
} from "../../src/tour/journal-etapes";
import { messageAssistant, messagePartiel } from "../../src/tour/persistance";

const CAPTURE = "/api/playwright/screenshot/step_abc12345_3.png";

function journalTour(): JournalEtapes {
  const j = new JournalEtapes();
  j.noter({ type: "thinking_token", text: "je lis " }, 1000);
  j.noter({ type: "thinking_token", text: "la config" }, 2000);
  j.noter({ type: "content_token", text: "Je lis." }, 4000);
  j.noter({ type: "tool_call", name: "read_file", call_id: "a", args: { path: "p" } }, 5000);
  j.noter({ type: "tool_result", name: "read_file", call_id: "a", result: "{}", duration_ms: 120 }, 5120);
  j.noter({ type: "thinking_token", text: "je délègue" }, 6000);
  j.noter({ type: "tool_call", name: "task", call_id: "t", args: {} }, 7000);
  j.noter({ type: "tool_result", name: "task", call_id: "t", result: "{}", duration_ms: 50 }, 7050);
  j.noter({ type: "tool_call", name: "pw_goto", call_id: "b", args: {} }, 8000);
  j.noter(
    {
      type: "tool_result",
      name: "pw_goto",
      call_id: "b",
      result: "{}",
      duration_ms: 900,
      screenshot_url: CAPTURE,
      screenshot_step: "3",
    },
    8900,
  );
  j.noter({ type: "tool_call", name: "execute_shell", call_id: "c", args: {} }, 10_000);
  return j;
}

describe("JournalEtapes", () => {
  it("réflexion rattachée à l'étape qu'elle précède (délégation : notée et gardée pour la suivante), durées, capture, arrêt, réflexion finale", () => {
    const j = journalTour();
    j.arreter(28_000);
    j.noter({ type: "thinking_token", text: "conclusion" }, 28_500);
    expect(j.versMessage(30_000)).toStrictEqual({
      steps: {
        a: { think: "je lis la config", think_ms: 3000, ms: 120 },
        t: { think: "je délègue", think_ms: 1000, ms: 50 },
        b: { think: "je délègue", think_ms: 2000, ms: 900, shot: CAPTURE, shot_step: 3 },
        c: { state: "stopped", ms: 18_000 },
      },
      tail: { think: "conclusion", think_ms: 1500 },
    });
  });

  it("la réflexion d'un nouvel appel du modèle repart de zéro (texte et durée), même après une délégation", () => {
    const j = new JournalEtapes();
    j.noter({ type: "thinking_token", text: "je planifie" }, 1000);
    j.noter({ type: "tool_call", name: "todowrite", call_id: "t1", args: {} }, 2000);
    j.noter({ type: "thinking_token", text: "je coche" }, 5000);
    j.noter({ type: "tool_call", name: "todowrite", call_id: "t2", args: {} }, 6000);
    j.noter({ type: "thinking_token", text: "je conclus" }, 9000);
    j.noter({ type: "content_token", text: "Fini." }, 9500);
    expect(j.versMessage(10_000)).toStrictEqual({
      steps: {
        t1: { think: "je planifie", think_ms: 1000 },
        t2: { think: "je coche", think_ms: 1000 },
      },
      tail: { think: "je conclus", think_ms: 500 },
    });
  });

  it("aucun appel identifié (goldens sans call_id) : rien à enregistrer", () => {
    const j = new JournalEtapes();
    j.noter({ type: "thinking_token", text: "x" });
    j.noter({ type: "tool_call", name: "docx_lire", id: "c1" });
    expect(j.versMessage()).toBeNull();
  });
});

describe("retour du client", () => {
  it("tool_meta nettoyé : clés connues, capture hors préfixe et étapes vides écartées", () => {
    expect(
      metaOutilsPropre({
        steps: {
          a: { ms: 12.7, think: "t", state: "stopped", shot: "https://ailleurs/x.png", extra: 1 },
          b: { ms: -4, shot: CAPTURE, shot_step: 2 },
          "": { ms: 1 },
        },
        tail: { think: "fin", think_ms: 9 },
        autre: true,
      }),
    ).toStrictEqual({
      steps: { a: { ms: 12, think: "t", state: "stopped" }, b: { shot_step: 2, shot: CAPTURE } },
      tail: { think: "fin", think_ms: 9 },
    });
    expect(metaOutilsPropre({ steps: {} })).toBeNull();
    expect(metaOutilsPropre("x")).toBeNull();
  });

  it("normalisation : tool_meta et error gardés pour un assistant seulement", () => {
    const [, persistables] = normalizeClientMessages([
      { role: "user", content: "q", tool_meta: { steps: { a: { ms: 1 } } }, error: { text: "x" } },
      {
        role: "assistant",
        content: "r",
        tool_meta: { steps: { a: { ms: 1 } } },
        error: { text: "Serveur injoignable", detail: "ECONNREFUSED", kind: "unreachable" },
      },
    ]);
    expect(persistables[0]).toStrictEqual({ role: "user", content: "q" });
    expect(persistables[1]?.["tool_meta"]).toStrictEqual({ steps: { a: { ms: 1 } } });
    expect(persistables[1]?.["error"]).toStrictEqual({
      text: "Serveur injoignable",
      detail: "ECONNREFUSED",
      kind: "unreachable",
    });
    expect(erreurPropre({ text: "" })).toBeNull();
  });

  it("« Continuer » : étapes du segment tronqué puis de la suite, réflexion finale de la suite", () => {
    expect(
      fusionnerMetaOutils(
        { steps: { a: { ms: 1 } }, tail: { think: "avant" } },
        { steps: { b: { ms: 2 } }, tail: { think: "après" } },
      ),
    ).toStrictEqual({ steps: { a: { ms: 1 }, b: { ms: 2 } }, tail: { think: "après" } });
    const msg: Dict = { tool_meta: { steps: { b: { ms: 2 } } } };
    mergePrevSegmentLists({ tool_meta: { steps: { a: { state: "stopped", ms: 5 } } } }, msg);
    expect(msg["tool_meta"]).toStrictEqual({ steps: { a: { state: "stopped", ms: 5 }, b: { ms: 2 } } });
  });
});

describe("persistance", () => {
  const acc = {
    execId: "e",
    taskUsage: {},
    filesChanged: new Map(),
    compactions: [],
    msgs: [{ role: "user", content: "q" }],
  };

  it("tour complet : tool_meta sur le message", () => {
    const meta = { steps: { a: { ms: 3 } } };
    const [msg] = messageAssistant("ok", "", null, {
      ...acc,
      isContinue: false,
      ctxSnap: null,
      pruneKeys: [],
      toolMeta: meta,
    });
    expect(msg["tool_meta"]).toStrictEqual(meta);
  });

  it("tour en échec : partiel avec tool_meta et error ; sans erreur, aucune clé ajoutée", () => {
    const erreur = erreurPourMessage("Serveur injoignable", "connect ECONNREFUSED", "unreachable");
    const meta = { steps: { c: { state: "stopped", ms: 18_000 } } };
    const p = messagePartiel(["début"], [], [], { ...acc, isContinue: false, toolMeta: meta, erreur });
    expect(p.message).toMatchObject({ content: "début", isTruncated: true, tool_meta: meta, error: erreur });
    const sans = messagePartiel(["début"], [], [], { ...acc, isContinue: false });
    expect(Object.keys(sans.message).sort()).toStrictEqual(["content", "isTruncated", "role", "run_ids"]);
  });
});
