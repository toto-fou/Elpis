// SPDX-License-Identifier: MIT
/* ============================================================================
 * js/chat/_scenario_model.js — modèle PUR (sans Vue) d'un scénario de test
 * desktop : construction d'un « pas » reproductible depuis une action (chat ou
 * clic direct), résumé lisible, et helpers de (dé)sérialisation.
 *
 * Isolé du glue Vue (_studio_automation.js) pour être testable en Node
 * (tests/frontend/test_scenario_model.js). Exporté en CommonJS ET en global
 * navigateur (function declarations + window.*).
 *
 * Forme d'un pas :
 *   { op, anchor, args, assert }
 *     op      "click" | "double_click" | "right_click" | "type" | "paste"
 *             | "copy" | "key" | "scroll" | "move" | "drag"
 *     anchor  COMMENT retrouver la cible au rejeu, par ordre de robustesse :
 *               { id, label, role, source, box, center }  (élément observé)
 *               { query }                                  (texte à matcher)
 *               { x, y }                                   (coords brutes, repli)
 *     args    arguments d'action non-défaut : {text,keys,button,clicks,dy,x2,y2,modifiers}
 *     assert  vérification au rejeu : { type:"action_ok" } par défaut
 *     expect  ÉVÉNEMENT attendu APRÈS l'action (réussite fiable, défini par l'humain) :
 *               { kind:"element"|"element_gone"|"text"|"text_gone"|"stable"|"none",
 *                 query?, anchor? }
 *     timeout_ms  délai max d'attente de la vérification au rejeu (30 000–300 000 ms)
 * ==========================================================================*/
(function (root) {
    "use strict";

    var ANCHOR_FIELDS = ["id", "label", "role", "source", "box", "center", "auto_id"];

    // Le NOM RÉEL d'un élément. Le serveur fabrique ``label`` depuis le rôle quand
    // l'arbre n'expose aucun nom (« group », « pane »…) et le signale par
    // ``unnamed: true`` : ce libellé n'identifie rien et ne doit JAMAIS servir de
    // cible (``name="group"`` ne retrouve aucun contrôle au rejeu). Sans le
    // marqueur (vieil agent, fixtures), un libellé égal au rôle est traité pareil.
    function realName(el) {
        if (!el) return "";
        if (el.unnamed) return "";
        if (el.name !== undefined && el.name !== null) return String(el.name);
        var label = String(el.label || "");
        if (label && el.role && label === String(el.role)) return "";
        if (label === "element") return "";
        return label;
    }

    // auto_id VOLATILE : « view_N » d'un moteur Chromium/WebView2 (Edge, Chrome,
    // VS Code, Slack, Teams, Electron). Numéro d'ordre dans l'arbre, RÉASSIGNÉ à
    // chaque relance → jamais une identité fiable. Le nom + rôle a11y est stable.
    function volatileId(id) { return !!id && /^view_\d+$/i.test(String(id)); }

    // Ancre depuis un élément observé. ``elements`` (liste du frame, pré-ordre)
    // permet d'y ajouter le chemin structurel et de détecter un nom ambigu.
    function _anchorFromElement(el, elements) {
        var a = {};
        for (var i = 0; i < ANCHOR_FIELDS.length; i++) {
            var k = ANCHOR_FIELDS[i];
            if (k === "label") continue;
            if (el[k] !== undefined && el[k] !== null && el[k] !== "") a[k] = el[k];
        }
        var nm = realName(el);
        if (nm) a.label = nm;
        if (elements && elements.length) {
            var p = elementPath(elements, el);
            if (p) a.path = p;
            if (nm && isAmbiguous(elements, el)) a.ambiguous = true;
            // Pile d'identités : voisin nommé (contrôle sans nom) + fenêtre & position
            // relative (repli qui survit à un déplacement de fenêtre, jamais un at= absolu).
            if (!nm && !el.auto_id) {
                var nb = nearestLabel(elements, el);
                if (nb) { a.near = nb.label; a.side = nb.side; }
            }
            var w = windowAnchor(elements, el);
            if (w) { a.window = w.window; a.rel = w.rel; }
        }
        // auto_id volatil (Chromium view_N) : ne pas l'écrire comme identité si un
        // nom réel ou un chemin le remplace (stables) — sinon un wait/clic keyé sur
        // « view_3 » casse à la relance (l'id a bougé). Gardé en dernier recours seul.
        if (a.auto_id && volatileId(a.auto_id)) {
            a.volatile_id = true;
            if (nm || a.path) delete a.auto_id;
        }
        // auto_id PARTAGÉ par plusieurs éléments du frame (Explorateur : toutes les
        // cellules « nom » portent System.ItemNameDisplay) : ce n'est pas une identité.
        // Le nom (ou le chemin) le remplace, sinon le rejeu agissait sur le PREMIER.
        if (a.auto_id && elements && elements.length) {
            var same = 0;
            for (var j = 0; j < elements.length; j++) if (elements[j] && elements[j].auto_id === a.auto_id) same++;
            if (same > 1) {
                a.shared_id = true;
                if (nm || a.path) delete a.auto_id;
            }
        }
        return a;
    }
    // Libellé NOMMÉ le plus proche d'un élément (même parent d'abord, puis
    // géométrie), et de quel côté il se trouve par rapport à l'élément.
    function nearestLabel(elements, el) {
        var c = _centerOf(el);
        if (!c) return null;
        var parent = elementParent(elements, el);
        var pools = [];
        if (parent) pools.push(elementChildren(elements, parent));
        pools.push(elements.filter(_inTree));
        for (var q = 0; q < pools.length; q++) {
            var best = null, bestD = Infinity;
            for (var i = 0; i < pools[q].length; i++) {
                var e = pools[q][i];
                if (e === el || !_inTree(e)) continue;
                var nm = realName(e);
                if (!nm || nm.length > 60) continue;
                var ec = _centerOf(e);
                if (!ec) continue;
                var dx = c[0] - ec[0], dy = c[1] - ec[1];
                var d = Math.sqrt(dx * dx + dy * dy) + Math.abs(dy);   // même ligne d'abord
                if (d < bestD) { bestD = d; best = { label: nm, dx: dx, dy: dy }; }
            }
            if (best && bestD < 600) {
                var side = Math.abs(best.dx) >= Math.abs(best.dy) ? (best.dx > 0 ? "right" : "left") : (best.dy > 0 ? "below" : "above");
                return { label: best.label, side: side };
            }
        }
        return null;
    }
    // Fenêtre (racine) de l'élément et position RELATIVE de son centre dans le
    // rectangle de la fenêtre : « #auto_id » si la racine en a un, sinon son titre.
    function windowAnchor(elements, el) {
        var anc = elementAncestors(elements, el);
        var root = anc.length ? anc[0] : null;
        if (!root || !Array.isArray(root.box) || root.box.length !== 4) return null;
        var c = _centerOf(el);
        if (!c) return null;
        var w = root.box[2] - root.box[0], h = root.box[3] - root.box[1];
        if (w <= 0 || h <= 0) return null;
        var ident = root.auto_id ? ("#" + root.auto_id) : realName(root);
        if (!ident) return null;
        return { window: ident, rel: [Math.round((c[0] - root.box[0]) / w * 1000) / 1000, Math.round((c[1] - root.box[1]) / h * 1000) / 1000] };
    }
    // Audit d'accessibilité : contrôles INTERACTIFS sans nom ni auto_id — ce que
    // l'application devrait corriger pour être automatisable proprement.
    var INTERACTIVE_ROLES = ["button", "checkbox", "radiobutton", "edit", "combobox", "listitem", "tab", "tabitem",
                             "menuitem", "slider", "hyperlink", "spinner", "treeitem", "splitbutton"];
    function a11yAudit(elements) {
        elements = elements || [];
        var rows = [], interactive = 0;
        for (var i = 0; i < elements.length; i++) {
            var e = elements[i];
            if (!_inTree(e)) continue;
            var role = String(e.role || "").toLowerCase();
            if (INTERACTIVE_ROLES.indexOf(role) < 0) continue;
            interactive++;
            var nm = realName(e);
            var stableAid = !!(e.auto_id && !volatileId(e.auto_id));
            if (nm && stableAid) continue;
            var nb = nearestLabel(elements, e);
            rows.push({ id: e.id, role: role, missing: (!nm && !stableAid) ? "nom et auto_id" : (!nm ? "nom" : "auto_id"),
                        volatile: !!(e.auto_id && volatileId(e.auto_id)),
                        path: elementPath(elements, e), near: nb ? nb.label : "", box: e.box });
        }
        return { interactive: interactive, rows: rows, unnamed: rows.filter(function (r) { return r.missing !== "auto_id"; }).length };
    }
    function a11yAuditCsv(audit) {
        var out = ["rôle;manque;chemin;voisin;x1;y1;x2;y2"];
        (audit && audit.rows || []).forEach(function (r) {
            var b = r.box || ["", "", "", ""];
            out.push([r.role, r.missing, r.path, r.near, b[0], b[1], b[2], b[3]].map(function (v) { return String(v == null ? "" : v).replace(/;/g, ","); }).join(";"));
        });
        return out.join("\n");
    }
    function anchorFromElement(el, elements) { return _anchorFromElement(el || {}, elements); }

    // Arguments d'action conservés (on omet les défauts pour un pas propre).
    function pickActionArgs(args) {
        args = args || {};
        var out = {};
        ["text", "keys", "modifiers", "app"].forEach(function (k) {
            if (args[k]) out[k] = args[k];
        });
        if (args.button && args.button !== "left") out.button = args.button;
        if (args.clicks && Number(args.clicks) > 1) out.clicks = Number(args.clicks);
        if (typeof args.dy === "number" && args.dy !== 0) out.dy = args.dy;
        else if (args.dy && Number(args.dy) !== 0) out.dy = Number(args.dy);
        if (args.x2 !== undefined && args.x2 !== null &&
            args.y2 !== undefined && args.y2 !== null) {
            out.x2 = Number(args.x2);
            out.y2 = Number(args.y2);
        }
        return out;
    }

    // Pas depuis un tool_call desktop_act (chat) : ``args`` = final_args du tool,
    // ``elements`` = liste d'éléments du frame courant (pour résoudre l'ancre).
    // C3 — défaut d'attente INFÉRÉ à l'enregistrement depuis l'op (signal sûr et
    // bon marché), au lieu du « stable » générique. L'humain peut toujours le
    // changer. launch → window_ready : une fenêtre s'ouvre, c'est LA synchro
    // fiable (« stable » se fige souvent AVANT l'apparition de la fenêtre).
    // Renvoie un objet expect, ou null pour garder le défaut implicite (stable).
    function inferDefaultExpect(op) {
        if (op === "launch") return { kind: "window_ready", query: "" };
        return null;
    }

    function scenarioStepFromAct(input) {
        input = input || {};
        var args = input.args || {};
        var elements = input.elements || [];
        var op = (args.op || input.op || "click");

        var anchor = null;
        if (args.element_id) {
            for (var i = 0; i < elements.length; i++) {
                if (elements[i] && String(elements[i].id) === String(args.element_id)) {
                    anchor = _anchorFromElement(elements[i], elements);
                    break;
                }
            }
        }
        // element_id absent du frame du Studio (numérotation d'un autre worker, frame
        // périmé) : la requête, puis le point, AVANT l'id brut — qui ne s'écrit en
        // aucune identité (« s.click() » échouait toujours au rejeu).
        if (!anchor && args.query) anchor = { query: String(args.query) };
        if (!anchor && args.x !== undefined && args.x !== null &&
            args.y !== undefined && args.y !== null) {
            anchor = { x: Number(args.x), y: Number(args.y) };
        }
        if (!anchor && args.element_id) anchor = { id: args.element_id, lost: true };   // id brut : marqué perdu
        if (!anchor) anchor = {};

        var step = {
            op: op,
            anchor: anchor,
            args: pickActionArgs(args),
            assert: { type: "action_ok" },
        };
        var ex = inferDefaultExpect(op);   // C3 — défaut malin (launch → window_ready)
        if (ex) step.expect = ex;
        return step;
    }

    // Pas depuis un clic direct sur l'image/liste : ``element`` = la box cliquée.
    // Un clic sur une CASE (rôle checkbox, ou pattern toggle) devient « check » /
    // « uncheck » selon l'état AVANT le clic : le script vise un état (la case
    // cochée), pas un geste — rejoué sur une appli déjà dans le bon état, il ne
    // fait rien au lieu d'inverser la case.
    function _toggleOp(op, el) {
        if (op !== "click" || !el) return op;
        var role = String(el.role || "").toLowerCase();
        var pats = Array.isArray(el.patterns) ? el.patterns : [];
        // Une CASE se coche ; un item d'arbre / de liste qui expose AUSSI une bascule
        // (couche QGIS, item cochable) se CLIQUE pour être choisi — le transformer en
        // uncheck masquait la couche au rejeu au lieu de la sélectionner.
        var itemRole = ["treeitem", "listitem", "dataitem", "menuitem", "tabitem", "radiobutton"].indexOf(role) >= 0;
        var toggle = role === "checkbox" || (pats.indexOf("toggle") >= 0 && pats.indexOf("selectionitem") < 0 && !itemRole);
        if (!toggle) return op;
        var states = (el.states || []).map(function (x) { return String(x).toLowerCase(); });
        return states.indexOf("checked") >= 0 ? "uncheck" : "check";
    }
    function scenarioStepFromDirect(input) {
        input = input || {};
        var el = input.element || {};
        var op = _toggleOp(input.op || "click", el);
        var step = {
            op: op,
            anchor: _anchorFromElement(el, input.elements || []),
            // Capture les args (ex. texte de set_value) sinon ils sont perdus au rejeu.
            args: pickActionArgs(input.args || {}),
            assert: { type: "action_ok" },
        };
        // Un double-clic OUVRE quelque chose (fichier, projet, dossier) : on attend
        // l'écran stable avant la suite — vu sur la VM : le projet QGIS se
        // rechargeait encore quand le script cliquait déjà dedans.
        if (op === "double_click" || Number((input.args || {}).clicks) === 2) step.expect = { kind: "stable" };
        return step;
    }

    // Le résultat d'un tool/endpoint est-il un succès ? (string JSON ou objet)
    function resultOk(result) {
        if (result == null) return false;
        var obj = result;
        if (typeof result === "string") {
            try { obj = JSON.parse(result); } catch (e) { return !/"(ok)"\s*:\s*false|"error"/.test(result); }
        }
        if (obj && typeof obj === "object") {
            if (obj.ok === false) return false;
            if (obj.error) return false;
            return true;
        }
        return true;
    }

    // Résumé lisible d'un pas (UI).
    function summarizeStep(step) {
        if (!step) return "";
        var op = step.op || "?";
        var a = step.anchor || {};
        var who = a.label || a.query || (a.id ? "#" + a.id : null) ||
                  (a.x !== undefined ? "(" + a.x + "," + a.y + ")" : "");
        var args = step.args || {};
        if (op === "type" || op === "paste") return op + ' « ' + (args.text || "") + ' »';
        if (op === "key") return 'key ' + (args.keys || "");
        if (op === "scroll") return 'scroll ' + (args.dy || 0);
        if (op === "drag") return 'drag → (' + (args.x2) + ',' + (args.y2) + ')';
        if (op === "launch") return 'lancer ' + (args.app || args.target || "");
        return op + (who ? ' « ' + who + ' »' : "");
    }

    // ── Effet & allers-retours (signatures de frame dHash, hex 64 bits) ──────
    // Distance de Hamming entre deux signatures. Sigs absentes/longueurs diff. →
    // 64 (= « totalement différent » : on ne peut pas conclure, on garde par défaut).
    function hamming(a, b) {
        if (!a || !b || a.length !== b.length) return 64;
        var x;
        try { x = BigInt('0x' + a) ^ BigInt('0x' + b); }
        catch (e) { return 64; }
        var c = 0;
        while (x > 0n) { c += Number(x & 1n); x >>= 1n; }
        return c;
    }

    // L'action a-t-elle eu un EFFET visible ? 'changed' | 'none' | 'unknown'
    // (sig manquante = on ne peut pas juger → 'unknown', traité comme à garder).
    function frameEffect(before, after, threshold) {
        threshold = (threshold == null) ? 6 : threshold;
        if (!before || !after) return 'unknown';
        return hamming(before, after) > threshold ? 'changed' : 'none';
    }

    // Élague les ALLERS-RETOURS : si l'état (signature) après un pas réapparaît
    // dans l'historique des états, les pas depuis cet état forment une boucle
    // (fumble → correction) et sont retirés. Les pas attendent ``sigBefore`` /
    // ``sigAfter`` ; sans signatures, rien n'est élagué (conservateur).
    function pruneCycles(steps, threshold) {
        threshold = (threshold == null) ? 6 : threshold;
        steps = steps || [];
        if (!steps.length) return [];
        var kept = [];
        var states = [steps[0].sigBefore || ''];   // état initial
        for (var s = 0; s < steps.length; s++) {
            var after = steps[s].sigAfter || '';
            var backTo = -1;
            if (after) {
                for (var i = 0; i < states.length; i++) {
                    if (states[i] && hamming(states[i], after) <= threshold) { backTo = i; break; }
                }
            }
            if (backTo >= 0) {            // retour à un état connu → coupe la boucle
                kept.length = backTo;
                states.length = backTo + 1;
            } else {
                kept.push(steps[s]);
                states.push(after);
            }
        }
        return kept;
    }

    // ── Attente / vérification d'un pas (réussite fiable au rejeu) ───────────
    var EXPECT_KINDS = ["element", "element_gone", "text", "text_gone", "appear", "window_ready", "value", "value_gone", "state", "count", "stable", "none"];
    var WINDOW_ROLES = ["window", "dialog", "frame", "document", "pane", "panel"];
    function isWindowRole(role) { return WINDOW_ROLES.indexOf(String(role || "").toLowerCase()) >= 0; }
    // Plancher bas → FAST-FAIL (le backend partage cette borne) ; défaut = 30 s.
    var MIN_TIMEOUT_MS = 1500, MAX_TIMEOUT_MS = 300000, DEFAULT_TIMEOUT_MS = 30000;

    function clampTimeout(ms) {
        var v = Number(ms);
        if (!isFinite(v)) return DEFAULT_TIMEOUT_MS;
        return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(v)));
    }

    function _elKey(el) {
        var label = ((el && el.label) || "").trim().toLowerCase();
        var role = ((el && el.role) || "").toLowerCase();
        return label ? (label + "" + role) : ("#" + ((el && el.id) || ""));
    }
    function _area(el) {
        var b = el && el.box;
        if (!b || b.length < 4) return 0;
        return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    }
    // Diff de deux observations : éléments APPARUS (added) / DISPARUS (removed)
    // après une action — base des « nouveaux événements » proposés à l'humain.
    // ``added`` est trié par surface décroissante (le plus saillant d'abord :
    // une fenêtre/dialogue qui s'ouvre passe avant un petit bouton).
    function diffElements(before, after) {
        before = before || []; after = after || [];
        var bk = {}, ak = {}, i;
        for (i = 0; i < before.length; i++) bk[_elKey(before[i])] = true;
        for (i = 0; i < after.length; i++) ak[_elKey(after[i])] = true;
        var added = after.filter(function (e) { return !bk[_elKey(e)]; });
        var removed = before.filter(function (e) { return !ak[_elKey(e)]; });
        added.sort(function (a, b) { return _area(b) - _area(a); });
        return { added: added, removed: removed };
    }

    // Attente par défaut quand l'humain n'en définit pas : STABILITÉ (jamais
    // d'échec sur « pas d'effet »). Le backend applique exactement la même règle.
    function defaultExpect() { return { kind: "stable" }; }

    // Construit une attente « élément (dis)paru » depuis l'élément choisi (modale).
    function expectFromElement(el, present) {
        el = el || {};
        return {
            kind: (present === false) ? "element_gone" : "element",
            query: el.label || el.query || "",
            anchor: { label: el.label, role: el.role, box: el.box, center: el.center, source: el.source },
        };
    }

    function _fmtMs(ms) {
        var s = Math.round(clampTimeout(ms) / 1000);
        return s >= 60 ? ((Math.round(s / 6) / 10) + " min") : (s + " s");
    }
    // Mode de comparaison « texte partiel » → suffixe lisible (partiel = muet).
    function _cmpLabel(expect) {
        var c = (expect && expect.cmp) || (expect && expect.match ? "regex" : "partiel");
        return c === "exact" ? " (exact)" : c === "regex" ? " (regex)" : "";
    }
    // Résumé lisible de l'attente (badge UI / journal de rejeu).
    function summarizeExpect(expect, timeoutMs) {
        expect = expect || {};
        var t = _fmtMs(timeoutMs);
        var q = expect.query || (expect.anchor && (expect.anchor.label || expect.anchor.query)) || "";
        switch (expect.kind) {
            case "element": return "attend « " + q + " » · " + t;
            case "element_gone": return "« " + q + " » disparaît · " + t;
            case "text": return "texte « " + q + " »" + _cmpLabel(expect) + " · " + t;
            case "text_gone": return "texte « " + q + " » disparaît" + _cmpLabel(expect) + " · " + t;
            case "appear": return "nouvelle fenêtre/élément · " + t;
            case "window_ready": return "fenêtre prête" + (q ? " « " + q + " »" : "") + " · " + t;
            case "value": return "champ « " + q + " » = « " + (expect.expected || "") + " »" + _cmpLabel(expect) + " · " + t;
            case "value_gone": return "champ « " + q + " » ≠ « " + (expect.expected || "") + " »" + _cmpLabel(expect) + " · " + t;
            case "state": return "« " + q + " » est " + (expect.state || "?") + " · " + t;
            case "count": return "compte « " + (q || expect.role || "*") + " » " + (expect.op || "==") + " " + (expect.count || 0) + " · " + t;
            case "pause": return "pause · " + t;
            case "none": return "aucune vérification";
            default: return "écran stable · " + t;
        }
    }

    // Comparaison pixel CÔTÉ CLIENT : fraction de pixels dont la luminance diffère
    // de plus de ``threshold`` entre deux frames (tableaux de même taille,
    // typiquement réduits ex. 64×64). Confirme un changement visuel RÉEL —
    // complément/repli au dHash quand l'arbre a11y est absent (apps canvas).
    function pixelDiffRatio(a, b, threshold) {
        threshold = (threshold == null) ? 16 : threshold;
        if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
        var changed = 0;
        for (var i = 0; i < a.length; i++) {
            if (Math.abs(a[i] - b[i]) > threshold) changed++;
        }
        return changed / a.length;
    }

    // Arbre UIA : transforme la liste PLATE (pré-ordre + ``depth``) en lignes
    // VISIBLES d'un arbre indenté/repliable. ``collapsed`` = map {id:true}.
    // En mode RECHERCHE (``filter`` non vide) : correspondances à plat
    // (nom/rôle/auto_id), sans hiérarchie. Chaque ligne = {el, depth, hasChildren, collapsed}.
    function elementTreeRows(elements, collapsed, filter) {
        elements = elements || [];
        collapsed = collapsed || {};
        var f = String(filter || "").trim().toLowerCase();
        var rows = [], i;
        if (f) {
            for (i = 0; i < elements.length; i++) {
                var e = elements[i];
                var hay = ((e.label || "") + " " + (e.role || "") + " " + (e.auto_id || "")).toLowerCase();
                if (hay.indexOf(f) >= 0) rows.push({ el: e, depth: 0, hasChildren: false, collapsed: false });
            }
            return rows;
        }
        var hideBelow = -1;
        for (i = 0; i < elements.length; i++) {
            var el = elements[i];
            var depth = Number(el.depth || 0);
            if (hideBelow >= 0 && depth > hideBelow) continue;   // sous un nœud replié
            hideBelow = -1;
            var nextDepth = (i + 1 < elements.length) ? Number(elements[i + 1].depth || 0) : -1;
            var hasChildren = nextDepth > depth;
            var isCollapsed = hasChildren && !!collapsed[el.id];
            rows.push({ el: el, depth: depth, hasChildren: hasChildren, collapsed: isCollapsed });
            if (isCollapsed) hideBelow = depth;
        }
        return rows;
    }

    // ── Hiérarchie : parents, enfants, chemin structurel ────────────────────
    // L'arbre a11y arrive À PLAT en pré-ordre avec ``depth``. Le parent d'un nœud
    // est le nœud PRÉCÉDENT le plus proche de profondeur strictement moindre ;
    // ses enfants directs sont les nœuds du sous-arbre qu'aucun nœud du sous-arbre
    // ne précède à une profondeur moindre (robuste aux TROUS de profondeur : un
    // nœud filtré côté agent laisse ses enfants deux niveaux plus bas). Les boxes
    // de vision (``source: "vision"``) sont hors arbre : ni parent ni enfant.
    function _idx(elements, el) {
        if (!el) return -1;
        for (var i = 0; i < elements.length; i++) if (elements[i] === el || (elements[i] && el.id !== undefined && elements[i].id === el.id)) return i;
        return -1;
    }
    function _d(el) { return Number((el && el.depth) || 0); }
    function _inTree(el) { return !!el && el.source !== "vision"; }
    function elementParent(elements, el) {
        elements = elements || [];
        var i = _idx(elements, el);
        if (i < 0 || !_inTree(el)) return null;
        var d = _d(el);
        for (var j = i - 1; j >= 0; j--) {
            if (!_inTree(elements[j])) continue;
            if (_d(elements[j]) < d) return elements[j];
        }
        return null;
    }
    // Ancêtres, racine en premier (sans l'élément lui-même).
    function elementAncestors(elements, el) {
        var out = [], p = elementParent(elements, el), guard = 0;
        while (p && guard++ < 64) { out.unshift(p); p = elementParent(elements, p); }
        return out;
    }
    function elementChildren(elements, el) {
        elements = elements || [];
        var i = _idx(elements, el);
        if (i < 0 || !_inTree(el)) return [];
        var d = _d(el), out = [], runMin = Infinity;
        for (var j = i + 1; j < elements.length; j++) {
            var e = elements[j];
            if (!_inTree(e)) continue;
            var dj = _d(e);
            if (dj <= d) break;
            if (dj <= runMin) out.push(e);
            if (dj < runMin) runMin = dj;
        }
        return out;
    }
    // Racines de l'arbre (fenêtres) : nœuds sans parent, hors vision.
    function elementRoots(elements) {
        var out = [];
        for (var i = 0; i < (elements || []).length; i++) {
            var e = elements[i];
            if (_inTree(e) && elementParent(elements, e) === null) out.push(e);
        }
        return out;
    }
    function _seg(el, siblings) {
        var role = String((el && el.role) || "") || "element";
        var n = 0, k = 0;
        for (var i = 0; i < siblings.length; i++) {
            if (String((siblings[i] && siblings[i].role) || "" ) === String((el && el.role) || "")) { n++; if (siblings[i] === el || siblings[i].id === el.id) k = n; }
        }
        return role + "[" + (k || 1) + "]";
    }
    // auto_id utilisable comme ancre de chemin : stable, sans « / », et porté par CE SEUL
    // élément du frame — « #DeleteBtn » partagé par chaque ligne d'une liste désignait la
    // première ligne au rejeu (resolvePath prend le premier nœud qui correspond).
    function _uniqueAid(elements, el) {
        if (!el || !el.auto_id || volatileId(el.auto_id) || String(el.auto_id).indexOf("/") >= 0) return false;
        var n = 0;
        for (var i = 0; i < (elements || []).length; i++) if (elements[i] && elements[i].auto_id === el.auto_id && ++n > 1) return false;
        return true;
    }
    function _anchorSeg(el, elements) {
        if (_uniqueAid(elements, el)) return "#" + el.auto_id;
        var nm = realName(el);
        return (el.role ? String(el.role) + ":" : "") + nm;
    }
    // Chemin STRUCTUREL d'un élément : « <ancre>/role[n]/…/role[n] », où l'ancre
    // est l'ancêtre le plus proche qui a un auto_id (« #id ») ou un vrai nom
    // (« role:Nom »), et chaque pas = rôle + rang parmi les enfants de même rôle.
    // Un élément lui-même ancré (auto_id / nom) a pour chemin sa seule ancre. Sans
    // aucun ancêtre nommé, le chemin part de la racine par son rang (« window[2] »).
    // C'est ce qui permet de viser un contrôle SANS NOM sans tomber en coordonnées.
    // Vide pour une box de vision (hors arbre). Résolu par resolvePath / le runtime.
    // Un nœud est « ancrable » s'il a un auto_id, ou un vrai nom porté par lui SEUL.
    function _anchorable(elements, el) {
        // Un « / » dans l'auto_id ou le nom (« Entrée/Sortie ») couperait le chemin en
        // deux segments : ce nœud ne peut pas servir d'ancre (même règle que le runtime).
        if (!el) return false;
        var nm = realName(el);
        return !!(_uniqueAid(elements, el) || (nm && nm.indexOf("/") < 0 && !isAmbiguous(elements, el)));
    }
    function elementPath(elements, el) {
        elements = elements || [];
        if (!_inTree(el) || _idx(elements, el) < 0) return "";
        if (_anchorable(elements, el)) return _anchorSeg(el, elements);
        var chain = elementAncestors(elements, el).concat([el]);
        var start = -1;
        for (var i = chain.length - 2; i >= 0; i--) {
            if (_anchorable(elements, chain[i])) { start = i; break; }
        }
        var segs = [];
        if (start >= 0) segs.push(_anchorSeg(chain[start], elements));
        else { segs.push(_seg(chain[0], elementRoots(elements))); start = 0; }
        for (var j = start + 1; j < chain.length; j++) {
            segs.push(_seg(chain[j], elementChildren(elements, chain[j - 1])));
        }
        return segs.join("/");
    }
    // Un pas de chemin → {auto_id} | {role, name} | {name} | {role, n}.
    function parsePathSeg(seg) {
        seg = String(seg || "").trim();
        if (!seg) return null;
        if (seg.charAt(0) === "#") return { auto_id: seg.slice(1) };
        var m = /^([a-z_]+)\[(\d+)\]$/i.exec(seg);
        if (m) return { role: m[1].toLowerCase(), n: parseInt(m[2], 10) || 1 };
        var c = seg.indexOf(":");
        if (c > 0 && /^[a-z_]+$/i.test(seg.slice(0, c))) return { role: seg.slice(0, c).toLowerCase(), name: seg.slice(c + 1) };
        return { name: seg };
    }
    function _norm(s) { return String(s || "").replace(/\s+/g, " ").trim().toLowerCase(); }
    function _matchSeg(el, p, siblings) {
        if (!el || !p) return false;
        if (p.auto_id !== undefined) return String(el.auto_id || "") === p.auto_id;
        if (p.name !== undefined) {
            if (p.role && _norm(el.role) !== p.role) return false;
            return _norm(realName(el)) === _norm(p.name);
        }
        if (_norm(el.role) !== p.role) return false;
        var k = 0;
        for (var i = 0; i < siblings.length; i++) {
            if (_norm(siblings[i].role) === p.role) { k++; if (siblings[i] === el) return k === p.n; }
        }
        return false;
    }
    // Résout un chemin (grammaire de elementPath) dans la liste : l'élément, ou null.
    // Descendants (sous-arbre) d'un élément, en pré-ordre.
    function elementDescendants(elements, el) {
        var i = _idx(elements, el), out = [];
        if (i < 0 || !_inTree(el)) return out;
        var d = _d(el);
        for (var j = i + 1; j < elements.length; j++) {
            var e = elements[j];
            if (!_inTree(e)) continue;
            if (_d(e) <= d) break;
            out.push(e);
        }
        return out;
    }
    // Strict d'abord (enfants DIRECTS) ; ``relaxed`` (défaut) : si le chemin exact
    // casse, « l'ancre puis le N-ième descendant de ce rôle » — même règle que le
    // runtime (resolve_path), un conteneur Qt en plus ou en moins ne casse plus tout.
    function resolvePath(elements, path, relaxed) {
        elements = elements || [];
        if (relaxed === undefined) relaxed = true;
        var segs = String(path || "").split("/").map(parsePathSeg).filter(Boolean);
        if (!segs.length) return null;
        var first = segs[0], pool = (first.n !== undefined && first.auto_id === undefined && first.name === undefined)
            ? elementRoots(elements) : elements.filter(_inTree);
        var anchor = null;
        for (var i = 0; i < pool.length; i++) { if (_matchSeg(pool[i], first, pool)) { anchor = pool[i]; break; } }
        if (!anchor && relaxed && first.auto_id) {
            // Ancre absente : dock Qt FLOTTANT = objectName nu, ANCRÉ = nom préfixé
            // (« QgisApp.PythonConsole ») — le dernier composant pointé sert dans les deux sens.
            var tail = first.auto_id.split(".").pop();
            for (var a = 0; a < pool.length; a++) {
                var aid = String(pool[a].auto_id || "");
                if (aid === tail || aid.slice(-(tail.length + 1)) === "." + tail) { anchor = pool[a]; break; }
            }
        }
        var cur = anchor;
        for (var s = 1; cur && s < segs.length; s++) {
            var kids = elementChildren(elements, cur), next = null;
            for (var j = 0; j < kids.length; j++) { if (_matchSeg(kids[j], segs[s], kids)) { next = kids[j]; break; } }
            cur = next;
        }
        if (cur || !relaxed || !anchor || segs.length < 2) return cur || null;
        var last = segs[segs.length - 1], sub = elementDescendants(elements, anchor);
        if (last.n !== undefined) {
            var same = sub.filter(function (e) { return _norm(e.role) === last.role; });
            return (last.n > 0 && last.n <= same.length) ? same[last.n - 1] : null;
        }
        for (var k = 0; k < sub.length; k++) { if (_matchSeg(sub[k], last, sub)) return sub[k]; }
        return null;
    }
    // Un nom (+ rôle) porté par PLUSIEURS éléments du frame → viser par le nom
    // seul prendrait le premier venu ; le chemin tranche.
    function isAmbiguous(elements, el) {
        var nm = _norm(realName(el)), role = _norm(el && el.role);
        if (!nm) return false;
        var n = 0;
        for (var i = 0; i < (elements || []).length; i++) {
            var e = elements[i];
            if (_norm(realName(e)) === nm && _norm(e && e.role) === role) n++;
        }
        return n > 1;
    }
    // L'élément LE PLUS PROFOND sous un point : le plus petit qui le contient ;
    // à surface égale, le plus profond dans l'arbre. C'est la règle de l'inspecteur
    // (clic = ce qu'on voit, jamais le conteneur).
    function deepestAt(elements, point) {
        var best = null, bestA = Infinity;
        for (var i = 0; i < (elements || []).length; i++) {
            var el = elements[i], b = el && el.box;
            if (!b || b.length < 4 || !_inBox(b, point)) continue;
            var a = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
            if (a < bestA || (a === bestA && best && _d(el) > _d(best))) { best = el; bestA = a; }
        }
        return best;
    }

    // ── Plans (couches) : une fenêtre = un plan ─────────────────────────────
    // L'arbre a11y arrive À PLAT en pré-ordre, fenêtre après fenêtre dans l'ordre
    // Z (la fenêtre au premier plan d'abord) : chaque racine (depth 0, hors
    // vision) ouvre un nouveau plan, ses descendants le suivent. Une box venue de
    // la vision seule (depth 0 aussi, mais sans arbre) est rattachée au premier
    // plan dont la racine contient son centre — sinon au plan 1.
    function _inBox(box, pt) {
        return Array.isArray(box) && box.length === 4 && pt && pt.length >= 2
            && pt[0] >= box[0] && pt[0] <= box[2] && pt[1] >= box[1] && pt[1] <= box[3];
    }
    function _centerOf(el) {
        if (el && Array.isArray(el.center) && el.center.length >= 2) return el.center;
        var b = el && el.box;
        return (Array.isArray(b) && b.length === 4) ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null;
    }
    function elementLayers(elements) {
        elements = elements || [];
        var layers = [], layerOf = {}, current = 0, orphans = [], i, el;
        for (i = 0; i < elements.length; i++) {
            el = elements[i];
            if (!el) continue;
            var isRoot = Number(el.depth || 0) === 0 && el.source !== "vision";
            if (isRoot) {
                current = layers.length + 1;
                layers.push({ index: current, id: el.id, label: el.label || el.role || ("plan " + current),
                              role: el.role || "", box: el.box, count: 0 });
            }
            if (el.source === "vision" || !current) { orphans.push(el); continue; }
            layerOf[el.id] = current;
            layers[current - 1].count++;
        }
        for (i = 0; i < orphans.length; i++) {
            el = orphans[i];
            var c = _centerOf(el), hit = 0;
            for (var j = 0; j < layers.length; j++) { if (_inBox(layers[j].box, c)) { hit = layers[j].index; break; } }
            if (!hit) {
                if (!layers.length) layers.push({ index: 1, id: null, label: "sans fenêtre", role: "", box: null, count: 0 });
                hit = 1;
            }
            layerOf[el.id] = hit;
            layers[hit - 1].count++;
        }
        return { layers: layers, layerOf: layerOf };
    }
    // Filtre par plans (``on`` = {index:true}, vide/null = tous) et par profondeur
    // maximale dans la fenêtre (``depthMax`` 0 = toutes ; les boxes de vision,
    // sans profondeur, passent toujours).
    function filterByLayers(elements, on, depthMax, layerOf) {
        elements = elements || [];
        var keys = on ? Object.keys(on).filter(function (k) { return on[k]; }) : [];
        var lo = layerOf || elementLayers(elements).layerOf;
        var dm = Number(depthMax || 0);
        return elements.filter(function (el) {
            if (!el) return false;
            if (keys.length && !on[lo[el.id]]) return false;
            if (dm > 0 && el.source !== "vision" && Number(el.depth || 0) > dm - 1) return false;
            return true;
        });
    }
    // « 1er plan », « 2e plan »…
    function layerOrdinal(index) { return index === 1 ? "1er plan" : (index + "e plan"); }

    // Élément VISIBLE sur la capture : sa box chevauche le cadre [0,0,W,H]. Dims
    // inconnues (0) → true (fail-open). Filtre l'overlay/compteur Studio sur ce qui
    // est réellement à l'écran (miroir front du drop offscreen/hors-région agent).
    function boxOnScreen(box, W, H) {
        if (!Array.isArray(box) || box.length !== 4
            || !box.every(function (n) { return typeof n === "number" && isFinite(n); })) return false;
        if (!W || !H) return true;
        return box[2] > 0 && box[3] > 0 && box[0] < W && box[1] < H;
    }

    var api = {
        ANCHOR_FIELDS: ANCHOR_FIELDS,
        boxOnScreen: boxOnScreen,
        realName: realName,
        volatileId: volatileId,
        anchorFromElement: anchorFromElement,
        elementParent: elementParent,
        elementAncestors: elementAncestors,
        elementChildren: elementChildren,
        elementRoots: elementRoots,
        elementPath: elementPath,
        parsePathSeg: parsePathSeg,
        resolvePath: resolvePath,
        elementDescendants: elementDescendants,
        isAmbiguous: isAmbiguous,
        deepestAt: deepestAt,
        nearestLabel: nearestLabel,
        windowAnchor: windowAnchor,
        a11yAudit: a11yAudit,
        a11yAuditCsv: a11yAuditCsv,
        INTERACTIVE_ROLES: INTERACTIVE_ROLES,
        elementLayers: elementLayers,
        filterByLayers: filterByLayers,
        layerOrdinal: layerOrdinal,
        EXPECT_KINDS: EXPECT_KINDS,
        clampTimeout: clampTimeout,
        diffElements: diffElements,
        defaultExpect: defaultExpect,
        inferDefaultExpect: inferDefaultExpect,
        expectFromElement: expectFromElement,
        summarizeExpect: summarizeExpect,
        isWindowRole: isWindowRole,
        pixelDiffRatio: pixelDiffRatio,
        elementTreeRows: elementTreeRows,
        pickActionArgs: pickActionArgs,
        scenarioStepFromAct: scenarioStepFromAct,
        scenarioStepFromDirect: scenarioStepFromDirect,
        resultOk: resultOk,
        summarizeStep: summarizeStep,
        hamming: hamming,
        frameEffect: frameEffect,
        pruneCycles: pruneCycles,
    };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;                 // Node (tests)
    }
    // Navigateur : expose les fonctions en globales pour _studio_automation.js.
    if (root) {
        Object.keys(api).forEach(function (k) { root[k] = api[k]; });
    }
})(typeof window !== "undefined" ? window : this);
