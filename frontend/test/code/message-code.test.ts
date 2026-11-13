// SPDX-License-Identifier: MIT
/** frontend/test/code/message-code.test.ts — transcript de la page Code : déplier le détail d'un outil ne re-rend que sa ligne. */
import { createApp, h, nextTick, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import PageCode from "../../src/components/code/PageCode.vue";
import { CLE_CODE } from "../../src/features/code/domaine";
import type { DomaineCode } from "../../src/features/code/domaine";
import { etapes, formaterValeur, libelleOutil } from "../../src/features/code/rendu";
import type { MessageOpencode } from "../../src/features/code/rendu";

let app: App | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

function transcript(n: number): MessageOpencode[] {
  const sortie: MessageOpencode[] = [];
  for (let i = 0; i < n; i++) {
    const id = `x${i}`;
    const fini = { created: i, completed: i + 1 };
    if (i % 2 === 0) {
      sortie.push({
        id,
        role: "user",
        info: { id, role: "user", time: fini },
        parts: [{ id: `${id}p`, type: "text", text: `Demande ${i}` }],
      });
      continue;
    }
    sortie.push({
      id,
      role: "assistant",
      info: { id, role: "assistant", time: fini },
      parts: [
        { id: `${id}p1`, type: "text", text: `## Étape ${i}` },
        {
          id: `${id}p2`,
          type: "tool",
          tool: "bash",
          state: { status: "completed", input: { command: `echo ${i}` }, output: `sortie ${i}` },
        },
      ],
    });
  }
  return sortie;
}

function monter(messages: MessageOpencode[]) {
  const rendus: string[] = [];
  const valeurs = reactive<Record<string, unknown>>({
    currentView: "code",
    codeAvailable: true,
    codeActiveId: "s1",
    codeSessions: [],
    activeSession: null,
    codeCtx: null,
    codeAgentShow: false,
    codePluginStale: false,
    codeLoading: false,
    codeMessages: messages,
    codeMessagesRendus: messages,
    codeDebutRendu: 0,
    codeLiveIdx: -1,
    codeBusyActive: false,
    codePerms: [],
    codeQuestions: [],
    codePrompt: "",
    codeNow: 0,
    settings: { chat_width: 70 },
    logoApp: "/logo.png",
    user: { avatar: null },
    codeSteps: etapes,
    codeFmtVal: formaterValeur,
    codeToolLabel: libelleOutil,
    codeMsgError: () => null,
    renderMarkdown: (s: string) => {
      rendus.push(s);
      return `<p>${s}</p>`;
    },
  });
  const domaine = new Proxy(valeurs, {
    get(c, cle: string) {
      return cle in c ? c[cle] : () => "";
    },
  }) as unknown as DomaineCode;
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(PageCode) });
  app.provide(CLE_CODE, domaine);
  app.mount(hote);
  return { hote, rendus };
}

describe("PageCode : détail d'un outil", () => {
  it("le dépli ne re-rend que la ligne de l'outil", async () => {
    const { hote, rendus } = monter(transcript(40));
    expect(rendus).toHaveLength(20);
    const boutons = [...hote.querySelectorAll<HTMLButtonElement>(".elpis-code-tool-row button")];
    expect(boutons).toHaveLength(20);
    rendus.length = 0;
    boutons[19]?.click();
    await nextTick();
    expect(rendus).toEqual(["## Étape 39"]);
    expect(hote.textContent).toContain("sortie 39");
    expect(hote.textContent).not.toContain("sortie 37");
  });

  it("chaque ligne garde son propre état ouvert ou fermé", async () => {
    const { hote } = monter(transcript(6));
    const boutons = () => [...hote.querySelectorAll<HTMLButtonElement>(".elpis-code-tool-row button")];
    boutons()[0]?.click();
    boutons()[2]?.click();
    await nextTick();
    expect(hote.textContent).toContain("sortie 1");
    expect(hote.textContent).toContain("sortie 5");
    expect(hote.textContent).not.toContain("sortie 3");
    boutons()[0]?.click();
    await nextTick();
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
    expect(hote.textContent).not.toContain("sortie 1");
    expect(hote.textContent).toContain("sortie 5");
  });
});
