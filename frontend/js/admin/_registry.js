// SPDX-License-Identifier: MIT
// ============================================================================
//  frontend/js/admin/_registry.js — ARBORESCENCE de la console d'administration
// ============================================================================
//  Source UNIQUE (refonte 2026-09-27) : la barre latérale, les titres, les liens profonds (#page),
//  les alias des anciens identifiants, les chargeurs de données de chaque page
//  (app.js › _loadAdminTab) et les blocs qu'elle enregistre en dérivent.
//
//  Principe : UNE FONCTIONNALITÉ = UN ÉCRAN (adresse + activation + règles +
//  prompt + test). Six entrées ; chacune se déplie en sous-pages. Les
//  identifiants de page sont UNIQUES dans toute la console : le lien profond
//  ne porte que l'identifiant (#compression), l'entrée se déduit.
//
//  Champs d'une page :
//    id, label   identifiant (lien profond, v-if des gabarits) et titre
//    wide        colonne large (tableaux, graphiques) ; sinon formulaire
//    loaders     [nom, ...arguments] appelés sur le module admin à l'entrée —
//                arguments EXPLICITES : loadDailyReport(date) et
//                loadUsers(notify) ont une signature, un argument passé au
//                hasard produirait « ?date=main » ou un toast parasite
//    stores      blocs enregistrés par la barre de la page (cf. ADMIN_STORES)
//    paths       préfixes des chemins de config.json réglés sur la page — sert
//                à nommer la page d'un réglage (« Redémarrage nécessaire :
//                Inférence, Entretien »)
//  Champs d'une entrée : id, label, icon (Phosphor), role ('staff' = admin et
//  modérateurs, 'admin' = administrateurs seulement), pages.
// ============================================================================
(function () {
    'use strict';

    const CONFIG = ['loadAdminConfig', 'main'];

    const ENTRIES = [
        // Page d'arrivée (lot 6) : ce qui demande l'attention, l'état des
        // services, les dernières 24 h. Lisible par les modérateurs.
        { id: 'overview', label: 'Vue d’ensemble', icon: 'ph-squares-four', role: 'staff', pages: [
            { id: 'overview', label: 'Vue d’ensemble', wide: true, loaders: [['loadOverview']] },
        ] },
        { id: 'supervision', label: 'Supervision', icon: 'ph-chart-line-up', role: 'staff', pages: [
            { id: 'dashboard',  label: 'Métriques',        wide: true, loaders: [['loadAdminStats']], paths: ['metrics.'] },
            { id: 'report',     label: 'Rapport',          wide: true, loaders: [['loadDailyReport']] },
            { id: 'runs',       label: 'Exécutions',       wide: true, loaders: [['loadAdminRuns']] },
            { id: 'tool-calls', label: 'Appels d’outils',  wide: true, loaders: [['loadObservability']] },
            { id: 'audit',      label: 'Audit',            wide: true, loaders: [['loadObservability']] },
            { id: 'logs',       label: 'Journaux',         wide: true, loaders: [['loadRecentLogs']] },
        ] },
        { id: 'models', label: 'Modèles & services', icon: 'ph-cpu', role: 'admin', pages: [
            { id: 'inference',   label: 'Inférence',          wide: true, stores: ['config', 'scheduling'],
              loaders: [CONFIG, ['loadAdminLlmConnectors'], ['loadLlmScheduling']], paths: ['llama.'] },
            { id: 'compression', label: 'Compression',        stores: ['compression'],
              loaders: [['loadCompressionCfg']] },
            { id: 'rag',         label: 'RAG',                stores: ['config'], loaders: [CONFIG] },
            { id: 'vision',      label: 'Vision & machines',  stores: ['config'], loaders: [CONFIG, ['loadAxSites']] },
            { id: 'voice',       label: 'Voix',               stores: ['config'], loaders: [CONFIG] },
            { id: 'images',      label: 'Images',             stores: ['config'],
              loaders: [CONFIG, ['loadImageAdmin'], ['loadGroups']] },
            { id: 'mcp',         label: 'Outils MCP',         stores: ['config'], loaders: [CONFIG, ['loadMcpManifest'], ['loadOauthClients']], paths: ['mcp.'] },
            { id: 'prompts',     label: 'Prompts',            wide: true, loaders: [['loadSystemPrompts']] },
        ] },
        { id: 'access', label: 'Utilisateurs & accès', icon: 'ph-users', role: 'admin', pages: [
            { id: 'accounts', label: 'Comptes',                  wide: true, loaders: [['loadUsers'], ['loadGroups']] },
            { id: 'groups',   label: 'Groupes',                  wide: true, loaders: [['loadGroups'], ['loadUsers']] },
            { id: 'rights',   label: 'Droits par défaut',        stores: ['config', 'allowed'],
              loaders: [CONFIG, ['loadAdminLlmConnectors']] },
            { id: 'sessions', label: 'Mots de passe & sessions', stores: ['config'], loaders: [CONFIG],
              paths: ['security.session.', 'security.password_policy.'] },
        ] },
        { id: 'sandbox', label: 'Sandbox', icon: 'ph-cube', role: 'admin', pages: [
            { id: 'sandbox-limits',     label: 'Limites & politique', stores: ['exec'], loaders: [['loadExecConfig']] },
            { id: 'sandbox-network',    label: 'Réseau',              stores: ['exec'], loaders: [['loadExecConfig']] },
            { id: 'sandbox-toolhosts',  label: 'Hôtes d’outils',      loaders: [['loadExecConfig'], ['loadToolhosts']] },
            { id: 'sandbox-containers', label: 'Containers',          wide: true, loaders: [['loadExecConfig']] },
        ] },
        { id: 'system', label: 'Système', icon: 'ph-hard-drives', role: 'admin', pages: [
            { id: 'instance', label: 'Instance',    stores: ['config'], loaders: [CONFIG], paths: ['app_info.', 'app.'] },
            { id: 'appearance', label: 'Apparence', wide: true, loaders: [['loadAdminSkins']], paths: ['skins.'] },
            { id: 'https',    label: 'Accès HTTPS', loaders: [CONFIG] },
            { id: 'data',     label: 'Données',     loaders: [['loadDatabase'], ['loadRemoteBackup']], paths: ['database.', 'backup.'] },
            { id: 'upkeep',   label: 'Entretien',   stores: ['config'], loaders: [CONFIG, ['loadDailyReport']], paths: ['maintenance.'] },
        ] },
    ];

    // Anciens identifiants → page d'accueil de ce qu'ils contenaient. Un signet
    // « admin.html#connections » ou un lien de notification (#report) ne doit
    // pas atterrir sur une page vide sans explication.
    const ALIASES = Object.freeze({
        observability: 'tool-calls',
        general: 'instance',
        connections: 'inference',
        engines: 'inference',
        llm: 'inference',
        security: 'sessions',
        users: 'accounts',
        exec: 'sandbox-limits',
        database: 'data',
        maintenance: 'upkeep',
        config: 'instance',
        ax: 'vision',
    });

    const PAGES = {};
    for (const e of ENTRIES) {
        for (const p of e.pages) {
            PAGES[p.id] = Object.freeze(Object.assign({ wide: false, stores: [], loaders: [], paths: [] }, p, {
                entry: e.id, entryLabel: e.label, role: e.role,
            }));
        }
        Object.freeze(e.pages);
        Object.freeze(e);
    }

    // Identifiant (actuel ou historique) → identifiant de page, ou '' s'il ne
    // désigne rien.
    function resolve(id) {
        const raw = String(id || '').replace(/^#/, '');
        if (PAGES[raw]) return raw;
        const alias = ALIASES[raw];
        return (alias && PAGES[alias]) ? alias : '';
    }

    // Chemin de config.json → page qui le règle (préfixe le plus long), ou ''.
    function pageForPath(path) {
        let best = '', len = 0;
        for (const id in PAGES) {
            for (const pre of PAGES[id].paths) {
                if (String(path).startsWith(pre) && pre.length > len) { best = id; len = pre.length; }
            }
        }
        return best;
    }

    window.ELPIS_ADMIN_NAV = Object.freeze({
        entries: Object.freeze(ENTRIES),
        pages: Object.freeze(PAGES),
        aliases: ALIASES,
        resolve,
        pageForPath,
    });
})();
