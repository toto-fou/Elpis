// SPDX-License-Identifier: MIT
/** frontend/src/app/racine/notifications.ts — centre de notifications (cloche) : liste paginée, lu et non lu, événements en direct, notification du système, badge du titre d'onglet, signaux de fin des chats en arrière-plan. */
import { computed, ref, watch } from "vue";
import type { Ref } from "vue";

import type { FetchAuth } from "../../features/editor/etat";
import type { OptionsToast } from "./chrome";

export interface Notification {
  id: number | string;
  kind: string;
  title: string;
  body: string;
  ref_type: string;
  ref_id: number | string | null;
  read_at: number | null;
  created_at: number;
  _onClick?: () => void;
}

export interface GroupeNotifications {
  label: string;
  items: Notification[];
}

/** Routines, pour le lien profond d'une notification de routine. */
export interface RoutinesNotif {
  openRoutinesPage(): Promise<unknown> | unknown;
  readonly routines: Ref<readonly { id?: unknown }[]>;
  viewRoutine(r: never): unknown;
}

export interface DependancesNotifications {
  readonly fetchAuth: FetchAuth;
  readonly user: Ref<{ id?: unknown; user_id?: unknown } | null>;
  showToast(message: string, type?: string, opts?: OptionsToast): unknown;
  announce(message: string): void;
  goToAdmin(onglet: string): void;
  openChatById(id: unknown): void;
  routines(): RoutinesNotif | null;
}

const PAGE = 50;
const objet = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

async function corps(r: Response | null): Promise<Record<string, unknown> | null> {
  if (!r?.ok) return null;
  return objet(await r.json());
}

export function notifTimeAgo(ts: number | null | undefined, _tick?: number): string {
  if (!ts) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return "à l'instant";
  if (s < 3600) return "il y a " + String(Math.floor(s / 60)) + " min";
  if (s < 86400) return "il y a " + String(Math.floor(s / 3600)) + " h";
  return "il y a " + String(Math.floor(s / 86400)) + " j";
}

export function notifIcon(kind: string): string {
  switch (kind) {
    case "routine_error":
    case "scenario_failed":
    case "tool_error":
    case "compression_failed":
    case "model_load_error":
      return "ph-warning-circle";
    case "daily_report":
      return "ph-chart-line";
    case "chat_done":
      return "ph-chat-circle-dots";
    case "sandbox_quota":
      return "ph-hard-drives";
    case "system_restart":
      return "ph-arrows-clockwise";
    default:
      return "ph-check-circle";
  }
}

export function notifColor(kind: string): string {
  if (/error|failed/.test(kind || "")) return "text-red-500";
  if (kind === "daily_report") return "text-indigo-500";
  if (kind === "sandbox_quota") return "text-amber-500";
  if (kind === "system_restart") return "text-slate-400";
  if (kind === "chat_done") return "text-blue-500";
  return "text-emerald-500";
}

function tranche(ts: number): string {
  const maintenant = new Date();
  const d = new Date((ts || 0) * 1000);
  const memeJour = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const hier = new Date(maintenant);
  hier.setDate(maintenant.getDate() - 1);
  if (memeJour(d, maintenant)) return "Aujourd'hui";
  if (memeJour(d, hier)) return "Hier";
  if (Date.now() / 1000 - (ts || 0) < 7 * 86400) return "Cette semaine";
  return "Plus ancien";
}

export function creerNotifications(dep: DependancesNotifications) {
  const notifications = ref<Notification[]>([]);
  const notifUnread = ref(0);
  const showNotifPanel = ref(false);
  const notifDropdownRef: Ref<HTMLElement | null> = ref(null);
  // Préférence par appareil (la permission du navigateur est liée à l'appareil, pas au compte).
  const notifyOSSupported = typeof window !== "undefined" && "Notification" in window;
  // Les notifications du système exigent un contexte sécurisé (HTTPS ou localhost).
  const notifyOSSecure = typeof window === "undefined" || window.isSecureContext !== false;
  const notifyOSEnabled = ref(false);
  try {
    notifyOSEnabled.value =
      typeof localStorage !== "undefined" && localStorage.getItem("elpis.notifyOS") === "1";
  } catch {
    /* stockage refusé */
  }
  const notifLoading = ref(false);
  const notifError = ref(false);
  const notifHasMore = ref(false);
  const notifNowTick = ref(0);
  // Repère « nouveau » de la consultation courante, indépendant de read_at (soldé à l'ouverture).
  const notifNewIds = ref<Set<Notification["id"]>>(new Set());

  const isNotifNew = (n: Notification | null | undefined): boolean => !!n && notifNewIds.value.has(n.id);

  const groupedNotifications = computed(() => {
    const out: GroupeNotifications[] = [];
    let cur: GroupeNotifications | null = null;
    for (const n of notifications.value) {
      const b = tranche(n.created_at);
      if (!cur || cur.label !== b) {
        cur = { label: b, items: [] };
        out.push(cur);
      }
      cur.items.push(n);
    }
    return out;
  });

  async function loadNotifications(): Promise<void> {
    notifLoading.value = true;
    notifError.value = false;
    try {
      const d = await corps(await dep.fetchAuth("/api/notifications?limit=" + String(PAGE), {}, true));
      if (d) {
        notifications.value = Array.isArray(d["items"]) ? (d["items"] as Notification[]) : [];
        notifHasMore.value = notifications.value.length >= PAGE;
        if (typeof d["unread"] === "number") notifUnread.value = d["unread"];
      } else {
        notifError.value = true;
      }
    } catch {
      notifError.value = true;
    } finally {
      notifLoading.value = false;
    }
  }

  /** « Voir plus » : lot suivant par le curseur d'identifiant. */
  async function loadMoreNotifs(): Promise<void> {
    const dernier = notifications.value[notifications.value.length - 1];
    if (!dernier) return;
    notifLoading.value = true;
    try {
      const d = await corps(
        await dep.fetchAuth(
          "/api/notifications?limit=" + String(PAGE) + "&before=" + String(dernier.id),
          {},
          true,
        ),
      );
      if (d) {
        const suite = Array.isArray(d["items"]) ? (d["items"] as Notification[]) : [];
        notifications.value = notifications.value.concat(suite);
        notifHasMore.value = suite.length >= PAGE;
      }
    } catch {
      /* lot suivant indisponible : la liste reste telle quelle */
    } finally {
      notifLoading.value = false;
    }
  }

  async function refreshNotifUnread(): Promise<void> {
    const d = await corps(await dep.fetchAuth("/api/notifications/unread-count", {}, true));
    if (d) notifUnread.value = Number(d["count"]) || 0;
  }

  function lireNonLus(d: Record<string, unknown> | null): void {
    if (d && d["unread"] != null) notifUnread.value = Number(d["unread"]);
  }

  async function markNotifRead(id: Notification["id"]): Promise<void> {
    const n = notifications.value.find((x) => x.id === id);
    if (n && !n.read_at) n.read_at = Date.now() / 1000;
    lireNonLus(
      await corps(
        await dep.fetchAuth("/api/notifications/" + String(id) + "/read", { method: "PATCH" }, true),
      ),
    );
  }

  /** Bascule lu ⇄ non lu d'une notification (« à traiter plus tard »). */
  async function toggleNotifReadState(n: Notification | null | undefined): Promise<void> {
    if (!n) return;
    const nonLu = !!n.read_at;
    n.read_at = nonLu ? null : Date.now() / 1000;
    const suivant = new Set(notifNewIds.value);
    if (nonLu) suivant.add(n.id);
    else suivant.delete(n.id);
    notifNewIds.value = suivant;
    const chemin = "/api/notifications/" + String(n.id) + (nonLu ? "/unread" : "/read");
    lireNonLus(await corps(await dep.fetchAuth(chemin, { method: "PATCH" }, true)));
  }

  async function markAllNotifsRead(): Promise<void> {
    const now = Date.now() / 1000;
    for (const n of notifications.value) if (!n.read_at) n.read_at = now;
    notifUnread.value = 0;
    notifNewIds.value = new Set();
    await dep.fetchAuth("/api/notifications/read-all", { method: "POST" }, true);
  }

  async function deleteNotif(id: Notification["id"]): Promise<void> {
    notifications.value = notifications.value.filter((n) => n.id !== id);
    lireNonLus(
      await corps(await dep.fetchAuth("/api/notifications/" + String(id), { method: "DELETE" }, true)),
    );
  }

  async function clearNotifs(): Promise<void> {
    notifications.value = [];
    notifUnread.value = 0;
    notifNewIds.value = new Set();
    await dep.fetchAuth("/api/notifications/clear", { method: "POST" }, true);
  }

  // Ouvrir le panneau vaut « vu » : compteur soldé et read_at posé localement.
  async function soldeSilencieux(): Promise<void> {
    if (!notifUnread.value) return;
    const now = Date.now() / 1000;
    for (const n of notifications.value) if (!n.read_at) n.read_at = now;
    notifUnread.value = 0;
    await dep.fetchAuth("/api/notifications/read-all", { method: "POST" }, true);
  }

  // Horloge des « il y a … » : ne tourne que panneau ouvert (granularité d'une minute).
  let horloge: ReturnType<typeof setInterval> | null = null;
  function demarrerHorloge(): void {
    horloge ??= setInterval(() => {
      notifNowTick.value++;
    }, 60000);
  }
  function arreterHorloge(): void {
    if (horloge) clearInterval(horloge);
    horloge = null;
  }

  function openNotifPanel(): void {
    showNotifPanel.value = true;
    demarrerHorloge();
    void loadNotifications().then(() => {
      notifNewIds.value = new Set(notifications.value.filter((n) => !n.read_at).map((n) => n.id));
      void soldeSilencieux();
    });
  }
  function closeNotifPanel(): void {
    showNotifPanel.value = false;
    arreterHorloge();
  }
  function toggleNotifPanel(): void {
    if (showNotifPanel.value) closeNotifPanel();
    else openNotifPanel();
  }

  /** Clic sur une notification : marquée lue, puis lien vers sa source quand elle existe encore. */
  async function openNotifItem(n: Notification | null | undefined): Promise<void> {
    if (!n) return;
    if (!n.read_at) void markNotifRead(n.id);
    const rt = n.ref_type || "";
    const rid = n.ref_id != null ? n.ref_id : null;
    try {
      const routines = dep.routines();
      if (rt === "routine" && routines) {
        showNotifPanel.value = false;
        await routines.openRoutinesPage();
        const liste = routines.routines.value || [];
        const trouvee = rid != null ? liste.find((r) => r.id === rid) : null;
        if (trouvee) routines.viewRoutine(trouvee as never);
        else if (rid != null) dep.showToast("Routine introuvable (supprimée ?)", "info");
      } else if (rt === "daily_report") {
        showNotifPanel.value = false;
        dep.goToAdmin("report");
      } else if (rt === "chat" && rid != null) {
        dep.openChatById(rid);
      }
    } catch {
      /* lien impossible : la notification reste marquée lue */
    }
  }

  /** Notification du système, seulement si activée et l'onglet en arrière-plan. */
  function notifierSysteme(n: Notification | null): void {
    if (!n || !notifyOSEnabled.value || !notifyOSSupported) return;
    try {
      if (Notification.permission !== "granted") return;
      if (document.visibilityState !== "hidden") return;
      const osn = new Notification(n.title || "Notification", {
        body: n.body || "",
        tag: "elpis-notif-" + String(n.id),
      });
      osn.onclick = () => {
        try {
          window.focus();
        } catch {
          /* focus refusé */
        }
        if (typeof n._onClick === "function") n._onClick();
        else void openNotifItem(n);
        try {
          osn.close();
        } catch {
          /* déjà fermée */
        }
      };
    } catch {
      /* API indisponible */
    }
  }

  /** Événement `notification` du flux système : charge enrichie (insérée sans aller-retour), destinataire filtré. */
  function onNotificationEvent(brut: unknown): void {
    if (!brut || typeof brut !== "object") return;
    const data = brut as Record<string, unknown>;
    const u = dep.user.value;
    if (u && data["user_id"] != null) {
      const moi = u.id ?? u.user_id;
      if (moi != null && String(data["user_id"]) !== String(moi)) return;
    }
    if (typeof data["unread"] === "number") notifUnread.value = data["unread"];
    else notifUnread.value = (notifUnread.value || 0) + 1;

    const notif: Notification | null =
      data["id"] != null
        ? {
            id: data["id"] as Notification["id"],
            kind: String(data["kind"] || ""),
            title: String(data["title"] || ""),
            body: String(data["body"] || ""),
            ref_type: String(data["ref_type"] || ""),
            ref_id: data["ref_id"] != null ? (data["ref_id"] as Notification["ref_id"]) : null,
            read_at: null,
            created_at: Date.now() / 1000,
          }
        : null;
    if (notif && !notifications.value.some((n) => n.id === notif.id)) {
      notifications.value.unshift(notif);
      // Plafond local : l'historique complet reste en base, le panneau pagine.
      if (notifications.value.length > 200) notifications.value.length = 200;
    }
    // Panneau ouvert : déjà vue, surlignée et soldée, sans toast ni notification du système.
    if (showNotifPanel.value) {
      if (notif) {
        const s = new Set(notifNewIds.value);
        s.add(notif.id);
        notifNewIds.value = s;
      }
      void soldeSilencieux();
      return;
    }
    if (notif?.title) dep.announce("Nouvelle notification : " + notif.title);
    if (notif) {
      dep.showToast(
        notif.title || "Nouvelle notification",
        /error|failed/.test(notif.kind) ? "error" : "success",
        {
          actionLabel: "Voir",
          onAction: () => void openNotifItem(notif),
        },
      );
    }
    notifierSysteme(notif);
  }

  /** Active ou coupe la notification du système (permission demandée au besoin). */
  async function toggleNotifyOS(): Promise<void> {
    if (notifyOSEnabled.value) {
      notifyOSEnabled.value = false;
      try {
        localStorage.setItem("elpis.notifyOS", "0");
      } catch {
        /* stockage refusé */
      }
      return;
    }
    if (!notifyOSSupported) {
      dep.showToast("Notifications système non supportées par ce navigateur", "error");
      return;
    }
    if (!notifyOSSecure) {
      dep.showToast(
        "Notifications indisponibles : page non sécurisée. Ouvrez l'app en HTTPS ou via http://localhost.",
        "error",
        { duration: 8000 },
      );
      return;
    }
    const bloquees =
      "Notifications bloquées pour ce site dans le navigateur. Autorisez-les via le cadenas de la barre d'adresse, puis réessayez.";
    let perm = Notification.permission;
    if (perm === "denied") {
      dep.showToast(bloquees, "error", { duration: 8000 });
      return;
    }
    if (perm === "default") {
      try {
        perm = await Notification.requestPermission();
      } catch {
        perm = "denied";
      }
    }
    if (perm === "granted") {
      notifyOSEnabled.value = true;
      try {
        localStorage.setItem("elpis.notifyOS", "1");
      } catch {
        /* stockage refusé */
      }
      dep.showToast("Notifications système activées", "success");
    } else {
      notifyOSEnabled.value = false;
      dep.showToast(bloquees, "error", { duration: 8000 });
    }
  }

  /** Réponse prête d'un chat lancé en arrière-plan : toast cliquable, notification du système, annonce. */
  function notifyChatDone(chatId: string, title?: string): void {
    const t = title || "Conversation";
    dep.announce("Réponse prête : " + t);
    dep.showToast(t + " — réponse prête", "success", {
      actionLabel: "Ouvrir",
      onAction: () => dep.openChatById(chatId),
    });
    notifierSysteme({
      id: "chat-" + chatId,
      kind: "chat_done",
      title: t,
      body: "La réponse est prête.",
      ref_type: "",
      ref_id: null,
      read_at: null,
      created_at: 0,
      _onClick: () => dep.openChatById(chatId),
    });
  }

  function notifyChatError(chatId: string, title?: string, detail?: unknown): void {
    const t = title || "Conversation";
    dep.announce("Erreur dans : " + t);
    dep.showToast(t + " — erreur" + (detail ? " : " + String(detail).slice(0, 80) : ""), "error", {
      actionLabel: "Ouvrir",
      onAction: () => dep.openChatById(chatId),
    });
    notifierSysteme({
      id: "chaterr-" + chatId,
      kind: "tool_error",
      title: t,
      body: detail ? String(detail) : "Une erreur est survenue.",
      ref_type: "",
      ref_id: null,
      read_at: null,
      created_at: 0,
      _onClick: () => dep.openChatById(chatId),
    });
  }

  // Badge « (N) Elpis » dans le titre de l'onglet en arrière-plan, retiré au retour ou à zéro.
  const titreBase = typeof document !== "undefined" ? document.title || "Elpis" : "Elpis";
  function appliquerBadgeTitre(): void {
    if (typeof document === "undefined") return;
    const n = notifUnread.value || 0;
    document.title =
      n > 0 && document.visibilityState === "hidden"
        ? "(" + (n > 99 ? "99+" : String(n)) + ") " + titreBase
        : titreBase;
  }
  watch(notifUnread, appliquerBadgeTitre);
  watch(showNotifPanel, (ouvert) => {
    if (ouvert) demarrerHorloge();
    else arreterHorloge();
  });

  /** Déconnexion : liste et compteur vidés, panneau fermé. */
  function viderNotifications(): void {
    notifications.value = [];
    notifUnread.value = 0;
    showNotifPanel.value = false;
  }

  return {
    notifications,
    notifUnread,
    showNotifPanel,
    notifDropdownRef,
    toggleNotifPanel,
    openNotifPanel,
    closeNotifPanel,
    loadNotifications,
    loadMoreNotifs,
    refreshNotifUnread,
    markNotifRead,
    markAllNotifsRead,
    deleteNotif,
    clearNotifs,
    openNotifItem,
    toggleNotifReadState,
    notifTimeAgo,
    notifIcon,
    notifColor,
    isNotifNew,
    groupedNotifications,
    notifyOSEnabled,
    notifyOSSupported,
    notifyOSSecure,
    toggleNotifyOS,
    notifLoading,
    notifError,
    notifHasMore,
    notifNowTick,
    onNotificationEvent,
    notifyChatDone,
    notifyChatError,
    appliquerBadgeTitre,
    viderNotifications,
  };
}
