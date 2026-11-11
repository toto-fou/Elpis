// SPDX-License-Identifier: MIT
/** frontend/test/chat/message/signaux.test.ts — signaux d'état sobres (texte neutre, seul le signe porte la couleur, réussite sans fond) et vocabulaire français dans les fichiers du fil. */
import { createApp, h } from "vue";
import type { App, VNode } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import FichiersModifies from "../../../src/components/chat/message/FichiersModifies.vue";
import CarteOutil from "../../../src/components/chat/outils/CarteOutil.vue";
import GroupeOutils from "../../../src/components/chat/outils/GroupeOutils.vue";
import type { ContexteMessage } from "../../../src/features/chat/message/types";
import type { EtapeOutil } from "../../../src/features/chat/outils/types";
import { CLE_FIL } from "../../../src/features/chat/page/domaines";

let app: App | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

function monter(rendu: () => VNode, fil?: object): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: rendu });
  if (fil) app.provide(CLE_FIL, fil as ContexteMessage);
  app.mount(hote);
  return hote;
}

const COULEURS = /text-(emerald|green|red|rose|amber)-\d+/;

describe("signaux sobres", () => {
  it("fichiers modifiés : « +12 −3 » et « créé » en texte neutre, seul le signe du fichier est coloré", () => {
    const fichiers = [
      {
        path: "src/a.ts",
        name: "a.ts",
        dir: "src",
        change: "modified",
        computed: true,
        additions: 12,
        deletions: 3,
      },
      { path: "b.sh", name: "b.sh", dir: "", change: "created", computed: true, additions: 4, deletions: 0 },
    ];
    const hote = monter(() => h(FichiersModifies, { entry: { idx: 1, msg: { role: "assistant" } } }), {
      isDiffEditorEnabled: () => false,
      hasDiffFiles: () => true,
      diffFilesFor: () => fichiers,
    });
    const stats = [...hote.querySelectorAll(".diff-row-flat .font-mono > span")].map((s) =>
      s.textContent?.trim(),
    );
    expect(stats).toContain("+12 −3");
    for (const s of hote.querySelectorAll(".diff-row-flat span")) expect(s.className).not.toMatch(COULEURS);
    expect(hote.innerHTML).not.toContain("rose");
    expect(hote.querySelector(".ph-file-plus")?.className).toContain("text-emerald-600");
  });

  it("étape en échec (déroulé Classique) : nom neutre, signe ✗ rouge ; plus d'« appel #N »", () => {
    const steps: EtapeOutil[] = [
      { name: "read_file", status: "done", _is_error: true, result: '{"error":"x"}' },
    ];
    const hote = monter(() =>
      h(GroupeOutils, {
        msg: { _segsOpen: { 0: true } },
        idx: 1,
        grp: {
          gi: 0,
          text: "",
          steps,
          disp: [{ step: steps[0]!, flat: 0, shell: false }],
          nTools: 1,
          nComp: 0,
          pills: { pills: [], extraCount: 0 },
          running: false,
          shellRuns: [],
          shellMeta: null,
        },
        consoleShell: false,
        masquerReflexion: false,
      }),
    );
    const nom = hote.querySelector("button.group\\/toolbtn span.font-mono");
    expect(nom?.className).not.toMatch(COULEURS);
    expect(hote.querySelector(".ph-x-circle")?.className).toContain("text-red-500");
    const carte = monter(() =>
      h(CarteOutil, {
        step: { name: "read_file", status: "done", result: "{}" },
        numero: 3,
        compactOuvert: false,
      }),
    );
    expect(carte.textContent).not.toContain("appel #");
    expect(carte.querySelector("button[aria-label='Fermer le détail']")).not.toBeNull();
  });

  it("compression : « Compression du contexte », « Voir le résumé », jetons", () => {
    const hote = monter(() =>
      h(CarteOutil, {
        step: {
          name: "context_compress",
          _kind: "compression",
          status: "done",
          stats: { tokens_before: 31_000, tokens_after: 9000, new_state: { summary_xml: "<s/>" } },
        },
        numero: 1,
        compactOuvert: false,
      }),
    );
    expect(hote.textContent).toContain("Compression du contexte");
    expect(hote.textContent).toContain("Voir le résumé");
    expect(hote.textContent).toContain("jetons");
    expect(hote.textContent).not.toContain("compact");
  });
});
