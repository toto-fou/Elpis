// SPDX-License-Identifier: MIT
/** packages/bureau/src/gestionnaires.ts — gestionnaires des outils MCP `desktop_*` (enveloppes de desktop_tools.register) : arguments et défauts du schéma, cible active, politique et exposition ; l'inscription MCP vient de l'hôte d'outils. */
import {
  FlottantPy,
  getPy,
  intPy,
  longueurPy,
  lowerPy,
  ouPy as ou,
  strPy,
  stripPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config, getDesktopTargets } from "@elpis/config";

import { agentReq, allowedTargets, noTargetErr, ok, rechargerCibles, resolveTarget } from "./agent";
import { clampTimeoutS, runAutomationCore, slugAuto } from "./automatisation";
import { frameSig } from "./image";
import {
  actCore,
  chatElementCap,
  grab,
  launchCore,
  listWindowsCore,
  observeCore,
  readTextCore,
  runCommandCore,
  saveFrame,
  waitCore,
  windowActionCore,
} from "./outils";
import type { OptionsAttente } from "./outils";
import { err, servicesOutilsBureau } from "./ports";
import { sequencePy } from "./session";

/** Plafond d'exécution de `desktop_run_automation` côté client (`_RUN_AUTOMATION_TOOL_CEILING_S`). */
export const RUN_AUTOMATION_TOOL_CEILING_S = 3700;
/** Budget de toute la matrice, sous le plafond (`_RUN_AUTOMATION_BUDGET_S`). */
export const RUN_AUTOMATION_BUDGET_S = 3600;
/** Taille lue au plus d'un script de la sandbox (`max_bytes=4 << 20`). */
const SCRIPT_SANDBOX_MAX = 4 << 20;

/** `desktop_session` : santé de l'agent de la cible active (`ping`), ou cibles permises au compte (`list`). */
export async function desktopSession(username: string, a: { action?: string } = {}): Promise<Dict> {
  const action = lowerPy(stripPy(a.action || "ping"));
  rechargerCibles();
  if (action === "list") {
    const cibles = await allowedTargets(getDesktopTargets(false), username);
    const listees = cibles.map((t) => ({ name: t.name, os: t.os, default: t.default }));
    return listees.length > 0 ? ok({ targets: listees, count: listees.length }) : noTargetErr();
  }
  const cible = await resolveTarget("", username);
  if (!cible) return noTargetErr();
  const sante = await agentReq(cible, "/health", null, "GET", 8);
  if (veritePy(getPy(sante, "error")))
    return err("agent_down", `'${cible.name}' did not answer`, {
      target: cible.name,
      detail: getPy(sante, "message"),
    });
  return ok({ target: cible.name, healthy: true, agent: sante });
}

/** `desktop_screenshot` (exposé sur DESKTOP_EXPOSE_RAW_TOOLS) : capture brute sous un jeton de trame, sans analyse. */
export async function desktopScreenshot(username: string): Promise<Dict> {
  const cible = await resolveTarget("", username);
  if (!cible) return noTargetErr();
  const g = await grab(cible);
  if (!Array.isArray(g)) return g;
  const [png, w, h] = g;
  const jeton = await saveFrame(png, username);
  return ok({ target: cible.name, img_w: w, img_h: h, frame_token: jeton, sig: await frameSig(png) });
}

export type ArgsObserve = {
  prompt?: string;
  use_vision?: boolean;
  use_tree?: boolean;
  max_elements?: number;
  scope?: string;
};

/** `desktop_observe` : `max_elements` négatif (défaut -1) = plafond du chemin chat de la configuration. */
export async function desktopObserve(username: string, a: ArgsObserve = {}): Promise<Dict> {
  const max = a.max_elements ?? -1;
  return observeCore(username, "", {
    prompt: a.prompt ?? "",
    use_vision: a.use_vision ?? true,
    use_tree: a.use_tree ?? true,
    max_elements: max < 0 ? chatElementCap() : max,
    scope: a.scope ?? "",
  });
}

/** `desktop_inspect` (exposé sur DESKTOP_EXPOSE_RAW_TOOLS) : arbre a11y brut de la cible active. */
export async function desktopInspect(username: string, a: { max_nodes?: number } = {}): Promise<Dict> {
  const cible = await resolveTarget("", username);
  if (!cible) return noTargetErr();
  const arbre = await agentReq(cible, "/ui_tree", { max_nodes: intPy(ou(a.max_nodes, 300)) });
  if (veritePy(getPy(arbre, "error"))) return arbre;
  const elements = ou(getPy(arbre, "elements"), []);
  return ok({
    target: cible.name,
    count: sequencePy(elements).n,
    elements,
    width: getPy(arbre, "width"),
    height: getPy(arbre, "height"),
  });
}

/** `desktop_read` : OCR du texte affiché (zone, élément observé, requête ou plein écran). */
export async function desktopRead(
  username: string,
  a: { query?: string; element_id?: string; region?: number[] | null } = {},
): Promise<Dict> {
  return readTextCore(username, "", a.query ?? "", a.element_id ?? "", a.region ?? null);
}

/** `desktop_clipboard` : lit (`get`, défaut) ou pose (`set`) le presse-papiers de la cible active. */
export async function desktopClipboard(
  username: string,
  a: { action?: string; text?: string } = {},
): Promise<Dict> {
  const cible = await resolveTarget("", username);
  if (!cible) return noTargetErr();
  const action = lowerPy(stripPy(a.action || "get"));
  const texte = a.text ?? "";
  if (action === "set") {
    const r = await agentReq(cible, "/clipboard_set", { text: texte });
    if (veritePy(getPy(r, "error"))) return r;
    return ok({ target: cible.name, chars: longueurPy(texte) });
  }
  const r = await agentReq(cible, "/clipboard_get", {});
  if (veritePy(getPy(r, "error"))) return r;
  const lu = getPy(r, "text", "");
  return ok({ target: cible.name, text: lu, chars: sequencePy(lu).n });
}

export type ArgsAct = {
  op: string;
  element_id?: string;
  query?: string;
  x?: number | null;
  y?: number | null;
  x2?: number | null;
  y2?: number | null;
  text?: string;
  keys?: string;
  button?: string;
  clicks?: number;
  dy?: number;
  modifiers?: string;
  settle_ms?: number;
  observe_after?: boolean;
};

/** `desktop_act` : chemin chat d'`act_core` (clic sémantique re-résolu, écran frais rendu si `observe_after`). */
export async function desktopAct(username: string, a: ArgsAct): Promise<Dict> {
  const observer = a.observe_after ?? true;
  return actCore(username, "", {
    op: a.op,
    element_id: a.element_id ?? "",
    query: a.query ?? "",
    x: a.x ?? null,
    y: a.y ?? null,
    x2: a.x2 ?? null,
    y2: a.y2 ?? null,
    text: a.text ?? "",
    keys: a.keys ?? "",
    button: a.button ?? "left",
    clicks: a.clicks ?? 1,
    dy: a.dy ?? 0,
    modifiers: a.modifiers ?? "",
    settle_ms: a.settle_ms ?? 1000,
    observe_after: observer,
    semantic_click: true,
    return_elements: observer,
  });
}

/** `desktop_wait` : attente d'une condition d'UI ; le battement de l'appel long est à la charge de l'hôte. */
export async function desktopWait(username: string, a: OptionsAttente = {}): Promise<Dict> {
  return waitCore(username, "", a);
}

/** `desktop_launch` : lance une application (noms amicaux résolus sous Windows) et attend sa fenêtre. */
export async function desktopLaunch(
  username: string,
  a: { app: string; args?: string; timeout_ms?: number },
): Promise<Dict> {
  return launchCore(username, "", { app: a.app, args: a.args ?? "", timeout_ms: a.timeout_ms ?? 15000 });
}

export type ArgsRunAutomation = {
  name: string;
  code?: string;
  targets?: string;
  dry_run?: boolean;
  trace?: boolean;
  timeout_s?: number;
};

/** `desktop_run_automation` : script fourni ou lu dans la sandbox, cibles séparées par des virgules (aucune : la cible active, écart au Python qui ne lançait rien), budget par cible ramené sous le plafond de l'outil. */
export async function desktopRunAutomation(username: string, a: ArgsRunAutomation): Promise<Dict> {
  const services = servicesOutilsBureau();
  let src = strPy(ou(a.code, ""));
  if (!stripPy(src)) src = await lireScript(username, a.name);
  if (!stripPy(src))
    return err(
      "no_code",
      `script vide : passe \`\`code\`\` ou enregistre automations/${slugAuto(a.name)}.py dans la sandbox`,
    );
  let cibles = strPy(ou(a.targets, ""))
    .split(",")
    .map((t) => stripPy(t))
    .filter((t) => t);
  if (cibles.length === 0) {
    const active = await resolveTarget("", username);
    if (!active) return noTargetErr();
    cibles = [active.name];
  }
  let uid: number | null;
  try {
    uid = services === null ? null : await services.idCompte(username);
  } catch {
    uid = null;
  }
  let parCible = clampTimeoutS(a.timeout_s ?? 600);
  const tient = Math.max(30, Math.floor(RUN_AUTOMATION_BUDGET_S / Math.max(1, cibles.length)));
  let note = "";
  if (parCible > tient) {
    note =
      `budget par cible ramené de ${parCible} s à ${tient} s ` +
      `(plafond de l'outil ${RUN_AUTOMATION_BUDGET_S} s pour ${cibles.length} cible(s))`;
    parCible = tient;
  }
  const doc = await runAutomationCore(username, cibles, a.name, src, {
    dry_run: veritePy(a.dry_run ?? false),
    trace: veritePy(a.trace ?? false),
    timeout_s: parCible,
    notify_user_id: uid,
    notifier:
      services === null
        ? null
        : (u, titre, corps) => services.notifier({ user_id: u, username }, titre, corps),
    total_budget_s: RUN_AUTOMATION_BUDGET_S,
  });
  if (note) doc["note"] = note;
  return doc;
}

/** `_load_sandbox_automation` : `automations/<slug>.py` de la sandbox du compte, `""` sur tout échec. */
async function lireScript(username: string, nom: string): Promise<string> {
  const services = servicesOutilsBureau();
  if (services === null) return "";
  try {
    return await services.lireSandbox(username, `automations/${slugAuto(nom)}.py`, SCRIPT_SANDBOX_MAX);
  } catch {
    return "";
  }
}

export type ArgsShell = {
  command: string;
  shell?: string;
  cwd?: string;
  timeout_sec?: number;
  max_output?: number;
};

/** `desktop_shell` (masqué par DESKTOP_DISABLE_SHELL) : commande sur la cible active, sans isolation. */
export async function desktopShell(username: string, a: ArgsShell): Promise<Dict> {
  return runCommandCore(username, "", {
    command: a.command,
    shell: a.shell ?? "powershell",
    cwd: a.cwd ?? "",
    timeout_sec: a.timeout_sec ?? 120,
    max_output: a.max_output ?? 20000,
  });
}

/** `desktop_windows` : fenêtres ouvertes de la cible active. */
export async function desktopWindows(username: string): Promise<Dict> {
  return listWindowsCore(username, "");
}

/** `desktop_focus` : agit sur une fenêtre de `desktop_windows` (activate par défaut). */
export async function desktopFocus(
  username: string,
  a: { action?: string; window_id?: string } = {},
): Promise<Dict> {
  return windowActionCore(username, "", a.action ?? "activate", a.window_id ?? "");
}

/** Politique d'un outil (`meta.policy` et annotations de `tool_kw_openworld`/`tool_kw_mutating`) ; `battement` : `Heartbeat(ctx)` pendant l'appel. */
export type OutilDesktop = {
  nom: string;
  lecture: boolean;
  delaiS: number | null;
  battement: boolean;
  exposition: "toujours" | "shell" | "brut";
  gerer: (username: string, args: Dict) => Promise<Dict>;
};

const outil = (
  nom: string,
  lecture: boolean,
  gerer: (username: string, args: never) => Promise<Dict>,
  o: Partial<Pick<OutilDesktop, "delaiS" | "battement" | "exposition">> = {},
): OutilDesktop => ({
  nom,
  lecture,
  delaiS: o.delaiS ?? null,
  battement: o.battement ?? false,
  exposition: o.exposition ?? "toujours",
  gerer: gerer as (username: string, args: Dict) => Promise<Dict>,
});

/** Outils `desktop_*` dans l'ordre d'inscription de `register()` ; l'hôte n'y accède que par les deux fonctions d'exposition. */
const OUTILS_DESKTOP: readonly OutilDesktop[] = [
  outil("desktop_session", true, desktopSession),
  outil("desktop_observe", true, desktopObserve),
  outil("desktop_read", true, desktopRead),
  outil("desktop_clipboard", false, desktopClipboard),
  outil("desktop_act", false, desktopAct),
  outil("desktop_wait", true, desktopWait, { battement: true }),
  outil("desktop_launch", false, desktopLaunch),
  outil("desktop_run_automation", false, desktopRunAutomation, { delaiS: RUN_AUTOMATION_TOOL_CEILING_S }),
  outil("desktop_shell", false, desktopShell, { delaiS: 610, exposition: "shell" }),
  outil("desktop_windows", true, desktopWindows),
  outil("desktop_focus", false, desktopFocus),
  outil("desktop_screenshot", true, desktopScreenshot, { exposition: "brut" }),
  outil("desktop_inspect", true, desktopInspect, { exposition: "brut" }),
];

/** `CATEGORY` de desktop_tools : famille, libellé, icône et couleur du panneau d'outils (`meta.category`). */
export const CATEGORIE_DESKTOP = {
  name: "desktop",
  label: "Contrôle d'écran",
  icon: "ph-desktop",
  color: "teal",
};

/** Annotations MCP : `tool_kw_openworld(read_only=True)` en lecture, `tool_kw_mutating(open_world=True)` sinon. */
export function annotationsDesktop(o: OutilDesktop): Dict {
  return { readOnlyHint: o.lecture, destructiveHint: false, idempotentHint: false, openWorldHint: true };
}

/** `meta.policy` : sériel, élagage `desktop`, non rejouable ; `timeout_s` flottant comme `with_policy`. */
export function politiqueDesktop(o: OutilDesktop): Dict {
  const p: Dict = { serial: true, prune: "desktop", replay_safe: false };
  if (o.delaiS !== null) p["timeout_s"] = new FlottantPy(o.delaiS);
  return p;
}

/** Outils exposés au modèle selon la configuration lue au démarrage (DESKTOP_DISABLE_SHELL, DESKTOP_EXPOSE_RAW_TOOLS). */
export function outilsDesktopExposes(): OutilDesktop[] {
  return OUTILS_DESKTOP.filter(
    (o) =>
      o.exposition === "toujours" ||
      (o.exposition === "shell" && !config.DESKTOP_DISABLE_SHELL) ||
      (o.exposition === "brut" && config.DESKTOP_EXPOSE_RAW_TOOLS),
  );
}

/** Outil exposé de ce nom, sinon `null` : l'hôte inscrit ET répartit les appels par cette fonction seulement (un outil masqué est refusé). */
export function outilDesktopExpose(nom: string): OutilDesktop | null {
  return outilsDesktopExposes().find((o) => o.nom === nom) ?? null;
}
