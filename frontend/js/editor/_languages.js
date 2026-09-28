// SPDX-License-Identifier: MIT
// ============================================================
//  static/js/editor/_languages.js -- Extracted from app-editor.js
//
//  Pure data + language-detection helpers.
//
//  Responsibilities
//  ----------------
//  • LANG_MAP -- extension → { lang, icon, color } (web, data,
//    systems, shell, devops, docs, plain text).
//  • FILENAME_LANG_MAP -- special filenames without extension
//    (Dockerfile, Makefile, .env, .gitignore, .htaccess, nginx.conf).
//  • _getLang(path)     -- returns the Monaco language ID for a path,
//                         checking filename first, then extension.
//  • _registerRobotFramework() -- registers a Monarch tokenizer for
//                                .robot / .resource files. Idempotent:
//                                safe to call multiple times.
//
//  Contract
//  --------
//  Loaded BEFORE app-editor.js. Exposes on window:
//      window.setupEditorLanguages()
//
//  Zero dependencies on the editor's reactive state -- this is pure
//  data and side-effect-free helpers, except _registerRobotFramework
//  which registers itself with the global `monaco` object if present.
// ============================================================

(function() {
    'use strict';

    function setupEditorLanguages() {
        // -- Extended language map -----------------------------------
        // Covers far more extensions than utils.js and maps them to
        // Monaco language IDs. The `icon` / `color` fields mirror
        // utils.js conventions so getFileMeta() still works for the
        // file tree; this map is used only for Monaco language selection.
        const LANG_MAP = {
            // -- Web -------------------------------------------------
            js:         { lang: 'javascript', icon: 'ph-file-js',        color: 'text-yellow-400' },
            mjs:        { lang: 'javascript', icon: 'ph-file-js',        color: 'text-yellow-400' },
            cjs:        { lang: 'javascript', icon: 'ph-file-js',        color: 'text-yellow-400' },
            jsx:        { lang: 'javascript', icon: 'ph-file-js',        color: 'text-yellow-400' },
            ts:         { lang: 'typescript', icon: 'ph-file-ts',        color: 'text-blue-400'   },
            tsx:        { lang: 'typescript', icon: 'ph-file-ts',        color: 'text-blue-400'   },
            html:       { lang: 'html',       icon: 'ph-browsers',       color: 'text-orange-500' },
            htm:        { lang: 'html',       icon: 'ph-browsers',       color: 'text-orange-500' },
            vue:        { lang: 'html',       icon: 'ph-browsers',       color: 'text-emerald-500'},
            css:        { lang: 'css',        icon: 'ph-paint-brush',    color: 'text-sky-400'    },
            scss:       { lang: 'scss',       icon: 'ph-paint-brush',    color: 'text-pink-400'   },
            sass:       { lang: 'scss',       icon: 'ph-paint-brush',    color: 'text-pink-400'   },
            less:       { lang: 'less',       icon: 'ph-paint-brush',    color: 'text-indigo-400' },
            // -- Data ------------------------------------------------
            json:       { lang: 'json',       icon: 'ph-brackets-curly', color: 'text-lime-500'   },
            jsonc:      { lang: 'json',       icon: 'ph-brackets-curly', color: 'text-lime-500'   },
            yaml:       { lang: 'yaml',       icon: 'ph-file-text',      color: 'text-yellow-500' },
            yml:        { lang: 'yaml',       icon: 'ph-file-text',      color: 'text-yellow-500' },
            toml:       { lang: 'ini',        icon: 'ph-file-text',      color: 'text-orange-400' },
            ini:        { lang: 'ini',        icon: 'ph-file-text',      color: 'text-slate-400'  },
            env:        { lang: 'ini',        icon: 'ph-file-text',      color: 'text-slate-400'  },
            xml:        { lang: 'xml',        icon: 'ph-code',           color: 'text-orange-400' },
            svg:        { lang: 'xml',        icon: 'ph-image',          color: 'text-purple-400' },
            sql:        { lang: 'sql',        icon: 'ph-database',       color: 'text-blue-400'   },
            graphql:    { lang: 'graphql',    icon: 'ph-graph',          color: 'text-pink-500'   },
            gql:        { lang: 'graphql',    icon: 'ph-graph',          color: 'text-pink-500'   },
            // -- Systems / Backend ------------------------------------
            py:         { lang: 'python',     icon: 'ph-file-py',        color: 'text-blue-500'   },
            pyw:        { lang: 'python',     icon: 'ph-file-py',        color: 'text-blue-500'   },
            go:         { lang: 'go',         icon: 'ph-file-code',      color: 'text-cyan-500'   },
            rs:         { lang: 'rust',       icon: 'ph-file-code',      color: 'text-orange-500' },
            java:       { lang: 'java',       icon: 'ph-file-code',      color: 'text-red-500'    },
            kt:         { lang: 'kotlin',     icon: 'ph-file-code',      color: 'text-purple-500' },
            kts:        { lang: 'kotlin',     icon: 'ph-file-code',      color: 'text-purple-500' },
            c:          { lang: 'c',          icon: 'ph-file-code',      color: 'text-blue-600'   },
            h:          { lang: 'c',          icon: 'ph-file-code',      color: 'text-blue-400'   },
            cpp:        { lang: 'cpp',        icon: 'ph-file-code',      color: 'text-blue-600'   },
            cc:         { lang: 'cpp',        icon: 'ph-file-code',      color: 'text-blue-600'   },
            cxx:        { lang: 'cpp',        icon: 'ph-file-code',      color: 'text-blue-600'   },
            hpp:        { lang: 'cpp',        icon: 'ph-file-code',      color: 'text-blue-400'   },
            cs:         { lang: 'csharp',     icon: 'ph-file-code',      color: 'text-green-600'  },
            rb:         { lang: 'ruby',       icon: 'ph-file-code',      color: 'text-red-500'    },
            php:        { lang: 'php',        icon: 'ph-file-code',      color: 'text-indigo-500' },
            swift:      { lang: 'swift',      icon: 'ph-file-code',      color: 'text-orange-500' },
            r:          { lang: 'r',          icon: 'ph-file-code',      color: 'text-blue-400'   },
            // -- Scripts / Shell --------------------------------------
            sh:         { lang: 'shell',      icon: 'ph-terminal-window',color: 'text-green-500'  },
            bash:       { lang: 'shell',      icon: 'ph-terminal-window',color: 'text-green-500'  },
            zsh:        { lang: 'shell',      icon: 'ph-terminal-window',color: 'text-green-400'  },
            fish:       { lang: 'shell',      icon: 'ph-terminal-window',color: 'text-green-400'  },
            ps1:        { lang: 'powershell', icon: 'ph-terminal-window',color: 'text-blue-500'   },
            psm1:       { lang: 'powershell', icon: 'ph-terminal-window',color: 'text-blue-500'   },
            // -- DevOps / Config --------------------------------------
            dockerfile: { lang: 'dockerfile', icon: 'ph-cube',           color: 'text-sky-500'    },
            nginx:      { lang: 'nginx',      icon: 'ph-file-text',      color: 'text-emerald-500'},
            proto:      { lang: 'proto3',     icon: 'ph-file-code',      color: 'text-slate-400'  },
            tf:         { lang: 'hcl',        icon: 'ph-file-code',      color: 'text-purple-400' },
            hcl:        { lang: 'hcl',        icon: 'ph-file-code',      color: 'text-purple-400' },
            // -- Docs -------------------------------------------------
            md:         { lang: 'markdown',   icon: 'ph-info',           color: 'text-slate-400'  },
            mdx:        { lang: 'markdown',   icon: 'ph-info',           color: 'text-slate-400'  },
            rst:        { lang: 'restructuredtext', icon: 'ph-info',     color: 'text-slate-400'  },
            // -- Robot Framework --------------------------------------
            robot:      { lang: 'robotframework', icon: 'ph-robot',      color: 'text-cyan-600'   },
            resource:   { lang: 'robotframework', icon: 'ph-robot',      color: 'text-cyan-500'   },
            // -- Plain text -------------------------------------------
            txt:        { lang: 'plaintext',  icon: 'ph-file-text',      color: 'text-gray-500'   },
            log:        { lang: 'plaintext',  icon: 'ph-file-text',      color: 'text-gray-400'   },
            csv:        { lang: 'plaintext',  icon: 'ph-table',          color: 'text-green-500'  },
        };

        // -- Fallback: special filenames without extension -----------
        const FILENAME_LANG_MAP = {
            'dockerfile': 'dockerfile',
            'makefile':   'makefile',
            'gemfile':    'ruby',
            'rakefile':   'ruby',
            'procfile':   'shell',
            'vagrantfile':'ruby',
            '.env':       'ini',
            '.gitignore': 'ini',
            '.htaccess':  'apache',
            'nginx.conf': 'nginx',
        };

        /** Get Monaco language ID for a file path (case-insensitive). */
        function _getLang(filePath) {
            const name = (filePath || '').split('/').pop();
            const lower = name.toLowerCase();
            // Check exact filename first
            if (FILENAME_LANG_MAP[lower]) return FILENAME_LANG_MAP[lower];
            const ext = lower.split('.').pop();
            return (LANG_MAP[ext] || {}).lang || 'plaintext';
        }

        // ==============================================================
        //  ROBOT FRAMEWORK MONARCH TOKENIZER
        // ==============================================================

        function _registerRobotFramework() {
            if (typeof monaco === 'undefined') return;
            if (monaco.languages.getLanguages().some(l => l.id === 'robotframework')) return;

            monaco.languages.register({ id: 'robotframework', extensions: ['.robot', '.resource'], aliases: ['Robot Framework', 'robot'] });

            monaco.languages.setMonarchTokensProvider('robotframework', {
                defaultToken: 'text',
                tokenPostfix: '.robot',

                keywords: [
                    'IF', 'ELSE IF', 'ELSE', 'END', 'FOR', 'IN', 'IN RANGE', 'IN ENUMERATE',
                    'IN ZIP', 'WHILE', 'BREAK', 'CONTINUE', 'TRY', 'EXCEPT', 'FINALLY',
                    'RETURN', 'SKIP',
                ],

                settings_keywords: [
                    'Library', 'Resource', 'Variables', 'Documentation', 'Metadata',
                    'Suite Setup', 'Suite Teardown', 'Test Setup', 'Test Teardown',
                    'Test Template', 'Test Timeout', 'Task Setup', 'Task Teardown',
                    'Task Template', 'Task Timeout', 'Force Tags', 'Default Tags',
                ],

                tokenizer: {
                    root: [
                        // Section headers  *** Settings ***  etc.
                        [/^\*{3,}\s*(Settings?|Variables?|Test Cases?|Tasks?|Keywords?|Comments?)\s*\*{0,3}/i,
                            'keyword.section'],

                        // Line comment
                        [/#.*$/, 'comment'],

                        // [Annotations]  like [Documentation], [Arguments], [Tags] ...
                        [/\[[A-Za-z ]+\]/, 'type.annotation'],

                        // Variable patterns  ${var}  @{list}  &{dict}  %{env}
                        [/[\$@&%]\{[^}]*\}/, 'variable'],
                        // Variable assignment  ${x}=
                        [/[\$@&%]\{[^}]*\}\s*=/, 'variable.definition'],

                        // Strings
                        [/"(?:[^"\\]|\\.)*"/, 'string'],
                        [/'(?:[^'\\]|\\.)*'/, 'string'],

                        // Named argument  name=value
                        [/\b([A-Za-z_][A-Za-z0-9_]*)\s*=/, 'variable.parameter'],

                        // Numbers
                        [/\b-?\d+(?:\.\d+)?\b/, 'number'],

                        // Settings section keywords (first word on a line)
                        [/^(Library|Resource|Variables|Documentation|Metadata|Suite Setup|Suite Teardown|Test Setup|Test Teardown|Test Template|Test Timeout|Task Setup|Task Teardown|Task Template|Task Timeout|Force Tags|Default Tags|Tags)\b/i, 'keyword'],

                        // Control flow keywords
                        [/\b(IF|ELSE IF|ELSE|END|FOR|IN(?:\s+RANGE|\s+ENUMERATE|\s+ZIP)?|WHILE|BREAK|CONTINUE|TRY|EXCEPT|FINALLY|RETURN|SKIP)\b/, 'keyword.control'],

                        // Separator (two or more spaces / tab)
                        [/(?:  +|\t)/, 'white'],
                    ],
                },
            });

            monaco.languages.setLanguageConfiguration('robotframework', {
                comments:   { lineComment: '#' },
                brackets:   [['${', '}'], ['@{', '}'], ['&{', '}'], ['(', ')'], ['[', ']']],
                wordPattern: /([^\s:,\(])+/,
            });
        }

        // -- Public surface ------------------------------------------
        return {
            LANG_MAP,
            FILENAME_LANG_MAP,
            _getLang,
            _registerRobotFramework,
        };
    }

    window.setupEditorLanguages = setupEditorLanguages;
})();
