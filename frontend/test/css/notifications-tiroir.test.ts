// SPDX-License-Identifier: MIT
/** frontend/test/css/notifications-tiroir.test.ts — un tiroir ouvert écarte les notifications de son pied (à sa gauche, ou au-dessus sur un écran étroit). */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const STYLE = readFileSync(join(import.meta.dirname, "../../css/style.css"), "utf8");
const CHROME = readFileSync(join(import.meta.dirname, "../../src/components/racine/ChromeApp.vue"), "utf8");

describe("notifications et tiroir ouvert", () => {
  it("le conteneur des notifications porte sa classe, et un tiroir ouvert le place hors du pied", () => {
    expect(CHROME).toMatch(/class="elpis-toasts fixed bottom-6 right-6/u);
    expect(STYLE).toContain(
      "body:has(.adm-drawer-backdrop) .elpis-toasts { right: calc(min(28rem, 100vw) + 1.5rem); }",
    );
    expect(STYLE).toMatch(
      /@media \(max-width: 52rem\) \{\s*body:has\(\.adm-drawer-backdrop\) \.elpis-toasts \{ right: 1\.5rem; bottom: 5\.25rem; \}/u,
    );
  });
});
