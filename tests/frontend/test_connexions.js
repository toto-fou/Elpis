// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_connexions.js
//  Lancer : node tests/frontend/test_connexions.js
//
//  Cible : frontend/js/settings/connexions.js — Paramètres › Connexions
//  (EXT.1) : blocs à copier par plateforme (MCP, VS Code, opencode,
//  OpenAPI, curl), jeton montré une seule fois puis espace réservé,
//  desktop jamais coché d'office, création et régénération.
// ============================================================
'use strict';

const { t, ta, fin, assert } = require('./lib/harnais.js');
const { charger, depuisBac } = require('./lib/charger.js');

const C = charger(['settings/connexions.js']);

function reponse(obj, ok = true) {
    return { ok, status: ok ? 200 : 422, json: async () => obj };
}

function monter(routes) {
    const vus = [];
    const D = C.fabrique('setupConnexions', [null, {
        fetchAuth: async (u, o) => { vus.push([u, (o && o.method) || 'GET', o && o.body]); return routes(u, o); },
        showToast: () => {},
    }]);
    return { D, vus };
}

const POLITIQUE = { tools_enabled: true, max_days: 90, max_per_user: 20,
                    families: [{ name: 'fs', label: 'Fichiers' }, { name: 'git', label: 'Git' },
                               { name: 'desktop', label: 'Bureau' }] };

t('blocs d\'un jeton d\'outils : une entrée par famille, le jeton en Bearer', () => {
    const blocs = C.g('elpisConnexionBlocks')('ept_abc', ['fs', 'git'],
        'http://lan/api/mcp-bridge', 'http://lan/api/tools', 'tools');
    const par = Object.fromEntries(blocs.map((b) => [b.id, b.text]));
    const mcp = JSON.parse(par.mcp).mcpServers;
    assert.deepEqual(Object.keys(mcp), ['elpis-fs', 'elpis-git']);
    assert.equal(mcp['elpis-fs'].url, 'http://lan/api/mcp-bridge/fs');
    assert.equal(mcp['elpis-fs'].headers.Authorization, 'Bearer ept_abc');
    assert.equal(JSON.parse(par.vscode).servers['elpis-git'].type, 'http');
    assert.equal(JSON.parse(par.opencode).mcp['elpis-fs'].type, 'remote');
    assert.ok(par.openapi.includes('http://lan/api/tools/git') && par.openapi.includes('ept_abc'));
    assert.ok(par.curl.includes('http://lan/api/tools/fs/openapi.json'));
});

t('sans jeton en clair : espace réservé partout', () => {
    const blocs = C.g('elpisConnexionBlocks')('', ['fs'], 'u', 'v', 'tools');
    assert.ok(blocs.every((b) => b.text.includes('<VOTRE_JETON>')));
    const oc = C.g('elpisConnexionBlocks')('pcr_x', [], 'u', 'v', 'opencode');
    assert.deepEqual(depuisBac(oc.map((b) => b.text)), ['/remote pcr_x']);
});

(async () => {
    await ta('nouveau jeton : desktop proposé mais jamais coché d\'office', async () => {
        const { D } = monter(async () => reponse({ tokens: [], policy: POLITIQUE, bridge_url: 'b', tools_url: 'o', opencode_enabled: true }));
        await D.loadConnexions();
        D.cnxNew();
        assert.deepEqual(depuisBac(D.cnxState.value.form.families), { fs: true, git: true, desktop: false });
        assert.equal(D.cnxState.value.form.days, 30);
    });

    await ta('création : familles cochées envoyées, jeton montré une fois', async () => {
        const { D, vus } = monter(async (u, o) => {
            if (o && o.method === 'POST') return reponse({ token: 'ept_neuf', item: { id: 4, kind: 'tools', name: 'X', families: ['fs'] } });
            return reponse({ tokens: [{ id: 4, kind: 'tools', name: 'X', families: ['fs'], hint: 'neuf' }], policy: POLITIQUE, bridge_url: 'b', tools_url: 'o' });
        });
        await D.loadConnexions();
        D.cnxNew();
        D.cnxState.value.form.families.git = false;
        await D.cnxCreate();
        const post = vus.find((v) => v[1] === 'POST');
        assert.deepEqual(JSON.parse(post[2]).families, ['fs']);
        assert.equal(D.cnxState.value.reveal.token, 'ept_neuf');
        assert.equal(D.cnxState.value.form, null);
        // configuration d'un jeton existant : plus de clair
        D.cnxShowConfig(D.cnxState.value.tokens[0]);
        assert.equal(D.cnxState.value.reveal.token, '');
        assert.ok(D.cnxBlocks().every((b) => !b.text.includes('ept_neuf')));
    });

    await ta('erreur de création : message du serveur affiché', async () => {
        const { D } = monter(async (u, o) => (o && o.method === 'POST')
            ? reponse({ detail: 'Durée maximale : 90 jours.' }, false)
            : reponse({ tokens: [], policy: POLITIQUE }));
        await D.loadConnexions();
        D.cnxNew();
        await D.cnxCreate();
        assert.equal(D.cnxState.value.error, 'Durée maximale : 90 jours.');
        assert.equal(D.cnxState.value.reveal, null);
    });

    await ta('fermeture des Paramètres : le jeton montré une fois est oublié', async () => {
        const { D } = monter(async (u, o) => (o && o.method === 'POST')
            ? reponse({ token: 'ept_secret', item: { id: 1, name: 'x', kind: 'tools', families: ['fs'] } })
            : reponse({ tokens: [], policy: POLITIQUE }));
        await D.loadConnexions();
        D.cnxNew();
        await D.cnxCreate();
        assert.equal(D.cnxState.value.reveal.token, 'ept_secret');
        D.cnxReset();
        assert.equal(D.cnxState.value.reveal, null);
        assert.ok(!JSON.stringify(D.cnxState.value).includes('ept_secret'));
    });

    await ta('applications autorisées (OAuth) : listées puis retirées', async () => {
        let grants = [{ grant_id: 'g1', client_id: 'elpis-x', client_name: 'Éditeur', families: ['fs'],
                        created_at: 1790000000, last_used_at: null }];
        const { D, vus } = monter(async (u, o) => {
            if (u === '/api/oauth/grants') return reponse({ items: grants, enabled: true });
            if (u === '/api/oauth/grants/g1' && o && o.method === 'DELETE') { grants = []; return reponse({ ok: true }); }
            return reponse({ tokens: [], policy: POLITIQUE });
        });
        await D.loadConnexions();
        assert.equal(D.cnxState.value.grants.length, 1);
        assert.equal(D.cnxState.value.oauthEnabled, true);
        await D.cnxRevokeGrant(D.cnxState.value.grants[0]);
        assert.ok(vus.some((v) => v[0] === '/api/oauth/grants/g1' && v[1] === 'DELETE'));
        assert.equal(D.cnxState.value.grants.length, 0);
        D.cnxReset();
        assert.deepEqual(depuisBac(D.cnxState.value.grants), []);
    });

    fin('test_connexions.js');
})();
