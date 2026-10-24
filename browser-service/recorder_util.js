// SPDX-License-Identifier: MIT
/** browser-service/recorder_util.js — recorder : valeurs des champs secrets remplacées par une variable d'environnement (une par champ), secrets retirés des évaluations et des URL, évaluations notées sans être rejouées. */

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

/** Script d'une évaluation en une ligne de commentaire sûre (retours à la ligne aplatis, 120 caractères au plus). */
export function commentaireEval(script) {
    const ligne = String(script ?? '').replace(/[\r\n\u2028\u2029\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    return ligne.length > 120 ? `${ligne.slice(0, 117)}...` : ligne;
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
    return { secret_variables: secrets, notes };
}
