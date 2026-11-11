// SPDX-License-Identifier: MIT
/** frontend/test/auth/sse-systeme.test.ts — SSE système : décodage C1, reconnexion, recyclage, expiration, nettoyage lié à la session. */
import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { setupChatSystemSSE } from "../../src/features/auth/sse-systeme";
import type { SourceEvenements } from "../../src/features/auth/sse-systeme";
import { COMPTE_A, COMPTE_B } from "../aides";

class FausseSource implements SourceEvenements {
  readyState = 0;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  ferme = false;
  close(): void {
    this.ferme = true;
    this.readyState = 2;
  }
  ouvrir(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  envoyer(donnees: unknown): void {
    const texte = typeof donnees === "string" ? donnees : JSON.stringify(donnees);
    this.onmessage?.(new MessageEvent("message", { data: texte }));
  }
  tomber(): void {
    this.readyState = 2;
    this.onerror?.(new Event("error"));
  }
}

const ETAT_MODELES = {
  models: ["m"],
  models_with_status: [{ id: "m" }],
  models_loaded: [],
  kv_cache: {},
  server_reachable: true,
  status: "ok",
  props: {},
};

function monter() {
  const session = new GestionnaireSession();
  session.ouvrir(COMPTE_A);
  const sources: FausseSource[] = [];
  const user = ref<unknown>(COMPTE_A);
  const ctx = {
    systemAlert: ref<unknown>(null),
    handleSessionExpired: vi.fn(() => {
      session.fermer("expiration");
      user.value = null;
    }),
  };
  const rappels = {
    onReconnect: vi.fn(),
    onModelStatus: vi.fn(),
    onModelChanged: vi.fn(),
    onNotification: vi.fn(),
    onChatJob: vi.fn(),
    onChatWake: vi.fn(),
    pollModels: vi.fn(),
  };
  const recharger = vi.fn();
  const sonde = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
  const sse = setupChatSystemSSE(
    { user, isLoadingModel: ref(false), isStreaming: ref(false) },
    ctx,
    rappels,
    {
      session,
      creerSource: () => {
        const s = new FausseSource();
        sources.push(s);
        return s;
      },
      fetch: sonde,
      recharger,
    },
  );
  const derniere = (): FausseSource => {
    const s = sources[sources.length - 1];
    if (!s) throw new Error("aucune source");
    return s;
  };
  return { session, sources, derniere, user, ctx, rappels, sse, recharger, sonde };
}

let avertissements = vi.fn();
let infos = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  avertissements = vi.fn();
  infos = vi.fn();
  vi.spyOn(console, "warn").mockImplementation(avertissements);
  vi.spyOn(console, "info").mockImplementation(infos);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("aiguillage des événements", () => {
  it("model_status, model_changed, notification appliqués", () => {
    const t = monter();
    t.sse.connectSystemEvents();
    const s = t.derniere();
    s.ouvrir();
    s.envoyer({ type: "model_status", data: ETAT_MODELES });
    s.envoyer({ type: "model_changed" });
    const notif = {
      user_id: 1,
      id: 3,
      kind: "k",
      title: "t",
      body: "b",
      ref_type: "",
      ref_id: null,
      unread: 1,
    };
    s.envoyer({ type: "notification", data: notif });
    expect(t.rappels.onModelStatus).toHaveBeenCalledWith(ETAT_MODELES);
    expect(t.rappels.onModelChanged).toHaveBeenCalledTimes(1);
    expect(t.rappels.onNotification).toHaveBeenCalledWith(notif);
  });

  it("chat_job et chat_wake : relayés aux rappels de l'état des tâches de fond", () => {
    const t = monter();
    const { onChatJob, onChatWake } = t.rappels;
    t.sse.connectSystemEvents();
    const s = t.derniere();
    const job = {
      id: "j-3f2a1c9e",
      chat_id: "c1",
      chat_title: "T",
      label: "pytest",
      command: "pytest",
      state: "running",
      wake_on: ["exit"],
      wake: true,
      pid: 1,
      exit_code: null,
      signal: null,
      created_at: 1,
      started_at: 1,
      ended_at: null,
      last_line: "",
      log: "/work/.bg/job-j-3f2a1c9e.log",
      pending_events: 0,
    };
    s.envoyer({ type: "chat_job", data: { chat_id: "c1", job, active: 1, active_total: 1 } });
    const wake = {
      chat_id: "c1",
      chat_title: "T",
      status: "queued",
      run_id: null,
      wake: { summary: "pytest terminé", events: [], depth: 1 },
      queued: 2,
    };
    s.envoyer({ type: "chat_wake", data: wake });
    s.envoyer({ type: "chat_wake", data: { ...wake, status: "reveille" } });
    expect(onChatJob).toHaveBeenCalledTimes(1);
    expect(onChatWake).toHaveBeenCalledWith(wake);
    expect(onChatWake).toHaveBeenCalledTimes(1);
  });

  it("rag_job : relayé à la page RAG par un événement `rag:job` de la fenêtre, sans rappel à câbler", () => {
    const t = monter();
    t.sse.connectSystemEvents();
    const s = t.derniere();
    const recus: unknown[] = [];
    const ecoute = (e: Event): void => {
      recus.push((e as CustomEvent).detail);
    };
    window.addEventListener("rag:job", ecoute);
    const coll = "00000000-0000-4000-8000-000000000001";
    const donnees = {
      user_id: 1,
      collection_id: coll,
      job: {
        id: "00000000-0000-4000-8000-000000002001",
        collection_id: coll,
        kind: "ingest",
        status: "running",
        total: 9,
        done: 3,
        failed: 0,
        error: null,
        created_at: 1_700_000_000,
        finished_at: null,
      },
    };
    s.envoyer({ type: "rag_job", data: donnees });
    s.envoyer({ type: "rag_job", data: { ...donnees, job: { ...donnees.job, status: "indescriptible" } } });
    window.removeEventListener("rag:job", ecoute);
    expect(recus).toEqual([donnees]);
    expect(avertissements).toHaveBeenCalled();
  });

  it("invalide ou inconnu : ignoré, jamais appliqué", () => {
    const t = monter();
    t.sse.connectSystemEvents();
    const s = t.derniere();
    s.envoyer("pas du json");
    s.envoyer({ type: "model_status", data: { models: "x" } });
    s.envoyer({ type: "nouveau_type" });
    expect(t.rappels.onModelStatus).not.toHaveBeenCalled();
    expect(avertissements).toHaveBeenCalledTimes(2);
    expect(infos).toHaveBeenCalledWith("[sse] événement système inconnu ignoré :", "nouveau_type");
  });

  it("journal : le flux principal n'en fait rien (la page Journaux a son propre flux)", () => {
    const t = monter();
    t.sse.connectSystemEvents();
    const s = t.derniere();
    s.envoyer({ type: "log", message: "a", level: "INFO", ts: 5 });
    vi.advanceTimersByTime(200);
    expect(s.ferme).toBe(false);
    expect(t.rappels.onModelStatus).not.toHaveBeenCalled();
  });
});

describe("session et reconnexion", () => {
  it("session_expired : flux fermé, traitement d'expiration, aucune reconnexion", () => {
    const t = monter();
    t.sse.connectSystemEvents();
    const s = t.derniere();
    s.envoyer({ type: "session_expired" });
    expect(s.ferme).toBe(true);
    expect(t.ctx.handleSessionExpired).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120_000);
    expect(t.sources).toHaveLength(1);
  });

  it("chute du flux : reconnexion 1 s puis 2 s, resynchronisation à la réouverture", () => {
    const t = monter();
    t.sse.connectSystemEvents();
    t.derniere().ouvrir();
    t.derniere().tomber();
    vi.advanceTimersByTime(999);
    expect(t.sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(t.sources).toHaveLength(2);
    t.derniere().tomber();
    vi.advanceTimersByTime(2000);
    expect(t.sources).toHaveLength(3);
    t.derniere().ouvrir();
    expect(t.rappels.onReconnect).toHaveBeenCalledTimes(1);
  });

  it("worker_recycling : rebranché après 750 ms, sans bannière", () => {
    const t = monter();
    t.sse.connectSystemEvents();
    t.derniere().ouvrir();
    t.derniere().envoyer({ type: "worker_recycling" });
    vi.advanceTimersByTime(750);
    expect(t.sources).toHaveLength(2);
    t.derniere().ouvrir();
    expect(t.rappels.onReconnect).toHaveBeenCalledTimes(1);
    expect(t.ctx.systemAlert.value).toBeNull();
  });

  it("restart : bannière, une seule chaîne de sondes, rechargement", async () => {
    const t = monter();
    t.sse.connectSystemEvents();
    t.derniere().envoyer({ type: "restart", message: "Redémarrage", started_at: 1 });
    t.derniere().envoyer({ type: "app_restarting" });
    expect(t.ctx.systemAlert.value).toBe("Le serveur redémarre…");
    await vi.advanceTimersByTimeAsync(6000);
    expect(t.sonde).toHaveBeenCalledTimes(1);
    expect(t.recharger).toHaveBeenCalledTimes(1);
  });

  it("app_restarting force_logout : expiration traitée", () => {
    const t = monter();
    t.sse.connectSystemEvents();
    t.derniere().envoyer({ type: "app_restarting", message: "m", force_logout: true });
    expect(t.ctx.handleSessionExpired).toHaveBeenCalled();
    expect(t.derniere().ferme).toBe(true);
  });

  it("sans utilisateur : aucune connexion (pas de boucle de 401)", () => {
    const t = monter();
    t.user.value = null;
    t.sse.connectSystemEvents();
    expect(t.sources).toHaveLength(0);
  });

  it("changement de compte : flux, timers et écouteur de visibilité de A libérés", () => {
    const t = monter();
    t.sse.connectSystemEvents();
    const sA = t.derniere();
    sA.tomber();
    t.session.fermer("deconnexion");
    t.session.ouvrir(COMPTE_B);
    expect(sA.ferme).toBe(true);
    vi.advanceTimersByTime(120_000);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(t.sources).toHaveLength(1);
    expect(t.rappels.pollModels).not.toHaveBeenCalled();
    t.user.value = COMPTE_B;
    t.sse.connectSystemEvents();
    expect(t.sources).toHaveLength(2);
  });

  it("événement tardif d'une source fermée : ignoré", () => {
    const t = monter();
    t.sse.connectSystemEvents();
    const s = t.derniere();
    t.sse.disconnectSystemEvents();
    s.envoyer({ type: "model_changed" });
    expect(t.rappels.onModelChanged).not.toHaveBeenCalled();
  });

  it("sondage de secours des modèles toutes les 60 s, arrêté à la déconnexion", () => {
    const t = monter();
    t.sse.connectSystemEvents();
    vi.advanceTimersByTime(60_000);
    expect(t.rappels.pollModels).toHaveBeenCalledTimes(1);
    t.sse.disconnectSystemEvents();
    vi.advanceTimersByTime(180_000);
    expect(t.rappels.pollModels).toHaveBeenCalledTimes(1);
  });
});
