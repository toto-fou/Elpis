// SPDX-License-Identifier: MIT
/** frontend/test/code/message-vivant.test.ts — message en cours de la page Code rendu par blocs comme le chat : nœuds des blocs figés gardés (mises à jour, fin, relecture, page masquée), parts successives, coloration au fil de l'eau, purification. */
import { createRequire } from "node:module";

import { createApp, h, markRaw, nextTick, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import PageCode from "../../src/components/code/PageCode.vue";
import { moteurMarkdown } from "../../src/features/chat/rendu/instance";
import { CLE_CODE } from "../../src/features/code/domaine";
import type { DomaineCode } from "../../src/features/code/domaine";
import { etapes, formaterValeur, libelleOutil } from "../../src/features/code/rendu";
import type { MessageOpencode, PartOpencode } from "../../src/features/code/rendu";

vi.mock("../../src/platform/vendor", () => ({
  ensureVendor: () => Promise.reject(new Error("Chargement impossible")),
}));

let app: App | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

function texte(id: string, text: string, fin?: number): PartOpencode {
  return markRaw({ id, type: "text", text, time: fin ? { start: 1, end: fin } : { start: 1 } });
}

function message(id: string, parts: PartOpencode[], fini = false): MessageOpencode {
  const time = fini ? { created: 1, completed: 2 } : { created: 1 };
  return { id, role: "assistant", info: { id, role: "assistant", time }, parts };
}

function monter(messages: MessageOpencode[]) {
  const valeurs = reactive<Record<string, unknown>>({
    currentView: "code",
    codeAvailable: true,
    codeActiveId: "s1",
    codeSessions: [],
    codeMessages: messages,
    codeMessagesRendus: messages,
    codeDebutRendu: 0,
    codeLiveIdx: 0,
    codePerms: [],
    codeQuestions: [],
    codePrompt: "",
    settings: { chat_width: 70 },
    logoApp: "/logo.png",
    user: { avatar: null },
    codeSteps: etapes,
    codeFmtVal: formaterValeur,
    codeToolLabel: libelleOutil,
    codeMsgError: () => null,
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
  const ligne = (i = 0): MessageOpencode => (valeurs["codeMessagesRendus"] as MessageOpencode[])[i]!;
  const corps = (): HTMLElement[] => [...hote.querySelectorAll<HTMLElement>(".markdown-body")];
  return { hote, valeurs, ligne, corps };
}

/** Enregistre les mutations d'un corps pendant `geste` et rend celles qui touchent l'un des `figes`. */
async function mutationsDans(
  el: HTMLElement,
  figes: readonly Element[],
  geste: () => void,
): Promise<MutationRecord[]> {
  const recs: MutationRecord[] = [];
  const mo = new MutationObserver((r) => recs.push(...r));
  mo.observe(el, { childList: true, subtree: true, characterData: true });
  geste();
  await nextTick();
  recs.push(...mo.takeRecords());
  mo.disconnect();
  return recs.filter((r) => figes.some((f) => f.contains(r.target)));
}

const sansBlancs = (s: string): string => s.replace(/>\s+</g, "><").trim();
const DEBUT = "Premier paragraphe.\n\n```python\nx = 1\n```\n\nDeuxième en cou";

describe("page Code : message en cours rendu par blocs", () => {
  it("une mise à jour ne touche que le bloc actif ; les nœuds figés et la sélection restent, jusqu'après la fin", async () => {
    const { ligne, corps } = monter([message("a1", [texte("t1", DEBUT)])]);
    const [c] = corps();
    expect(c?.getAttribute("aria-busy")).toBe("true");
    const p = c!.querySelector("p")!;
    const noeud = p.firstChild!;
    const pre = c!.querySelector("pre");
    const sel = document.getSelection()!;
    const r = document.createRange();
    r.selectNodeContents(noeud);
    sel.removeAllRanges();
    sel.addRange(r);
    const figes = [...c!.children].slice(0, -1);
    expect(figes.length).toBe(2);
    const touches = await mutationsDans(c!, figes, () => {
      ligne().parts.splice(0, 1, texte("t1", DEBUT + "rs.\n\nTroisième"));
    });
    expect(touches).toEqual([]);
    expect(corps()[0]).toBe(c);
    expect(c!.querySelector("p")).toBe(p);
    expect(p.firstChild).toBe(noeud);
    expect(c!.querySelector("pre")).toBe(pre);
    expect(c!.textContent).toContain("Troisième");
    expect(sel.anchorNode).toBe(noeud);
    expect(sel.toString()).toBe("Premier paragraphe.");
    const final = DEBUT + "rs.\n\nTroisième et fin.";
    ligne().parts.splice(0, 1, texte("t1", final));
    ligne().info = { ...ligne().info, time: { created: 1, completed: 2 } };
    await nextTick();
    expect(corps()[0]).toBe(c);
    expect(c!.hasAttribute("aria-busy")).toBe(false);
    expect(c!.querySelector("p")).toBe(p);
    expect(c!.querySelector("pre")).toBe(pre);
    expect(sel.toString()).toBe("Premier paragraphe.");
    const blocs = [...c!.children].map((b) => b.innerHTML).join("");
    expect(sansBlancs(blocs)).toBe(sansBlancs(moteurMarkdown().renderMarkdown(final)));
  });

  it("parts successives (texte, outil, texte) : chacune garde ses blocs, une part finie est figée sans attendre le message", async () => {
    const outil = markRaw({ id: "o1", type: "tool", tool: "bash", state: { status: "running" } });
    const { ligne, corps } = monter([
      message("a1", [texte("t1", "Intro.\n\nSuite"), outil, texte("t3", "Après")]),
    ]);
    const [c1, c3] = corps();
    const enfants = [...c1!.children];
    const touches = await mutationsDans(c1!, [c1!], () => {
      ligne().parts.splice(2, 1, texte("t3", "Après l'outil.\n\nEncore"));
    });
    expect(touches).toEqual([]);
    expect(corps()[1]).toBe(c3);
    expect(c3!.textContent).toContain("Encore");
    ligne().parts.splice(0, 1, texte("t1", "Intro.\n\nSuite et fin.", 5));
    await nextTick();
    expect(c1!.hasAttribute("aria-busy")).toBe(false);
    expect(c1!.children[0]).toBe(enfants[0]);
    expect(c3!.getAttribute("aria-busy")).toBe("true");
  });

  it("message relu par le serveur (relecture, texte remplacé) : les blocs de tête restent", async () => {
    const { valeurs, corps } = monter([message("a1", [texte("t1", DEBUT)])]);
    const [c] = corps();
    const p = c!.querySelector("p");
    const pre = c!.querySelector("pre");
    // Relecture du transcript : nouvel objet message, même id, texte prolongé.
    const relu = [message("a1", [texte("t1", DEBUT + "rs.\n\nQuatre")])];
    valeurs["codeMessages"] = relu;
    valeurs["codeMessagesRendus"] = relu;
    await nextTick();
    expect(corps()[0]).toBe(c);
    expect(c!.querySelector("p")).toBe(p);
    expect(c!.textContent).toContain("Quatre");
    // Texte final du serveur différent du texte diffusé : la fin est redécoupée, la tête garde ses nœuds.
    const remplace = [
      message("a1", [texte("t1", "Premier paragraphe.\n\n```python\nx = 1\n```\n\nAutre fin.")], true),
    ];
    valeurs["codeMessages"] = remplace;
    valeurs["codeMessagesRendus"] = remplace;
    await nextTick();
    expect(corps()[0]).toBe(c);
    expect(c!.querySelector("p")).toBe(p);
    expect(c!.querySelector("pre")).toBe(pre);
    expect(c!.textContent).toContain("Autre fin.");
    expect(c!.textContent).not.toContain("Deuxième");
    expect(c!.hasAttribute("aria-busy")).toBe(false);
  });

  it("session changée : le transcript suivant ne reprend rien du précédent, même à id de part égal", async () => {
    const { valeurs, corps } = monter([message("a1", [texte("t1", DEBUT)])]);
    const [c] = corps();
    const autre = [message("b1", [texte("t1", "Autre session.\n\nEn cours")])];
    valeurs["codeMessages"] = autre;
    valeurs["codeMessagesRendus"] = autre;
    await nextTick();
    expect(c!.isConnected).toBe(false);
    expect(corps()[0]?.textContent).toContain("Autre session.");
    expect(corps()[0]?.textContent).not.toContain("Premier");
  });

  it("page masquée puis rouverte : le flux reprend sur les mêmes nœuds", async () => {
    const { valeurs, ligne, corps } = monter([message("a1", [texte("t1", DEBUT)])]);
    const [c] = corps();
    const p = c!.querySelector("p");
    valeurs["currentView"] = "chat";
    await nextTick();
    ligne().parts.splice(0, 1, texte("t1", DEBUT + "rs."));
    await nextTick();
    valeurs["currentView"] = "code";
    await nextTick();
    ligne().parts.splice(0, 1, texte("t1", DEBUT + "rs.\n\nRetour"));
    await nextTick();
    expect(corps()[0]).toBe(c);
    expect(c!.querySelector("p")).toBe(p);
    expect(c!.textContent).toContain("Retour");
  });

  it("message fini : rendu complet en cache, ni re-rendu ni reconstruit quand sa ligne change", async () => {
    const final = "## Titre\n\n- a\n- b\n\n```js\nx\n```";
    const { ligne, corps } = monter([message("a1", [texte("t1", final)], true)]);
    const [c] = corps();
    expect(c!.hasAttribute("aria-busy")).toBe(false);
    expect(c!.innerHTML).toBe(moteurMarkdown().renderMarkdown(final));
    const h2 = c!.querySelector("h2");
    ligne().parts.push(markRaw({ id: "o1", type: "tool", tool: "bash", state: { status: "completed" } }));
    await nextTick();
    expect(corps()[0]).toBe(c);
    expect(c!.querySelector("h2")).toBe(h2);
  });

  it("une fence diff qui se ferme pendant le flux laisse en place les blocs du texte qui la précède", async () => {
    const debut = "Intro.\n\nVoici le correctif :\n\n```diff\n-a\n+b";
    const { ligne, corps } = monter([message("a1", [texte("t1", debut)])]);
    const [c] = corps();
    const p = c!.querySelector("p");
    ligne().parts.splice(0, 1, texte("t1", debut + "\n```\n\nEnsuite"));
    await nextTick();
    expect(corps()[0]).toBe(c);
    expect(c!.querySelector("p")).toBe(p);
    expect(c!.querySelector("pre")).toBeNull();
    expect(corps()[1]?.textContent).toContain("Ensuite");
  });

  it("un bloc de code figé est coloré pendant le flux, pas la fence encore ouverte", async () => {
    // Laisse passer les tranches de coloration déjà programmées par les tests précédents.
    await new Promise((r) => setTimeout(r, 60));
    const hl = createRequire(import.meta.url)("@highlightjs/cdn-assets/highlight.min.js");
    (window as unknown as { hljs?: unknown }).hljs = hl;
    const tranches: ((e: { timeRemaining(): number }) => void)[] = [];
    vi.stubGlobal("requestIdleCallback", (cb: (e: { timeRemaining(): number }) => void) => tranches.push(cb));
    const vider = (): void => {
      while (tranches.length) tranches.shift()?.({ timeRemaining: () => 50 });
    };
    try {
      const { ligne, corps } = monter([message("a1", [texte("t1", "Avant\n\n```python\nx = 1")])]);
      const [c] = corps();
      vider();
      expect(c!.querySelector("[class^='hljs-']")).toBeNull();
      ligne().parts.splice(0, 1, texte("t1", "Avant\n\n```python\nx = 1\n```\n\nSuite\n\n```python\ny = 2"));
      await nextTick();
      vider();
      const [fige, ouvert] = [...c!.querySelectorAll("pre code")];
      expect(fige?.querySelectorAll(".hljs-number").length).toBe(1);
      expect(ouvert?.querySelector("[class^='hljs-']")).toBeNull();
      expect(c!.getAttribute("aria-busy")).toBe("true");
    } finally {
      delete (window as unknown as { hljs?: unknown }).hljs;
    }
  });

  it("un bloc de code reste du code quel que soit son langage, pendant le flux et après la fin", async () => {
    const SPECIAUX =
      'Fichier :\n\n```elpis-skin\n{"nom": "mon-skin"}\n```\n\nIcône :\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>\n```\n\n```mermaid\ngraph TD; A-->B\n```\n\n```chart-ref\n0123456789ab\n```\n\nCommit `!0123456789ab` et !0123456789ab poussés.\n';
    const { ligne, corps } = monter([message("a1", [texte("t1", SPECIAUX.slice(0, 40))])]);
    ligne().parts.splice(0, 1, texte("t1", SPECIAUX));
    await nextTick();
    ligne().info = { ...ligne().info, time: { created: 1, completed: 2 } };
    await nextTick();
    await new Promise((r) => setTimeout(r, 300));
    const c = corps()[0]!;
    expect(c.hasAttribute("aria-busy")).toBe(false);
    expect(c.querySelectorAll("pre code").length).toBe(4);
    expect(c.textContent).toContain('{"nom": "mon-skin"}');
    expect(c.textContent).toContain("<rect width=");
    expect(c.textContent).toContain("graph TD; A-->B");
    expect(c.textContent).toContain("!0123456789ab poussés");
    expect(c.querySelector("svg, .svg-render, .chart-ref-holder, [data-renvoi-graphique]")).toBeNull();
  });

  it("aucune charge XSS n'atteint le DOM : blocs figés, bloc actif et fin du message", async () => {
    const charge =
      'x <img src=x onerror="alert(1)"> <svg onload="alert(1)"><script>alert(1)</script></svg> [a](javascript:alert(1))';
    const { hote, ligne } = monter([message("a1", [texte("t1", charge + "\n\n" + charge)])]);
    const verifier = (): void => {
      expect(hote.querySelector("script")).toBeNull();
      expect(hote.innerHTML).not.toMatch(/onerror|onload|javascript:/i);
    };
    verifier();
    ligne().parts.splice(0, 1, texte("t1", charge + "\n\n" + charge + "\n\n" + charge));
    await nextTick();
    verifier();
    ligne().info = { ...ligne().info, time: { created: 1, completed: 2 } };
    await nextTick();
    verifier();
  });
});
