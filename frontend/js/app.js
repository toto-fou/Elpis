// SPDX-License-Identifier: MIT
// ============================================================
//  app.js -- Vue 3 root application  (Elpis Assistant)
//
//  Orchestrates:
//    setupAuth     (app-auth.js)
//    setupChat     (app-chat.js)
//    setupEditor   (app-editor.js)
//    setupAdmin    (app-admin.js)
//    setupSettings (app-settings.js)
//
//  Bugs fixed vs. the original (Alpine.js RAG-Manager) file:
//   • createApp / mount was never called → Vue never mounted
//   • ctx.checkAuth missing → crash on 401 in generateResponse
//   • ctx.chats missing → crash in logout
//   • liveLogs double-ref: admin created its own ref, SSE pushed
//     to root ref → log view stayed empty
//   • spread order wrong → module refs clobbered root refs
//   • showExportMenu not wired into ctx → admin export broken
//   • ctx.nextTick missing → admin dashboard chart render broken
// ============================================================

const { createApp, ref, computed, watch, nextTick,
        onMounted, onUnmounted } = Vue;

// -- Icon presets (admin welcome-screen picker) -----------------
const APP_ICON_PRESETS = [
    'ph-robot','ph-brain','ph-cpu','ph-magic-wand','ph-sparkle',
    'ph-star','ph-lightning','ph-rocket','ph-planet','ph-alien',
    'ph-ghost','ph-bug','ph-flower','ph-tree','ph-leaf',
    'ph-sun','ph-moon','ph-cloud','ph-fire','ph-snowflake',
    'ph-heart','ph-diamond','ph-crown','ph-trophy','ph-medal',
    'ph-shield','ph-lock','ph-key','ph-eye','ph-compass',
    'ph-map','ph-globe','ph-anchor','ph-airplane','ph-car',
    'ph-bicycle','ph-train','ph-boat','ph-buildings','ph-house',
    'ph-database','ph-hard-drives','ph-code','ph-terminal','ph-git-branch',
    'ph-chat','ph-chats','ph-envelope','ph-bell','ph-bookmark',
];

// -- KPI color → Tailwind class (admin dashboard cards) --------
function kpiIconClass(color) {
    // La couleur d'un KPI PORTE du sens (rose = ça va mal, emerald = ça va) :
    // toute teinte non listée retombait en gris, effaçant justement le signal
    // que le widget cherchait à donner. La table couvre donc l'intégralité de
    // la palette utilisée par les providers.
    const map = {
        blue:    'bg-blue-50 text-blue-600',
        sky:     'bg-sky-50 text-sky-600',
        cyan:    'bg-cyan-50 text-cyan-600',
        teal:    'bg-teal-50 text-teal-600',
        green:   'bg-emerald-50 text-emerald-600',
        emerald: 'bg-emerald-50 text-emerald-600',
        purple:  'bg-violet-50 text-violet-600',
        violet:  'bg-violet-50 text-violet-600',
        indigo:  'bg-indigo-50 text-indigo-600',
        red:     'bg-red-50 text-red-500',
        rose:    'bg-rose-50 text-rose-600',
        orange:  'bg-orange-50 text-orange-500',
        amber:   'bg-amber-50 text-amber-600',
        yellow:  'bg-yellow-50 text-yellow-600',
        slate:   'bg-slate-100 text-slate-600',
    };
    return map[(color || '').toLowerCase()] || 'bg-slate-100 text-slate-600';
}

// ===============================================================
const elpisApp = createApp({
    components: { TreeItem },

    setup() {

        // -- 1.  SHARED STATE  (single source of truth) ----------
        const user            = ref(null);
        const settings        = ref({
            enable_editor:        true,
            enable_preview:       false,
            editor_ratio:         50,
            chat_width:           70,
            assistant_name:       'Elpis',
            assistant_icon:       'ph-robot',
            assistant_avatar:     '',
            skin:                 'elpis',
            system_prompt:        '',
            mcp_servers:          [],
            sandbox_path_display: '',
            enable_model_selector: false,
        });
        const config = ref({ use_rag: false, rag_collection: '', rag_search_mode: 'classic', rag_use_mmr: false, active_mcp_ids: [] });
        const messages        = ref([]);
        const currentChatId   = ref(null);
        const inputMessage    = ref('');
        const inputRef        = ref(null);
        const isStreaming     = ref(false);
        const isAdminView     = ref(false);
        const isUserScrolling = ref(false);
        // « Loin du bas du chat ? » (seuil 240 px). Mis à jour par le handler
        // scroll SANS être soumis au lock anti-scroll-programmatique : la
        // visibilité du bouton « descendre » dépend de la POSITION (un fait),
        // pas de l'historique des gestes (une intention).
        // AUDIT 2026-08-31 — c'était la distance CONTINUE en px, alors que le
        // seul consommateur est ce seuil : chaque événement scroll et chaque
        // resize de la colonne (ResizeObserver, à chaque flush de stream
        // quand l'utilisateur a remonté) écrivait une valeur différente →
        // re-render de la RACINE (~11 700 lignes de gabarit) en pure perte.
        // En booléen, Vue ignore les écritures qui ne basculent pas.
        const chatAwayFromBottom = ref(false);
        const _CHAT_AWAY_PX = 240;
        const currentView     = ref('chat');
        // Repliée par défaut sous lg (1024px) : sinon le mobile démarre sur la
        // sidebar en overlay `fixed` qui masque tout le chat. Le hamburger
        // `lg:hidden` du header (chat.html) la rouvre ; loadChat/startNewChat
        // la referment à la navigation (même breakpoint 1024).
        const showSidebar     = ref(typeof window === 'undefined' || window.innerWidth >= 1024);
        const systemAlert     = ref('');
        // Ref `thinkingMode` retirée (refonte) : la réflexion est désormais pilotée
        // uniquement par samplingOverride.thinking_budget_tokens dans le panneau
        // Sampling. Budget > 0 → réflexion ON, sinon OFF.
        const showInfoModal   = ref(false);

        // -- OpenCode CLI installer --
        const showOpenCodeModal = ref(false);
        const openCodePlatform  = ref('linux');
        // Clé du bloc dont la commande vient d'être copiée ('install' | 'sync'), sinon ''.
        const openCodeCopied    = ref('');
        // (EXT.1) Le jeton elpis-remote n'est plus réaffichable (empreinte seule
        // côté serveur) : la re-synchronisation LIT celui du poste, dans
        // ``~/.config/opencode/elpis-remote.json`` (posé par l'installeur ou
        // l'appairage). Aucun jeton ne transite donc par la page.
        // Familles d'outils publiées à opencode (une entrée MCP — donc une
        // bascule — par famille). Liste SERVEUR (config + outils réellement
        // enregistrés) : le front n'en garde aucune copie figée.
        const openCodeFamilies = ref([]);
        watch(showOpenCodeModal, async (open) => {
            if (!open) return;
            try {
                const r = await fetchAuth('/api/cli/opencode/families', {}, true);
                openCodeFamilies.value = (r && r.ok) ? ((await r.json()).families || []) : [];
            } catch (_) { openCodeFamilies.value = []; }
        });
        // PAS de jeton dans la commande. L'appairage se fait APRÈS l'install, depuis
        // opencode : `/remote login` affiche un code à saisir dans la page « Code »
        // (device flow). Embarquer le jeton allongeait la commande, la rendait
        // per-user (impossible à partager/documenter) et la faisait finir dans les
        // historiques shell. L'installeur pose quand même app_url + CA épinglée.
        // Base d'AMORÇAGE : volontairement en http sur :80 quand l'app est
        // derrière le frontal TLS. La machine cible ne connaît pas encore la CA
        // locale (cert LAN auto-signé) : en https il fallait donc désactiver la
        // vérification AVANT même de télécharger le script — d'où l'ancien
        // préambule PowerShell de ~400 caractères (TLS 1.2 forcé + callback C#
        // compilé), long et cassant selon la version de .NET. Caddy sert ces
        // routes publiques en clair (deploy/caddy › @bootstrap) ; le script
        // téléchargé, lui, épingle ensuite la CA pour tout ce qui parle à l'app.
        const openCodeBootBase = computed(() =>
            window.location.protocol === 'https:'
                ? `http://${window.location.hostname}`
                : window.location.origin);
        const openCodeCommand   = computed(() => {
            const server = openCodeBootBase.value;
            if (openCodePlatform.value === 'windows') {
                // irm (pas iwr) : Invoke-RestMethod ne passe jamais par le moteur
                // de parsing HTML d'IE — rien à configurer sur un poste vierge.
                return `iex(irm ${server}/opencode.ps1)`;
            }
            return `curl -fsSL ${server}/opencode | bash`;
        });
        // Re-sync de la seule config (endpoint + modèles + outils Elpis), sans
        // réinstaller. Le jeton est lu SUR LE POSTE (elpis-remote.json) et part
        // vers l'APP (jamais sur l'amorçage en clair) ; poste non appairé →
        // jeton vide → config sans bloc ``mcp``.
        const openCodeSyncCommand = computed(() => {
            const base = window.location.origin;
            if (openCodePlatform.value === 'windows') {
                return `$t = (Get-Content "$env:USERPROFILE\\.config\\opencode\\elpis-remote.json" -Raw | ConvertFrom-Json).token; `
                    + `irm -Headers @{ 'x-elpis-token' = "$t" } ${base}/api/cli/opencode.json -OutFile "$env:USERPROFILE\\.config\\opencode\\opencode.json"`;
            }
            return `T="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' ~/.config/opencode/elpis-remote.json | head -n1)"; `
                + `curl -fsSL -H "x-elpis-token: $T" ${base}/api/cli/opencode.json -o ~/.config/opencode/opencode.json`;
        });
        let _openCodeCopyTimer = null;   // (passe 9, F12) une seule minuterie « Copié »
        async function copyOpenCodeCommand(kind) {
            const text = kind === 'sync' ? openCodeSyncCommand.value : openCodeCommand.value;
            try {
                await navigator.clipboard.writeText(text);
                openCodeCopied.value = kind === 'sync' ? 'sync' : 'install';
                showToast('Commande copiée');
                if (_openCodeCopyTimer) clearTimeout(_openCodeCopyTimer);
                _openCodeCopyTimer = setTimeout(() => { openCodeCopied.value = ''; _openCodeCopyTimer = null; }, 2000);
            } catch(e) {
                showToast('Copie échouée', 'error');
            }
        }
        function downloadOpenCodeBundle() {
            const url = `/api/cli/bundle/${openCodePlatform.value}`;
            const a = document.createElement('a');
            a.href = url;
            // le nom réel vient du Content-Disposition serveur ; fallback à l'extension correcte
            a.download = `opencode-${openCodePlatform.value}.${openCodePlatform.value === 'windows' ? 'zip' : 'tar.gz'}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            showToast('Téléchargement démarré');
        }
        (function detectOpenCodeOS() {
            try {
                const ua = (navigator.userAgent || '').toLowerCase();
                if (ua.includes('windows'))      openCodePlatform.value = 'windows';
                else if (ua.includes('mac'))     openCodePlatform.value = 'macos';
                else                              openCodePlatform.value = 'linux';
            } catch(e) {}
        })();
        // -- end OpenCode --
        const showExportMenu  = ref(false);
        const imgZoom        = ref(null);   // URL of zoomed image (null = modal closed)

        // -- Centre de notifications (cloche sidebar) ----------------
        // Alimenté par les fins de run de routine (succès/échec), poussé en
        // live via le bus SSE (type:"notification") et listé via /api/notifications.
        const notifications    = ref([]);   // [{id, kind, title, body, ref_type, ref_id, read_at, created_at}]
        const notifUnread      = ref(0);    // compteur non-lus (badge) — maj par SSE + endpoint
        const showNotifPanel   = ref(false);
        const notifDropdownRef = ref(null);
        // Préférence per-appareil « notifications système » (OS). Opt-in, stockée
        // en localStorage (une permission navigateur est liée à l'appareil, pas
        // au compte). notifyOSSupported gate le toggle si l'API est absente.
        const notifyOSSupported = (typeof window !== 'undefined' && 'Notification' in window);
        // Les notifications navigateur exigent un CONTEXTE SÉCURISÉ : HTTPS, ou
        // http://localhost / 127.0.0.1. Servie en HTTP sur une IP de LAN, l'app
        // est en contexte non sécurisé → le navigateur refuse la permission
        // d'office (cause classique d'un « refus » à l'activation).
        const notifyOSSecure = (typeof window === 'undefined') || (window.isSecureContext !== false);
        const notifyOSEnabled   = ref(false);
        try { notifyOSEnabled.value = (typeof localStorage !== 'undefined' && localStorage.getItem('elpis.notifyOS') === '1'); } catch (_) {}
        const notifLoading = ref(false);   // fetch en cours (spinner panneau)
        const notifError   = ref(false);   // dernier fetch en erreur (message + Réessayer)
        const notifHasMore = ref(false);   // un lot plein → « Voir plus » dispo
        const notifNowTick = ref(0);       // horloge réactive (rafraîchit les « il y a … »)
        // Surlignage « nouveau » de la session courante : indépendant de read_at
        // (qu'on solde à l'ouverture), pour garder un repère visuel cohérent sans
        // que le badge et le surlignage divergent après un reload. Set réassigné
        // pour la réactivité Vue.
        const notifNewIds  = ref(new Set());
        const NOTIF_PAGE   = 50;           // taille de lot (aligne le cap serveur)

        // liveLogs: ONE shared ref -- chat SSE writes here,
        //           admin log view reads here.
        // admin module creates its own internal liveLogs ref;
        // we OVERRIDE it at the bottom of the return spread.
        const liveLogs = ref([]);

        const appInfo = ref({
            name:        'Elpis',
            version:     '1.0.0',
            teamName:    '',
            engine:      'llama.cpp',
            description: '',
            iconType:    'phosphor',
            icon:        'ph-robot',
            iconColor:   '#ffffff',
            iconBg:      '#0f172a',
            logoBb64:    '',
        });

        // -- 2.  TOAST SYSTEM ------------------------------------
        const toasts = ref([]);

        function showToast(message, type, opts) {
            type = type || 'success';
            opts = opts || {};
            const id = Date.now() + Math.random();
            const duration = typeof opts.duration === 'number' ? opts.duration : 4000;
            // (2026-09-20) Deux toasts IDENTIQUES (même texte, même type, sans
            // action ni rappel) ne s'empilent plus : le premier est prolongé.
            // Vu avec deux Ctrl+S rapprochés : deux « Sauvegardé ! » superposés.
            if (!opts.actionLabel && !opts.onExpire) {
                const same = toasts.value.find(x => x.message === message && x.type === type
                                                    && !x.actionLabel && !x.onExpire);
                if (same) {
                    if (same._timer) clearTimeout(same._timer);
                    same._timer = setTimeout(() => {
                        toasts.value = toasts.value.filter(x => x.id !== same.id);
                    }, duration);
                    return same.id;
                }
            }
            const toast = { id, message, type };
            if (opts.actionLabel && typeof opts.onAction === 'function') {
                toast.actionLabel = opts.actionLabel;
                toast.onAction = opts.onAction;
            }
            if (typeof opts.onExpire === 'function') {
                toast.onExpire = opts.onExpire;
            }
            toasts.value.push(toast);
            const timer = setTimeout(() => {
                const t = toasts.value.find(x => x.id === id);
                toasts.value = toasts.value.filter(x => x.id !== id);
                if (t && t.onExpire) { try { t.onExpire(); } catch(_) {} }
            }, duration);
            toast._timer = timer;
            return id;
        }

        function removeToast(id, runExpire) {
            const t = toasts.value.find(x => x.id === id);
            if (t && t._timer) clearTimeout(t._timer);
            toasts.value = toasts.value.filter(x => x.id !== id);
            if (runExpire && t && t.onExpire) { try { t.onExpire(); } catch(_) {} }
        }

        // -- 2bis.  ANNOUNCER (a11y) --------------
        // Région sr-only unique (#elpis-announcer dans app_chrome.html) pour
        // annoncer aux lecteurs d'écran les événements SANS UI dédiée :
        // fin de génération, sélection de modèle, mutations de todo…
        // (Les toasts/statuts ont déjà leurs régions aria-live propres.)
        const announcerText = ref('');
        const announcerAssertive = ref(false);
        let _announceTimer = null;
        function announce(message, assertive) {
            announcerAssertive.value = !!assertive;
            // Vider puis remplir au tick suivant force la relecture même si
            // le même texte est annoncé deux fois de suite.
            announcerText.value = '';
            if (_announceTimer) clearTimeout(_announceTimer);
            _announceTimer = setTimeout(function() { announcerText.value = String(message || ''); }, 30);
        }

        // -- 3.  MODAL (confirm / prompt) ------------------------
        const modalState = ref({
            isOpen: false, type: 'confirm',
            title: '', message: '',
            confirmLabel: 'Confirmer', cancelLabel: 'Annuler',
            isDanger: false, inputValue: '', placeholder: '',
            resolve: null,
        });
        const modalInputRef = ref(null);
        // a11y — conteneur du dialog (piège Tab) + garde de
        // focus : l'élément actif avant ouverture est restitué à la fermeture.
        const modalDialogRef = ref(null);
        const _modalFocusGuard = window.elpisFocusGuard();
        function onModalTabKey(e) {
            window.elpisTrapTab(e, modalDialogRef.value);
        }
        // a11y — ref sur le bouton Annuler du modal confirm : on le focalise à
        // l'ouverture pour donner un point d'entrée clavier et permettre
        // immédiatement Échap / Tab (le modal était jusque-là sans focus géré).
        const modalCancelRef = ref(null);

        function openConfirm(title, message, isDanger, confirmLabel, cancelLabel) {
            message  = message  || '';
            isDanger = isDanger || false;
            return new Promise(function(resolve) {
                _modalFocusGuard.remember();
                modalState.value = {
                    isOpen: true, type: 'confirm',
                    title, message,
                    confirmLabel: confirmLabel || (isDanger ? 'Supprimer' : 'Confirmer'),
                    cancelLabel: cancelLabel || 'Annuler',
                    isDanger, inputValue: '', placeholder: '',
                    resolve,
                };
                nextTick(function() {
                    if (modalCancelRef.value) modalCancelRef.value.focus();
                });
            });
        }

        function openPrompt(title, defaultValue, placeholder) {
            defaultValue = defaultValue || '';
            placeholder  = placeholder  || '';
            return new Promise(function(resolve) {
                _modalFocusGuard.remember();
                modalState.value = {
                    isOpen: true, type: 'prompt',
                    title, message: '',
                    confirmLabel: 'Valider', cancelLabel: 'Annuler',
                    isDanger: false,
                    inputValue: defaultValue, placeholder,
                    resolve,
                };
                nextTick(function() {
                    if (modalInputRef.value) modalInputRef.value.focus();
                });
            });
        }

        // Choix à plus de deux issues (« Enregistrer / Ne pas enregistrer /
        // Annuler », « Écraser / Comparer / Recharger »). ``choices`` =
        // [{ id, label, tone: 'primary' | 'danger' | 'neutral' }] ; la
        // promesse rend l'``id`` choisi, ou null (Annuler, Échap, clic dehors).
        // ``cancelLabel`` optionnel : « Rester » pour une garde de sortie.
        function openChoice(title, message, choices, cancelLabel) {
            return new Promise(function(resolve) {
                _modalFocusGuard.remember();
                modalState.value = {
                    isOpen: true, type: 'choice',
                    title, message: message || '',
                    confirmLabel: '', cancelLabel: cancelLabel || 'Annuler',
                    isDanger: false, inputValue: '', placeholder: '',
                    choices: Array.isArray(choices) ? choices : [],
                    resolve: function(v) { resolve(v || null); },
                };
                nextTick(function() {
                    if (modalCancelRef.value) modalCancelRef.value.focus();
                });
            });
        }
        // Confirmation SAISIE pour l'irréversible (restauration, purge,
        // migration) : le bouton ne s'active qu'une fois ``word`` recopié —
        // un clic réflexe sur « Confirmer » ne suffit plus à tout effacer.
        function openTypedConfirm(title, message, word, confirmLabel) {
            return new Promise(function(resolve) {
                _modalFocusGuard.remember();
                modalState.value = {
                    isOpen: true, type: 'confirm',
                    title, message: message || '',
                    confirmLabel: confirmLabel || 'Confirmer', cancelLabel: 'Annuler',
                    // Pas de placeholder : le mot grisé se lisait comme une
                    // valeur déjà saisie.
                    isDanger: true, inputValue: '', placeholder: '',
                    requireText: word,
                    resolve,
                };
                nextTick(function() {
                    if (modalInputRef.value) modalInputRef.value.focus();
                });
            });
        }
        function modalTypedBlocked() {
            const m = modalState.value;
            if (!m.requireText) return false;
            return String(m.inputValue || '').trim().toLowerCase() !== String(m.requireText).toLowerCase();
        }
        function handleModalChoice(id) {
            if (!modalState.value.isOpen || !modalState.value.resolve) return;
            modalState.value.resolve(id);
            modalState.value.isOpen = false;
            _modalFocusGuard.restore();
        }

        function handleModalSubmit() {
            if (!modalState.value.isOpen || !modalState.value.resolve) return;
            if (modalTypedBlocked()) return;
            const result = modalState.value.type === 'prompt'
                ? (modalState.value.inputValue || null)
                : true;
            modalState.value.resolve(result);
            modalState.value.isOpen = false;
            _modalFocusGuard.restore();
        }

        function handleModalCancel() {
            if (modalState.value.resolve) modalState.value.resolve(false);
            modalState.value.isOpen = false;
            _modalFocusGuard.restore();
        }

        // -- 4.  CONTEXT MENU ------------------------------------
        const contextMenu = ref({ isOpen: false, x: 0, y: 0, type: '', item: null });

        function openContextMenu(event, type, item) {
            // event.clientX/Y peuvent être 0 quand l'ouverture vient d'un bouton
            // "…" actionné au clavier (Entrée/Espace) plutôt que d'un clic droit.
            // On retombe alors sur la position de la ligne (getBoundingClientRect)
            // pour ancrer le menu près du déclencheur.
            let cx = event.clientX, cy = event.clientY;
            if ((!cx && !cy) && event.currentTarget && event.currentTarget.getBoundingClientRect) {
                const r = event.currentTarget.getBoundingClientRect();
                cx = r.left; cy = r.bottom;
            }
            const x = Math.min(cx, window.innerWidth  - 210);
            // Hauteur réelle du menu fichier (≈ 10 entrées) : la ligne visée en
            // bas de l'explorateur ouvrait un menu coupé par le bord.
            const y = Math.max(8, Math.min(cy, window.innerHeight - (type === 'chat' ? 230 : 360)));
            contextMenu.value = { isOpen: true, x, y, type, item };
            // a11y — mémorise l'élément actif AVANT de bouger
            // le focus : il sera restitué à la fermeture du menu.
            _menuFocusGuard.remember();
            // a11y — déplace le focus sur le 1er item à l'ouverture pour rendre
            // le menu pilotable au clavier (flèches + Entrée).
            nextTick(function() {
                const menu = document.getElementById('custom-context-menu');
                if (menu) {
                    const first = menu.querySelector('[role="menuitem"]');
                    if (first) first.focus();
                }
            });
        }

        const _menuFocusGuard = window.elpisFocusGuard();
        function closeContextMenu() {
            contextMenu.value.isOpen = false;
            _menuFocusGuard.restore();   // a11y — focus rendu au déclencheur
        }

        // a11y — navigation clavier dans le menu contextuel : flèches haut/bas
        // entre les items, Home/Fin aux extrémités. Escape est géré globalement
        // dans onGlobalKeydown. Les items eux-mêmes (role=menuitem) gèrent
        // Entrée/Espace nativement (ce sont des <button>).
        function onContextMenuKeydown(e) {
            if (!contextMenu.value.isOpen) return;
            const menu = document.getElementById('custom-context-menu');
            if (!menu) return;
            const items = Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]'));
            if (items.length === 0) return;
            const cur = items.indexOf(document.activeElement);
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                items[(cur + 1 + items.length) % items.length].focus();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                items[(cur - 1 + items.length) % items.length].focus();
            } else if (e.key === 'Home') {
                e.preventDefault();
                items[0].focus();
            } else if (e.key === 'End') {
                e.preventDefault();
                items[items.length - 1].focus();
            }
        }

        // -- 4.5.  SPLIT-APP NAVIGATION --------------------------------
        // Two refs that hold the URL of the OTHER process when APP_MODE
        // separates main from admin. Both are populated:
        //   1. SYNCHRONOUSLY at first paint, from window.__ADMIN_APP_URL__ /
        //      __MAIN_APP_URL__ — admin.html's bootstrap script sets the
        //      latter from the current host (a fallback like
        //      "http://host:8001/" derived from "http://host:8002/admin").
        //      That makes the "Retour à l'app" button work even before
        //      the /api/public-config response lands.
        //   2. ASYNCHRONOUSLY by app-auth.js:loadPublicConfig() once the
        //      backend tells us the canonical URLs (env vars
        //      ADMIN_PUBLIC_URL / MAIN_PUBLIC_URL on each process).
        //
        // We store them as Vue refs (not just window globals) because Vue 3
        // templates do NOT expose ``window`` to the bind/listener scope —
        // any ``:href="window.__X__"`` would compile but throw at runtime
        // ("window is undefined") in the Vue prod build. The refs must be
        // returned at the bottom of setup() so ``mainAppUrl``, ``goToAdmin``
        // etc. resolve against the component instance.
        const adminAppUrl = ref(
            (typeof window !== 'undefined' && typeof window.__ADMIN_APP_URL__ === 'string')
                ? window.__ADMIN_APP_URL__ : ''
        );
        const mainAppUrl = ref(
            (typeof window !== 'undefined' && typeof window.__MAIN_APP_URL__ === 'string')
                ? window.__MAIN_APP_URL__ : ''
        );
        // Feature flags GLOBAUX (toggle admin) — remplis par /api/public-config
        // (app-auth.js:loadPublicConfig). Défaut activé = rétro-compat (config sans
        // section ``features``). Les templates masquent les surfaces désactivées.
        // (``supervisor`` retiré : reste de la feature Superviseur supprimée —
        // loadPublicConfig ne renvoie plus que {opencode}.)
        // ``voice_*`` en défaut FALSE, à l'inverse des autres : un bouton micro
        // qui apparaît le temps d'un aller-retour réseau puis disparaît est pire
        // qu'un bouton qui n'arrive qu'une fois la réponse connue.
        const features = ref({ opencode: true, agents: true, office_preview: true,
                               voice_stt: false, voice_tts: false });

        // Bound to the sidebar's "Admin" button.
        //  - With split mode (adminAppUrl set): navigate the browser. The
        //    cookie is host-scoped so the session follows.
        //  - Without split (legacy / APP_MODE=full): toggle the in-page
        //    admin view as before. ``adminMod`` may be undefined here if
        //    setupAdmin failed silently (admin.html intentional minimal
        //    bundle), so we guard the call.
        //
        //  Defense-in-depth: if APP_MODE is split (`main` / `admin`) but
        //  ``adminAppUrl.value`` is empty for any reason (network error
        //  during loadPublicConfig, env var unset on a misconfigured
        //  deployment, …), synthesise a target URL client-side using
        //  the same heuristic as the backend's _synthesize_public_url.
        //  Without this, the button would silently fall through to the
        //  in-page admin view, which is exactly bug #3 in the user's
        //  report ("le bouton coté chatbot pour aller sur la page admin
        //  me renvoi sur l'ancienne page"). Belt and braces.
        function _synthesizeAdminUrl() {
            try {
                const u = new URL(window.location.href);
                if (u.port === '8001') {
                    return `${u.protocol}//${u.hostname}:8002/admin`;
                }
                // Default ports / non-pair ports → reverse-proxy convention
                return `${u.origin}/admin`;
            } catch(_) {
                return '';
            }
        }
        function goToAdmin(tab) {
            // ``tab`` optionnel : onglet admin cible (deep-link depuis une notif).
            // Garde anti-event : ``@click="goToAdmin"`` passe un MouseEvent en 1er
            // argument — on ne retient qu'une chaîne.
            const t = (typeof tab === 'string' && tab) ? tab : '';
            const _hash = t ? ('#' + t) : '';
            if (adminAppUrl.value) {
                window.location.href = adminAppUrl.value + _hash;
                return;
            }
            const appMode = (typeof window !== 'undefined' && window.__APP_MODE__) || '';
            if (appMode === 'main' || appMode === 'admin') {
                const synth = _synthesizeAdminUrl();
                if (synth) { window.location.href = synth + _hash; return; }
            }
            // True legacy single-process mode → in-page admin.
            if (adminMod && typeof adminMod.loadUsers === 'function') {
                adminMod.loadUsers();
            }
            // Identifiant actuel ou historique (#report, #connections…) : le
            // registre de la console le résout.
            if (t && adminMod && typeof adminMod.goAdminPage === 'function') adminMod.goAdminPage(t);
            isAdminView.value = true;
        }

        // Bound to the "Retour au chat" button in the admin sidebar
        // (includes/admin/sidebar.html) — used by BOTH admin.html and the
        // in-page admin view inside index.html.
        //
        //   • Split-mode (admin.html sets window.__ADMIN_ONLY_MODE__) :
        //     navigate to the peer main-app URL — there is no chat view
        //     to fall back to in this process.
        //   • Embedded mode (index.html) : just collapse the admin panel
        //     by flipping isAdminView back to false. No page reload, the
        //     chat state stays intact (open chat, scroll position, etc.).
        //
        // The sidebar's anchor keeps :href="mainAppUrl || '/'" so middle-
        // click / Ctrl-click still opens the main app in a new tab in
        // both modes — only plain clicks are intercepted (.prevent).
        async function goToMainApp() {
            const embedded = !(typeof window !== 'undefined' && window.__ADMIN_ONLY_MODE__);
            // Garde de sortie de la console (Enregistrer · Ignorer · Rester) dans
            // les DEUX modes : en mode séparé, la garde native de l'onglet ne
            // proposerait pas d'enregistrer ; une fois la page enregistrée ou
            // abandonnée, elle ne se déclenche plus.
            if (adminMod && typeof adminMod.adminConfirmLeave === 'function') {
                if (!(await adminMod.adminConfirmLeave())) return;
            }
            if (embedded) {
                isAdminView.value = false;
                return;
            }
            window.location.href = mainAppUrl.value || '/';
        }

        // -- 5.  AUTH FETCH --------------------------------------
        // Anti-rafale : une session qui expire fait tomber en 401 toutes les
        // requêtes en vol (poll de statut, sauvegarde, chargement). Un seul
        // message, pas dix.
        let _sessionExpiredNotified = false;

        // AUDIT 2026-08-02 (S3/S4) — traitement UNIQUE de la fin de session,
        // partagé par fetchAuth, l'event SSE ``session_expired``, le WS
        // terminal (close 4001) et les uploads XHR. Se contente de basculer
        // ``user`` à null : c'est le watcher user (plus bas) qui fait la
        // purge complète (messages, onglets Monaco, credentials git, SSE/WS,
        // modales) — ainsi TOUTE désauthentification purge, pas seulement
        // le logout volontaire.
        function _handleSessionExpired() {
            if (user.value !== null && !_sessionExpiredNotified) {
                _sessionExpiredNotified = true;
                setTimeout(() => { _sessionExpiredNotified = false; }, 10000);
                showToast('Session expirée — reconnectez-vous. '
                        + 'Les modifications non enregistrées seront perdues.',
                          'warning', { duration: 12000 });
            }
            user.value = null;
        }

        async function fetchAuth(url, options, soft) {
            options = options || {};
            soft    = soft    || false;
            // ``rethrowAbort`` : l'appelant qui abandonne sa requête veut voir
            // l'AbortError, pas un ``null`` indiscernable d'une panne réseau.
            const { rethrowAbort, ...fetchOptions } = options;
            try {
                const res = await fetch(url, { credentials: 'same-origin', ...fetchOptions });
                if (res.status === 401) {
                    // AUDIT 2026-08-02 (S4) — le 401 est traité MÊME en mode
                    // soft. « soft » ne doit taire que les erreurs réseau des
                    // polls de fond, pas l'expiration de session : avant, les
                    // ~53 call-sites soft (inbox 30 s, modèles 60 s, quota
                    // 10 s…) avalaient le 401 en silence — l'app restait
                    // affichée toute la nuit après expiration, et le premier
                    // message tapé le lendemain était perdu.
                    _handleSessionExpired();
                    return null;
                }
                if (res.status === 403) {
                    // AUDIT 2026-08-02 (S8) — deps.py promet depuis toujours
                    // que « le front intercepte le 403 must_change_password » :
                    // c'est désormais vrai. Sans ce bloc, un compte marqué
                    // « mot de passe à changer » voyait toutes ses actions
                    // échouer sans jamais recevoir l'écran de changement.
                    try {
                        const body = await res.clone().json();
                        if (body && body.detail === 'must_change_password' && authMod) {
                            if (!authMod.mustChangePassword.value) {
                                authMod.mustChangePassword.value = true;
                                showToast('Votre mot de passe doit être changé '
                                        + 'avant de continuer.', 'warning');
                            }
                            user.value = null;   // → carte de changement (auth_cards)
                            return null;
                        }
                    } catch (_) { /* corps non-JSON : 403 ordinaire */ }
                }
                return res;
            } catch(e) {
                // Une requête abandonnée par son appelant n'est pas une panne :
                // le toast « Erreur réseau » tombait à chaque Échap.
                if (e && e.name === 'AbortError') {
                    if (rethrowAbort) throw e;
                    return null;
                }
                if (!soft) showToast('Erreur réseau', 'error');
                return null;
            }
        }

        // fetchAuth ne traitait QUE le réseau et le 401 :
        // un 4xx/5xx revenait silencieux et chaque call-site devait tester
        // res.ok lui-même (beaucoup avalaient). fetchJsonAuth = même contrat
        // + toast sur !res.ok + parse JSON défensif. Retourne l'objet JSON
        // ou null. Migration PROGRESSIVE des call-sites (écritures
        // destructrices et loaders d'état d'abord) — `opts.silent` pour les
        // sites qui toastent déjà (éviter les doubles toasts).
        async function fetchJsonAuth(url, options, opts) {
            opts = opts || {};
            const res = await fetchAuth(url, options, opts.soft);
            if (!res) return null;                       // réseau/401 déjà gérés
            if (!res.ok) {
                if (!opts.silent) {
                    showToast(opts.errorMsg || ('Erreur serveur (HTTP ' + res.status + ')'), 'error');
                }
                return null;
            }
            try {
                return await res.json();
            } catch (e) {
                if (!opts.silent) showToast('Réponse serveur invalide', 'error');
                return null;
            }
        }

        // -- 6.  SHARED REFS BUNDLE passed to every setup*() -----
        const sharedRefs = {
            user, settings, config, messages, currentChatId,
            inputMessage, inputRef, isStreaming, isAdminView,
            isUserScrolling, currentView, showSidebar,
            // Drapeaux d'instance : les modules en ont besoin pour décider,
            // pas seulement les templates pour masquer.
            features,
        };

        // -- 7.  MODULE PLACEHOLDERS (filled right after init) ---
        // Using 'let' so closures in ctx can reference them after all
        // modules are constructed.
        let authMod, chatMod, editorMod, adminMod, adminSkinsMod, adminRunsMod, settingsMod, skillsMenuMod, routinesMenuMod, studioMenuMod, studioChatMod, studioAutomationMod, codeMenuMod, mascotteMod;

        // -- 8.  CONTEXT OBJECT passed to every setup*() ---------
        // All getters are lazy; the referenced module vars are already
        // assigned before any of these methods can be *called* (they're
        // only called at runtime, after onMounted).
        const ctx = {
            // -- utilities --------------------------------------
            showToast,
            fetchAuth,
            fetchJsonAuth,
            announce,
            openConfirm,
            openPrompt,
            openChoice,
            openTypedConfirm,
            nextTick,
            // -- ponts éditeur ↔ chat (2026-09-19) -----------------
            // Insère du texte dans la barre de prompt (après le brouillon en
            // cours) et y place le curseur. Sort du plein écran éditeur, sinon
            // la barre de prompt reste masquée.
            insertIntoChat(text) {
                if (!text) return;
                currentView.value = 'chat';
                if (editorMod && editorMod.editorFullscreen && editorMod.editorFullscreen.value && editorMod.exitEditorFullscreen) {
                    editorMod.exitEditorFullscreen();
                }
                const cur = inputMessage.value || '';
                inputMessage.value = cur ? (cur.replace(/\s+$/, '') + '\n\n' + text) : text;
                nextTick(function() {
                    const el = inputRef.value;
                    if (el) {
                        try { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } catch (_) {}
                    }
                    if (chatMod && chatMod.autoResize) chatMod.autoResize();
                });
            },
            // Joint un fichier de la sandbox au prochain message (même puce
            // que la mention « @ »).
            attachFileToChat(path) {
                if (!path || !chatMod || !chatMod.selectMention) return;
                currentView.value = 'chat';
                if (editorMod && editorMod.editorFullscreen && editorMod.editorFullscreen.value && editorMod.exitEditorFullscreen) {
                    editorMod.exitEditorFullscreen();
                }
                return chatMod.selectMention({ path, name: String(path).split('/').pop() });
            },
            // Chemin cliqué dans un message → éditeur, à la ligne.
            openInEditor(path, line, col) {
                return editorMod && editorMod.openPathFromChat
                    ? editorMod.openPathFromChat(path, line, col) : undefined;
            },

            // -- root refs (getters so setup* modules always see the
            //    same reactive object, not a stale snapshot) -----
            // user : exposé pour les gardes d'auth des flux (SSE code,
            // terminal…) — audit 2026-08-02 (S2).
            get user()           { return user;           },
            get showSidebar()    { return showSidebar;    },
            get systemAlert()    { return systemAlert;    },
            get liveLogs()       { return liveLogs;       },
            get appInfo()        { return appInfo;        },
            // thinkingMode retiré : lire samplingOverride.thinking_budget_tokens à la place
            get showExportMenu() { return showExportMenu; },
            // Split-mode navigation refs — app-auth.js writes into these
            // when /api/public-config returns admin_url / main_url.
            get adminAppUrl()    { return adminAppUrl;    },
            get mainAppUrl()     { return mainAppUrl;     },
            get features()       { return features;       },

            // -- cross-module ref getters ---------------------
            // Branding de l'écran d'accueil (config admin, /api/public-config).
            // Lu par la mascotte pour le STYLE du mot animé — typo et échelles.
            // Getter paresseux : ctx est construit avant setupAuth.
            get welcomeConfig()   { return authMod     ? authMod.welcomeConfig     : null; },
            // Raccourci « Créer un compte » de la Vue d'ensemble (console admin).
            get showNewUserModal(){ return authMod     ? authMod.showNewUserModal  : null; },
            // Recherche Ctrl+K de la console : actions d'apparence (mode, thème).
            get themeApi()        { return settingsMod ? { toggleThemeMode: settingsMod.toggleThemeMode,
                                                           setAppSkin: settingsMod.setAppSkin,
                                                           skins: settingsMod.APP_SKINS ? settingsMod.APP_SKINS.value : [] } : null; },
            // Skin courant (registre serveur) : la mascotte lit ``mascot`` au
            // lieu de tester l'identifiant « kiki ».
            get skinCourant()     { return settingsMod ? settingsMod.skinCourant : null; },
            // Console › Apparence : après une activation, relire la liste
            // proposée au compte (menu d'apparence, Paramètres).
            reloadAppSkins()      { return settingsMod && settingsMod.loadAppSkins ? settingsMod.loadAppSkins() : Promise.resolve(false); },
            // Serveurs MCP affichables = perso visibles + bibliothèque PARTAGÉE
            // cochée. Source unique (module Paramètres) pour le panneau Outils
            // ET pour ce que le chat envoie au backend.
            get pinnedServers()   { return settingsMod ? settingsMod.pinnedServers    : null; },
            get ragCollections()  { return chatMod     ? chatMod.ragCollections       : null; },
            get chats()           { return chatMod     ? chatMod.chats                : null; },
            get currentChatTitle(){ return chatMod     ? chatMod.currentChatTitle     : null; },
            get fileInput()       { return editorMod   ? editorMod.fileInput          : null; },
            // Ouvre un fichier du sandbox dans l'éditeur. Getter paresseux (même
            // motif que fileInput) : ctx est construit AVANT setupEditor, et la
            // console admin ne charge pas du tout le module éditeur.
            openFile(path)        { return editorMod && editorMod.openFile ? editorMod.openFile(path) : null; },
            get showEditor()      { return editorMod   ? editorMod.showEditor         : null; },
            get monacoRef()       { return editorMod   ? editorMod.monacoRef          : null; },
            get models()          { return editorMod   ? editorMod.models             : null; },
            get openTabs()        { return editorMod   ? editorMod.openTabs           : null; },
            get availableModels() { return chatMod     ? chatMod.availableModels      : null; },
            get activeModelIds()  { return chatMod     ? chatMod.activeModelIds       : null; },
            // Modèle live sélectionné dans le chat.
            get selectedModel()   { return chatMod     ? chatMod.selectedModel        : null; },
            // Rendu riche partagé (code-copy + charts).
            addCodeCopyButtons(all, scope) { return chatMod && chatMod.addCodeCopyButtons ? chatMod.addCodeCopyButtons(all, scope) : null; },
            clearChartInstances()          { return chatMod && chatMod.clearChartInstances ? chatMod.clearChartInstances() : null; },

            // -- cross-module method proxies -----------------
            checkAuth()          { return authMod     ? authMod.checkAuth()             : Promise.resolve(); },
            loadChatsList()      { return chatMod     ? chatMod.loadChatsList()          : Promise.resolve(); },
            // Ouvre un chat par son id (Réglages → Mémoire : chat d'origine
            // d'une note). Même repère que le deep-link des notifications.
            openChatById(id)     { return _openChatById(id); },
            loadAvailableModels(){ return chatMod     ? chatMod.loadAvailableModels()    : Promise.resolve(); },
            autoResize()         { return chatMod     ? chatMod.autoResize()             : undefined; },
            loadSandboxFiles()   { return editorMod   ? editorMod.loadSandboxFiles()     : Promise.resolve(); },
            updateEditor(p, c, d){ return editorMod   ? editorMod.updateEditor(p, c, d) : Promise.resolve(); },
            // Fichier affiché par un visualiseur (image/hex/aperçu Office) : pas
            // de contenu texte à réconcilier, seulement l'aperçu à rafraîchir.
            editorIsViewerPath(p)  { return editorMod && editorMod.officeIsViewerPath ? editorMod.officeIsViewerPath(p) : false; },
            editorRefreshViewer(p) { return editorMod && editorMod.editorRefreshViewer ? editorMod.editorRefreshViewer(p) : Promise.resolve(); },
            capturePreWrite(p)   { return editorMod   ? editorMod.capturePreWrite(p)    : null; },
            // Diff Monaco plein écran (utilisé par chat/_diff_card.js comme
            // fallback "ouvrir dans l'éditeur"). Sans editorMod -> no-op.
            showDiffForMessage(p, b){ return editorMod ? editorMod.showDiffForMessage(p, b) : undefined; },
            showToolDiff(p, b)   { return editorMod ? editorMod.showToolDiff(p, b) : undefined; },
            // Tool streaming : écriture d'un fichier / édition en direct dans Monaco
            streamOpenForWrite(p, o){ return editorMod ? editorMod.streamOpenForWrite(p, o) : Promise.resolve(false); },
            streamLocateEdit(p, s)  { return editorMod ? editorMod.streamLocateEdit(p, s)   : Promise.resolve(false); },
            streamWriteChunk(p, c)  { return editorMod ? editorMod.streamWriteChunk(p, c)   : undefined; },
            streamFinalize(p, o)    { return editorMod ? editorMod.streamFinalize(p, o)     : Promise.resolve(); },
            isStreamActive(p)       { return editorMod ? editorMod.isStreamActive(p)        : false; },
            // Revérifie les onglets ouverts contre le disque (après une commande
            // shell, une action git de l'assistant, la fin d'un tour — E8).
            checkExternalModsSoon(d){ return editorMod && editorMod.checkExternalModsSoon ? editorMod.checkExternalModsSoon(d) : undefined; },
            getStreamPreSnapshot(p) { return editorMod ? editorMod.getStreamPreSnapshot(p)  : null; },
            loadUsers()          { return adminMod    ? adminMod.loadUsers()             : Promise.resolve(); },
            loadSettingsData()   { return settingsMod ? settingsMod.loadSettingsData()   : Promise.resolve(); },
            // Fermeture de la modal Paramètres depuis un autre module (ex.
            // lancement du chat Assistant depuis l'onglet Skills). skip=true =
            // sans confirm dirty ni reload (cf. closeSettings d'app-settings.js).
            closeSettings(skip)  { return settingsMod && settingsMod.closeSettings ? settingsMod.closeSettings(skip) : undefined; },
            // Ouverture des Paramètres sur un onglet précis et de l'aide :
            // les commandes « / » de navigation du composeur passent par là.
            // Proxies paresseux — setupChat est monté AVANT setupSettings.
            openSettingsTab(tab) { return settingsMod && settingsMod.openSettingsTab ? settingsMod.openSettingsTab(tab) : undefined; },
            openHelp(doc)        { return settingsMod && settingsMod.openHelp ? settingsMod.openHelp(doc) : undefined; },
            // Écriture mémoire ANNULÉE depuis le fil (chat/_memory_card.js) :
            // Réglages → Mémoire relit l'état (le crochet n'était branché nulle
            // part, 2026-09-21).
            onMemoryChanged()    { return settingsMod && settingsMod.loadUserMemory ? settingsMod.loadUserMemory() : undefined; },
            // Décocher « Réponse vocale » doit faire taire ce qui se lit :
            // le module Paramètres est monté APRÈS celui du chat, d'où le
            // proxy paresseux plutôt qu'une capture directe.
            stopSpeaking()       { return chatMod && chatMod.stopSpeaking ? chatMod.stopSpeaking() : undefined; },
            // Template de prompt inséré depuis Paramètres → Prompts : même
            // chemin que « /template » (fenêtre des variables, insertion au
            // curseur). Le module chat est monté AVANT les Paramètres.
            openTemplate(t)      { return chatMod && chatMod.openTemplate ? chatMod.openTemplate(t) : undefined; },
            // Deux onglets de Paramètres ont leur chargeur AILLEURS que dans
            // le module Paramètres (Agents → chat, Skills → menu skills) :
            // openSettingsTab en a besoin pour ne pas les ouvrir vides.
            loadMcpUserCategories() { return chatMod && chatMod.loadMcpUserCategories ? chatMod.loadMcpUserCategories() : Promise.resolve(); },
            openSkillsTab()         { return skillsMenuMod && skillsMenuMod.openSkillsTab ? skillsMenuMod.openSkillsTab() : Promise.resolve(); },
            loadPublicConfig()   { return authMod     ? authMod.loadPublicConfig()       : Promise.resolve(); },

            // -- Nettoyage de session (logout, poste partagé) --
            // logout() (app-auth.js) passe par ces proxies : les refs
            // qu'il purgeait directement (gitCredUser, attachedFiles,
            // stopGeneration, …) n'ont JAMAIS été des clés de ctx — tout
            // ce cleanup était silencieusement mort (fuite d'état entre
            // comptes : token git prérempli, PJ, génération non stoppée).
            // ``explicit`` : vrai pour un départ VOLONTAIRE (bouton
            // Déconnexion), faux/absent pour une fin de session subie
            // (401, session_expired, cookie échu). Seul le premier arrête la
            // génération en cours — cf. resetOnLogout (audit 2026-08-22, B4).
            resetChatOnLogout(explicit) { return chatMod   && chatMod.resetOnLogout   ? chatMod.resetOnLogout(explicit)   : undefined; },
            // (passe 6, F10) — purge du snapshot de session (crash recovery)
            // de l'utilisateur COURANT : la clé est namespacée par user_id
            // (cf. _sessionKey) ; _history.js supprimait la clé legacy nue,
            // jamais la vraie → un crash après « Nouveau chat » restaurait la
            // conversation précédente.
            clearSavedSession() {
                try { sessionStorage.removeItem(_sessionKey()); } catch (_) {}
                try { sessionStorage.removeItem(SESSION_KEY_BASE); } catch (_) {}
            },
            rescueEditorBuffers() { return editorMod && editorMod.rescueDirtyBuffers ? editorMod.rescueDirtyBuffers() : 0; },
            resetEditorOnLogout() { return editorMod && editorMod.resetOnLogout ? editorMod.resetOnLogout() : undefined; },
            // AUDIT 2026-08-02 (S3) — point d'entrée unique « session morte »
            // pour les modules (SSE session_expired, WS terminal 4001,
            // chargement de chat en 401…) : toast unique + user=null, la
            // purge complète étant faite par le watcher user.
            handleSessionExpired() { return _handleSessionExpired(); },

            // -- notifications : pont SSE (app-chat.js → état app.js) -
            onNotificationEvent(data) { return _handleNotificationEvent(data); },
            // Resync après reconnexion SSE : les events "notification" émis
            // pendant la coupure sont perdus (pas de replay côté bus). On
            // rattrape depuis la DB — la LISTE complète si le panneau est
            // ouvert (sinon le panneau resterait déphasé), sinon juste le
            // compteur. No-op en admin-only (endpoint absent).
            refreshNotifBadge() {
                if (window.__ADMIN_ONLY_MODE__) return undefined;
                return showNotifPanel.value ? loadNotifications() : refreshNotifUnread();
            },
            // Signaux de fin / erreur d'un run de chat en arrière-plan (Lot 4) :
            // appelés par app-chat.js quand un run d'arrière-plan se termine.
            notifyChatDone(chatId, title)          { return notifyChatDone(chatId, title); },
            notifyChatError(chatId, title, detail) { return notifyChatError(chatId, title, detail); },
            // -- Annotation Studio : pont SSE (annotation_frame → studio) -
            onAnnotationFrame(data) { return studioMenuMod && studioMenuMod.applyFrame ? studioMenuMod.applyFrame(data) : undefined; },
            // -- modèle LLM courant : le mini-chat Studio réutilise le même -
            currentModelId() { return chatMod && chatMod.selectedModel ? chatMod.selectedModel.value : null; },
            // -- serveur d'inférence courant : le Studio part sur LE serveur
            //    choisi dans le chat, et la page Routines lit les modèles du
            //    serveur de la routine (le couple serveur+modèle est atomique).
            currentConnectorId() {
                return (chatMod && chatMod.selectedConnector && chatMod.selectedConnector.value) || null;
            },
            engineModels(connectorId) {
                if (!chatMod) return [];
                if (!connectorId) return (chatMod.availableModels && chatMod.availableModels.value) || [];
                const byConn = (chatMod.pickerConnModels && chatMod.pickerConnModels.value) || {};
                return byConn[connectorId] || [];
            },
            loadEngines() {
                try { if (chatMod && chatMod.loadLlmConnectors) chatMod.loadLlmConnectors(); } catch (_) {}
            },
        };

        // -- 9.  INIT ALL MODULES --------------------------------
        // Each setup factory is guarded with a typeof check: on the dedicated
        // admin page (admin.html) we deliberately do not load app-editor.js
        // (along with its 13 MB Monaco bundle) because the admin console
        // never opens files. Without the guard, ``setupEditor()`` would
        // throw at line 342 ("setupEditor is not a function"), which crashes
        // setup() BEFORE the return statement runs — every ref defined below
        // (contextMenu, adminAppUrl, …) becomes invisible to the template,
        // and the user gets a flurry of misleading "X is undefined" errors.
        //
        // Falling back to an empty object {} is safe because:
        //   • the spread ``...editorMod`` on line ~810 just adds nothing,
        //   • the ctx getters above already return null when the module is
        //     missing (e.g. ``get fileInput() { return editorMod ? … : null }``),
        //   • no template in admin.html references editor refs (we removed
        //     the editor.html include).
        function _safeSetup(factoryName, factory) {
            if (typeof factory !== 'function') {
                console.info('[app] ' + factoryName + ' absent — module skippé (probable mode admin réduit)');
                return {};
            }
            try {
                return factory(Vue, sharedRefs, ctx);
            } catch (e) {
                console.error('[app] ' + factoryName + ' a levé une exception, fallback module vide:', e);
                return {};
            }
        }
        authMod     = _safeSetup('setupAuth',     typeof setupAuth     !== 'undefined' ? setupAuth     : null);
        chatMod     = _safeSetup('setupChat',     typeof setupChat     !== 'undefined' ? setupChat     : null);
        editorMod   = _safeSetup('setupEditor',   typeof setupEditor   !== 'undefined' ? setupEditor   : null);
        adminMod    = _safeSetup('setupAdmin',    typeof setupAdmin    !== 'undefined' ? setupAdmin    : null);
        settingsMod = _safeSetup('setupSettings', typeof setupSettings !== 'undefined' ? setupSettings : null);
        // Console › Système › Apparence (skins de l'instance). Module à part :
        // ses chargeurs sont cherchés par _loadAdminTab après ceux d'adminMod.
        adminSkinsMod = _safeSetup('setupAdminSkins', typeof setupAdminSkins !== 'undefined' ? setupAdminSkins : null);
        // Console › Supervision › Exécutions (L5.7) : même principe.
        adminRunsMod = _safeSetup('setupAdminRuns', typeof setupAdminRuns !== 'undefined' ? setupAdminRuns : null);
        // Gestion des skills. Module self-contained : l'onglet « Skills » de la
        // modal Paramètres (includes/modals/settings_skills.html, gated sur
        // settingsTab==='skills', refs/methods spread ci-dessous) porte tout le
        // CRUD — l'ex-page pleine skills_page.html a été supprimée (2026-07-18).
        skillsMenuMod = _safeSetup('setupSkillsMenu', typeof setupSkillsMenu !== 'undefined' ? setupSkillsMenu : null);
        // Routines-management page (entrée sidebar sous « Éditeur »). Module
        // self-contained : la sidebar flippe currentView='routines', et
        // includes/main/routines_page.html (refs/methods spread ci-dessous)
        // rend la page CRUD + journal des runs.
        routinesMenuMod = _safeSetup('setupRoutinesMenu', typeof setupRoutinesMenu !== 'undefined' ? setupRoutinesMenu : null);
        // Annotation Studio (computer-use live view). Sidebar flips
        // currentView='studio'; includes/main/studio_page.html renders the box
        // overlay. Live frames arrive via the 'annotation_frame' SSE event,
        // bridged from app-chat.js through ctx.onAnnotationFrame below.
        studioMenuMod = _safeSetup('setupStudioMenu', typeof setupStudioMenu !== 'undefined' ? setupStudioMenu : null);
        codeMenuMod = _safeSetup('setupCodeMenu', typeof setupCodeMenu !== 'undefined' ? setupCodeMenu : null);
        // Mascotte du bloc « nouveau chat » (remplace le logo Elpis fixe).
        // Self-contained : ne lit que settings/messages/currentView/isStreaming
        // et n'expose qu'un état, consommé par includes/main/chat.html.
        mascotteMod = _safeSetup('setupMascotte', typeof setupMascotte !== 'undefined' ? setupMascotte : null);
        // Mini-chat latéral du Studio (pilotage desktop semi-live + clic direct).
        // Reçoit studioMenuMod en 4e arg pour partager le stage (applyFrame), la
        // cible (selectedTarget) et la liste d'éléments détectés.
        studioChatMod = (typeof setupStudioChat !== 'undefined')
            ? (() => { try { return setupStudioChat(Vue, sharedRefs, ctx, studioMenuMod); }
                       catch (e) { console.error('[app] setupStudioChat a levé :', e); return {}; } })()
            : {};
        // Studio d'automatisation (2026-09-12) : les clics deviennent des étapes,
        // les étapes du code Python exécutable sur la machine cible. Reçoit le
        // menu (stage + éléments) ET le chat (hooks d'enregistrement des actions).
        studioAutomationMod = (typeof setupStudioAutomation !== 'undefined')
            ? (() => { try { return setupStudioAutomation(Vue, sharedRefs, ctx, studioMenuMod, studioChatMod); }
                       catch (e) { console.error('[app] setupStudioAutomation a levé :', e); return {}; } })()
            : {};
        // QUITTER le Studio (Échap, bouton retour, MAIS AUSSI un switch sidebar /
        // nouveau chat / ouverture d'une conv qui posent currentView='chat' sans
        // passer par closeStudio) doit COUPER le mini-chat (sinon ses outils
        // desktop_* continuent d'agir sur la machine cible en arrière-plan) et
        // désarmer un glisser-déposer en cours (sinon le listener keydown global
        // fuit). Un watch sur currentView capture TOUS les chemins de sortie.
        watch(currentView, (v, old) => {
            if (old === 'studio' && v !== 'studio') {
                try { studioChatMod.studioChatStop && studioChatMod.studioChatStop(); } catch (e) {}
                try { studioChatMod.cancelStudioDrag && studioChatMod.cancelStudioDrag(); } catch (e) {}
            }
            if (old === 'code' && v !== 'code') {
                try { codeMenuMod.codeDisconnectStream && codeMenuMod.codeDisconnectStream(); } catch (e) {}
            }
        });


        // -- 10. CONTEXT MENU ACTION (needs module refs) ---------
        function handleContextAction(action) {
            const item = contextMenu.value.item;
            const type = contextMenu.value.type;
            closeContextMenu();
            if (!item) return;

            if (type === 'chat') {
                if (action === 'rename')  chatMod.renameChat(item.id, item.title);
                if (action === 'archive') chatMod.archiveChat(item.id);
                if (action === 'delete')  chatMod.deleteChat(item.id);
                return;
            }
            // file / folder / explorer-bg
            let parentPath = '';
            if (type === 'folder') parentPath = item.path;
            else if (type === 'file' && item.path && item.path.includes('/')) parentPath = item.path.substring(0, item.path.lastIndexOf('/'));
            if (action === 'new_file')   editorMod.createFile(parentPath);
            if (action === 'new_folder') editorMod.createFolder(parentPath);
            if (action === 'rename')     editorMod.renameItem(item.path);
            if (action === 'copy_path')  editorMod.copyTabPath(item.path);   // fichiers ET dossiers
            if (action === 'download')   editorMod.downloadFile(item.path);  // sélection multiple → zip
            if (action === 'delete')     editorMod.deleteFile(item.path);    // sélection multiple incluse
            if (action === 'duplicate')  editorMod.duplicateItem(item.path);
            if (action === 'attach_chat') editorMod.attachToChat(item.path);
            if (action === 'terminal_here') editorMod.openTerminalHere(type === 'folder' ? item.path : parentPath);
            if (action === 'collapse_all') editorMod.collapseAllFolders();
        }

        // -- EXPLORER DRAG & DROP ---------------------------------
        const explorerDragOver = ref(false);
        var _dragLeaveTimer = null;

        // -- IMPORT PROGRESS (gros dossiers) ----------------------
        // État réactif de la barre de progression d'import. Rendu dans
        // l'explorateur (cf. editor.html), calqué sur la barre snapshot.
        // ``phase`` (2026-09-16) : 'prepare' pendant le parcours d'un dossier
        // déposé et le pré-contrôle d'espace, 'upload' pendant l'envoi.
        const uploadProgress = ref({
            active: false, phase: 'upload', pct: 0,
            files_done: 0, total_files: 0,
            current_file: '', skipped: 0,
        });

        function onExplorerDragOver() {
            explorerDragOver.value = true;
            if (_dragLeaveTimer) { clearTimeout(_dragLeaveTimer); _dragLeaveTimer = null; }
        }

        function onExplorerDragLeave() {
            _dragLeaveTimer = setTimeout(function() { explorerDragOver.value = false; }, 100);
        }

        // -- ANNULATION D'IMPORT (2026-09-16) ---------------------
        // Avant : l'XHR d'un lot n'était conservé nulle part et un import mis
        // en file démarrait quoi qu'il arrive — rien ne pouvait arrêter un
        // dossier trop gros. ``_uploadCtl`` porte l'import EN COURS (null au
        // repos) : son XHR, son identifiant (isole son ``.part`` côté serveur)
        // et le drapeau ``cancelled`` que les boucles consultent entre deux
        // envois. ``_uploadEpoch`` est incrémenté par l'annulation : les imports
        // déjà EN FILE sortent sans rien envoyer.
        // Les fichiers déjà écrits RESTENT (un retour arrière effacerait aussi
        // les fichiers qu'ils ont écrasés, sans retour possible).
        var _uploadCtl = null;
        var _uploadEpoch = 0;

        function cancelSandboxUpload() {
            _uploadEpoch++;
            var ctl = _uploadCtl;
            if (!ctl || ctl.cancelled) return;
            ctl.cancelled = true;
            if (ctl.xhr) { try { ctl.xhr.abort(); } catch (_) {} }
            if (ctl.fetchAbort) { try { ctl.fetchAbort.abort(); } catch (_) {} }
        }

        // Supprime le ``.part`` d'un fichier découpé interrompu (annulation ou
        // échec en plein fichier). Rejoué une fois 2,5 s plus tard : un morceau
        // entièrement reçu AVANT l'abort est encore traité côté serveur et
        // pourrait recréer le tmp juste après la première suppression.
        function _dropChunkPart(relPath, uploadId) {
            var url = '/api/sandbox/upload-chunk?path=' + encodeURIComponent(relPath)
                    + '&upload_id=' + encodeURIComponent(uploadId);
            var go = function() { fetchAuth(url, { method: 'DELETE' }, true); };
            go();
            setTimeout(go, 2500);
        }

        // « 12,4 Go » — messages de refus du pré-contrôle.
        function _fmtOctets(n) {
            n = Math.max(0, Number(n) || 0);
            var u = [[1073741824, 'Go'], [1048576, 'Mo'], [1024, 'Ko']];
            for (var i = 0; i < u.length; i++) {
                if (n >= u[i][0]) {
                    return (n / u[i][0]).toFixed(1).replace('.', ',').replace(/,0$/, '') + ' ' + u[i][1];
                }
            }
            return n + ' o';
        }

        // POST d'un lot via XHR (et non fetch) pour exposer la progression
        // d'upload octet-par-octet (fetch ne donne pas upload.onprogress).
        // Renvoie {ok, status, data[, aborted]}. Cookies same-origin envoyés
        // d'office. ``ctl`` (import en cours) reçoit l'XHR pour pouvoir
        // l'interrompre ; un abort rend ``aborted: true`` — distinct d'une
        // panne réseau, qui ne doit pas être comptée comme une annulation.
        function _xhrUploadBatch(url, formData, onProgress, ctl) {
            return new Promise(function(resolve) {
                if (ctl && ctl.cancelled) { resolve({ ok: false, status: 0, data: null, aborted: true }); return; }
                var xhr = new XMLHttpRequest();
                var done = function(r) { if (ctl && ctl.xhr === xhr) ctl.xhr = null; resolve(r); };
                xhr.open('POST', url);
                // sans timeout, un upload pendu sur un réseau qui
                // meurt sans onerror restait "in progress" indéfiniment (l'UI
                // affichait "active: true" sans fin). 10 min couvre largement
                // un gros chunk (8 Mo) même sur connexion dégradée.
                xhr.timeout = 10 * 60 * 1000;
                if (xhr.upload) {
                    xhr.upload.onprogress = function(e) {
                        if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total);
                    };
                }
                xhr.onload = function() {
                    var data = null;
                    try { data = JSON.parse(xhr.responseText); } catch (_) {}
                    done({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data: data });
                };
                xhr.onerror = function() { done({ ok: false, status: 0, data: null }); };
                xhr.onabort = function() { done({ ok: false, status: 0, data: null, aborted: true }); };
                xhr.ontimeout = function() { done({ ok: false, status: 0, data: null, timeout: true }); };
                if (ctl) ctl.xhr = xhr;
                xhr.send(formData);
            });
        }

        // Upload chunké/streamé d'UN gros fichier (mémoire bornée des deux
        // côtés). Renvoie {ok, status[, aborted]}. ``onFileProgress(bytesDoneInFile)``
        // est appelé au fil des chunks pour alimenter la barre globale.
        var _UP_CHUNK_SIZE = 8 * 1024 * 1024;     // 8 Mo par chunk
        async function _uploadFileChunked(chunkUrl, file, relPath, onFileProgress, ctl) {
            var size = file.size || 0;
            var total = Math.max(1, Math.ceil(size / _UP_CHUNK_SIZE));
            for (var idx = 0; idx < total; idx++) {
                var start = idx * _UP_CHUNK_SIZE;
                var end = Math.min(start + _UP_CHUNK_SIZE, size);
                var blob = file.slice(start, end);
                var url = chunkUrl
                    + '?path=' + encodeURIComponent(relPath)
                    + '&index=' + idx + '&total=' + total + '&size=' + size
                    + '&upload_id=' + encodeURIComponent(ctl.id);
                var chunkStart = start;
                var resp = await _xhrUploadBatch(url, blob, function(loaded) {
                    if (onFileProgress) onFileProgress(chunkStart + loaded);
                }, ctl);
                if (!resp.ok) {
                    // Annulation, ou échec EN PLEIN fichier (5xx, réseau) : le
                    // ``.part`` ne sera jamais promu — le supprimer tout de suite
                    // plutôt que de le laisser compter dans le quota jusqu'au
                    // balayage quotidien. 401 : session partie, rien à faire.
                    if (resp.status !== 401) _dropChunkPart(relPath, ctl.id);
                    return resp;   // 401 / 413 quota / 5xx / abort → on stoppe ce fichier
                }
            }
            return { ok: true, status: 200, data: { done: true } };
        }

        // Pré-contrôle d'espace AVANT le moindre envoi (2026-09-16). Un dossier
        // trop gros s'importait à moitié puis butait sur le quota. Le serveur
        // mesure l'usage exact, déduit les écrasements et applique deux
        // bornes : le plafond d'UN import (``app.sandbox_import_max_pct`` de la
        // capacité, 60 % par défaut) et l'espace restant.
        // Rend {fits, message} ; route absente (hôte d'outils plus ancien) ou
        // injoignable → fits:true (le serveur reste l'autorité pendant l'envoi).
        var _PRECHECK_MAX_ENTRIES = 20000;          // = serveur (routes_files.py)
        async function _precheckUpload(items, totalBytes, ctl) {
            var body = { total_bytes: totalBytes, files: [] };
            if (items.length <= _PRECHECK_MAX_ENTRIES) {
                body.files = items.map(function(it) { return { path: it.rel, size: it.file.size || 0 }; });
            }
            ctl.fetchAbort = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            var res = null;
            try {
                res = await fetchAuth('/api/sandbox/upload-precheck', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: ctl.fetchAbort ? ctl.fetchAbort.signal : undefined,
                }, true);
            } catch (_) { res = null; }
            ctl.fetchAbort = null;
            if (!res || !res.ok) return { fits: true };
            var d = null;
            try { d = await res.json(); } catch (_) { return { fits: true }; }
            if (!d || d.fits !== false) return { fits: true };
            var borne = d.reason === 'remaining'
                ? 'espace restant ' + _fmtOctets(d.allowed_bytes)
                : 'limite d\'un import ' + _fmtOctets(d.allowed_bytes) + ' (' + d.max_pct + ' %)';
            return { fits: false, message: 'Import impossible : ' + _fmtOctets(d.needed_bytes)
                                         + ' à importer, ' + borne };
        }

        // Upload files into sandbox — robuste aux GROS DOSSIERS *et* GROS FICHIERS.
        //
        //  • Petits fichiers (≤ 8 Mo) → regroupés en lots multipart bornés
        //    (taille + nombre) : une requête courte par lot, pas de timeout
        //    worker même sur des milliers de fichiers.
        //  • Gros fichiers (> 8 Mo)  → upload CHUNKÉ streamé (``/upload-chunk``) :
        //    ni le client ni le serveur ne chargent le fichier entier en RAM,
        //    et on dépasse le plafond multipart de 50 Mo (un fichier de 1 Go
        //    passe). C'était le bug « 0 fichier importé » sur 1 Go.
        //  Progression globale en octets, fluide, sur l'ensemble.
        var _UP_BATCH_BYTES = 12 * 1024 * 1024;   // ~12 Mo de contenu par lot
        var _UP_BATCH_COUNT = 40;                  // ou 40 fichiers, 1er atteint
        var _UP_SMALL_LIMIT = 8 * 1024 * 1024;     // > → chunké
        // AUDIT 2026-08-31 (passe 4, F4) — la fonction n'était PAS réentrante :
        // deux glisser-déposer simultanés se partageaient l'unique ref
        // ``uploadProgress`` (compteurs mélangés), et le finisher du premier
        // masquait la barre pendant que le second montait encore. On
        // SÉRIALISE les invocations (le lot suivant démarre quand le
        // précédent est soldé) et le masquage différé est jetonné.
        var _uploadChain = Promise.resolve();
        var _uploadHideSeq = 0;
        // ``prepare(ctl)`` rend (ou promet) la liste à importer : copie d'une
        // FileList, ou parcours d'un dossier déposé — qui tourne DANS la file,
        // barre « Préparation… » affichée et annulable.
        function _enqueueUpload(prepare, targetFolder) {
            var epoch = _uploadEpoch;
            var run = _uploadChain.then(function() {
                if (epoch !== _uploadEpoch) return;    // annulé pendant l'attente
                return _runUploadJob(prepare, targetFolder);
            });
            _uploadChain = run.catch(function() {});
            return run;
        }
        function uploadFilesToSandbox(input, targetFolder) {
            if (!input) return Promise.resolve();
            // Copie IMMÉDIATE : un import mis en file gardait une référence à la
            // FileList de l'<input>, que le clic suivant sur « Importer » vide.
            var snapshot = Array.prototype.slice.call(input);
            if (snapshot.length === 0) return Promise.resolve();
            return _enqueueUpload(function() { return snapshot; }, targetFolder);
        }
        // Dossiers/fichiers DÉPOSÉS (FileSystemEntry) : le parcours fait partie
        // de l'import — sur un gros dossier il dure, et il doit pouvoir s'annuler.
        function uploadDroppedEntries(entries, targetFolder) {
            var list = Array.prototype.slice.call(entries || []);
            if (list.length === 0) return Promise.resolve();
            return _enqueueUpload(function(ctl) { return _collectDropEntries(list, ctl); }, targetFolder);
        }
        function _hideUploadBar(delayMs) {
            var _hideSeq = ++_uploadHideSeq;
            var hide = function() {
                if (_hideSeq !== _uploadHideSeq) return;
                uploadProgress.value = Object.assign({}, uploadProgress.value, { active: false });
            };
            // Sans délai : dans le même tick que le toast qui l'accompagne.
            if (!delayMs) { hide(); return; }
            setTimeout(hide, delayMs);
        }
        async function _runUploadJob(prepare, targetFolder) {
            var ctl = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
                        cancelled: false, xhr: null, fetchAbort: null };
            _uploadCtl = ctl;
            ++_uploadHideSeq;   // invalide un masquage différé encore en vol
            uploadProgress.value = {
                active: true, phase: 'prepare', pct: 0,
                files_done: 0, total_files: 0,
                current_file: 'Analyse', skipped: 0,
            };
            try {
                var input = await prepare(ctl);
                if (ctl.cancelled) {
                    _hideUploadBar(0);
                    showToast('Import annulé', 'info');
                    return;
                }
                await _doUploadFilesToSandbox(input, targetFolder, ctl);
            } finally {
                if (_uploadCtl === ctl) _uploadCtl = null;
            }
        }
        async function _doUploadFilesToSandbox(input, targetFolder, ctl) {
            var arr = input ? Array.prototype.slice.call(input) : [];
            if (arr.length === 0) { _hideUploadBar(0); return; }

            // Normalise l'entrée en [{file, rel}]. Deux formes acceptées :
            //  • FileList / File[]  → rel = webkitRelativePath || name (bouton
            //    fichier ; bouton DOSSIER qui pose webkitRelativePath).
            //  • [{file, path}]     → rel = path : drag-drop de DOSSIERS, dont
            //    l'arbo a été reconstruite via webkitGetAsEntry (cf.
            //    _collectDropEntries) — car dataTransfer.files ne descend PAS
            //    dans les répertoires et renvoyait une entrée illisible →
            //    xhr.send échouait → « status 0 » (le bug « 0 fichier »).
            var entryForm = !!(arr[0] && arr[0].file && (arr[0].file instanceof Blob));
            var items = arr.map(function(x) {
                var file = entryForm ? x.file : x;
                var rel = entryForm ? (x.path || file.name) : (file.webkitRelativePath || file.name);
                if (targetFolder) rel = targetFolder + '/' + rel;
                return { file: file, rel: rel };
            });

            var uploadUrl = '/api/sandbox/upload';
            var chunkUrl = uploadUrl + '-chunk';

            // Sépare petits / gros + total d'octets pour la progression.
            var totalBytes = 0, smallFiles = [], largeFiles = [];
            for (var i = 0; i < items.length; i++) {
                var sz = items[i].file.size || 0;
                totalBytes += sz;
                (sz > _UP_SMALL_LIMIT ? largeFiles : smallFiles).push(items[i]);
            }

            // Pré-contrôle : l'import entier, ou rien.
            uploadProgress.value = Object.assign({}, uploadProgress.value, {
                phase: 'prepare', total_files: items.length,
                current_file: 'Vérification de l\'espace',
            });
            var pre = await _precheckUpload(items, totalBytes, ctl);
            if (ctl.cancelled) { _hideUploadBar(0); showToast('Import annulé', 'info'); return; }
            if (!pre.fits) {
                _hideUploadBar(0);
                showToast(pre.message, 'error');
                return;
            }

            uploadProgress.value = {
                active: true, phase: 'upload', pct: 0,
                files_done: 0, total_files: items.length,
                current_file: '', skipped: 0,
            };

            var bytesBefore = 0, savedTotal = 0, skippedTotal = 0, auth401 = false, quotaHit = false;

            function _setPct(doneBytes) {
                if (totalBytes <= 0) return;
                uploadProgress.value = Object.assign({}, uploadProgress.value, {
                    pct: Math.min(99, Math.round(doneBytes / totalBytes * 100)),
                });
            }
            function _bumpCounters() {
                uploadProgress.value = Object.assign({}, uploadProgress.value, {
                    files_done: Math.min(savedTotal + skippedTotal, items.length),
                    skipped: skippedTotal,
                    pct: totalBytes > 0 ? Math.min(99, Math.round(bytesBefore / totalBytes * 100)) : 99,
                });
            }
            // Fin des envois : session partie, quota plein, ou annulation.
            function _stop() { return auth401 || quotaHit || ctl.cancelled; }

            // 1) PETITS fichiers — lots multipart. (items = {file, rel})
            var batches = [], cur = [], curBytes = 0;
            for (var s = 0; s < smallFiles.length; s++) {
                var ssz = smallFiles[s].file.size || 0;
                if (cur.length && (curBytes + ssz > _UP_BATCH_BYTES || cur.length >= _UP_BATCH_COUNT)) {
                    batches.push(cur); cur = []; curBytes = 0;
                }
                cur.push(smallFiles[s]); curBytes += ssz;
            }
            if (cur.length) batches.push(cur);

            for (var b = 0; b < batches.length && !_stop(); b++) {
                var batch = batches[b];
                var fd = new FormData();
                var batchBytes = 0;
                for (var j = 0; j < batch.length; j++) {
                    fd.append('files', batch[j].file);
                    fd.append('paths', batch[j].rel);
                    batchBytes += batch[j].file.size || 0;
                }
                uploadProgress.value = Object.assign({}, uploadProgress.value, {
                    current_file: batch[0].rel,
                });
                var before = bytesBefore, bBytes = batchBytes;
                var resp = await _xhrUploadBatch(uploadUrl, fd, function(loaded) {
                    _setPct(before + Math.min(loaded, bBytes));
                }, ctl);
                if (resp.aborted) break;
                bytesBefore += batchBytes;
                if (resp.status === 401) { auth401 = true; break; }
                if (resp.ok && resp.data) {
                    savedTotal += resp.data.saved || 0;
                    var _skipped = resp.data.skipped || [];
                    skippedTotal += _skipped.length;
                    // Quota plein sur un lot : le serveur répond 200 et range les
                    // fichiers refusés dans ``skipped`` — avant, seul le 413 d'un
                    // morceau était reconnu, et tous les lots suivants partaient
                    // quand même.
                    if (_skipped.some(function(x) { return x && x.reason === 'quota_exceeded'; })) quotaHit = true;
                } else {
                    skippedTotal += batch.length;   // 503/réseau : lot ignoré, on continue
                }
                _bumpCounters();
            }

            // 2) GROS fichiers — un par un, chunké streamé.
            for (var k = 0; k < largeFiles.length && !_stop(); k++) {
                var lf = largeFiles[k];           // {file, rel}
                var lrel = lf.rel;
                var lbytes = lf.file.size || 0;
                uploadProgress.value = Object.assign({}, uploadProgress.value, { current_file: lrel });
                var lbefore = bytesBefore;
                var lresp = await _uploadFileChunked(chunkUrl, lf.file, lrel, function(doneInFile) {
                    _setPct(lbefore + doneInFile);
                }, ctl);
                if (lresp.aborted) break;
                bytesBefore += lbytes;
                if (lresp.status === 401) { auth401 = true; break; }
                if (lresp.ok) {
                    savedTotal += 1;
                } else {
                    skippedTotal += 1;
                    if (lresp.status === 413) quotaHit = true;   // quota ou plafond d'import
                }
                _bumpCounters();
            }

            // AUDIT 2026-08-02 (S-mineur) — passait par ``user.value = null``
            // nu : ni toast, ni purge (le watcher purgeait déjà, mais sans
            // message l'utilisateur croyait à un upload perdu sans cause).
            if (auth401) { _hideUploadBar(0); _handleSessionExpired(); return; }

            if (ctl.cancelled) {
                _hideUploadBar(0);
                if (editorMod && editorMod.loadSandboxFiles) editorMod.loadSandboxFiles();
                if (editorMod && editorMod.checkExternalModsSoon) editorMod.checkExternalModsSoon(0);
                showToast('Import annulé — ' + savedTotal + ' fichier(s) déjà importé(s)', 'info');
                return;
            }

            // Finalisation : barre à 100% un court instant, puis masquée —
            // sauf si un nouvel upload a repris la barre entre-temps (F4).
            uploadProgress.value = Object.assign({}, uploadProgress.value, { pct: 100 });
            _hideUploadBar(600);

            if (editorMod && editorMod.loadSandboxFiles) editorMod.loadSandboxFiles();
            // Un import a pu écraser un fichier ouvert : onglets revérifiés
            // tout de suite (propre → rechargé, modifié → conflit signalé).
            if (editorMod && editorMod.checkExternalModsSoon) editorMod.checkExternalModsSoon(0);

            if (savedTotal === 0) {
                showToast(quotaHit ? 'Quota sandbox dépassé — import refusé' : 'Échec de l\'import (0 fichier)', 'error');
            } else if (skippedTotal > 0 || quotaHit) {
                var _nonEnvoyes = items.length - savedTotal - skippedTotal;
                showToast(savedTotal + ' fichier(s) importé(s), ' + (skippedTotal + Math.max(0, _nonEnvoyes)) + ' ignoré(s)'
                          + (quotaHit ? ' (quota dépassé)' : ''), 'error');
            } else {
                showToast(savedTotal + ' fichier(s) importé(s)');
            }
        }

        // Traverse RÉCURSIVEMENT des FileSystemEntry (webkitGetAsEntry) en une
        // liste plate [{file, path}] qui PRÉSERVE l'arborescence. Indispensable
        // pour le drag-drop de DOSSIERS : dataTransfer.files ne descend pas dans
        // les répertoires (il renvoie une entrée illisible → upload échoue).
        // readEntries() rend les enfants par paquets (~100) → on boucle jusqu'au
        // paquet vide.
        // ``ctl`` (optionnel) : un import annulé arrête le parcours, et le
        // nombre de fichiers trouvés s'affiche au fil de l'eau (« Préparation »).
        function _collectDropEntries(entries, ctl) {
            var out = [];
            var _lastShown = 0;
            function _stopped() { return !!(ctl && ctl.cancelled); }
            function _showFound() {
                if (!ctl || out.length - _lastShown < 50) return;
                _lastShown = out.length;
                uploadProgress.value = Object.assign({}, uploadProgress.value, { total_files: out.length });
            }
            function readOne(entry, prefix) {
                return new Promise(function(resolve) {
                    if (!entry || _stopped()) { resolve(); return; }
                    if (entry.isFile) {
                        entry.file(function(file) {
                            out.push({ file: file, path: prefix + entry.name });
                            _showFound();
                            resolve();
                        }, function() { resolve(); });   // fichier illisible → on skip, pas de crash
                    } else if (entry.isDirectory) {
                        var reader = entry.createReader();
                        var children = [];
                        function readBatch() {
                            if (_stopped()) { resolve(); return; }
                            reader.readEntries(function(batch) {
                                if (!batch.length) {
                                    Promise.all(children.map(function(c) {
                                        return readOne(c, prefix + entry.name + '/');
                                    })).then(resolve);
                                    return;
                                }
                                children = children.concat(Array.prototype.slice.call(batch));
                                readBatch();
                            }, function() { resolve(); });
                        }
                        readBatch();
                    } else { resolve(); }
                });
            }
            return Promise.all(entries.map(function(e) { return readOne(e, ''); }))
                          .then(function() { return out; });
        }
        // Exposé pour TreeItem (drop sur un dossier de l'arbre, cf. utils.js).
        window.__elpisCollectDropEntries = _collectDropEntries;
        window.__elpisUploadEntries = uploadDroppedEntries;

        async function handleExplorerDrop(event) {
            explorerDragOver.value = false;
            if (window.__dropHandled && Date.now() - window.__dropHandled < 200) return;

            var dt = event.dataTransfer;
            // IMPORTANT : extraire les entries SYNCHRONEMENT — dataTransfer est
            // invalidé dès le retour du handler (donc avant tout await).
            var entries = [];
            if (dt.items && dt.items.length && typeof DataTransferItem !== 'undefined') {
                for (var i = 0; i < dt.items.length; i++) {
                    var it = dt.items[i];
                    if (it.kind !== 'file') continue;   // drag interne = 'string' → ignoré ici
                    var entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
                    if (entry) entries.push(entry);
                }
            }

            if (entries.length) {
                // Dossiers/fichiers du bureau → traversée préservant l'arbo.
                // On a EU des entries : on traite ici exclusivement et on
                // RETOURNE — même si vide (dossier vide) — pour ne PAS retomber
                // sur dt.files qui contient le « fichier dossier » fantôme.
                // Le parcours tourne DANS l'import (barre « Préparation »).
                uploadDroppedEntries(entries, '');
                return;
            }

            // Fallback (navigateur sans l'API entries) : fichiers plats.
            var files = dt.files;
            if (files && files.length > 0) { uploadFilesToSandbox(files, ''); return; }

            // Glisser interne (une ligne ou toute la sélection) → racine.
            var srcs = window.elpisDraggedPaths ? window.elpisDraggedPaths(dt) : [dt.getData('text/plain')];
            srcs.filter(function(p) { return p && p.indexOf('/') > 0; })
                .forEach(function(p) { editorMod.moveItem(p, ''); });
        }

        // déplacer ces listeners dans onMounted/onUnmounted.
        // Avant ils étaient attachés au scope du setup() (eager) sans
        // jamais être retirés — fuite garantie sur unmount du composant
        // racine. Voir aussi la handler list ci-dessous (ligne onMounted).
        function _onDragend() { explorerDragOver.value = false; }
        function _onDrop()    { explorerDragOver.value = false; }

        // Global: TreeItem calls this directly for file drops on folders
        window.__elpisUploadFiles = uploadFilesToSandbox;

        // (Welcome : plus aucun style calculé — fond et couleurs suivent le
        //  skin ; seule la taille est lue inline depuis welcomeConfig, les
        //  espacements sont figés dans chat.html.)

        // -- 12. WATCHERS -----------------------------------------

        // isAdminView → trigger initial data load when admin panel OPENS.
        // This is the primary fix: adminTab starts as 'dashboard' and Vue 3
        // watchers don't fire for the initial value, so without this watcher
        // loadAdminStats() was never called on first open → empty dashboard.
        // Chargement des données d'une page admin. Table unique consommée par
        // les DEUX watchers ci-dessous (ouverture de la console + changement de
        // page) : les deux listes avaient divergé — 'groups' n'était chargé
        // qu'à l'ouverture dans l'un, 'users' que dans l'autre.
        // Chaque valeur liste les chargeurs de la page sous forme
        // ``[nom, ...arguments]`` — les arguments sont EXPLICITES : plusieurs
        // chargeurs ont une signature (loadDailyReport(date), loadUsers(notify))
        // et un argument passé au hasard produirait « ?date=main » ou un toast
        // parasite. Chaque appel est protégé par un typeof : les modules
        // optionnels ne sont pas tous présents en mode admin-only.
        // Les chargeurs de chaque page viennent du REGISTRE de la console
        // (frontend/js/admin/_registry.js › loaders) : une seule table pour la
        // barre latérale, les titres, les liens profonds et les données.
        function _adminLoaders(tab) {
            const nav = window.ELPIS_ADMIN_NAV;
            const page = nav && nav.pages && nav.pages[tab];
            return (page && page.loaders) || [];
        }
        function _loadAdminTab(tab) {
            // Le tableau de bord est le seul à poller ; toute autre page arrête
            // le poll pour ne pas consommer un slot HTTP en arrière-plan.
            if (tab === 'dashboard') adminMod.startDashboardPolling();
            else adminMod.stopDashboardPolling();
            // Vue d'ensemble : rafraîchie tant qu'elle est affichée.
            if (tab === 'overview') adminMod.startOverviewPolling();
            else adminMod.stopOverviewPolling();
            for (const [fn, ...args] of _adminLoaders(tab)) {
                if (typeof adminMod[fn] === 'function') adminMod[fn](...args);
                else if (adminSkinsMod && typeof adminSkinsMod[fn] === 'function') adminSkinsMod[fn](...args);
                else if (adminRunsMod && typeof adminRunsMod[fn] === 'function') adminRunsMod[fn](...args);
            }
        }

        // isAdminView → chargement initial à l'OUVERTURE du panneau admin.
        // adminTab vaut déjà sa valeur (deep-link #<id> honoré au setup) et les
        // watchers Vue 3 ne se déclenchent pas sur la valeur initiale.
        watch(isAdminView, function(active) {
            if (!active) {
                adminMod.stopDashboardPolling();
                adminMod.stopOverviewPolling();
                // Re-render code blocks / charts when coming back to chat
                nextTick(function() { if (chatMod && chatMod.addCodeCopyButtons) chatMod.addCodeCopyButtons(true); });
                return;
            }
            _loadAdminTab(adminMod.adminTab.value);
            // Réglages « au démarrage » : marqueurs de la barre d'enregistrement
            // et bandeau « Redémarrage nécessaire » sur toutes les pages.
            adminMod.loadRestartStatus();
        });

        // Admin tab → chargement au CHANGEMENT de page dans la console.
        watch(function() { return adminMod.adminTab?.value; }, function(tab) {
            if (!isAdminView.value) return;   // ignore changes while not in admin
            _loadAdminTab(tab);
        });

        // User scroll detection (attach once the ref element is ready)
        let _scrollLockUntil = 0;
        let _lastScrollTop    = 0;
        // le watch peut fire plusieurs fois si Vue
        // recrée l'élément (toggle v-if dans des cas rares). On
        // garde une référence sur le DERNIER élément abonné et on
        // détache son listener avant d'attacher au nouveau. Sinon
        // chaque cycle ajoute un listener supplémentaire → N
        // requestAnimationFrame(_vsRecalc) par frame de scroll.
        let _scrollAttachedEl = null;
        let _scrollHandler = null;
        let _wheelHandler = null;
        let _touchStartHandler = null;
        let _touchMoveHandler = null;
        let _keyHandler = null;
        let _distResizeObs = null;
        let _touchY = 0;
        watch(function() { return chatMod.chatContainer?.value; }, function(el) {
            // Détacher les anciens listeners si on change d'élément (ou
            // si le ref devient null via unmount du composant).
            if (_scrollAttachedEl) {
                if (_scrollHandler)     _scrollAttachedEl.removeEventListener('scroll',     _scrollHandler);
                if (_wheelHandler)      _scrollAttachedEl.removeEventListener('wheel',      _wheelHandler);
                if (_touchStartHandler) _scrollAttachedEl.removeEventListener('touchstart', _touchStartHandler);
                if (_touchMoveHandler)  _scrollAttachedEl.removeEventListener('touchmove',  _touchMoveHandler);
                if (_keyHandler)        _scrollAttachedEl.removeEventListener('keydown',    _keyHandler);
                _scrollAttachedEl = null;
                _scrollHandler = null;
                _wheelHandler = null;
                _touchStartHandler = null;
                _touchMoveHandler = null;
                _keyHandler = null;
            }
            if (_distResizeObs) { _distResizeObs.disconnect(); _distResizeObs = null; }
            if (!el) return;
            _lastScrollTop = el.scrollTop;
            _scrollHandler = function() {
                // Position : TOUJOURS à jour, y compris pendant le lock —
                // la visibilité du bouton « descendre » suit les scrolls
                // programmatiques aussi (chargement de chat, autoscroll).
                const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
                chatAwayFromBottom.value = dist > _CHAT_AWAY_PX;

                // Skip programmatic scrolls (lock period after scrollToBottom, etc.)
                if (Date.now() < _scrollLockUntil) {
                    _lastScrollTop = el.scrollTop;
                    return;
                }

                const scrolledUp = el.scrollTop < _lastScrollTop;
                _lastScrollTop = el.scrollTop;

                // Disable autoscroll ONLY when user actively scrolls UP
                if (scrolledUp && dist > 120) {
                    isUserScrolling.value = true;
                } else if (dist <= 30) {
                    // Re-enable automatically when user scrolls back to bottom
                    // (gardé POST-lock : sinon l'événement scroll locké qui
                    // suit un wheel-up pendant un stream re-forcerait false).
                    isUserScrolling.value = false;
                }

                // Virtual scroll recalc
                if (chatMod.onChatScroll) chatMod.onChatScroll();
            };
            // Casser l'autoscroll sur INTENTION utilisateur (wheel/touch/
            // clavier), même pendant le lock : pendant un streaming, le lock
            // est renouvelé à chaque token (scrollToBottom → _lockAutoScroll)
            // et le handler scroll ne voit jamais les gestes — sans ces
            // listeners, impossible de remonter lire pendant une génération.
            // Garde `scrollHeight > clientHeight + 10` : ne pas figer
            // isUserScrolling=true sur un contenu qui tient dans le viewport
            // (aucun événement scroll dist<=30 ne viendrait le réarmer).
            // Limite résiduelle assumée : le drag de la scrollbar pendant un
            // stream reste mangé (pas d'event wheel/touch/key).
            _wheelHandler = function(e) {
                if (e.deltaY < 0 && el.scrollHeight > el.clientHeight + 10)
                    isUserScrolling.value = true;
            };
            _touchStartHandler = function(e) { _touchY = e.touches[0].clientY; };
            _touchMoveHandler = function(e) {
                // Doigt vers le BAS = contenu qui remonte = lecture de l'historique.
                if (e.touches[0].clientY - _touchY > 10 && el.scrollHeight > el.clientHeight + 10)
                    isUserScrolling.value = true;
            };
            _keyHandler = function(e) {
                if (e.key === 'PageUp' || e.key === 'Home' || e.key === 'ArrowUp')
                    isUserScrolling.value = true;
            };
            el.addEventListener('scroll',     _scrollHandler,     { passive: true });
            el.addEventListener('wheel',      _wheelHandler,      { passive: true });
            el.addEventListener('touchstart', _touchStartHandler, { passive: true });
            el.addEventListener('touchmove',  _touchMoveHandler,  { passive: true });
            el.addEventListener('keydown',    _keyHandler);
            // Le contenu peut grandir/rétrécir SANS événement scroll
            // (autoscroll cassé pendant un stream, switch vers un chat
            // court) → chatAwayFromBottom deviendrait obsolète. On observe
            // le viewport ET la colonne de contenu (persiste entre chats).
            _distResizeObs = new ResizeObserver(function() {
                chatAwayFromBottom.value =
                    (el.scrollHeight - el.scrollTop - el.clientHeight) > _CHAT_AWAY_PX;
            });
            _distResizeObs.observe(el);
            if (el.firstElementChild) _distResizeObs.observe(el.firstElementChild);
            chatAwayFromBottom.value =
                (el.scrollHeight - el.scrollTop - el.clientHeight) > _CHAT_AWAY_PX;
            _scrollAttachedEl = el;
        });

        // Expose lock function for chat module to use
        // 800ms n'est pas suffisant : un revealPositionInCenter
        // Monaco sur un fichier de 5000+ lignes peut s'étaler sur plusieurs
        // frames (smoothScrolling activé), et le watch chatContainer scroll
        // le voyait comme une intervention utilisateur → autoscroll cassé
        // pendant le streaming. 1500ms couvre le pire cas observé tout en
        // restant imperceptible si l'user scrolle volontairement après.
        ctx._lockAutoScroll = function() { _scrollLockUntil = Date.now() + 1500; };

        // -- 13. GLOBAL CLICK HANDLER ----------------------------
        function onGlobalClick(e) {
            if (contextMenu.value.isOpen) closeContextMenu();

            // Close RAG panel when clicking outside its anchor
            // Garde-fou : chatMod.showRagPanel peut être absent côté admin
            if (chatMod.showRagPanel && chatMod.showRagPanel.value) {
                const ragRef = chatMod.ragDropdownRef && chatMod.ragDropdownRef.value;
                if (ragRef && !ragRef.contains(e.target)) {
                    chatMod.showRagPanel.value = false;
                }
            }

            // Close composer "+" mini-menu when clicking outside its
            // anchor. Pattern identique au RAG/Memory panel : ref +
            // ref.contains(e.target). Le panneau Partages reçus, lui,
            // n'a PAS de fermeture sur clic externe (par parité avec
            // l'historique : seule l'Echap ou le X interne le ferment).
            if (chatMod.showComposerPlus && chatMod.showComposerPlus.value) {
                const cRef = chatMod.composerPlusRef && chatMod.composerPlusRef.value;
                if (cRef && !cRef.contains(e.target)) {
                    chatMod.showComposerPlus.value = false;
                }
            }

            // Close model manager dropdown when clicking outside
            if (chatMod.showModelManager && chatMod.showModelManager.value) {
                if (!e.target.closest('[data-model-manager]')) {
                    chatMod.showModelManager.value = false;
                }
            }

            // Close reasoning-effort menu (chip Effort du composeur) when
            // clicking outside its anchor — même pattern closest().
            if (chatMod.showReasoningEffortMenu && chatMod.showReasoningEffortMenu.value) {
                if (!e.target.closest('[data-effort-menu]')) {
                    chatMod.showReasoningEffortMenu.value = false;
                }
            }

            // Ferme le menu du profil réseau (onglet Sandbox) — même
            // patron closest() que le sélecteur de modèle.
            if (settingsMod && settingsMod.netMenuOpen && settingsMod.netMenuOpen.value) {
                if (!e.target.closest('[data-net-menu]')) {
                    settingsMod.netMenuOpen.value = false;
                }
            }

            // Close todo flyout (chip Tâches du composeur) when clicking
            // outside its anchor — même pattern closest() que le sélecteur
            // de modèle.
            if (chatMod.todoPanelOpen && chatMod.todoPanelOpen.value) {
                if (!e.target.closest('[data-todo-flyout]')) {
                    chatMod.todoPanelOpen.value = false;
                }
            }

            // Close export menu in admin when clicking outside
            if (showExportMenu.value) {
                if (!e.target.closest('[data-export-menu]')) {
                    showExportMenu.value = false;
                }
            }

            // Close notifications panel when clicking outside its anchor.
            if (showNotifPanel.value && notifDropdownRef.value) {
                if (!notifDropdownRef.value.contains(e.target)) {
                    showNotifPanel.value = false;
                }
            }
        }

        // -- 13b. NOTIFICATIONS (centre de notifications) ----------
        // Tous les appels passent par fetchAuth en mode soft (pas de toast ni
        // logout sur 401 silencieux) ; l'état live est rafraîchi par le SSE.
        // 2e argument (tick) : sert UNIQUEMENT à créer une dépendance réactive
        // dans le template pour que « il y a … » se réévalue avec notifNowTick.
        function notifTimeAgo(ts, _tick) {
            if (!ts) return '';
            const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
            if (s < 60)    return "à l'instant";
            if (s < 3600)  return 'il y a ' + Math.floor(s / 60)    + ' min';
            if (s < 86400) return 'il y a ' + Math.floor(s / 3600)  + ' h';
            return 'il y a ' + Math.floor(s / 86400) + ' j';
        }
        // Identité visuelle par type (icône + couleur). 5 kinds aujourd'hui
        // (+ extensions Lot 4) : un coup d'œil suffit à distinguer la nature.
        function notifIcon(kind) {
            switch (kind) {
                case 'routine_error':
                case 'scenario_failed':
                case 'tool_error':
                case 'compression_failed':
                case 'model_load_error':  return 'ph-warning-circle';
                case 'daily_report':      return 'ph-chart-line';
                case 'chat_done':         return 'ph-chat-circle-dots';
                case 'sandbox_quota':     return 'ph-hard-drives';
                case 'system_restart':    return 'ph-arrows-clockwise';
                default:                  return 'ph-check-circle';   // *_ok
            }
        }
        function notifColor(kind) {
            if (/error|failed/.test(kind || ''))   return 'text-red-500';
            if (kind === 'daily_report')           return 'text-indigo-500';
            if (kind === 'sandbox_quota')          return 'text-amber-500';
            if (kind === 'system_restart')         return 'text-slate-400';
            if (kind === 'chat_done')              return 'text-blue-500';
            return 'text-emerald-500';                                 // *_ok
        }
        // Surlignage « nouveau » de la session (cf. notifNewIds).
        function isNotifNew(n) { return !!n && notifNewIds.value.has(n.id); }

        // Groupement par tranche temporelle, calqué sur l'historique chat.
        function _notifBucket(ts) {
            const now = new Date();
            const d   = new Date((ts || 0) * 1000);
            const sameDay = (a, b) => a.getFullYear() === b.getFullYear()
                && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
            const yest = new Date(now); yest.setDate(now.getDate() - 1);
            if (sameDay(d, now))  return "Aujourd'hui";
            if (sameDay(d, yest)) return 'Hier';
            if ((Date.now() / 1000 - (ts || 0)) < 7 * 86400) return 'Cette semaine';
            return 'Plus ancien';
        }
        const groupedNotifications = computed(() => {
            const out = [];
            let cur = null;
            for (const n of notifications.value) {
                const b = _notifBucket(n.created_at);
                if (!cur || cur.label !== b) { cur = { label: b, items: [] }; out.push(cur); }
                cur.items.push(n);
            }
            return out;
        });

        async function loadNotifications() {
            notifLoading.value = true;
            notifError.value = false;
            try {
                const res = await fetchAuth('/api/notifications?limit=' + NOTIF_PAGE, {}, true);
                if (res && res.ok) {
                    const d = await res.json();
                    notifications.value = d.items || [];
                    notifHasMore.value = (notifications.value.length >= NOTIF_PAGE);
                    if (typeof d.unread === 'number') notifUnread.value = d.unread;
                } else {
                    notifError.value = true;
                }
            } catch (_) {
                notifError.value = true;
            } finally {
                notifLoading.value = false;
            }
        }
        // Pagination « Voir plus » : on pousse le lot suivant via le curseur id.
        async function loadMoreNotifs() {
            const last = notifications.value[notifications.value.length - 1];
            if (!last) return;
            notifLoading.value = true;
            try {
                const res = await fetchAuth('/api/notifications?limit=' + NOTIF_PAGE + '&before=' + last.id, {}, true);
                if (res && res.ok) {
                    const d = await res.json();
                    const more = d.items || [];
                    notifications.value = notifications.value.concat(more);
                    notifHasMore.value = (more.length >= NOTIF_PAGE);
                }
            } catch (_) { /* soft */ }
            finally { notifLoading.value = false; }
        }
        async function refreshNotifUnread() {
            const res = await fetchAuth('/api/notifications/unread-count', {}, true);
            if (res && res.ok) {
                const d = await res.json();
                notifUnread.value = d.count || 0;
            }
        }
        async function markNotifRead(id) {
            const n = notifications.value.find(x => x.id === id);
            if (n && !n.read_at) n.read_at = Date.now() / 1000;   // optimiste
            const res = await fetchAuth('/api/notifications/' + id + '/read', { method: 'PATCH' }, true);
            if (res && res.ok) { const d = await res.json(); notifUnread.value = d.unread ?? notifUnread.value; }
        }
        // Bascule lu ⇄ non-lu par item (« garder pour traiter plus tard »).
        async function toggleNotifReadState(n) {
            if (!n) return;
            const makeUnread = !!n.read_at;
            n.read_at = makeUnread ? null : (Date.now() / 1000);     // optimiste
            // Le repère « nouveau » suit l'état non-lu explicite.
            const next = new Set(notifNewIds.value);
            if (makeUnread) next.add(n.id); else next.delete(n.id);
            notifNewIds.value = next;
            const path = '/api/notifications/' + n.id + (makeUnread ? '/unread' : '/read');
            const res = await fetchAuth(path, { method: 'PATCH' }, true);
            if (res && res.ok) { const d = await res.json(); notifUnread.value = d.unread ?? notifUnread.value; }
        }
        async function markAllNotifsRead() {
            const now = Date.now() / 1000;
            notifications.value.forEach(n => { if (!n.read_at) n.read_at = now; });
            notifUnread.value = 0;
            notifNewIds.value = new Set();
            await fetchAuth('/api/notifications/read-all', { method: 'POST' }, true);
        }
        async function deleteNotif(id) {
            notifications.value = notifications.value.filter(n => n.id !== id);
            const res = await fetchAuth('/api/notifications/' + id, { method: 'DELETE' }, true);
            if (res && res.ok) { const d = await res.json(); notifUnread.value = d.unread ?? notifUnread.value; }
        }
        async function clearNotifs() {
            notifications.value = [];
            notifUnread.value = 0;
            notifNewIds.value = new Set();
            await fetchAuth('/api/notifications/clear', { method: 'POST' }, true);
        }
        // Ouvrir le panneau vaut « vu » : on solde le compteur ET on marque
        // read_at localement (cohérence badge ↔ état). Le repère « nouveau »
        // (surlignage) est porté à part par notifNewIds, capturé à l'ouverture,
        // donc il reste visible pour CETTE consultation sans diverger du badge.
        async function _silentMarkAllRead() {
            if (!notifUnread.value) return;
            const now = Date.now() / 1000;
            notifications.value.forEach(n => { if (!n.read_at) n.read_at = now; });
            notifUnread.value = 0;
            await fetchAuth('/api/notifications/read-all', { method: 'POST' }, true);
        }
        // Horloge réactive : ne tourne QUE panneau ouvert (granularité 1 min).
        let _notifTickTimer = null;
        function _startNotifTick() {
            if (_notifTickTimer) return;
            _notifTickTimer = setInterval(() => { notifNowTick.value++; }, 60000);
        }
        function _stopNotifTick() {
            if (_notifTickTimer) { clearInterval(_notifTickTimer); _notifTickTimer = null; }
        }
        function openNotifPanel() {
            showNotifPanel.value = true;
            _startNotifTick();
            loadNotifications().then(() => {
                // Capture les non-lues du moment comme « nouvelles » pour cette
                // consultation, PUIS solde (read_at + badge).
                notifNewIds.value = new Set(notifications.value.filter(n => !n.read_at).map(n => n.id));
                _silentMarkAllRead();
            });
        }
        function closeNotifPanel() {
            showNotifPanel.value = false;
            _stopNotifTick();
        }
        function toggleNotifPanel() {
            if (showNotifPanel.value) { closeNotifPanel(); return; }
            openNotifPanel();
        }
        // Clic sur une notif : la marque lue puis deep-link vers sa source.
        // Table ref_type → destination, best-effort : si la cible n'est pas
        // disponible (module absent, ref_id manquant), on se contente de marquer
        // lu sans naviguer (jamais d'erreur visible).
        async function openNotifItem(n) {
            if (!n) return;
            if (!n.read_at) markNotifRead(n.id);
            const rt  = n.ref_type || '';
            const rid = (n.ref_id != null) ? n.ref_id : null;
            try {
                if (rt === 'routine' && routinesMenuMod && routinesMenuMod.openRoutinesPage) {
                    showNotifPanel.value = false;
                    await routinesMenuMod.openRoutinesPage();
                    // Cible la routine PRÉCISE (+ son journal), pas la liste.
                    const list  = (routinesMenuMod.routines && routinesMenuMod.routines.value) || [];
                    const found = (rid != null) ? list.find(r => r.id === rid) : null;
                    if (found && routinesMenuMod.viewRoutine) routinesMenuMod.viewRoutine(found);
                    // Routine supprimée depuis : la page s'ouvrait sur la PREMIÈRE
                    // routine sans un mot — l'utilisateur lisait le journal d'une
                    // autre routine en croyant lire celui de la notification.
                    else if (rid != null) showToast('Routine introuvable (supprimée ?)', 'info');

                } else if (rt === 'daily_report') {
                    // Admin-only : ouvre l'onglet « Rapport du jour ».
                    showNotifPanel.value = false;
                    goToAdmin('report');

                } else if (rt === 'chat' && rid != null) {
                    // Notifs liées à une conversation (forward-compat : aucune notif
                    // backend 'chat' aujourd'hui — le ref_id est entier, les chats
                    // ont un id texte ; les signaux chat passent par des toasts/OS
                    // à closure directe, cf. notifyChatDone/notifyChatError).
                    _openChatById(rid);
                }
            } catch (_) { /* best-effort : pas de navigation, déjà marqué lu */ }
        }
        // Handler de l'event SSE {type:"notification"} (câblé via ctx → app-chat.js).
        // Le payload est ENRICHI par le backend (push_notification) :
        //   {user_id, id, kind, title, body, ref_type, ref_id, unread}
        // ce qui permet d'afficher un toast/notif OS d'aperçu et d'insérer
        // l'item dans la liste locale SANS aller-retour HTTP.
        function _handleNotificationEvent(data) {
            if (!data) return;
            const u = user.value;
            // Filtre destinataire : on ignore les notifs d'un autre utilisateur.
            if (u && data.user_id != null) {
                const myId = (u.id ?? u.user_id);
                if (myId != null && String(data.user_id) !== String(myId)) return;
            }
            if (typeof data.unread === 'number') notifUnread.value = data.unread;
            else notifUnread.value = (notifUnread.value || 0) + 1;

            // Reconstruit l'objet notif depuis le payload enrichi (legacy : id absent).
            const notif = (data.id != null) ? {
                id:        data.id,
                kind:      data.kind || '',
                title:     data.title || '',
                body:      data.body || '',
                ref_type:  data.ref_type || '',
                ref_id:    (data.ref_id != null ? data.ref_id : null),
                read_at:   null,
                created_at: Date.now() / 1000,
            } : null;

            // Insère en tête de la liste locale (dédup par id) → panneau à jour
            // sans refetch ; la reconnexion (Lot 5) n'a plus à tout recharger.
            if (notif && !notifications.value.some(n => n.id === notif.id)) {
                notifications.value.unshift(notif);
                // AUDIT 2026-08-02 (M5) — plafond, comme liveLogs (500) :
                // sans lui, 8 h de routines qui notifient = liste (titre
                // 300 c + corps 280 c) et scan some() O(n) sans borne.
                // Le panneau pagine de toute façon ; l'historique complet
                // reste en DB.
                if (notifications.value.length > 200) {
                    notifications.value.length = 200;
                }
            }

            // Panneau ouvert : l'utilisateur la voit déjà → on la marque
            // « nouvelle » (surlignage), on solde, et pas de toast/OS (doublon).
            if (showNotifPanel.value) {
                if (notif) { const s = new Set(notifNewIds.value); s.add(notif.id); notifNewIds.value = s; }
                _silentMarkAllRead();
                return;
            }

            // Annonce lecteur d'écran (région sr-only déjà câblée).
            if (notif && notif.title) announce('Nouvelle notification : ' + notif.title);

            // Toast in-app cliquable (aperçu + action « Voir » → deep-link).
            if (notif) {
                const isErr = /error|failed/.test(notif.kind);
                showToast(notif.title || 'Nouvelle notification', isErr ? 'error' : 'success', {
                    actionLabel: 'Voir',
                    onAction: () => openNotifItem(notif),
                });
            }

            // Notification OS native (opt-in, uniquement onglet en arrière-plan).
            _maybeOsNotify(notif);
        }

        // -- Livraison proactive : notification OS + badge titre d'onglet ----

        // Émet une notification du système d'exploitation si l'utilisateur l'a
        // activée (opt-in) ET seulement quand l'onglet n'est pas au premier plan
        // (au premier plan le toast suffit, inutile de doubler le signal).
        function _maybeOsNotify(n) {
            if (!n || !notifyOSEnabled.value || !notifyOSSupported) return;
            try {
                if (Notification.permission !== 'granted') return;
                if (document.visibilityState !== 'hidden') return;
                const osn = new Notification(n.title || 'Notification', {
                    body: n.body || '',
                    tag:  'elpis-notif-' + (n.id != null ? n.id : ''),
                });
                osn.onclick = () => {
                    try { window.focus(); } catch (_) {}
                    if (typeof n._onClick === 'function') n._onClick(); else openNotifItem(n);
                    try { osn.close(); } catch (_) {}
                };
            } catch (_) { /* best-effort */ }
        }

        // Active/désactive les notifications OS (demande la permission au besoin).
        async function toggleNotifyOS() {
            if (notifyOSEnabled.value) {
                notifyOSEnabled.value = false;
                try { localStorage.setItem('elpis.notifyOS', '0'); } catch (_) {}
                return;
            }
            if (!notifyOSSupported) { showToast('Notifications système non supportées par ce navigateur', 'error'); return; }
            if (!notifyOSSecure) {
                showToast("Notifications indisponibles : page non sécurisée. Ouvrez l'app en HTTPS ou via http://localhost.", 'error', { duration: 8000 });
                return;
            }
            const _blocked = "Notifications bloquées pour ce site dans le navigateur. Autorisez-les via le cadenas de la barre d'adresse, puis réessayez.";
            let perm = Notification.permission;
            // Déjà refusé au niveau navigateur : requestPermission ne re-demande
            // pas → message actionnable plutôt qu'un « refusé » opaque.
            if (perm === 'denied') { showToast(_blocked, 'error', { duration: 8000 }); return; }
            if (perm === 'default') {
                try { perm = await Notification.requestPermission(); } catch (_) { perm = 'denied'; }
            }
            if (perm === 'granted') {
                notifyOSEnabled.value = true;
                try { localStorage.setItem('elpis.notifyOS', '1'); } catch (_) {}
                showToast('Notifications système activées', 'success');
            } else {
                notifyOSEnabled.value = false;
                showToast(_blocked, 'error', { duration: 8000 });
            }
        }

        // Ouvre une conversation par son id (string) — repère partagé par le
        // deep-link des notifs « chat » et par les signaux de fin/erreur en
        // arrière-plan (Lot 4). Best-effort : si le module chat manque, no-op.
        function _openChatById(chatId) {
            if (chatId == null) return;
            showNotifPanel.value = false;
            if (isAdminView.value) isAdminView.value = false;
            currentView.value = 'chat';
            if (chatMod && chatMod.loadChat) chatMod.loadChat(chatId);
        }

        // Signale qu'une réponse de chat lancée en arrière-plan (autre onglet /
        // autre conversation) est PRÊTE : toast cliquable + notif OS + a11y.
        // Non persistant (la réponse vit déjà dans la conversation).
        function notifyChatDone(chatId, title) {
            const t = title || 'Conversation';
            announce('Réponse prête : ' + t);
            showToast(t + ' — réponse prête', 'success', {
                actionLabel: 'Ouvrir',
                onAction: () => _openChatById(chatId),
            });
            _maybeOsNotify({ id: 'chat-' + chatId, kind: 'chat_done', title: t,
                             body: 'La réponse est prête.', _onClick: () => _openChatById(chatId) });
        }
        // Signale qu'un run de chat en arrière-plan a ÉCHOUÉ.
        function notifyChatError(chatId, title, detail) {
            const t = title || 'Conversation';
            announce('Erreur dans : ' + t);
            showToast(t + ' — erreur' + (detail ? (' : ' + String(detail).slice(0, 80)) : ''), 'error', {
                actionLabel: 'Ouvrir',
                onAction: () => _openChatById(chatId),
            });
            _maybeOsNotify({ id: 'chaterr-' + chatId, kind: 'tool_error', title: t,
                             body: detail || 'Une erreur est survenue.', _onClick: () => _openChatById(chatId) });
        }

        // Badge dans le titre de l'onglet : « (N) Elpis » quand
        // l'onglet est en arrière-plan et qu'il y a des non-lus. Restauré dès
        // que l'onglet redevient visible ou que le compteur retombe à 0.
        let _titleBase = (typeof document !== 'undefined') ? (document.title || 'Elpis') : 'Elpis';
        function _applyTitleBadge() {
            if (typeof document === 'undefined') return;
            const n = notifUnread.value || 0;
            if (n > 0 && document.visibilityState === 'hidden') {
                document.title = '(' + (n > 99 ? '99+' : n) + ') ' + _titleBase;
            } else {
                document.title = _titleBase;
            }
        }
        watch(notifUnread, _applyTitleBadge);
        // Filet de sécurité : l'horloge réactive ne tourne que panneau ouvert,
        // quel que soit le chemin de fermeture (clic externe, Échap, deep-link).
        watch(showNotifPanel, (open) => { if (open) _startNotifTick(); else _stopNotifTick(); });

        // -- 14. LIFECYCLE ----------------------------------------

        // -- Global keyboard shortcuts --------------------------
        // Registered with { capture: true } so we intercept BEFORE
        // the browser (Firefox intercepts Ctrl+E for its search bar,
        // Ctrl+B for bookmarks, etc. at the bubble phase -- capture
        // phase fires first regardless of browser).
        //
        // Raccourcis clavier Ctrl/Cmd retirés : trop de collisions avec les
        // raccourcis réservés de Firefox (Ctrl+Shift+M = mode adaptatif,
        // Ctrl+Shift+N = fenêtre privée, Ctrl+Shift+R = reload forcé,
        // Ctrl+Shift+T = rouvrir l'onglet, etc.). Une page web ne peut PAS
        // neutraliser ces combos — le navigateur les capture avant la page.
        // Seul Escape est conservé : touche libre, comportement standard,
        // fiable — il ferme les panneaux superposés.

        // ── a11y : piège de focus + restitution pour les GRANDS modaux ──────
        // Les modaux plein écran (paramètres, MCP, aide, info, opencode,
        // model_props, AX, partage) partagent le même overlay `fixed inset-0`
        // marqué [data-a11y-modal]. Plutôt que câbler un garde dans chacun des
        // 8 open/close, on observe l'UNION de leurs flags : à l'ouverture on
        // mémorise le focus (et on entre dans le modal si lui-même ne l'a pas
        // fait) ; à la fermeture on restitue le focus au déclencheur. Le piège
        // Tab (dans onGlobalKeydown) cycle dans le modal ouvert. Le modal
        // générique confirm/prompt et le menu contextuel gardent LEUR propre
        // gestion (ils passent AVANT dans la pile z-index) → on leur cède.
        const _A11Y_FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), ' +
            'input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
        const _bigModalGuard = window.elpisFocusGuard();
        const _anyBigModalOpen = computed(function() {
            return !!(
                (settingsMod.showSettingsModal   && settingsMod.showSettingsModal.value)   ||
                (settingsMod.showMcpManagerModal && settingsMod.showMcpManagerModal.value) ||
                (settingsMod.isShareModalOpen    && settingsMod.isShareModalOpen.value)    ||
                (settingsMod.showHelpModal       && settingsMod.showHelpModal.value)       ||
                (showInfoModal.value) ||
                (showOpenCodeModal.value) ||
                (chatMod.showModelProps && chatMod.showModelProps.value) ||
                (chatMod.taskModal      && chatMod.taskModal.value)      ||
                // Fiche d'un outil (bouton « i » du panneau Outils) : petite,
                // mais c'est un dialog — piège Tab et garde de focus comme les
                // autres, sinon Tab s'échappe derrière l'overlay.
                (chatMod.toolInfo       && chatMod.toolInfo.value)       ||
                (adminMod.showAxModal   && adminMod.showAxModal.value)   ||
                // (passe 5, F7) — modales Git : piège Tab + garde de focus,
                // comme les autres (dialogs marqués data-a11y-modal).
                (editorMod.showGitCloneModal  && editorMod.showGitCloneModal.value)  ||
                (editorMod.showGitInitModal   && editorMod.showGitInitModal.value)   ||
                (editorMod.showGitRemoteModal && editorMod.showGitRemoteModal.value) ||
                (editorMod.showGitPushAuth    && editorMod.showGitPushAuth.value)    ||
                (editorMod.showGitMergeModal  && editorMod.showGitMergeModal.value)  ||
                // (passe 6, F14) — modales admin (mot de passe, nouvel
                // utilisateur) et groupes : marquées data-a11y-modal.
                (adminMod.resetTarget       && adminMod.resetTarget.value)       ||
                (authMod.showNewUserModal   && authMod.showNewUserModal.value)   ||
                (adminMod.groupModal        && adminMod.groupModal.value        && adminMod.groupModal.value.show)        ||
                (adminMod.groupMembersModal && adminMod.groupMembersModal.value && adminMod.groupMembersModal.value.show)
            );
        });
        watch(_anyBigModalOpen, function(open) {
            if (open) {
                _bigModalGuard.remember();
                nextTick(function() {
                    const overlay = document.querySelector('[data-a11y-modal]');
                    if (!overlay || overlay.contains(document.activeElement)) return;   // modal auto-focalisé → on n'écrase pas
                    const first = overlay.querySelector(_A11Y_FOCUSABLE);
                    if (first) first.focus();
                });
            } else {
                _bigModalGuard.restore();
            }
        });

        function onGlobalKeydown(e) {
            // a11y — piège Tab dans le grand modal ouvert. On cède au modal
            // confirm/prompt et au menu contextuel (au-dessus dans la pile),
            // qui gèrent déjà leur propre piège Tab.
            if (e.key === 'Tab' && _anyBigModalOpen.value
                && !modalState.value.isOpen && !contextMenu.value.isOpen) {
                const overlay = document.querySelector('[data-a11y-modal]');
                if (overlay) window.elpisTrapTab(e, overlay);
            }
            // -- Escape : ferme tous les panneaux superposés --------------
            if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey) {
                // Pas de preventDefault sur Escape -- Monaco/dropdowns en ont besoin aussi
                // (F7) marque l'événement : le listener de repli plein écran
                // de l'éditeur s'efface quand la cascade est active (sinon
                // double geste — la cascade ferme un overlay ET lui sortait
                // du plein écran sur le même Échap).
                e._elpisCascadeSaw = true;
                // -- Modal générique confirm/prompt EN PREMIER : c'est le modal
                //    le plus utilisé (z-7000, plein écran) et la porte de toutes
                //    les actions destructrices. Il est au sommet de la pile
                //    z-index, donc Echap doit le fermer avant tout autre overlay.
                //    (a11y : cohérence avec les autres modaux qui se ferment à Échap.)
                if (modalState.value.isOpen) { handleModalCancel(); return; }
                // -- Voix TRÈS HAUT dans la cascade : une dictée en cours ou
                //    une réponse qui se lit à voix haute est exactement ce que
                //    l'utilisateur cherche à arrêter quand il frappe Échap.
                //    Juste après le modal générique, qui reste au sommet de la
                //    pile z-index. Même contrat que codeEscape() : rend true
                //    quand il a consommé la touche.
                //    ⚠ Sauf quand une fenêtre, un menu du composeur ou Monaco
                //    attend cet Échap : il doit d'abord les fermer, sinon on
                //    ne pouvait plus quitter les Paramètres en pleine dictée.
                const _ae0 = document.activeElement;
                const _escAilleurs = _anyBigModalOpen.value
                    || (chatMod && chatMod.showSlash && chatMod.showSlash.value)
                    || (chatMod && chatMod.showMentionDropdown && chatMod.showMentionDropdown.value)
                    || (chatMod && chatMod.showComposerPlus && chatMod.showComposerPlus.value)
                    || !!(_ae0 && _ae0.closest && _ae0.closest('.monaco-editor'));
                if (!_escAilleurs && chatMod && chatMod.voiceEscape && chatMod.voiceEscape()) return;
                // -- Popover Importer de l'onglet Skills AVANT la modal
                //    Paramètres : ce handler est en capture:true, il court-
                //    circuite le @keydown.escape du template — sans ce pré-check
                //    Échap dans le menu Importer fermerait TOUTE la modal.
                if (skillsMenuMod.showSkillImportMenu && skillsMenuMod.showSkillImportMenu.value) {
                    skillsMenuMod.closeSkillImportMenu ? skillsMenuMod.closeSkillImportMenu() : (skillsMenuMod.showSkillImportMenu.value = false);
                    return;
                }
                // -- Menu du profil réseau (onglet Sandbox) AVANT la modal
                //    Paramètres, même raison que le popover Importer ci-dessus :
                //    ce handler est en CAPTURE, donc un stopPropagation posé
                //    dans le template s'exécute trop tard — sans ce pré-check,
                //    Échap dans le menu fermait TOUTE la modal (mesuré).
                if (settingsMod.netMenuOpen && settingsMod.netMenuOpen.value) {
                    settingsMod.closeNetMenu ? settingsMod.closeNetMenu() : (settingsMod.netMenuOpen.value = false);
                    return;
                }
                // (passe 6, F14) — modales admin/groupes (z-7500 puis z-6000)
                // et skill-assistant : absentes de la cascade, Échap les
                // traversait et fermait l'overlay du dessous (page admin,
                // Paramètres) en les laissant peintes. Transfert : fermable
                // seulement une fois terminé (progression en cours = on garde).
                if (adminMod.paletteOpen && adminMod.paletteOpen.value)                                                      { adminMod.closePalette(); return; }
                if (adminMod.adminMeOpen && adminMod.adminMeOpen.value)                                                      { adminMod.adminMeOpen.value = false; return; }
                if (adminMod.dashMenu && adminMod.dashMenu.value)                                                            { adminMod.dashMenu.value = null; return; }
                if (adminMod.engineDrawer && adminMod.engineDrawer.value)                                                    { adminMod.closeEngineDrawer(); return; }
                if (adminMod.groupModal && adminMod.groupModal.value && adminMod.groupModal.value.show)                      { adminMod.groupModal.value.show = false; return; }
                if (adminMod.groupMembersModal && adminMod.groupMembersModal.value && adminMod.groupMembersModal.value.show) { adminMod.groupMembersModal.value.show = false; return; }
                if (adminMod.resetTarget && adminMod.resetTarget.value)                                                      { adminMod.resetTarget.value = null; return; }
                if (authMod.showNewUserModal && authMod.showNewUserModal.value)                                              { authMod.showNewUserModal.value = false; return; }
                if (chatMod.skillAssistForm && chatMod.skillAssistForm.value && chatMod.skillAssistForm.value.open)          { chatMod.skillAssistForm.value.open = false; return; }
                if (chatMod.toolInfo && chatMod.toolInfo.value)                                                              { chatMod.closeToolInfo(); return; }
                // « Détails » d'une exécution (chat et console › Exécutions).
                if (chatMod.runDetails && chatMod.runDetails.value && chatMod.closeRunDetails)                               { chatMod.closeRunDetails(); return; }
                if (adminMod.transferModal && adminMod.transferModal.value && adminMod.transferModal.value.active
                        && (adminMod.transferModal.value.done || adminMod.transferModal.value.error)) {
                    if (adminMod.closeTransferModal) adminMod.closeTransferModal();
                    return;
                }
                // -- Modals plein écran d'abord : ils sont au-dessus des panneaux
                //    dans la pile z-index, donc Echap doit fermer le modal en
                //    priorité avant tout dropdown sous-jacent. Gardes ?. car les
                //    modules peuvent retomber sur {} via _safeSetup.
                if (settingsMod.showSettingsModal && settingsMod.showSettingsModal.value)     { (settingsMod.closeSettings ? settingsMod.closeSettings() : settingsMod.showSettingsModal.value = false); return; }
                // (2026-09-20) Même sortie que le bouton Fermer : la liste des serveurs
                // est persistée si elle a changé et les identifiants saisis sont effacés.
                if (settingsMod.showMcpManagerModal && settingsMod.showMcpManagerModal.value) { (settingsMod.closeMcpManager ? settingsMod.closeMcpManager() : settingsMod.showMcpManagerModal.value = false); return; }
                if (settingsMod.isShareModalOpen && settingsMod.isShareModalOpen.value)       { settingsMod.isShareModalOpen.value = false; return; }
                if (settingsMod.showHelpModal && settingsMod.showHelpModal.value)             { settingsMod.showHelpModal.value = false; return; }
                if (showInfoModal.value)                                                      { showInfoModal.value = false; return; }
                if (showOpenCodeModal.value)                                                 { showOpenCodeModal.value = false; return; }
                if (chatMod.showModelProps && chatMod.showModelProps.value)                   { chatMod.showModelProps.value = false; return; }
                if (chatMod.taskModal && chatMod.taskModal.value)                             { chatMod.closeTaskModal ? chatMod.closeTaskModal() : (chatMod.taskModal.value = null); return; }
                if (adminMod.showAxModal && adminMod.showAxModal.value)                        { adminMod.showAxModal.value = false; return; }
                // (F8) Modale Raccourcis de l'éditeur : son @keydown.esc de
                // template était INERTE (div non focusable, l'événement ne
                // naît jamais dedans) — la cascade est le vrai canal.
                if (editorMod.shortcutsModalVisible && editorMod.shortcutsModalVisible.value)   { editorMod.closeShortcutsModal ? editorMod.closeShortcutsModal() : (editorMod.shortcutsModalVisible.value = false); return; }
                // (passe 5, F7) — les 5 modales Git : absentes de la cascade,
                // leur @keydown.esc de backdrop ne marchait que tant que le
                // focus restait dans le champ autofocusé, et la cascade
                // traversait (fermait un popover/le plein écran EN PLUS).
                if (editorMod.showGitCloneModal && editorMod.showGitCloneModal.value)   { editorMod.showGitCloneModal.value = false; return; }
                if (editorMod.showGitInitModal && editorMod.showGitInitModal.value)     { editorMod.showGitInitModal.value = false; return; }
                if (editorMod.showGitRemoteModal && editorMod.showGitRemoteModal.value) { editorMod.showGitRemoteModal.value = false; return; }
                if (editorMod.showGitPushAuth && editorMod.showGitPushAuth.value)       { editorMod.showGitPushAuth.value = false; return; }
                if (editorMod.showGitMergeModal && editorMod.showGitMergeModal.value)   { editorMod.showGitMergeModal.value = false; return; }
                if (imgZoom.value)                                                            { imgZoom.value = null; return; }
                // Popovers de l'éditeur (menu import, débordement d'onglets, menu
                // contextuel d'onglet) : fermables au clavier comme les autres
                // overlays — avant, seul le clic externe (backdrop) les fermait.
                if (editorMod.showEditorMore && editorMod.showEditorMore.value)     { editorMod.showEditorMore.value = false; return; }
                if (editorMod.showImportMenu && editorMod.showImportMenu.value)     { editorMod.showImportMenu.value = false; return; }
                if (editorMod.showTabsOverflow && editorMod.showTabsOverflow.value) { editorMod.showTabsOverflow.value = false; return; }
                if (editorMod.tabCtxMenu && editorMod.tabCtxMenu.value && editorMod.tabCtxMenu.value.show) { editorMod.closeTabCtxMenu ? editorMod.closeTabCtxMenu() : (editorMod.tabCtxMenu.value.show = false); return; }
                // Menu « / » du composeur. Sans cette entrée, Échap fermait le
                // menu (handler de la textarea) ET l'overlay suivant de la
                // pile : ce listener est en CAPTURE, un stopPropagation posé
                // dans la textarea s'exécute trop tard pour l'en empêcher.
                if (chatMod.showSlash && chatMod.showSlash.value) { chatMod.slashDismiss && chatMod.slashDismiss(); return; }
                if (chatMod.showMentionDropdown && chatMod.showMentionDropdown.value) { chatMod.closeMentionDropdown && chatMod.closeMentionDropdown(); return; }
                if (chatMod.showSamplingPanel && chatMod.showSamplingPanel.value) { chatMod.showSamplingPanel.value = false; return; }
                if (chatMod.showMcpPanel && chatMod.showMcpPanel.value)  { chatMod.showMcpPanel.value  = false; return; }
                if (chatMod.showRagPanel && chatMod.showRagPanel.value) { chatMod.showRagPanel.value = false; return; }
                if (chatMod.showComposerPlus && chatMod.showComposerPlus.value) { chatMod.showComposerPlus.value = false; return; }
                if (chatMod.showModelManager && chatMod.showModelManager.value) { chatMod.showModelManager.value = false; return; }
                if (chatMod.showReasoningEffortMenu && chatMod.showReasoningEffortMenu.value) { chatMod.showReasoningEffortMenu.value = false; return; }
                if (showNotifPanel.value) { showNotifPanel.value = false; return; }
                if (settingsMod.showSharedPrompts && settingsMod.showSharedPrompts.value) {
                    settingsMod.showSharedPrompts.value = false; return;
                }
                // Menu contextuel (clic droit chat/fichier) : fermable au clavier.
                if (contextMenu.value.isOpen) { closeContextMenu(); return; }
                // Overlays plein écran (currentView) en DERNIER : un modal ouvert
                // par-dessus doit se fermer avant la page sous-jacente.
                if (currentView.value === 'routines') {
                    // En pleine édition, Échap = même geste que la flèche du header
                    // (retour vue lecture) — fermer TOUTE la page jetait le
                    // formulaire sans confirmation (réflexe Échap ≠ tout perdre).
                    if (routinesMenuMod.routineIsEditing && routinesMenuMod.routineIsEditing.value) {
                        if (routinesMenuMod.cancelRoutineEdit) routinesMenuMod.cancelRoutineEdit();
                        return;
                    }
                    if (routinesMenuMod.closeRoutinesPage) routinesMenuMod.closeRoutinesPage();
                    else currentView.value = 'chat';
                    return;
                }
                if (currentView.value === 'studio') {
                    // (passe 5, F3) — les overlays du Studio D'ABORD : la
                    // cascade fermait la PAGE entière sous la modale de
                    // saisie, le menu contextuel de scène ou le glisser armé
                    // (dont le badge affiche « Annuler (Échap) »).
                    if (studioChatMod.studioTextModal && studioChatMod.studioTextModal.value) {
                        if (studioChatMod.textModalCancel) studioChatMod.textModalCancel();
                        return;
                    }
                    if (studioChatMod.studioCtxMenu && studioChatMod.studioCtxMenu.value) {
                        if (studioChatMod.closeStudioCtx) studioChatMod.closeStudioCtx();
                        return;
                    }
                    if (studioChatMod.studioDragFrom && studioChatMod.studioDragFrom.value) {
                        if (studioChatMod.cancelStudioDrag) studioChatMod.cancelStudioDrag();
                        return;
                    }
                    if (studioMenuMod.closeStudio) studioMenuMod.closeStudio();
                    else currentView.value = 'chat';
                    return;
                }
                if (currentView.value === 'code') {
                    // popovers de la page (sélecteur modèle, menu « / », drawer)
                    // d'abord ; ensuite session → liste → chat (closeCodePage).
                    if (codeMenuMod.codeEscape && codeMenuMod.codeEscape()) return;
                    if (codeMenuMod.closeCodePage) codeMenuMod.closeCodePage();
                    else currentView.value = 'chat';
                    return;
                }
                // (F7) Plein écran éditeur en DERNIER : tout overlay au-dessus
                // se ferme d'abord ; on ne quitte le plein écran que si rien
                // d'autre n'a consommé cet Échap.
                if (editorMod.editorFullscreen && editorMod.editorFullscreen.value) {
                    // Recherche, autocomplétion, renommage, multi-curseur :
                    // Échap les referme DANS Monaco — ne pas quitter en plus
                    // le plein écran sur la même touche.
                    if (editorMod.monacoConsumesEscape && editorMod.monacoConsumesEscape(e)) return;
                    if (editorMod.exitEditorFullscreen) editorMod.exitEditorFullscreen();
                    else editorMod.editorFullscreen.value = false;
                    return;
                }
                return;
            }

            // -- Ctrl/Cmd+Maj+O : nouveau chat (cf. tooltip du bouton
            //    "Nouveau chat" de la sidebar). Ctrl+N est réservé par le
            //    navigateur (nouvelle fenêtre), donc inutilisable ici.
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'O' || e.key === 'o')) {
                // Curseur dans le code : c'est « Aller au symbole » de Monaco
                // (même raccourci que VS Code), pas un nouveau chat.
                const _ae = document.activeElement;
                if (_ae && _ae.closest && _ae.closest('.monaco-editor')) return;
                e.preventDefault();
                // (passe 4, F10) — pas de nouveau chat SOUS une modale : un
                // confirm en attente (suppression…) ou les Préférences avec
                // modifs non sauvées basculaient la conversation en dessous
                // sans passer par leurs gardes. L'utilisateur ferme d'abord.
                if (modalState.value.isOpen
                        || (settingsMod.showSettingsModal && settingsMod.showSettingsModal.value)) {
                    return;
                }
                currentView.value = 'chat';
                if (chatMod.startNewChat) chatMod.startNewChat();
                return;
            }
        }

        // -- Session-crash recovery -------------------------------------------
        // la clé sessionStorage est namespacée par user_id pour
        // éviter qu'un user B qui se logue dans le même onglet ne récupère
        // la session de A (cas changement de compte sans fermer l'onglet).
        const SESSION_KEY_BASE = 'elpis_chat_session';
        function _sessionKey() {
            const u = user.value;
            const uid = (u && (u.id ?? u.user_id ?? u.username)) || 'anon';
            return SESSION_KEY_BASE + ':' + String(uid);
        }

        function _saveSession() {
            if (!user.value) return;
            const SESSION_KEY = _sessionKey();
            try {
                // AUDIT 2026-08-01 (E2) : le filtre écartait les messages sans
                // texte — or un `notice` de compaction a `content: ''` (cf.
                // app-chat.js `_flash`) et un message image-seule aussi. Comme
                // ce snapshot court-circuite `loadChat` au restore et devient
                // la source de vérité repersistée au tour suivant, tout ce
                // qu'il perd est effacé EN BASE. Même règle de conservation
                // que `_keepForPersist` côté app-chat.js.
                const msgs = messages.value.filter(m => m.role && (
                    m.role === 'notice'
                    || m.content
                    || (m.images && m.images.length)
                    || (m.tool_history && m.tool_history.length)
                ));
                if (!msgs.length) { sessionStorage.removeItem(SESSION_KEY); return; }
                sessionStorage.setItem(SESSION_KEY, JSON.stringify({
                    chatId:   currentChatId.value,
                    title:    chatMod.currentChatTitle ? chatMod.currentChatTitle.value : '',
                    // Toggles d'outils (catégories + ``ext:<id>``). MÊME raison
                    // que les todos juste dessous : le restore court-circuite
                    // loadChat, donc meta_json["tools"] n'est jamais rejoué. Sans
                    // ce champ, les toggles repartaient à zéro après un F5 et le
                    // premier PUT /tools écrivait cette liste VIDE en base — la
                    // sélection du chat était perdue pour de bon.
                    tools:    chatMod.activeToolCats ? chatMod.activeToolCats() : null,
                    // Todo-list de session : le restore court-circuite loadChat
                    // (seed meta_json["todos"] jamais rejoué) → sans ce champ,
                    // un simple F5 faisait disparaître le panneau alors que la
                    // liste avait encore des tâches ouvertes.
                    todos:    (chatMod.todoList && Array.isArray(chatMod.todoList.value))
                                  ? chatMod.todoList.value : [],
                    messages: msgs.map(m => ({
                        role:           m.role,
                        content:        m.content,
                        images:         m.images,
                        files:          m.files,
                        displayContent: m.displayContent,
                        thinking:       m.thinking,
                        isError:        m.isError,
                        metrics:        m.metrics,
                        // Champs structurés qui doivent SURVIVRE au reload
                        // in-tab (le restore court-circuite loadChat) :
                        // séquence agentic (bouton « Continuer ») + marqueur
                        // de format delta + cartes agents persistantes
                        // (outil `task`).
                        tool_history:   m.tool_history,
                        tool_history_delta: m.tool_history_delta,
                        taskRuns:       m.taskRuns,
                        // E1 : `isTruncated` pilote SEUL le bouton
                        // « Continuer ». Sans lui, un tour coupé par le
                        // plafond d'itérations devient irrécupérable après un
                        // simple F5 (et le flag est perdu en base au tour
                        // suivant).
                        isTruncated:    m.isTruncated,
                        // E2 : champs du marqueur de compaction — sans eux le
                        // notice restauré serait vide de sens.
                        kind:           m.kind,
                        ts:             m.ts,
                        round:          m.round,
                        tokens_after:   m.tokens_after,
                        summary:        m.summary,
                        // Fichiers modifiés par les outils (diffs du chat).
                        files_changed:    m.files_changed,
                    })),
                    savedAt: Date.now(),
                }));
            } catch(e) {}
        }

        function _restoreSession() {
            const SESSION_KEY = _sessionKey();
            try {
                const raw = sessionStorage.getItem(SESSION_KEY);
                if (!raw) return;
                const data = JSON.parse(raw);
                // Only restore if recent (< 1h) and current chat is empty
                if (!data || !data.messages || !data.messages.length) return;
                if (Date.now() - data.savedAt > 3600000) { sessionStorage.removeItem(SESSION_KEY); return; }
                if (messages.value.length > 0) return;
                // Restore
                currentChatId.value = data.chatId || null;
                if (chatMod.currentChatTitle) chatMod.currentChatTitle.value = data.title || '';
                // Toggles d'outils : ré-appliqués AVANT tout (applyChatTools
                // recale ``_toolsLastSentSig``, ce qui empêche le watcher du
                // panneau de prendre l'état vide du boot pour un changement de
                // l'utilisateur et de le PUT en base). ``null`` = snapshot d'une
                // version antérieure : on ne touche à rien plutôt que d'écraser.
                try {
                    if (Array.isArray(data.tools) && chatMod.applyChatTools) {
                        chatMod.applyChatTools(data.tools);
                    }
                } catch (_) {}
                // Re-seed du panneau todo depuis le snapshot (même règle que
                // loadChat : une liste entièrement soldée ne réapparaît pas ;
                // panneau replié — todoPanelOpen reste à false au boot).
                try {
                    const _td = Array.isArray(data.todos) ? data.todos : [];
                    const _open = _td.some(t => t && t.status !== 'completed' && t.status !== 'cancelled');
                    if (chatMod.todoList) chatMod.todoList.value = _open ? _td : [];
                } catch (_) {}
                // Reconstruction de la vue entrelacée texte/outils (et du bloc
                // terminal en direct) depuis tool_history — même chemin que le
                // reload normal (_history.js). Sans ça, le restore court-circuite
                // loadChat et TOUT l'affichage outils disparaissait après un
                // reload in-tab (toolSteps/segTexts jamais reconstruits) ; un
                // re-clic sidebar sur le même chat ne réparait rien (loadChat
                // court-circuité sur id identique).
                let _prevTH = null;
                messages.value = data.messages.map(m => {
                    const msg = {
                        ...m,
                        events: [], thinkingOpen: false, isStreaming: false,
                        // E1 — NE PAS forcer `isTruncated` à false : il vient
                        // du snapshot et pilote seul le bouton « Continuer ».
                        // L'écraser rendait toute reprise impossible après un
                        // F5, y compris pour un `loadChat` ultérieur (le flag
                        // était réécrit en base au tour suivant).
                        isTruncated: !!m.isTruncated,
                    };
                    try {
                        if (m.role === 'assistant' && Array.isArray(m.tool_history)
                            && m.tool_history.length && window.elpisToolSegments) {
                            const _segs = window.elpisToolSegments.parseToolHistorySegments(
                                m.tool_history,
                                { prevHistory: _prevTH,
                                  delta: !!m.tool_history_delta,
                                  finalContent: (typeof m.content === 'string' ? m.content : '') || '' });
                            if (_segs && _segs.toolSteps.length) {
                                msg.toolSteps = _segs.toolSteps;
                                msg.segTexts  = _segs.segTexts;
                            }
                            _prevTH = m.tool_history;
                        }
                    } catch (_) { /* best-effort : restore sans segments */ }
                    return msg;
                });
                sessionStorage.removeItem(SESSION_KEY);
                setTimeout(() => {
                    chatMod.scrollToBottom && chatMod.scrollToBottom(true);
                    chatMod.addCodeCopyButtons && chatMod.addCodeCopyButtons(true);
                }, 200);
                // Chantier C (2026-09-16, R8) — rechargement PENDANT un tour : le
                // snapshot ne sait rien du run qui continue côté serveur. S'il
                // tourne encore, on relit la conversation depuis la base, ce qui
                // s'y RATTACHE (rejeu du journal puis direct) au lieu de laisser
                // un fil figé sans indicateur ni bouton Stop.
                const _rid = data.chatId;
                if (_rid && chatMod.loadChat) {
                    fetchAuth('/api/chat/' + encodeURIComponent(_rid) + '/generation-status', {}, true)
                        .then(r => (r && r.ok) ? r.json() : null)
                        .then(d => {
                            if (d && d.generation_running
                                    && String(currentChatId.value) === String(_rid)) {
                                chatMod.loadChat(_rid, { force: true });
                            }
                        })
                        .catch(() => {});
                }
            } catch(e) {}
        }

        function _onBeforeUnload() { _saveSession(); }

        // ── Deep-link « Interroger » (#ask) ────────────────────────────────
        // L'onglet Documents de rag_app (service séparé, port :8444) ouvre
        // le chatbot sur ``/#ask?collection=…&doc=…&rag=…[&q=…]`` : on
        // démarre un chat RAG scopé sur le document OCR via
        // startDocumentChat. Le hash est consommé (replaceState) pour
        // qu'un F5 ne relance pas un chat ; s'il n'y a PAS de session, on
        // le laisse en place — le watch(user) rejoue après login.
        function maybeHandleAskDeepLink() {
            if (window.__ADMIN_ONLY_MODE__) return;
            const h = window.location.hash || '';
            if (!h.startsWith('#ask')) return;
            if (!chatMod.startDocumentChat) return;
            const qs = h.includes('?') ? h.slice(h.indexOf('?') + 1) : '';
            const params = new URLSearchParams(qs);
            const collection = (params.get('collection') || '').trim();
            if (!collection) return;
            history.replaceState(null, '', window.location.pathname);
            chatMod.startDocumentChat({
                collection: collection,
                docName: (params.get('doc') || '').trim() || 'document',
                ragName: (params.get('rag') || '').trim(),
                question: (params.get('q') || '').trim(),
            });
        }

        onMounted(async function() {
            document.addEventListener('click',   onGlobalClick);
            // capture: true → fires before browser default handlers (Escape only)
            document.addEventListener('keydown', onGlobalKeydown, { capture: true });
            window.addEventListener('beforeunload', _onBeforeUnload);
            // drag listeners gérés par le lifecycle.
            document.addEventListener('dragend', _onDragend);
            // Capture phase: fires BEFORE any stopPropagation in tree-items
            document.addEventListener('drop', _onDrop, true);
            // Badge titre d'onglet : réappliqué au focus/blur de l'onglet.
            document.addEventListener('visibilitychange', _applyTitleBadge);
            await authMod.loadPublicConfig();
            await authMod.checkAuth();
            if (user.value) {
                // Gardé (&&) : si un sous-bundle chat manque, _safeSetup
                // retombe sur chatMod={} — ne pas crasher tout onMounted.
                chatMod.connectSystemEvents && chatMod.connectSystemEvents();
                if (!window.__ADMIN_ONLY_MODE__) {
                    // En admin-only, ces hooks tentent /api/inbox/count et
                    // /api/saved/chats/:id qui n'existent pas sur le port admin.
                    // On garde uniquement le SSE (qui sert à la live console
                    // de logs et que l'admin app sert bien).
                    settingsMod.startInboxPolling();
                    // Charge la LISTE (items + unread) et pas seulement le badge :
                    // le panneau est ainsi à jour dès la 1re ouverture, y compris
                    // pour les notifs créées pendant que l'onglet était fermé.
                    loadNotifications();
                    _restoreSession();
                    // Après restauration : un éventuel #ask (venu de rag_app)
                    // prime et ouvre le chat documentaire.
                    maybeHandleAskDeepLink();
                }
            }
        });

        onUnmounted(function() {
            document.removeEventListener('click',   onGlobalClick);
            document.removeEventListener('keydown', onGlobalKeydown, { capture: true });
            window.removeEventListener('beforeunload', _onBeforeUnload);
            document.removeEventListener('dragend', _onDragend);
            document.removeEventListener('drop', _onDrop, true);
            document.removeEventListener('visibilitychange', _applyTitleBadge);
            chatMod.disconnectSystemEvents && chatMod.disconnectSystemEvents();
            adminMod.stopDashboardPolling();
            adminMod.stopOverviewPolling();
            settingsMod.stopInboxPolling();
        });

        // Start/stop inbox polling when the user session changes (login / logout)
        watch(user, (val, oldVal) => {
            if (val) {
                // SSE système : onMounted ne le connecte que si une session
                // existait déjà au chargement. Quand on se connecte via la
                // carte de login, c'est CE watch qui doit ouvrir le flux
                // (bannière restart, notifications live, statut modèles) —
                // y compris en admin-only (console de logs live).
                // connectSystemEvents est idempotent (ferme l'EventSource
                // existant avant d'en rouvrir un).
                if (chatMod.connectSystemEvents) chatMod.connectSystemEvents();
                if (!window.__ADMIN_ONLY_MODE__) {
                    settingsMod.startInboxPolling();
                    // Liste complète au login (items + unread) — voir onMounted.
                    loadNotifications();
                    _restoreSession();
                    // Arrivée non authentifiée sur un lien #ask : le hash a
                    // été laissé en place — rejouer maintenant qu'on a une
                    // session.
                    maybeHandleAskDeepLink();
                }
            } else {
                settingsMod.stopInboxPolling();
                notifications.value = [];
                notifUnread.value = 0;
                showNotifPanel.value = false;
                // AUDIT 2026-08-02 (S3) — purge d'état COMPLÈTE sur toute
                // désauthentification (401 de fetchAuth, event SSE
                // session_expired, logout volontaire). Avant, seule logout()
                // purgeait : après une simple expiration, la conversation,
                // les onglets Monaco et les credentials git du compte
                // précédent restaient en mémoire — et le compte suivant qui
                // se connectait dans le même onglet voyait la conversation
                // d'autrui (_restoreSession fait un return anticipé quand
                // messages n'est pas vide). Chaque étape est défensive :
                // les modules peuvent être absents (console admin split).
                messages.value = [];
                if (ctx.chats) ctx.chats.value = [];
                currentChatId.value = null;
                isAdminView.value = false;
                // Modifications non enregistrées mises de côté AVANT la purge
                // (E2) : restaurables à la reconnexion de ce compte.
                try { editorMod && editorMod.rescueDirtyBuffers && editorMod.rescueDirtyBuffers(); } catch (_) {}
                if (ctx.showEditor) ctx.showEditor.value = false;
                if (ctx.openTabs) ctx.openTabs.value = [];
                if (ctx.models) {
                    Object.values(ctx.models).forEach(m => { try { m.dispose(); } catch(_) {} });
                    Object.keys(ctx.models).forEach(k => delete ctx.models[k]);
                }
                try { ctx.resetChatOnLogout(); }   catch (_) {}
                try { ctx.resetEditorOnLogout(); } catch (_) {}
                isStreaming.value = false;
                try { adminMod && adminMod.stopDashboardPolling && adminMod.stopDashboardPolling(); } catch (_) {}
                try { adminMod && adminMod.stopOverviewPolling && adminMod.stopOverviewPolling(); } catch (_) {}
                // AUDIT 2026-08-02 (S7) — les modales vivent HORS des blocs
                // v-if="user" et sont peintes AU-DESSUS de la carte de login
                // (z-6000/7000 > z-5000) : sans fermeture explicite,
                // l'utilisateur restait à cliquer dans une modale morte sans
                // jamais voir le formulaire de connexion.
                if (modalState.value.isOpen) {
                    try { modalState.value.resolve && modalState.value.resolve(false); } catch (_) {}
                    modalState.value.isOpen = false;
                }
                try { ctx.closeSettings(true); } catch (_) {}
                // AUDIT 2026-08-02 (E7) — la page Code (/remote) échappait à la
                // purge S3 : currentView restait 'code', aucune reconnexion au
                // login, état jamais vidé → l'utilisateur suivant voyait sessions
                // opencode + transcript + token de l'ancien dans le même onglet.
                // On coupe le flux, on vide l'état, et on force la vue sur 'chat'
                // (couvre aussi studio/admin, pour un point d'entrée neutre).
                try { codeMenuMod.codeResetOnLogout && codeMenuMod.codeResetOnLogout(); } catch (_) {}
                showOpenCodeModal.value = false;
                try { currentView.value = 'chat'; } catch (_) {}
                // (passe 5, F15) — libère la capture d'écran du Studio (blob
                // de la machine cible) : elle survivait au logout.
                try { studioMenuMod.clearStudio && studioMenuMod.clearStudio(); } catch (_) {}
                // Studio d'automatisation : script courant oublié au logout
                // (fichiers du compte sortant).
                try { studioAutomationMod.resetAutomation && studioAutomationMod.resetAutomation(); } catch (_) {}
                // AUDIT 2026-09-01 (passe 5, F6) — l'overlay de zoom des
                // DIAGRAMMES (créé hors Vue par _rendering.js, z-9999) avait
                // le même défaut que imgZoom ci-dessous : il survivait au
                // logout et se peignait AU-DESSUS de l'écran de login, avec
                // le diagramme du compte précédent. ``_elpisClose`` (posé par
                // _openDiagramZoom) retire aussi ses listeners window.
                try {
                    document.querySelectorAll('.elpis-diagram-zoom-overlay').forEach(function(el) {
                        try { el._elpisClose ? el._elpisClose() : el.remove(); }
                        catch (_) { try { el.remove(); } catch (_e) {} }
                    });
                } catch (_) {}
                // AUDIT 2026-08-02 (F4) — l'overlay imgZoom (z-9999 > login 9990)
                // restait peint AU-DESSUS du login et gardait l'image en mémoire.
                try { imgZoom.value = null; } catch (_) {}
                // AUDIT 2026-08-02 (F3) — la modale de transfert (hors v-if user)
                // survivait au logout et réapparaissait au login suivant.
                try { adminMod && adminMod.closeTransferModal && adminMod.closeTransferModal(); } catch (_) {}
                // Purge la session de l'user qui vient de se déconnecter
                // ainsi que la clé legacy non-namespacée (anciens onglets).
                // AUDIT 2026-08-02 (S-mineur) — la clé est dérivée d'oldVal :
                // _sessionKey() lisait user.value DÉJÀ null et purgeait la
                // clé ':anon' au lieu de celle de l'utilisateur sortant.
                try {
                    const _uid = (oldVal && (oldVal.id ?? oldVal.user_id ?? oldVal.username)) || 'anon';
                    sessionStorage.removeItem(SESSION_KEY_BASE + ':' + String(_uid));
                } catch (_) {}
                try { sessionStorage.removeItem(SESSION_KEY_BASE); } catch (_) {}
            }
        });

        // -- 15. TEMPLATE RETURN ----------------------------------
        //
        // SPREAD ORDER IS INTENTIONAL:
        //   1. Modules with lowest priority first (admin, settings)
        //   2. Modules with higher priority next  (editor, chat, auth)
        //   3. Explicit root refs / functions LAST to always win
        //      over any same-named value inside a module.
        //
        // Critical overrides that must be last:
        //   • liveLogs      → admin creates its own internal ref; we
        //                      override so the template always sees the
        //                      root ref that the SSE handler writes to
        //   • showExportMenu → same pattern
        //   • user, settings, config, messages, etc. → always root refs

        // Historique des chats, regroupé par date pour la sidebar.
        const groupedHistory = computed(() => {
            const chatsList = (chatMod && chatMod.chats && chatMod.chats.value) || [];
            const items = [];
            // ``_renamed`` recopié (passe 2 2026-08-31) : le flash de
            // renommage est posé sur l'entrée de ``chats.value``, mais la
            // sidebar rend CETTE projection — sans la recopie, le flag
            // n'était ni affiché ni même SUIVI par le computed (Vue ne
            // traque que les champs lus), et le renommage d'un chat en
            // arrière-plan était totalement invisible.
            for (const c of chatsList) items.push({ id: c.id, title: c.title, updated_at: c.updated_at, kind: 'chat', _renamed: c._renamed || false });
            if (!items.length) return [];
            const norm = ts => (!ts ? 0 : (ts > 1e12 ? ts : ts * 1000));
            items.sort((a, b) => norm(b.updated_at) - norm(a.updated_at));
            const now = new Date();
            const sToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
            const sYest = sToday - 86400000, sWeek = sToday - 7 * 86400000;
            const buckets = [
                { key: 'today', label: "Aujourd'hui", items: [] },
                { key: 'yesterday', label: 'Hier', items: [] },
                { key: 'week', label: '7 derniers jours', items: [] },
                { key: 'older', label: 'Plus ancien', items: [] },
            ];
            for (const it of items) {
                const ts = norm(it.updated_at);
                if (ts >= sToday) buckets[0].items.push(it);
                else if (ts >= sYest) buckets[1].items.push(it);
                else if (ts >= sWeek) buckets[2].items.push(it);
                else buckets[3].items.push(it);
            }
            return buckets.filter(b => b.items.length);
        });

        return {
            // -- module exports (lower priority first) ----------
            ...adminMod,
            ...adminSkinsMod,
            ...adminRunsMod,
            ...settingsMod,
            ...skillsMenuMod,
            ...routinesMenuMod,
            ...studioMenuMod,
            ...codeMenuMod,
            ...mascotteMod,
            ...studioChatMod,
            ...studioAutomationMod,
            ...editorMod,
            ...chatMod,
            groupedHistory,
            ...authMod,

            // -- root state (always wins) ------------------------
            user,
            settings,
            config,
            messages,
            currentChatId,
            inputMessage,
            inputRef,
            isStreaming,
            isAdminView,
            isUserScrolling,
            chatAwayFromBottom,
            currentView,
            showSidebar,
            systemAlert,
            showInfoModal,
            // -- OpenCode CLI --
            showOpenCodeModal,
            openCodePlatform,
            openCodeCopied,
            openCodeCommand,
            openCodeSyncCommand,
            openCodeFamilies,
            copyOpenCodeCommand,
            downloadOpenCodeBundle,
            appInfo,
            imgZoom,

            // -- single shared refs that defeat module duplicates -
            liveLogs,
            showExportMenu,

            // -- notifications (cloche sidebar) ------------------
            notifications,
            notifUnread,
            showNotifPanel,
            notifDropdownRef,
            toggleNotifPanel,
            openNotifPanel,
            loadNotifications,
            markNotifRead,
            markAllNotifsRead,
            deleteNotif,
            clearNotifs,
            openNotifItem,
            notifTimeAgo,
            notifyOSEnabled,
            notifyOSSupported,
            notifyOSSecure,
            toggleNotifyOS,
            notifLoading,
            notifError,
            notifHasMore,
            notifNowTick,
            loadMoreNotifs,
            toggleNotifReadState,
            notifIcon,
            notifColor,
            isNotifNew,
            groupedNotifications,
            closeNotifPanel,

            // -- split-mode navigation (admin process URL etc.) ---
            //    These refs are reactive so a config update from
            //    /api/public-config picks up live in any binding that
            //    references mainAppUrl / adminAppUrl. The two methods
            //    are bound to the sidebar's "Admin" button and the
            //    admin page's "Retour à l'app" button respectively.
            adminAppUrl,
            mainAppUrl,
            features,
            goToAdmin,
            goToMainApp,

            // -- toast -------------------------------------------
            toasts,
            showToast,
            removeToast,

            // -- announcer a11y ------------------
            announcerText,
            announcerAssertive,
            announce,

            // -- modal -------------------------------------------
            modalState,
            modalInputRef,
            modalCancelRef,
            modalDialogRef,
            onModalTabKey,
            handleModalSubmit,
            handleModalChoice,
            modalTypedBlocked,
            handleModalCancel,

            // -- context menu ------------------------------------
            contextMenu,
            openContextMenu,
            onContextMenuKeydown,
            handleContextAction,
            handleExplorerDrop,
            onExplorerDragOver,
            onExplorerDragLeave,
            explorerDragOver,
            uploadFilesToSandbox,
            uploadProgress,
            cancelSandboxUpload,

            // -- admin helpers (stateless, no conflict risk) ------
            kpiIconClass,
            appIconPresets: APP_ICON_PRESETS,

            elpisSanitize: (typeof window !== 'undefined' && typeof window.elpisSanitize === 'function')
                ? window.elpisSanitize
                : function(s) { return s == null ? '' : String(s); },
            elpisEscape: (typeof window !== 'undefined' && typeof window.elpisEscape === 'function')
                ? window.elpisEscape
                : function(s) { return s == null ? '' : String(s); },
        };
    },
})
.component('tree-item', TreeItem)
.component('skill-tree-node', SkillTreeNode);

// Carte diff de la page « Remote code » : quatre surfaces l'utilisent, une
// seule définition (chat/_code_render.js). Enregistrement CONDITIONNEL —
// admin.html charge app.js sans les modules du chat : une référence nue à
// CodeDiffCard y lèverait une ReferenceError avant le mount, donc une
// administration blanche.
if (typeof CodeDiffCard !== 'undefined') elpisApp.component('code-diff', CodeDiffCard);
// Grille xlsx de l'éditeur (aperçus Office) — même raison : absente d'admin.html.
if (typeof OfficeGrid !== 'undefined') elpisApp.component('office-grid', OfficeGrid);

elpisApp.mount('#app');
