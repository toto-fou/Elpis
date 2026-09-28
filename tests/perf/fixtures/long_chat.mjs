// SPDX-License-Identifier: MIT
// Fixture : chat persisté de N messages pour activer la virtualisation
// (VS_THRESHOLD = 30 dans _virtual_scroll.js) et mesurer l'ouverture
// d'un chat long. Alternance user/assistant ; 1 réponse sur 3 contient
// un bloc de code de ~30 lignes (coût marked + hljs au premier rendu).

function smallCodeBlock(seed) {
    const l = ['```js', `// extrait ${seed}`];
    for (let i = 0; i < 26; i++) l.push(`const v${seed}_${i} = compute(${i}) + offset; // ligne ${i}`);
    l.push('```');
    return l.join('\n');
}

export function buildLongChat(id, count = 40) {
    const messages = [];
    for (let i = 0; i < count; i++) {
        if (i % 2 === 0) {
            messages.push({ role: 'user', content: `Question ${i / 2 + 1} : peux-tu détailler le point ${i} du document, avec un exemple si possible ?` });
        } else {
            let content = `Réponse ${Math.ceil(i / 2)} — voici le détail demandé. ` +
                `Le point ${i} concerne la stabilité du rendu et la gestion mémoire du frontend. `.repeat(4);
            if (i % 3 === 1) content += '\n\n' + smallCodeBlock(i) + '\n\nCe code illustre le mécanisme.';
            messages.push({
                role: 'assistant', content,
                model: 'm1', duration_s: 3.2, token_count: 180,
            });
        }
    }
    return { id, title: `Chat long ${count} messages`, messages };
}
