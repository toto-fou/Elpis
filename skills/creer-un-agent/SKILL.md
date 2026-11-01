---
name: creer-un-agent
description: Create a personal sub-agent through a short guided interview — ask grouped questions (mission and deliverable, tools and MCP servers, read-only, budget, reasoning), draft the complete card (name, one-line description, tool categories, read_only, max_iters, thinking, English persona), then save it DISABLED with agent_save for the user to review and switch on from the Agents page
tags: [agent, agents, sous-agent, subagent, persona, task, delegation, assistant, entretien, interview]
compatibility: agent_save and ask_user, general built-in tools of the chat (no category; agent_save is absent when the administrator switched sub-agents off)
---

# Create a personal agent — guided interview

You turn the USER'S recurring kind of mission into a personal sub-agent that the
assistant can later delegate to with `task`: short interview, draft, approval,
save. These instructions are in English; **always talk to the user in their
language** (French by default). The agent itself — its one-line description and
its persona — is read by models, so **write the description and the persona in
English**, whatever the user's language.

The first user message normally carries an INITIAL BRIEF (name, mission, tools,
constraints). Build on it — never re-ask what it already answers. Draft nothing
until the interview is complete.

## 1. Interview — `ask_user` questionnaire

Ask several questions AT ONCE with the `ask_user` tool (an interactive panel
opens above the prompt bar; the combined answers arrive as the NEXT user
message). Write questions and options in the user's language, then end your
turn with ONE short sentence inviting the user to answer — never repeat the
questions in text.

    ask_user(questions=[
      {"q": "Quelle mission confier à cet agent, et que doit-il rendre ?", "options": []},
      {"q": "De quels outils a-t-il besoin ?",
       "options": ["Fichiers", "Terminal", "Git", "Navigateur / web", "Office"], "multi": true},
      {"q": "Peut-il modifier quelque chose ?",
       "options": ["Non, lecture seule", "Oui, il écrit"]},
      {"q": "Quel budget d'appels d'outils par mission ?",
       "options": ["Court (15)", "Moyen (30)", "Long (60)"]}
    ])

If `ask_user` is unavailable, ask the same questions numbered in plain text.

Rules:
- 3 to 5 questions per round, **2 rounds maximum**; the second round only for
  what the first answers left unclear (one of the user's MCP servers,
  reasoning, folders it must never touch). Then draft.
- Cover: mission and expected deliverable · tools (categories and the user's
  MCP servers) · read-only or not · iteration budget · reasoning.
- Do not ask about the user's web session: agent_save cannot set it (the agent
  always starts with its own isolated browser). Mention it only at hand-over.
- **Never invent a value** (server id, path, URL): ask, or leave it out and say
  so.

## 2. Drafting — the complete card

- `name`: 1-32 characters `a-z 0-9 - _`, starting and ending with a letter or
  digit (e.g. `revue-sql`). Not a built-in agent name (`explore`, `implement`,
  `verify`, `web`, `pr`).
- `description`: ONE line in English, 200 characters at most, telling the
  parent model WHEN to delegate to this agent and what it returns (it appears
  in the agent list of `task`).
- `tool_categories`: only what the mission needs. Valid values: `browser`,
  `chart`, `desktop`, `fs`, `git`, `memory`, `office`, `shell`, `skill`. An
  unknown category is refused: the tool error lists the valid values.
- `mcp_server_ids`: only when the user named one of their MCP servers. If you
  do not know its id, pass the name the user gave: the tool error lists the
  valid ids with their names; or leave it out and tell the user to tick the
  server in the agent's Tools tab.
- `read_only`: `true` for an agent that investigates, reviews or checks —
  it then has no write, commit or shell tool, and its report is not tainted by
  its own changes.
- `max_iters`: tool-call budget per mission (1-200); leave it out for the
  default. Roughly 15 for a lookup, 30 for an investigation, 60 for a change.
- `thinking`: `off`, `on` or `inherit`; leave it out unless the user asked.
- `prompt` — the persona, **in English**, in the structure of the shipped
  agents:

      # Role
      Who the agent is: expertise and what people trust it for (3-4 lines).

      # Objective
      The kind of mission it receives and what a good result is. Its report
      travels alone: the parent sees none of its tool calls.

      # Your tools
      The tools of its categories that this job runs on, and how to use them.

      # Method
      Numbered steps, from locating to verifying.

      # Effort
      A call budget by mission size (small, medium, large).

      # Constraints
      Hard limits: read-only or not, folders it must never touch, what it must
      never do; no emojis; report in the language of the mission.

      # Report
      Use the common report format of your rules, Status line first. Then the
      sections specific to this agent.

- **Show the COMPLETE card (name, description, tools, read-only, budget,
  reasoning, persona) and get explicit approval BEFORE saving.** After
  corrections, re-show only what changed.

## 3. Saving

Call `agent_save(name, description, prompt, ...)` only after explicit approval.
- `agent_exists`: ask the user whether to overwrite their agent of that name
  (`replace=true`) or to choose another name.
- `invalid_argument`: read the message, fix the argument and retry once; if it
  still fails, explain the problem to the user.
- `agents_limit`: the user must delete one of their agents on the Agents page
  first.
- `agent_save` absent (sub-agents switched off by the administrator): give the
  complete card to the user so they can create it by hand on the Agents page.

## 4. Hand over

Tell the user (in their language): the agent was saved **disabled** — the
assistant cannot delegate to it yet. They review it and switch it on from the
**Agents** page (Plus menu), where they can also edit every field and, in the
Rights tab, tick "Ma session web" if it should use their logged-in web session
(it starts with its own isolated browser). Sub-agents must
also be switched on for their account (switch at the top of the Agents page).
