// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/sandbox.ts — Paramètres › Sandbox : état du container Docker du compte, transitions à barre de progression, profil réseau et sondage tant que le container se prépare. */
import { schemaReponseBacMoi, schemaReponseChoixBac } from "@elpis/contracts";
import type { Ref } from "vue";
import type { z } from "zod";

import { journal } from "../../platform/journal";
import { corpsJson } from "../../utils/lecture-json";
import type { CtxReglages, VueReglages } from "./types";

const ENTETES_JSON = { "Content-Type": "application/json" };

export interface ConteneurSandbox {
  pending?: string;
  running?: boolean;
  exists?: boolean;
  container_name?: string;
  logs?: string;
  error?: string;
  [cle: string]: unknown;
}
export interface ImageSandbox {
  status?: string;
  progress_msg?: string;
  elapsed_s?: number;
  error?: string;
  [cle: string]: unknown;
}
export interface ProfilReseau {
  id: string;
  name: string;
  mode: string;
  description?: string;
  ips?: string[];
  [cle: string]: unknown;
}
export interface EtatSandbox {
  user_mode: string;
  effective_mode: string;
  force_admin: boolean;
  daemon_ok: boolean;
  daemon_info: string;
  image: string;
  limits: {
    cpu_quota_pct?: number;
    memory_mb?: number;
    pids_max?: number;
    timeout_s?: number;
    [cle: string]: unknown;
  };
  idle_kill_hours: number;
  container: ConteneurSandbox | null;
  stats: { cpu?: unknown; mem?: unknown; pids?: unknown; [cle: string]: unknown } | null;
  image_status: ImageSandbox | null;
  network_profile_id?: string;
  network_profiles?: ProfilReseau[];
  network_profile_locked?: boolean;
}

export interface EtapeTransition {
  label: string;
  target: number;
}
export interface EtatTransition {
  active: boolean;
  progress: number;
  label: string;
  step: number;
  total: number;
  error: string | null;
  containerLogs: string | null;
}

export type TonSandbox = "ok" | "idle" | "busy" | "warn" | "danger";
export interface StatutSandbox {
  tone: TonSandbox;
  label: string;
  detail: string;
  mono: string;
  action: "start" | "create" | null;
}

const SANDBOX_TONES: Readonly<Record<TonSandbox, { dot: string; alert: string }>> = {
  ok: { dot: "bg-emerald-500", alert: "" },
  idle: { dot: "bg-slate-300", alert: "" },
  busy: { dot: "bg-blue-500", alert: "" },
  warn: { dot: "bg-amber-500", alert: "bg-amber-50 border-amber-200 text-amber-800" },
  danger: { dot: "bg-red-500", alert: "bg-red-50 border-red-200 text-red-700" },
};

const attendre = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const messageErreur = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const etatInitial = (): EtatSandbox => ({
  user_mode: "folder",
  effective_mode: "folder",
  force_admin: false,
  daemon_ok: true,
  daemon_info: "",
  image: "",
  limits: {},
  idle_kill_hours: 24,
  container: null,
  stats: null,
  image_status: null,
});

export function creerSandbox(vue: VueReglages, ctx: CtxReglages) {
  const { computed, nextTick, ref } = vue;
  const { showToast, openConfirm, fetchAuth } = ctx;
  const sandboxState: Ref<EtatSandbox> = ref(etatInitial());
  const sandboxBusy = ref(false);
  const netMenuOpen = ref(false);
  const transitionState: Ref<EtatTransition> = ref({
    active: false,
    progress: 0,
    label: "",
    step: 0,
    total: 0,
    error: null,
    containerLogs: null,
  });

  const activeNetProfile = computed(
    () =>
      (sandboxState.value.network_profiles ?? []).find(
        (p) => p.id === sandboxState.value.network_profile_id,
      ) ?? null,
  );

  /** Un seul modèle de statut : l'ordre reproduit la chaîne de conditions d'origine (mode, daemon, image, attente, actif, existant). */
  const sandboxStatus = computed<StatutSandbox>(() => {
    const s = sandboxState.value;
    const c = s.container;
    const img = s.image_status;
    if (s.effective_mode !== "docker")
      return {
        tone: "idle",
        label: "Container arrêté",
        detail: "Mode dossier actif.",
        mono: "",
        action: "create",
      };
    if (!s.daemon_ok)
      return {
        tone: "danger",
        label: "Docker injoignable",
        detail: s.daemon_info || "(aucun détail)",
        mono: "",
        action: null,
      };
    if (img && img.status === "loading") {
      const el = img.elapsed_s ? ` (${img.elapsed_s} s)` : "";
      return {
        tone: "busy",
        label: "Préparation de l'image…",
        detail: (img.progress_msg || "Premier chargement, jusqu'à une minute.") + el,
        mono: "",
        action: null,
      };
    }
    if (img && img.status === "not_found")
      return {
        tone: "warn",
        label: "Image indisponible",
        detail: "L'administrateur doit fournir l'archive de l'image.",
        mono: "",
        action: null,
      };
    if (img && img.status === "error")
      return {
        tone: "danger",
        label: "Échec du chargement de l'image",
        detail: img.error || "",
        mono: "",
        action: null,
      };
    if (c && c.pending)
      return {
        tone: "busy",
        label: c.pending === "image_loading" ? "Image en cours…" : "Démarrage…",
        detail: "",
        mono: c.container_name || "",
        action: null,
      };
    if (c && c.running)
      return { tone: "ok", label: "Actif", detail: "", mono: c.container_name || "", action: null };
    if (c && c.exists)
      return { tone: "idle", label: "Arrêté", detail: "", mono: c.container_name || "", action: "start" };
    return {
      tone: "idle",
      label: "Aucun container",
      detail: "Il sera créé au démarrage.",
      mono: "",
      action: "create",
    };
  });
  const sandboxTone = computed(() => SANDBOX_TONES[sandboxStatus.value.tone] || SANDBOX_TONES.idle);

  // ── Profil réseau : menu déroulant maison ────────────────────────────────
  function netProfileMode(prof: ProfilReseau | null | undefined): string {
    if (!prof) return "";
    return prof.mode === "none" ? "isolé" : prof.mode === "bridge" ? "ouvert" : "filtré";
  }
  function netProfileDetail(prof: ProfilReseau | null | undefined): string {
    if (!prof) return "";
    if (prof.description) return prof.description;
    if (prof.mode === "none") return "Aucun accès réseau sortant.";
    if (prof.mode === "bridge") return "Accès réseau complet.";
    return "Accès limité aux adresses listées.";
  }
  const optionsMenuReseau = (): HTMLElement[] =>
    Array.from(
      document.querySelector("[data-net-menu]")?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
    );

  function toggleNetMenu(): void {
    if (sandboxBusy.value || sandboxState.value.network_profile_locked) return;
    netMenuOpen.value = !netMenuOpen.value;
    if (!netMenuOpen.value) return;
    void nextTick(() => {
      const opts = optionsMenuReseau();
      const cur = opts.find((el) => el.getAttribute("aria-selected") === "true");
      (cur ?? opts[0])?.focus();
    });
  }
  function pickNetProfile(id: string): void {
    netMenuOpen.value = false;
    if (id !== sandboxState.value.network_profile_id) void onChangeProfile(id);
  }
  /** Ferme le menu et rend le focus au déclencheur (appelée par la cascade Échap globale d'app.js). */
  function closeNetMenu(): void {
    netMenuOpen.value = false;
    document.querySelector<HTMLElement>("[data-net-menu] > div > button")?.focus();
  }
  function onNetMenuKeydown(e: KeyboardEvent): void {
    if (!netMenuOpen.value) return;
    const opts = optionsMenuReseau();
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeNetMenu();
      return;
    }
    if (!opts.length) return;
    const cur = opts.findIndex((el) => el === document.activeElement);
    const aller = (i: number): void => {
      e.preventDefault();
      opts[(i + opts.length) % opts.length]?.focus();
    };
    if (e.key === "ArrowDown") aller(cur + 1);
    else if (e.key === "ArrowUp") aller(cur - 1);
    else if (e.key === "Home") aller(0);
    else if (e.key === "End") aller(opts.length - 1);
  }

  // ── Transitions ──────────────────────────────────────────────────────────
  /** Lance une action longue avec barre à étapes ; `action` reçoit `avancer(i)` pour sauter à l'étape i. */
  async function runTransition(
    etapes: readonly EtapeTransition[],
    action: (avancer: (idx: number) => void) => Promise<void>,
  ): Promise<void> {
    transitionState.value = {
      active: true,
      progress: 0,
      label: etapes[0]?.label || "",
      step: 1,
      total: etapes.length,
      error: null,
      containerLogs: null,
    };
    sandboxBusy.value = true;
    let progres = 0;
    let cible = etapes[0]?.target || 5;
    const minuterie = setInterval(() => {
      if (progres < cible - 0.5) {
        progres += Math.max(0.3, (cible - progres) * 0.08);
        transitionState.value.progress = Math.min(progres, cible);
      }
    }, 80);
    const avancer = (idx: number): void => {
      const s = etapes[Math.min(idx, etapes.length - 1)];
      if (!s) return;
      cible = s.target;
      transitionState.value.step = Math.min(idx, etapes.length - 1) + 1;
      transitionState.value.label = s.label;
    };
    try {
      await action(avancer);
      cible = 100;
      progres = 100;
      avancer(etapes.length - 1);
      transitionState.value.label = etapes[etapes.length - 1]?.label ?? "";
      transitionState.value.progress = 100;
      await attendre(600);
    } catch (e) {
      transitionState.value.error = messageErreur(e);
      const logs = sandboxState.value.container?.logs;
      if (logs) {
        transitionState.value.containerLogs = logs;
        await attendre(8000);
      } else {
        await attendre(2500);
      }
      throw e;
    } finally {
      clearInterval(minuterie);
      transitionState.value.active = false;
      sandboxBusy.value = false;
    }
  }

  /** Attend qu'une condition soit vraie en relisant l'état du sandbox. */
  async function waitFor(predicat: () => boolean, delaiMs = 30000, intervalleMs = 500): Promise<boolean> {
    const debut = Date.now();
    while (Date.now() - debut < delaiMs) {
      await loadSandboxState();
      if (predicat()) return true;
      await attendre(intervalleMs);
    }
    throw new Error("Timeout en attendant l'état attendu");
  }

  /** Reporte les journaux d'un conteneur en échec et lève son erreur le cas échéant. */
  /** Réponse de `POST /api/sandbox/me` validée par le contrat ; `null` (amorce ignorée) si elle n'y correspond pas. */
  async function lireChoix(r: Response): Promise<z.infer<typeof schemaReponseChoixBac> | null> {
    const lu = schemaReponseChoixBac.safeParse(await corpsJson(r));
    if (lu.success) return lu.data;
    journal.avertir("[sandbox] réponse hors contrat : POST /api/sandbox/me", lu.error.issues);
    return null;
  }

  function appliquerBootstrap(choix: z.infer<typeof schemaReponseChoixBac> | null): void {
    const conteneur = choix?.bootstrap.container;
    if (conteneur?.logs)
      sandboxState.value.container = { ...sandboxState.value.container, logs: conteneur.logs };
    if (conteneur?.error) throw new Error(conteneur.error);
  }

  async function onChangeProfile(idProfil: string): Promise<void> {
    if (sandboxBusy.value) return;
    if (sandboxState.value.network_profile_locked) return;
    if (idProfil === sandboxState.value.network_profile_id) return;
    const nouveau = (sandboxState.value.network_profiles ?? []).find((p) => p.id === idProfil);
    const ok = await openConfirm(
      `Changer pour "${nouveau?.name || idProfil}" ?`,
      "Le container Docker sera détruit puis recréé avec le nouveau profil. Vos fichiers restent intacts.",
      false,
      "Changer le profil",
    );
    if (!ok) return;
    const etapes: EtapeTransition[] = [
      { label: "Sauvegarde du profil…", target: 12 },
      { label: "Destruction de l'ancien container…", target: 35 },
      { label: "Création du nouveau container…", target: 60 },
      { label: "Démarrage…", target: 82 },
      { label: "Configuration réseau…", target: 95 },
      { label: "Container prêt", target: 100 },
    ];
    try {
      await runTransition(etapes, async (avancer) => {
        avancer(0);
        const r = await fetchAuth("/api/sandbox/me", {
          method: "POST",
          headers: ENTETES_JSON,
          body: JSON.stringify({ mode: "docker", network_profile_id: idProfil }),
        });
        if (!r || !r.ok) throw new Error(r ? await r.text() : "no response");
        appliquerBootstrap(await lireChoix(r));
        avancer(1);
        await attendre(200);
        avancer(2);
        await loadSandboxState();
        avancer(3);
        await waitFor(() => !!sandboxState.value.container?.running, 30000, 500);
        avancer(4);
        await attendre(200);
        avancer(5);
      });
      showToast(`Profil réseau changé : ${nouveau?.name}`, "success");
    } catch (e) {
      showToast("Échec : " + messageErreur(e), "error");
      await loadSandboxState();
    }
  }

  // ── Sondage tant que le container se prépare ─────────────────────────────
  let minuterieSondage: ReturnType<typeof setInterval> | null = null;
  let echecsSondage = 0;

  function doitSonder(): boolean {
    const s = sandboxState.value;
    if (s.effective_mode !== "docker") return false;
    if (!s.daemon_ok) return false;
    const imgStatus = s.image_status?.status;
    if (imgStatus === "loading") return true;
    const c = s.container;
    if (c?.pending) return true;
    if (c?.exists && !c.running) return false;
    if (!c || (!c.running && imgStatus === "loaded")) return true;
    return false;
  }

  function stopSandboxPolling(): void {
    if (minuterieSondage) {
      clearInterval(minuterieSondage);
      minuterieSondage = null;
    }
  }
  /** Cadence de 1,5 s, onglet visible seulement, abandon après 20 échecs consécutifs. */
  function demarrerSondage(): void {
    if (minuterieSondage) return;
    echecsSondage = 0;
    minuterieSondage = setInterval(() => {
      void (async () => {
        if (!doitSonder()) {
          stopSandboxPolling();
          return;
        }
        if (document.visibilityState !== "visible") return;
        const avant = sandboxState.value;
        await loadSandboxState({ silent: true });
        if (sandboxState.value === avant) {
          if (++echecsSondage >= 20) stopSandboxPolling();
        } else {
          echecsSondage = 0;
        }
      })();
    }, 1500);
  }

  async function loadSandboxState(opts: { silent?: boolean } = {}): Promise<void> {
    try {
      const r = await fetchAuth("/api/sandbox/me");
      if (!r || !r.ok) return;
      const lu = schemaReponseBacMoi.safeParse(await corpsJson(r));
      if (!lu.success) {
        if (!opts.silent)
          journal.avertir("[sandbox] réponse hors contrat : GET /api/sandbox/me", lu.error.issues);
        return;
      }
      const d = lu.data;
      sandboxState.value = { ...d, idle_kill_hours: d.idle_kill_hours || 24, stats: d.stats ?? null };
      if (doitSonder()) demarrerSondage();
      else stopSandboxPolling();
    } catch (e) {
      if (!opts.silent) journal.erreur("loadSandboxState", e);
    }
  }

  async function changeSandboxMode(_mode?: string): Promise<void> {
    if (sandboxBusy.value) return;
    const mode = "docker";
    const etapes: EtapeTransition[] = [
      { label: "Sauvegarde de la configuration…", target: 12 },
      { label: "Préparation de l'image Docker…", target: 35 },
      { label: "Création du container…", target: 60 },
      { label: "Démarrage…", target: 80 },
      { label: "Configuration réseau…", target: 92 },
      { label: "Container prêt", target: 100 },
    ];
    try {
      await runTransition(etapes, async (avancer) => {
        avancer(0);
        const r = await fetchAuth("/api/sandbox/me", {
          method: "POST",
          headers: ENTETES_JSON,
          body: JSON.stringify({ mode }),
        });
        if (!r || !r.ok) throw new Error(r ? await r.text() : "no response");
        const choix = await lireChoix(r);
        appliquerBootstrap(choix);
        sandboxState.value.user_mode = mode;
        sandboxState.value.effective_mode = "docker";
        if (choix?.bootstrap.image_status?.status === "loading") {
          avancer(1);
          await waitFor(() => sandboxState.value.image_status?.status === "loaded", 60000, 1000);
        }
        avancer(2);
        await loadSandboxState();
        avancer(3);
        await waitFor(() => !!sandboxState.value.container?.running, 30000, 500);
        avancer(4);
        await attendre(200);
        avancer(5);
      });
      showToast("Container Docker prêt.", "success");
    } catch (e) {
      showToast("Échec : " + messageErreur(e), "error");
      await loadSandboxState();
    }
  }

  async function restartSandboxContainer(intent = "restart"): Promise<void> {
    const redemarrage = intent !== "start";
    const ok = await openConfirm(
      redemarrage ? "Redémarrer votre container ?" : "Démarrer votre container ?",
      redemarrage
        ? "Les processus en cours seront arrêtés mais vos fichiers restent intacts."
        : "Votre dossier de travail sera monté sur /work.",
      false,
      redemarrage ? "Redémarrer" : "Démarrer",
    );
    if (!ok) return;
    const etapes: EtapeTransition[] = redemarrage
      ? [
          { label: "Arrêt du container…", target: 35 },
          { label: "Redémarrage…", target: 80 },
          { label: "Container prêt", target: 100 },
        ]
      : [
          { label: "Démarrage du container…", target: 45 },
          { label: "Configuration réseau…", target: 85 },
          { label: "Container prêt", target: 100 },
        ];
    try {
      await runTransition(etapes, async (avancer) => {
        avancer(0);
        const r = await fetchAuth("/api/sandbox/me/restart", { method: "POST" });
        if (!r || !r.ok) throw new Error(r ? await r.text() : "no response");
        avancer(etapes.length - 2);
        await loadSandboxState();
      });
      showToast(redemarrage ? "Container redémarré." : "Container démarré.", "success");
    } catch (e) {
      showToast("Échec : " + messageErreur(e), "error");
    }
  }

  async function destroySandboxContainer(): Promise<void> {
    const ok = await openConfirm(
      "Détruire votre container ?",
      "Le container Docker sera supprimé. Votre dossier de travail reste intact, vous pourrez toujours le réutiliser.",
      true,
      "Détruire",
    );
    if (!ok) return;
    sandboxBusy.value = true;
    try {
      const r = await fetchAuth("/api/sandbox/me", { method: "DELETE" });
      if (!r || !r.ok) throw new Error(r ? await r.text() : "no response");
      showToast("Container détruit. Il sera recréé au prochain usage.", "success");
      await loadSandboxState();
    } catch (e) {
      showToast("Échec : " + messageErreur(e), "error");
    } finally {
      sandboxBusy.value = false;
    }
  }

  return {
    sandboxState,
    sandboxBusy,
    sandboxStatus,
    sandboxTone,
    transitionState,
    activeNetProfile,
    netMenuOpen,
    toggleNetMenu,
    pickNetProfile,
    onNetMenuKeydown,
    closeNetMenu,
    netProfileMode,
    netProfileDetail,
    onChangeProfile,
    loadSandboxState,
    changeSandboxMode,
    restartSandboxContainer,
    destroySandboxContainer,
    stopSandboxPolling,
  };
}
