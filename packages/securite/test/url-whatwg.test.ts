// SPDX-License-Identifier: MIT
/** packages/securite/test/url-whatwg.test.ts — accord urlsplit/WHATWG (E40) : même hôte et même port pour la garde et le client, sinon refus. */
import { describe, expect, it } from "vitest";

import { cibleNonAmbigue, urlNonAmbigue } from "../src/url-whatwg";

describe("accord urlsplit/WHATWG", () => {
  it.each([
    "http://example.com/a?b#c",
    "https://Example.COM:8443/",
    "https://example.com:443/",
    "http://bücher.de/",
    "http://[2001:db8::1]:8080/",
    "http://user:mdp@example.com/",
    "http://10.0.0.5/",
  ])("%s : même lecture", (url) => {
    expect(urlNonAmbigue(url)).toBe(true);
    expect(cibleNonAmbigue(url)).toBeInstanceOf(URL);
  });

  it.each([
    ["http://127.1/", "IPv4 abrégée : WHATWG lit 127.0.0.1, urlsplit un nom"],
    ["http://2130706433/", "IPv4 décimale"],
    ["http://0x7f.0.0.1/", "IPv4 hexadécimale"],
    ["http://evil.com\\@127.0.0.1/", "barre inverse : WHATWG coupe l'hôte avant l'arobase"],
    ["http://exa mple.com/", "espace dans l'hôte"],
    ["http://ex%61mple.com/", "pourcent-encodage dans l'hôte"],
    ["ftp://example.com/", "schéma hors http(s)"],
    ["javascript:alert(1)", "schéma hors http(s)"],
  ])("%s : refusée (%s)", (url) => {
    expect(urlNonAmbigue(url)).toBe(false);
    expect(cibleNonAmbigue(url)).toBeNull();
  });

  it("URL illisible : urlsplit lève (cibleNonAmbigue aussi), WHATWG refuse (null), urlNonAmbigue répond faux", () => {
    expect(() => cibleNonAmbigue("http://[::1/")).toThrow();
    expect(urlNonAmbigue("http://[::1/")).toBe(false);
    expect(cibleNonAmbigue("http://example.com:abc/")).toBeNull();
    expect(urlNonAmbigue("http://example.com:abc/")).toBe(false);
  });
});
