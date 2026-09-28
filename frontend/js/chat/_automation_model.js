// SPDX-License-Identifier: MIT
/* ============================================================================
 * js/chat/_automation_model.js — modèle PUR (sans Vue) d'une AUTOMATISATION du
 * Studio + générateur de code Python (runtime ``elpis_auto`` de l'agent).
 *
 * Les ÉTAPES sont la source de vérité ; le code est une projection régénérée à
 * chaque changement. Exporté en CommonJS ET en globales navigateur (comme
 * _scenario_model.js, dont il réutilise les helpers d'action et d'attente).
 *
 * Forme d'un script :
 *   { version:2, name, target, os, monitor, params:[{name, value}], steps:[] }
 * Forme d'une étape (``kind``) :
 *   action  { op, anchor, args, expect?, timeout_ms?, retry?, on_error?, comment? }
 *   wait    { expect:{kind, query, anchor?, expected?, cmp?, state?, op?, count?}, timeout_ms? }
 *   check   { expect:{…}, timeout_ms? }          vérification qui compte (code 1)
 *   if      { cond:{type:'exists'|'missing'|'value'|'state'|'text', anchor?, query?, expected?, cmp?, state?} }
 *   else    {}
 *   end     {}                                   ferme le dernier if / loop
 *   loop    { times:n }
 *   focus   { window }                           fenêtre au premier plan (titre, regex)
 *   note    { text }
 *   var     { name, source:'value'|'clipboard'|'param', anchor?, key? }
 *   code    { text }                             Python libre (échappatoire)
 * ==========================================================================*/
(function (root) {
    "use strict";

    var DEFAULT_TIMEOUT_MS = 30000;
    var BLOCK_OPEN = { "if": true, "loop": true };
    var KINDS = ["action", "wait", "check", "if", "else", "end", "loop", "focus", "note", "var", "code"];

    function newAutomation(fields) {
        fields = fields || {};
        return {
            version: 2,
            name: fields.name || "",
            target: fields.target || "",
            os: fields.os || "",
            monitor: Number(fields.monitor || 0),
            timeout_s: Number(fields.timeout_s) > 0 ? Number(fields.timeout_s) : null,   // délai de séance (en-tête)
            params: Array.isArray(fields.params) ? fields.params.slice() : [],
            steps: Array.isArray(fields.steps) ? fields.steps.slice() : [],
            updated_at: fields.updated_at || null,
        };
    }

    // Étape depuis ce que le glue reçoit (pas d'action déjà normalisé par
    // _scenario_model : {op, anchor, args, expect?}) → kind 'action'.
    function actionStep(step) {
        var out = {};
        Object.keys(step || {}).forEach(function (k) { out[k] = step[k]; });
        out.kind = "action";
        return out;
    }

    function makeStep(kind, fields) {
        if (KINDS.indexOf(kind) < 0) throw new Error("kind inconnu : " + kind);
        var st = { kind: kind };
        Object.keys(fields || {}).forEach(function (k) { st[k] = fields[k]; });
        if (kind === "loop" && !(Number(st.times) > 0)) st.times = 3;
        if (kind === "if" && !st.cond) st.cond = { type: "exists", query: "" };
        if (kind === "var" && !st.name) st.name = "valeur";
        if (kind === "var" && !st.source) st.source = "value";
        return st;
    }

    // ── Blocs : profondeur d'affichage + validation ─────────────────────────
    // depths[i] = indentation de l'étape i ; else/end se dessinent au niveau du
    // bloc qu'ils ferment. Robuste : un end orphelin reste à 0.
    function blockDepths(steps) {
        var d = 0, out = [];
        (steps || []).forEach(function (st) {
            if (st.kind === "end" || st.kind === "else") d = Math.max(0, d - 1);
            out.push(d);
            if (BLOCK_OPEN[st.kind] || st.kind === "else") d++;
        });
        return out;
    }

    function validateBlocks(steps) {
        var stack = [], errors = [];
        (steps || []).forEach(function (st, i) {
            if (BLOCK_OPEN[st.kind]) stack.push({ kind: st.kind, i: i, hasElse: false });
            else if (st.kind === "else") {
                var top = stack[stack.length - 1];
                if (!top || top.kind !== "if") errors.push({ index: i, message: "« Sinon » sans « Si »" });
                else if (top.hasElse) errors.push({ index: i, message: "deux « Sinon » pour le même « Si »" });
                else top.hasElse = true;
            } else if (st.kind === "end") {
                if (!stack.length) errors.push({ index: i, message: "« Fin » sans bloc ouvert" });
                else stack.pop();
            }
        });
        stack.forEach(function (b) { errors.push({ index: b.i, message: (b.kind === "if" ? "« Si »" : "« Boucle »") + " jamais fermé (ajoute « Fin »)" }); });
        return { ok: errors.length === 0, errors: errors };
    }

    // ── Libellés ────────────────────────────────────────────────────────────
    function condLabel(cond) {
        cond = cond || {};
        var who = (cond.anchor && (cond.anchor.label || cond.anchor.auto_id)) || cond.query || "?";
        switch (cond.type) {
            case "missing": return "si « " + who + " » absent";
            case "value": return "si « " + who + " » " + (cond.cmp === "exact" ? "= " : "contient ") + "« " + (cond.expected || "") + " »";
            case "state": return "si « " + who + " » est " + (cond.state || "?");
            case "text": return "si le texte « " + (cond.query || "") + " » est visible";
            default: return "si « " + who + " » présent";
        }
    }

    function stepLabel(step) {
        if (!step) return "";
        var sumStep = (typeof root.summarizeStep === "function") ? root.summarizeStep
                    : (typeof summarizeStep === "function" ? summarizeStep : null);
        var sumExp = (typeof root.summarizeExpect === "function") ? root.summarizeExpect
                   : (typeof summarizeExpect === "function" ? summarizeExpect : null);
        switch (step.kind) {
            case "wait": return "attendre : " + (sumExp ? sumExp(step.expect, step.timeout_ms || DEFAULT_TIMEOUT_MS) : "");
            case "check": return "vérifier : " + (sumExp ? sumExp(step.expect, step.timeout_ms || DEFAULT_TIMEOUT_MS) : "");
            case "if": return condLabel(step.cond);
            case "else": return "sinon";
            case "end": return "fin";
            case "loop": return "répéter " + (step.times || 1) + " fois";
            case "focus": return "premier plan « " + (step.window || "") + " »";
            case "note": return "note : " + (step.text || "");
            case "var": return step.name + " ← " + (step.source === "clipboard" ? "presse-papiers" : step.source === "param" ? "paramètre " + (step.key || "") : "valeur de « " + ((step.anchor && step.anchor.label) || step.query || "?") + " »");
            case "code": return "code : " + String(step.text || "").split("\n")[0];
            default: return sumStep ? sumStep(step) : (step.op || "");
        }
    }

    // ── Génération Python ───────────────────────────────────────────────────
    function pyStr(s) {
        s = String(s == null ? "" : s);
        return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "").replace(/\t/g, "\\t") + '"';
    }
    function pyIdent(s) {
        var v = String(s || "valeur").replace(/[^A-Za-z0-9_]/g, "_");
        if (/^[0-9]/.test(v)) v = "_" + v;
        return v || "valeur";
    }

    // Qualité d'ancrage d'une cible : 'uia' (AutomationId exposé par l'appli),
    // 'nom' (libellé + rôle de l'arbre d'accessibilité), 'coords' (un point,
    // dernier recours), '' (pas de cible). Décide ce que le code contient.
    // 'chemin' = chemin structurel depuis un ancêtre nommé (élément SANS nom, ou
    // nom porté par plusieurs éléments) : toujours un contrôle exposé par Windows,
    // jamais un point. Un libellé fabriqué depuis le rôle (« group ») ne compte pas.
    function anchorQuality(anchor) {
        anchor = anchor || {};
        if (anchor.auto_id) return "uia";
        var name = anchor.label || anchor.query || "";
        if (name && anchor.role && name === anchor.role) name = "";
        if (name && anchor.source !== "vision" && !anchor.ambiguous) return "nom";
        if (anchor.path && anchor.source !== "vision") return "chemin";
        if (name && anchor.source !== "vision") return "nom";
        if (name) return "vision";
        var c = anchor.center;
        if ((Array.isArray(c) && c.length >= 2) || (anchor.x !== undefined && anchor.x !== null)) return "coords";
        return "";
    }

    // kwargs de ciblage depuis une ancre. RÈGLE : les éléments EXPOSÉS par
    // Windows (auto_id, puis nom + rôle a11y) d'abord ; les coordonnées ne
    // sortent dans le code qu'en DERNIER recours — un pur point, ou une box
    // venue de la vision seule (le libellé est alors une lecture, pas une
    // identité, on garde le point en repli).
    // Pile d'identités : l'identité PRINCIPALE (auto_id | nom+rôle | chemin), puis
    // les replis que le runtime essaiera dans l'ordre si elle casse — voisin nommé
    // (contrôle sans nom), vignette (image=), fenêtre + position relative. Jamais
    // un at= absolu pour un élément de l'arbre : seulement pour un point nu ou
    // une box de vision. ``opts.lean`` : l'identité principale seule (conditions courtes).
    function targetKwargs(anchor, opts) {
        anchor = anchor || {};
        opts = opts || {};
        var parts = [];
        var q = anchorQuality(anchor);
        var rel = function () {
            if (opts.lean) return;
            if (anchor.image) parts.push("image=" + pyStr(anchor.image));
            if (anchor.window && Array.isArray(anchor.rel) && anchor.rel.length >= 2) {
                parts.push("window=" + pyStr(anchor.window));
                parts.push("rel=(" + Number(anchor.rel[0]).toFixed(3) + ", " + Number(anchor.rel[1]).toFixed(3) + ")");
            }
        };
        if (q === "chemin") {
            parts.push("path=" + pyStr(anchor.path));
            if (!opts.lean && anchor.near) {
                parts.push("near=" + pyStr(anchor.near));
                if (anchor.role) parts.push("role=" + pyStr(anchor.role));
                if (anchor.side) parts.push("side=" + pyStr(anchor.side));
            }
            rel();
            return parts.join(", ");
        }
        if (anchor.auto_id) parts.push("auto_id=" + pyStr(anchor.auto_id));
        var name = anchor.label || anchor.query || "";
        if (name && anchor.role && name === anchor.role) name = "";   // libellé fabriqué : jamais une cible
        if (name) parts.push("name=" + pyStr(name));
        if (anchor.role && name) parts.push("role=" + pyStr(anchor.role));
        if (q === "coords" || q === "vision") {
            var c = anchor.center;
            if (Array.isArray(c) && c.length >= 2) parts.push("at=(" + Math.round(c[0]) + ", " + Math.round(c[1]) + ")");
            else if (anchor.x !== undefined && anchor.y !== undefined && anchor.x !== null) parts.push("at=(" + Math.round(anchor.x) + ", " + Math.round(anchor.y) + ")");
            return parts.join(", ");
        }
        rel();
        return parts.join(", ");
    }

    // Une ancre « utilisable » porte une identité : auto_id, nom réel ou chemin.
    function _usable(a) { return !!(a && (a.auto_id || a.label || a.path || a.near || a.image)); }

    // Délai de TOUT CE QUI ATTEND (wait.*, expect.*, launch avec fenêtre) : la variable
    // ``TIMEOUT`` déclarée en tête du script (valeur par défaut, modifiable à un seul
    // endroit). Une étape qui a besoin d'un délai différent porte sa valeur
    // (``timeout=120``) : ``timeout_ms`` renseigné = valeur propre, sinon la variable.
    var TIMEOUT_VAR = "TIMEOUT";
    function timeoutKw(ms) {
        var v = Number(ms);
        if (!isFinite(v) || v <= 0) return "timeout=" + TIMEOUT_VAR;
        return "timeout=" + (Math.round(v / 100) / 10);
    }
    function _fmtSec(sec) {
        var v = Number(sec);
        if (!isFinite(v) || v <= 0) v = DEFAULT_TIMEOUT_MS / 1000;
        return String(Math.round(v * 10) / 10);
    }
    // ``TIMEOUT = 30`` (nombre littéral, commentaire permis) sur SA ligne : c'est ce que le
    // champ « Délai » lit et réécrit. ``TIMEOUT = 2 * 60`` ou ``TIMEOUT = 1e3`` sont des
    // déclarations (le script est valide) mais pas un nombre éditable : le champ n'y touche pas.
    var TIMEOUT_RX = /^(TIMEOUT[ \t]*=[ \t]*)(\d+(?:\.\d+)?)([ \t]*(?:#.*)?)$/m;
    var TIMEOUT_DECL_RX = /^TIMEOUT[ \t]*(?::[^=\n]*)?=(?!=)/m;
    var TIMEOUT_COMMENT = "   # délai par défaut (s) de tout ce qui attend ; timeout=… sur une ligne pour la changer";
    // Valeur de ``TIMEOUT = N`` dans le code, ou null s'il n'y en a pas (ou si elle est calculée).
    function readTimeoutValue(code) {
        var m = TIMEOUT_RX.exec(String(code || ""));
        return m ? Number(m[2]) : null;
    }
    function timeoutDeclared(code) { return TIMEOUT_DECL_RX.test(String(code || "")); }
    // Le code SANS chaînes ni commentaires (chaînes vidées : « "" »), pour chercher un nom
    // ou un « : » de fin de ligne sans se faire piéger par « # » ou « TIMEOUT » dans un texte.
    function pyCodeOnly(code) {
        var s = String(code || ""), out = "", i = 0, n = s.length;
        while (i < n) {
            var ch = s[i];
            if (ch === "#") { while (i < n && s[i] !== "\n") i++; continue; }
            if (ch === '"' || ch === "'") {
                var q = s.substr(i, 3) === ch + ch + ch ? ch + ch + ch : ch;
                i += q.length;
                while (i < n) {
                    if (s[i] === "\\") { i += 2; continue; }
                    if (s.substr(i, q.length) === q) { i += q.length; break; }
                    if (q.length === 1 && s[i] === "\n") break;
                    i++;
                }
                out += '""';
                continue;
            }
            out += ch; i++;
        }
        return out;
    }
    // Le code se sert-il de la variable (hors chaînes et commentaires) ?
    function usesTimeoutVar(code) { return /\bTIMEOUT\b/.test(pyCodeOnly(code)); }
    // Garantit la variable : ``TIMEOUT = sec`` juste avant ``s = Session(``, et la séance
    // qui l'utilise (``Session(…, timeout=TIMEOUT)``). Un script d'avant la variable
    // (``Session(monitor=0, timeout=90)``) est converti EN GARDANT sa valeur (``TIMEOUT = 90``) ;
    // un délai calculé (``timeout=float(os.environ…)``) n'est pas touché ; un script qui
    // déclare déjà la variable est rendu tel quel. Pur.
    function ensureTimeoutVar(code, sec) {
        code = String(code || "");
        if (timeoutDeclared(code)) return code;
        var all = code.split("\n");
        var i = all.findIndex(function (l) { return /^s = Session\(/.test(l); });
        if (i < 0) {
            all.splice(headerEnd(all) + 1, 0, TIMEOUT_VAR + " = " + _fmtSec(sec) + TIMEOUT_COMMENT);
            return all.join("\n");
        }
        var line = all[i], lit = /\btimeout\s*=\s*(\d+(?:\.\d+)?)\s*(?=[,)])/.exec(line);
        if (lit) {
            sec = Number(lit[1]);
            line = line.replace(/\btimeout\s*=\s*\d+(?:\.\d+)?(?=\s*[,)])/, "timeout=" + TIMEOUT_VAR);
        } else if (!/\btimeout\s*=/.test(line)) {
            if (/\(\s*\)/.test(line)) line = line.replace(/\(\s*\)/, "(timeout=" + TIMEOUT_VAR + ")");
            else line = line.replace(/([^(\s])\s*\)(\s*(#.*)?)$/, "$1, timeout=" + TIMEOUT_VAR + ")$2");
        }
        all[i] = line;
        all.splice(i, 0, TIMEOUT_VAR + " = " + _fmtSec(sec) + TIMEOUT_COMMENT);
        return all.join("\n");
    }
    // Change la valeur par défaut (``TIMEOUT = sec``), en déclarant la variable si besoin.
    // Une déclaration calculée n'est pas réécrite (le code est rendu tel quel).
    function setTimeoutValue(code, sec) {
        code = String(code || "");
        if (TIMEOUT_RX.test(code)) return code.replace(TIMEOUT_RX, function (m, head, v, tail) { return head + _fmtSec(sec) + tail; });
        if (timeoutDeclared(code)) return code;
        return ensureTimeoutVar(code, sec);
    }
    function join(parts) { return parts.filter(function (p) { return p; }).join(", "); }

    function expectTarget(expect) {
        var a = expect.anchor || {};
        if (!a.label && !a.auto_id && expect.query) a = { label: expect.query, role: a.role };
        return targetKwargs(a, { lean: true });
    }

    // Lignes Python d'une attente/vérification (après une action, ou étape seule).
    function expectLines(expect, timeoutMs, asCheck) {
        expect = expect || {};
        var t = timeoutKw(timeoutMs), q = expect.query || "";
        var cmpKw = function () {
            var e = pyStr(expect.expected || "");
            if (expect.cmp === "exact") return "equals=" + e;
            if (expect.cmp === "regex" || expect.match) return "regex=" + e;
            return "contains=" + e;
        };
        switch (expect.kind) {
            case "none": return [];
            case "stable": return ["s.wait.stable(" + t + ")"];
            case "pause": return ["s.wait.seconds(" + (Math.round(Math.max(0, Number(timeoutMs) || 0) / 100) / 10) + ")"];
            case "window_ready": return ["s.wait.window(" + join([pyStr(q || "."), t]) + ")"];
            case "appear": return ["s.wait.appear(" + t + ")"];
            case "element": return ["s." + (asCheck ? "expect.exists" : "wait.element") + "(" + join([expectTarget(expect), t]) + ")"];
            case "element_gone": return ["s." + (asCheck ? "expect.gone" : "wait.gone") + "(" + join([expectTarget(expect), t]) + ")"];
            case "text": return ["s.wait.text(" + join([pyStr(q), t]) + ")   # vision : exige Elpis"];
            case "text_gone": return ["s.wait.text(" + join([pyStr(q), "gone=True", t]) + ")   # vision : exige Elpis"];
            case "value": return ["s.expect.value(" + join([expectTarget(expect), cmpKw(), t]) + ")"];
            case "value_gone": return ["s.expect.value(" + join([expectTarget(expect), cmpKw(), "negate=True", t]) + ")"];
            case "state": return ["s.expect.state(" + join([pyStr(expect.state || "enabled"), expectTarget(expect), t]) + ")"];
            case "count": return ["s.expect.count(" + join([
                "role=" + pyStr(expect.role || ""), q ? "contains=" + pyStr(q) : "",
                "op=" + pyStr(expect.op || "=="), "n=" + Number(expect.count || 0), t]) + ")"];
            default: return ["s.wait.stable(" + t + ")"];
        }
    }

    var _NEEDS_TARGET = ["click", "left_click", "invoke", "double_click", "triple_click", "right_click", "middle_click",
                         "set_value", "move", "drag", "toggle", "check", "uncheck", "select", "expand", "collapse", "scroll_into_view"];
    function actionLines(step) {
        var a = step.args || {}, an = step.anchor || {}, t = targetKwargs(an);
        var lines = [], op = step.op || "click";
        var ex = step.expect;
        var needSnapshot = ex && ex.kind === "appear";
        if (needSnapshot) lines.push("s.snapshot()");
        // Bouton et touches maintenues : portés par TOUTES les variantes de clic
        // (un « click » avec button="right" s'écrivait en clic gauche ; Ctrl+double-clic
        // perdait Ctrl).
        var mods = a.modifiers ? "modifiers=" + pyStr(a.modifiers) : "";
        var btnKw = function (dflt) { var b = String(a.button || dflt || "left").toLowerCase(); return b !== "left" ? "button=" + pyStr(b) : ""; };
        var clicksKw = function (dflt) { var c = Number(a.clicks) > 1 ? Number(a.clicks) : dflt; return c > 1 ? "clicks=" + c : ""; };
        if (!t && _NEEDS_TARGET.indexOf(op) >= 0) {
            // Cible perdue à l'enregistrement : une ligne vide de cible (« s.click() »)
            // échouait à coup sûr au rejeu. On l'écrit en COMMENTAIRE à compléter.
            return ["# s." + (op === "set_value" ? "set_value" : op.indexOf("click") >= 0 || op === "invoke" ? "click" : op)
                    + "(…)   # cible non retrouvée à l'enregistrement" + (an.id ? " (" + an.id + ")" : "") + " : à compléter"];
        }
        switch (op) {
            case "click": case "left_click": case "invoke":
                lines.push("s.click(" + join([t, btnKw(), clicksKw(1), mods]) + ")"); break;
            case "double_click": lines.push("s.click(" + join([t, btnKw(), clicksKw(2) || "clicks=2", mods]) + ")"); break;
            case "triple_click": lines.push("s.click(" + join([t, btnKw(), "clicks=3", mods]) + ")"); break;
            case "right_click": lines.push("s.click(" + join([t, 'button="right"', clicksKw(1), mods]) + ")"); break;
            case "middle_click": lines.push("s.click(" + join([t, 'button="middle"', clicksKw(1), mods]) + ")"); break;
            case "type": lines.push("s.type(" + pyStr(a.text || "") + ")"); break;
            case "paste": lines.push("s.paste(" + pyStr(a.text || "") + ")"); break;
            case "copy": lines.push("s.copy()"); break;
            case "key": case "hotkey": case "press": lines.push("s.key(" + pyStr(a.keys || "") + ")"); break;
            case "set_value": lines.push("s.set_value(" + join([pyStr(a.text || ""), t]) + ")"); break;
            case "scroll": lines.push("s.scroll(" + join([String(Number(a.dy || 0)), t]) + ")"); break;
            case "move": lines.push("s.move(" + t + ")"); break;
            case "drag": lines.push("s.drag(" + join(["to=(" + Math.round(a.x2 || 0) + ", " + Math.round(a.y2 || 0) + ")", t, a.modifiers ? "modifiers=" + pyStr(a.modifiers) : ""]) + ")"); break;
            case "launch":
                var win = (ex && ex.kind === "window_ready" && ex.query) ? ex.query : "";
                lines.push("s.launch(" + join([pyStr(a.app || a.target || an.query || ""), win ? "wait_window=" + pyStr(win) : "", timeoutKw(step.timeout_ms)]) + ")");
                // Attente portée par launch() ; sans titre, pas de « s.wait.window(".") »
                // qui reconnaissait N'IMPORTE quelle fenêtre et rendait la main aussitôt.
                if (ex && ex.kind === "window_ready") ex = null;
                break;
            case "toggle": case "check": case "uncheck": case "select": case "expand": case "collapse": case "scroll_into_view":
                lines.push("s." + op + "(" + t + ")"); break;
            default:
                lines.push("# opération inconnue : " + op); break;
        }
        // Réessais : kwarg de l'ACTION (le runtime rejoue l'action, pas le bloc).
        if (Number(step.retry) > 0) {
            var k = needSnapshot ? 1 : 0;
            if (lines[k] && /^s\.[a-z_]+\(/.test(lines[k])) {
                lines[k] = lines[k].replace(/\)$/, (lines[k].endsWith("()") ? "" : ", ") + "retry=" + Number(step.retry) + ")");
            }
        }
        if (ex && ex.kind && ex.kind !== "none") lines = lines.concat(expectLines(ex, step.timeout_ms, false));
        return lines;
    }

    function condExpr(cond) {
        // (les conditions restent lisibles : identité principale seule — cf. targetKwargs lean)
        cond = cond || {};
        var a = cond.anchor || {};
        if (!a.label && !a.auto_id && cond.query) a = { label: cond.query, role: a.role };
        var t = targetKwargs(a, { lean: true });
        switch (cond.type) {
            case "missing": return "not s.exists(" + t + ")";
            case "value":
                if (cond.cmp === "exact") return "s.value(" + t + ") == " + pyStr(cond.expected || "");
                return pyStr(cond.expected || "") + " in s.value(" + t + ")";
            case "state": return "s.state(" + join([pyStr(cond.state || "enabled"), t]) + ")";
            case "text": return "s.sees(" + pyStr(cond.query || "") + ")";
            default: return "s.exists(" + t + ")";
        }
    }

    function needsVision(steps) {
        return (steps || []).some(function (st) {
            var ex = st.expect || {};
            if (ex.kind === "text" || ex.kind === "text_gone") return true;
            if (st.kind === "if" && st.cond && st.cond.type === "text") return true;
            return false;
        });
    }

    // Le script complet. ``now`` (Date) injectable pour des tests déterministes.
    function automationToPython(script, now) {
        script = script || {};
        var steps = script.steps || [];
        var d = now || new Date();
        var stamp = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0")
                  + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
        var name = script.name || "automatisation";
        var out = [];
        out.push("# -*- coding: utf-8 -*-");
        // Docstring : « \U » d'un chemin Windows (« C:\Users ») ou « """ » dans le nom
        // rendaient le script invalide (SyntaxError avant la première ligne).
        var doc = function (v) { return String(v).replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"'); };
        out.push('"""' + doc(name) + " — généré par Elpis Studio le " + stamp + ".");
        out.push("Cible : " + doc(script.target || "?") + (script.os ? " (" + doc(script.os) + ")" : "") + ", écran " + Number(script.monitor || 0) + ".");
        out.push("Exécuter sur la machine cible : run-script.bat " + pyIdent(name) + ".py [--param=valeur ...]");
        out.push('"""');
        out.push("from elpis_auto import Session");
        out.push("");
        var vision = needsVision(steps);
        // ``TIMEOUT`` (s) = délai sans activité à l'écran de tout ce qui attend : les lignes
        // wait/expect/launch le reprennent (``timeout=TIMEOUT``), la séance aussi (un clic
        // qui attend sa cible). Une ligne qui a besoin d'autre chose porte sa valeur.
        // ``patience`` (plafond absolu, 120 s) se règle sur la séance : Session(…, patience=300).
        out.push(TIMEOUT_VAR + " = " + _fmtSec(script.timeout_s) + TIMEOUT_COMMENT);
        out.push("s = Session(" + join(["monitor=" + Number(script.monitor || 0),
                                        "timeout=" + TIMEOUT_VAR,
                                        vision ? 'needs=["vision"]' : ""]) + ")");
        var params = script.params || [];
        if (params.length) {
            out.push("p = s.params({" + params.map(function (p) { return pyStr(p.name) + ": " + pyStr(p.value == null ? "" : p.value); }).join(", ") + "})");
        }
        out.push("");

        var indent = 1;        // niveau 0 = module ; les étapes vivent au niveau 0 sauf dans un bloc
        var depth = 0;
        var pad = function (n) { return new Array(n + 1).join("    "); };
        var lastOpen = [];     // pile : l'étape a-t-elle un corps ? (sinon ``pass``)
        var emit = function (line) {
            out.push(line ? pad(depth) + line : "");
            if (lastOpen.length) lastOpen[lastOpen.length - 1] = true;
        };
        var openBlock = function (line) {
            out.push(pad(depth) + line);
            depth++;
            lastOpen.push(false);
        };
        var closeBlock = function () {
            if (!lastOpen.length) return false;
            if (!lastOpen[lastOpen.length - 1]) out.push(pad(depth) + "pass");
            lastOpen.pop();
            depth = Math.max(0, depth - 1);
            return true;
        };

        steps.forEach(function (st) {
            if (!st) return;
            if (st.comment) emit("# " + String(st.comment).replace(/\n/g, " "));
            switch (st.kind) {
                case "if": openBlock("if " + condExpr(st.cond) + ":"); break;
                case "else":
                    if (closeBlock()) openBlock("else:");
                    else emit("# « Sinon » sans « Si » — ignoré");
                    break;
                case "end":
                    if (!closeBlock()) emit("# « Fin » sans bloc ouvert — ignoré");
                    break;
                case "loop": openBlock("for _i in range(" + Math.max(1, Number(st.times || 1)) + "):"); break;
                case "focus": emit("s.focus(window=" + pyStr(st.window || "") + ")"); break;
                case "note": emit("s.note(" + pyStr(st.text || "") + ")"); break;
                case "wait": expectLines(st.expect, st.timeout_ms, false).forEach(emit); break;
                case "check": expectLines(st.expect, st.timeout_ms, true).forEach(emit); break;
                case "var":
                    if (st.source === "clipboard") emit(pyIdent(st.name) + " = s.copy()");
                    else if (st.source === "param") emit(pyIdent(st.name) + " = p[" + pyStr(st.key || st.name) + "]");
                    else emit(pyIdent(st.name) + " = s.value(" + targetKwargs(_usable(st.anchor) ? st.anchor : { label: st.query }, { lean: true }) + ")");
                    break;
                case "code":
                    String(st.text || "").split("\n").forEach(function (l) { emit(l); });
                    break;
                default: {
                    var lines = actionLines(st);
                    // ``continue`` = l'échec est journalisé puis avalé : un bloc with.
                    if (st.on_error === "continue") {
                        var label = stepLabel(st).replace(/"/g, "'");
                        openBlock("with s.step(" + join([pyStr(label), 'on_error="continue"']) + "):");
                        lines.forEach(emit);
                        closeBlock();
                    } else {
                        lines.forEach(emit);
                    }
                }
            }
        });
        while (lastOpen.length) { out.push(pad(depth) + "# bloc non fermé — fermé ici"); closeBlock(); }
        out.push("");
        out.push("raise SystemExit(s.finish())");
        out.push("");
        void indent;
        return out.join("\n");
    }

    // ── Le code comme DOCUMENT (édité à la main dans l'éditeur) ─────────────
    var FOOTER = "raise SystemExit(s.finish())";

    // Squelette d'un script neuf : en-tête + Session + pied. Les étapes
    // s'insèrent entre les deux.
    function scriptSkeleton(meta, now) {
        return automationToPython(newAutomation(meta || {}), now);
    }

    // Indice de la ligne de pied (ou la fin) : l'insertion « à la fin » se fait
    // juste au-dessus.
    function footerIndex(lines) {
        for (var i = lines.length - 1; i >= 0; i--) if (lines[i].trim() === FOOTER) return i;
        return lines.length;
    }

    // Lignes Python d'UNE étape (pour l'insertion dans l'éditeur).
    function stepLines(step) {
        step = step || {};
        switch (step.kind) {
            case "wait": return expectLines(step.expect, step.timeout_ms, false);
            case "check": return expectLines(step.expect, step.timeout_ms, true);
            case "if": return ["if " + condExpr(step.cond) + ":", "    pass"];
            case "else": return ["else:", "    pass"];
            case "loop": return ["for _i in range(" + Math.max(1, Number(step.times || 1)) + "):", "    pass"];
            case "focus": return ["s.focus(window=" + pyStr(step.window || "") + ")"];
            case "note": return ["s.note(" + pyStr(step.text || "") + ")"];
            case "var":
                if (step.source === "clipboard") return [pyIdent(step.name) + " = s.copy()"];
                if (step.source === "param") return [pyIdent(step.name) + " = p[" + pyStr(step.key || step.name) + "]"];
                return [pyIdent(step.name) + " = s.value(" + targetKwargs(_usable(step.anchor) ? step.anchor : { label: step.query }, { lean: true }) + ")"];
            case "code": return String(step.text || "").split("\n");
            default: return actionLines(step);
        }
    }

    function _indentOf(line) { var m = /^(\s*)/.exec(line || ""); return m ? m[1].length : 0; }

    // Insère ``lines`` dans ``code`` APRÈS la ligne ``after`` (indice 0-based ;
    // -1 = avant le pied), à l'indentation de cette ligne. Si cette ligne est
    // un ``pass`` de bloc vide, elle est REMPLACÉE (le bloc reçoit sa première
    // vraie instruction). Pur : renvoie {code, line} (line = 1re ligne insérée).
    // ``indentOverride`` (nombre d'espaces) force l'indentation — pour ``else:``,
    // qui doit RESSORTIR d'un niveau par rapport au corps où est le curseur.
    // Dernière ligne de l'EN-TÊTE (docstring, imports, ``s = Session(``,
    // ``p = s.params(``) : rien ne s'insère au-dessus. Un curseur laissé en
    // ligne 1 (éditeur fraîchement ouvert) enverrait sinon le bloc AVANT les
    // imports — vu au harnais : « if s.exists(…) » en ligne 2, Session en ligne 10.
    function headerEnd(lines) {
        // L'en-tête s'ARRÊTE à la première instruction qui n'en fait pas partie : un
        // « import time » écrit plus bas dans le corps envoyait sinon toute insertion
        // faite au-dessus de lui… au pied du script.
        var end = -1, inDoc = false;
        for (var i = 0; i < (lines || []).length; i++) {
            var t = String(lines[i] || "").trim();
            var q = (t.match(/"""/g) || []).length;
            if (inDoc) { end = i; if (q % 2 === 1) inDoc = false; continue; }
            if (q) { end = i; if (q % 2 === 1) inDoc = true; continue; }
            if (!t || t[0] === "#") continue;
            if (/^(s = Session\(|p = s\.params\(|from |import |TIMEOUT\s*=)/.test(t)) { end = i; continue; }
            break;
        }
        return end;
    }

    // La ligne OUVRE-t-elle un bloc (« if …: », « for …: », « else: ») ? Le « : » final
    // est lu hors chaînes et commentaires (« name="Commande # 12" » ne coupe plus la ligne).
    function isBlockOpener(line) {
        return /^\s*(if|elif|else|for|while|with|try|except|finally|def|class)\b/.test(line || "")
            && /:\s*$/.test(pyCodeOnly(line));
    }
    function _blank(l) { var t = String(l || "").trim(); return !t || t[0] === "#"; }
    // Dernière ligne du bloc ouvert en ``i`` (corps = lignes plus indentées ; lignes vides
    // et commentaires ignorés). ``i`` si le bloc n'a pas de corps.
    function blockEnd(lines, i) {
        var base = _indentOf(lines[i]), end = i;
        for (var j = i + 1; j < lines.length; j++) {
            if (_blank(lines[j])) continue;
            if (_indentOf(lines[j]) <= base) break;
            end = j;
        }
        return end;
    }
    // Où écrire « else: » pour le curseur en ``cur`` : APRÈS la fin du bloc « if / for /
    // while / try » qui contient le curseur (ou qu'il ouvre), à l'indentation de ce bloc.
    // Écrit au milieu du corps, il volait les lignes suivantes ; écrit sur la ligne du
    // « if », il passait entre le « if » et son corps (IndentationError). Null : aucun bloc.
    function elseInsertPoint(lines, cur) {
        lines = lines || [];
        if (cur == null || cur < 0 || cur >= lines.length) return null;
        var CLAUSE = /^\s*(if|elif|for|while|try|except)\b/;
        var op = -1;
        if (isBlockOpener(lines[cur]) && CLAUSE.test(lines[cur])) op = cur;
        else {
            var ind = _blank(lines[cur]) ? Infinity : _indentOf(lines[cur]);
            for (var k = cur - 1; k >= 0; k--) {
                if (_blank(lines[k])) continue;
                var ik = _indentOf(lines[k]);
                if (ik < ind) {
                    if (isBlockOpener(lines[k]) && CLAUSE.test(lines[k])) { op = k; break; }
                    if (ik === 0) break;
                    ind = ik;
                }
            }
        }
        if (op < 0) return null;
        return { after: blockEnd(lines, op), indent: _indentOf(lines[op]) };
    }
    // Retire la ligne ``i`` sans casser le Python : une ligne qui OUVRE un bloc part avec
    // son corps (et ses « elif / else / except / finally ») ; un corps devenu vide reçoit
    // « pass ». Pur : {code, removed} (removed = nombre de lignes retirées).
    function deleteLineAt(code, i) {
        var all = String(code || "").split("\n");
        if (i == null || i < 0 || i >= all.length) return { code: String(code || ""), removed: 0 };
        var start = i, end = i, base = _indentOf(all[i]);
        if (isBlockOpener(all[i])) {
            end = blockEnd(all, i);
            var clauses = /^\s*(if|try|for|while)\b/.test(all[i]);
            while (clauses) {
                var nx = end + 1;
                while (nx < all.length && _blank(all[nx])) nx++;
                if (nx < all.length && _indentOf(all[nx]) === base && /^\s*(elif|else|except|finally)\b/.test(all[nx]) && isBlockOpener(all[nx])) end = blockEnd(all, nx);
                else break;
            }
        }
        all.splice(start, end - start + 1);
        // Corps vidé ? (ouvrant au-dessus, rien de plus indenté entre lui et la suite)
        var prev = start - 1;
        while (prev >= 0 && _blank(all[prev])) prev--;
        if (prev >= 0 && isBlockOpener(all[prev]) && _indentOf(all[prev]) < base) {
            var next = start;
            while (next < all.length && _blank(all[next])) next++;
            if (next >= all.length || _indentOf(all[next]) <= _indentOf(all[prev])) {
                all.splice(start, 0, new Array(_indentOf(all[prev]) + 5).join(" ") + "pass");
                return { code: all.join("\n"), removed: end - start };
            }
        }
        return { code: all.join("\n"), removed: end - start + 1 };
    }

    function insertLinesAt(code, after, lines, indentOverride) {
        var all = String(code || "").split("\n");
        // Curseur dans l'en-tête ou sur/après le pied → « à la fin » (avant le pied).
        if (after != null && after >= 0 && (after <= headerEnd(all) || after >= footerIndex(all))) after = -1;
        var at = (after == null || after < 0 || after >= all.length) ? footerIndex(all) : after + 1;
        var ref = (after != null && after >= 0 && after < all.length) ? all[after] : "";
        var n = (indentOverride == null) ? _indentOf(ref) : Math.max(0, Number(indentOverride) || 0);
        // Curseur sur une ligne qui OUVRE un bloc (« if …: », « for …: », « else: ») :
        // la ligne insérée va DANS le bloc (+4) — à la même indentation, elle fermait
        // le bloc vide (IndentationError). Son « pass » de bloc vide est remplacé.
        var opener = indentOverride == null && isBlockOpener(ref);
        if (opener) n += 4;
        var indent = new Array(n + 1).join(" ");
        var replacePass = ref.trim() === "pass" && indentOverride == null;
        if (opener && all[after + 1] != null && all[after + 1].trim() === "pass" && _indentOf(all[after + 1]) === n) {
            after = after + 1; at = after; replacePass = true;
        }
        var body = (lines || []).map(function (l) { return l ? indent + l : ""; });
        if (replacePass) all.splice(after, 1, body[0]); else all.splice(at, 0, body[0]);
        var first = replacePass ? after : at;
        if (body.length > 1) all.splice(first + 1, 0, ...body.slice(1));
        return { code: all.join("\n"), line: first };
    }

    // Plan de lecture du code : une ligne par instruction utile, avec le niveau
    // d'indentation, le genre (bloc / action / attente / vérif / note / autre)
    // et la QUALITÉ d'ancrage lue dans la ligne (uia / nom / coords).
    function outlineFromCode(code) {
        var rows = [], inDoc = false;
        String(code || "").split("\n").forEach(function (raw, i) {
            var t = raw.trim();
            // Docstring d'en-tête : tout ce qui est entre deux """ n'est pas du plan.
            var quotes = (t.match(/"""/g) || []).length;
            if (quotes % 2 === 1) { inDoc = !inDoc; return; }
            if (inDoc || quotes) return;
            if (!t || t[0] === "#" || t === "pass") return;
            if (/^(from |import |s = Session\(|p = s\.params\(|raise SystemExit|TIMEOUT\s*=)/.test(t)) return;
            var kind = "code";
            if (/:$/.test(t) && /^(if |elif |else|for |while |with |try|except|finally)/.test(t)) kind = "block";
            else if (/^s\.wait\./.test(t)) kind = "wait";
            else if (/^s\.expect\./.test(t)) kind = "check";
            else if (/^s\.note\(/.test(t)) kind = "note";
            else if (/^s\.(launch|focus|close)\(/.test(t)) kind = "window";
            else if (/^s\.[a-z_]+\(/.test(t)) kind = "action";
            var anchor = "";
            if (/auto_id=/.test(t)) anchor = "uia";
            else if (/\bname=/.test(t)) anchor = "nom";
            else if (/\bpath=/.test(t)) anchor = "chemin";
            else if (/\bnear=/.test(t)) anchor = "voisin";
            else if (/\bimage=/.test(t)) anchor = "image";
            else if (/\bdescribe=/.test(t)) anchor = "vision";
            else if (/\bat=\(|\brel=\(/.test(t)) anchor = "coords";
            rows.push({ line: i, indent: Math.floor(_indentOf(raw) / 4), text: t, kind: kind, anchor: anchor });
        });
        return rows;
    }

    // Découpe les arguments d'un appel Python au niveau 0 (tuples, chaînes respectés).
    function _splitArgs(argstr) {
        var out = [], cur = "", depth = 0, q = null;
        for (var i = 0; i < argstr.length; i++) {
            var ch = argstr[i];
            if (q) { cur += ch; if (ch === "\\") { cur += argstr[++i] || ""; } else if (ch === q) q = null; continue; }
            if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
            if (ch === "(" || ch === "[" || ch === "{") depth++;
            if (ch === ")" || ch === "]" || ch === "}") depth--;
            if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
            cur += ch;
        }
        if (cur.trim()) out.push(cur.trim());
        return out;
    }
    var IDENTITY_KEYS = ["auto_id", "name", "role", "path", "near", "side", "image", "describe", "window", "rel", "at"];
    // Applique une identité proposée par le rapport (« réparation ») à une ligne :
    // ``s.click(auto_id="perdu", name="OK", role="button", window="#W", rel=(0.1, 0.2))``
    // + ``auto_id="okBtn"`` → l'identité principale est REMPLACÉE, les replis
    // (window/rel/image/near) et les autres arguments (clicks=, text…) gardés.
    function applyIdentity(line, suggest) {
        var m = /^(\s*)(.*?)(\(([\s\S]*)\))(\s*#.*)?$/.exec(line || "");
        if (!m || !suggest) return line;
        var head = m[1] + m[2], args = _splitArgs(m[4]), tail = m[5] || "";
        var sug = _splitArgs(suggest);
        var sugKeys = sug.map(function (a) { return (a.split("=")[0] || "").trim(); });
        var primary = ["auto_id", "name", "role", "path", "near", "side", "describe"];
        var kept = args.filter(function (a) {
            var k = (a.indexOf("=") > 0) ? a.split("=")[0].trim() : "";
            if (!k) return true;                                  // positionnel (texte de set_value…)
            if (sugKeys.indexOf(k) >= 0) return false;            // remplacé
            return primary.indexOf(k) < 0;                        // ancienne identité principale retirée
        });
        var positional = kept.filter(function (a) { return a.indexOf("=") < 0 || /^["']/.test(a); });
        var named = kept.filter(function (a) { return positional.indexOf(a) < 0; });
        var ordered = named.slice().sort(function (a, b) {
            var ia = IDENTITY_KEYS.indexOf(a.split("=")[0].trim()), ib = IDENTITY_KEYS.indexOf(b.split("=")[0].trim());
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        });
        return head + "(" + positional.concat(sug, ordered).join(", ") + ")" + tail;
    }

    // Le premier bloc ```python d'une réponse d'assistant (sinon tout le texte
    // s'il ressemble à du code, sinon rien).
    function extractPythonBlock(text) {
        text = String(text || "");
        var m = /```(?:python|py)?\s*\n([\s\S]*?)```/i.exec(text);
        if (m) return m[1].replace(/\s+$/, "");
        if (/^\s*s\.[a-z_]+\(/m.test(text)) return text.trim();
        return "";
    }

    // Aide-mémoire de l'API (pour l'assistant IA et l'aide à l'écran).
    var API_CHEATSHEET = [
        "API elpis_auto (objet s = Session) — une ligne = une action :",
        "s.launch(\"calc.exe\", wait_window=\"Calculatrice\", timeout=TIMEOUT)   s.focus(window=\"Bloc-notes\")   s.close(window=\"…\", timeout=TIMEOUT)",
        "s.click(auto_id=\"…\", name=\"…\", role=\"button\")   clicks=2 (double)   button=\"right\"   at=(x, y) en dernier recours",
        "s.click(path=\"#Panel/group[2]/button[1]\")   contrôle SANS nom : chemin depuis un ancêtre nommé (#auto_id ou role:Nom), rôle[rang] à chaque pas",
        "Pile d'identités (essayées dans l'ordre) : auto_id, path, name+role, near=\"Libellé\" (+side=right|left|below|above), image=\"assets/x.png\", describe=\"…\" (vision Elpis), window=\"#Win\"+rel=(fx, fy), at=(x, y)",
        "s.require(window=\"Titre\", launch=\"app.exe\")   s.require(gone=\"Titre\")   s.require(checked=True, name=\"…\")   préconditions (état de départ garanti)",
        "Options : python -m elpis_auto --dry-run | --trace | --repeat N | --data jeu.csv script.py   ·   import lib.xxx (dossier lib/ à côté du script)",
        "s.type(\"texte\")   s.key(\"ctrl+s\")   s.paste(\"texte\")   v = s.copy()   s.set_value(\"12\", auto_id=\"…\")",
        "s.scroll(-3, name=\"…\")   s.drag(to=(x, y), name=\"…\")   s.toggle/check/uncheck/select/expand/collapse(name=\"…\")",
        "TIMEOUT = 30 en tête du script : délai par défaut de tout ce qui attend. Écrire timeout=TIMEOUT sur chaque wait/expect/launch ; une valeur (timeout=120) seulement pour une étape qui a besoin d'un autre délai",
        "s.wait.window(\"Titre\", timeout=TIMEOUT)   s.wait.element(name=\"…\", timeout=TIMEOUT)   s.wait.gone(name=\"…\", timeout=TIMEOUT)   s.wait.stable(timeout=TIMEOUT)   s.wait.appear(timeout=TIMEOUT)",
        "s.wait.seconds(20) : pause FIXE (seulement quand rien d'observable ne signale la fin ; sinon une attente nommée rend la main plus tôt)",
        "s = Session(monitor=1, timeout=TIMEOUT, patience=120) : délai SANS activité à l'écran (tant que ça bouge, on attend, jusqu'à patience s) ; appli lourde : TIMEOUT = 90 et patience=300   window=\"Titre\" sur un clic = premier plan si possible, jamais une panne",
        "s.expect.exists(name=\"…\", timeout=TIMEOUT)   s.expect.gone(…, timeout=TIMEOUT)   s.expect.value(name=\"Total\", contains=\"42\" | equals= | regex=, timeout=TIMEOUT)",
        "s.expect.state(\"checked\", name=\"…\")   s.expect.count(role=\"button\", op=\">=\", n=3)",
        "s.exists(name=\"…\") -> bool   s.value(name=\"…\") -> str   s.state(\"checked\", name=\"…\") -> bool   s.note(\"…\")",
        "with s.step(\"libellé\", on_error=\"continue\"): …   retry=2 sur une action   p = s.params({\"cle\": \"défaut\"})",
        "Règle : viser auto_id, sinon name + role (arbre d'accessibilité), sinon path= ; at=(x, y) seulement s'il n'y a rien d'autre.",
    ].join("\n");

    var api = {
        KINDS: KINDS,
        FOOTER: FOOTER,
        API_CHEATSHEET: API_CHEATSHEET,
        TIMEOUT_VAR: TIMEOUT_VAR,
        readTimeoutValue: readTimeoutValue,
        ensureTimeoutVar: ensureTimeoutVar,
        setTimeoutValue: setTimeoutValue,
        timeoutDeclared: timeoutDeclared,
        usesTimeoutVar: usesTimeoutVar,
        pyCodeOnly: pyCodeOnly,
        isBlockOpener: isBlockOpener,
        blockEnd: blockEnd,
        elseInsertPoint: elseInsertPoint,
        deleteLineAt: deleteLineAt,
        anchorQuality: anchorQuality,
        scriptSkeleton: scriptSkeleton,
        footerIndex: footerIndex,
        stepLines: stepLines,
        insertLinesAt: insertLinesAt,
        headerEnd: headerEnd,
        outlineFromCode: outlineFromCode,
        extractPythonBlock: extractPythonBlock,
        applyIdentity: applyIdentity,
        DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
        newAutomation: newAutomation,
        actionStep: actionStep,
        makeStep: makeStep,
        blockDepths: blockDepths,
        validateBlocks: validateBlocks,
        stepLabel: stepLabel,
        condLabel: condLabel,
        targetKwargs: targetKwargs,
        pyStr: pyStr,
        needsVision: needsVision,
        automationToPython: automationToPython,
    };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) Object.keys(api).forEach(function (k) { root[k] = api[k]; });
})(typeof window !== "undefined" ? window : this);
