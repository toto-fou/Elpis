// SPDX-License-Identifier: MIT
/** apps/core/src/comptes/reglages.ts — document de réglages d'un compte : lecture augmentée (défauts, mascottes, skin, sandbox, images, MCP sans secret) et écriture filtrée (accounts/routes_settings.py). */
import { getUserSettings, getUsernameById, ligneUtilisateur, mergeUserSettings } from "@elpis/auth";
import {
  cleHashPy,
  clesOrdonnees,
  comparePointsDeCode,
  egalPy,
  ErreurPython,
  estDict,
  estErreurPython,
  getOu,
  getPy,
  HttpError,
  iterExige,
  nomTypePy,
  ouPy,
  poserCle,
  pyJsonDumps,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config, configView, pyJoin, realpathPy, safeSandboxName } from "@elpis/config";
import type { Base } from "@elpis/db";
import {
  FAMILY_NAMES,
  ID_PREFIX,
  invaliderMcp,
  mergePersonalMcp,
  personalPublic,
  sharedId,
  StdioNotAllowed,
} from "@elpis/mcp";
import { EncryptionUnavailable } from "@elpis/securite";

import { resolveSkinCompte } from "../apparence/comptes-perso";
import { defaultSkin, mascotIds, mascotsCatalogue } from "../apparence/skins";
import { clampMaxRounds, clampThresholdPct, clampThresholdTokens } from "../contexte/porte-compaction";
import { cleanPrefs, enabledIn, readyFor } from "../images/acces";
import { getImageConfig } from "../images/config";
import type { Journal } from "../journal";
import type { ModeApp } from "../mode";
import { validateCustomAgents } from "../outils/integres/taches-agents";

export const USER_SETTINGS_ALLOWED: ReadonlySet<string> = new Set([
  "mcp_servers",
  "shared_mcp_visible",
  "active_mcp_url",
  "system_prompt",
  "assistant_name",
  "enable_editor",
  "enable_preview",
  "enable_mcp",
  "enable_rag",
  "enable_model_selector",
  "enable_charts",
  "sandbox_path_display",
  "editor_ratio",
  "editor_dark_mode",
  "dark_mode",
  "dark_mode_auto",
  "auto_open_editor_on_write",
  "editor_font_size",
  "editor_font_family",
  "editor_tab_size",
  "editor_insert_spaces",
  "editor_word_wrap",
  "editor_minimap",
  "editor_line_numbers",
  "editor_edit_highlight",
  "editor_auto_save",
  "editor_persist_tabs",
  "editor_follow_active",
  "chat_width",
  "sandbox_mode",
  "network_profile_id",
  "thinking_mode",
  "active_mcp_ids",
  "selected_model",
  "ui_lang",
  "ui_theme",
  "skin",
  "welcome_mascot",
  "welcome_mascot_anime",
  "memory_enabled",
  "hide_thinking",
  "agents_enabled",
  "custom_agents",
  "opencode_mcp_families",
  "live_shell_enabled",
  "voice_input_enabled",
  "voice_reply_enabled",
  "voice_reply_tools_enabled",
  "compression_enabled",
  "compression_threshold_pct",
  "compression_threshold_tokens",
  "compression_max_rounds",
  "image_enabled",
  "image_tool_enabled",
  "routine_tool_enabled",
  "image_prefs",
  "jobs_wake",
  "hide_web_screenshots",
  "chat_workflow",
  "context_display",
  "thinking_display",
  "footer_metrics",
  "thread_density",
]);

/** Seules clés que le processus admin accepte en écriture (menu « Compte et apparence » de la console). */
export const ADMIN_PORT_SETTINGS: ReadonlySet<string> = new Set(["skin", "dark_mode", "dark_mode_auto"]);

const SANDBOX_PROTECTED = ["sandbox_mode", "network_profile_id"] as const;
/** Préférences d'affichage du chat à valeurs fermées : une valeur inconnue n'est pas enregistrée. */
export const CHOIX_AFFICHAGE: Readonly<Record<string, readonly string[]>> = {
  chat_workflow: ["classic", "work_block", "timeline", "terminal"],
  context_display: ["tokens", "fill", "percent", "ring"],
  thinking_display: ["collapsed", "expanded", "hidden"],
  footer_metrics: ["full", "essential", "hidden"],
  thread_density: ["comfortable", "compact"],
};
/** Cases coercées en booléen strict au PUT. */
const BOOLEENS = [
  "agents_enabled",
  "dark_mode_auto",
  "live_shell_enabled",
  "image_enabled",
  "image_tool_enabled",
  "routine_tool_enabled",
  "voice_input_enabled",
  "voice_reply_enabled",
  "voice_reply_tools_enabled",
  "compression_enabled",
  "welcome_mascot_anime",
  "jobs_wake",
  "hide_web_screenshots",
] as const;
const MUTABLES_MCP = new Set([
  "visible",
  "auth_enc",
  "key_scheme",
  "has_auth",
  "auth_secret",
  "authorization",
  "basic_auth",
  "headers",
  "headers_enc",
  "env",
  "env_enc",
  "extra_scheme",
]);
const REFUS_MODIFICATION = "Modification de serveur MCP réservée aux administrateurs.";
/** Anciennes clés de l'apparence de l'assistant (icône Phosphor, image chargée) : plus écrites ni relues. */
const AVATAR_ASSISTANT = ["assistant_icon", "assistant_avatar"] as const;

/** Défauts du document, dans l'ordre de `api_get_settings` ; le skin est le défaut d'instance du moment. */
function defauts(mascotte: string): [string, unknown][] {
  return [
    ["mcp_servers", []],
    ["shared_mcp_visible", []],
    ["active_mcp_url", ""],
    ["system_prompt", ""],
    ["assistant_name", "Elpis"],
    ["editor_dark_mode", true],
    ["dark_mode", false],
    ["dark_mode_auto", false],
    ["skin", defaultSkin()],
    ["welcome_mascot", mascotte],
    ["welcome_mascot_anime", true],
    ["auto_open_editor_on_write", true],
    ["editor_font_size", 14],
    ["editor_font_family", "JetBrains Mono"],
    ["editor_tab_size", 4],
    ["editor_insert_spaces", true],
    ["editor_word_wrap", "off"],
    ["editor_minimap", false],
    ["editor_line_numbers", true],
    ["editor_edit_highlight", true],
    ["editor_auto_save", "off"],
    ["editor_persist_tabs", true],
    ["editor_follow_active", false],
    ["memory_enabled", false],
    ["hide_thinking", false],
    ["agents_enabled", false],
    ["custom_agents", []],
    ["live_shell_enabled", true],
    ["compression_enabled", false],
    ["compression_threshold_pct", 0],
    ["compression_threshold_tokens", 0],
    ["compression_max_rounds", 0],
    ["enable_mcp", true],
    ["voice_input_enabled", false],
    ["voice_reply_enabled", false],
    ["voice_reply_tools_enabled", false],
    ["image_enabled", true],
    ["image_tool_enabled", true],
  ];
}

/** `_reglage_mascottes` : (allumées, actives, défaut) réglés par l'admin ; liste vide = toutes ; `mascottes_on` faux coupe tout ; une scène qui n'est pas un objet est ignorée (le Python lève). */
export function reglageMascottes(): [boolean, string[], string] {
  let scene: unknown;
  try {
    scene = ouPy(getPy(ouPy(getPy(ouPy(configView(), {}), "welcome"), {}), "scene"), {});
  } catch {
    scene = {};
  }
  if (!estDict(scene)) scene = {};
  if (getPy(scene, "mascottes_on") === false) return [false, [], ""];
  const toutes = mascotIds();
  let actives = iterExige(ouPy(getPy(scene, "mascottes_actives"), [])).filter(
    (m): m is string => typeof m === "string" && toutes.includes(m),
  );
  if (actives.length === 0) actives = [...toutes];
  const d = getPy(scene, "mascotte_defaut");
  const defaut = typeof d === "string" && actives.includes(d) ? d : d === "" ? "" : (actives[0] as string);
  return [true, actives, defaut];
}

/** `str(SANDBOX_DIR / nom).resolve()` du dossier réel du compte (`safe_sandbox_name`) ; « Error path » si la résolution échoue. */
function cheminSandbox(username: string): string {
  try {
    return realpathPy(pyJoin(config.SANDBOX_DIR, safeSandboxName(username)));
  } catch {
    return "Error path";
  }
}

function selecteurDeModele(): boolean {
  try {
    return veritePy(getPy(getPy(ouPy(configView(), {}), "app", {}), "enable_model_selector", false));
  } catch {
    return false;
  }
}

/** `GET /api/settings` : réglages enregistrés complétés des défauts et des valeurs calculées côté serveur. */
export async function lireReglages(base: Base, uid: number, journal: Journal): Promise<Dict> {
  const saved = await getUserSettings(base, uid, (m) => journal.error(m));
  // Écart voulu au Python : l'avatar de l'assistant est le logo de l'application ; les anciens choix sont ignorés.
  for (const k of AVATAR_ASSISTANT) delete saved[k];
  const liste = defauts("boite_or");
  const [allumees, actives, defautAdmin] = reglageMascottes();
  for (const [k, v] of liste)
    if (!Object.hasOwn(saved, k)) poserCle(saved, k, k === "welcome_mascot" ? defautAdmin : v);
  const mascotte = saved["welcome_mascot"];
  if (veritePy(mascotte) && !(typeof mascotte === "string" && actives.includes(mascotte)))
    poserCle(saved, "welcome_mascot", defautAdmin);
  poserCle(saved, "mascottes_actives", actives);
  poserCle(saved, "mascottes_catalogue", mascotsCatalogue());
  poserCle(saved, "skin", resolveSkinCompte(uid, getOu(saved, "skin", null)));
  poserCle(saved, "mascottes_on", allumees);
  poserCle(saved, "sandbox_path_display", cheminSandbox((await getUsernameById(base, uid)) || "guest"));
  poserCle(saved, "enable_model_selector", selecteurDeModele());
  const cfg = getImageConfig();
  const pret = await readyFor(base, uid, cfg);
  poserCle(saved, "image_ready", pret);
  poserCle(saved, "image_available", pret && enabledIn(saved));
  poserCle(saved, "image_prefs", cleanPrefs(getOu(saved, "image_prefs", null), cfg));
  const serveurs = saved["mcp_servers"];
  if (Array.isArray(serveurs))
    poserCle(
      saved,
      "mcp_servers",
      serveurs.filter((s) => estDict(s)).map((s) => personalPublic(s)),
    );
  return saved;
}

/** `(v or [])[:200]` : liste ou texte ; autre chose n'est pas indexable (TypeError). */
function deuxCentsPremiers(v: unknown): unknown[] {
  if (Array.isArray(v)) return v.slice(0, 200);
  if (typeof v === "string") return Array.from(v).slice(0, 200);
  throw new ErreurPython("TypeError", `'${nomTypePy(v)}' object is not subscriptable`);
}

/** Secret NEUF dans l'entrée : `auth_secret`, ou une valeur d'en-tête ou de variable. */
function porteUneValeur(s: Dict): boolean {
  if (strPy(ouPy(getOu(s, "auth_secret", null), ""))) return true;
  for (const k of ["headers", "env"])
    for (const p of iterExige(ouPy(getOu(s, k, null), [])))
      if (estDict(p) && strPy(ouPy(getOu(p, "value", null), ""))) return true;
  return false;
}

/** `{s.get("id"): s for s in liste if s.get("id")}` : clés à l'égalité Python, TypeError si non hachable ; une entrée qui n'est pas un objet est ignorée (le Python lève). */
function parIdentifiant(liste: unknown): Map<unknown, Dict> {
  const out = new Map<unknown, Dict>();
  for (const s of iterExige(liste)) {
    if (!estDict(s)) continue;
    const id = getPy(s, "id", null);
    if (veritePy(id)) out.set(cleHashPy(id), s as Dict);
  }
  return out;
}

/** Entrées enregistrées ramenées à la forme que la fusion donne à un enregistrement neuf (type, mode et utilisateur d'authentification, clés anciennes retirées) : la comparaison d'un non-admin se fait entre formes normalisées, jamais contre une entrée d'avant ces champs (le Python répond 403 à chaque PUT). */
async function anciennesNormalisees(anciens: unknown): Promise<unknown> {
  if (!Array.isArray(anciens)) return anciens;
  const sansPaires = anciens.map((s: unknown) =>
    estDict(s) ? Object.fromEntries(Object.entries(s).filter(([k]) => k !== "headers" && k !== "env")) : s,
  );
  try {
    return await mergePersonalMcp(anciens, sansPaires, { allowStdio: true });
  } catch {
    return anciens;
  }
}

/** Bloc `mcp_servers` du PUT : ids partagés renommés, droits d'un non-admin, fusion des secrets, invalidation ciblée du pool. */
async function serveursMcp(
  base: Base,
  uid: number,
  data: Dict,
  current: Dict,
  journal: Journal,
): Promise<void> {
  iterExige(ouPy(getOu(data, "mcp_servers", null), [])).forEach((s, i) => {
    if (estDict(s) && strPy(ouPy(getOu(s, "id", null), "")).startsWith(ID_PREFIX)) {
      poserCle(s, "id", `server_local_${i}_${strPy(s["id"]).replaceAll(":", "_")}`);
      journal.warn(`[settings] id de serveur MCP perso dans l'espace partagé — renommé en ${strPy(s["id"])}`);
    }
  });
  const anciens = ouPy(getOu(current, "mcp_servers", []), []);
  const recus = ouPy(getOu(data, "mcp_servers", []), []);
  const moi = await ligneUtilisateur(base, uid);
  const admin = moi !== undefined && moi !== null && Number(moi.is_admin) === 1;
  const ancienneListe = iterExige(anciens);
  if (!admin) {
    const idsAnciens = new Set<string>();
    for (const s of ancienneListe)
      if (estDict(s) && veritePy(getOu(s, "id", null))) idsAnciens.add(strPy(s["id"]));
    for (const s of iterExige(recus))
      if (estDict(s) && idsAnciens.has(strPy(getOu(s, "id", null))) && porteUneValeur(s))
        throw new HttpError(403, REFUS_MODIFICATION);
  }
  let nouvelle: Dict[];
  try {
    nouvelle = await mergePersonalMcp(anciens, recus, { allowStdio: admin });
  } catch (e) {
    if (e instanceof StdioNotAllowed) throw new HttpError(403, e.message);
    if (e instanceof EncryptionUnavailable)
      throw new HttpError(
        503,
        "Chiffrement indisponible : impossible d'enregistrer un secret MCP. Configurez app.encryption_key.",
      );
    throw e;
  }
  poserCle(data, "mcp_servers", nouvelle);
  if (!admin) {
    const avant = parIdentifiant(await anciennesNormalisees(anciens));
    const apres = parIdentifiant(nouvelle);
    for (const sid of avant.keys())
      if (!apres.has(sid))
        throw new HttpError(403, "Suppression de serveur MCP réservée aux administrateurs.");
    for (const [sid, ancien] of avant) {
      const nouveau = apres.get(sid);
      if (!veritePy(nouveau)) continue;
      for (const k of new Set([...clesOrdonnees(ancien), ...clesOrdonnees(nouveau as Dict)]))
        if (!MUTABLES_MCP.has(k) && !egalPy(getOu(ancien, k, null), getOu(nouveau, k, null)))
          throw new HttpError(403, REFUS_MODIFICATION);
    }
  }
  if (pyJsonDumps(anciens, { sortKeys: true }) !== pyJsonDumps(nouvelle, { sortKeys: true }))
    await invaliderMcp({ type: "reglages", avant: ancienneListe, apres: nouvelle });
}

/** `PUT /api/settings` : clés autorisées seulement, valeurs coercées ou ramenées au jeu fermé, puis fusion atomique. */
export async function ecrireReglages(
  base: Base,
  uid: number,
  brut: unknown,
  mode: ModeApp,
  journal: Journal,
): Promise<void> {
  if (!estDict(brut)) throw new HttpError(400, "Le payload doit être un objet JSON.");
  const data: Dict = {};
  for (const k of clesOrdonnees(brut)) if (USER_SETTINGS_ALLOWED.has(k)) poserCle(data, k, brut[k]);
  if (mode === "admin") {
    const extra = Object.keys(data)
      .filter((k) => !ADMIN_PORT_SETTINGS.has(k))
      .sort(comparePointsDeCode);
    if (extra.length > 0)
      throw new HttpError(403, "Préférence non modifiable depuis la console : " + extra.join(", "));
  }
  const current = await getUserSettings(base, uid, (m) => journal.error(m));
  for (const k of SANDBOX_PROTECTED) delete data[k];
  const a = (k: string): boolean => Object.hasOwn(data, k);
  for (const k of BOOLEENS) if (a(k)) poserCle(data, k, veritePy(data[k]));
  for (const [k, valeurs] of Object.entries(CHOIX_AFFICHAGE))
    if (a(k) && !(typeof data[k] === "string" && valeurs.includes(data[k]))) delete data[k];
  if (a("opencode_mcp_families")) {
    const familles = data["opencode_mcp_families"];
    if (estDict(familles)) {
      const net: Dict = {};
      for (const f of clesOrdonnees(familles))
        if (FAMILY_NAMES.includes(f)) poserCle(net, f, veritePy(familles[f]));
      poserCle(data, "opencode_mcp_families", net);
    } else delete data["opencode_mcp_families"];
  }
  if (a("image_prefs")) poserCle(data, "image_prefs", cleanPrefs(data["image_prefs"]));
  if (a("compression_threshold_pct") || a("compression_threshold_tokens")) {
    if (a("compression_threshold_pct"))
      poserCle(data, "compression_threshold_pct", clampThresholdPct(data["compression_threshold_pct"]));
    if (a("compression_threshold_tokens"))
      poserCle(
        data,
        "compression_threshold_tokens",
        clampThresholdTokens(data["compression_threshold_tokens"]),
      );
    if (veritePy(getOu(data, "compression_threshold_tokens", null)))
      poserCle(data, "compression_threshold_pct", 0);
    else if (veritePy(getOu(data, "compression_threshold_pct", null)))
      poserCle(data, "compression_threshold_tokens", 0);
  }
  if (a("compression_max_rounds"))
    poserCle(data, "compression_max_rounds", clampMaxRounds(data["compression_max_rounds"]));
  if (a("skin")) poserCle(data, "skin", resolveSkinCompte(uid, data["skin"]));
  if (a("welcome_mascot")) {
    const [, actives] = reglageMascottes();
    const v = strPy(ouPy(data["welcome_mascot"], ""));
    poserCle(data, "welcome_mascot", actives.includes(v) ? v : "");
  }
  if (a("custom_agents")) {
    try {
      poserCle(data, "custom_agents", validateCustomAgents(data["custom_agents"]));
    } catch (e) {
      if (estErreurPython(e, "ValueError")) throw new HttpError(400, e.message);
      throw e;
    }
  }
  if (a("shared_mcp_visible")) {
    const vus: string[] = [];
    for (const v of deuxCentsPremiers(ouPy(data["shared_mcp_visible"], []))) {
      const s = strPy(ouPy(v, ""));
      if (sharedId(s) !== null && !vus.includes(s)) vus.push(s);
    }
    poserCle(data, "shared_mcp_visible", vus);
  }
  if (a("mcp_servers")) await serveursMcp(base, uid, data, current, journal);
  await mergeUserSettings(base, uid, (s) => {
    for (const k of clesOrdonnees(data)) poserCle(s, k, data[k]);
  });
}
