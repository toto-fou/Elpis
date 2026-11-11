// SPDX-License-Identifier: MIT
/** frontend/test/chat/export.test.ts — export PDF : la fenêtre d'impression (même origine) ne reçoit que du HTML purifié, sans script (CSP héritée), et l'impression part du parent. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { exporterConversation } from "../../src/features/chat/export";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("export PDF", () => {
  it("contenu des messages purifié avant l'écriture dans la fenêtre", () => {
    let ecrit = "";
    const fenetre = {
      document: { write: (h: string) => (ecrit += h), close: () => undefined, readyState: "complete" },
      focus: () => undefined,
      print: () => undefined,
      addEventListener: () => undefined,
    };
    vi.spyOn(window, "open").mockReturnValue(fenetre as unknown as Window);
    exporterConversation("pdf", {
      messages: [
        { role: "user", content: 'Bonjour <img src=x onerror="alert(1)"><script>alert(2)</script>' },
        { role: "assistant", content: '<a href="javascript:alert(3)">lien</a> **gras**' },
      ],
      titre: "<b>Essai</b>",
      chatId: "c1",
      utilisateur: "alice",
      assistant: "Elpis",
    });
    const doc = new DOMParser().parseFromString(ecrit, "text/html");
    const scripts = Array.from(doc.querySelectorAll("script"), (s) => s.textContent ?? "");
    expect(scripts).toHaveLength(0);
    for (const el of Array.from(doc.querySelectorAll("*")))
      for (const at of Array.from(el.attributes)) {
        expect(at.name.startsWith("on"), `${el.tagName} ${at.name}`).toBe(false);
        expect(/^\s*javascript:/i.test(at.value), `${el.tagName} ${at.name}`).toBe(false);
      }
    expect(doc.querySelector("strong")?.textContent).toBe("gras");
    expect(doc.title).toBe("<b>Essai</b>");
  });

  it("impression appelée depuis le parent, après le chargement de la fenêtre", () => {
    vi.useFakeTimers();
    const ecoutes: { charge?: () => void } = {};
    const print = vi.fn();
    const fenetre = {
      document: { write: () => undefined, close: () => undefined, readyState: "loading" },
      focus: () => undefined,
      print,
      addEventListener: (type: string, f: () => void) => {
        if (type === "load") ecoutes.charge = f;
      },
    };
    vi.spyOn(window, "open").mockReturnValue(fenetre as unknown as Window);
    exporterConversation("pdf", {
      messages: [{ role: "user", content: "Bonjour" }],
      titre: "Essai",
      chatId: "c1",
      utilisateur: "alice",
      assistant: "Elpis",
    });
    vi.advanceTimersByTime(500);
    expect(print).not.toHaveBeenCalled();
    expect(ecoutes.charge).toBeTypeOf("function");
    ecoutes.charge?.();
    vi.advanceTimersByTime(200);
    expect(print).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
