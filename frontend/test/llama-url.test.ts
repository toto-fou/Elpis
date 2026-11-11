// SPDX-License-Identifier: MIT
/** frontend/test/llama-url.test.ts — l'URL complète du moteur local suit l'hôte et le port, sans réécrire une URL propre. */
import { describe, expect, it } from "vitest";

import { suivreHotePort } from "../src/utils/llama-url";

describe("suivreHotePort", () => {
  it("URL qui visait l'ancien hôte:port : recalée, chemin gardé", () => {
    expect(
      suivreHotePort("http://192.0.2.53:8080/v1/chat/completions", "192.0.2.53", 8080, "192.0.2.60", 8080),
    ).toBe("http://192.0.2.60:8080/v1/chat/completions");
    expect(
      suivreHotePort("http://10.0.0.5:8080/v1/chat/completions", "10.0.0.5", "8080", "10.0.0.5", 9000),
    ).toBe("http://10.0.0.5:9000/v1/chat/completions");
  });

  it("URL propre (autre hôte, proxy https) : jamais réécrite", () => {
    const u = "https://llm.lan/api/v1/chat/completions";
    expect(suivreHotePort(u, "192.0.2.53", 8080, "192.0.2.60", 8080)).toBe(u);
  });

  it("URL vide ou hôte inchangé : rien ; IPv6 littérale entre crochets", () => {
    expect(suivreHotePort("", "a", 1, "b", 1)).toBe("");
    expect(suivreHotePort("http://a:1/x", "a", 1, "a", 1)).toBe("http://a:1/x");
    expect(suivreHotePort("http://[::1]:8080/x", "::1", 8080, "::2", 8080)).toBe("http://[::2]:8080/x");
  });
});
