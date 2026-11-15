// SPDX-License-Identifier: MIT
/** frontend/test/reglages/aide-rendu.test.ts — guide de la fenêtre d'aide : découpe en sections, ancres, clips posés en lecteurs chargés à l'approche de l'écran, sommaire, recherche, liens et ouverture en contexte de la fenêtre. */
import fs from "node:fs";
import path from "node:path";

import { nextTick } from "vue";
import type { InjectionKey } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import ModaleAide from "../../src/components/chat/modales/ModaleAide.vue";
import { CLE_MODALES } from "../../src/features/chat/modales/domaine";
import { clicMarkdown } from "../../src/features/chat/rendu/enrichissement";
import { BLOCS_AIDE } from "../../src/features/reglages/aide";
import {
  ancreTitre,
  decouperGuide,
  lireGuide,
  monterSection,
  titreVise,
  trouverSection,
} from "../../src/features/reglages/aide-rendu";
import type { SectionMontee } from "../../src/features/reglages/aide-rendu";
import * as mouvement from "../../src/platform/mouvement";
import { demonter, etat, monter } from "../chat/page/montage";

const RACINE = path.resolve(import.meta.dirname, "../../..");
const GUIDE = fs.readFileSync(path.join(RACINE, "docs/fr/user-guide.md"), "utf8");
const CLIPS = path.join(RACINE, "docs/media/aide");
const montees: SectionMontee[] = [];

const EXEMPLE = [
  "# Mon guide",
  "",
  "> Accroche du document.",
  "",
  "---",
  "",
  "# Au quotidien",
  "",
  "## Le chat",
  "<!-- aide: chat -->",
  "",
  "[Démonstration : envoyer un message](../media/aide/chat-envoyer.webm)",
  "",
  "Voir aussi [les routines](#les-routines), [la planification](#déclencheurs) et [les mentions](#mention-fichier).",
  "",
  "Hors de l'application : [la doc](../architecture.md).",
  "",
  "### Mention `@fichier`",
  "",
  "```md",
  "## Pas un titre",
  "```",
  "",
  "---",
  "",
  "## Les routines",
  "<!-- aide: routines -->",
  "",
  "Une routine relance un prompt.",
  "",
  "### Déclencheurs",
  "",
  "Horaire ou événement.",
  "",
  "# Aide",
  "",
  "## Questions fréquentes",
  "",
  "Réponse courte.",
].join("\n");

type Entree = Partial<IntersectionObserverEntry>;
type Signal = (e: Entree[]) => void;

// Deux observateurs par section montée : le premier charge à l'approche, le second lit ce qui est visible.
function observateurs(): Signal[] {
  const signaux: Signal[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: Signal) {
        signaux.push(cb);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  return signaux;
}

// Entrée d'observateur comme un navigateur l'envoie : part visible du clip, hauteurs du clip vu et de l'écran.
function entree(target: Element, part: number, vu = 400 * part, ecran = 600): Entree {
  return {
    target,
    isIntersecting: part > 0,
    intersectionRatio: part,
    intersectionRect: { height: vu } as DOMRectReadOnly,
    rootBounds: { height: ecran } as DOMRectReadOnly,
  };
}

// Lecture simulée : `play` et `pause` tiennent `paused` et émettent leur événement, comme un vrai lecteur.
function lecteurSimule(): void {
  const etats = new WeakMap<object, boolean>();
  Object.defineProperty(HTMLMediaElement.prototype, "paused", {
    configurable: true,
    get(this: object) {
      return etats.get(this) ?? true;
    },
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    etats.set(this, false);
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    if (etats.get(this) === false) {
      etats.set(this, true);
      this.dispatchEvent(new Event("pause"));
    }
  });
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
}

function poser(md: string): HTMLElement {
  const defilement = document.createElement("div");
  const corps = document.createElement("div");
  corps.className = "markdown-body";
  defilement.appendChild(corps);
  document.body.appendChild(defilement);
  montees.push(monterSection(corps, defilement, md));
  return corps;
}

afterEach(() => {
  for (const s of montees.splice(0)) s.detacher();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  demonter();
});

describe("découpe du guide", () => {
  it("une section par titre de niveau 2, groupée par titre de niveau 1 ; le titre du document est écarté", () => {
    const s = decouperGuide(EXEMPLE);
    expect(s.map((x) => [x.groupe, x.titre])).toEqual([
      ["", "Présentation"],
      ["Au quotidien", "Le chat"],
      ["Au quotidien", "Les routines"],
      ["Aide", "Questions fréquentes"],
    ]);
    expect(s[0]!.md).toBe("## Présentation\n\n> Accroche du document.");
    expect(decouperGuide("")).toEqual([]);
    expect(decouperGuide("## Seul\n\n---\n\n***\n").map((x) => x.md)).toEqual(["## Seul"]);
    expect(decouperGuide("\n\n---\n\n___\n")).toEqual([]);
    expect(decouperGuide("  \n")).toEqual([]);
  });

  it("clé de contexte lue puis retirée, filet final retiré, bloc de code jamais coupé", () => {
    const [, chat, routines] = decouperGuide(EXEMPLE.replace(/\n/g, "\r\n"));
    expect([chat!.cle, routines!.cle]).toEqual(["chat", "routines"]);
    expect(chat!.md).not.toContain("aide:");
    expect(chat!.md.startsWith("## Le chat")).toBe(true);
    expect(chat!.md.endsWith("```")).toBe(true);
    expect(chat!.md).toContain("## Pas un titre");
    expect(chat!.ancres).toEqual(["mention-fichier"]);
  });

  it("une section se retrouve par sa clé, son ancre ou l'ancre d'un sous-titre", () => {
    const s = decouperGuide(EXEMPLE);
    expect(trouverSection(s, "routines")?.titre).toBe("Les routines");
    expect(trouverSection(s, "#le-chat")?.titre).toBe("Le chat");
    expect(trouverSection(s, "déclencheurs")?.titre).toBe("Les routines");
    expect(trouverSection(s, "")).toBeUndefined();
    expect(trouverSection(s, "inconnue")).toBeUndefined();
  });

  it("ancres d'un Markdown publié : chaque espace en tiret, ponctuation retirée, doublons suffixés sans collision", () => {
    expect(ancreTitre("Vos **collections** (RAG)")).toBe("vos-collections-rag");
    expect(ancreTitre("Compaction et élagage : tenir dans le contexte")).toBe(
      "compaction-et-élagage--tenir-dans-le-contexte",
    );
    expect(ancreTitre("Commandes `/`")).toBe("commandes-");
    expect(ancreTitre("L'éditeur de code")).toBe("léditeur-de-code");
    const ids = (md: string): string[] => decouperGuide(md).map((x) => x.id);
    expect(ids("## Foo\n\nA\n\n## Foo\n\nB\n\n## Foo 1\n\nC")).toEqual(["foo", "foo-1", "foo-1-1"]);
    expect(ids("# Guide\n\nAccroche.\n\n## Présentation\n\nTexte.")).toEqual(["_0", "présentation"]);
    expect(decouperGuide("## Langage C#\n\nTexte.")[0]!.titre).toBe("Langage C#");
  });

  it("un commentaire, un bloc HTML ou un titre souligné ne trompent pas la découpe ; une définition de lien vaut partout", () => {
    const commentaire = decouperGuide("## A\n\n<!--\n## pas un titre\n-->\n\nSuite.\n\n## B\n\nFin.");
    expect(commentaire.map((x) => x.titre)).toEqual(["A", "B"]);
    const details = decouperGuide(
      "## A\n\n<details>\n<summary>Plus</summary>\n## dedans\n</details>\n\n## B\n\nFin.",
    );
    expect(details.map((x) => x.titre)).toEqual(["A", "B"]);
    const souligne = decouperGuide("Premier\n-------\n\nTexte.\n\nSecond\n------\n\nFin.");
    expect(souligne.map((x) => x.titre)).toEqual(["Premier", "Second"]);
    observateurs();
    const ref = decouperGuide("## A\n\nVoir [ici][r].\n\n## B\n\n[r]: https://exemple.test/page\n");
    const corps = poser(ref[0]!.md);
    expect(corps.querySelector("a")?.getAttribute("href")).toBe("https://exemple.test/page");
    expect(ref[0]!.recherche).not.toContain("exemple.test");
  });

  it("lu par tranches, le guide donne les mêmes sections que lu d'une traite, même autour d'un commentaire ou d'un bloc brut", () => {
    const pieges = [
      "# Guide",
      "",
      "## A",
      "",
      "<!-- note",
      "",
      "## dans un commentaire",
      "",
      "-->",
      "",
      "<pre>",
      "",
      "## dans un bloc brut",
      "",
      "</pre>",
      "",
      "```",
      "",
      "## dans du code",
      "```",
      "",
      "## B",
      "",
      "Fin.",
    ].join("\n");
    for (const texte of [GUIDE, EXEMPLE, pieges]) {
      const lecture = lireGuide(texte);
      let pas = 1;
      while (!lecture.avancer(0)) pas++;
      expect(lecture.sections()).toEqual(decouperGuide(texte));
      if (texte === GUIDE) expect(pas).toBeGreaterThan(20);
    }
    expect(decouperGuide(pieges).map((x) => x.titre)).toEqual(["A", "B"]);
  });

  it("le guide livré : ancres uniques, chaque lien interne mène à son titre, chaque écran a sa section", () => {
    const s = decouperGuide(GUIDE);
    expect(s.length).toBeGreaterThan(10);
    expect(new Set(s.map((x) => x.id)).size).toBe(s.length);
    expect(s.every((x) => x.md.trim() && x.recherche === x.recherche.toLowerCase())).toBe(true);
    const liens = [...GUIDE.matchAll(/\]\(#([^)\s]+)\)/g)].map((r) => decodeURIComponent(r[1]!));
    expect(liens.filter((l) => !trouverSection(s, l))).toEqual([]);
    const cles = [...Object.values(BLOCS_AIDE), "chat", "editeur"];
    expect(cles.filter((c) => trouverSection(s, c)?.cle !== c)).toEqual([]);
  });

  it("le guide livré ne mène nulle part hors de lui : ancres, clips et adresses complètes seulement", () => {
    const cibles = [...GUIDE.matchAll(/\]\(([^)\s]+)\)/g)].map((r) => r[1]!);
    const admises = /^(?:#|https?:\/\/|mailto:|\.\.\/media\/aide\/[a-z0-9-]{1,64}\.webm$)/;
    expect(cibles.filter((c) => !admises.test(c))).toEqual([]);
  });

  it("le guide livré et le dossier des clips se répondent : aucun lien mort, aucun clip orphelin, chaque clip cité une fois", () => {
    const cites = [...GUIDE.matchAll(/\]\(([^)\s]*\.webm)\)/g)].map((r) => r[1]!);
    expect(cites.filter((c) => !/^\.\.\/media\/aide\/[a-z0-9-]{1,64}\.webm$/.test(c))).toEqual([]);
    const noms = cites.map((c) => c.slice("../media/aide/".length));
    expect(noms.filter((n, i) => noms.indexOf(n) !== i)).toEqual([]);
    const livres = fs.existsSync(CLIPS) ? fs.readdirSync(CLIPS).filter((n) => n.endsWith(".webm")) : [];
    expect(noms.filter((n) => !livres.includes(n))).toEqual([]);
    expect(livres.filter((n) => !noms.includes(n))).toEqual([]);
    expect(noms.length).toBeGreaterThan(0);
  });
});

describe("clips d'une section", () => {
  it("un lien seul dans son paragraphe vers media/aide devient un lecteur ; tout autre lien reste un lien", () => {
    observateurs();
    const corps = poser(
      [
        "[Envoyer un message](../media/aide/chat-envoyer.webm)",
        "",
        "Dans une phrase, [le clip](../media/aide/chat-envoyer.webm) reste un lien.",
        "",
        "[Ailleurs](../autre/chat-envoyer.webm)",
      ].join("\n"),
    );
    const figures = corps.querySelectorAll("figure.aide-clip");
    expect(figures.length).toBe(1);
    const video = figures[0]!.querySelector("video")!;
    expect([video.muted, video.loop, video.preload, video.getAttribute("src")]).toEqual([
      true,
      true,
      "none",
      null,
    ]);
    expect(video.dataset["src"]).toBe("/api/help/media/chat-envoyer.webm");
    expect(figures[0]!.querySelector("figcaption")!.textContent).toBe("Envoyer un message");
    expect(figures[0]!.querySelector("button")!.getAttribute("aria-pressed")).toBe("false");
    expect(corps.querySelectorAll("a[href$='.webm']").length).toBe(2);
  });

  it("le texte du guide passe par la purification du chat : ni script ni gestionnaire d'événement", () => {
    observateurs();
    const corps = poser('Avant <img src="x" onerror="alert(1)"> et <script>alert(2)</script> après.');
    expect(corps.querySelector("script")).toBeNull();
    expect(corps.innerHTML).not.toContain("onerror");
    expect(corps.textContent).toContain("Avant");
  });

  it("chargé à l'approche ; joue quand 60 % du clip est visible, s'arrête dès qu'il en sort, même encore à l'écran", () => {
    const signaux = observateurs();
    lecteurSimule();
    vi.spyOn(mouvement, "mouvementReduit").mockReturnValue(false);
    const corps = poser("[Envoyer](../media/aide/chat-envoyer.webm)");
    const figure = corps.querySelector<HTMLElement>("figure")!;
    const video = figure.querySelector("video")!;
    const [charger, voir] = signaux as [Signal, Signal];
    charger([entree(figure, 0.05)]);
    expect(video.getAttribute("src")).toBe("/api/help/media/chat-envoyer.webm");
    voir([entree(figure, 0.3)]);
    expect(video.paused).toBe(true);
    voir([entree(figure, 0.7)]);
    expect([video.paused, figure.dataset["etat"]]).toEqual([false, "lecture"]);
    expect(figure.querySelector("button")!.getAttribute("aria-pressed")).toBe("true");
    voir([entree(figure, 0.4)]);
    expect([video.paused, figure.dataset["etat"]]).toEqual([true, "pause"]);
    voir([entree(figure, 0.7)]);
    voir([entree(figure, 0)]);
    expect(video.paused).toBe(true);
  });

  it("un clip plus haut que l'écran joue dès qu'il en couvre 60 %", () => {
    const signaux = observateurs();
    lecteurSimule();
    vi.spyOn(mouvement, "mouvementReduit").mockReturnValue(false);
    const corps = poser("[Envoyer](../media/aide/chat-envoyer.webm)");
    const figure = corps.querySelector<HTMLElement>("figure")!;
    signaux[1]!([entree(figure, 0.4, 200, 300)]);
    expect(figure.querySelector("video")!.paused).toBe(false);
  });

  it("animations réduites : jamais de départ seul, le clic lance puis arrête", () => {
    const signaux = observateurs();
    lecteurSimule();
    vi.spyOn(mouvement, "mouvementReduit").mockReturnValue(true);
    const corps = poser("[Envoyer](../media/aide/chat-envoyer.webm)");
    const figure = corps.querySelector<HTMLElement>("figure")!;
    const video = figure.querySelector("video")!;
    signaux[1]!([entree(figure, 1)]);
    expect(video.paused).toBe(true);
    figure.querySelector("button")!.click();
    expect([video.paused, figure.dataset["etat"], video.getAttribute("src")]).toEqual([
      false,
      "lecture",
      "/api/help/media/chat-envoyer.webm",
    ]);
    figure.querySelector("button")!.click();
    expect([video.paused, figure.dataset["etat"], figure.dataset["arret"]]).toEqual([true, "pause", "1"]);
  });

  it("un clip arrêté à la main ne repart pas seul ; un clip illisible retire son lecteur", () => {
    const signaux = observateurs();
    lecteurSimule();
    vi.spyOn(mouvement, "mouvementReduit").mockReturnValue(false);
    const corps = poser("[Un](../media/aide/un.webm)\n\n[Deux](../media/aide/deux.webm)");
    const [un, deux] = [...corps.querySelectorAll<HTMLElement>("figure")] as [HTMLElement, HTMLElement];
    signaux[1]!([entree(un, 1)]);
    un.querySelector("button")!.click();
    signaux[1]!([entree(un, 1)]);
    expect(un.querySelector("video")!.paused).toBe(true);
    deux.querySelector("video")!.dispatchEvent(new Event("error"));
    expect(corps.querySelectorAll("figure").length).toBe(1);
  });

  it("une section retirée arrête ses clips et libère leur adresse", () => {
    const signaux = observateurs();
    lecteurSimule();
    vi.spyOn(mouvement, "mouvementReduit").mockReturnValue(false);
    const corps = poser("[Envoyer](../media/aide/chat-envoyer.webm)");
    const figure = corps.querySelector<HTMLElement>("figure")!;
    const video = figure.querySelector("video")!;
    signaux[1]!([entree(figure, 1)]);
    expect(video.paused).toBe(false);
    montees.splice(0)[0]!.detacher();
    expect([video.paused, video.getAttribute("src")]).toEqual([true, null]);
  });
});

// La fenêtre découpe le guide puis pose la section dans des tâches à part, après sa propre peinture : les laisser passer.
async function taches(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 2));
  await nextTick();
}

describe("fenêtre d'aide", () => {
  function ouvrir(valeurs: Record<string, unknown> = {}) {
    observateurs();
    const suivis: Event[] = [];
    const dom = etat({
      showHelpModal: true,
      isLoadingReadme: false,
      readmeContent: EXEMPLE,
      helpSection: "",
      handleMarkdownClick: (ev: Event) => {
        suivis.push(ev);
        clicMarkdown(ev, {});
      },
      ...valeurs,
    });
    const hote = monter(ModaleAide, [[CLE_MODALES as InjectionKey<object>, dom]]);
    const doc = hote.ownerDocument;
    return {
      dom: dom as Record<string, unknown>,
      doc,
      suivis,
      titre: () => doc.querySelector('[role="dialog"] .markdown-body h2')?.textContent,
      entrees: () => [...doc.querySelectorAll<HTMLElement>("[data-aide-entree]")],
      recherche: () => doc.querySelector<HTMLInputElement>("[data-aide-recherche]")!,
      corps: () => doc.querySelector<HTMLElement>('[role="dialog"] .markdown-body')!,
    };
  }

  it("sommaire par groupe, première section par défaut, section de l'écran en cours si elle est demandée", async () => {
    const f = ouvrir();
    await taches();
    expect(f.entrees().map((e) => e.textContent!.trim())).toEqual([
      "Présentation",
      "Le chat",
      "Les routines",
      "Questions fréquentes",
    ]);
    expect(f.entrees()[0]!.getAttribute("aria-current")).toBe("page");
    f.dom["helpSection"] = "routines";
    await taches();
    await taches();
    expect(f.titre()).toBe("Les routines");
    expect(f.entrees()[2]!.getAttribute("aria-current")).toBe("page");
  });

  it("l'entrée de la section ouverte est amenée dans le sommaire", async () => {
    const vus: string[] = [];
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      vus.push((this.textContent ?? "").trim());
    });
    ouvrir({ helpSection: "routines" });
    await taches();
    expect(vus).toEqual(["Les routines"]);
  });

  it("une seule section à l'écran ; le sommaire en change et le titre de la nouvelle prend le focus", async () => {
    const f = ouvrir({ helpSection: "chat" });
    await taches();
    expect(f.titre()).toBe("Le chat");
    expect(f.corps().querySelectorAll("h2").length).toBe(1);
    expect(f.corps().querySelector("figure.aide-clip video")).not.toBeNull();
    expect(f.doc.activeElement?.tagName).not.toBe("H2");
    f.entrees()[3]!.click();
    await taches();
    expect(f.titre()).toBe("Questions fréquentes");
    expect(f.corps().querySelector("figure")).toBeNull();
    expect(f.doc.activeElement).toBe(f.corps().querySelector("h2"));
  });

  it("la recherche filtre le sommaire sans accents ni casse, Entrée ouvre le premier résultat", async () => {
    const f = ouvrir();
    await taches();
    const champ = f.recherche();
    champ.value = "EVENEMENT";
    champ.dispatchEvent(new Event("input"));
    await taches();
    expect(f.entrees().map((e) => e.textContent!.trim())).toEqual(["Les routines"]);
    champ.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await taches();
    expect(f.titre()).toBe("Les routines");
    champ.value = "introuvable";
    champ.dispatchEvent(new Event("input"));
    await taches();
    expect(f.entrees().length).toBe(0);
    expect(f.doc.querySelector('[data-aide-sommaire] [role="status"]')?.textContent).toContain(
      "Aucune section",
    );
  });

  it("la fenêtre s'affiche avant que le guide soit découpé : sommaire et section arrivent dans des tâches suivantes", async () => {
    const f = ouvrir();
    await nextTick();
    expect(f.doc.querySelector('[role="dialog"][aria-label="Aide"]')).not.toBeNull();
    expect(f.entrees().length).toBe(0);
    expect(f.doc.querySelector('[data-aide-sommaire] [role="status"]')).toBeNull();
    await taches();
    expect(f.entrees().length).toBe(4);
    expect(f.titre()).toBe("Présentation");
  });

  it("pendant le chargement, le sommaire vide ne dit pas qu'il n'y a rien", async () => {
    const f = ouvrir({ readmeContent: "", isLoadingReadme: true });
    await taches();
    expect(f.doc.querySelector('[data-aide-sommaire] [role="status"]')).toBeNull();
  });

  it("un lien vers une autre section en change, puis descend au sous-titre visé ; dans la même section, il y descend", async () => {
    const vus: string[] = [];
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      if (this.tagName !== "BUTTON") vus.push(this.tagName + ":" + (this.textContent ?? "").trim());
    });
    const f = ouvrir({ helpSection: "chat" });
    await taches();
    f.corps().querySelector<HTMLAnchorElement>('a[href="#mention-fichier"]')!.click();
    expect(vus).toEqual(["H3:Mention @fichier"]);
    f.corps().querySelector<HTMLAnchorElement>('a[href="#les-routines"]')!.click();
    await taches();
    expect(f.titre()).toBe("Les routines");
    expect(vus.length).toBe(1);
    f.entrees()[1]!.click();
    await taches();
    f.corps().querySelector<HTMLAnchorElement>('a[href^="#d"]')!.click();
    await taches();
    expect(f.titre()).toBe("Les routines");
    expect(vus[1]).toBe("H3:Déclencheurs");
    expect(f.doc.activeElement?.textContent).toBe("Déclencheurs");
  });

  it("un lien relatif vers un fichier ne fait pas quitter l'application", async () => {
    const f = ouvrir({ helpSection: "chat" });
    await taches();
    const lien = f.corps().querySelector<HTMLAnchorElement>('a[href="../architecture.md"]')!;
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    lien.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(f.suivis).toEqual([]);
    expect(titreVise(f.corps(), decouperGuide(EXEMPLE)[1]!, "")?.textContent).toBe("Le chat");
  });
});
