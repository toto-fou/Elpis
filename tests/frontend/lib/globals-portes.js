// SPDX-License-Identifier: MIT
// tests/frontend/lib/globals-portes.js — modules portés en TypeScript, publiés dans le bac vm des tests sous les noms de globals d'avant la migration (chargeables par Node, sans Vue).
'use strict';

const src = (rel) => require('../../../frontend/src/' + rel);

/** Fonctions pures (ex-utils.js). */
function globalsUtilitaires() {
    const utils = src('utils/utils-purs.ts');
    return {
        escapeHtml: utils.escapeHtml,
        elpisEscape: utils.escapeHtml,
        elpisParsePath: utils.parsePath,
        elpisLooksLikePath: utils.looksLikePath,
        fmtElapsed: utils.fmtElapsed,
        elpisFmtElapsed: utils.fmtElapsed,
        elpisFmtElapsedMs: utils.fmtElapsedMs,
        fmtTokenCount: utils.fmtTokenCount,
        elpisFmtTokens: utils.fmtTokenCount,
        tokenBreakdown: utils.tokenBreakdown,
        elpisTokenBreakdown: utils.tokenBreakdown,
        elpisFuzzyMatch: utils.fuzzyMatch,
        elpisCanonPath: utils.canonPath,
        ELPIS_BUILTIN_AGENTS: utils.BUILTIN_AGENTS,
        ELPIS_RESERVED_AGENT_NAMES: utils.RESERVED_AGENT_NAMES,
    };
}

/** Tout ce que les tests du chat lisent dans le bac. */
function globalsChat() {
    const ansi = src('utils/ansi.ts');
    const images = src('features/images/formats.ts');
    return {
        setupChatHelpersJson: src('utils/helpers-json.ts').setupChatHelpersJson,
        elpisLlamaUrl: { suivreHotePort: src('utils/llama-url.ts').suivreHotePort },
        ...globalsUtilitaires(),
        elpisAnsi: { ansiToHtml: ansi.ansiToHtml, escapeHtml: ansi.escapeHtml },
        elpisLineDiff: { ...src('utils/line-diff.ts') },
        elpisMinimalEdit: { ...src('utils/minimal-edit.ts') },
        elpisOffice: { ...src('utils/office-model.ts') },
        elpisTemplates: src('features/chat/composeur/templates.ts').elpisTemplates,
        copyImageFields: images.copyImageFields,
        parseImageCommand: images.parseImageCommand,
        imageVariantRequest: images.imageVariantRequest,
        imageInitialProgress: images.imageInitialProgress,
        ...src('modeles/scenario-model.ts'),
        ...src('modeles/automation-model.ts'),
    };
}

/** Passe d'enrichissement des corps Markdown, sous la forme de l'ancien objet `ElpisEnrichissement`. */
function apiEnrichissement() {
    const e = src('features/chat/rendu/enrichissement.ts');
    return {
        ATTRIBUT: e.ATTRIBUT_COMPOSANT,
        configurer: e.configurerEnrichissement,
        enrichir: e.enrichirBlocs,
        balayer: e.balayerGraphiques,
        vider: e.viderGraphiques,
        clic: e.clicMarkdown,
        exporter: src('features/chat/export.ts').exporterConversation,
    };
}

module.exports = { globalsUtilitaires, globalsChat, apiEnrichissement };
