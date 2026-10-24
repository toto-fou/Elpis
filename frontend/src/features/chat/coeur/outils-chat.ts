// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/coeur/outils-chat.ts — outils et réglages par conversation (portés d'`app-chat.js`) : catégories MCP, serveurs du manifeste, outils décochés, persistance par chat (PUT /tools), mode plan, occupation de contexte restaurée, fiche d'un outil. */
import { journal } from "../../../platform/journal";
import { nextTick, watch } from "vue";

import type { CategorieMcp, ServeurManifeste } from "./etat.ts";
import type { CoeurChat } from "./liens.ts";
import type { Objet } from "./types.ts";

const estObjet = (v: unknown): v is Objet => !!v && typeof v === "object" && !Array.isArray(v);
const consoleSeule = (): boolean => !!(window as { __ADMIN_ONLY_MODE__?: boolean }).__ADMIN_ONLY_MODE__;

async function lireListe(rep: Response | null, cle: string): Promise<unknown[] | null> {
  if (!rep || !rep.ok) return null;
  const d: unknown = await rep.json();
  if (!estObjet(d) || !d["ok"]) return null;
  const l = d[cle];
  return Array.isArray(l) ? (l as unknown[]) : [];
}

export function creerOutilsChat(c: CoeurChat) {
  const { r, ctx, e } = c;
  let minuteriePut: ReturnType<typeof setTimeout> | null = null;
  let putEnAttente: { chatId: string; tools: string[] } | null = null;
  let derniereSignature = "";

  // Serveurs MCP externes affichables par ce compte (liste du module Paramètres, repli sur les serveurs perso).
  function pinnedServers(): { id?: unknown; name?: string; type?: string; shared?: boolean }[] {
    const p = ctx.pinnedServers;
    if (p && Array.isArray(p.value)) return p.value;
    return (r.settings.value?.mcp_servers || []).filter((s) => s && s.visible) as {
      id?: unknown;
      name?: string;
    }[];
  }

  // Outils réellement retirés : ceux d'une catégorie cochée (une exclusion sous une catégorie éteinte est ignorée).
  function excludedNames(): string[] {
    const actifs = new Set<string>();
    for (const cat of e.mcpUserCategories.value || [])
      if (e.localTools.value[cat.name]) for (const t of cat.tools || []) actifs.add(t.name);
    return Object.keys(e.excludedTools.value).filter((n) => e.excludedTools.value[n] && actifs.has(n));
  }

  /** État par chat de tout le panneau MCP : catégories, `ext:<id>`, `mf:<nom>`, exclusions `-<outil>`. */
  function activeToolCats(): string[] {
    const cats = Object.keys(e.localTools.value)
      .filter((k) => e.localTools.value[k])
      .sort();
    const ext = (r.config.value.active_mcp_ids || []).map((id) => "ext:" + id).sort();
    const mf = Object.keys(e.manifestTools.value)
      .filter((k) => e.manifestTools.value[k])
      .map((n) => "mf:" + n)
      .sort();
    const excl = excludedNames()
      .map((n) => "-" + n)
      .sort();
    return cats.concat(ext, mf, excl);
  }

  function isToolOn(nom: string): boolean {
    return !e.excludedTools.value[nom];
  }

  function setToolOn(nom: string, on: boolean): void {
    const suite = { ...e.excludedTools.value };
    if (on) delete suite[nom];
    else suite[nom] = true;
    e.excludedTools.value = suite;
  }

  function toggleTool(nom: string): void {
    setToolOn(nom, !isToolOn(nom));
  }

  function catToolsCount(cat: CategorieMcp | null | undefined): string {
    const outils = cat?.tools || [];
    if (!outils.length) return "";
    const on = outils.filter((t) => isToolOn(t.name)).length;
    return on === outils.length ? "" : on + "/" + outils.length;
  }

  function toggleToolCatOpen(nom: string): void {
    e.openToolCats.value = { ...e.openToolCats.value, [nom]: !e.openToolCats.value[nom] };
  }

  function resetCatTools(cat: CategorieMcp | null | undefined): void {
    const suite = { ...e.excludedTools.value };
    for (const t of cat?.tools || []) delete suite[t.name];
    e.excludedTools.value = suite;
  }

  function openToolInfo(outil: Objet | null | undefined, cat: CategorieMcp | null | undefined): void {
    e.toolInfo.value = Object.assign({}, outil || {}, { cat: (cat && (cat.label || cat.name)) || "" });
  }

  function closeToolInfo(): void {
    e.toolInfo.value = null;
  }

  function envoyerOutils(): void {
    const p = putEnAttente;
    putEnAttente = null;
    if (minuteriePut) {
      clearTimeout(minuteriePut);
      minuteriePut = null;
    }
    if (!p || !p.chatId) return;
    derniereSignature = p.chatId + "|" + p.tools.join(",");
    void ctx
      .fetchAuth(
        "/api/saved/chats/" + encodeURIComponent(p.chatId) + "/tools",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tools: p.tools }),
        },
        true,
      )
      .catch(() => null);
  }

  /** Restauration au chargement : null = chat d'avant la fonction (état courant gardé), [] = tout décoché. */
  function applyChatTools(saved: unknown): void {
    if (!Array.isArray(saved)) return;
    const suite: Record<string, boolean> = {};
    for (const k of Object.keys(e.localTools.value)) suite[k] = false;
    const suiteMf: Record<string, boolean> = {};
    for (const k of Object.keys(e.manifestTools.value)) suiteMf[k] = false;
    const extIds: string[] = [];
    const exclus: Record<string, boolean> = {};
    for (const k of saved as unknown[]) {
      if (typeof k !== "string" || !k) continue;
      if (k.startsWith("ext:")) extIds.push(k.slice(4));
      else if (k.startsWith("mf:")) suiteMf[k.slice(3)] = true;
      else if (k.startsWith("-")) exclus[k.slice(1)] = true;
      else suite[k] = true;
    }
    e.localTools.value = suite;
    e.manifestTools.value = suiteMf;
    e.excludedTools.value = exclus;
    // Ids externes restaurés tels quels : filtrer sur des listes encore en vol viderait la sélection en base.
    r.config.value.active_mcp_ids = extIds;
    derniereSignature = (r.currentChatId.value || "") + "|" + activeToolCats().join(",");
  }

  function applyChatPlanMode(v: unknown): void {
    e.planMode.value = !!v;
  }

  // Différé d'un tick : le changement de conversation remet ces états à zéro juste après.
  function applyChatCtxUsage(usage: unknown, chatId: unknown): void {
    void nextTick(() => {
      if (String(r.currentChatId.value) !== String(chatId)) return;
      const u = estObjet(usage) ? usage : {};
      const used = Number(u["used"]) || 0;
      const total = Number(u["total"]) || 0;
      if (!(used > 0) || !(total > 0)) return;
      const pct = typeof u["pct"] === "number" ? u["pct"] : Math.min(100, Math.round((used / total) * 100));
      c.f.lastCtxUsed = used;
      e.ctxRealPct.value = pct;
      e.ctxUsage.value = { used, total, pct, persisted: true };
    });
  }

  // Mode lecture seule : miroir local posé seulement après un aller-retour réussi (chat vierge : armé localement).
  async function setPlanMode(on: boolean): Promise<boolean> {
    const id = r.currentChatId.value;
    if (!id) {
      e.planMode.value = !!on;
      return true;
    }
    try {
      const res = await ctx.fetchAuth(
        "/api/saved/chats/" + encodeURIComponent(id) + "/plan-mode",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plan_mode: !!on }),
        },
        true,
      );
      if (!res || !res.ok) return false;
    } catch {
      return false;
    }
    e.planMode.value = !!on;
    return true;
  }

  function planifierPut(): void {
    const chatId = r.currentChatId.value;
    if (!chatId) return;
    const sig = chatId + "|" + activeToolCats().join(",");
    if (sig === derniereSignature && !putEnAttente) return;
    if (putEnAttente && putEnAttente.chatId !== chatId) envoyerOutils();
    putEnAttente = { chatId, tools: activeToolCats() };
    if (minuteriePut) clearTimeout(minuteriePut);
    minuteriePut = setTimeout(() => {
      minuteriePut = null;
      envoyerOutils();
    }, 600);
  }
  watch(e.localTools, planifierPut, { deep: true });
  watch(e.excludedTools, planifierPut, { deep: true });
  watch(() => (r.config.value.active_mcp_ids || []).join(","), planifierPut);
  watch(e.manifestTools, planifierPut, { deep: true });

  async function loadManifestServers(): Promise<void> {
    try {
      const liste = await lireListe(await ctx.fetchAuth("/api/mcp/manifest-servers"), "servers");
      if (!liste) return;
      const serveurs = liste.filter(
        (s): s is ServeurManifeste => estObjet(s) && typeof s["name"] === "string",
      );
      e.manifestServers.value = serveurs;
      const suite = { ...e.manifestTools.value };
      for (const s of serveurs) if (!(s.name in suite)) suite[s.name] = false;
      const valides = new Set(serveurs.map((s) => s.name));
      for (const k of Object.keys(suite)) if (!valides.has(k)) delete suite[k];
      e.manifestTools.value = suite;
    } catch (err) {
      journal.avertir("[mcp] loadManifestServers failed:", (err instanceof Error && err.message) || err);
    }
  }

  // Catégories visibles du registre ; les bascules existantes sont gardées, les disparues retirées.
  async function loadMcpUserCategories(): Promise<void> {
    try {
      const liste = await lireListe(await ctx.fetchAuth("/api/mcp/categories"), "categories");
      if (liste) {
        const cats = liste.filter((x): x is CategorieMcp => estObjet(x) && typeof x["name"] === "string");
        e.mcpUserCategories.value = cats;
        const suite = { ...e.localTools.value };
        for (const cat of cats) if (!(cat.name in suite)) suite[cat.name] = false;
        const valides = new Set(cats.map((x) => x.name));
        for (const k of Object.keys(suite)) if (!valides.has(k)) delete suite[k];
        e.localTools.value = suite;
      } else return;
    } catch (err) {
      journal.avertir("[mcp] loadMcpUserCategories failed:", (err instanceof Error && err.message) || err);
    }
    await loadManifestServers();
  }

  /** Clés pré-cochées d'un nouveau chat : catégories et serveurs `default_on` du manifeste. */
  function defaultToolKeys(): string[] {
    const out: string[] = [];
    for (const cat of e.mcpUserCategories.value || []) if (cat && cat.default_on) out.push(cat.name);
    for (const s of e.manifestServers.value || []) if (s && s.default_on) out.push("mf:" + s.name);
    return out;
  }

  watch(
    r.user,
    (u) => {
      if (u && !consoleSeule()) void loadMcpUserCategories();
      else {
        e.localTools.value = {};
        e.mcpUserCategories.value = [];
        e.excludedTools.value = {};
      }
    },
    { immediate: true },
  );
  watch(e.showMcpPanel, (ouvert) => {
    if (ouvert && r.user.value) void loadMcpUserCategories();
  });

  return {
    pinnedServers,
    excludedNames,
    activeToolCats,
    isToolOn,
    setToolOn,
    toggleTool,
    catToolsCount,
    toggleToolCatOpen,
    resetCatTools,
    openToolInfo,
    closeToolInfo,
    applyChatTools,
    applyChatPlanMode,
    applyChatCtxUsage,
    setPlanMode,
    loadManifestServers,
    loadMcpUserCategories,
    defaultToolKeys,
  };
}
