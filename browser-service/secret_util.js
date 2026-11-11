// SPDX-License-Identifier: MIT
// browser-service/secret_util.js — connexion avec un secret du coffre : formes encodées du mot de passe (garde réseau, purge des sorties de /login), contrôle et détection des champs, saisie.

const LONGUEUR_MIN_PURGE = 3;
const MASQUE = '[secret]';
const TYPES_IDENTIFIANT = new Set(['text', 'email', 'tel', 'url', 'search', 'number']);

/** `scheme://host[:port]` d'une adresse http(s) (WHATWG), `null` sinon (about:, data:, srcdoc, origine opaque). */
export function origineDe(adresse) {
    if (typeof adresse !== 'string' || !adresse.trim() || !URL.canParse(adresse.trim())) return null;
    const u = new URL(adresse.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin === 'null' ? null : u.origin;
}

/** Erreur codée d'une connexion : code stable, statut HTTP et champs joints à la réponse. */
export function erreurSecret(code, message, statut = 403, details = null) {
    const e = new Error(message);
    e.code = code;
    e.statut = statut;
    if (details) e.details = details;
    return e;
}

// ── Formes du mot de passe et purge ─────────────────────────────────────

/** Formes sous lesquelles une valeur peut revenir : brute, URL, formulaire, HTML (entités, texte et attribut sérialisés), JSON, base64 (trois variantes), hexadécimal. */
export function formesSecret(v) {
    if (typeof v !== 'string' || v.length < LONGUEUR_MIN_PURGE) return [];
    const octets = Buffer.from(v, 'utf8');
    const b64 = octets.toString('base64');
    const out = new Set([v, b64, b64.replace(/=+$/, ''), octets.toString('base64url'), octets.toString('hex')]);
    try {
        const url = encodeURIComponent(v);
        out.add(url);
        out.add(url.replaceAll('%20', '+'));
        out.add(new URLSearchParams({ x: v }).toString().slice(2));
        out.add(encodeURI(v));
    } catch {}
    out.add(v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'));
    out.add(v.replaceAll('&', '&amp;').replaceAll('\u00a0', '&nbsp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'));
    out.add(v.replaceAll('&', '&amp;').replaceAll('\u00a0', '&nbsp;').replaceAll('"', '&quot;'));
    out.add(JSON.stringify(v).slice(1, -1));
    return [...out].filter((x) => x.length >= LONGUEUR_MIN_PURGE).sort((a, b) => b.length - a.length);
}

// Chaîne purgée des seules occurrences ENTIÈRES d'une forme : un morceau n'est jamais masqué (le masquage partiel ferait un oracle sur un texte fourni).
function purgerChaine(s, formes) {
    let t = s;
    for (const f of formes) if (t.includes(f)) t = t.split(f).join(MASQUE);
    return t;
}

/** Texte purgé des `formes` (adresse, titre, message, ligne de journal), à appeler AVANT toute coupure ; tel quel sans formes. */
export function purgerTexte(texte, formes) {
    const s = typeof texte === 'string' ? texte : String(texte ?? '');
    return formes && formes.length ? purgerChaine(s, formes) : s;
}

/** Corps et en-têtes d'une requête Playwright en un texte ; vide s'ils ne sont pas lisibles. */
export function chargeRequete(rq) {
    try { return [rq.postData() || '', ...Object.values(rq.headers())].join('\n'); } catch (e) { return ''; }
}

/** Une requête sortante porte-t-elle l'une des formes (adresse, corps ou en-têtes) ? */
export function requetePorteSecret(url, corps, formes) {
    for (const f of formes) if ((url && url.includes(f)) || (corps && corps.includes(f))) return true;
    return false;
}

// ── Champs de connexion ─────────────────────────────────────────────────

/** Élément unique parmi les VISIBLES (`nth` compte parmi eux) ; poignée à libérer par l'appelant. */
export async function choisirVisible(candidats, { timeout, nth = null, quoi = 'target' }) {
    const visibles = candidats.filter({ visible: true });
    let n = await visibles.count().catch(() => 0);
    for (const fin = Date.now() + Math.min(timeout, 1500); n === 0 && Date.now() < fin; ) {
        await new Promise((r) => setTimeout(r, 150));
        n = await visibles.count().catch(() => 0);
    }
    if (n === 0) throw erreurSecret('secret_target_required', `No visible element matches the ${quoi}: a field hidden by CSS is not a valid target.`, 400,
        { fix: 'Target the element displayed on screen (label, placeholder, role and name, or a ref from pw_find).' });
    if (n > 1 && nth === null) throw erreurSecret('secret_target_required', `${n} visible elements match the ${quoi}: refused.`, 400,
        { fix: 'Narrow the target (label, placeholder, nth=K or a ref from pw_find).' });
    if (nth !== null && nth >= n) throw erreurSecret('secret_target_required', `nth=${nth} but only ${n} visible element(s) match the ${quoi}.`, 400);
    const h = await (nth === null ? visibles.first() : visibles.nth(nth)).elementHandle({ timeout });
    if (!h) throw erreurSecret('secret_target_required', `The ${quoi} disappeared before it could be checked.`, 400);
    return h;
}

/** Contrôle d'un champ avant tout secret, sans valeur : origine http(s) de son frame, partagée par chaque frame parent jusqu'à la page, type réel, éditable, opaque. Rend l'origine. */
export async function controlerPoignee(h, champ) {
    const frame = await h.ownerFrame();
    const origine = frame ? origineDe(frame.url()) : null;
    if (!origine) throw erreurSecret('secret_scope_mismatch', "The field's frame has no http(s) origin (about:blank, srcdoc, data:…): input refused.", 403);
    for (let f = frame.parentFrame(); f; f = f.parentFrame())
        if (origineDe(f.url()) !== origine)
            throw erreurSecret('secret_scope_mismatch', `The field's frame is embedded in a page of another origin (${origineDe(f.url()) || 'not http(s)'}): input refused.`, 403);
    const info = await h.evaluate((el) => {
        let opacite = 1;
        for (let n = el; n && n.nodeType === 1; n = n.parentElement || (n.getRootNode() && n.getRootNode().host) || null)
            opacite *= parseFloat(getComputedStyle(n).opacity) || 0;
        return {
            input: el instanceof HTMLInputElement, area: el instanceof HTMLTextAreaElement,
            type: el instanceof HTMLInputElement ? el.type : null,
            ecriture: (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.disabled && !el.readOnly,
            opacite,
        };
    });
    if (info.opacite < 0.05) throw erreurSecret('secret_target_required', 'The field is transparent: an invisible field is not a valid target for a secret.', 400);
    if (!info.ecriture) throw erreurSecret('secret_target_required', 'The field is not an editable input (disabled, read-only or not a form field).', 400);
    if (champ === 'password' && !(info.input && info.type === 'password'))
        throw erreurSecret('secret_target_required', 'A password can only be typed into an <input type="password"> field.', 400);
    if (champ === 'username' && !(info.area || (info.input && TYPES_IDENTIFIANT.has(info.type))))
        throw erreurSecret('secret_target_required', 'A username is typed into a text field (text, email, tel, url, search, number) or a text area.', 400);
    return origine;
}

/** Cible explicite contrôlée : un seul élément visible, puis `controlerPoignee`. Rend `{ h, origine }` ; la poignée est à libérer. */
export async function controlerChamp(candidats, { champ, timeout, nth = null }) {
    const h = await choisirVisible(candidats, { timeout, nth, quoi: `${champ} target` });
    try {
        return { h, origine: await controlerPoignee(h, champ) };
    } catch (e) {
        await h.dispose().catch(() => {});
        throw e;
    }
}

/** Formulaire englobant (ou formaction du bouton) : ni GET explicite, ni autre origine que `origine` ; lu sans propriété écrasable par un champ nommé. */
export async function verifierFormulaire(h, origine) {
    const f = await h.evaluate((el) => {
        const attr = (n, a) => Element.prototype.getAttribute.call(n, a);
        const form = el instanceof HTMLInputElement || el instanceof HTMLButtonElement || el instanceof HTMLTextAreaElement ? el.form : null;
        const actionForm = form ? Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'action').get.call(form) : '';
        const fa = attr(el, 'formaction');
        let action = null;
        try { action = new URL(fa ? fa : (actionForm || location.href), document.baseURI).origin; } catch { action = null; }
        return { form: Boolean(form), methode: String(attr(el, 'formmethod') || (form ? attr(form, 'method') : '') || '').toLowerCase(), action };
    });
    if (!f.form && !f.methode) return;
    if (f.methode && f.methode !== 'post')
        throw erreurSecret('secret_scope_mismatch', 'Submitting this form would not be a POST: the secret would end up in an address.', 403,
            { fix: 'This page does not log in through a POST form: ask the user for another way to log in.' });
    if (f.action !== origine)
        throw erreurSecret('secret_scope_mismatch', `The form posts to another origin (${f.action || 'unreadable'}) than the field's (${origine}): refused.`, 403);
}

/** Saisit la valeur (`fill`) puis, pour le mot de passe, revérifie dans la page sans rien en rendre : type, champ actif, longueur saisie ; sinon champ vidé et refus. */
export async function remplirChamp(h, valeur, { champ, timeout, delaiAvant = Infinity }) {
    const reste = delaiAvant - Date.now();
    if (reste < 300) throw erreurSecret('secret_login_failed', 'Login deadline reached before input: nothing was typed.', 408);
    await h.fill(valeur, { timeout: Math.min(timeout, reste) });
    if (champ !== 'password') return;
    const etat = await h.evaluate((el, n) => ({
        type: el instanceof HTMLInputElement ? el.type : 'other',
        actif: el.getRootNode().activeElement === el,
        longueur: typeof el.value === 'string' && el.value.length === n,
    }), valeur.length).catch(() => ({ type: 'other' }));
    if (etat.type === 'password' && etat.actif && etat.longueur) return;
    await viderChamp(h);
    throw erreurSecret('secret_target_required', etat.type !== 'password'
        ? 'The field changed type during input: value cleared, login refused.'
        : 'The password field lost focus or did not keep the typed value (length limit, script): value cleared, login refused.', 400);
}

/** Bouton par défaut du formulaire du champ (celui qu'Entrée déclenche sans submit_target) : ni formmethod autre que POST, ni formaction d'une autre origine. */
export async function verifierBoutonParDefaut(h, origine) {
    const b = await h.evaluate((el) => {
        const attr = (n, a) => Element.prototype.getAttribute.call(n, a);
        const form = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.form : null;
        if (!form) return null;
        const els = Array.from(Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'elements').get.call(form));
        const bouton = els.find((e) => (e instanceof HTMLButtonElement && e.type === 'submit') || (e instanceof HTMLInputElement && ['submit', 'image'].includes(e.type)));
        if (!bouton) return null;
        const fa = attr(bouton, 'formaction');
        let action = null;
        try { action = fa ? new URL(fa, document.baseURI).origin : null; } catch { action = 'unreadable'; }
        return { methode: String(attr(bouton, 'formmethod') || '').toLowerCase(), action };
    });
    if (!b) return;
    if (b.methode && b.methode !== 'post')
        throw erreurSecret('secret_scope_mismatch', "The form's default button would not submit with POST: the secret would end up in an address.", 403);
    if (b.action && b.action !== origine)
        throw erreurSecret('secret_scope_mismatch', `The form's default button posts to another origin (${b.action}) than the field's (${origine}): refused.`, 403);
}

/** Vide un champ (échec de connexion) ; sans erreur s'il a disparu. */
export async function viderChamp(h) {
    await h.evaluate((el) => { if ('value' in el) el.value = ''; }).catch(() => {});
}

/** Description d'un champ sans sa valeur : balise, type, name, id, autocomplete, libellé. */
export async function decrireChamp(h) {
    return h.evaluate((el) => {
        const net = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        const labels = el.labels ? Array.from(el.labels).map((l) => l.textContent).join(' ') : '';
        return {
            tag: el.tagName.toLowerCase(), type: el instanceof HTMLInputElement ? el.type : '',
            name: net(el.getAttribute('name')), id: net(el.id), autocomplete: net(el.getAttribute('autocomplete')),
            label: net(el.getAttribute('aria-label') || labels || el.getAttribute('placeholder')),
        };
    }).catch(() => ({}));
}

// Poignées des éléments visibles d'un sélecteur, sur tous les frames de la page.
async function visiblesPartout(page, selecteur) {
    const out = [];
    for (const f of page.frames()) {
        if (f.isDetached()) continue;
        const loc = f.locator(selecteur).filter({ visible: true });
        const n = Math.min(await loc.count().catch(() => 0), 10);
        for (let i = 0; i < n; i++) {
            const h = await loc.nth(i).elementHandle({ timeout: 1000 }).catch(() => null);
            if (h) out.push(h);
        }
    }
    return out;
}

// Nombre d'éléments visibles d'un sélecteur sur tous les frames, sans poignée.
async function compteVisibles(page, selecteur) {
    let n = 0;
    for (const f of page.frames()) if (!f.isDetached()) n += await f.locator(selecteur).filter({ visible: true }).count().catch(() => 0);
    return n;
}

// Candidats du même formulaire que `ref` quand `ref` en a un ; sinon la liste telle quelle.
async function memeFormulaire(liste, ref) {
    if (!ref) return liste;
    const formRef = await ref.evaluateHandle((el) => el.form || null).catch(() => null);
    if (!formRef || !formRef.asElement()) { if (formRef) await formRef.dispose().catch(() => {}); return liste; }
    const gardes = [];
    for (const h of liste) if (await h.evaluate((el, f) => el.form === f, formRef).catch(() => false)) gardes.push(h);
    await formRef.dispose().catch(() => {});
    return gardes;
}

// Champ texte, e-mail ou téléphone visible et éditable qui précède le mot de passe dans son formulaire ; null sans formulaire.
async function precedentDansFormulaire(mdp) {
    const r = await mdp.evaluateHandle((pw) => {
        const form = pw.form;
        if (!form) return null;
        const els = Array.from(Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'elements').get.call(form));
        const vu = (el) => { const b = el.getBoundingClientRect(); const st = getComputedStyle(el); return b.width > 0 && b.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
        for (let j = els.indexOf(pw) - 1; j >= 0; j--) {
            const el = els[j];
            if (el instanceof HTMLInputElement && ['text', 'email', 'tel'].includes(el.type) && !el.disabled && !el.readOnly && vu(el)) return el;
        }
        return null;
    }).catch(() => null);
    const el = r && r.asElement();
    if (!el && r) await r.dispose().catch(() => {});
    return el || null;
}

// Choix parmi des candidats : un seul → lui, aucun → null, plusieurs → secret_target_required avec leur description.
async function unSeul(champ, liste, autres) {
    if (liste.length <= 1) { for (const h of autres) await h.dispose().catch(() => {}); return liste[0] || null; }
    const candidates = [];
    for (const h of liste.slice(0, 5)) candidates.push(await decrireChamp(h));
    for (const h of [...liste, ...autres]) await h.dispose().catch(() => {});
    throw erreurSecret('secret_target_required', `${liste.length} visible ${champ} fields could be the login field: pass ${champ}_target.`, 400, { field: champ, candidates });
}

/** Champs trouvés sans cible (tous frames) : mot de passe current-password ou seul visible, identifiant username, email ou texte qui le précède dans son formulaire ; ambiguïté → secret_target_required. */
export async function detecterChamps(page, { champs = ['username', 'password'], timeout = 1500 } = {}) {
    const veut = new Set(champs);
    const NON_MDP = ':not([type=password i]):not([type=hidden i])';
    const MOTIFS_IDENTIFIANT = [`input[autocomplete~=username i]${NON_MDP}`, `input[autocomplete~=email i]${NON_MDP}`];
    const UN_CHAMP = ['input[type=password i]', ...MOTIFS_IDENTIFIANT].join(', ');
    for (const fin = Date.now() + Math.min(timeout, 2000); Date.now() < fin && !(await compteVisibles(page, UN_CHAMP)); )
        await new Promise((r) => setTimeout(r, 200));
    let p = await visiblesPartout(page, 'input[type=password i][autocomplete~=current-password i]');
    if (!p.length) p = await visiblesPartout(page, 'input[type=password i]:not([autocomplete~=new-password i])');
    if (!veut.has('password') && p.length > 1) { for (const h of p) await h.dispose().catch(() => {}); p = []; }
    const password = await unSeul('password', p, []);
    let username = null;
    try {
        if (veut.has('username')) {
            for (const motif of MOTIFS_IDENTIFIANT) {
                const tous = await visiblesPartout(page, motif);
                const gardes = await memeFormulaire(tous, password);
                if (!gardes.length) { for (const h of tous) await h.dispose().catch(() => {}); continue; }
                username = await unSeul('username', gardes, tous.filter((h) => !gardes.includes(h)));
                break;
            }
            if (!username && password) username = await precedentDansFormulaire(password);
        }
    } catch (e) {
        if (password) await password.dispose().catch(() => {});
        throw e;
    }
    if (password && !veut.has('password')) { await password.dispose().catch(() => {}); return { username, password: null }; }
    return { username, password };
}
