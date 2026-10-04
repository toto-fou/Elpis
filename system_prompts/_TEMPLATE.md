# _TEMPLATE — comment écrire les prompts système d'Elpis

> Fichier de référence (lecture seule via l'API admin). Jamais injecté dans un chat : il documente
> l'architecture et la méthode. L'assemblage est en deux couches.

---

## Architecture en deux couches

**1. Socle — `CHATBOT_SYSTEM.md` (TOUJOURS présent).**
Identité, méthode, principes, style. Il doit être vrai que des outils soient actifs OU NON.
**Règle d'or : le socle ne suppose JAMAIS de sandbox, d'outils « dont tu disposes », ni d'action.**
Une session peut être purement conversationnelle (chat-only) : dans ce cas le socle est le seul
prompt. Toute affirmation « tu travailles dans un sandbox / tu édites des fichiers » y serait fausse
et trompeuse.

**2. Fragments de capacité — `FRAGMENT_*.md` (CONDITIONNELS).**
Injectés automatiquement, et seulement quand la capacité correspondante est active, par
`build_capability_block()` (`llm_core/_system_prompts.py`), à partir des catégories d'outils du tour
(`llm_core/_mcp_categories.categorize`). Deux étages :

- **Action** — cadrage sandbox / agentique. `FRAGMENT_TOOLS` dès qu'une catégorie d'action est présente,
  + un fragment spécialisé selon la catégorie. Pilote aussi `<runtime_context>` (fs/shell/git).
- **Contenu** — capacités « douces » (graphiques, mémoire, RAG). Injectées INDÉPENDAMMENT (même sans
  catégorie d'action) → elles NE tirent NI `FRAGMENT_TOOLS` NI `<runtime_context>`, seulement leur guide.

| Fichier | Étage | Injecté quand | Rôle |
|---|---|---|---|
| `FRAGMENT_TOOLS.md` | action | ≥1 catégorie d'**action** (`fs/shell/git/desktop/browser`) | « tu peux agir », sandbox, posture réversible/destructeur |
| `FRAGMENT_CODE.md` | action | `fs` / `shell` / `git` | discipline d'ingénierie logicielle |
| `FRAGMENT_AUTOMATION.md` | action | `desktop` | automatisation du bureau |
| `FRAGMENT_WEB.md` | action | `browser` | navigation web |
| `FRAGMENT_CHART.md` | contenu | `chart` (un outil par type : `chart_bar`, `chart_heatmap`, `chart_gantt`… `chart_table`) | graphiques & tableaux rendus par l'UI (ECharts) |
| `FRAGMENT_MEMORY.md` | contenu | `memory` (`memory`/`session_search`) | mémoire long-terme : quoi / où sauvegarder |
| `FRAGMENT_RAG.md` | contenu | outils `rag_*` (builtins → catégorie `rag` synthétisée) | base de connaissances documentaire |

Les blocs `<runtime_context>` (sandbox), `# Mémoire (instantané)`, l'index de skills et `AX memory`
sont eux aussi conditionnels et injectés par le backend — ne les recopie pas dans un prompt.

---

## Squelette d'un prompt (socle ou fragment)
```
# Identité / Titre
{Qui / quoi, concret. Pour le socle : agnostique aux outils.}

# Méthode / Principes
{3–5 règles POSITIVES (« fais X »), chacune avec son pourquoi implicite.}

# Style
{Langue, ton, structure, longueur selon la complexité.}

# Exemples
{1–3 mini-exemples <example>…</example>, variés et courts.}
```

## Rappels de méthode (guides Anthropic & OpenAI, adaptés à un petit modèle local)
- **Socle agnostique** : aucune hypothèse de capacité dans le toujours-présent (cf. règle d'or).
- **Ancrer dans le réel** : décris le produit et les vraies capacités, pas des généralités.
- **Cadrage positif** : dis quoi FAIRE ; si une interdiction est nécessaire, explique le pourquoi.
- **Ne pas dupliquer** : les paramètres/capacités des outils sont dans leurs descriptions et dans
  `<runtime_context>` — n'y reviens pas.
- **Pas de sur-spécification ni de contradiction** : plus court = mieux suivi, surtout sur petit modèle.
- **Pas de chain-of-thought imposé** : donne l'objectif et le critère de réussite, pas un
  « réfléchis étape par étape » verbeux.

## Conventions de la passe « riche » (2026-07)
- **Exemples travaillés** : chaque fragment porte 1–3 blocs `<example>` COMPORTEMENTAUX — scénario
  en prose, paramètres cités inline (`action="replace"`, `target="[a1f4]"`) — JAMAIS le markup
  wire d'un appel (`<tool_call>`, JSON d'appel) : il fuiterait dans les bulles.
- **Protocole d'erreur unifié** : les outils échouent avec `error` (code stable) + `message` (FR)
  + `fix` (geste correctif) ; les fragments enseignent « applique le fix, jamais de relance
  identique, 2 échecs même cible → changer de stratégie » et une condition d'arrêt explicite.
- **Budgets bornés par test** : `tests/llm_core/test_capability_fragments.py` verrouille un plafond
  de caractères par fichier (dérive interdite), l'absence de markup wire et l'absence d'émoji.
