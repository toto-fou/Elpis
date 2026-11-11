// SPDX-License-Identifier: MIT
/** frontend/test/routines/routines.test.ts — module des routines : ouverture, vue lecture, enregistrement, arrêt d'un run, webhook. */
import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { creerApiRoutines } from "../../src/features/routines/api";
import { creerRoutines } from "../../src/features/routines/routines";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const ROUTINE = {
  id: 3,
  owner_user_id: 1,
  name: "Veille",
  cron_expr: "0 9 * * *",
  model: null,
  system_prompt: "",
  task_prompt: "Résume",
  mcp_snapshot: [
    { command: "DEFAULT_LOCAL_PYTHON", filter_categories: ["fs"] },
    { id: "s1", name: "Ext", type: "sse" },
  ],
  skills: ["deploy"],
  thinking_mode: false,
  enabled: true,
  created_at: 1,
  updated_at: 1,
  last_fire_minute: null,
  runs_keep: 0,
  notify_on: "all",
  notify_keep: 0,
  webhook_enabled: false,
  webhook_filter: {},
  trigger_after_id: null,
  trigger_after_on: "ok",
  agents_enabled: false,
  connector_id: null,
  webhook_has_secret: false,
  last_run: null,
  running_count: 0,
};

function monter(
  routeur: (u: string, i?: RequestInit) => Response | Promise<Response>,
  confirmer: (titre: string) => boolean = () => true,
) {
  const appels: Array<[string, string]> = [];
  const http = new ClientHttp(new GestionnaireSession(), (u, i) => {
    appels.push([i?.method ?? "GET", u]);
    return Promise.resolve(routeur(u, i));
  });
  const toasts: string[] = [];
  const surface = creerRoutines(
    creerApiRoutines(http),
    { currentView: ref("chat") },
    {
      showToast: (m) => void toasts.push(m),
      openConfirm: (titre) => Promise.resolve(confirmer(titre)),
    },
  );
  return { s: surface, appels, toasts };
}

const SKILLS = { skills: [], count: 0 };

afterEach(() => vi.useRealTimers());

describe("module des routines", () => {
  it("ouvre la page, charge la liste et affiche la première routine en lecture", async () => {
    const { s } = monter((u) => {
      if (u === "/api/routines") return json({ items: [ROUTINE] });
      if (u === "/api/skills") return json(SKILLS);
      return json({ items: [] });
    });
    await s.openRoutinesPage();
    expect(s.routines.value).toHaveLength(1);
    expect(s.routineEditMode.value).toBe("view");
    expect(s.selectedRoutineId.value).toBe(3);
    s._liberer();
  });

  it("enregistre une édition : charge utile complète et retour à la vue", async () => {
    let corps: Record<string, unknown> = {};
    const { s, toasts } = monter((u, i) => {
      if (u === "/api/routines" && !i?.method) return json({ items: [ROUTINE] });
      if (u === "/api/routines/3" && i?.method === "PUT") {
        corps = JSON.parse(String(i.body)) as Record<string, unknown>;
        return json({ ok: true });
      }
      if (u === "/api/skills") return json(SKILLS);
      return json({ items: [] });
    });
    await s.loadRoutines();
    const r = s.routines.value[0];
    if (!r) throw new Error("routine absente");
    s.editRoutine(r);
    s.routineForm.value.name = "  Veille 2 ";
    s.toggleWeekday(2);
    await s.saveRoutine();
    expect(corps).toMatchObject({
      name: "Veille 2",
      cron_expr: "0 9 * * *",
      skills: ["deploy"],
      mcp_servers: [
        { type: "stdio", name: "Outils Locaux", command: "DEFAULT_LOCAL_PYTHON", filter_categories: ["fs"] },
        { id: "s1", name: "Ext", type: "sse" },
      ],
    });
    expect(corps).not.toHaveProperty("agents_enabled");
    expect(toasts).toContain("Routine enregistrée");
    expect(s.routineEditMode.value).toBe("view");
    s._liberer();
  });

  it("refuse un nom vide sans appel réseau", async () => {
    const { s, toasts, appels } = monter(() => json({}));
    s.startCreateRoutine();
    await s.saveRoutine();
    expect(toasts).toEqual(["Nom requis"]);
    expect(s.routineEditTab.value).toBe("general");
    expect(appels).toHaveLength(0);
    s._liberer();
  });

  it("quitte sans question tant que rien n'a changé", async () => {
    const titres: string[] = [];
    const { s } = monter(
      () => json({ items: [ROUTINE] }),
      (t) => (titres.push(t), true),
    );
    s.startCreateRoutine();
    expect(s.routineDirty.value).toBe(false);
    await s.cancelRoutineEdit();
    expect(titres).toEqual([]);
    expect(s.routineEditMode.value).toBe("");
    s._liberer();
  });

  it("demande de confirmer l'abandon quand le formulaire a changé, et reste si on refuse", async () => {
    const titres: string[] = [];
    let reponse = false;
    const { s } = monter(
      () => json({ items: [ROUTINE] }),
      (t) => (titres.push(t), reponse),
    );
    s.startCreateRoutine();
    s.routineForm.value.task_prompt = "Une longue tâche";
    expect(s.routineDirty.value).toBe(true);
    await s.cancelRoutineEdit();
    expect(titres).toEqual(["Abandonner les modifications ?"]);
    expect(s.routineEditMode.value).toBe("create");
    reponse = true;
    await s.cancelRoutineEdit();
    expect(s.routineEditMode.value).toBe("");
    s._liberer();
  });

  it("affiche la planification en clair et garde le cron brut quand il est personnalisé", () => {
    const { s } = monter(() => json({}));
    expect(s.cronLisible("0 9 * * *")).toBe("Tous les jours à 09:00");
    expect(s.cronLisible("5 4 2 3 *")).toBe("5 4 2 3 *");
    expect(s.routineEditTabs.map((t) => t.label)).toEqual(["Général", "Planification", "Tâche", "Outils"]);
    s._liberer();
  });

  it("arrête un run en cours une seule fois puis relit le journal", async () => {
    vi.useFakeTimers();
    const run = { id: 7, routine_id: 3, status: "running" } as never;
    const { s, appels, toasts } = monter((u) => {
      if (u.endsWith("/stop")) return json({ ok: true, stopping: true });
      if (u === "/api/routines") return json({ items: [ROUTINE] });
      return json({ items: [] });
    });
    await s.stopRoutineRun(run);
    await s.stopRoutineRun(run);
    expect(appels.filter(([, u]) => u.endsWith("/stop"))).toHaveLength(1);
    expect(toasts).toContain("Arrêt demandé");
    expect(s.runStopping(run)).toBe(true);
    s._liberer();
  });

  it("active le webhook et garde le secret en mémoire", async () => {
    const { s, toasts } = monter((u) => {
      if (u.endsWith("/webhook/rotate")) return json({ ok: true, secret: "abc", path: "/p" });
      if (u === "/api/routines") return json({ items: [ROUTINE] });
      return json({ items: [] });
    });
    await s.loadRoutines();
    s.selectedRoutineId.value = 3;
    await s.rotateWebhook();
    expect(s.webhookSecret.value).toBe("abc");
    expect(s.webhookEnabled.value).toBe(true);
    expect(s.routines.value[0]?.webhook_enabled).toBe(true);
    expect(toasts[0]).toContain("Webhook activé");
    s._liberer();
  });
});
