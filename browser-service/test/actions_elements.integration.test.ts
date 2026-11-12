// SPDX-License-Identifier: MIT
// browser-service/test/actions_elements.integration.test.ts — vrai service construit (dist/main.mjs) + Chromium (PLAYWRIGHT_BROWSERS_PATH) sur des pages d'essai d'une adresse publique fixe, servies par les simulations de la session (/mock/add) : aucun réseau.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { demarrerService, raisonDeSauter } from './aides/service.ts';
import type { Service } from './aides/service.ts';

const SAUT = await raisonDeSauter();

const SITE = 'http://93.184.216.34';
const OWNER = 'essai';
const PAGES = {
    '/checkboxes': `<h3>Checkboxes</h3><form id="checkboxes">
        <input type="checkbox"> checkbox 1<br><input type="checkbox" checked> checkbox 2
        <label><input type="checkbox" disabled> verrou</label></form>`,
    '/iframe': `<h3>An iFrame containing the TinyMCE WYSIWYG Editor</h3>
        <iframe id="mce_0_ifr" src="${SITE}/iframe-content" title="Rich Text Area"></iframe>`,
    '/iframe-content': '<p>Your content goes here.</p>',
    '/upload': `<h3>File Uploader</h3><input id="file-upload" type="file" multiple>
        <div id="uploaded-files"></div>
        <script>document.getElementById('file-upload').addEventListener('change', async (e) => {
            const parts = [];
            for (const f of e.target.files) parts.push(f.name + ':' + f.type + ':' + await f.text());
            document.getElementById('uploaded-files').textContent = parts.join('|');
        });</script>`,
    '/tables': `<table id="table1"><tbody>${['Smith', 'Bach', 'Doe', 'Conway'].map(n =>
        `<tr><td>${n}</td><td><a href="#edit">edit</a> <a href="#delete" onclick="window.last='${n}'">delete</a></td></tr>`).join('')}
        </tbody></table>`,
    '/boutons': `<button onclick="window.last='Restart'">Restart</button>
        <button onclick="window.last='Start'">Start</button>
        <button onclick="window.last='Valider'">Valider</button>
        <button disabled>Bloqué</button>`,
    '/redemarrer': `<button onclick="window.last='Restart'">Restart</button>`,
    '/dropdown': `<select id="dropdown"><option value="" disabled selected>Please select an option</option>
        <option value="1">Option 1</option><option value="2">Option 2</option></select>
        <div id="custom" onclick="document.getElementById('liste').hidden=false">Choose a city</div>
        <ul id="liste" role="listbox" hidden><li role="option" onclick="window.ville='Lyon'">Lyon</li>
        <li role="option" onclick="window.ville='Paris'">Paris</li></ul>`,
    '/chemin': '<input name="C:\\dossier">',
    '/apostrophe': `<button>it's</button>`,
};

// Élément trouvé par /locator ou candidat d'une cible ambiguë.
interface ElementTrouve { role: string; name: string; text: string; ref: string; checked: boolean; disabled: boolean }
// Résultat d'une étape de /chain.
interface Etape {
    success: boolean;
    screenshot_file: string;
    screenshot_path: string;
    code: string;
    duration_ms: number;
    alternatives: { target: string }[];
}

// Champs des réponses lus par ces essais.
interface Corps {
    session_id: string;
    count: number;
    frames: { url: string }[];
    frames_total: number;
    text: string;
    total: number;
    matches: ElementTrouve[];
    code: string;
    options: { label: string }[];
    results: Etape[];
    path: string;
    matched: number;
    warning: string;
    candidates: ElementTrouve[];
    name_match: string;
    suggestions: { target: string; name: string }[];
    uploaded: { name: string; size: number }[];
    strategy: string;
    result: unknown;
    selected: { value: string; label: string; index: number };
}

let svc!: Service<Corps>;
let sid = '';

async function api(route: string, corps: Record<string, unknown> = {}) {
    const r = await svc.post(route, { owner: OWNER, session_id: sid, ...corps });
    return { status: r.statut, corps: r.corps };
}

async function lire(route: string) {
    const r = await svc.get(`${route}${route.includes('?') ? '&' : '?'}owner=${OWNER}&session_id=${sid}`);
    return { status: r.statut, corps: r.corps };
}

// Page d'essai ouverte par un vrai goto ; le DOM est neuf à chaque appel.
async function ouvrir(chemin: string) {
    const r = await api('/action', { type: 'goto', url: `${SITE}${chemin}` });
    assert.equal(r.status, 200, JSON.stringify(r.corps));
}

async function evaluer(script: string) {
    const r = await api('/evaluate', { script });
    assert.equal(r.status, 200, JSON.stringify(r.corps));
    return r.corps.result;
}

before(async () => {
    if (SAUT) return;
    svc = await demarrerService<Corps>({ env: { FORCE_COLOR: '1' } });
    const r = await api('/start', { url: 'about:blank', isolated: true });
    assert.equal(r.status, 200, JSON.stringify(r.corps));
    sid = r.corps.session_id;
    for (const [chemin, corps] of Object.entries(PAGES)) {
        const m = await api('/mock/add', {
            url_pattern: `^${SITE.replace(/\./g, '\\.')}${chemin}$`, is_regex: true,
            status: 200, content_type: 'text/html; charset=utf-8',
            body: `<!doctype html><html><head><meta charset="utf-8"><title>${chemin}</title></head><body>${corps}</body></html>`,
        });
        assert.equal(m.status, 200, JSON.stringify(m.corps));
    }
    await api('/mock/add', { url_pattern: '93.184.216.34', status: 404, content_type: 'text/plain', body: 'absent' });
});

after(async () => {
    if (svc) {
        if (sid) await api('/stop', {}).catch(() => {});
        await svc.arreter();
    }
});

const T = { skip: SAUT, timeout: 60000 };

test('frames : une iframe listée une fois, son texte lu une fois', T, async () => {
    await ouvrir('/iframe');
    await new Promise(r => setTimeout(r, 300));
    const f = await lire('/frames');
    assert.equal(f.status, 200, JSON.stringify(f.corps));
    assert.equal(f.corps.count, 2, JSON.stringify(f.corps.frames));
    assert.equal(f.corps.frames.filter(x => x.url.endsWith('/iframe-content')).length, 1);
    const t = await api('/extract_text', { include_frames: true });
    assert.equal(t.status, 200, JSON.stringify(t.corps));
    assert.equal(t.corps.frames_total, 1);
    assert.equal(t.corps.text.split('Your content goes here.').length - 1, 1, t.corps.text);
});

test('locator : rôle ARIA effectif, état coché, jamais la valeur « on » comme texte', T, async () => {
    await ouvrir('/checkboxes');
    const r = await api('/locator', { by_role: 'checkbox', max: 5, visible_only: false });
    assert.equal(r.status, 200, JSON.stringify(r.corps));
    assert.equal(r.corps.total, 3);
    const [a, b, c] = r.corps.matches as [ElementTrouve, ElementTrouve, ElementTrouve];
    assert.deepEqual([a.role, b.role, c.role], ['checkbox', 'checkbox', 'checkbox']);
    assert.deepEqual([a.checked, b.checked, c.checked], [false, true, false]);
    assert.equal(c.disabled, true);
    assert.equal(c.name, 'verrou');
    for (const m of r.corps.matches) assert.notEqual(m.text, 'on', JSON.stringify(m));
    const css = await api('/locator', { by_css: '#checkboxes input', max: 5, visible_only: false });
    assert.deepEqual(css.corps.matches.map(m => m.role), ['checkbox', 'checkbox', 'checkbox']);
});

// Aucune séquence ANSI dans une réponse.
function propre(corps: unknown) {
    const texte = JSON.stringify(corps);
    assert.ok(!texte.includes('\\u001b') && !texte.includes('\x1b'), texte);
}

test('erreurs : codes fixes sans donnée, liste des options, aucun ANSI', T, async () => {
    await ouvrir('/dropdown');
    const r = await api('/action', { type: 'select', by_css: '#dropdown', selector: '#dropdown', option_label: 'Option 99' });
    assert.equal(r.status, 500);
    assert.equal(r.corps.code, 'option_not_found', JSON.stringify(r.corps));
    assert.deepEqual(r.corps.options.map(o => o.label), ['Please select an option', 'Option 1', 'Option 2']);
    propre(r.corps);
    await ouvrir('/boutons');
    const t = await api('/action', { type: 'click', by_role: 'button', by_name: 'Bloqué', timeout: 1200 });
    assert.equal(t.status, 500);
    assert.equal(t.corps.code, 'timeout', JSON.stringify(t.corps));
    propre(t.corps);
});

test('échec de pw_chain avec capture, pdf : chemins réels du dossier du service (/work dans le bac), sans ANSI', T, async () => {
    await ouvrir('/boutons');
    const c = await api('/chain', { actions: [{ type: 'press', key: 'NoSuchKey' }], screenshot_on_fail: true });
    assert.equal(c.status, 200, JSON.stringify(c.corps));
    const echec = c.corps.results[0]!;
    assert.equal(echec.success, false);
    assert.match(echec.screenshot_file, /^fail_/);
    assert.equal(echec.screenshot_path, `${svc.dossier}/screenshots/${echec.screenshot_file}`);
    assert.match(echec.code, /^[a-z][a-z0-9_]*$/);
    propre(c.corps);
    const p = await api('/print_pdf', {});
    assert.equal(p.status, 200, JSON.stringify(p.corps));
    assert.ok(p.corps.path.startsWith(`${svc.dossier}/downloads/essai/page_`) && p.corps.path.endsWith('.pdf'), p.corps.path);
    propre(p.corps);
});

test('clic ambigu : matched + avertissement, refus strict avec candidats, nth', T, async () => {
    await ouvrir('/tables');
    const cible = { type: 'click', by_role: 'link', by_name: 'delete', selector: 'delete' };
    const r = await api('/action', cible);
    assert.equal(r.status, 200, JSON.stringify(r.corps));
    assert.equal(r.corps.matched, 4);
    assert.match(r.corps.warning, /4 elements match/);
    assert.equal(await evaluer('window.last'), 'Smith');
    const s = await api('/action', { ...cible, strict: true });
    assert.equal(s.status, 409, JSON.stringify(s.corps));
    assert.equal(s.corps.code, 'ambiguous_target');
    assert.equal(s.corps.candidates.length, 4);
    assert.deepEqual(s.corps.candidates.map(c => [c.role, c.name]), Array(4).fill(['link', 'delete']));
    const parRef = await api('/action', { type: 'click', ref: s.corps.candidates[2]!.ref });
    assert.equal(parRef.status, 200, JSON.stringify(parRef.corps));
    assert.equal(await evaluer('window.last'), 'Doe');
    const n = await api('/action', { ...cible, nth: 3, strict: true });
    assert.equal(n.status, 200, JSON.stringify(n.corps));
    assert.equal(await evaluer('window.last'), 'Conway');
    const hors = await api('/action', { ...cible, nth: 9 });
    assert.equal(hors.corps.code, 'element_not_found', JSON.stringify(hors.corps));
    await ouvrir('/boutons');
    const perime = await api('/action', { type: 'click', ref: s.corps.candidates[0]!.ref, selector: `ref:${s.corps.candidates[0]!.ref}` });
    assert.equal(perime.status, 404, JSON.stringify(perime.corps));
    assert.equal(perime.corps.code, 'ref_expired');
});

test('nom : correspondance exacte préférée, sous-chaîne signalée', T, async () => {
    await ouvrir('/boutons');
    const r = await api('/action', { type: 'click', by_role: 'button', by_name: 'Start', selector: 'Start' });
    assert.equal(r.status, 200, JSON.stringify(r.corps));
    assert.equal(await evaluer('window.last'), 'Start');
    assert.equal(r.corps.matched, 1);
    assert.equal(r.corps.name_match, 'exact');
    assert.equal(r.corps.warning, undefined);
    await ouvrir('/redemarrer');
    const p = await api('/action', { type: 'click', by_role: 'button', by_name: 'Start', selector: 'Start' });
    assert.equal(p.status, 200, JSON.stringify(p.corps));
    assert.equal(p.corps.name_match, 'substring');
    assert.match(p.corps.warning, /named exactly "Start".*"Restart"/);
});

test('élément introuvable : échec rapide element_not_found avec des cibles proches', T, async () => {
    await ouvrir('/boutons');
    const t0 = Date.now();
    const r = await api('/action', { type: 'click', by_role: 'button', by_name: 'Validr', selector: 'Validr' });
    assert.ok(Date.now() - t0 < 6000, `${Date.now() - t0} ms`);
    assert.equal(r.status, 404, JSON.stringify(r.corps));
    assert.equal(r.corps.code, 'element_not_found');
    assert.equal(r.corps.suggestions[0]!.target, 'role=button|name=Valider');
    const f = await api('/action', { type: 'click', by_role: 'button', by_name: 'Fantome', selector: 'Fantome' });
    assert.equal(f.corps.code, 'element_not_found');
    assert.deepEqual(f.corps.suggestions.map(x => x.name), ['Restart', 'Start', 'Valider', 'Bloqué']);
    const c = await api('/chain', { actions: [{ type: 'click', by_role: 'button', by_name: 'Validr', selector: 'Validr' }],
                                   screenshot_on_fail: false });
    assert.equal(c.status, 200, JSON.stringify(c.corps));
    assert.equal(c.corps.results[0]!.code, 'element_not_found');
    assert.ok(c.corps.results[0]!.duration_ms < 6000, JSON.stringify(c.corps.results[0]));
    assert.equal(c.corps.results[0]!.alternatives[0]!.target, 'role=button|name=Valider');
});

test('pick : la valeur retenue est rendue (select natif et liste personnalisée)', T, async () => {
    await ouvrir('/dropdown');
    const n = await api('/handle_dropdown', { selector: '#dropdown', option_text: 'Option 2', search_text: 'Option 2' });
    assert.equal(n.status, 200, JSON.stringify(n.corps));
    assert.deepEqual(n.corps.selected, { value: '2', label: 'Option 2', index: 2 });
    const c = await api('/handle_dropdown', { selector: '#custom', option_text: 'Lyon', search_text: 'Lyon' });
    assert.equal(c.status, 200, JSON.stringify(c.corps));
    assert.equal(c.corps.selected.label, 'Lyon');
    assert.equal(await evaluer('window.ville'), 'Lyon');
    const x = await api('/handle_dropdown', { selector: '#dropdown', option_text: 'Option 99', search_text: 'Option 99' });
    assert.equal(x.corps.code, 'option_not_found', JSON.stringify(x.corps));
    assert.equal(x.corps.options.length, 3);
});

test('upload : contenus base64 posés dans le champ, refus clairs sans fichier ou avec un chemin du serveur', T, async () => {
    await ouvrir('/upload');
    const b64 = (t: string) => Buffer.from(t).toString('base64');
    const r = await api('/action', { type: 'upload', by_css: '#file-upload', selector: '#file-upload', files: [
        { name: 'note.txt', mime_type: 'text/plain', content_base64: b64('bonjour') },
        { name: 'sous/dossier/b.csv', content_base64: b64('a;b') },
    ] });
    assert.equal(r.status, 200, JSON.stringify(r.corps));
    assert.deepEqual(r.corps.uploaded, [{ name: 'note.txt', size: 7 }, { name: 'b.csv', size: 3 }]);
    assert.equal(await evaluer("document.getElementById('uploaded-files').textContent"),
        'note.txt:text/plain:bonjour|b.csv:application/octet-stream:a;b');
    for (const files of [undefined, []]) {
        const v = await api('/action', { type: 'upload', by_css: '#file-upload', selector: '#file-upload', files });
        assert.equal(v.status, 400, JSON.stringify(v.corps));
        assert.equal(v.corps.code, 'files_required');
    }
    const ch = await api('/action', { type: 'upload', by_css: '#file-upload', files: ['/etc/hostname'] });
    assert.equal(ch.status, 400, JSON.stringify(ch.corps));
    assert.equal(ch.corps.code, 'invalid_files');
    const fp = await api('/action', { type: 'upload', by_css: '#file-upload', filePath: '/etc/hostname' });
    assert.equal(fp.corps.code, 'files_required');
    assert.ok(!JSON.stringify([r, ch, fp]).includes('buffer'));
});

test('sélecteur avec antislash : la stratégie name retrouve le champ (antislash échappé, pas lu comme échappement CSS)', T, async () => {
    await ouvrir('/chemin');
    const r = await api('/action', { type: 'fill', selector: 'C:\\dossier', text: 'ok' });
    assert.equal(r.status, 200, JSON.stringify(r.corps));
    assert.equal(await evaluer("document.querySelector('input').value"), 'ok');
});

test("cible text='…' déjà échappée : désescapée comme Playwright avant la réécriture en :has-text", T, async () => {
    await ouvrir('/apostrophe');
    const r = await api('/action', { type: 'click', selector: "text='it\\'s'" });
    assert.equal(r.status, 200, JSON.stringify(r.corps));
    assert.equal(r.corps.strategy, '1-playwright');
});
