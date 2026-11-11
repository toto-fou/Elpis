// SPDX-License-Identifier: MIT
/** browser-service/recorder_util.js — recorder : valeurs des champs secrets remplacées par une variable d'environnement (une par champ), secrets retirés des évaluations et des URL, évaluations notées sans être rejouées, gestes dans des <iframe> rejoués dans leur cadre. */

const MOTS_SECRETS = [
    [/pass(?:word|wd|phrase|code)?(?![a-z])|passw|pwd|mot.?de.?passe|kennwort|contrase/i, 'PASSWORD'],
    [/(?<![a-z])otp(?![a-z])|one.?time|totp|2fa|mfa|verif\w*.?code/i, 'OTP'],
    [/api.?key/i, 'API_KEY'],
    [/token/i, 'TOKEN'],
    [/secret/i, 'SECRET'],
    [/(?<![a-z])pin(?![a-z])|pin.?code/i, 'PIN'],
    [/(?<![a-z])(?:cvc|cvv)(?![a-z])|security.?code|card.?code/i, 'CARD_CVC'],
];

/** Variable d'environnement d'un champ secret (`type=password`, ou nom, id, libellé, indice qui évoque un secret), `null` sinon. */
export function variableSecrete(champ = {}, indices = []) {
    const sources = [champ.name, champ.id, champ.autocomplete, champ.label, champ.labels, champ.placeholder, ...indices]
        .filter((v) => typeof v === 'string' && v);
    for (const s of sources) for (const [motif, nom] of MOTS_SECRETS) if (motif.test(s)) return nom;
    return String(champ.type || '').toLowerCase() === 'password' ? 'PASSWORD' : null;
}

// Champ désigné par ses attributs (id, nom, libellé), sinon par la cible du geste : la même clé pour le même champ.
function cleChamp(evt, champ) {
    for (const k of ['id', 'name', 'labels', 'label', 'placeholder']) if (typeof champ[k] === 'string' && champ[k]) return `${k}=${champ[k]}`;
    return `cible=${JSON.stringify(evt.locator || {})}|${evt.selector || ''}|${evt.ref || ''}`;
}

/** Variable propre à un champ : la famille (`PASSWORD`) au premier champ, `PASSWORD_2`, `PASSWORD_3`… aux suivants, la même pour un champ déjà vu. */
export function variablePourChamp(famille, cle, variables = null) {
    if (!variables) return famille;
    const k = `${famille}\u0000${cle}`;
    if (!variables.has(k)) {
        const prises = new Set(variables.values());
        let nom = famille;
        for (let i = 2; prises.has(nom); i++) nom = `${famille}_${i}`;
        variables.set(k, nom);
    }
    return variables.get(k);
}

/** Événement `fill`/`type` d'un champ secret : valeur retirée, `secret` = nom de la variable (une par champ si `variables` est fourni) qui la remplacera au rejeu. */
export function masquerSecret(evt, champ = {}, variables = null) {
    const l = evt.locator || {};
    const famille = variableSecrete(champ, [l.name, l.label, l.placeholder, l.test_id, l.css, l.xpath, evt.selector]);
    if (!famille) return evt;
    const { value: _valeur, text: _texte, ...reste } = evt;
    return { ...reste, secret: variablePourChamp(famille, cleChamp(evt, champ || {}), variables) };
}

const LITTERAUX = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const SAISIE_DANS_SCRIPT = new RegExp(String.raw`\.value\s*\+?=(?!=)|\b(?:fill|type|insertText|setRangeText|sendKeys|setValue|execCommand)\s*\(|`
    + String.raw`pass(?:word|wd|phrase)?|pwd|secret|token|api.?key|(?<![a-z])(?:otp|pin|cvc|cvv)(?![a-z])|auth|session|credential|bearer`, 'i');

// Au-delà, un script qui saisit ou cite un secret est masqué en entier : LITTERAUX est quadratique sur un littéral non fermé.
const MAX_SCRIPT_MASQUE = 8192;

/** Script d'une évaluation sans secret : s'il saisit une valeur (`.value =`, `fill(`, `type(`…) ou cite un secret, ses littéraux et la valeur affectée deviennent `***`. */
export function masquerScript(script) {
    const s = String(script ?? '');
    if (!SAISIE_DANS_SCRIPT.test(s)) return s;
    if (s.length > MAX_SCRIPT_MASQUE) return "'***'";
    return s.replace(LITTERAUX, "'***'").replace(/(\.value\s*\+?=(?!=)\s*)[\w.$-]+/g, '$1***');
}

const PARAMS_SECRETS = /auth(?!or)|(?<![a-z])(?:code|key|sig|sid|jwt)(?![a-z])|session|sessid|signature|credential|ticket|saml/i;
const estParamSecret = (nom) => MOTS_SECRETS.some(([motif]) => motif.test(nom)) || PARAMS_SECRETS.test(nom);

/** URL sans identifiants (`user:pass@`) ni valeur de paramètre sensible (requête et fragment : token, key, password, secret, auth, code, session…), remplacés par `***`. */
export function masquerUrl(url) {
    if (typeof url !== 'string' || !url) return url;
    let u;
    try { u = new URL(url); } catch (_) { return url; }
    let change = false;
    if (u.username || u.password) { u.username = ''; u.password = ''; change = true; }
    const masquer = (params) => {
        let touche = false;
        for (const nom of new Set(params.keys())) if (estParamSecret(nom)) { params.set(nom, '***'); touche = true; }
        return touche;
    };
    if (masquer(u.searchParams)) change = true;
    if (u.hash.includes('=')) {
        const fragment = new URLSearchParams(u.hash.slice(1));
        if (masquer(fragment)) { u.hash = fragment.toString(); change = true; }
    }
    return change ? u.href : url;
}

/** Script d'une évaluation en une ligne de commentaire sûre (retours à la ligne et caractères de contrôle aplatis, 120 caractères au plus). */
export function commentaireEval(script) {
    const ligne = String(script ?? '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
    return ligne.length > 120 ? `${ligne.slice(0, 117)}...` : ligne;
}

/** Cellule Robot Framework rejouée telle quelle : blancs (hors espace simple) et contrôles codés \uXXXX, rien ne coupe la ligne ni la cellule ; \ $ @ & % * # = | échappés ; vide = ${EMPTY}. */
export function celluleRobot(v) {
    const s = String(v ?? '').replace(/[\\$@&%#=|*]/g, '\\$&')
        .replace(/[^\S ]|[\x00-\x1f\x7f-\x9f]|^ | $| (?= )/gu, (c) => `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`);
    return s || '${EMPTY}';
}

/** Notes du script : variables secrètes à fournir, évaluations non rejouées, URL masquées. */
export function notesDuScript(events) {
    const secrets = [...new Set(events.filter((e) => e.secret).map((e) => e.secret))].sort();
    const evals = events.filter((e) => e.action === 'eval').length;
    const urls = events.filter((e) => e.action === 'goto' && e.url_masked).length;
    const notes = [];
    if (secrets.length)
        notes.push(`Secret values were not recorded: set ${secrets.join(', ')} in the environment before replaying.`);
    if (evals)
        notes.push(`${evals} eval call(s) kept as comments, not replayed: arbitrary page scripts are not user gestures; port them by hand if the test needs them.`);
    if (urls)
        notes.push(`${urls} goto URL(s) had credentials or sensitive parameters replaced by ***: put the real values back before replaying.`);
    const envois = [...new Set(events.filter((e) => e.action === 'upload').flatMap((e) => e.files || []))];
    if (envois.length)
        notes.push(`Uploads are replayed by file name (${envois.join(', ')}): put these files where the test runs.`);
    return { secret_variables: secrets, notes };
}

/** Exécutée dans la page : sélecteur stable d'un élément (test id, rôle + nom, libellé, indice, texte, CSS), `null` si rien d'exploitable. */
export function decrireElement(el) {
    const txt = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test');
    if (testId) return { test_id: testId };
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const implicite = { button: 'button', a: el.hasAttribute('href') ? 'link' : '', select: 'combobox', textarea: 'textbox', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', img: 'img' }[tag]
        || (tag === 'input' ? ({ button: 'button', submit: 'button', reset: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox' }[type] || (['hidden', 'file', 'image', 'color', 'date', 'time'].includes(type) ? '' : 'textbox')) : '');
    const role = el.getAttribute('role') || implicite;
    const labels = Array.from(el.labels || []).map((l) => txt(l.textContent)).filter(Boolean);
    const aria = txt(el.getAttribute('aria-label'));
    const nomParContenu = ['button', 'link', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem', 'heading'];
    const contenu = ['button', 'a'].includes(tag) || nomParContenu.includes(role) || /^h[1-6]$/.test(tag) ? txt(el.innerText || el.textContent) : '';
    const valeur = tag === 'input' && ['button', 'submit', 'reset'].includes(type) ? txt(el.value) : '';
    const nom = aria || labels[0] || contenu || valeur || txt(el.getAttribute('title')) || txt(el.getAttribute('alt'));
    if (role && nom && nom.length <= 80) return { role, name: nom };
    if (labels[0] && labels[0].length <= 80) return { label: labels[0] };
    const indice = txt(el.getAttribute('placeholder'));
    if (indice) return { placeholder: indice };
    const direct = txt(Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' '));
    if (direct && direct.length <= 80) return { text: direct };
    const unique = (s) => { try { return document.querySelectorAll(s).length === 1; } catch (_) { return false; } };
    if (el.id && unique(`#${CSS.escape(el.id)}`)) return { css: `#${CSS.escape(el.id)}` };
    const nameAttr = el.getAttribute('name');
    if (nameAttr && unique(`${tag}[name="${CSS.escape(nameAttr)}"]`)) return { css: `${tag}[name="${CSS.escape(nameAttr)}"]` };
    const chemin = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
        const t = n.tagName.toLowerCase();
        if (n.id && unique(`#${CSS.escape(n.id)}`)) { chemin.unshift(`#${CSS.escape(n.id)}`); break; }
        const freres = n.parentElement ? Array.from(n.parentElement.children).filter((c) => c.tagName === n.tagName) : [n];
        chemin.unshift(freres.length > 1 ? `${t}:nth-of-type(${freres.indexOf(n) + 1})` : t);
    }
    return chemin.length ? { css: chemin.join(' > ') } : null;
}

/** Exécutée dans le document parent : sélecteur CSS d'une <iframe> qui la désigne seule (id, name, title, src, sinon chemin nth-of-type). */
export function selecteurCadre(el) {
    const unique = (s) => { try { return document.querySelectorAll(s).length === 1; } catch (_) { return false; } };
    const tag = el.tagName.toLowerCase();
    if (el.id && unique(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;
    for (const attr of ['name', 'title', 'src']) {
        const v = el.getAttribute(attr);
        if (v && v.length <= 200 && unique(`${tag}[${attr}="${CSS.escape(v)}"]`)) return `${tag}[${attr}="${CSS.escape(v)}"]`;
    }
    const chemin = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
        if (n.id && unique(`#${CSS.escape(n.id)}`)) { chemin.unshift(`#${CSS.escape(n.id)}`); break; }
        const freres = n.parentElement ? Array.from(n.parentElement.children).filter((c) => c.tagName === n.tagName) : [n];
        chemin.unshift(freres.length > 1 ? `${n.tagName.toLowerCase()}:nth-of-type(${freres.indexOf(n) + 1})` : n.tagName.toLowerCase());
    }
    return chemin.join(' > ');
}

/** Portée d'un geste enregistré dans des <iframe> (`frames`, de la page vers le cadre) : frameLocator chaînés (playwright), corps du document de chaque cadre (cypress), `>>>` (robot). */
export function porteeCadres(frames, fmt, echapper = (s) => s) {
    const f = Array.isArray(frames) ? frames.filter((x) => typeof x === 'string' && x) : [];
    if (fmt === 'playwright') return f.reduce((acc, s) => `${acc}.frameLocator('${echapper(s)}')`, 'page');
    if (fmt === 'cypress') {
        if (!f.length) return '';
        return f.map((s, i) => `${i ? '.find' : 'cy.get'}('${echapper(s)}').its('0.contentDocument.body').should('not.be.empty').then(cy.wrap)`).join('');
    }
    if (fmt === 'robot') return f.length ? `${f.join(' >>> ')} >>> ` : '';
    return '';
}
