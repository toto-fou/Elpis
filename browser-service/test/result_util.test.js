// SPDX-License-Identifier: MIT
// Verrouille les mises en forme de l'audit tools web 2026-09-05 (perdues une
// première fois par un retour de version — d'où un test unitaire, pas une
// session navigateur).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostOf, compactConsole, summarizeNetwork, describeLocator, selectOptionArg,
         sansAnsi, codeErreur, racinesMasquees, nettoyerSortie, normaliserErreur,
         noeudsAria, ressemblance, classerSuggestions, echapperDsl, echapperCss, litteralXPath } from '../result_util.js';

test('compactConsole regroupe les répétitions en (×N) et garde les distincts', () => {
    const lines = ['[error] A', '[error] B', '[error] A', '[error] A', '[warning] C'];
    assert.deepEqual(compactConsole(lines, 5), ['[error] B', '[error] A (×3)', '[warning] C']);
    // plafond n : on garde les DERNIERS distincts
    assert.deepEqual(compactConsole(lines, 1), ['[warning] C']);
    assert.deepEqual(compactConsole([], 5), []);
});

test('summarizeNetwork : by_host sur tout, priorité document/same-origin sous le plafond', () => {
    const logs = [];
    for (let i = 0; i < 30; i++) logs.push({ ts: i, dir: 'REQ', type: 'xhr', url: 'https://optimizely.com/x', host: 'optimizely.com', same_origin: false });
    logs.push({ ts: 100, dir: 'REQ', type: 'document', method: 'POST', url: 'https://app/authenticate', host: 'app', same_origin: true });
    logs.push({ ts: 101, dir: 'RES', type: 'document', status: 303, url: 'https://app/authenticate', host: 'app', same_origin: true });
    logs.push({ ts: 102, dir: 'RES', type: 'document', status: 200, url: 'https://app/secure', host: 'app', same_origin: true });
    const r = summarizeNetwork(logs, { last: 5 });
    assert.equal(r.total, 33);
    assert.deepEqual(r.by_host, { 'optimizely.com': 30, app: 3 });
    assert.equal(r.count, 5);
    assert.equal(r.prioritized, true);
    // les 3 entrées document sont là, complétées par du bruit, ordre chronologique
    assert.deepEqual(r.logs.filter(l => l.type === 'document').map(l => l.status ?? l.method), ['POST', 303, 200]);
    assert.deepEqual(r.logs.map(l => l.ts), r.logs.map(l => l.ts).slice().sort((a, b) => a - b));
    // filtre + types
    assert.equal(summarizeNetwork(logs, { filter: 'secure' }).count, 1);
    assert.equal(summarizeNetwork(logs, { types: new Set(['document']) }).total, 3);
    assert.equal(hostOf('https://a.b:8080/x?y'), 'a.b:8080');
    assert.equal(hostOf('nope'), '');
});

test('describeLocator reflète resolveOfficialLocator', () => {
    assert.equal(describeLocator({ by_role: 'link', by_name: 'Log in' }), "page.getByRole('link', { name: /Log in/i }).first()");
    assert.equal(describeLocator({ by_role: 'button', by_name: 'OK', exact: true, nth: 2 }), "page.getByRole('button', { name: 'OK' }).nth(2)");
    assert.equal(describeLocator({ by_css: "#it's" }), "page.locator('#it\\'s').first()");
    assert.equal(describeLocator({ by_text: 'Hello', filter_has_text: 'x' }, { first: false }), "page.getByText('Hello').filter({ hasText: 'x' })");
    assert.equal(describeLocator({ ref: 'loc_ab#1' }), "ref('loc_ab#1')");
    assert.equal(describeLocator({ selector: 'text=Go' }), "page.locator('text=Go').first()");
    assert.equal(describeLocator({}), null);
});

test('selectOptionArg : jamais selectOption(\'\') quand une option a été choisie', () => {
    const evt = { action: 'select', selected: { value: '2', label: 'Option 2', index: 2 } };
    assert.equal(selectOptionArg(evt, 'playwright'), "{ label: 'Option 2' }");
    assert.equal(selectOptionArg(evt, 'cypress'), "'Option 2'");
    assert.equal(selectOptionArg(evt, 'robot'), 'label    Option 2');
    assert.equal(selectOptionArg({ option_label: 'France ${{1+1}}\n    Log' }, 'robot'), String.raw`label    France \${{1+1}}\u000a\u0020\u0020\u0020 Log`);
    assert.equal(selectOptionArg({ option_value: '2', selected: { value: '2', label: 'Option 2' } }, 'playwright'), "{ label: 'Option 2' }");
    assert.equal(selectOptionArg({ selected: { value: '2', label: '' } }, 'playwright'), "{ value: '2' }");
    // événement historique sans `selected` : on retombe sur value
    assert.equal(selectOptionArg({ value: 'fr' }, 'playwright'), "{ value: 'fr' }");
    assert.equal(selectOptionArg({}, 'playwright'), "''");
});

test('codeErreur : codes fixes sans donnée, code propre gardé, browser_error sinon', () => {
    assert.equal(codeErreur('Navigation échouée vers https://domaine-inexistant.invalid/ : net::ERR_TUNNEL_CONNECTION_FAILED'), 'navigation_failed');
    assert.equal(codeErreur('No <option> matching "Option 99". Available: "Option 1"(1)'), 'option_not_found');
    assert.equal(codeErreur("Cannot read properties of undefined (reading 'buffer')"), 'internal_error');
    assert.equal(codeErreur('locator.click: Timeout 2500ms exceeded.\nCall log:\n\x1b[2m  - waiting\x1b[22m'), 'timeout');
    assert.equal(codeErreur('element_not_found'), 'element_not_found');
    assert.equal(codeErreur('Quelque chose de neuf : /home/x'), 'browser_error');
    for (const m of ['Navigation échouée vers x', 'No <option> matching "a"', 'Cannot read properties of null', 'zzz'])
        assert.match(codeErreur(m), /^[a-z][a-z0-9_]{0,24}$/);
});

test('sansAnsi et nettoyerSortie : séquences ANSI retirées, chemins du serveur masqués à toute profondeur', () => {
    assert.equal(sansAnsi('\x1b[2m- waiting for getByRole\x1b[22m'), '- waiting for getByRole');
    const racines = racinesMasquees({ base: '/home/dev/Elpis/browser-service', home: '/home/dev' });
    const r = nettoyerSortie({
        error: 'boom \x1b[31mrouge\x1b[39m',
        screenshot_path: '/home/dev/Elpis/browser-service/screenshots/fail_ab_1.png',
        results: [{ path: '/home/dev/.cache/ms-playwright/x', note: 'cwd /home/dev/Elpis/browser-service' }],
        autre: '/home/devx/garde', n: 3, ok: true, rien: null,
    }, racines);
    assert.deepEqual(r, {
        error: 'boom rouge', screenshot_path: 'screenshots/fail_ab_1.png',
        results: [{ path: '~/.cache/ms-playwright/x', note: 'cwd .' }],
        autre: '/home/devx/garde', n: 3, ok: true, rien: null,
    });
    assert.ok(!JSON.stringify(r).includes('/home/dev/'));
});

test("normaliserErreur : code ajouté aux erreurs qui n'en ont pas, sauf enveloppes de session 404/410", () => {
    assert.deepEqual(normaliserErreur({ status: 'nav_error', error: 'Navigation échouée vers x : net::ERR_X' }, 502),
        { status: 'nav_error', error: 'Navigation échouée vers x : net::ERR_X', code: 'navigation_failed' });
    assert.deepEqual(normaliserErreur({ error: 'x', code: 'ref_expired' }, 404), { error: 'x', code: 'ref_expired' });
    assert.deepEqual(normaliserErreur({ error: 'Session introuvable.' }, 404), { error: 'Session introuvable.' });
    assert.deepEqual(normaliserErreur({ error: 'Session expirée (page crash).' }, 410), { error: 'Session expirée (page crash).' });
    assert.deepEqual(normaliserErreur({ status: 'success' }, 200), { status: 'success' });
    assert.equal(normaliserErreur({ error: "Cannot read properties of undefined (reading 'buffer')" }, 500).code, 'internal_error');
});

test('noeudsAria : rôles et noms actionnables d\'un instantané ARIA, guillemets YAML compris', () => {
    const yaml = ['- heading "T" [level=3]', '- checkbox', '- text: c1', '- checkbox [checked]',
        '- button "Say \\"hi\\""', '- link "delete":', '  - /url: "#d"', '- textbox "Email": x',
        '- combobox:', '  - option "Option 1" [selected]', "- 'button \"Menu: l''ouvrir\"'", '- link "delete":'].join('\n');
    assert.deepEqual(noeudsAria(yaml), [
        { role: 'checkbox', name: '' }, { role: 'button', name: 'Say "hi"' }, { role: 'link', name: 'delete' },
        { role: 'textbox', name: 'Email' }, { role: 'combobox', name: '' }, { role: 'option', name: 'Option 1' },
        { role: 'button', name: "Menu: l'ouvrir" },
    ]);
});

test('classerSuggestions : noms proches d\'abord, sinon les éléments du rôle demandé', () => {
    const noeuds = [{ role: 'button', name: 'Restart' }, { role: 'button', name: 'Valider' },
                    { role: 'link', name: 'Valider le panier' }, { role: 'link', name: 'Accueil' }];
    assert.ok(ressemblance('Validr', 'Valider') > 0.8);
    assert.ok(ressemblance('Fantome', 'Valider') < 0.5);
    assert.equal(ressemblance('Étoile', 'etoile'), 1);
    assert.deepEqual(classerSuggestions(noeuds, { name: 'Validr', role: 'button' }).map(s => s.target),
        ['role=button|name=Valider']);
    assert.deepEqual(classerSuggestions(noeuds, { name: 'valider', role: 'link' }).map(s => s.target),
        ['role=button|name=Valider', 'role=link|name=Valider le panier']);
    assert.deepEqual(classerSuggestions(noeuds, { name: 'Fantome', role: 'button' }).map(s => s.name), ['Restart', 'Valider']);
    assert.deepEqual(classerSuggestions(noeuds, { name: 'Zzz' }, 2).map(s => s.name), ['Restart', 'Valider']);
    assert.deepEqual(classerSuggestions([], { name: 'x' }), []);
});

test('nettoyerSortie : seuls les messages et les chemins du service changent ; contenu de la page, Date et URL rendus tels quels', () => {
    const racines = racinesMasquees({ base: '/home/dev/Elpis/browser-service', home: '/home/dev' });
    const quand = new Date(86400000);
    const corps = {
        text: 'Voir /home/dev/notes.txt ; dépôt http://git.lan/home/dev ; fin', url: 'http://git.lan/home/dev',
        tabs: [{ index: 0, url: 'http://git.lan/root/home/dev', title: '/home/dev/notes' }],
        result: { error: 'cwd /home/dev/x', quand, ou: new URL('http://a.lan/x') },
        results: [{ frame: 'about:blank', result: [new Date(0)] }],
        dialog: { last: { message: 'fichier /home/dev/notes.txt' } },
        error: 'Navigation to http://git.lan/home/dev failed: /home/dev/.cache/x introuvable',
        fix: 'voir /home/dev/Elpis/browser-service/screenshots/a.png', screenshot_path: '/home/dev/Elpis/browser-service/screenshots/a.png',
    };
    assert.deepEqual(JSON.parse(JSON.stringify(nettoyerSortie(corps, racines))), {
        ...JSON.parse(JSON.stringify(corps)),
        error: 'Navigation to http://git.lan/home/dev failed: ~/.cache/x introuvable',
        fix: 'voir screenshots/a.png', screenshot_path: 'screenshots/a.png',
    });
    assert.equal(JSON.stringify(nettoyerSortie({ result: new Date(0) }, racines)), '{"result":"1970-01-01T00:00:00.000Z"}');
    assert.equal(JSON.stringify(nettoyerSortie({ quand: new Date(0), ou: new URL('http://a.lan/') }, racines)),
        '{"quand":"1970-01-01T00:00:00.000Z","ou":"http://a.lan/"}');
});

test('cibles DSL générées : un « | » qui annoncerait une clé est échappé, les autres restent lisibles', () => {
    const noeuds = [{ role: 'link', name: 'Docs | Produit' }, { role: 'button', name: 'Trier | name=prix' }];
    assert.deepEqual(classerSuggestions(noeuds, {}).map(s => s.target),
        ['role=link|name=Docs | Produit', 'role=button|name=Trier \\| name=prix']);
    assert.equal(echapperDsl('a:has-text("x |NTH=1")'), 'a:has-text("x \\|NTH=1")');
    assert.equal(echapperDsl('[lang|=fr]'), '[lang|=fr]');
    assert.equal(echapperDsl('a \\|name=b'), 'a \\|name=b');
});

test('sélecteurs du modèle : antislash et guillemet échappés en CSS, littéral XPath sans antislash', () => {
    assert.equal(echapperCss('C:\\d "x"'), 'C:\\\\d \\"x\\"');
    assert.equal(echapperCss(undefined), '');
    assert.equal(litteralXPath('Valider'), "'Valider'");
    assert.equal(litteralXPath("J'accepte"), `"J'accepte"`);
    assert.equal(litteralXPath('dit "oui"'), `'dit "oui"'`);
    assert.equal(litteralXPath(`l'a dit "oui"`), `concat('l', "'", 'a dit "oui"')`);
});
