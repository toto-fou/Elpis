// SPDX-License-Identifier: MIT
// ============================================================
//  chat/_slash.js -- Le menu « / » du composeur (commandes,
//  skills, prompts sauvegardés).
//
//  Extrait de _compose.js (ex-lignes 377-551), qui portait déjà
//  deux sous-systèmes (@mention + « / ») pour 682 lignes. Le
//  moteur de commandes ajoutant registre, arguments et niveaux
//  de complétion, il vit désormais dans son propre module.
//
//  Modèle : le menu « / » de la page Code (chat/_code_menu.js),
//  nettement plus mature. On en reprend telles quelles :
//    * le tri « startsWith puis includes » (_code_menu.js:122-130)
//    * l'état « dismissed » : Échap ferme jusqu'à la frappe
//      suivante sans rien détruire (:43, :581-585)
//    * l'auto-scroll par scrollIntoView (:657-663)
//    * la cascade clavier, Tab = Entrée (:664-746)
//    * le re-parse À L'ENVOI de la commande tapée à la main
//      (:752-773) — sans lui, « /plan on » partirait au modèle
//    * la toast de confirmation, variante info pour un no-op
//      (:223-226) : sans retour, une commande ressemble à une
//      frappe perdue
//
//  Deux régimes de détection (cf. _slashCtx) :
//    * TÊTE    « /nom arg1 arg2 » depuis le début du composeur —
//               les arguments sont autorisés
//    * INLINE  « …texte /frag » au fil de la phrase — régime
//               historique du menu /skill, sans argument
//
//  État DÉRIVÉ (computed) plutôt que muté : l'ancien `slashMode`
//  était impératif et COLLAIT (une fois passé en « skills »,
//  effacer jusqu'à /co ne revenait jamais aux commandes).
//
//  Dépendances injectées :
//    * sharedRefs.inputRef, inputMessage, isStreaming
//    * sharedRefs.showMentionDropdown -- @mention reste prioritaire
//    * ctx.fetchAuth, ctx.showToast, ctx.autoResize
//    * ctx.manualCompress   -- /compact
//    * ctx.openSettingsTab  -- /settings, /memory, /usage
//    * ctx.openHelp         -- /help
//    * ctx.setPlanMode      -- /plan
//    * ctx.imageSlash       -- /image
//    * ctx.env              -- getter {chatId, isStreaming, planMode, imageAvailable}
// ============================================================

function setupChatSlash(vue, sharedRefs, ctx) {
    const { ref, computed, nextTick } = vue;
    const { inputRef, inputMessage, showMentionDropdown } = sharedRefs;
    // Templates de prompt (chat/_templates.js) — absent = pas de /template.
    const templates = sharedRefs.templates || null;
    const { fetchAuth, showToast } = ctx;

    // ── État du menu ──────────────────────────────────────────────
    // slashRaw : contexte de saisie, POUSSÉ par l'événement input.
    // Ce n'est délibérément pas un computed : il dépend de
    // ``selectionStart``, qui n'est pas une source réactive — un
    // computed ne serait jamais réévalué au déplacement du curseur.
    const slashRaw       = ref(null);
    const slashDismissed = ref(false);  // Échap, non destructif
    const slashIdx       = ref(0);      // rangée sélectionnée au clavier
    // Sous-niveau CHOISI explicitement (/skills, /prompt). Le reste
    // du niveau se déduit de la saisie ; celui-ci ne peut pas, la
    // frappe « / » seule étant ambiguë entre la racine et un retour
    // dans la liste ouverte.
    const slashSub       = ref(null);   // null | 'skills' | 'prompts'

    // Skills épinglés : chips au-dessus du composeur. À l'envoi,
    // app-chat.js transmet leurs noms dans ``pinned_skills`` → le
    // backend injecte leur corps de force (en plus de l'auto-matching).
    const pinnedSkills   = ref([]);

    // ── Caches ────────────────────────────────────────────────────
    // ⚠ Ces caches sont des ref() et NON des variables plates : ils
    // sont lus par des computed (slashList). Un ``let`` ordinaire ne
    // déclencherait aucune réévaluation au retour du fetch, et le menu
    // resterait vide jusqu'à la frappe suivante. L'ancien code s'en
    // sortait parce qu'il réassignait skillFiltered.value à la main.
    const _skillAll      = ref([]);
    const _promptAll     = ref([]);
    let   _skillCacheAt  = 0;
    let   _promptCacheAt = 0;
    const CACHE_MS       = 30000;

    // Les pages de gestion émettent ces événements après tout CRUD →
    // on invalide, sinon le menu reste périmé jusqu'à expiration du TTL.
    if (typeof window !== 'undefined') {
        window.addEventListener('skills:changed', function () {
            _skillCacheAt = 0; _skillAll.value = [];
        });
        window.addEventListener('prompts:changed', function () {
            _promptCacheAt = 0; _promptAll.value = [];
        });
    }

    async function _loadSkills() {
        if (Date.now() - _skillCacheAt < CACHE_MS && _skillAll.value.length) return;
        try {
            const res = await fetchAuth('/api/skills', {}, true);
            if (res && res.ok) {
                const data = await res.json();
                _skillAll.value = Array.isArray(data.skills) ? data.skills : [];
                _skillCacheAt   = Date.now();
            }
        } catch (e) { /* silencieux : la commande ne marchera juste pas */ }
    }

    // Prompts personnels ET reçus en partage : deux routes, une seule
    // liste. Le partage entre utilisateurs existe déjà côté Paramètres,
    // il n'y a aucune raison de ne pas le servir ici aussi.
    async function _loadPrompts() {
        if (Date.now() - _promptCacheAt < CACHE_MS && _promptAll.value.length) return;
        const out = [];
        try {
            const res = await fetchAuth('/api/prompts', {}, true);
            if (res && res.ok) {
                const data = await res.json();
                (data.items || []).forEach(function (p) {
                    if (p && p.content) out.push({
                        id: p.id, title: p.title || '', content: p.content, shared: false,
                    });
                });
            }
        } catch (e) { /* silencieux */ }
        try {
            const res = await fetchAuth('/api/prompts/shared', {}, true);
            if (res && res.ok) {
                const data = await res.json();
                (data.items || []).forEach(function (p) {
                    if (p && p.content) out.push({
                        id: 's' + p.id, title: p.title || '', content: p.content,
                        shared: true, from: p.from_username || '',
                    });
                });
            }
        } catch (e) { /* silencieux */ }
        _promptAll.value  = out;
        _promptCacheAt    = Date.now();
    }

    // ── Le registre ───────────────────────────────────────────────
    // Une commande :
    //   name      canonique, sans slash
    //   label     UN ou DEUX mots (règle UX maison : pas de phrase)
    //   desc      une ligne — 2e ligne de la rangée ET title= complet
    //   icon      classe Phosphor LITTÉRALE (jamais composée à la volée)
    //   args[]    [{name, label, values}] — absent = commande sans argument
    //   when(env) disponibilité ; whenLabel = la RAISON, dite à l'utilisateur
    //   mode      bascule vers un sous-niveau au lieu d'exécuter
    //   run(args) async → {ok, msg, info?, silent?}
    // Onglets réels de la modale Paramètres (includes/modals/settings.html).
    // Table LITTÉRALE : ces identifiants sont ceux que settingsTab attend.
    const SETTINGS_TABS = [
        { value: 'profile',     label: 'Profil'        },
        { value: 'chat',        label: 'Chat'          },
        { value: 'ai_models',   label: 'Moteurs'       },
        { value: 'appearance',  label: 'Apparence'     },
        { value: 'features',    label: 'Fonctions'     },
        { value: 'usage',       label: 'Utilisation'   },
        { value: 'memory',      label: 'Mémoire'       },
        { value: 'agents',      label: 'Agents'        },
        { value: 'prompts',     label: 'Prompts'       },
        { value: 'skills',      label: 'Skills'        },
        { value: 'archives',    label: 'Archives'      },
        { value: 'sandbox',     label: 'Sandbox'       },
        { value: 'connectors',  label: 'Connecteurs'   },
    ];

    const SLASH_CORE = [
        {
            name: 'skills', label: 'Skills', icon: 'ph-graduation-cap',
            desc: 'Parcourir et épingler un skill dans le prompt',
            mode: 'skills',
        },
        {
            name: 'prompt', label: 'Prompts', icon: 'ph-bookmark-simple',
            desc: 'Reprendre un prompt sauvegardé ou reçu',
            mode: 'prompts',
        },
        {
            // (2026-09-21) Template de prompt : « /template <nom> ». Les
            // valeurs de l'argument sont les templates du compte (getter :
            // la liste suit le cache réactif) ; la dernière rangée ouvre la
            // création. Le texte est inséré après saisie des variables.
            name: 'template', label: 'Templates', icon: 'ph-brackets-curly',
            desc: 'Insérer un template de prompt, variables à remplir',
            args: [{
                name: 'nom', label: 'nom',
                get values() {
                    const list = templates ? templates.templatesAll.value : [];
                    return list.map(t => ({ value: t.name, label: t.title || t.name }))
                        .concat([{ value: '+', label: 'Nouveau template', last: true }]);
                },
            }],
            when:      () => !!templates,
            whenLabel: 'Indisponible',
            run: async (a) => templates.runTemplateByName(a[0] || ''),
        },
        {
            name: 'plan', label: 'Mode plan', icon: 'ph-binoculars',
            desc: "Préparer un plan : outils d'écriture retirés jusqu'à la réponse",
            // SANS sous-menu on/off (retour utilisateur 2026-08-16) :
            // sélectionner la rangée BASCULE immédiatement. Le mode est
            // ONE-SHOT — le serveur le coupe lui-même à la fin du tour rendu
            // (event 'final', plan_mode_done) ; « /plan » sert donc à l'armer,
            // ou à le couper à la main avant d'avoir envoyé.
            // Chat vierge ADMIS : le mode s'ARME localement et est scellé à
            // la création du chat (préparer un plan AVANT d'agir est tout
            // l'intérêt). Bloqué PENDANT une génération : le tour en cours a
            // déjà ses outils — un témoin qui basculerait au milieu mentirait
            // jusqu'à la fin du tour.
            when:      (env) => !env.isStreaming,
            whenLabel: 'Hors génération',
            run: async (a) => {
                const avant = !!ctx.env.planMode;
                // « on »/« off » TAPÉS restent honorés (mémoire musculaire) :
                // sans ça, « /plan off » mode déjà coupé l'ACTIVERAIT
                // (bascule inversée). Tout autre argument = bascule simple.
                const on = (a[0] === 'on') ? true
                         : (a[0] === 'off') ? false
                         : !avant;
                if (on === avant) {
                    return { ok: true, info: true,
                             msg: 'Mode plan déjà ' + (on ? 'actif.' : 'coupé.') };
                }
                const ok = await ctx.setPlanMode(on);
                if (!ok) return { ok: false, msg: 'Bascule impossible.' };
                if (on && !ctx.env.chatId) {
                    return { ok: true, msg: 'Mode plan armé — la '
                        + "conversation démarrera sans outils d'écriture." };
                }
                return { ok: true, msg: on
                    ? "Mode plan actif — outils d'écriture retirés jusqu'à la réponse."
                    : 'Mode plan coupé.' };
            },
        },
        {
            // « /image [ratio] [xN] description » : envoie la demande au
            // moteur d'images sans ouvrir le mode ; seule, ouvre le mode.
            // Absente du menu pour un compte sans moteur d'images.
            name: 'image', label: 'Images', icon: 'ph-image',
            desc: 'Générer une image : /image 16:9 x2 description',
            hidden:    (env) => !env.imageAvailable,
            when:      (env) => !env.isStreaming,
            whenLabel: 'Hors génération',
            run: async (_a, raw) => (ctx.imageSlash ? ctx.imageSlash(raw)
                : { ok: false, msg: 'Génération d’images indisponible.' }),
        },
        {
            name: 'compact', label: 'Compacter', icon: 'ph-arrows-in-simple',
            desc: "Résume l'historique ancien pour libérer du contexte",
            when:      (env) => !!env.chatId && !env.isStreaming,
            whenLabel: 'Demande une conversation en cours, hors génération',
            // silent : manualCompress pose DÉJÀ sa barre de progression puis
            // sa notice. Une toast en plus ferait doublon avec plus riche.
            run: async () => { await ctx.manualCompress(); return { ok: true, silent: true }; },
        },
        {
            name: 'settings', label: 'Réglages', icon: 'ph-gear',
            desc: 'Ouvrir les réglages sur un onglet',
            args: [{ name: 'onglet', label: 'onglet', values: SETTINGS_TABS }],
            run: async (a) => {
                const tab = a[0]
                    ? (SETTINGS_TABS.find(t => t.value === a[0]) || null)
                    : null;
                if (a[0] && !tab) return { ok: false, msg: 'Onglet inconnu : ' + a[0] };
                await ctx.openSettingsTab(tab ? tab.value : null);
                return { ok: true, silent: true };   // l'écran qui s'ouvre EST le retour
            },
        },
        {
            name: 'memory', label: 'Mémoire', icon: 'ph-brain',
            desc: 'Ouvrir la mémoire long terme',
            run: async () => { await ctx.openSettingsTab('memory'); return { ok: true, silent: true }; },
        },
        {
            name: 'usage', label: 'Utilisation', icon: 'ph-chart-bar',
            desc: 'Ouvrir votre consommation',
            run: async () => { await ctx.openSettingsTab('usage'); return { ok: true, silent: true }; },
        },
        {
            name: 'help', label: 'Aide', icon: 'ph-question',
            desc: 'Ouvrir la documentation',
            run: async () => { await ctx.openHelp(); return { ok: true, silent: true }; },
        },
    ];

    // Commande cachée dans le contexte courant (ex. /image sans moteur) :
    // absente du menu et jamais résolue — le texte part tel quel.
    function _cmdHidden(cmd) {
        if (!cmd || typeof cmd.hidden !== 'function') return false;
        try { return !!cmd.hidden(ctx.env || {}); } catch (e) { return false; }
    }

    function _findCmd(name) {
        const n = String(name || '').toLowerCase();
        return SLASH_CORE.find(c => c.name === n && !_cmdHidden(c)) || null;
    }

    // Disponibilité d'une commande dans le contexte courant.
    function slashCmdOk(cmd) {
        if (!cmd || typeof cmd.when !== 'function') return true;
        try { return !!cmd.when(ctx.env || {}); } catch (e) { return true; }
    }

    // ── Détection du contexte de saisie ───────────────────────────
    function _slashCtx() {
        const el = inputRef.value;
        if (!el) return null;
        const cursor = el.selectionStart;
        const before = (inputMessage.value || '').substring(0, cursor);

        // Régime TÊTE — « /nom arg1 arg2… » depuis le tout début.
        // [^\n] : un Maj+Entrée termine la commande, on retombe en
        // texte libre et le menu se ferme.
        const head = before.match(/^\/([\w.\-]*)((?:[ \t]+[^\n]*)?)$/);
        if (head) {
            const brut = (head[2] || '').replace(/^[ \t]+/, '');
            return {
                head: true, name: head[1], raw: brut,
                words: brut ? brut.split(/[ \t]+/) : [],
                hasSpace: !!head[2],
                trailing: /[ \t]$/.test(before),   // on commence un NOUVEL argument
                start: 0, end: cursor,
            };
        }
        // Régime INLINE — fragment au fil du texte. Comportement
        // historique du menu /skill, conservé à l'identique : pas
        // d'argument, pour ne pas casser « explique-moi /rediger ».
        const m = before.match(/(?:^|\s)\/([\w.\-]*)$/);
        return m ? {
            head: false, name: m[1], raw: '', words: [], hasSpace: false,
            trailing: false, start: cursor - m[1].length - 1, end: cursor,
        } : null;
    }

    // ── Listes dérivées ───────────────────────────────────────────
    function _pack(src, q, textOf) {
        // Tri en DEUX paquets : préfixe d'abord, sous-chaîne ensuite,
        // chaque paquet trié. Bien plus pertinent qu'un startsWith seul.
        const byName = (a, b) => textOf(a).localeCompare(textOf(b));
        const starts = src.filter(x => textOf(x).toLowerCase().startsWith(q));
        const inside = q
            ? src.filter(x => !textOf(x).toLowerCase().startsWith(q)
                           && textOf(x).toLowerCase().includes(q))
            : [];
        return [...starts.sort(byName), ...inside.sort(byName)];
    }

    const _query = computed(() => ((slashRaw.value && slashRaw.value.name) || '').toLowerCase());

    const slashCmdList = computed(() => _pack(SLASH_CORE.filter(c => !_cmdHidden(c)), _query.value, c => c.name));

    const slashSkillList = computed(() => {
        const q = _query.value.trim();
        const list = !q ? _skillAll.value : _skillAll.value.filter(s => {
            const hay = [s.name, s.description, s.domain,
                         (s.tags || []).join(' ')].join(' ').toLowerCase();
            return hay.includes(q);
        });
        // Tri stable : par domaine puis nom (cohérent avec l'index backend)
        return list.slice().sort((a, b) =>
            (a.domain || '').localeCompare(b.domain || '') ||
            (a.name || '').localeCompare(b.name || ''));
    });

    const slashPromptList = computed(() => {
        const q = _query.value.trim();
        if (!q) return _promptAll.value.slice();
        return _promptAll.value.filter(p =>
            (p.title + ' ' + p.content).toLowerCase().includes(q));
    });

    // Valeurs proposées pour l'argument en cours de frappe.
    const slashValueList = computed(() => {
        const c   = slashRaw.value;
        const cmd = c && c.head ? _findCmd(c.name) : null;
        if (!cmd || !(cmd.args || []).length) return [];
        // Espace final ⇒ on commence un nouvel argument.
        const i    = c.trailing ? c.words.length : Math.max(0, c.words.length - 1);
        const spec = cmd.args[Math.min(i, cmd.args.length - 1)];
        if (!spec || !spec.values) return [];
        const q = (c.trailing ? '' : (c.words[c.words.length - 1] || '')).toLowerCase();
        // ``last`` : rangée d'action (« Nouveau template ») gardée EN DERNIER,
        // hors du tri par nom — et seulement tant qu'aucun filtre n'est tapé.
        const packed = _pack(spec.values.filter(v => !v.last), q, v => v.value);
        return q ? packed : packed.concat(spec.values.filter(v => v.last));
    });

    // Niveau courant, entièrement dérivé.
    const slashLevel = computed(() => {
        const c = slashRaw.value;
        if (!c) return 'commands';
        // Sous-niveau explicitement ouvert (/skills, /prompt) : il tient
        // tant que la saisie reste un fragment simple, sans argument.
        if (slashSub.value && !c.hasSpace) return slashSub.value;
        if (c.head) {
            const exact = _findCmd(c.name);
            if (exact && c.hasSpace && (exact.args || []).length) return 'values';
        }
        if (slashCmdList.value.length) return 'commands';
        // Aucune commande ne matche (« /crea ») → on bascule sur les
        // skills et on filtre. Rétrocompatibilité « muscle memory » du
        // menu /skill historique : à conserver.
        return 'skills';
    });

    const slashList = computed(() => {
        switch (slashLevel.value) {
            case 'values':  return slashValueList.value;
            case 'skills':  return slashSkillList.value;
            case 'prompts': return slashPromptList.value;
            default:        return slashCmdList.value;
        }
    });

    const showSlash = computed(() =>
           slashRaw.value !== null
        && !slashDismissed.value
        && !(showMentionDropdown && showMentionDropdown.value)   // @mention prioritaire
        && slashList.value.length > 0);

    // ── Écriture dans la textarea ─────────────────────────────────
    // Remplace le fragment « /… » consommé. Généralise l'ancien
    // _stripSlashFragment, qui calculait sa fin depuis skillQuery :
    // avec des arguments, la longueur consommée doit être explicite.
    function _replaceSpan(sctx, texte) {
        if (!sctx) return;
        const rep    = texte || '';
        const before = (inputMessage.value || '').substring(0, sctx.start);
        const after  = (inputMessage.value || '').substring(sctx.end);
        inputMessage.value = before + rep + after;
        const pos = sctx.start + rep.length;
        nextTick(function () {
            if (inputRef.value) {
                inputRef.value.setSelectionRange(pos, pos);
                inputRef.value.focus();
            }
            ctx.autoResize && ctx.autoResize();
        });
    }

    function _refresh() {
        slashRaw.value = _slashCtx();
        if (slashRaw.value === null) slashSub.value = null;
        slashIdx.value = 0;
    }

    // ── Exécution ─────────────────────────────────────────────────
    async function slashRun(hit) {
        if (!hit || !hit.cmd) return;
        const cmd = hit.cmd;
        if (!slashCmdOk(cmd)) {
            showToast(cmd.whenLabel || 'Indisponible ici.', 'error');
            return;
        }
        let out;
        try {
            out = await cmd.run(hit.args || [], hit.raw || '');
        } catch (e) {
            showToast('Échec de /' + cmd.name, 'error');
            return;
        }
        out = out || { ok: true };
        // Une commande DOIT confirmer : sans retour visible, elle
        // ressemble à une frappe perdue. Sauf celles qui ont déjà
        // leur propre rendu (progression, écran qui s'ouvre).
        if (!out.silent && out.msg) {
            showToast(out.msg, out.ok ? (out.info ? 'info' : 'success') : 'error');
        }
    }

    // Vide le composeur puis exécute (chemin « sélection dans le menu »).
    async function _consumeAndRun(cmd, args, raw) {
        _replaceSpan(slashRaw.value, '');
        slashDismissed.value = true;
        slashSub.value       = null;
        await slashRun({ cmd, args: args || [], raw: raw || '' });
    }

    // ── Sélection d'une rangée ────────────────────────────────────
    async function selectSlash(item) {
        if (!item) return;
        const lvl = slashLevel.value;
        if (lvl === 'skills')  return selectSkill(item);
        if (lvl === 'prompts') return selectPrompt(item);
        if (lvl === 'values')  return selectValue(item);

        const cmd = item;
        // Bascule de sous-niveau : on garde le « / » pour que la frappe
        // suivante filtre la liste ouverte.
        if (cmd.mode) {
            _replaceSpan(slashRaw.value, '/');
            slashSub.value = cmd.mode;
            if (cmd.mode === 'skills')  await _loadSkills();
            if (cmd.mode === 'prompts') await _loadPrompts();
            nextTick(_refresh);
            return;
        }
        // Commande à arguments : on insère « /nom » et on laisse
        // l'utilisateur choisir sa valeur dans le menu qui suit.
        if ((cmd.args || []).length) {
            if (cmd.name === 'template' && templates) await templates.loadTemplates();
            _replaceSpan(slashRaw.value, '/' + cmd.name + ' ');
            nextTick(_refresh);
            return;
        }
        // Arguments TAPÉS à la main (régime tête) : relayés au run —
        // seulement si la rangée validée EST la commande tapée (une
        // navigation aux flèches vers une autre rangée ne doit pas
        // hériter d'arguments qui ne la concernent pas). Sans ça,
        // « /plan on » validé menu ouvert perdait son « on » et la
        // bascule s'inversait (Entrée menu ≠ Entrée envoi).
        const c = slashRaw.value;
        const motsTapes = (c && c.head && Array.isArray(c.words)
                           && _findCmd(c.name) === cmd)
            ? c.words.filter(Boolean) : [];
        await _consumeAndRun(cmd, motsTapes, motsTapes.join(' '));
    }

    // Choix d'une valeur d'argument.
    async function selectValue(v) {
        const c = slashRaw.value;
        if (!c || !c.head || !v) return;
        const cmd = _findCmd(c.name);
        if (!cmd) return;
        const mots = c.trailing ? c.words.slice() : c.words.slice(0, -1);
        mots.push(v.value);
        const iSuivant = mots.length;   // index de l'argument suivant
        // Dernier argument déclaré → la commande est complète, on exécute.
        if (iSuivant >= (cmd.args || []).length) {
            await _consumeAndRun(cmd, mots, mots.join(' '));
            return;
        }
        _replaceSpan(c, '/' + cmd.name + ' ' + mots.join(' ') + ' ');
        nextTick(_refresh);
    }

    function selectSkill(skill) {
        if (!skill || !skill.name) return;
        _replaceSpan(slashRaw.value, '');
        slashDismissed.value = true;
        slashSub.value       = null;
        if (pinnedSkills.value.some(s => s.name === skill.name)) return;  // dédup
        pinnedSkills.value.push({
            name: skill.name, description: skill.description || '', domain: skill.domain || '',
        });
    }

    function removePinnedSkill(name) {
        pinnedSkills.value = pinnedSkills.value.filter(s => s.name !== name);
    }

    // Le prompt est INSÉRÉ, jamais envoyé : l'utilisateur relit puis
    // décide. Envoyer 800 mots sur une frappe d'Entrée serait brutal.
    function selectPrompt(p) {
        if (!p || !p.content) return;
        _replaceSpan(slashRaw.value, '');
        slashDismissed.value = true;
        slashSub.value       = null;
        nextTick(function () {
            inputMessage.value = p.content;
            nextTick(function () {
                if (inputRef.value) {
                    const n = (p.content || '').length;
                    inputRef.value.setSelectionRange(n, n);
                    inputRef.value.focus();
                }
                ctx.autoResize && ctx.autoResize();
            });
        });
    }

    // ── Résolution à l'ENVOI (commande tapée intégralement) ───────
    // Sans ce second point d'entrée, « /plan on » suivi d'Entrée part
    // au modèle comme un message. Une commande INCONNUE, elle, doit
    // partir normalement — d'où le retour null.
    function slashResolve(text) {
        const m = String(text || '').trim().match(/^\/([\w.\-]+)(?:[ \t]+([\s\S]*))?$/);
        if (!m) return null;          // « /srv/projet » ne matche pas : pas de /
        const cmd = _findCmd(m[1]);
        if (!cmd) return null;
        if (cmd.mode) return null;    // /skills, /prompt : menus, pas des actions
        const raw = (m[2] || '').trim();
        return { cmd, raw, args: raw ? raw.split(/[ \t]+/) : [] };
    }

    // ── Clavier / ouverture / fermeture ───────────────────────────
    function _scrollSlashItem(idx) {
        nextTick(function () {
            const list = document.getElementById('slash-list');
            if (!list) return;
            const item = list.querySelectorAll('li[data-slash-row]')[idx];
            if (item && item.scrollIntoView) item.scrollIntoView({ block: 'nearest' });
        });
    }

    function slashSetIdx(i) { slashIdx.value = i; }

    // Échap : ferme SANS détruire l'état ni vider la textarea. La
    // frappe suivante réarme (cf. onInput).
    function slashDismiss() { slashDismissed.value = true; }

    // Remise à zéro complète — appelée au changement de chat, sinon
    // le menu resterait ouvert sur des disponibilités calculées pour
    // la conversation précédente.
    function resetSlash() {
        slashRaw.value       = null;
        slashSub.value       = null;
        slashDismissed.value = false;
        slashIdx.value       = 0;
    }

    // Appelé par le handler input de _compose.js, APRÈS @mention.
    function onInput() {
        slashDismissed.value = false;      // réarmement
        _refresh();
        if (slashRaw.value === null) return;
        // Chargements paresseux, sans bloquer la frappe : les listes
        // sont dérivées, elles se peupleront toutes seules.
        const lvl = slashLevel.value;
        if (lvl === 'skills'  || slashSub.value === 'skills')  _loadSkills();
        if (lvl === 'prompts' || slashSub.value === 'prompts') _loadPrompts();
        const c = slashRaw.value;
        if (templates && c && c.head && 'template'.startsWith(String(c.name || '').toLowerCase())
                && String(c.name || '').length >= 2) templates.loadTemplates();
    }

    // Renvoie true si la touche a été consommée.
    function slashKeydown(e) {
        if (!showSlash.value) return false;
        const list = slashList.value;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            slashIdx.value = Math.min(slashIdx.value + 1, list.length - 1);
            _scrollSlashItem(slashIdx.value);
            return true;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            slashIdx.value = Math.max(slashIdx.value - 1, 0);
            _scrollSlashItem(slashIdx.value);
            return true;
        }
        // Tab vaut Entrée, comme sur la page Code.
        if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            const chosen = list[slashIdx.value];
            if (chosen) selectSlash(chosen);
            return true;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            slashDismiss();
            return true;
        }
        return false;
    }

    // ── Helpers d'affichage (template) ────────────────────────────
    // Tables LITTÉRALES : une classe d'icône composée à la volée serait
    // une classe morte (feuille précompilée).
    const HEADER_ICON = {
        commands: 'ph-terminal', values: 'ph-caret-right',
        prompts:  'ph-bookmark-simple', skills: 'ph-graduation-cap',
    };
    const HEADER_LABEL = {
        commands: 'Commandes', values: 'Valeurs',
        prompts:  'Prompts',   skills: 'Skills',
    };
    const slashHeaderIcon  = computed(() => HEADER_ICON[slashLevel.value]  || 'ph-terminal');
    const slashHeaderLabel = computed(() => HEADER_LABEL[slashLevel.value] || 'Commandes');

    function slashRowKey(item, i) {
        const k = item && (item.name || item.value || item.id);
        return k != null ? String(k) : 'row-' + i;
    }
    function promptPreview(p) {
        const t = String((p && p.content) || '').replace(/\s+/g, ' ').trim();
        return t.length > 90 ? t.slice(0, 90) + '…' : t;
    }
    // Le title= porte le texte COMPLET (règle UX maison : pas de
    // paragraphe dans le panneau, le détail est en infobulle) — et pour
    // une commande indisponible, la RAISON plutôt que la description.
    function slashRowTitle(item) {
        if (!item) return '';
        switch (slashLevel.value) {
            case 'commands': return slashCmdOk(item) ? (item.desc || '') : (item.whenLabel || '');
            case 'values':   return item.label || '';
            case 'prompts':  return item.content || '';
            default:         return item.description || '';
        }
    }

    return {
        // état lu par le template
        showSlash, slashLevel, slashList, slashIdx, slashRaw,
        pinnedSkills,
        // actions
        selectSlash, selectValue, selectSkill, selectPrompt, removePinnedSkill,
        slashDismiss, slashSetIdx, resetSlash, slashKeydown, onInput,
        // moteur (utilisé par _compose.js et app-chat.js)
        slashResolve, slashRun, slashCmdOk,
        // affichage
        slashRowKey, promptPreview, slashRowTitle,
        slashHeaderIcon, slashHeaderLabel,
    };
}

window.setupChatSlash = setupChatSlash;
