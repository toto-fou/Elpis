// SPDX-License-Identifier: MIT
/* eslint-disable */
// @ts-nocheck
/** browser-service/src/routes/enregistreur.ts — /recorder/*: gesture recorder and its script (playwright, cypress, robot, json) written to /work/recordings. */
import fs from 'fs';
import { celluleRobot, commentaireEval, notesDuScript, porteeCadres } from '../recorder_util.ts';
import { intercepteurs } from '../requete.ts';
import { selectOptionArg } from '../result_util.ts';


export function registerRecorderRoutes(app, ctx) {
const { getSession } = intercepteurs(ctx);
app.post('/recorder/start', getSession, async (req, res) => {
    req.session._recorder = {
        recording: true,
        start_ts: Date.now(),
        events: [],
        variables: new Map(),
    };
    res.json({ status: 'recording', start_ts: req.session._recorder.start_ts });
});

app.post('/recorder/stop', getSession, async (req, res) => {
    if (!req.session._recorder) {
        return res.json({ status: 'not_started', count: 0 });
    }
    req.session._recorder.recording = false;
    res.json({
        status: 'stopped',
        count: req.session._recorder.events.length,
        duration_ms: Date.now() - req.session._recorder.start_ts,
    });
});

app.post('/recorder/clear', getSession, async (req, res) => {
    if (req.session._recorder) {
        req.session._recorder.events = [];
        req.session._recorder.variables = new Map();
        req.session._recorder.start_ts = Date.now();
    }
    res.json({ status: 'cleared' });
});

app.get('/recorder/status', getSession, async (req, res) => {
    const r = req.session._recorder;
    res.json({
        recording: !!(r && r.recording),
        count: r ? r.events.length : 0,
        duration_ms: r ? Date.now() - r.start_ts : 0,
    });
});

app.get('/recorder/dump', getSession, async (req, res) => {
    const format = req.query.format || 'playwright';
    const r = req.session._recorder;
    if (!r || r.events.length === 0) {
        return res.json({ format, count: 0, script: '', warning: 'No events recorded.' });
    }
    const events = r.events;

    function escape(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
    function targetExpr(evt, fmt, l = evt.locator || {}) {
        // l : sélecteur stable relevé (role, name, text, label, css…) ; les cadres de evt.frames préfixent la cible
        if (fmt === 'playwright') {
            const page = porteeCadres(evt.frames, 'playwright', escape);
            if (l.role && l.name) return `${page}.getByRole('${escape(l.role)}', { name: '${escape(l.name)}' })`;
            if (l.role) return `${page}.getByRole('${escape(l.role)}')`;
            if (l.label) return `${page}.getByLabel('${escape(l.label)}')`;
            if (l.placeholder) return `${page}.getByPlaceholder('${escape(l.placeholder)}')`;
            if (l.test_id) return `${page}.getByTestId('${escape(l.test_id)}')`;
            if (l.text) return `${page}.getByText('${escape(l.text)}')`;
            if (l.css) return `${page}.locator('${escape(l.css)}')`;
            if (l.xpath) return `${page}.locator('xpath=${escape(l.xpath)}')`;
            return `${page}.locator('${escape(evt.selector || '')}')`;
        }
        if (fmt === 'cypress') {
            if (l.test_id) return `cy.get('[data-testid="${escape(l.test_id)}"]')`;
            if (l.role && l.name) return `cy.findByRole('${escape(l.role)}', { name: '${escape(l.name)}' })`;
            if (l.label) return `cy.findByLabelText('${escape(l.label)}')`;
            if (l.placeholder) return `cy.findByPlaceholderText('${escape(l.placeholder)}')`;
            if (l.text) return `cy.contains('${escape(l.text)}')`;
            if (l.css) return `cy.get('${escape(l.css)}')`;
            return `cy.get('${escape(evt.selector || '')}')`;
        }
        if (fmt === 'robot') {
            // Robot Framework with Browser library ; `>>>` entre dans chaque cadre
            const cadres = porteeCadres(evt.frames, 'robot');
            if (l.role && l.name) return `${cadres}role=${l.role}[name="${l.name}"]`;
            if (l.test_id) return `${cadres}[data-testid="${l.test_id}"]`;
            if (l.label) return `${cadres}label=${l.label}`;
            if (l.placeholder) return `${cadres}[placeholder="${l.placeholder.replace(/[\\"]/g, '\\$&')}"]`;
            if (l.text) return `${cadres}text=${l.text}`;
            if (l.css) return `${cadres}${l.css}`;
            return `${cadres}${evt.selector || ''}`;
        }
        return evt.selector || '';
    }

    // Option cliquée d'un choix (pick) : son sélecteur relevé, sinon son texte exact.
    const optionDe = (e, fmt) => targetExpr(e, fmt, e.option_locator || { text: e.option || '' });
    const fichiersJs = (e) => `[${(e.files || []).map(f => `'${escape(f)}'`).join(', ')}]`;
    let script = '';
    if (format === 'json') {
        script = JSON.stringify(events, null, 2);
    } else if (format === 'playwright') {
        const lines = [
            "import { test, expect } from '@playwright/test';",
            '',
        ];
        const { secret_variables: aLire } = notesDuScript(events);
        if (aLire.length) lines.push(`// Secrets are not recorded: set ${aLire.join(', ')} in the environment.`, '');
        lines.push('test(\'recorded session\', async ({ page }) => {');
        for (const e of events) {
            const t = targetExpr(e, 'playwright');
            switch (e.action) {
                case 'goto': lines.push(`  await page.goto('${escape(e.url)}');`); break;
                case 'click': lines.push(`  await ${t}.click();`); break;
                case 'fill':  lines.push(`  await ${t}.fill(${e.secret ? `process.env.${e.secret} ?? ''` : `'${escape(e.value)}'`});`); break;
                case 'type':  lines.push(`  await ${t}.type(${e.secret ? `process.env.${e.secret} ?? ''` : `'${escape(e.value)}'`});`); break;
                case 'press': lines.push(`  await page.keyboard.press('${escape(e.key || e.value)}');`); break;
                case 'eval': lines.push(`  // eval not replayed: ${commentaireEval(e.script)}`); break;
                case 'select': lines.push(`  await ${t}.selectOption(${selectOptionArg(e, 'playwright')});`); break;
                case 'check': lines.push(`  await ${t}.check();`); break;
                case 'uncheck': lines.push(`  await ${t}.uncheck();`); break;
                case 'hover': lines.push(`  await ${t}.hover();`); break;
                case 'upload': lines.push(`  await ${t}.setInputFiles(${fichiersJs(e)});`); break;
                case 'pick':
                    if (e.kind === 'custom') lines.push(`  await ${t}.click();`, `  await ${optionDe(e, 'playwright')}.click();`);
                    else lines.push(`  await ${t}.fill('${escape(e.value)}');`, e.kind === 'enter' ? `  await ${t}.press('Enter');` : `  await ${optionDe(e, 'playwright')}.click();`);
                    break;
                default: lines.push(`  // ${e.action}: ${escape(JSON.stringify(e)).replace(/[\u2028\u2029]/g, ' ')}`);
            }
        }
        lines.push('});');
        script = lines.join('\n');
    } else if (format === 'cypress') {
        const lines = ["describe('recorded session', () => {", "  it('replays', () => {"];
        for (const e of events) {
            const t = targetExpr(e, 'cypress');
            const geste = [];
            switch (e.action) {
                case 'goto':  geste.push(`cy.visit('${escape(e.url)}');`); break;
                case 'click': geste.push(`${t}.click();`); break;
                case 'fill':
                case 'type':  geste.push(e.secret ? `${t}.type(Cypress.env('${e.secret}'), { log: false });` : `${t}.type('${escape(e.value)}');`); break;
                case 'eval': geste.push(`// eval not replayed: ${commentaireEval(e.script)}`); break;
                case 'select': geste.push(`${t}.select(${selectOptionArg(e, 'cypress')});`); break;
                case 'check': geste.push(`${t}.check();`); break;
                case 'uncheck': geste.push(`${t}.uncheck();`); break;
                case 'upload': geste.push(`${t}.selectFile(${fichiersJs(e)});`); break;
                case 'pick':
                    if (e.kind === 'custom') geste.push(`${t}.click();`, `${optionDe(e, 'cypress')}.click();`);
                    else geste.push(`${t}.type('${escape(e.value)}${e.kind === 'enter' ? '{enter}' : ''}');`, ...(e.kind === 'enter' ? [] : [`${optionDe(e, 'cypress')}.click();`]));
                    break;
                default: geste.push(`// ${e.action}`);
            }
            // Geste dans des <iframe> : joué dans le corps du document du cadre.
            const cadre = e.action === 'goto' || e.action === 'eval' ? '' : porteeCadres(e.frames, 'cypress', escape);
            if (cadre) lines.push(`    ${cadre}.within(() => { ${geste.join(' ')} });`);
            else lines.push(...geste.map(g => `    ${g}`));
        }
        lines.push('  });', '});');
        script = lines.join('\n');
    } else if (format === 'robot') {
        const lines = ['*** Settings ***', 'Library    Browser', ''];
        const { secret_variables: aFournir } = notesDuScript(events);
        if (aFournir.length) lines.push('*** Variables ***', ...aFournir.map(v => `\${${v}}    %{${v}}`), '');
        lines.push('*** Test Cases ***', 'Recorded Session');
        let pageOuverte = false;
        for (const e of events) {
            const t = celluleRobot(targetExpr(e, 'robot'));
            switch (e.action) {
                // Le premier goto ouvre l'onglet ; les suivants naviguent dans le même.
                case 'goto':  lines.push(`    ${pageOuverte ? 'Go To' : 'New Page'}    ${celluleRobot(e.url)}`); pageOuverte = true; break;
                case 'click': lines.push(`    Click    ${t}`); break;
                case 'fill':  lines.push(e.secret ? `    Fill Secret    ${t}    $${e.secret}` : `    Fill Text    ${t}    ${celluleRobot(e.value)}`); break;
                case 'type':  lines.push(e.secret ? `    Type Secret    ${t}    $${e.secret}` : `    Type Text    ${t}    ${celluleRobot(e.value)}`); break;
                case 'eval':  lines.push(`    # eval not replayed: ${commentaireEval(e.script)}`); break;
                case 'press': lines.push(`    Keyboard Key    press    ${celluleRobot(e.key || e.value)}`); break;
                case 'select': lines.push(`    Select Options By    ${t}    ${selectOptionArg(e, 'robot')}`); break;
                case 'check': lines.push(`    Check Checkbox    ${t}`); break;
                case 'uncheck': lines.push(`    Uncheck Checkbox    ${t}`); break;
                case 'upload': lines.push(`    Upload File By Selector    ${t}    ${(e.files || []).map(celluleRobot).join('    ')}`); break;
                case 'pick':
                    if (e.kind === 'custom') lines.push(`    Click    ${t}`, `    Click    ${celluleRobot(optionDe(e, 'robot'))}`);
                    else lines.push(`    Fill Text    ${t}    ${celluleRobot(e.value)}`, e.kind === 'enter' ? `    Keyboard Key    press    Enter` : `    Click    ${celluleRobot(optionDe(e, 'robot'))}`);
                    break;
                default: lines.push(`    # ${e.action}`);
            }
        }
        script = lines.join('\n');
    } else {
        return res.status(400).json({ error: `Unknown format: ${format}. Use: playwright|cypress|robot|json` });
    }

    const { secret_variables, notes } = notesDuScript(events);
    // Le script est aussi écrit dans /work/recordings, prêt à rejouer dans le bac.
    const ext = { playwright: 'spec.js', cypress: 'cy.js', robot: 'robot', json: 'json' }[format] || 'txt';
    let fichier = `/work/recordings/recording-${String(req.query.session_id || '').substring(0, 8)}-${Date.now()}.${ext}`;
    try {
        fs.mkdirSync('/work/recordings', { recursive: true });
        fs.writeFileSync(fichier, script);
    } catch (e) { fichier = null; }
    res.json({ format, count: events.length, script, ...(fichier ? { file: fichier } : {}),
        ...(secret_variables.length ? { secret_variables } : {}), ...(notes.length ? { notes } : {}) });
});
}
