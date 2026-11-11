// SPDX-License-Identifier: MIT
/** frontend/test/reglages/agents-lecture-seule.test.ts — page Agents : réflexion par agent (choix du compte ou défaut de l'administrateur), lecture seule par agent (défaut de l'administrateur, réglage du compte, imposée = verrouillée), écriture de `read_only` dans `custom_agents`, session web du compte (interdite par l'administrateur = verrouillée). */
import { DEFAUTS_REGLAGES_AGENTS } from "@elpis/contracts";
import type { LectureSeuleAgents } from "@elpis/contracts";
import { ref } from "vue";
import * as Vue from "vue";
import { describe, expect, it } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import type { RangeeAgent } from "../../src/features/reglages/agents";
import { setupReglages } from "../../src/features/reglages/reglages";
import type { AgentPerso, CtxReglages, RefsReglages, ReglagesApp } from "../../src/features/reglages/types";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const LIVRES = ["explore", "implement", "verify", "web", "pr"] as const;

function politique(forced: Partial<Record<string, boolean>> = {}): LectureSeuleAgents {
  const p = JSON.parse(JSON.stringify(DEFAUTS_REGLAGES_AGENTS.read_only)) as LectureSeuleAgents;
  Object.assign(p.forced, forced);
  return p;
}

function monter(pol: LectureSeuleAgents, agents: AgentPerso[] = [], sessionWeb = true) {
  const puts: Record<string, unknown>[] = [];
  const route = (url: string, init?: RequestInit): Response => {
    if (url === "/api/settings/agent-templates")
      return json({
        templates: LIVRES.map((name) => ({
          name,
          summary: name,
          prompt: "persona " + name,
          tool_categories: ["fs"],
          max_iters: 20,
          read_only_default: pol.defaults[name],
          read_only_forced: pol.forced[name],
        })),
        read_only_policy: pol,
        thinking_policy: DEFAUTS_REGLAGES_AGENTS.thinking,
        user_browser_session_allowed: sessionWeb,
      });
    if (url === "/api/settings" && init?.method === "PUT") {
      puts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return json({ ok: true });
    }
    return json({});
  };
  const fetchFaux = (url: string, init?: RequestInit): Promise<Response> => Promise.resolve(route(url, init));
  const settings = ref<ReglagesApp>({ custom_agents: agents });
  const refs: RefsReglages = {
    user: ref({ username: "alice" }),
    settings,
    config: ref({ active_mcp_ids: [] }),
    inputMessage: ref(""),
    inputRef: ref(null),
  };
  const ctx: CtxReglages = {
    showToast: () => undefined,
    fetchAuth: (url, options) => fetchFaux(url, options),
    openConfirm: () => Promise.resolve(true),
    openPrompt: () => Promise.resolve(null),
  };
  const R = setupReglages(Vue, refs, ctx, new ClientHttp(new GestionnaireSession(), fetchFaux));
  const rangee = (nom: string): RangeeAgent | undefined => R.agentBank.value.find((a) => a.name === nom);
  return { R, puts, settings, rangee };
}

describe("page Agents : réflexion", () => {
  it("choix du compte s'il est posé, sinon défaut de l'administrateur pour le type (`custom` pour un agent personnel)", async () => {
    const { R, rangee } = monter(politique(), [
      { name: "explore", thinking: "on" },
      { name: "docs", description: "d", prompt: "p", tool_categories: ["fs"], mcp_server_ids: [] },
      {
        name: "revue",
        description: "r",
        prompt: "p",
        tool_categories: ["fs"],
        mcp_server_ids: [],
        thinking: "off",
      },
    ]);
    await R.loadAgentTemplates(true);
    expect(rangee("explore")).toMatchObject({ thinking: "on", thinking_source: "compte" });
    expect(rangee("verify")).toMatchObject({ thinking: "on", thinking_source: "defaut" });
    expect(rangee("web")).toMatchObject({ thinking: "off", thinking_source: "defaut" });
    expect(rangee("docs")).toMatchObject({ thinking: "inherit", thinking_source: "defaut" });
    expect(rangee("revue")).toMatchObject({ thinking: "off", thinking_source: "compte" });
  });
});

describe("page Agents : lecture seule", () => {
  it("état effectif : défaut de l'administrateur par type, `custom` pour un agent personnel", async () => {
    const { R, rangee } = monter(politique(), [
      { name: "docs", description: "d", prompt: "p", tool_categories: ["fs"], mcp_server_ids: [] },
    ]);
    await R.loadAgentTemplates(true);
    expect(rangee("explore")).toMatchObject({
      read_only: true,
      read_only_forced: false,
      read_only_source: "defaut",
    });
    expect(rangee("implement")).toMatchObject({ read_only: false, read_only_source: "defaut" });
    expect(rangee("docs")).toMatchObject({ read_only: false, read_only_source: "defaut" });
  });

  it("imposée par l'administrateur : choix verrouillé, le formulaire garde la valeur posée par le compte", async () => {
    const { R, rangee, puts } = monter(politique({ explore: true, custom: true }), [
      { name: "explore", read_only: false },
    ]);
    await R.loadAgentTemplates(true);
    expect(rangee("explore")).toMatchObject({
      read_only: true,
      read_only_forced: true,
      read_only_source: "imposee",
    });
    R.startEditAgent(rangee("explore"));
    expect(R.agentForm.value?.read_only).toBe(false);
    expect(R.agentFormChoix.value.lectureSeule).toMatchObject({ impose: true, valeur: true, posee: false });
    R.choisirLectureSeule(false);
    expect(R.agentForm.value?.read_only).toBe(false);
    await R.saveAgentForm();
    expect(puts.at(-1)).toEqual({
      custom_agents: [
        {
          name: "explore",
          description: "",
          mcp_server_ids: [],
          tool_categories: [],
          prompt: "",
          read_only: false,
        },
      ],
    });
  });

  it("segment « Lecture seule » d'un livré : écrit `read_only` à l'enregistrement ; le choix du défaut le retire", async () => {
    const { R, rangee, puts, settings } = monter(politique());
    await R.loadAgentTemplates(true);
    R.startEditAgent(rangee("implement"));
    R.choisirLectureSeule(true);
    expect(R.agentFormChoix.value.lectureSeule).toMatchObject({ valeur: true, posee: true, defaut: false });
    expect(puts).toEqual([]);
    await R.saveAgentForm();
    expect((puts.at(-1)?.["custom_agents"] as AgentPerso[])[0]).toMatchObject({
      name: "implement",
      read_only: true,
    });
    expect(rangee("implement")).toMatchObject({ read_only: true, read_only_source: "compte" });
    R.startEditAgent(rangee("implement"));
    R.choisirLectureSeule(false);
    expect(R.agentForm.value?.read_only).toBeNull();
    await R.saveAgentForm();
    expect(settings.value.custom_agents).toEqual([]);
    expect(rangee("implement")).toMatchObject({ read_only: false, read_only_source: "defaut" });
  });

  it("explore lecture seule par défaut : « Lecture et écriture » écrit `read_only: false` ; « Revenir au défaut » l'efface", async () => {
    const { R, rangee, puts } = monter(politique());
    await R.loadAgentTemplates(true);
    R.startEditAgent(rangee("explore"));
    R.choisirLectureSeule(false);
    await R.saveAgentForm();
    expect((puts.at(-1)?.["custom_agents"] as AgentPerso[])[0]).toMatchObject({
      name: "explore",
      read_only: false,
    });
    R.startEditAgent(rangee("explore"));
    expect(R.agentFormChoix.value.lectureSeule.posee).toBe(true);
    R.revenirDefautLectureSeule();
    await R.saveAgentForm();
    expect(puts.at(-1)).toEqual({ custom_agents: [] });
  });

  it("le formulaire garde la case : modifier un agent ne perd pas son `read_only`", async () => {
    const { R, rangee, settings } = monter(politique(), [
      {
        name: "docs",
        description: "d",
        prompt: "p",
        tool_categories: ["fs"],
        mcp_server_ids: [],
        read_only: true,
      },
      { name: "implement", read_only: true },
    ]);
    await R.loadAgentTemplates(true);
    R.startEditAgent(rangee("docs"));
    if (R.agentForm.value) R.agentForm.value.description = "nouvelle";
    await R.saveAgentForm();
    R.startEditAgent(rangee("implement"));
    if (R.agentForm.value) R.agentForm.value.max_iters = 30;
    await R.saveAgentForm();
    const liste = settings.value.custom_agents ?? [];
    expect(liste.find((a) => a.name === "docs")).toMatchObject({ description: "nouvelle", read_only: true });
    expect(liste.find((a) => a.name === "implement")).toMatchObject({ max_iters: 30, read_only: true });
  });
});

describe("page Agents : session web", () => {
  it("« Ma session web » écrit `user_browser_session: true`, « Session privée » l'efface ; interdite par l'administrateur, le choix est verrouillé", async () => {
    const { R, rangee, puts, settings } = monter(politique());
    await R.loadAgentTemplates(true);
    R.startEditAgent(rangee("web"));
    expect(R.agentFormChoix.value.sessionWeb).toEqual({ permise: true, valeur: false });
    R.choisirSessionWeb(true);
    await R.saveAgentForm();
    expect((puts.at(-1)?.["custom_agents"] as AgentPerso[])[0]).toMatchObject({
      name: "web",
      user_browser_session: true,
    });
    expect(rangee("web")).toMatchObject({ user_browser_session: true });
    R.startEditAgent(rangee("web"));
    R.choisirSessionWeb(false);
    await R.saveAgentForm();
    expect(settings.value.custom_agents).toEqual([]);
    const interdit = monter(politique(), [{ name: "web", user_browser_session: true }], false);
    await interdit.R.loadAgentTemplates(true);
    interdit.R.startEditAgent(interdit.rangee("web"));
    expect(interdit.R.agentFormChoix.value.sessionWeb).toEqual({ permise: false, valeur: false });
    interdit.R.choisirSessionWeb(false);
    expect(interdit.R.agentForm.value?.user_browser_session).toBe(true);
  });
});
