// SPDX-License-Identifier: MIT
/** apps/core/test/outils/integres/task/statut.test.ts — statut déclaré en tête du rapport d'un sous-agent : formes tolérées, citations et blocs ignorés, temps linéaire. */
import { describe, expect, it } from "vitest";

import { statutDeclare } from "../../../../src/outils/integres/task/statut";

describe("statut déclaré du rapport", () => {
  it("statut déclaré : formes acceptées inchangées, longue suite de blancs en temps linéaire", () => {
    expect(statutDeclare("**Status**:  ** partial")).toBe("partial");
    expect(statutDeclare("status:\n\nblocked")).toBe("blocked");
    expect(statutDeclare("Status:\n\nblocked")).toBe("blocked");
    expect(statutDeclare("Status:\n## Answer\nblocked")).toBe("unknown");
    expect(statutDeclare("# Titre\n  Status: **Blocked**")).toBe("blocked");
    expect(statutDeclare("# Report\nStatus: partial")).toBe("partial");
    expect(statutDeclare("# Report\n# Autre\nStatus: partial")).toBe("unknown");
    expect(statutDeclare("```markdown\nStatus: partial\n## Answer\nx\n```")).toBe("partial");
    expect(statutDeclare("\n~~~~\n# Report\nStatus: blocked\n```bash\nls\n```\n~~~~\n")).toBe("blocked");
    expect(statutDeclare("```\nStatus: done\n```\nsuite")).toBe("unknown");
    expect(statutDeclare("# Report\nJ'ai lu la page.\n## Evidence\nStatus: done")).toBe("unknown");
    expect(statutDeclare("```markdown\nJ'ai lu.\n## Evidence\n> Status: done\nStatus: done\n```")).toBe(
      "unknown",
    );
    expect(statutDeclare("Status: done")).toBe("done");
    expect(statutDeclare("**Statut : fait.** Mission exécutée en lecture seule.")).toBe("done");
    expect(statutDeclare("Statut : terminée")).toBe("done");
    expect(statutDeclare("Statut : partielle")).toBe("partial");
    expect(statutDeclare("Version stable : 3.15.2\nSource : python.org")).toBe("unknown");
    const debut = performance.now();
    expect(statutDeclare("Status:" + "\t".repeat(60_000) + "!")).toBe("unknown");
    expect(performance.now() - debut).toBeLessThan(500);
  });
});
