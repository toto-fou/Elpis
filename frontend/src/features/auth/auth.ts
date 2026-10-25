// SPDX-License-Identifier: MIT
/** frontend/src/features/auth/auth.ts — module de connexion des scripts historiques (`setupAuth`) : me-lite, connexion, déconnexion, comptes. */
import { schemaOk, schemaReponseConnexion, schemaReponseMoi } from "@elpis/contracts";
import { ref } from "vue";
import type { Ref } from "vue";
import { z } from "zod";

import type { ClientHttp } from "../../platform/http/client";
import { adresseLogo } from "../communs/logo";
import type { HttpLegacy, Toast } from "../../platform/http/legacy";
import type { Compte, GestionnaireSession } from "./session";

export type UtilisateurAffiche = Compte;

export interface RefsAuth {
  readonly user: Ref<UtilisateurAffiche | null>;
  readonly isAdminView: Ref<boolean>;
  readonly messages: Ref<unknown[]>;
  readonly currentChatId: Ref<unknown>;
  readonly isStreaming: Ref<boolean>;
}

interface Jetable {
  dispose(): void;
}

/** Sous-ensemble du `ctx` d'app.js lu par ce module ; tout est facultatif (console séparée). */
export interface CtxAuth {
  readonly showToast: Toast;
  readonly fetchAuth: HttpLegacy["fetchAuth"];
  readonly appInfo?: Ref<unknown>;
  readonly adminAppUrl?: Ref<unknown>;
  readonly mainAppUrl?: Ref<unknown>;
  readonly features?: Ref<unknown>;
  readonly chats?: Ref<unknown[]>;
  readonly showEditor?: Ref<boolean>;
  readonly openTabs?: Ref<unknown[]>;
  readonly models?: Record<string, Jetable>;
  readonly monacoRef?: {
    instance: Jetable | null;
    diff: Jetable | null;
    initPromise: unknown;
    originalModel: unknown;
  };
  loadSettingsData?(): unknown;
  loadChatsList?(): unknown;
  loadSandboxFiles?(): unknown;
  loadUsers?(): unknown;
  rescueEditorBuffers?(): unknown;
  resetChatOnLogout?(explicit?: boolean): unknown;
  resetEditorOnLogout?(): unknown;
}

export interface DependancesAuth {
  readonly session: GestionnaireSession;
  readonly http: ClientHttp;
  readonly fenetre?: FenetreElpis;
}

/** Globals posés par `index.html`/`admin.html` et relus ici. */
export interface FenetreElpis {
  __ADMIN_ONLY_MODE__?: unknown;
  __APP_MODE__?: unknown;
  __ADMIN_APP_URL__?: unknown;
  __MAIN_APP_URL__?: unknown;
  location: { href: string };
}

const objet = z.record(z.string(), z.unknown());
const schemaConfigPublique = z.looseObject({
  welcome: objet.nullish(),
  login_page: objet.nullish(),
  app_info: objet.nullish(),
  app_logo_url: z.unknown().optional(),
  admin_url: z.unknown().optional(),
  main_url: z.unknown().optional(),
  app_mode: z.unknown().optional(),
  features: objet.nullish(),
});
function ou(v: unknown, defaut: unknown): unknown {
  return v ? v : defaut;
}

function lancer(fn: (() => unknown) | undefined): void {
  if (!fn) return;
  const r = fn();
  if (r instanceof Promise) r.catch(() => {});
}

export function setupAuth(refs: RefsAuth, ctx: CtxAuth, dep: DependancesAuth) {
  const { user, isAdminView, messages, currentChatId, isStreaming } = refs;
  const { showToast, fetchAuth } = ctx;
  const { session, http } = dep;
  const fen = (): FenetreElpis => dep.fenetre ?? (window as unknown as FenetreElpis);

  const loginForm = ref({ username: "", password: "" });
  const loginError = ref("");
  const isLoading = ref(false);
  const mustChangePassword = ref(false);
  const newPasswordForce = ref("");
  const showNewUserModal = ref(false);
  const newUserForm = ref({ username: "", password: "", role: "user" });
  const welcomeConfig = ref<Record<string, unknown>>({
    type: "image",
    icon: "ph-sparkle text-blue-500",
    width: 112,
    height: 112,
    image_b64: "static/elpis-256.png",
  });
  const loginConfig = ref<Record<string, unknown>>({
    title: "Connexion",
    subtitle: "",
    icon_type: "phosphor",
    icon: "ph-robot",
    icon_color: "#ffffff",
    icon_bg: "#2563eb",
    logo_b64: "",
    bg_color: "",
    card_color: "#ffffff",
    text_color: "",
    btn_color: "#0f172a",
  });

  const modeSepare = (): boolean => {
    const mode = fen().__APP_MODE__ || "";
    return mode === "main" || mode === "admin" || !!ctx.adminAppUrl?.value;
  };

  async function loadPublicConfig(): Promise<void> {
    const r = await http.requete("/api/public-config", {}, { schema: schemaConfigPublique, sans401: true });
    if (r.type !== "ok") return;
    const data = r.valeur;
    if (data.welcome) {
      const w = data.welcome;
      welcomeConfig.value = {
        type: ou(w.type, "icon"),
        icon: String(ou(w.icon, "ph-sparkle")).split(" ")[0],
        width: ou(w.width, 96),
        height: ou(w.height, 96),
        image_b64: ou(w.image_b64, "static/elpis-256.png"),
        scene: ou(w.scene, null),
      };
    }
    if (data.login_page) loginConfig.value = { ...loginConfig.value, ...data.login_page };
    if (data.app_info && ctx.appInfo) {
      const a = data.app_info;
      ctx.appInfo.value = {
        name: ou(a.name, "Elpis"),
        version: ou(a.version, "0.1.1"),
        teamName: ou(a.team_name, ""),
        engine: ou(a.engine, "llama.cpp"),
        description: ou(a.description, ""),
        iconType: ou(a.icon_type, "phosphor"),
        icon: ou(a.icon, "ph-robot"),
        iconColor: ou(a.icon_color, "#ffffff"),
        iconBg: ou(a.icon_bg, "#0f172a"),
        logoBb64: ou(a.logo_b64, ""),
        logoUrl: adresseLogo(data.app_logo_url),
      };
    }
    if (typeof data.admin_url === "string" && data.admin_url) {
      fen().__ADMIN_APP_URL__ = data.admin_url;
      if (ctx.adminAppUrl && ctx.adminAppUrl.value !== undefined) ctx.adminAppUrl.value = data.admin_url;
    }
    if (typeof data.main_url === "string" && data.main_url) {
      fen().__MAIN_APP_URL__ = data.main_url;
      if (ctx.mainAppUrl && ctx.mainAppUrl.value !== undefined) ctx.mainAppUrl.value = data.main_url;
    }
    if (data.app_mode) fen().__APP_MODE__ = data.app_mode;
    if (data.features && ctx.features?.value) {
      const f = data.features;
      ctx.features.value = {
        opencode: f.opencode !== false,
        agents: f.agents !== false,
        office_preview: f.office_preview !== false,
        voice_stt: f.voice_stt === true,
        voice_tts: f.voice_tts === true,
      };
    }
  }

  /** Relit `/api/me-lite` ; une réponse partie avant un changement de session est ignorée (génération). */
  async function checkAuth(): Promise<void> {
    const adminOnly = !!fen().__ADMIN_ONLY_MODE__;
    const r = await http.requete("/api/me-lite", {}, { schema: schemaReponseMoi, sans401: true });
    if (r.type !== "ok") return;
    const data = r.valeur;
    if (data.logged_in) {
      const compte: Compte = {
        id: data.id,
        username: data.username,
        is_admin: data.is_admin,
        role: data.role,
        avatar: data.avatar,
      };
      session.ouvrir(compte);
      user.value = compte;
      mustChangePassword.value = false;
      if (adminOnly) {
        isAdminView.value = true;
        lancer(ctx.loadSettingsData);
      } else {
        await ctx.loadChatsList?.();
        lancer(ctx.loadSettingsData);
        lancer(ctx.loadSandboxFiles);
      }
    } else if ("must_change_password" in data) {
      session.motDePasseAChanger();
      user.value = null;
      mustChangePassword.value = true;
    } else {
      if (!session.fermer("expiration")) session.constaterDeconnecte();
      user.value = null;
      mustChangePassword.value = false;
    }
  }

  async function login(): Promise<void> {
    if (isLoading.value) return;
    isLoading.value = true;
    loginError.value = "";
    try {
      const r = await http.requete(
        "/api/login-lite",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(loginForm.value),
        },
        { schema: schemaReponseConnexion, sans401: true },
      );
      if (r.type === "ok") {
        const data = r.valeur;
        loginForm.value = { username: loginForm.value.username, password: "" };
        if (data.must_change_password) {
          session.motDePasseAChanger();
          mustChangePassword.value = true;
          return;
        }
        await checkAuth();
        showToast("Bienvenue");
        if (fen().__ADMIN_ONLY_MODE__) {
          if (data.is_admin) lancer(ctx.loadUsers);
          else {
            showToast("Accès admin requis pour cette console.", "error");
            await http.requete("/api/logout-lite", { method: "POST" }, { sans401: true });
            session.fermer("deconnexion");
            user.value = null;
          }
        } else if (data.is_admin && !modeSepare()) {
          isAdminView.value = true;
          lancer(ctx.loadUsers);
        }
      } else if (r.type === "reseau") {
        loginError.value = "Serveur injoignable — vérifiez votre connexion réseau.";
      } else if ((r.type === "requete" && r.statut === 401) || r.type === "refus") {
        loginError.value = "Identifiant ou mot de passe incorrect.";
      } else if (r.type === "requete" && r.statut === 429) {
        loginError.value = "Trop de tentatives. Patientez une minute avant de réessayer.";
      } else if (r.type !== "annulation" && r.type !== "perime" && r.type !== "expiration") {
        const statut = "statut" in r ? r.statut : 0;
        loginError.value =
          "Service momentanément indisponible (erreur " +
          statut +
          "). Vos identifiants n’ont pas été vérifiés — réessayez dans un instant.";
      }
    } finally {
      isLoading.value = false;
    }
  }

  async function lireDetail(res: Response | null): Promise<unknown> {
    if (!res) return undefined;
    try {
      const corps: unknown = await res.json();
      return corps !== null && typeof corps === "object" ? (corps as { detail?: unknown }).detail : undefined;
    } catch {
      return undefined;
    }
  }

  async function submitForcePasswordChange(): Promise<void> {
    if (!newPasswordForce.value) return;
    isLoading.value = true;
    try {
      const res = await fetchAuth("/api/users/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_password: newPasswordForce.value }),
      });
      if (res && res.ok) {
        mustChangePassword.value = false;
        newPasswordForce.value = "";
        await checkAuth();
        showToast("Mot de passe mis à jour ! Bienvenue.");
        if (fen().__ADMIN_ONLY_MODE__) {
          if (user.value && user.value.is_admin) lancer(ctx.loadUsers);
        } else if (user.value && user.value.is_admin && !modeSepare()) {
          isAdminView.value = true;
          lancer(ctx.loadUsers);
        }
      } else {
        showToast(String(ou(await lireDetail(res), "Erreur lors du changement")), "error");
      }
    } catch {
      showToast("Erreur serveur", "error");
    } finally {
      isLoading.value = false;
    }
  }

  async function createUserAdmin(): Promise<void> {
    if (!newUserForm.value.username || !newUserForm.value.password) return;
    try {
      const res = await fetchAuth("/api/admin/users/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newUserForm.value),
      });
      if (res && res.ok) {
        showToast("Utilisateur créé !");
        showNewUserModal.value = false;
        newUserForm.value = { username: "", password: "", role: "user" };
        lancer(ctx.loadUsers);
      } else {
        showToast(String(ou(await lireDetail(res), "Erreur")), "error");
      }
    } catch {
      showToast("Erreur serveur", "error");
    }
  }

  async function changeUserRole(userId: number | string, role: string): Promise<void> {
    try {
      const res = await fetchAuth("/api/admin/users/" + String(userId) + "/role", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (res && res.ok) {
        showToast("Rôle mis à jour");
      } else {
        showToast(String(ou(await lireDetail(res), "Erreur")), "error");
      }
      lancer(ctx.loadUsers);
    } catch {
      showToast("Erreur réseau", "error");
    }
  }

  function essayer(fn: () => unknown): void {
    try {
      fn();
    } catch {
      /* module absent ou déjà purgé */
    }
  }

  /** Départ volontaire : seul cas où la génération en cours est arrêtée côté serveur. */
  async function logout(): Promise<void> {
    essayer(() => ctx.rescueEditorBuffers?.());
    const r = await http.requete(
      "/api/logout-lite",
      { method: "POST" },
      { schema: schemaOk.optional(), sans401: true },
    );
    if (r.type === "reseau") {
      showToast("Déconnexion impossible : serveur injoignable", "error");
      return;
    }
    session.fermer("deconnexion");
    user.value = null;
    isAdminView.value = false;
    messages.value = [];
    if (ctx.chats) ctx.chats.value = [];
    currentChatId.value = null;
    if (ctx.showEditor) ctx.showEditor.value = false;
    if (ctx.openTabs) ctx.openTabs.value = [];
    const models = ctx.models;
    if (models) {
      for (const m of Object.values(models)) essayer(() => m.dispose());
      for (const k of Object.keys(models)) delete models[k];
    }
    const monaco = ctx.monacoRef;
    if (monaco) {
      if (monaco.instance) {
        const i = monaco.instance;
        essayer(() => i.dispose());
        monaco.instance = null;
      }
      if (monaco.diff) {
        const d = monaco.diff;
        essayer(() => d.dispose());
        monaco.diff = null;
      }
      monaco.initPromise = null;
      monaco.originalModel = null;
    }
    essayer(() => ctx.resetChatOnLogout?.(true));
    essayer(() => ctx.resetEditorOnLogout?.());
    isStreaming.value = false;
    loginForm.value = { username: "", password: "" };
    loginError.value = "";
    mustChangePassword.value = false;
    newPasswordForce.value = "";
    showToast("Déconnecté");
    const f = fen();
    if (f.__ADMIN_ONLY_MODE__ && typeof f.__MAIN_APP_URL__ === "string" && f.__MAIN_APP_URL__) {
      const cible = f.__MAIN_APP_URL__;
      setTimeout(() => {
        f.location.href = cible;
      }, 600);
    }
  }

  return {
    loginForm,
    loginError,
    isLoading,
    mustChangePassword,
    newPasswordForce,
    showNewUserModal,
    newUserForm,
    welcomeConfig,
    loadPublicConfig,
    checkAuth,
    login,
    loginConfig,
    submitForcePasswordChange,
    createUserAdmin,
    changeUserRole,
    logout,
  };
}
