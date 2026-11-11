// SPDX-License-Identifier: MIT
/** frontend/test/url-sure.test.ts — garde des URL issues de données : http(s) et chemins de la page acceptés, tout autre schéma refusé. */
import { describe, expect, it } from "vitest";

import { estUrlHttp } from "../src/utils/url-sure";

describe("estUrlHttp", () => {
  it.each(["https://elpis.lan:8002/", "http://10.0.0.5/admin", "/api/x?y=1", "page.html"])(
    "acceptée : %s",
    (u) => {
      expect(estUrlHttp(u)).toBe(true);
    },
  );
  it.each([
    "javascript:alert(1)",
    " JaVaScRiPt:alert(1)",
    "data:text/html,<p>x</p>",
    "vbscript:x",
    "file:///etc/passwd",
    "",
    null,
    42,
  ])("refusée : %s", (u) => {
    expect(estUrlHttp(u)).toBe(false);
  });
});
