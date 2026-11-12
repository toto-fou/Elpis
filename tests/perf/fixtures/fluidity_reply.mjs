// SPDX-License-Identifier: MIT
/** tests/perf/fixtures/fluidity_reply.mjs — réponse de mesure de la fluidité du flux : Markdown typique d'un LLM, un repère unique (`zq001`, …) tous les ~120 caractères pour dater l'arrivée et l'affichage du même texte */

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

/** Texte de la réponse et nombre de repères. */
export function reponseMixte() {
  let n = 0;
  const texte = GABARIT.replace(/\{m\}/g, () => "zq" + String(++n).padStart(3, "0"));
  return { texte, reperes: n };
}

/** Réflexion de mesure (mode réflexion) : environ 1,2 Ko avant la réponse. */
export const REFLEXION = "Je dois décrire le pipeline. ".repeat(40);
