// SPDX-License-Identifier: MIT
/** frontend/test/chat/jobs/historique-jobs.test.ts — historique : message de réveil relu avec sa ligne, confirmation de suppression ouverte aussitôt, qui annonce ensuite les tâches de fond arrêtées. */
import * as Vue from "vue";
import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";

import {
  construireMessages,
  creerHistoriqueChat,
  DELAI_TACHES_MS,
} from "../../../src/features/chat/historique/historique";
import type {
  DepsHistorique,
  Message,
  RefsHistorique,
} from "../../../src/features/chat/historique/historique";
import { json, REVEIL } from "./outils-jobs";

const analyse = (c: unknown): { files?: unknown; displayContent?: unknown } => ({ displayContent: c });

describe("messages de réveil relus", () => {
  it("origin job_wake et wake conservés sur le message utilisateur", () => {
    const [m] = construireMessages(
      [{ role: "user", content: "[Automatic wake-up]", origin: "job_wake", wake: REVEIL }],
      analyse,
    );
    expect(m?.origin).toBe("job_wake");
    expect((m?.wake as { summary: string }).summary).toBe(REVEIL.summary);
  });

  it("wake hors contrat écarté, origin gardée ; un message ordinaire n'a ni l'un ni l'autre", () => {
    const [a, b] = construireMessages(
      [
        { role: "user", content: "x", origin: "job_wake", wake: { summary: 1 } },
        { role: "user", content: "y" },
      ],
      analyse,
    );
    expect(a?.origin).toBe("job_wake");
    expect(a?.wake).toBeUndefined();
    expect(b?.origin).toBeUndefined();
  });

  it("origin « job_wake » sur un autre rôle : ignorée", () => {
    const [m] = construireMessages([{ role: "assistant", content: "x", origin: "job_wake" }], analyse);
    expect(m?.origin).toBeUndefined();
  });
});

function monter(compter?: (ids: readonly string[]) => Promise<number>) {
  const confirmations: [string, string | undefined, Promise<string> | undefined][] = [];
  const refs = {
    messages: ref<readonly Message[]>([]),
    currentChatId: ref<string | null>(null),
    currentChatTitle: ref(""),
    currentView: ref("accueil"),
    isStreaming: ref(false),
    isUserScrolling: ref(false),
    chats: ref([
      { id: "c1", title: "A" },
      { id: "c2", title: "B" },
    ]),
    inputRef: ref<HTMLTextAreaElement | null>(null),
    attachedFiles: ref<unknown[]>([]),
    user: ref<unknown>({ id: 1 }),
  } satisfies RefsHistorique;
  const noop = (): void => {};
  const deps: DepsHistorique = {
    detachFromStream: noop,
    stopRunForChat: noop,
    _parseFileBlocks: analyse,
    scrollToBottom: noop,
    _revokeAllWebShotBlobs: noop,
    _vsReset: noop,
    _vsInitTail: noop,
    loadAvailableModels: noop,
    ...(compter ? { compterJobsActifs: compter } : {}),
  };
  const api = creerHistoriqueChat(
    Vue,
    refs,
    {
      fetchAuth: () => Promise.resolve(json({})),
      showToast: () => undefined,
      openConfirm: (titre, texte, _danger, _libelle, _annuler, suite) => {
        confirmations.push([titre, texte, suite]);
        return Promise.resolve(false);
      },
      openPrompt: () => Promise.resolve(null),
      showSidebar: ref(true),
    },
    deps,
    null,
  );
  return { api, refs, confirmations };
}

describe("suppression d'une conversation à tâches de fond", () => {
  // La confirmation s'ouvre sans attendre ; le nombre de tâches arrive ensuite sur sa ligne réservée, sous le message.
  const SUITE = "Vous pourrez l’annuler quelques secondes.";

  it("la confirmation annonce « N tâches de fond seront arrêtées »", async () => {
    const vus: (readonly string[])[] = [];
    const b = monter((ids) => {
      vus.push(ids);
      return Promise.resolve(2);
    });
    await b.api.deleteChat("c1");
    expect(vus).toEqual([["c1"]]);
    expect(b.confirmations[0]?.slice(0, 2)).toEqual(["Supprimer la conversation ?", SUITE]);
    expect(await b.confirmations[0]?.[2]).toBe("2 tâches de fond seront arrêtées.");
  });

  it("une seule tâche : singulier", async () => {
    const b = monter(() => Promise.resolve(1));
    await b.api.deleteChat("c1");
    expect(await b.confirmations[0]?.[2]).toBe("1 tâche de fond sera arrêtée.");
  });

  it("aucune tâche, comptage en échec ou sans module : confirmation inchangée", async () => {
    for (const compter of [() => Promise.resolve(0), () => Promise.reject(new Error("réseau")), undefined]) {
      const b = monter(compter);
      await b.api.deleteChat("c1");
      expect(b.confirmations[0]?.[1]).toBe(SUITE);
      expect(await b.confirmations[0]?.[2]).toBe("");
    }
  });

  it("suppression groupée : le total des conversations choisies s'ajoute au message", async () => {
    const vus: (readonly string[])[] = [];
    const b = monter((ids) => {
      vus.push(ids);
      return Promise.resolve(3);
    });
    b.api.toggleChatSelectMode();
    b.api.toggleChatSelect("c1");
    b.api.toggleChatSelect("c2");
    await b.api.bulkDeleteChats();
    expect(vus).toEqual([["c1", "c2"]]);
    expect(b.confirmations[0]?.slice(0, 2)).toEqual([
      "Supprimer 2 conversation(s) ?",
      "Cette action est irréversible.",
    ]);
    expect(await b.confirmations[0]?.[2]).toBe("3 tâches de fond seront arrêtées.");
  });

  it("comptage sans réponse : la validation n'attend pas plus de DELAI_TACHES_MS", async () => {
    vi.useFakeTimers();
    try {
      const b = monter(() => new Promise<number>(() => {}));
      void b.api.deleteChat("c1");
      let arrivee: string | null = null;
      void b.confirmations[0]?.[2]?.then((t) => (arrivee = t));
      await vi.advanceTimersByTimeAsync(DELAI_TACHES_MS - 1);
      expect(arrivee).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(arrivee).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});
