// SPDX-License-Identifier: MIT
/** frontend/test/chat/rendu/corpus-flux.ts — corpus de réponses Markdown pour comparer le rendu par blocs du flux au rendu complet : cas limites du lexer et réponses réalistes. */

/** Réponse de mesure du banc de fluidité, avec ses repères `zq001`, `zq002`, … tous les ~120 caractères. */
const MESURE = `Voici une synthèse du pipeline de mesure, étape par étape {m}. Chaque étape est décrite avec son rôle, ses entrées et ce qu'elle produit {m}.

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

function repondre(gabarit: string): string {
  let n = 0;
  return gabarit.replace(/\{m\}/g, () => "zq" + String(++n).padStart(3, "0"));
}

export const CORPUS: Readonly<Record<string, string>> = {
  mixte: repondre(MESURE),
  listeLache:
    "Intro.\n\n1. **Un** : a\n\n   suite du un\n\n   - x\n   - y\n\n2. **Deux** : b\n\n   ```js\n   let a = 1;\n\n   let b = 2;\n   ```\n\n3. Trois\n\nFin.\n",
  citation: "> Première ligne\n>\n> Deuxième paragraphe de la citation\n\n> Autre citation\n\nTexte.\n",
  tableau: "Avant\n\n| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\nAprès\n",
  setext: "Titre\n=====\n\nSous-titre\n----------\n\nTexte\nsur deux lignes\n\n---\n\nFin\n",
  liensRef:
    'Voir [la doc][d] et [l\'autre][o].\n\nUn paragraphe.\n\n[d]: https://exemple.test/doc\n[o]: https://exemple.test/autre "Titre"\n\nFin [d].\n',
  html: "<details>\n<summary>Titre</summary>\n\nContenu **gras**\n\n</details>\n\nAprès.\n",
  codeIndente: "Texte\n\n    code indenté\n    suite\n\n    encore\n\nFin\n",
  listeSerree: "- a\n- b\n  - b1\n  - b2\n- c\n\nTexte\n\n* x\n* y\n\n+ autre liste\n",
  fenceDansListe: "1. Étape\n\n   ```bash\n   echo ok\n   ```\n\n2. Suite\n\n   > note\n\n3. Fin\n",
  taches: "- [ ] à faire\n- [x] fait\n\n\n\nParagraphe après trois lignes vides.\n",
  // Réponses réalistes
  fenceSansLigneVide:
    "Voici le code :\n```py\nx = 1\n\ny = 2\n```\nPuis du texte juste après.\n\nEt la suite.\n",
  fencesEnchainees: "```sh\nls\n```\n```sh\npwd\n```\n\n~~~text\nbrut\n~~~\nFin\n",
  fenceLongue: "````md\n```py\ninterne\n```\n````\n\nSuite\n",
  fenceNonFermee: "Début\n\n```py\nx = 1\ny = 2\n",
  citationImbriquee: "> Citation\n>\n> - puce\n> - puce 2\n>\n> ```js\n> let a = 1;\n> ```\n\nAprès\n",
  listeImbriquee:
    "1. Premier\n   - a\n     - a1\n     - a2\n   - b\n2. Second\n\n   Paragraphe de l'élément.\n\n   | x | y |\n   | - | - |\n   | 1 | 2 |\n\n3. Troisième\n",
  titresEtHr: "# Un\n\ntexte\n\n## Deux\n\n***\n\n### Trois\n- puce directe\n",
  htmlDiv: '<div class="x">\n\nParagraphe **dans** un div.\n\n- liste\n\n</div>\n\nHors du div.\n',
  htmlCommentaire: "<!-- note -->\n\nTexte\n\n<br>\n\nSuite\n",
  htmlTable: "<table>\n<tr><td>a</td></tr>\n</table>\n\nAprès\n",
  htmlNonFerme: "<p>Un paragraphe html\n\nSuite en markdown\n\nEncore\n",
  definitionsEnTete: "[d]: https://exemple.test/d\n\nTexte avec [d] et [autre][d].\n\nFin\n",
  definitionDansListe: "- voir [x]\n\n[x]: https://exemple.test/x\n",
  sautsDeLigneWindows: "Titre\r\n=====\r\n\r\n- a\r\n- b\r\n\r\n```js\r\nlet a = 1;\r\n```\r\n\r\nFin\r\n",
  tabulations: "Texte\n\n\tcode avec tabulation\n\n- liste\n\t- sous-liste\n\nFin\n",
  blancsDeTete: "\n\n  \nPremier paragraphe\n\nSecond\n",
  entitesEtLiens:
    "Un &amp; deux &lt;b&gt; [lien](https://exemple.test/a?x=1&y=2) <https://exemple.test> et https://auto.test/page.\n\n![img](data:image/png;base64,AAAA)\n",
  mathEtEchappements: "Prix : 3 \\* 4 = 12, `code` et \\`pas code\\`.\n\n1986\\. Une année.\n",
  paragrapheLong: ("Une phrase assez longue pour le test. ".repeat(40) + "\n\n").repeat(3) + "Fin\n",
};
