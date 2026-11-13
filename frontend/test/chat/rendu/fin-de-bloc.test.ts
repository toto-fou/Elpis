// SPDX-License-Identifier: MIT
/** frontend/test/chat/rendu/fin-de-bloc.test.ts — réparation de la fin inachevée du bloc actif : règles, faux positifs, idempotence, réponse coupée à chaque caractère. */
import * as marked from "marked";
import { beforeAll, describe, expect, it } from "vitest";

import { reparerFinDeBloc } from "../../../src/features/chat/rendu/fin-de-bloc";
import type { EtatFlux } from "../../../src/features/chat/rendu/flux-blocs";
import { moteurMarkdown } from "../../../src/features/chat/rendu/instance";
import type { MoteurMarkdown } from "../../../src/features/chat/rendu/markdown";

let m: MoteurMarkdown;

beforeAll(() => {
  m = moteurMarkdown();
});

function texteHorsCode(html: string): string {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  for (const el of Array.from(tpl.content.querySelectorAll("pre, code"))) el.remove();
  return tpl.content.textContent ?? "";
}

function sansBlocVide(html: string): boolean {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  return Array.from(tpl.content.querySelectorAll("li, h1, h2, h3, h4, h5, h6, blockquote")).every(
    (el) => (el.textContent ?? "").trim() !== "" || el.querySelector("img, input") !== null,
  );
}

const INLINE: [string, string][] = [
  ["**Lecture du f", "**Lecture du f**"],
  ["Un *peu", "Un *peu*"],
  ["Un __gras", "Un __gras__"],
  ["Un _peu", "Un _peu_"],
  ["Un ~~barré", "Un ~~barré~~"],
  ["Du `code", "Du `code`"],
  ["Du ``code", "Du ``code``"],
  ["Du ``code`", "Du ``code``"],
  ["**gras et *ital", "**gras et *ital***"],
  ["*ital et **gras", "*ital et **gras***"],
  ["***tout", "***tout***"],
  ["**a _b", "**a _b_**"],
  ["**a `b", "**a `b`**"],
  ["~~barré **g", "~~barré **g**~~"],
  ["**gras ", "**gras** "],
  ["**gras\n", "**gras**\n"],
  ["**a\nsuite", "**a\nsuite**"],
  ["Un **gras** puis **autre", "Un **gras** puis **autre**"],
  ["(**note", "(**note**"],
  ["**gras 😀", "**gras 😀**"],
  ["😀 *ital", "😀 *ital*"],
  ["- **a", "- **a**"],
  ["1. **Lecture du flux", "1. **Lecture du flux**"],
  ["   - un *peu", "   - un *peu*"],
  ["## Titre **x", "## Titre **x**"],
  ["> citation *x", "> citation *x*"],
  [
    "Premier paragraphe **complet** ici.\n\nSecond **inachevé",
    "Premier paragraphe **complet** ici.\n\nSecond **inachevé**",
  ],
  ["```\nx **y\n```\nTexte **z", "```\nx **y\n```\nTexte **z**"],
  ["| a | b |\n| --- | --- |\n| 1 | **2", "| a | b |\n| --- | --- |\n| 1 | **2**"],
  ["| a | b |\n| --- | --- |\n| **x** | un *peu", "| a | b |\n| --- | --- |\n| **x** | un *peu*"],
  ["Voici **", "Voici"],
  ["Voici **gras** et __", "Voici **gras** et"],
  ["Voici ~~", "Voici"],
  ["Voici (**", "Voici ("],
  ["**a *", "**a**"],
  ["**https://exemple.fr/a_b et *x", "**https://exemple.fr/a_b et *x***"],
];

const LIENS: [string, string][] = [
  ["[Voir la doc](https://exe", "Voir la doc"],
  ["Voir [la doc](", "Voir la doc"],
  ['[a](b "titre', "a"],
  ["![logo](http", "logo"],
  ["Texte [", "Texte"],
  ["Image ![", "Image"],
  ["(![", "("],
  ["**[Lien](http", "**Lien**"],
  ["Un [lien **gras](http://x", "Un lien **gras**"],
  ["- [", ""],
  ["- [ ] [tâche](http", "- [ ] tâche"],
];

const MARQUEURS: [string, string][] = [
  ["#", ""],
  ["## ", ""],
  ["###### ", ""],
  ["-", ""],
  ["- ", ""],
  ["*", ""],
  ["+", ""],
  ["1.", ""],
  ["12)", ""],
  [">", ""],
  ["> -", ""],
  ["`", ""],
  ["``", ""],
  ["~", ""],
  ["~~", ""],
  ["Intro\n-", "Intro"],
  ["Intro :\n\n1.", "Intro :\n\n"],
  ["Liste :\n- a\n- b\n- ", "Liste :\n- a\n- b"],
  ["- a\n  - b\n  -", "- a\n  - b"],
  ["Titre\n\n##", "Titre\n\n"],
  ["Texte\n``", "Texte"],
  ["Une **phrase\n-", "Une **phrase**"],
  ["Un paragraphe.\n\n>", "Un paragraphe.\n\n"],
];

const TABLEAUX: [string, string][] = [
  ["| a | b", ""],
  ["| a | b |\n", ""],
  ["|", ""],
  ["Intro :\n\n| Réglage | Avant", "Intro :\n\n"],
  ["Intro :\n| a | b |", "Intro :"],
  ["| a | b |\n|", ""],
  ["| a | b |\n| --- |", ""],
  ["| a | b |\n| --- | :", ""],
  ["| a | b | c |\n| --- | --- |", ""],
  ["| a | b |\n| --- | --- |\n|", "| a | b |\n| --- | --- |"],
];

const TABLEAUX_INTACTS = [
  "| a | b |\n| --- | --- |",
  "| a | b |\n| --- | --- |\n| 1 | 2 |",
  "| a | b |\n| :--- | ---: |\n| 1 | 2",
  "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |",
  "| a | b |\n| c | d |\n",
  "| a | b |\n| --- | --- | --- |\n",
];

const BALISES: [string, string][] = [
  ["Voici <div", "Voici"],
  ["Voici <", "Voici"],
  ['<a href="https://x', ""],
  ["<img src=x", ""],
  ["x <div cla", "x"],
  ["a </di", "a"],
  ["voir <https://exemple.fr/a_b", "voir"],
  ["**gras <span", "**gras**"],
];

const FENCES_OUVERTES = [
  "```js\nconst a = **1",
  "Texte **x\n```js\nconst b = *2",
  "```\nligne _a\n\nligne `b",
  "~~~\n| a | b",
  "```py\n# titre\n- a\n-",
  "```",
  "Avant\n```",
];

const INTACTS = [
  "Une phrase complète.",
  "Un paragraphe terminé avec **gras**, *italique*, ***les deux***, ~~barré~~ et `code`.",
  "- une puce",
  "* une puce",
  "+ une puce",
  "1. un item",
  "- a\n- b\n- c",
  "# Titre",
  "## Titre **gras**",
  "> une citation",
  "> citation sur\n> deux lignes",
  "snake_case et mon_fichier.py et un_identifiant_long_ici",
  "_private_var n'est pas une emphase fermée mais _on_ oui",
  "Le fichier mon_fichier_v2.pdf et __init__.py",
  "3 * 4 = 12",
  "a * b * c",
  "2*3",
  "x**2",
  "**Note:**texte collé, que marked laisse brut",
  "Prix HT*",
  "Voir la note*",
  "Voir la note [1]",
  "`**non fermé` et `_a_b`",
  "`a_b`, `a*b`, `**`",
  "Du code en ligne avec `` ` `` dedans",
  "https://exemple.fr/mon_fichier_v2.pdf",
  "https://exemple.fr/_next/static/*.js",
  "voir https://exemple.fr/a_b_c et www.exemple.fr/_x",
  "**https://exemple.fr/a_b**",
  "(https://exemple.fr/a_b)",
  "https://en.wikipedia.org/wiki/Foo_(bar)",
  "<https://exemple.fr/a_b>",
  "nom_prenom@exemple.fr",
  "a < b et c > d",
  "a<b",
  "if x<y alors",
  "<3",
  "a <= b",
  "<span>ok</span> et <br/> et <a href='x_y'>l_a</a>",
  "- [ ] tâche",
  "- [x] fait",
  "[x]",
  "[ ]",
  "[note] entre crochets",
  "[0, 1[",
  "x ∈ ]0, 1[",
  "tab[i](x)",
  "[lien](https://exemple.fr/a_b)",
  "[lien **gras**](https://exemple.fr/a_(b))",
  "![image](https://exemple.fr/y_z.png)",
  "[a][ref] et [^1]",
  "L'apostrophe d'un 'mot' et \"une citation\" et « des guillemets ».",
  "😀 **gras** 👍 et 😀*x*😀",
  "**gras 😀**",
  "𝒜_𝒷 et 𝕩*𝕪",
  "texte avec \\* échappé et \\_ aussi et \\` encore",
  "fin avec antislash \\",
  "---",
  "***",
  "___",
  "Texte\n\n---",
  "```js\nconst a = **1;\n```",
  "```\nx\n```",
  "Avant\n\n```py\nx = 1\n```\n\nAprès",
  "    du code indenté _a",
  "Un tableau | pas | vraiment",
  "Les |valeurs| absolues",
  "2024.",
  "Année\n2024.",
  "####### sept dièses",
  "#hashtag",
  "-a",
  "**gras** et _italique_ puis ~~barré~~ et `code` et [lien](http://x.fr).",
  "",
  "   ",
  "\n\n",
];

describe("fin de bloc : règles", () => {
  it.each(INLINE)("emphase et code en ligne : %j", (entree, sortie) => {
    expect(reparerFinDeBloc(entree)).toBe(sortie);
  });

  it.each(LIENS)("lien ou image en cours : %j", (entree, sortie) => {
    expect(reparerFinDeBloc(entree)).toBe(sortie);
  });

  it.each(MARQUEURS)("marqueur de bloc nu : %j", (entree, sortie) => {
    expect(reparerFinDeBloc(entree)).toBe(sortie);
  });

  it.each(TABLEAUX)("tableau pas encore décidé : %j", (entree, sortie) => {
    expect(reparerFinDeBloc(entree)).toBe(sortie);
  });

  it.each(TABLEAUX_INTACTS)("tableau décidé laissé tel quel : %j", (entree) => {
    expect(reparerFinDeBloc(entree)).toBe(entree);
  });

  it.each(BALISES)("balise HTML inachevée : %j", (entree, sortie) => {
    expect(reparerFinDeBloc(entree)).toBe(sortie);
  });

  it.each(FENCES_OUVERTES)("fence ouverte : rien n'est touché : %j", (entree) => {
    expect(reparerFinDeBloc(entree)).toBe(entree);
  });
});

describe("fin de bloc : texte complet et valide", () => {
  it.each(INTACTS)("rendu tel quel : %j", (entree) => {
    expect(reparerFinDeBloc(entree)).toBe(entree);
  });

  it("une réparation ne touche jamais les paragraphes précédents", () => {
    const avant = "Un *paragraphe terminé mais bancal.\n\nUn `autre.\n\n";
    expect(reparerFinDeBloc(avant + "Fin **ouverte")).toBe(avant + "Fin **ouverte**");
  });
});

describe("fin de bloc : le moteur rend ce qui est annoncé", () => {
  const CAS = [...INLINE, ...LIENS, ...BALISES].map(([e]) => e);

  it.each(CAS)("aucun marqueur brut après rendu : %j", (entree) => {
    const hors = texteHorsCode(m.renderStreamingActive(entree));
    expect(hors).not.toContain("**");
    expect(hors).not.toContain("__");
    expect(hors).not.toContain("~~");
    expect(hors).not.toContain("`");
    expect(hors).not.toContain("](");
    expect(hors).not.toContain("<div");
    expect(hors).not.toMatch(/\[$/);
  });

  it("le texte réparé rend la même structure que le texte fermé à la main", () => {
    expect(m.renderStreamingActive("**Lecture du f")).toBe(m.renderStreamingActive("**Lecture du f**"));
    expect(m.renderStreamingActive("1. un *peu")).toBe(m.renderStreamingActive("1. un *peu*"));
    expect(m.renderStreamingActive("Voir [la doc](http")).toBe(m.renderStreamingActive("Voir la doc"));
    expect(m.renderStreamingActive("A **b `c")).toBe(m.renderStreamingActive("A **b `c`**"));
  });

  it("marqueur nu ou tableau en attente : aucun bloc vide, aucune barre brute", () => {
    for (const e of ["-", "1.", "##", ">", "Liste :\n- a\n-", "| a | b", "| a | b |\n| --- |"]) {
      const html = m.renderStreamingActive(e);
      expect(sansBlocVide(html), e).toBe(true);
      expect(texteHorsCode(html), e).not.toContain("|");
    }
  });
});

describe("fin de bloc : robustesse", () => {
  function graine(n: number): () => number {
    let s = n >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const JETONS = [
    "a",
    "b",
    "mot",
    " ",
    " ",
    "\n",
    "\n\n",
    "*",
    "**",
    "***",
    "_",
    "__",
    "~~",
    "~",
    "`",
    "``",
    "```",
    "[",
    "]",
    "(",
    ")",
    "](",
    "![",
    "<",
    ">",
    "<div ",
    "|",
    "-",
    "#",
    "1.",
    "\\",
    "😀",
    "x_y",
    "http://a_b.fr/*",
    "&amp;",
  ];

  function aleatoire(rand: () => number, taille: number): string {
    let s = "";
    for (let i = 0; i < taille; i++) s += JETONS[Math.floor(rand() * JETONS.length)] ?? "";
    return s;
  }

  it("ne lève jamais d'exception et reste idempotente sur des entrées quelconques", () => {
    const rand = graine(7);
    for (let i = 0; i < 4000; i++) {
      const e = aleatoire(rand, 1 + Math.floor(rand() * 30));
      const r = reparerFinDeBloc(e);
      expect(typeof r).toBe("string");
      expect(reparerFinDeBloc(r), JSON.stringify(e)).toBe(r);
    }
  });

  it("ne lève pas d'exception sur des chaînes extrêmes", () => {
    for (const e of [
      "\u0000",
      "\ud83d",
      "\udc00x",
      "﻿**a",
      "\r\n",
      "**\r\n",
      "a\r\n| b |\r\n",
      "\t- \t",
      " *a",
    ])
      expect(() => reparerFinDeBloc(e)).not.toThrow();
  });

  it("un texte dont tous les marqueurs sont consommés par marked n'est jamais modifié", () => {
    const rand = graine(42);
    const SAFE = [
      "a",
      "b",
      "mot",
      " ",
      " ",
      "\n",
      "*",
      "**",
      "_",
      "__",
      "~~",
      "`",
      "``",
      "x_y",
      "(",
      ")",
      "😀",
      ",",
      ".",
    ];
    let consommes = 0;
    for (let i = 0; i < 6000; i++) {
      let e = "";
      const n = 1 + Math.floor(rand() * 14);
      for (let k = 0; k < n; k++) e += SAFE[Math.floor(rand() * SAFE.length)] ?? "";
      const dernier = e.trimEnd().split("\n").pop()?.trim() ?? "";
      if (/^(?:(?:[-+*>]\s*)+|`{1,2}|~{1,2})?$/.test(dernier)) continue;
      const hors = texteHorsCode(marked.parse(e, { async: false }));
      if (/[*_~`]/.test(hors)) continue;
      consommes++;
      expect(reparerFinDeBloc(e), JSON.stringify(e)).toBe(e);
    }
    expect(consommes).toBeGreaterThan(500);
  });

  it("coût linéaire sur des entrées pathologiques de 12 000 caractères", () => {
    const gabarits = [
      "*a ",
      "`",
      "``a",
      "[a](",
      "<a ",
      "| a\n",
      "_a_",
      "**a *b ",
      "![",
      "\\",
      "a\n- ",
      "http://a_b ",
    ];
    for (const g of gabarits) {
      const e = g.repeat(Math.ceil(12000 / g.length)).slice(0, 12000);
      const t0 = performance.now();
      reparerFinDeBloc(e);
      expect(performance.now() - t0, g).toBeLessThan(400);
    }
  });
});

/** Réponse de mesure du banc de fluidité, avec ses repères `zq001`, `zq002`, … tous les ~120 caractères. */
const GABARIT = `Voici une synthèse du pipeline de mesure, étape par étape {m}. Chaque étape est décrite avec son rôle, ses entrées et ce qu'elle produit {m}.

## Vue d'ensemble

Le pipeline lit les événements du flux, les regroupe par image et les verse dans le fil {m}. Il ne modifie ni le serveur ni le protocole, seulement l'affichage {m}. Les mesures sont prises sur une machine modeste, processeur ralenti quatre fois {m}.

1. **Lecture du flux** : les lignes NDJSON arrivent une par une {m}.

   Chaque ligne porte un type et un texte, et le lecteur les ajoute au tampon {m}.

   - le tampon de réflexion {m}
   - le tampon de narration {m}
   - le tampon du corps {m}

2. **Versement lissé** : le tampon est révélé au fil des images {m}.

   La tranche révélée dépend du retard accumulé, pour ne jamais prendre de retard {m}.

3. **Rendu** : les blocs terminés sont figés, seul le bloc en cours est re-rendu {m}.

4. **Défilement** : le fil reste collé en bas tant que l'utilisateur ne remonte pas {m}.

### Exemple complet

\`\`\`python
# Mesure du délai entre l'arrivée et l'affichage {m}
import json
import statistics
from dataclasses import dataclass, field


@dataclass
class Releve:
    nom: str = "releve"
    valeurs: list = field(default_factory=list)

    def ajouter(self, v):
        self.valeurs.append(float(v))  # {m}

    def mediane(self):
        return statistics.median(self.valeurs) if self.valeurs else 0

    def p95(self):
        s = sorted(self.valeurs)
        return s[int(len(s) * 0.95)] if s else 0  # {m}


def lire(chemin):
    with open(chemin, encoding="utf-8") as f:
        for ligne in f:
            yield json.loads(ligne)  # {m}


def resumer(chemin):
    r = Releve()
    for evenement in lire(chemin):
        if evenement.get("type") == "content_token":
            r.ajouter(evenement.get("delai_ms", 0))  # {m}
    return {"mediane": r.mediane(), "p95": r.p95(), "n": len(r.valeurs)}


if __name__ == "__main__":
    print(json.dumps(resumer("flux.ndjson"), indent=2))  # {m}
\`\`\`

Le tableau suivant résume les réglages comparés {m} :

| Réglage | Avant | Après | Effet attendu |
| --- | --- | --- | --- |
| Cadence du bloc actif | 110 ms | chaque image | texte continu {m} |
| Fenêtre de lissage | 350 ms | 100 ms | moins de retard {m} |
| Tranche minimale | 24 car. | 3 car. | plus de paquets de mots {m} |
| Défilement | lissé puis recollé | une écriture par image | plus de tremblement {m} |

Quelques points d'attention {m} :

- le caret ne doit pas clignoter à chaque rendu {m}
- une sélection de texte doit survivre aux jetons suivants {m}
- le bouton Stop doit vider les tampons tout de suite {m}

> Remarque : un flux très rapide ne doit pas saturer le fil d'exécution principal {m}.
>
> Le budget par image reste de quelques millisecondes {m}.

Enfin, un long paragraphe pour mesurer le coût du bloc actif quand il grandit {m}. Le rendu du bloc en cours est refait à chaque mise à jour, et son coût suit sa longueur {m}. Tant que le paragraphe reste court, ce coût est négligeable, mais un modèle qui écrit sans ligne vide pendant longtemps finit par produire un bloc de plusieurs kilo-octets {m}. Dans ce cas le moteur doit adapter sa cadence au temps de rendu mesuré plutôt qu'à la taille totale du message {m}. Les blocs déjà figés ne coûtent rien, puisqu'ils ne sont plus jamais re-rendus {m}. C'est la raison pour laquelle la garde doit porter sur le bloc actif seul {m}.

\`\`\`
$ node banc.mjs --cpu 4 --debit 60
images : 60/s, perdues 0 % {m}
delai jeton vers ecran : mediane 180 ms, p95 420 ms {m}
\`\`\`

En résumé, le fil doit rester fluide du premier au dernier jeton {m}.
`;

/** Deuxième réponse : liens, images, barré, citation imbriquée, cases à cocher, émojis, adresses nues et notes. */
const GABARIT_RICHE = `# Guide **rapide** de l'outil

Le fichier \`mon_fichier.py\` contient la fonction \`lire_config()\` et le module snake_case_utile {m}. Voir [la documentation](https://exemple.fr/doc/mon_guide_v2) ou l'adresse https://exemple.fr/_next/static/a_b.js {m}.

- [x] première tâche **terminée** {m}
- [ ] seconde tâche avec un [lien *italique*](https://exemple.fr/a_b) {m}
- une puce avec 😀 et du ~~texte barré~~ {m}
  - sous-puce avec \`code_inline\` {m}

1. Premier point : la multiplication 3 * 4 = 12 reste telle quelle {m}.
2. Second point : ![logo](data:image/png;base64,AAAA) et une note* en bas {m}.

> Citation avec **gras** et *italique*, sur une ligne {m}.
> Suite de la citation avec un [lien](https://exemple.fr/c) {m}.

Un paragraphe sur plusieurs
lignes avec **un gras qui commence ici
et finit là** puis du texte {m}.

*Note : les chiffres sont approximatifs* {m}.
`;

function repondre(gabarit: string): string {
  let n = 0;
  return gabarit.replace(/\{m\}/g, () => "zq" + String(++n).padStart(3, "0"));
}

describe.each([
  ["réponse de mesure", repondre(GABARIT)],
  ["réponse riche", repondre(GABARIT_RICHE)],
])("fin de bloc : %s coupée à chaque caractère", (_nom, texte) => {
  it("le bloc actif n'affiche jamais de marqueur brut en fin de texte", () => {
    let etat: EtatFlux | null = null;
    for (let k = 1; k <= texte.length; k++) {
      const r = m.avancerFlux(texte.slice(0, k), etat);
      etat = r.etat;
      if (!r.actifHtml) continue;
      const html = r.actifHtml;
      const hors = texteHorsCode(html);
      const contexte = `${k}: ${JSON.stringify(r.etat.texte.slice(r.etat.pos).slice(-60))}`;
      expect(hors, contexte).not.toContain("**");
      expect(hors, contexte).not.toContain("~~");
      expect(hors, contexte).not.toContain("`");
      expect(hors, contexte).not.toContain("](");
      expect(hors, contexte).not.toContain("|");
      expect(hors, contexte).not.toMatch(/(?:^|\n)\s*(?:#{1,6}|[-*+>]|\d+[.)])\s*$/);
      expect(hors, contexte).not.toMatch(/!?\[$/);
      expect(sansBlocVide(html), contexte).toBe(true);
    }
  });

  it("le texte complet est rendu comme sans réparation et n'est pas modifié", () => {
    const etat = m.terminerFlux(texte, null)?.etat;
    expect(etat?.blocs.length).toBeGreaterThan(0);
    for (const bloc of etat?.blocs ?? []) {
      if (!bloc.src.trim() || /^\s*(?:```|~~~)/.test(bloc.src)) continue;
      expect(reparerFinDeBloc(bloc.src), JSON.stringify(bloc.src.slice(0, 40))).toBe(bloc.src);
      expect(m.renderStreamingActive(bloc.src)).toBe(marked.parse(bloc.src, { async: false }));
    }
  });

  it("chaque état intermédiaire est stable : réparer deux fois donne le même texte", () => {
    let etat: EtatFlux | null = null;
    for (let k = 1; k <= texte.length; k += 3) {
      const r = m.avancerFlux(texte.slice(0, k), etat);
      etat = r.etat;
      const actif = r.etat.texte.slice(r.etat.pos);
      const reparee = reparerFinDeBloc(actif);
      expect(reparerFinDeBloc(reparee), `${k}`).toBe(reparee);
    }
  });
});
