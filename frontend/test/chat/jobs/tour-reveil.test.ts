// SPDX-License-Identifier: MIT
/** frontend/test/chat/jobs/tour-reveil.test.ts — tour de réveil en direct : run_started origin « job_wake » remplace la bulle utilisateur par la ligne de réveil, ou la question est un réveil dès le rattachement annoncé par chat_wake ; tour ordinaire inchangé. */
import { computed, nextTick, ref, watch } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { creerEtatChat, creerEtatFlux } from "../../../src/features/chat/coeur/etat";
import type { CoeurChat, LiensChat } from "../../../src/features/chat/coeur/liens";
import { creerRuns } from "../../../src/features/chat/coeur/runs";
import { creerDefilementVirtuel } from "../../../src/features/chat/liste/defilement-virtuel";
import type { EntreeListe, RefsDefilement } from "../../../src/features/chat/liste/defilement-virtuel";
import type { MessageChat, RefsRacineChat } from "../../../src/features/chat/coeur/types";
import { json, REVEIL } from "./outils-jobs";

const TEXTE = "[Automatic wake-up: background job event(s).]";

const ligne = (o: Record<string, unknown>): string => JSON.stringify(o) + "\n";

afterEach(() => {
  vi.unstubAllGlobals();
});

function monter(flux: string, userMessage = TEXTE, surEvenement?: (evt: Record<string, unknown>) => void) {
  const messages = ref<MessageChat[]>([{ role: "assistant", content: "Je lance pytest." }]);
  const r = {
    user: ref({ username: "alice" }),
    messages,
    currentChatId: ref<string | null>("c1"),
    isStreaming: ref(false),
    isUserScrolling: ref(false),
  } as unknown as RefsRacineChat;
  const appliques: string[] = [];
  const l = new Proxy({} as LiensChat, {
    get: (_c, k: string) => {
      if (k === "handleStreamEvent")
        return (evt: { type: string }) => {
          appliques.push(evt.type);
          surEvenement?.(evt);
          return Promise.resolve();
        };
      if (k === "loadChat") return () => Promise.resolve();
      if (k === "getCtxSize") return () => 0;
      return () => undefined;
    },
  });
  const ctx = {
    fetchAuth: () => Promise.resolve(json({})),
    showToast: () => undefined,
  } as unknown as CoeurChat["ctx"];
  const c = { r, ctx, e: creerEtatChat(), f: creerEtatFlux(), md: null, l } as unknown as CoeurChat;
  vi.stubGlobal("fetch", () => Promise.resolve(new Response(flux)));
  const runs = creerRuns(c, { generation: 1 } as never);
  const st = {
    generation_running: true,
    resumable: true,
    run_id: "r1",
    base_count: 1,
    is_continue: false,
    user_message: userMessage,
  };
  return { runs, messages, appliques, st };
}

const DEBUT = {
  type: "run_started",
  run_id: "r1",
  chat_id: "c1",
  engine_key: "e",
  model: "m",
  is_continue: false,
  base_count: 1,
  user_message: TEXTE,
};

describe("tour de réveil en direct", () => {
  it("run_started job_wake : la question posée devient une ligne de réveil, pas une bulle utilisateur", async () => {
    const flux =
      ligne({ ...DEBUT, origin: "job_wake", wake: REVEIL }) +
      ligne({ type: "replay_done" }) +
      ligne({ type: "run_end", status: "done" });
    const b = monter(flux);
    expect(await b.runs.attachRun("c1", b.st)).toBe(true);
    const question = b.messages.value.find((m) => m.role === "user");
    expect(question?.origin).toBe("job_wake");
    expect(question?.wake?.summary).toBe(REVEIL.summary);
    expect(question?.content).toBe(TEXTE);
    expect(b.appliques).not.toContain("run_started");
  });

  it("rattachement annoncé par chat_wake : la question est un réveil dès qu'elle est posée, avant le journal", async () => {
    const flux =
      ligne({ ...DEBUT, origin: "job_wake", wake: REVEIL }) + ligne({ type: "run_end", status: "done" });
    const b = monter(flux);
    let livrer: (r: Response) => void = () => undefined;
    vi.stubGlobal("fetch", () => new Promise<Response>((ok) => (livrer = ok)));
    const fini = b.runs.attachRun("c1", b.st, REVEIL);
    const question = b.messages.value.find((m) => m.role === "user");
    expect(question?.origin).toBe("job_wake");
    expect(question?.wake).toEqual(REVEIL);
    livrer(new Response(flux));
    expect(await fini).toBe(true);
    expect(b.messages.value.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("wake hors contrat : run_started entier écarté (jamais transmis à la vue), aucun résumé inventé", async () => {
    const flux =
      ligne({ ...DEBUT, origin: "job_wake", wake: { summary: 3 } }) +
      ligne({ type: "run_end", status: "done" });
    const b = monter(flux);
    await b.runs.attachRun("c1", b.st);
    const question = b.messages.value.find((m) => m.role === "user");
    expect(question?.origin).toBeUndefined();
    expect(question?.wake).toBeUndefined();
    expect(question?.content).toBe(TEXTE);
    expect(b.appliques).not.toContain("run_started");
  });

  it("tour ordinaire (origin user ou absent) : la question reste un message utilisateur", async () => {
    const flux = ligne({ ...DEBUT, origin: "user" }) + ligne({ type: "run_end", status: "done" });
    const b = monter(flux, "Bonjour");
    await b.runs.attachRun("c1", b.st);
    const question = b.messages.value.find((m) => m.role === "user");
    expect(question?.origin).toBeUndefined();
    expect(question?.content).toBe("Bonjour");
  });

  it("run_started dont le texte ne correspond pas à la dernière question : aucun message n'est modifié", async () => {
    const flux =
      ligne({ ...DEBUT, user_message: "autre", origin: "job_wake", wake: REVEIL }) +
      ligne({ type: "run_end", status: "done" });
    const b = monter(flux, "Bonjour");
    await b.runs.attachRun("c1", b.st);
    expect(b.messages.value.find((m) => m.role === "user")?.origin).toBeUndefined();
  });

  it("contenu diffusé du tour de réveil : dans la bulle de l'agent qui précède, pas dans une nouvelle", async () => {
    const flux =
      ligne({ ...DEBUT, base_count: 2, origin: "job_wake", wake: REVEIL }) +
      ligne({ type: "content_token", text: "Je corrige", n: 1 }) +
      ligne({ type: "run_end", status: "done" });
    const forme = (lignes: readonly EntreeListe[]) =>
      lignes.map((l) => [l.idx, (l.suite ?? []).map((s) => s.idx)]);
    let pendant: unknown = null;
    let diffuse = "";
    const b = monter(flux, TEXTE, (evt) => {
      if (evt["type"] !== "content_token") return;
      const msgs = b.messages.value;
      const i = msgs.length - 1;
      msgs[i] = { ...msgs[i], role: "assistant", content: String(evt["text"]) };
      pendant = forme(fenetre.visibleMessages.value);
      diffuse = String(fenetre.visibleMessages.value[0]?.suite?.[1]?.msg["content" as never]);
    });
    const fenetre = creerDefilementVirtuel({ ref, computed, watch, nextTick }, {
      messages: b.messages,
      chatContainer: ref(null),
      isUserScrolling: ref(false),
    } as unknown as RefsDefilement);
    // La base compte la réponse d'origine et le texte du réveil : la première est gardée.
    await b.runs.attachRun("c1", { ...b.st, base_count: 2 });
    expect(pendant).toEqual([[0, [1, 2]]]);
    expect(diffuse).toBe("Je corrige");
    expect(forme(fenetre.visibleMessages.value)).toEqual([[0, [1, 2]]]);
  });
});
