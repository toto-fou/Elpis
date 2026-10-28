// SPDX-License-Identifier: MIT
/** apps/core/src/contexte/assemblage.ts — message système de tête byte-stable : socle, runtime_context, manifeste et fragments de capacité ; mémoire AX rendue à part (suffixe de la question). */
import { comparePointsDeCode, estErreurAnnulation, reprPy, stripPy, strPy, veritePy } from "@elpis/commun";
import { config } from "@elpis/config";
import { origineExacte } from "@elpis/securite";

import { journal } from "../journal";
import { categorize } from "../outils/categories";
import { estDict, lire } from "../python";
import type { Dict } from "../python";
import { CTX } from "./config-contexte";
import { sanitizeMessageHistory } from "./elagage";
import { isSummaryCarrier } from "./etat-compression";
import { portMemoireAx, portProfilReseau, portPromptsCapacites } from "./ports";

const log = journal("uvicorn.error");
const SEP = "\n\n---\n\n";

/** État réseau réel du bac à sable du compte ; phrase neutre si la résolution échoue. */
export async function networkStatusLine(username: string): Promise<string> {
  try {
    const { id, mode } = await portProfilReseau().profilReseau(username);
    if (mode === "none") {
      return `  • Network: NONE this session (profile '${id}') — every outbound connection fails (expected, not a bug).`;
    }
    return (
      `  • Network: OPEN via profile '${id}' (mode: ${strPy(mode)}) — a refused connection means that destination is ` +
      "outside the profile, not a tool bug."
    );
  } catch {
    return (
      "  • Network: depends on the sandbox profile; if blocked, outbound connections fail with a connection error " +
      "(expected, not a bug)."
    );
  }
}

/** `str.format(username=…, root=…)` de Python limité aux champs nommés ; tout autre champ lève (le gabarit est alors rendu brut). */
function formatPy(gabarit: string, champs: Readonly<Record<string, string>>): string {
  let out = "";
  for (let i = 0; i < gabarit.length; i++) {
    const c = gabarit[i]!;
    if (c === "{" && gabarit[i + 1] === "{") {
      out += "{";
      i++;
    } else if (c === "}" && gabarit[i + 1] === "}") {
      out += "}";
      i++;
    } else if (c === "}") {
      throw new Error("Single '}' encountered in format string");
    } else if (c === "{") {
      const fin = gabarit.indexOf("}", i);
      if (fin < 0) throw new Error("Single '{' encountered in format string");
      const champ = gabarit.slice(i + 1, fin);
      const [nomConv, spec] = champ.includes(":")
        ? [champ.slice(0, champ.indexOf(":")), champ.slice(champ.indexOf(":") + 1)]
        : [champ, ""];
      const [nom, conv] = nomConv.includes("!") ? nomConv.split("!", 2) : [nomConv, null];
      if (spec || !Object.hasOwn(champs, nom!) || (conv !== null && conv !== "s" && conv !== "r")) {
        throw new Error(`champ de format non pris en charge : ${champ}`);
      }
      out += conv === "r" ? reprPy(champs[nom!]) : champs[nom!];
      i = fin;
    } else out += c;
  }
  return out;
}

/** Puce du bloc SHELL propre au TS, émise seulement quand `shell_job` est offert au tour. */
const LIGNE_COMMANDES_LONGUES = `  • Long commands (tests, builds, servers): shell_job(action="start") returns
    at once and wakes you on exit, a log line or a port; execute_shell(
    on_timeout="detach_and_wake") does the same past its timeout. Do not poll or sleep.
`;

function prefixeSurcharge(): string {
  try {
    return CTX.override("context.sandbox_prefix", "");
  } catch {
    return "";
  }
}

/** Message système `<runtime_context>` du bac à sable (chemins sous /work, git, shell, réseau réel ; puce des commandes longues si `shell_job` est offert) ; `""` sans compte. */
export async function buildRuntimeSandboxContext(
  username: string,
  o: { shellJob?: boolean } = {},
): Promise<string> {
  if (!username) return "";
  const ov = prefixeSurcharge();
  if (ov) {
    try {
      return formatPy(ov, { username, root: username });
    } catch {
      return ov;
    }
  }
  const netLine = await networkStatusLine(username);
  return `<runtime_context>
You operate inside an isolated per-user sandbox (user id: ${username}).

PATHS — every path must resolve under /work (your sandbox root). Relative
paths are preferred; an absolute path under /work is accepted:

  • fs_tools (read_file, write_file, edit_file, list_files, manage_files,
    code): \`path\`.
  • shell tool (execute_shell): \`cwd\` and \`save_stdout\`.

  ✓ path="src/main.py"   path="."   path="tmp/scratch.txt"   path="/work/src/main.py"
  ✗ path="/tmp/foo"   path="/home/x"   path="../up"   (outside /work: refused)

  On "outside sandbox" or "not_found": the path was wrong — rethink it as a
  relative path; do not retry the same absolute path with a small variation.

GIT — a repo is ANY directory in your sandbox containing \`.git/\`:

  \`repo\` = its RELATIVE path from the sandbox root (e.g. "myproject",
  "code/web-app"); \`path\` in git_write / git_query is relative to the REPO
  root. New repos (git_action init/clone, git_clone) are created at the
  sandbox root — there is NO dedicated subfolder.
  Discover existing repos with git_query(action="repos").

SHELL — commands run inside your Docker container:

  • Only your sandbox (mounted at /work) persists: anything written
    elsewhere (/tmp included) is lost when the container is recreated.
    The tools translate relative paths to /work for you.
${netLine}
  • execute_shell goes through \`bash -c\` (all shell metacharacters are
    interpreted). For stdout larger than ~20 KB, use save_stdout=<path>.
${o.shellJob ? LIGNE_COMMANDES_LONGUES : ""}</runtime_context>`;
}

/** Liste explicite des outils appelables cette session, triée et groupée par catégorie ; `""` si aucun. */
export function buildActiveToolsManifest(allowedToolNames: Iterable<unknown>): string {
  const names = [...new Set([...allowedToolNames].map((n) => stripPy(strPy(n))).filter((n) => n))].sort(
    comparePointsDeCode,
  );
  if (!names.length) return "";
  const byCat = new Map<string, string[]>();
  for (const n of names) {
    const cat = categorize(n) || "other";
    byCat.set(cat, [...(byCat.get(cat) ?? []), n]);
  }
  const lines = [
    "# Active tools (this session)",
    "",
    "The tools callable this session are EXACTLY the ones below — a tool absent from this list does not exist " +
      "right now (do not assume or invent one, and do not conclude a capability is missing without checking here " +
      "first).",
    "",
  ];
  for (const cat of [...byCat.keys()].sort(comparePointsDeCode))
    lines.push(`- ${cat}: ${byCat.get(cat)!.join(", ")}`);
  return lines.join("\n");
}

class SautAx extends Error {}

/** Connaissance d'interface des sites connus (mémoire AX), texte du suffixe de la question ; "" sans site ni tête system, best-effort. */
export async function buildAxMemoryBlock(workingMessages: readonly unknown[], owner = ""): Promise<string> {
  try {
    const port = portMemoireAx();
    const recent = workingMessages
      .slice(-6)
      .filter((m) => lire(m, "role") === "user")
      .map((m) => {
        const c = lire(m, "content");
        return typeof c === "string" ? c : "";
      })
      .join("\n");
    const sites = port.detectSitesFromText(recent);
    const sessionUrl = await port.detectSessionUrl(workingMessages, owner);
    let currentSite: string | null = null;
    let currentPath: string | null = null;
    const currentOrigin = sessionUrl ? origineExacte(sessionUrl) : null;
    if (sessionUrl) {
      [currentSite, currentPath] = port.normalizeUrl(sessionUrl);
      if (currentSite && !sites.includes(currentSite)) sites.unshift(currentSite);
    }
    const hasToolHistory = workingMessages.some((m) => {
      const r = lire(m, "role");
      const c = lire(m, "content");
      return (
        (r === "tool" || r === "system") &&
        typeof c === "string" &&
        (c.includes("tool_call") || c.includes("session_id"))
      );
    });
    const iteration = hasToolHistory ? 1 : 0;
    const blocks: string[] = [];
    for (const s of sites) {
      const block = await port.renderSiteContextual(s, {
        currentPath: s === currentSite ? currentPath : null,
        iteration,
        owner,
        origin: s === currentSite ? currentOrigin : null,
      });
      if (block) blocks.push(block);
    }
    if (!blocks.length) return "";
    const header = stripPy(config.SYSTEM_PROMPT_AX_MEMORY_HEADER || "");
    if (!header) {
      log.debug("[ax] header prompt vide/absent → skip injection");
      throw new SautAx();
    }
    if (!workingMessages.some((m) => lire(m, "role") === "system")) return "";
    const axText = `${header}\n\n${blocks.join("\n\n")}`;
    log.info(
      `[ax] ${blocks.length} site(s) for the question suffix (${Array.from(axText).length} chars, ` +
        `mode=${iteration ? "focused" : "full"})${currentPath ? ` (focus on ${currentPath})` : ""}: ${sites.join(", ")}`,
    );
    return axText;
  } catch (e) {
    if (estErreurAnnulation(e)) throw e;
    if (!(e instanceof SautAx)) log.debug(`[ax] inject failed (non-fatal): ${String(e)}`);
    return "";
  }
}

function texteDesParts(c: unknown[]): string {
  return stripPy(
    c
      .filter((b) => estDict(b) && typeof b["text"] === "string")
      .map((b) => (b as Dict)["text"] as string)
      .join(" "),
  );
}

/** Bloc opérationnel fusionné dans le premier message system (porteurs de résumé exclus), sinon inséré en tête ; mute la liste. */
export function foldOperationalBlock(workingMessages: unknown[], opText: string): void {
  const op = stripPy(opText || "");
  if (!op) return;
  const lead: number[] = [];
  for (let i = 0; i < workingMessages.length; i++) {
    if (lire(workingMessages[i], "role") !== "system") break;
    if (!isSummaryCarrier(workingMessages[i])) lead.push(i);
  }
  if (!lead.length) {
    workingMessages.unshift({ role: "system", content: op });
    return;
  }
  const parts: string[] = [];
  for (const i of lead) {
    const c = lire(workingMessages[i], "content");
    if (typeof c === "string" && stripPy(c)) parts.push(stripPy(c));
    else if (Array.isArray(c)) {
      const txt = texteDesParts(c);
      if (txt) parts.push(txt);
    }
  }
  parts.push(op);
  workingMessages[lead[0]!] = { ...(workingMessages[lead[0]!] as Dict), content: parts.join(SEP) };
  for (const i of lead.slice(1).reverse()) workingMessages.splice(i, 1);
}

function contientRuntimeContext(m: unknown): boolean {
  const c = lire(m, "content");
  const contenu = veritePy(c) ? c : "";
  if (typeof contenu === "string") return contenu.includes("<runtime_context>");
  return Array.isArray(contenu) && contenu.includes("<runtime_context>");
}

/** `[working_messages, bloc AX]` du tour : socle par défaut, hygiène, bloc opérationnel (manifeste, runtime_context, fragments) ; AX hors tête. */
export async function assembleOperationalContext(
  messages: readonly unknown[],
  options: { allowedToolNames: Iterable<unknown>; username: string },
): Promise<[unknown[], string]> {
  const allowed = [...options.allowedToolNames];
  const username = options.username;
  const hasSystem = messages.some((m) => lire(m, "role") === "system");
  let working: unknown[] = [];
  const defaultSys = stripPy(config.SYSTEM_PROMPT_DEFAULT || "");
  if (!hasSystem && defaultSys) working.push({ role: "system", content: defaultSys });

  let active: Set<string>;
  try {
    active = new Set(allowed.map((n) => categorize(strPy(n))));
    active.delete("other");
    if (allowed.some((n) => strPy(n).startsWith("rag_"))) active.add("rag");
  } catch {
    active = new Set();
  }
  let wantRuntimeCtx: boolean;
  try {
    wantRuntimeCtx = portPromptsCapacites().capabilityWantsRuntimeContext(active);
  } catch {
    wantRuntimeCtx = true;
  }
  const alreadyHasCtx = messages.some((m) => lire(m, "role") === "system" && contientRuntimeContext(m));
  const shellJob = allowed.some((n) => stripPy(strPy(n)) === "shell_job");
  const runtimeCtx =
    wantRuntimeCtx && !alreadyHasCtx ? await buildRuntimeSandboxContext(username, { shellJob }) : "";

  working.push(...messages);
  working = sanitizeMessageHistory(working);
  const ax = await buildAxMemoryBlock(working, username || "");

  let capBlock: string | null;
  try {
    capBlock = await portPromptsCapacites().buildCapabilityBlock(active);
  } catch {
    capBlock = null;
  }
  let manifest: string;
  try {
    manifest = buildActiveToolsManifest(allowed);
  } catch {
    manifest = "";
  }
  const opParts = [manifest, runtimeCtx, capBlock].filter((p): p is string => veritePy(p));
  if (opParts.length) foldOperationalBlock(working, opParts.join(SEP));
  return [working, ax];
}
