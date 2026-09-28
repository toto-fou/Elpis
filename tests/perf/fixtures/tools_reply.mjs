// SPDX-License-Identifier: MIT
// Fixture AGENTIC : phases d'un tour avec R rounds d'outils, conformes aux
// handlers du front (app-chat.js) :
//   tool_thinking {text}      — narration pré-outil (buffer preContent, 40 ms)
//   tool_call    {name, args} — pousse un step dans toolSteps (+ patch Vue)
//   tool_result  {name, result} — finalise le step (parse JSON pour _isErrorResult)
// puis réponse finale streamée en content_token + kv_cache + final.
//
// DÉTERMINISTE (pas de Math.random) : les tailles de résultats suivent un
// cycle fixe par index de round → runs comparables entre eux.
import { tokenize } from './big_code_reply.mjs';

// Résultat d'outil de 2 à 8 Ko selon le round (cycle fixe), JSON valide —
// le front le parse pour la détection d'erreur, autant payer ce coût réel.
function toolResultJson(round) {
    const sizes = [2000, 4500, 8000, 3000, 6500, 2500, 7500, 5000];
    const size = sizes[round % sizes.length];
    const line = `ligne ${round} — contenu de fichier simulé pour le harnais de perf. `;
    let body = '';
    while (body.length < size) body += line;
    return JSON.stringify({ ok: true, path: `src/module_${round}.py`, content: body.slice(0, size) });
}

const TOOL_NAMES = ['read_file', 'grep_files', 'list_dir', 'shell_exec'];

// Phases consommables par streamChat (perf-server) : kinds event|tokens|wait.
export function buildToolsPhases(rounds = 30) {
    const phases = [];
    for (let r = 0; r < rounds; r++) {
        const name = TOOL_NAMES[r % TOOL_NAMES.length];
        // Narration courte avant l'appel (préContent → flush 40 ms).
        phases.push({
            kind: 'tokens', type: 'tool_thinking',
            toks: tokenize(`Je consulte ${name} pour l'étape ${r + 1}. `),
        });
        phases.push({ kind: 'event', ev: { type: 'tool_call', name, args: { path: `src/module_${r}.py`, query: `motif_${r}` } } });
        // Petite latence d'exécution d'outil (I/O réelle ≈ 30-150 ms) — sans
        // elle, les tool_result arrivent dos à dos et le front coalesce des
        // patchs qui, en prod, arrivent espacés.
        phases.push({ kind: 'wait', ms: 40 });
        phases.push({ kind: 'event', ev: { type: 'tool_result', name, result: toolResultJson(r) } });
    }
    return phases;
}

// Réponse finale APRÈS les rounds (content classique, streamé).
export function buildToolsFinal(rounds = 30) {
    const text =
        `Synthèse après ${rounds} appels d'outils :\n\n` +
        Array.from({ length: 12 }, (_, i) =>
            `- Étape ${i + 1} : le module analysé expose une fonction principale et ` +
            `deux points d'attention (gestion d'erreur, taille de buffer).`).join('\n') +
        '\n\nConclusion : le pipeline est cohérent, les résultats des outils convergent.';
    return { content: tokenize(text), full: text };
}
