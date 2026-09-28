// SPDX-License-Identifier: MIT
// Fixtures de réponses LLM pour le mock de streaming NDJSON.
// Chaque builder retourne { thinking: [tokens], content: [tokens] } —
// tokens de 2-5 caractères (≈ 1 token BPE) pour reproduire la cadence
// réelle d'un llama-server sur le réseau local.

// Découpe un texte en pseudo-tokens de 2 à 5 chars (déterministe :
// la taille suit un cycle fixe, pas de Math.random → runs comparables).
export function tokenize(text) {
    const sizes = [3, 4, 2, 5, 3, 4, 3, 2, 4, 5];
    const out = [];
    let i = 0, k = 0;
    while (i < text.length) {
        const n = sizes[k % sizes.length];
        out.push(text.slice(i, i + n));
        i += n; k++;
    }
    return out;
}

function pythonBlock(lines) {
    const body = [];
    body.push('```python');
    body.push('# Pipeline de traitement des mesures — exemple généré');
    body.push('import json');
    body.push('import statistics');
    body.push('from dataclasses import dataclass, field');
    body.push('');
    for (let i = 0; body.length < lines - 1; i++) {
        const mod = i % 9;
        if (mod === 0) body.push(`@dataclass`);
        else if (mod === 1) body.push(`class Sample${i}:`);
        else if (mod === 2) body.push(`    name: str = "sample_${i}"`);
        else if (mod === 3) body.push(`    values: list = field(default_factory=list)`);
        else if (mod === 4) body.push(`    def p95(self):`);
        else if (mod === 5) body.push(`        s = sorted(self.values)`);
        else if (mod === 6) body.push(`        return s[int(len(s) * 0.95)] if s else 0`);
        else if (mod === 7) body.push(`    def add(self, v): self.values.append(float(v))  # ${i}`);
        else body.push('');
    }
    body.push('```');
    return body.join('\n');
}

const INTRO = `Voici une analyse détaillée du pipeline de mesure, avec un exemple complet en Python.

Le principe : chaque scénario collecte des métriques de rendu (long tasks, FPS, layout) puis les agrège en percentiles. **Les points importants** sont la stabilité inter-runs et la comparabilité baseline/candidat.

`;

const OUTRO = `

En résumé, l'agrégation par médiane sur trois runs élimine l'essentiel du bruit de la VM. Les percentiles p95 restent l'indicateur le plus sensible aux régressions de rendu.

- la médiane lisse le bruit ponctuel
- le p95 capture les pics de jank
- le max documente le pire cas

Ce découpage permet de comparer deux versions du frontend à environnement constant, sans dépendre du GPU.`;

// Réponse « gros bloc de code » : ~2 paragraphes + bloc python de N lignes + conclusion.
export function buildCodeReply(codeLines = 200) {
    const text = INTRO + pythonBlock(codeLines) + OUTRO;
    return {
        thinking: tokenize('Je vais structurer la réponse : intro, exemple complet en Python avec dataclasses, puis une synthèse des points de comparaison entre les runs.'),
        content: tokenize(text),
        full: text,
    };
}

// Réponse courte (smoke / queue) — quelques phrases.
export function buildShortReply() {
    const text = 'Réponse courte de contrôle : le harnais fonctionne, la mesure peut commencer.';
    return { thinking: [], content: tokenize(text), full: text };
}

// Réponse contenant des vecteurs XSS classiques + du markdown mixte
// (chart, tableau) : vérifie que le rendu FINAL passe bien par le sanitize
// (DOMPurify) — les vecteurs doivent être absents du DOM, le markdown OK.
export function buildXssReply() {
    const text = [
        "Voici un récapitulatif **avec** des éléments à assainir.",
        "",
        '<img src=x onerror="window.__XSS_FIRED=1">',
        '<script>window.__XSS_FIRED=1<\/script>',
        '<a href="javascript:window.__XSS_FIRED=1">lien</a>',
        "",
        "| Col A | Col B |",
        "|-------|-------|",
        "| 1     | 2     |",
        "",
        "```python",
        "def safe(): return 'ok'",
        "```",
    ].join("\n");
    return { thinking: [], content: tokenize(text), full: text };
}

// Réponse XL : texte long sans code (~30 Ko) pour stresser le re-layout
// du text node en fin de stream (messages très longs).
export function buildXlReply() {
    let text = INTRO;
    for (let i = 0; i < 60; i++) {
        text += `Paragraphe ${i + 1} — la croissance du message déplace le coût vers le remplacement du nœud texte et le layout du conteneur, ce qui est exactement le comportement que ce scénario cherche à borner. `;
        if (i % 7 === 6) text += '\n\n';
    }
    text += OUTRO;
    return { thinking: [], content: tokenize(text), full: text };
}
