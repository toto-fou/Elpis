// SPDX-License-Identifier: MIT
/** frontend/test/chat/composeur/composeur.test.ts — composeur : @mention (arbre, filtre, récents, insertion en pièce jointe, plafond), cascade clavier ; composants MenuMention, PiecesJointes, ZoneSaisie. */
import { computed, createApp, h, nextTick, reactive, ref, shallowRef } from "vue";
import type { App, VNode } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import MenuMention from "../../../src/components/chat/composeur/MenuMention.vue";
import PiecesJointes from "../../../src/components/chat/composeur/PiecesJointes.vue";
import ZoneSaisie from "../../../src/components/chat/composeur/ZoneSaisie.vue";
import { creerComposeur } from "../../../src/features/chat/composeur/composeur";
import type { FichierMention, PieceJointe } from "../../../src/features/chat/composeur/composeur";

let app: App | null = null;

function monter(rendu: () => VNode | VNode[]): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: rendu });
  app.mount(hote);
  return hote;
}

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
  localStorage.clear();
});

const ARBRE = {
  items: [
    { type: "dir", path: "src", children: [{ type: "file", path: "src/main.py", name: "main.py" }] },
    { type: "file", path: "README.md", name: "README.md" },
  ],
};

function monterComposeur() {
  const ta = document.createElement("textarea");
  document.body.appendChild(ta);
  const inputRef = ref<HTMLTextAreaElement | null>(ta);
  const inputMessage = ref("");
  const attachedFiles = ref<PieceJointe[]>([]);
  const isStreaming = ref(false);
  const toasts: string[] = [];
  const urls: string[] = [];
  let envois = 0;
  const c = creerComposeur(
    { ref, nextTick, computed, reactive },
    { inputRef, inputMessage, attachedFiles, isStreaming },
    {
      fetchAuth: (url: string) => {
        urls.push(url);
        const corps = url.startsWith("/api/sandbox/tree") ? JSON.stringify(ARBRE) : "print(1)\n";
        return Promise.resolve(new Response(corps));
      },
      showToast: (m: string) => toasts.push(m),
      sendMessage: () => {
        envois++;
      },
    },
  );
  const taper = async (texte: string): Promise<void> => {
    inputMessage.value = texte;
    ta.value = texte;
    ta.setSelectionRange(texte.length, texte.length);
    await (c.handleInputInput as () => Promise<void>)();
  };
  return { c, ta, inputMessage, attachedFiles, isStreaming, toasts, urls, taper, envois: () => envois };
}

describe("creerComposeur", () => {
  it("@ ouvre la liste filtrée ; le choix retire @requête et joint le fichier", async () => {
    const m = monterComposeur();
    await m.taper("voir @mai");
    expect((m.c.showMentionDropdown as { value: boolean }).value).toBe(true);
    const fichiers = (m.c.mentionFiles as { value: FichierMention[] }).value;
    expect(fichiers.map((f) => f.path)).toEqual(["src/main.py"]);
    await (m.c.selectMention as (f: FichierMention) => Promise<void>)(fichiers[0] as FichierMention);
    expect(m.inputMessage.value).toBe("voir ");
    expect(m.attachedFiles.value).toEqual([{ name: "src/main.py", content: "print(1)\n", isMention: true }]);
    expect(m.urls.filter((u) => u.startsWith("/api/sandbox/tree")).length).toBe(1);
    await m.taper("@");
    const tous = (m.c.mentionFiles as { value: FichierMention[] }).value;
    expect(tous[0]?.path).toBe("src/main.py");
    expect((m.c.mentionRecentCount as { value: number }).value).toBe(1);
    expect(m.urls.filter((u) => u.startsWith("/api/sandbox/tree")).length).toBe(1);
  });

  it("clavier : flèches et Échap dans la liste ; Entrée envoie, sauf pendant un flux", async () => {
    const m = monterComposeur();
    await m.taper("@");
    const touche = m.c.handleInputKeydown as (e: KeyboardEvent) => void;
    touche(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect((m.c.mentionIndex as { value: number }).value).toBe(1);
    touche(new KeyboardEvent("keydown", { key: "Escape" }));
    expect((m.c.showMentionDropdown as { value: boolean }).value).toBe(false);
    touche(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    expect(m.envois()).toBe(1);
    m.isStreaming.value = true;
    touche(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    expect(m.envois()).toBe(1);
  });

  it("plafond de 10 pièces jointes", async () => {
    const m = monterComposeur();
    m.attachedFiles.value = Array.from({ length: 10 }, (_, i) => ({ name: "f" + i }));
    await (m.c.selectMention as (f: FichierMention) => Promise<void>)({
      path: "README.md",
      name: "README.md",
    });
    expect(m.toasts).toEqual(["Maximum 10 fichiers joints"]);
  });
});

describe("composants du composeur", () => {
  it("MenuMention : sections Récents/Tous, choix et survol remontés", async () => {
    const evts: unknown[] = [];
    const hote = monter(() =>
      h(MenuMention, {
        ouvert: true,
        requete: "",
        fichiers: [
          { path: "a/b.ts", name: "b.ts" },
          { path: "c.md", name: "c.md" },
        ],
        index: 0,
        recents: 1,
        chargement: false,
        encore: true,
        onChoisir: (f: FichierMention) => evts.push(["choisir", f.path]),
        onSurvol: (i: number) => evts.push(["survol", i]),
      }),
    );
    await nextTick();
    expect(hote.textContent).toContain("Récents");
    expect(hote.textContent).toContain("Tous");
    expect(hote.textContent).toContain("Faire défiler");
    const lignes = hote.querySelectorAll<HTMLElement>("li[data-mention-row]");
    expect(lignes[0]?.querySelector("i")?.className).toContain("ph-file-ts");
    lignes[1]?.dispatchEvent(new MouseEvent("mouseover"));
    lignes[1]?.click();
    expect(evts).toEqual([
      ["survol", 1],
      ["choisir", "c.md"],
    ]);
  });

  it("PiecesJointes et ZoneSaisie : retrait, texte et élément publiés", async () => {
    const retraits: number[] = [];
    const texte = shallowRef("abc");
    let element: HTMLTextAreaElement | null = null;
    const saisies: string[] = [];
    const hote = monter(() => [
      h(PiecesJointes, {
        fichiers: [{ name: "src/a.py", content: "x\ny", isMention: true }, { name: "notes.txt" }],
        onRetirer: (i: number) => retraits.push(i),
      }),
      h(ZoneSaisie, {
        texte: texte.value,
        placeholder: "Votre message",
        "onUpdate:texte": (v: string) => (texte.value = v),
        onElement: (el: HTMLTextAreaElement | null) => (element = el),
        onSaisie: () => saisies.push(texte.value),
      }),
    ]);
    expect(hote.textContent).toContain("2L");
    hote.querySelectorAll<HTMLButtonElement>("button")[1]?.click();
    expect(retraits).toEqual([1]);
    const ta = hote.querySelector("textarea") as HTMLTextAreaElement;
    expect(element).toBe(ta);
    expect(ta.placeholder).toBe("Votre message");
    ta.value = "abcd";
    ta.dispatchEvent(new Event("input"));
    expect(saisies).toEqual(["abcd"]);
    expect(ta.style.minHeight).toBe("40px");
  });

  it("ZoneSaisie : deux lignes (60 px) au moins sur la page de nouveau chat, une ligne ensuite (hauteur ajustée rendue)", async () => {
    const nouveau = shallowRef(true);
    const hote = monter(() => h(ZoneSaisie, { texte: "", placeholder: "", nouveauChat: nouveau.value }));
    const ta = hote.querySelector("textarea") as HTMLTextAreaElement;
    expect(ta.style.minHeight).toBe("60px");
    ta.style.height = "60px";
    nouveau.value = false;
    await nextTick();
    expect(ta.style.minHeight).toBe("40px");
    expect(ta.style.height).toBe("");
  });
});
