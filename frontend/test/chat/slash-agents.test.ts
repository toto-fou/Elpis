// SPDX-License-Identifier: MIT
/** frontend/test/chat/slash-agents.test.ts — commande /agents : proposée si l'instance permet les sous-agents, on et off basculent le réglage du compte, open ou rien ouvre la page. */
import * as Vue from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { creerMenuSlash } from "../../src/features/chat/composeur/slash";
import type { AgentsSlash, CtxSlash } from "../../src/features/chat/composeur/slash";

afterEach(() => {
  document.body.innerHTML = "";
});

function monter(o: { disponible?: boolean; agents?: boolean } = {}) {
  const ta = document.createElement("textarea");
  document.body.appendChild(ta);
  const inputRef = Vue.ref<HTMLTextAreaElement | null>(ta);
  const inputMessage = Vue.ref("");
  const toasts: string[] = [];
  const actifs = Vue.ref(false);
  const agents: AgentsSlash = {
    disponible: () => o.disponible !== false,
    actifs: () => actifs.value,
    ouvrir: vi.fn(),
    basculer: vi.fn(async (on: boolean) => {
      actifs.value = on;
    }),
  };
  const ctx: CtxSlash = {
    fetchAuth: () => Promise.resolve(null),
    showToast: (m) => toasts.push(m),
    agents: o.agents === false ? null : agents,
  };
  const menu = creerMenuSlash(Vue, { inputRef, inputMessage }, ctx);
  const taper = (texte: string): void => {
    inputMessage.value = texte;
    ta.value = texte;
    ta.setSelectionRange(texte.length, texte.length);
    menu.onInput();
  };
  const lancer = (texte: string): Promise<void> => menu.slashRun(menu.slashResolve(texte));
  return { menu, taper, lancer, agents, actifs, toasts };
}

const noms = (b: ReturnType<typeof monter>): string[] =>
  b.menu.slashList.value.map((c) => (c as { name: string }).name);

describe("commande /agents", () => {
  it("est proposée avec l'icône du robot quand l'instance permet les sous-agents", () => {
    const b = monter();
    b.taper("/age");
    const c = b.menu.slashList.value[0] as { name: string; icon: string };
    expect(c.name).toBe("agents");
    expect(c.icon).toBe("ph-robot");
  });

  it("n'est pas proposée sans sous-agents sur l'instance ni sans module", () => {
    const b = monter({ disponible: false });
    b.taper("/age");
    expect(noms(b)).not.toContain("agents");
    const sans = monter({ agents: false });
    sans.taper("/age");
    expect(noms(sans)).not.toContain("agents");
  });

  it("on et off basculent le réglage, sans toast en double", async () => {
    const b = monter();
    await b.lancer("/agents on");
    expect(b.agents.basculer).toHaveBeenLastCalledWith(true);
    expect(b.actifs.value).toBe(true);
    await b.lancer("/agents off");
    expect(b.agents.basculer).toHaveBeenLastCalledWith(false);
    expect(b.actifs.value).toBe(false);
    expect(b.toasts).toEqual([]);
  });

  it("open, ou la commande seule, ouvre la page", async () => {
    const b = monter();
    await b.lancer("/agents open");
    await b.lancer("/agents");
    expect(b.agents.ouvrir).toHaveBeenCalledTimes(2);
    expect(b.agents.basculer).not.toHaveBeenCalled();
  });

  it("une action inconnue rappelle l'usage", async () => {
    const b = monter();
    await b.lancer("/agents peut-etre");
    expect(b.toasts).toEqual(["Usage : /agents [on|off|open]"]);
  });
});
