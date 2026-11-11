// SPDX-License-Identifier: MIT
/** frontend/test/reglages/mcp.test.ts — gestionnaire MCP à deux volets : sélection et garde de saisie, formulaire unique (perso, publié), test par serveur, suppression en ligne, modèles. */
import { ref } from "vue";
import * as Vue from "vue";
import { describe, expect, it } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { erreursFormulaireMcp, resumeTestMcp } from "../../src/features/reglages/mcp";
import type { EtatTestMcp } from "../../src/features/reglages/mcp";
import { setupReglages } from "../../src/features/reglages/reglages";
import type { CtxReglages, RefsReglages, ReglagesApp, ServeurMcp } from "../../src/features/reglages/types";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const PERSO: ServeurMcp[] = [
  {
    id: "server_1",
    name: "Git interne",
    type: "http",
    url: "http://git.lan:4445/mcp",
    command: "",
    visible: true,
    auth_mode: "bearer",
    has_auth: true,
  },
  {
    id: "server_2",
    name: "Jenkins",
    type: "sse",
    url: "https://jenkins.lan/sse",
    command: "",
    visible: false,
  },
];
const PARTAGE = {
  id: "shared:3",
  name: "Annuaire",
  type: "http",
  url: "http://annuaire.lan/mcp",
  enabled: true,
  has_auth: false,
  shared: true,
};

/** Options du faux core : test retenu jusqu'à `liberer()`, relecture de la bibliothèque en panne. */
interface Options {
  retenirTest?: boolean;
  bibliothequeKo?: boolean;
}

function monter(o: Options = {}) {
  let liberer: () => void = () => undefined;
  const retenue = new Promise<void>((r) => (liberer = r));
  const appels: { url: string; methode: string; corps: Record<string, unknown> }[] = [];
  let stockes: Record<string, unknown>[] = JSON.parse(JSON.stringify(PERSO)) as Record<string, unknown>[];
  const partages: Record<string, unknown>[] = [{ ...PARTAGE }];
  const route = (url: string, init?: RequestInit): Response => {
    const methode = init?.method ?? "GET";
    const corps = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    appels.push({ url, methode, corps });
    if (url === "/api/settings" && methode === "PUT") {
      if (Array.isArray(corps["mcp_servers"])) stockes = corps["mcp_servers"] as Record<string, unknown>[];
      return json({ ok: true });
    }
    if (url === "/api/settings") return json({ mcp_servers: stockes });
    if (url === "/api/mcp/shared-servers" && methode === "POST") {
      const s = { ...corps, id: "shared:9", shared: true, has_auth: false };
      partages.push(s);
      return json({ ok: true, server: s });
    }
    if (url === "/api/mcp/shared-servers")
      return o.bibliothequeKo
        ? json({ detail: "non" }, 500)
        : json({ ok: true, servers: partages, can_publish: true });
    if (url === "/api/mcp/test")
      return corps["url"] === "http://mauvais"
        ? json({ ok: false, error: "401 Unauthorized" })
        : json({ ok: true, tools: ["a", "b"], ms: 42 });
    return json({});
  };
  const fetchFaux = (url: string, init?: RequestInit): Promise<Response> =>
    o.retenirTest && url === "/api/mcp/test"
      ? retenue.then(() => route(url, init))
      : Promise.resolve(route(url, init));
  const settings = ref<ReglagesApp>({});
  const config = ref({ active_mcp_ids: ["server_1"] });
  const refs: RefsReglages = {
    user: ref({ username: "alice", role: "admin" }),
    settings,
    config,
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
  return { R, appels, settings, config, liberer: () => liberer() };
}

async function ouvert(o: Options = {}) {
  const m = monter(o);
  await m.R.loadSettingsData();
  m.R.openMcpManager();
  await m.R.loadSharedMcpServers();
  return m;
}

describe("resumeTestMcp / erreursFormulaireMcp", () => {
  const t = (e: Partial<EtatTestMcp>): EtatTestMcp => ({
    busy: false,
    ok: null,
    msg: "",
    outils: 0,
    ms: 0,
    ...e,
  });
  it("dit l'état du dernier test, court ou long", () => {
    expect(resumeTestMcp(undefined)).toEqual({ genre: "none", texte: "Non testé" });
    expect(resumeTestMcp(t({ busy: true }))).toEqual({ genre: "busy", texte: "Test…" });
    expect(resumeTestMcp(t({ ok: true, outils: 1, ms: 9 }))).toEqual({ genre: "ok", texte: "1 outil" });
    expect(resumeTestMcp(t({ ok: true, outils: 14, ms: 62 }), true).texte).toBe("14 outils · 62 ms");
    expect(resumeTestMcp(t({ ok: false, msg: "401" }))).toEqual({ genre: "err", texte: "Échec" });
    expect(resumeTestMcp(t({ ok: false, msg: "401" }), true).texte).toBe("Échec · 401");
  });
  it("exige nom et adresse, ou commande pour un serveur local", () => {
    const vide = {
      portee: "perso" as const,
      id: "",
      name: "",
      type: "http",
      url: "",
      command: "",
      auth_mode: "",
      auth_user: "",
      auth_secret: "",
      has_auth: false,
      headers: [],
      env: [],
      enabled: true,
    };
    expect(Object.keys(erreursFormulaireMcp(vide))).toEqual(["name", "url"]);
    expect(Object.keys(erreursFormulaireMcp({ ...vide, name: "x", type: "stdio" }))).toEqual(["command"]);
  });
});

describe("gestionnaire MCP à deux volets", () => {
  it("ouvre sur le premier serveur perso, formulaire propre", async () => {
    const { R } = await ouvert();
    expect(R.showMcpManagerModal.value).toBe(true);
    expect(R.mcpSel.value).toBe("p:server_1");
    expect(R.mcpForm.value).toMatchObject({
      portee: "perso",
      id: "server_1",
      name: "Git interne",
      has_auth: true,
      auth_secret: "",
    });
    expect(R.mcpSale.value).toBe(false);
  });

  it("une saisie en cours retient le changement de serveur et la fermeture jusqu'à Abandonner", async () => {
    const { R } = await ouvert();
    if (R.mcpForm.value) R.mcpForm.value.url = "http://git.lan:4446/mcp";
    R.mcpChoisir("p:server_2");
    expect(R.mcpGarde.value).toBe("p:server_2");
    expect(R.mcpSel.value).toBe("p:server_1");
    R.closeMcpManager();
    expect(R.mcpGarde.value).toBeNull();
    R.closeMcpManager();
    expect(R.mcpGarde.value).toBe("fermer");
    expect(R.showMcpManagerModal.value).toBe(true);
    R.mcpAbandonner();
    expect(R.showMcpManagerModal.value).toBe(false);
  });

  it("Enregistrer depuis la garde enregistre puis passe au serveur demandé", async () => {
    const { R, appels } = await ouvert();
    if (R.mcpForm.value) R.mcpForm.value.name = "Git";
    R.mcpChoisir("p:server_2");
    await R.mcpGardeEnregistrer();
    expect(appels.some((a) => a.methode === "PUT" && JSON.stringify(a.corps).includes('"name":"Git"'))).toBe(
      true,
    );
    expect(R.mcpSel.value).toBe("p:server_2");
  });

  it("un champ requis manquant reste sous le champ, rien ne part", async () => {
    const { R, appels } = await ouvert();
    R.mcpNouveau();
    expect(await R.mcpEnregistrer()).toBe(false);
    expect(R.mcpErreurs.value).toMatchObject({ name: "Nom requis" });
    expect(appels.filter((a) => a.methode === "PUT")).toEqual([]);
    R.mcpEffacerErreur("name");
    expect(R.mcpErreurs.value["name"]).toBeUndefined();
  });

  it("le test d'un nouveau serveur suit le serveur une fois ajouté ; l'échec garde son message", async () => {
    const { R, settings } = await ouvert();
    R.mcpNouveau();
    Object.assign(R.mcpForm.value ?? {}, { name: "Wiki", url: "http://wiki.lan/mcp" });
    await R.mcpTester();
    expect(R.mcpTests.value["nouveau"]).toMatchObject({ ok: true, outils: 2, ms: 42 });
    expect(await R.mcpEnregistrer()).toBe(true);
    const id = settings.value.mcp_servers?.at(-1)?.id ?? "";
    expect(R.mcpSel.value).toBe("p:" + id);
    expect(R.mcpTests.value[id]).toMatchObject({ ok: true, outils: 2 });
    expect(R.mcpFlash.value).toBe("Ajouté");
    if (R.mcpForm.value) R.mcpForm.value.url = "http://mauvais";
    await R.mcpTester();
    expect(R.mcpTests.value[id]).toMatchObject({ ok: false, msg: "401 Unauthorized" });
  });

  it("portée Tous : pas de serveur local, publication POST avec « enabled », sélection du publié", async () => {
    const { R, appels } = await ouvert();
    R.mcpNouveau();
    R.mcpSetType("stdio");
    R.mcpSetPortee("partage");
    expect(R.mcpForm.value?.type).toBe("http");
    R.mcpSetType("stdio");
    expect(R.mcpForm.value?.type).toBe("http");
    Object.assign(R.mcpForm.value ?? {}, { name: "Docs", url: "http://docs.lan/mcp" });
    expect(await R.mcpEnregistrer()).toBe(true);
    const post = appels.find((a) => a.url === "/api/mcp/shared-servers" && a.methode === "POST");
    expect(post?.corps).toMatchObject({ name: "Docs", type: "http", enabled: true });
    expect(R.mcpSel.value).toBe("s:shared:9");
    expect(R.mcpFlash.value).toBe("Publié");
  });

  it("épingler un serveur publié ne salit pas le formulaire", async () => {
    const { R, settings } = await ouvert();
    R.mcpChoisir("s:shared:3");
    await R.mcpBasculerPanneau();
    expect(settings.value.shared_mcp_visible).toEqual(["shared:3"]);
    expect(R.mcpEstEpingle("partage", "shared:3")).toBe(true);
    expect(R.mcpSale.value).toBe(false);
  });

  it("suppression en ligne : retire le serveur et son id actif, sélectionne le suivant", async () => {
    const { R, settings, config } = await ouvert();
    R.mcpDemanderSuppression();
    expect(R.mcpConfirmer.value).toBe(true);
    R.closeMcpManager();
    expect(R.mcpConfirmer.value).toBe(false);
    R.mcpDemanderSuppression();
    await R.mcpSupprimer();
    expect(settings.value.mcp_servers?.map((s) => s.id)).toEqual(["server_2"]);
    expect(config.value.active_mcp_ids).toEqual([]);
    expect(R.mcpSel.value).toBe("p:server_2");
  });

  it("un modèle ne s'applique qu'à un nouveau serveur", async () => {
    const { R } = await ouvert();
    R.mcpAppliquerModele("wikijs");
    expect(R.mcpForm.value?.name).toBe("Git interne");
    R.mcpNouveau();
    R.mcpAppliquerModele("wikijs");
    expect(R.mcpForm.value).toMatchObject({
      portee: "perso",
      name: "Wiki.js",
      type: "http",
      auth_mode: "bearer",
    });
    expect(R.mcpForm.value?.headers).toEqual([{ name: "X-API-Key", value: "", has_value: false }]);
  });

  it("test en vol puis Ajouter : le résultat atterrit sur le serveur ajouté, rien ne reste « Test… »", async () => {
    const { R, settings, liberer } = await ouvert({ retenirTest: true });
    R.mcpNouveau();
    Object.assign(R.mcpForm.value ?? {}, { name: "Wiki", url: "http://wiki.lan/mcp" });
    const enVol = R.mcpTester();
    expect(await R.mcpEnregistrer()).toBe(true);
    const id = settings.value.mcp_servers?.at(-1)?.id ?? "";
    liberer();
    await enVol;
    expect(R.mcpTests.value[id]).toMatchObject({ busy: false, ok: true, outils: 2 });
    expect(R.mcpTests.value["nouveau"]).toBeUndefined();
  });

  it("test en vol d'un nouveau serveur abandonné : sa réponse n'atterrit sur aucun autre formulaire", async () => {
    const { R, liberer } = await ouvert({ retenirTest: true });
    R.mcpNouveau();
    Object.assign(R.mcpForm.value ?? {}, { url: "http://wiki.lan/mcp" });
    const enVol = R.mcpTester();
    R.mcpAbandonner();
    R.mcpChoisir("p:server_2");
    R.mcpAbandonner();
    liberer();
    await enVol;
    R.mcpNouveau();
    expect(R.mcpTests.value["nouveau"]).toBeUndefined();
  });

  it("enregistrer une autre adresse que celle testée périme le résultat", async () => {
    const { R } = await ouvert();
    await R.mcpTester();
    expect(R.mcpTests.value["server_1"]?.ok).toBe(true);
    if (R.mcpForm.value) R.mcpForm.value.name = "Git renommé";
    await R.mcpEnregistrer();
    expect(R.mcpTests.value["server_1"]?.ok).toBe(true);
    if (R.mcpForm.value) R.mcpForm.value.url = "http://ailleurs.lan/mcp";
    await R.mcpEnregistrer();
    expect(R.mcpTests.value["server_1"]).toBeUndefined();
  });

  it("pendant un enregistrement : ni changement de serveur ni fermeture", async () => {
    const { R } = await ouvert();
    if (R.mcpForm.value) R.mcpForm.value.name = "Git 2";
    const enCours = R.mcpEnregistrer();
    R.mcpChoisir("p:server_2");
    R.closeMcpManager();
    expect(R.mcpGarde.value).toBeNull();
    expect(R.showMcpManagerModal.value).toBe(true);
    await enCours;
    expect(R.mcpSel.value).toBe("p:server_1");
  });

  it("publication : la réponse du core fait foi si la relecture de la bibliothèque échoue", async () => {
    const { R } = await ouvert({ bibliothequeKo: true });
    R.mcpNouveau();
    R.mcpSetPortee("partage");
    Object.assign(R.mcpForm.value ?? {}, { name: "Docs", url: "http://docs.lan/mcp" });
    expect(await R.mcpEnregistrer()).toBe(true);
    expect(R.mcpSel.value).toBe("s:shared:9");
    expect(R.mcpForm.value).toMatchObject({ portee: "partage", id: "shared:9", name: "Docs" });
  });
});
