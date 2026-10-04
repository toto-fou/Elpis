// SPDX-License-Identifier: MIT
function setupAuth(vue, sharedRefs, ctx) {
    const { user, settings, isAdminView, messages, currentChatId, isStreaming } = sharedRefs;
    const { showToast, fetchAuth } = ctx;

    const { ref } = vue;
    const loginForm = ref({ username: '', password: '' });
    const loginError = ref('');
    const isLoading = ref(false);
    const mustChangePassword = ref(false);
    const newPasswordForce = ref('');
    const showNewUserModal = ref(false);
    const newUserForm = ref({ username: '', password: '', role: 'user' });
    const welcomeConfig = ref({ type: 'image', icon: 'ph-sparkle text-blue-500', width: 112, height: 112, image_b64: 'static/elpis-256.png' });
    const loginConfig = ref({ title:'Connexion', subtitle:'', icon_type:'phosphor', icon:'ph-robot', icon_color:'#ffffff', icon_bg:'#2563eb', logo_b64:'', bg_color:'', card_color:'#ffffff', text_color:'', btn_color:'#0f172a' });

    async function loadPublicConfig() {
        try {
            const res = await fetch('/api/public-config');
            if (res.ok) {
                const data = await res.json();
                if (data.welcome) {
                    // Couleurs retirées (suivent le skin). On strippe une
                    // éventuelle classe couleur héritée d'anciens configs
                    // ("ph-sparkle text-blue-500" → "ph-sparkle").
                    welcomeConfig.value = {
                        type: data.welcome.type || 'icon',
                        icon: (data.welcome.icon || 'ph-sparkle').split(' ')[0],
                        width: data.welcome.width || 96,
                        height: data.welcome.height || 96,
                        // Image sans source (config partielle) : logo Elpis.
                        image_b64: data.welcome.image_b64 || 'static/elpis-256.png',
                        // Style du mot animé (typo + les deux échelles), réglé
                        // côté admin. Repris TEL QUEL : `accueil.js` borne et
                        // complète lui-même ce qui manque, et une seconde table
                        // de défauts ici finirait par diverger de la sienne.
                        scene: data.welcome.scene || null
                    };
                }
                if (data.login_page) {
                    loginConfig.value = { ...loginConfig.value, ...data.login_page };
                }
                if (data.app_info && ctx.appInfo) {
                    ctx.appInfo.value = {
                        name:        data.app_info.name        || 'Elpis',
                        version:     data.app_info.version     || '0.0.1',
                        teamName:    data.app_info.team_name   || '',
                        engine:      data.app_info.engine      || 'llama.cpp',
                        description: data.app_info.description || '',
                        iconType:    data.app_info.icon_type   || 'phosphor',
                        icon:        data.app_info.icon        || 'ph-robot',
                        iconColor:   data.app_info.icon_color  || '#ffffff',
                        iconBg:      data.app_info.icon_bg     || '#0f172a',
                        logoBb64:    data.app_info.logo_b64    || ''
                    };
                }
                // ── Split-app navigation URLs ──────────────────────────────
                // ``admin_url`` (set on the MAIN process via ADMIN_PUBLIC_URL)
                //   tells the chat-page sidebar where to navigate when the
                //   user clicks the "Admin" button. Falsy → in-page admin
                //   view (single-process / legacy mode).
                // ``main_url`` (set on the ADMIN process via MAIN_PUBLIC_URL)
                //   tells the admin page where the "Retour à l'app" link
                //   should point.
                //
                // Two writes per URL, intentionally:
                //   1. ``window.__X__``  — the bootstrap script in admin.html
                //      reads these synchronously to seed defaults BEFORE Vue
                //      mounts. We keep them in sync for any non-Vue code
                //      (e.g. setTimeout(() => window.location = …) in the
                //      logout handler).
                //   2. ``ctx.adminAppUrl.value / ctx.mainAppUrl.value`` —
                //      THIS is what the templates bind to. Without these
                //      writes, the refs only carry the bootstrap fallback
                //      and never get overridden by the canonical URL the
                //      backend reports.
                if (typeof data.admin_url === 'string' && data.admin_url) {
                    window.__ADMIN_APP_URL__ = data.admin_url;
                    if (ctx.adminAppUrl && ctx.adminAppUrl.value !== undefined) {
                        ctx.adminAppUrl.value = data.admin_url;
                    }
                }
                if (typeof data.main_url === 'string' && data.main_url) {
                    window.__MAIN_APP_URL__ = data.main_url;
                    if (ctx.mainAppUrl && ctx.mainAppUrl.value !== undefined) {
                        ctx.mainAppUrl.value = data.main_url;
                    }
                }
                if (data.app_mode) {
                    window.__APP_MODE__ = data.app_mode;
                }
                // Feature flags globaux (toggle admin). Absent OU non-false ⇒ activé
                // (rétro-compat : un ancien backend sans ce champ garde tout actif).
                if (data.features && ctx.features && ctx.features.value) {
                    ctx.features.value = {
                        opencode:  data.features.opencode  !== false,
                        agents:    data.features.agents    !== false,
                        office_preview: data.features.office_preview !== false,
                        // Moteur vocal : lecture STRICTE (``=== true``). Le défaut
                        // est OFF — une fonction qui ouvre le micro ou sort du son
                        // ne s'allume pas par rétro-compatibilité.
                        voice_stt: data.features.voice_stt === true,
                        voice_tts: data.features.voice_tts === true,
                    };
                }
            }
        } catch(e) {}
    }

    async function loadRagCollections() {
        try {
            const res = await fetchAuth('/api/rag/collections', {}, true);
            if (res && res.ok) {
                const data = await res.json();
                ctx.ragCollections.value = data.collections || [];
            }
        } catch(e) {}
    }

    async function checkAuth() {
        // ── ADMIN-ONLY MODE GUARD ────────────────────────────────────
        // The admin process serves /admin (admin.html) which sets
        // window.__ADMIN_ONLY_MODE__ before any module loads. In that
        // mode the chat / settings / sandbox endpoints DO NOT EXIST on
        // the admin port, so blindly calling ctx.loadChatsList() etc.
        // produces a 401/404 spam in the network tab and a bunch of
        // misleading "Erreur réseau" toasts. We skip them here AND we
        // lock isAdminView=true so the user lands directly on the
        // admin console instead of an empty chat shell.
        const adminOnly = !!window.__ADMIN_ONLY_MODE__;
        try {
            const res = await fetch('/api/me-lite', { credentials: 'same-origin' });
            if (res.ok) {
                const data = await res.json();
                if (data.must_change_password) {
                    // Session existe mais mot de passe doit être changé
                    user.value = null;
                    mustChangePassword.value = true;
                } else if (data.logged_in) {
                    user.value = { id: data.id, username: data.username, is_admin: data.is_admin, role: data.role || (data.is_admin ? 'admin' : 'user'), avatar: data.avatar };
                    mustChangePassword.value = false;
                    if (adminOnly) {
                        // Force la vue admin sans toucher au chat. La présence
                        // de cette page implique que l'utilisateur a explicitement
                        // navigué vers la console admin ; s'il n'a pas les droits,
                        // les boutons admin restent invisibles via v-if.
                        isAdminView.value = true;
                        // Correctif skins 2026-07 : la console admin suit le
                        // skin + mode sombre de l'utilisateur — il faut donc
                        // charger les settings ici aussi (les watchers
                        // d'app-settings.js posent les classes sur <body> ;
                        // avant, admin.html restait sur les défauts).
                        ctx.loadSettingsData();
                    } else {
                        await ctx.loadChatsList();
                        ctx.loadSettingsData();
                        ctx.loadSandboxFiles();
                        loadRagCollections();
                    }
                } else {
                    user.value = null;
                    mustChangePassword.value = false;
                }
            }
        } catch(e) {}
    }

    async function login() {
        // protection contre double-click / Enter répété :
        // sans ce guard, un utilisateur qui clique deux fois rapidement (ou
        // qui appuie sur Enter pendant qu'une auth est en vol) lance deux
        // POST /api/login-lite en parallèle. Le 2e gagne souvent — mais s'il
        // arrive APRÈS un checkAuth déclenché par le 1er, la session
        // peut se retrouver dans un état incohérent (user.value set par
        // le 1er, puis écrasé par le 2e). On bail tôt si un login est
        // déjà en cours.
        if (isLoading.value) return;
        isLoading.value = true;
        loginError.value = '';
        try {
            const res = await fetch('/api/login-lite', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(loginForm.value),
                credentials: 'same-origin'
            });
            if (res.ok) {
                const data = await res.json();
                if (data.must_change_password) {
                    mustChangePassword.value = true;
                } else {
                    await checkAuth();
                    showToast('Bienvenue');
                    if (window.__ADMIN_ONLY_MODE__) {
                        // Sur la console admin dédiée : on est déjà sur la
                        // bonne page, pas besoin de naviguer ailleurs. On
                        // refuse aussi gentiment l'accès aux non-staff —
                        // checkAuth() a forcé isAdminView mais on garde un
                        // garde-fou explicit.
                        if (data.is_admin) ctx.loadUsers();
                        else {
                            showToast('Accès admin requis pour cette console.', 'error');
                            // logout-lite invalide la session côté backend
                            // pour que retourner à l'app principale ne
                            // confonde pas l'état.
                            try { await fetch('/api/logout-lite', { method: 'POST', credentials: 'same-origin' }); } catch(_) {}
                            user.value = null;
                            return;
                        }
                    } else if (data.is_admin) {
                        // ── Don't auto-open the legacy in-page admin view
                        //    when in split-mode topology. Two reasons:
                        //
                        //    1. With ``adminAppUrl`` set, the chat sidebar
                        //       shows a dedicated "Admin" button that
                        //       navigates to the admin process URL. Flipping
                        //       ``isAdminView=true`` on top of that just
                        //       paints the embedded admin shell over the
                        //       chat page — symptom: "à la connexion la
                        //       page admin pop".
                        //
                        //    2. ``adminAppUrl`` may legitimately be empty
                        //       even in split mode if the operator forgot
                        //       to set ADMIN_PUBLIC_URL — but the backend
                        //       now synthesises one in that case (see
                        //       _resolve_public_url in _legacy.py), and we
                        //       can also detect split mode directly via
                        //       ``__APP_MODE__`` ("main" / "admin" / "full").
                        //       Trusting the mode flag is more robust than
                        //       inferring from a URL that may be loaded
                        //       slightly later.
                        //
                        //    The user can still reach admin explicitly via
                        //    the sidebar button when they want it.
                        const appMode  = (typeof window !== 'undefined' && window.__APP_MODE__) || '';
                        const splitMode = appMode === 'main' || appMode === 'admin'
                                       || !!(ctx.adminAppUrl && ctx.adminAppUrl.value);
                        if (!splitMode) {
                            isAdminView.value = true;
                            ctx.loadUsers();
                        }
                    }
                }
            } else if (res.status === 401 || res.status === 403) {
                loginError.value = "Nom d’utilisateur ou mot de passe incorrect.";
                showToast("Échec de la connexion", "error");
            } else if (res.status === 429) {
                loginError.value = "Trop de tentatives. Patientez une minute avant de réessayer.";
                showToast("Trop de tentatives", "error");
            } else {
                // AVANT : tout statut non-ok devenait « Identifiants
                // invalides » — un 500, un 502 de proxy ou un 503 au
                // démarrage du backend envoyaient l'utilisateur retaper un
                // mot de passe pourtant correct, jusqu'à « mot de passe
                // oublié ». La panne n'est pas de son côté : on le dit.
                loginError.value = "Service momentanément indisponible (erreur "
                                 + res.status + "). Vos identifiants n’ont pas été "
                                 + "vérifiés — réessayez dans un instant.";
                showToast("Service indisponible", "error");
            }
        } catch(e) {
            // Un `fetch` qui LÈVE = le navigateur n'a pas joint le serveur.
            // Annoncer « Erreur serveur » ici était le diagnostic exactement
            // inversé (le serveur n'a rien vu passer).
            loginError.value = "Serveur injoignable — vérifiez votre connexion réseau.";
        } finally {
            isLoading.value = false;
        }
    }

    async function submitForcePasswordChange() {
        if (!newPasswordForce.value) return;
        isLoading.value = true;
        try {
            const res = await fetchAuth('/api/users/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ new_password: newPasswordForce.value })
            });
            if (res && res.ok) {
                mustChangePassword.value = false;
                await checkAuth();
                showToast('Mot de passe mis à jour ! Bienvenue.');
                if (window.__ADMIN_ONLY_MODE__) {
                    // checkAuth() a déjà forcé isAdminView=true. Charge la liste
                    // d'utilisateurs si admin (sinon, l'UI affichera juste le
                    // dashboard limité).
                    if (user.value && user.value.is_admin) ctx.loadUsers();
                } else if (user.value && user.value.is_admin) {
                    // Same split-mode guard as in login() — see comment
                    // there. Trust ``__APP_MODE__`` first, then the
                    // ``adminAppUrl`` ref as a secondary signal.
                    const appMode = (typeof window !== 'undefined' && window.__APP_MODE__) || '';
                    const splitMode = appMode === 'main' || appMode === 'admin'
                                   || !!(ctx.adminAppUrl && ctx.adminAppUrl.value);
                    if (!splitMode) {
                        isAdminView.value = true; ctx.loadUsers();
                    }
                }
            } else {
                const err = res ? await res.json().catch(() => ({})) : {};
                showToast(err.detail || 'Erreur lors du changement', 'error');
            }
        } catch(e) {
            showToast('Erreur serveur', 'error');
        } finally {
            isLoading.value = false;
        }
    }

    async function createUserAdmin() {
        if (!newUserForm.value.username || !newUserForm.value.password) return;
        try {
            const res = await fetchAuth('/api/admin/users/new', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newUserForm.value)
            });
            if (res && res.ok) {
                showToast("Utilisateur créé !");
                showNewUserModal.value = false;
                newUserForm.value = { username: '', password: '', role: 'user' };
                ctx.loadUsers();
            } else {
                const err = res ? await res.json().catch(() => ({})) : {};
                showToast(err.detail || "Erreur", "error");
            }
        } catch(e) {
            showToast("Erreur serveur", "error");
        }
    }

    async function changeUserRole(userId, role) {
        try {
            const res = await fetchAuth('/api/admin/users/' + userId + '/role', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role })
            });
            if (res && res.ok) {
                showToast('Rôle mis à jour');
                ctx.loadUsers();
            } else {
                const err = res ? await res.json().catch(() => ({})) : {};
                showToast(err.detail || 'Erreur', 'error');
                ctx.loadUsers();
            }
        } catch(e) { showToast('Erreur réseau', 'error'); }
    }

    async function logout() {
        // Onglets modifiés : mis de côté pour ce compte avant la purge (E2).
        try { ctx.rescueEditorBuffers && ctx.rescueEditorBuffers(); } catch (_) {}
        await fetch('/api/logout-lite', { method: 'POST', credentials: 'same-origin' });
        user.value = null;
        isAdminView.value = false;
        messages.value = [];
        if (ctx.chats) ctx.chats.value = [];
        currentChatId.value = null;
        if (ctx.showEditor) ctx.showEditor.value = false;
        if (ctx.openTabs) ctx.openTabs.value = [];
        if (ctx.models) { Object.values(ctx.models).forEach(m => { try { m.dispose(); } catch(_) {} }); Object.keys(ctx.models).forEach(k => delete ctx.models[k]); }
        if (ctx.monacoRef) {
            if (ctx.monacoRef.instance) { try { ctx.monacoRef.instance.dispose(); } catch(_) {} ctx.monacoRef.instance = null; }
            if (ctx.monacoRef.diff) { try { ctx.monacoRef.diff.dispose(); } catch(_) {} ctx.monacoRef.diff = null; }
            ctx.monacoRef.initPromise = null;
            ctx.monacoRef.originalModel = null;
        }
        // Nettoyage de session des modules chat + éditeur, via les proxies
        // ctx (les anciennes lignes ``if (ctx.gitCredUser) …``,
        // ``if (ctx.attachedFiles) …``, ``if (ctx.stopGeneration) …``
        // testaient des clés JAMAIS exposées par ctx → ~17 lignes de
        // cleanup mortes : token git prérempli pour le compte suivant,
        // pièces jointes conservées, génération non stoppée, SSE laissé
        // ouvert). resetChatOnLogout stoppe la génération + le stream bg,
        // vide brouillon/PJ/skills épinglés et ferme le SSE (qui stoppe
        // aussi le polling modèles) ; resetEditorOnLogout purge l'état git
        // — credentials inclus.
        // ``true`` = départ volontaire : ici, et ici SEULEMENT, on arrête la
        // génération en cours (cf. resetOnLogout, audit 2026-08-22, B4).
        if (ctx.resetChatOnLogout)   { try { ctx.resetChatOnLogout(true); }   catch(e) {} }
        if (ctx.resetEditorOnLogout) { try { ctx.resetEditorOnLogout(); } catch(e) {} }
        // Ceinture : même si le module chat manque (admin split-mode),
        // aucun composer ne doit rester en état « génération en cours ».
        isStreaming.value = false;
        // Clear auth fields (poste partagé : ne pas laisser l'identifiant
        // précédent ni le mot de passe forcé en mémoire réactive)
        loginForm.value = { username: '', password: '' };
        loginError.value = '';
        mustChangePassword.value = false;
        newPasswordForce.value = '';
        showToast("Déconnecté");
        // Sur la console admin séparée, après logout l'utilisateur retourne
        // à l'app principale (laquelle re-demandera un login). Sans cette
        // redirection il reste sur :8002 et voit un écran de login admin
        // qui n'est PAS adapté aux utilisateurs non-staff.
        if (window.__ADMIN_ONLY_MODE__ && window.__MAIN_APP_URL__) {
            // 600ms : laisse le toast "Déconnecté" être lu.
            setTimeout(function() { window.location.href = window.__MAIN_APP_URL__; }, 600);
        }
    }

    return {
        loginForm, loginError, isLoading, mustChangePassword, newPasswordForce,
        showNewUserModal, newUserForm, welcomeConfig,
        loadPublicConfig, loadRagCollections, checkAuth, login, loginConfig,
        submitForcePasswordChange, createUserAdmin, changeUserRole, logout
    };
}
