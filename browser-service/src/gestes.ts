// SPDX-License-Identifier: MIT
/* eslint-disable */
// @ts-nocheck
/** browser-service/src/gestes.ts — page helpers of the gestures: native select, upload files, navigation back after a failed gesture, wait after an action, tree items, drag and drop. */
import path from 'path';
import { humanMouseMove } from './interaction.ts';
import { locatorFromParams, smartResolveLocator } from './localisateur.ts';
import { erreurCodee } from './requete.ts';

// ── <select> natif : choisir SANS essai-erreur ────────────────────────
//
// L'ancienne échelle tentait selectOption({value}) puis, en cas d'échec,
// selectOption({label}). Or un selectOption qui ne matche rien consomme la
// TOTALITÉ de son timeout avant de lever : mesuré à 10,05 s pour un choix par
// libellé (0,05 s par valeur), pendant que le client Python coupe à 10 s.
// Autrement dit : choisir une option par son texte affiché — le cas NORMAL,
// puisque c'est la seule chose que le modèle voit — échouait par construction.
//
// On lit donc la liste des options UNE fois (un evaluate, ~1 ms), on décide en
// JS, et on ne fait qu'un seul selectOption qui ne peut plus échouer.
// Ordre de correspondance : valeur exacte → libellé exact → libellé trimé →
// insensible à la casse → sous-chaîne. Renvoie l'option retenue, ou lève une
// erreur qui LISTE les libellés disponibles.
// Fichiers d'un upload : contenus envoyés par l'hôte d'outils (lus dans le bac du compte), jamais un chemin du serveur.
export function fichiersUpload(files) {
    if (!Array.isArray(files) || files.length === 0)
        throw erreurCodee('files_required', 'upload needs files: a list of {name, content_base64, mime_type?}.', {
            fix: "pw_act(session_id, action='upload', target='css=input[type=file]', files=['report.pdf']) — paths inside your sandbox /work.",
        });
    return files.map((f, i) => {
        if (!f || typeof f !== 'object' || typeof f.name !== 'string' || !f.name.trim() || typeof f.content_base64 !== 'string')
            throw erreurCodee('invalid_files', `files[${i}] must be {name, content_base64, mime_type?}; server paths are not accepted.`);
        const mimeType = typeof f.mime_type === 'string' && f.mime_type ? f.mime_type : 'application/octet-stream';
        return { name: path.basename(f.name.trim()), mimeType, buffer: Buffer.from(f.content_base64, 'base64') };
    });
}

export async function selectOptionSmart(locator, { option_value, option_label, value, text, timeout = 10000 }) {
    const lu = await locator.evaluate((el) => {
        if (!el.options) return null;
        return { multiple: el.multiple, opts: Array.from(el.options).map((o, i) => ({
            i, value: o.value, label: (o.text || '').trim(), disabled: !!o.disabled,
        })) };
    }).catch(() => null);
    if (lu === null) {
        const tag = await locator.evaluate(el => el.tagName.toLowerCase()).catch(() => '?');
        const e = new Error(
            `select: <${tag}> is not a native <select>. For a custom dropdown ` +
            `(div/ul/role=listbox) use action="pick", which opens it and clicks the option.`);
        e.notASelect = true;
        e.code = 'not_a_select';
        throw e;
    }
    const opts = lu.opts;
    const pick = (pred) => opts.find(o => !o.disabled && pred(o));
    // Option voulue : par valeur (option_value), par libellé (option_label), sinon valeur ou libellé devinés (value/text).
    const trouver = ({ option_value, option_label, value, text }) => {
        let hit = null;
        if (option_value) hit = pick(o => o.value === option_value);
        else if (option_label) {
            const w = String(option_label).trim();
            hit = pick(o => o.label === w)
               || pick(o => o.label.toLowerCase() === w.toLowerCase())
               || pick(o => o.label.toLowerCase().includes(w.toLowerCase()));
        }
        if (!hit) {
            const w = String(value || text || '').trim();
            if (w) {
                hit = pick(o => o.value === w)
                   || pick(o => o.label === w)
                   || pick(o => o.label.toLowerCase() === w.toLowerCase())
                   || pick(o => o.value.toLowerCase() === w.toLowerCase())
                   || pick(o => o.label.toLowerCase().includes(w.toLowerCase()));
            }
        }
        return hit;
    };
    const absente = (wanted) => erreurCodee('option_not_found',
        `No <option> matching "${wanted}". Available: ` +
        opts.slice(0, 12).map(o => `"${o.label}"(${o.value})`).join(', ') +
        (opts.length > 12 ? `, … ${opts.length - 12} more` : ''),
        { options: opts.slice(0, 30).map(o => ({ label: o.label, value: o.value, ...(o.disabled ? { disabled: true } : {}) })),
          fix: 'Pass option_label= with one of the labels in `options` (or option_value= with its value).' });
    // <select multiple> : une liste (ou des textes séparés par des virgules, sauf s'ils forment une option) sélectionne chaque option nommée.
    const champ = ['option_value', 'option_label', 'value', 'text'].find(k => ({ option_value, option_label, value, text })[k]);
    const brut = champ ? ({ option_value, option_label, value, text })[champ] : null;
    const liste = Array.isArray(brut) ? brut.map(String).filter(Boolean)
        : lu.multiple && typeof brut === 'string' && brut.includes(',') && !trouver({ [champ]: brut }) ? brut.split(',').map(x => x.trim()).filter(Boolean) : null;
    if (liste && (lu.multiple || liste.length > 1)) {
        if (!lu.multiple) throw erreurCodee('multiple_not_allowed', `This <select> takes one option; ${liste.length} were given.`,
            { fix: 'Pass a single option_label= (or option_value=).' });
        const touches = liste.map(w => [w, trouver({ [champ]: w })]);
        const manquante = touches.find(([, h]) => !h);
        if (manquante) throw absente(manquante[0]);
        const retenues = [...new Map(touches.map(([, h]) => [h.i, h])).values()];
        await locator.selectOption(retenues.map(h => ({ index: h.i })), { timeout });
        return { value: retenues.map(h => h.value).join(','), label: retenues.map(h => h.label).join(', '), index: retenues[0].i,
                 values: retenues.map(h => h.value), labels: retenues.map(h => h.label) };
    }
    const seule = liste ? { [champ]: liste[0] } : { option_value, option_label, value, text };
    const hit = trouver(seule);
    if (!hit) throw absente(seule.option_value || seule.option_label || seule.value || seule.text || '(none)');
    await locator.selectOption({ index: hit.i }, { timeout });
    return { value: hit.value, label: hit.label, index: hit.i };
}

// URL de l'onglet après un goto en échec, une fois engagée la page d'erreur du navigateur (1 s au plus).
export async function urlApresEchec(page, avant) {
    const fin = Date.now() + 1000;
    for (;;) {
        let url;
        try { url = page.url(); } catch (_) { return avant; }
        if (url !== avant || Date.now() >= fin) return url;
        await new Promise(r => setTimeout(r, 25));
    }
}

// Retour à la page d'avant un goto en échec, une fois chargée la page d'erreur du navigateur : URL finale de l'onglet.
export async function revenirApresEchec(page, urlErreur, echeance) {
    await page.waitForLoadState('load', { timeout: 1000 }).catch(() => {});
    const delai = Math.max(1000, Math.min(15000, echeance - Date.now()));
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: delai })
        .catch((e) => console.warn(`[goto] retour après l'échec : ${String(e.message).split('\n')[0]}`));
    return urlApresEchec(page, urlErreur);
}

export async function postActionWait(page, wait_after) {
    if (!wait_after) return;
    if (typeof wait_after === 'number') await page.waitForTimeout(wait_after);
    else if (wait_after === 'network') await Promise.race([page.waitForLoadState('networkidle').catch(() => {}), page.waitForTimeout(6000)]);
    else if (typeof wait_after === 'string' && wait_after.startsWith('selector:')) {
        const sel = wait_after.replace('selector:', '');
        await page.waitForSelector(sel, { state: 'visible', timeout: 12000 }).catch(() => {});
    } else if (typeof wait_after === 'string' && wait_after.startsWith('text:')) {
        const txt = wait_after.replace('text:', '');
        await page.waitForFunction(t => document.body.textContent.includes(t), txt, { timeout: 12000 }).catch(() => {});
    }
}

// ── Déplier / replier un nœud d'arbre ───────────────────────────────
// Un clic simple sur un treeitem GWT (CellTree) SÉLECTIONNE sans déplier :
// mesuré `click role=treeitem|name=Tables → success, expanded:false`. On
// essaie ce qu'un humain ferait, dans l'ordre, et on VÉRIFIE l'état après
// chaque geste : l'icône de bascule, le clavier (ArrowRight/ArrowLeft —
// CellTree comme tout arbre ARIA), le double-clic, le clic.
async function readExpanded(locator) {
    return locator.evaluate(el => {
        const a = el.getAttribute('aria-expanded');
        if (a !== null) return a === 'true';
        const cls = typeof el.className === 'string' ? el.className : '';
        if (/(^|\s)[\w-]*(open|expanded)[\w-]*(\s|$)/i.test(cls)) return true;
        if (/(^|\s)[\w-]*(closed|collapsed)[\w-]*(\s|$)/i.test(cls)) return false;
        return null;
    }).catch(() => null);
}
export async function expandTreeItem(page, locator, wantOpen, timeout) {
    const before = await readExpanded(locator);
    if (before === wantOpen) return { expanded_before: before, expanded: before, method: 'noop', attempts: [] };
    const t = Math.min(timeout || 5000, 5000);
    const gestures = [
        ['toggle', async () => {
            const tg = locator.locator('img, svg, [class*="Image"], [class*="image"], [class*="toggle"], [class*="Toggle"], [class*="caret"], [class*="expand"], [class*="arrow"], [class*="twist"]').first();
            if ((await tg.count().catch(() => 0)) === 0) throw new Error('no toggle child');
            await tg.click({ timeout: t });
        }],
        ['keyboard', async () => {
            await locator.focus({ timeout: t }).catch(() => locator.click({ timeout: t }));
            await page.keyboard.press(wantOpen ? 'ArrowRight' : 'ArrowLeft');
        }],
        ['dblclick', async () => locator.dblclick({ timeout: t })],
        ['click', async () => locator.click({ timeout: t })],
    ];
    const attempts = [];
    for (const [via, fn] of gestures) {
        try { await fn(); } catch (e) { attempts.push({ via, ok: false, error: String(e.message || e).slice(0, 80) }); continue; }
        await page.waitForTimeout(250);
        const now = await readExpanded(locator);
        attempts.push({ via, ok: now === wantOpen });
        if (now === wantOpen) return { expanded_before: before, expanded: now, method: via, attempts };
    }
    return { expanded_before: before, expanded: await readExpanded(locator), method: null, attempts,
             warning: 'state did not change — check with pw_page(action="inspect"), or navigate directly (goto …#!Page)' };
}

// ── Glisser-déposer ──────────────────────────────────────────────────
// dragTo (pointeur) d'abord ; s'il lève, événements HTML5 synthétiques avec
// un DataTransfer partagé (pages qui écoutent dragstart/drop sans suivre la
// souris). Sans destination : décalage en pixels.
async function html5DragDrop(srcLoc, dstLoc) {
    const dstHandle = await dstLoc.elementHandle({ timeout: 2000 }).catch(() => null);
    if (!dstHandle) return false;
    return srcLoc.evaluate((src, dst) => {
        const dt = new DataTransfer();
        const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
        fire(src, 'dragstart'); fire(dst, 'dragenter'); fire(dst, 'dragover'); fire(dst, 'drop'); fire(src, 'dragend');
        return true;
    }, dstHandle).catch(() => false);
}
export async function performDrag(ctx, page, srcLoc, body, timeout) {
    const { to, target_selector, dx, dy, direction, amount, human = false } = body || {};
    let dstLoc = null, dstVia = null;
    if (to && typeof to === 'object' && Object.values(to).some(v => v !== undefined && v !== null && v !== '')) {
        dstLoc = await locatorFromParams(ctx, page, to, null); dstVia = 'official';
    }
    if (!dstLoc && target_selector) {
        const r = await smartResolveLocator(page, target_selector).catch(() => null);
        if (r && r.locator) { dstLoc = r.locator; dstVia = `smart:${r.strategy || 'selector'}`; }
    }
    if (dstLoc) {
        const sb = await srcLoc.boundingBox().catch(() => null);
        const db = await dstLoc.boundingBox().catch(() => null);
        if (human && sb && db) {
            await humanMouseMove(page, 960, 540, sb.x + sb.width / 2, sb.y + sb.height / 2);
            await page.mouse.down();
            await humanMouseMove(page, sb.x + sb.width / 2, sb.y + sb.height / 2, db.x + db.width / 2, db.y + db.height / 2);
            await page.mouse.up();
            return { method: 'human-drag', destination: dstVia };
        }
        let dragErr = null;
        try { await srcLoc.dragTo(dstLoc, { timeout }); }
        catch (e) { dragErr = String(e.message || e).slice(0, 120); }
        if (!dragErr) return { method: 'dragTo', destination: dstVia };
        if (await html5DragDrop(srcLoc, dstLoc)) return { method: 'html5-events', destination: dstVia, dragto_error: dragErr };
        throw new Error(`drag failed: ${dragErr}`);
    }
    let ddx = dx, ddy = dy;
    const noXY = (ddx === undefined || ddx === null) && (ddy === undefined || ddy === null);
    if (noXY && (direction || amount !== undefined)) {
        const amt = amount === undefined ? 100 : Number(amount);
        const map = { down: [0, amt], up: [0, -amt], right: [amt, 0], left: [-amt, 0] };
        [ddx, ddy] = map[direction || 'right'] || [amt, 0];
    }
    if ((ddx === undefined || ddx === null) && (ddy === undefined || ddy === null))
        throw new Error('drag needs a destination (to=/target_selector=) or an offset (direction=/amount=, dx/dy)');
    const box = await srcLoc.boundingBox();
    if (!box) throw new Error('drag source has no bounding box (hidden?)');
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy); await page.mouse.down();
    await page.mouse.move(cx + (ddx || 0), cy + (ddy || 0), { steps: 15 }); await page.mouse.up();
    return { method: 'offset', dx: ddx || 0, dy: ddy || 0 };
}
