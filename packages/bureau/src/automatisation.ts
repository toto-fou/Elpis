// SPDX-License-Identifier: MIT
/** packages/bureau/src/automatisation.ts — scripts d'automatisation exécutés SUR la cible : dépôt (script, lib/, assets/), lancement, suivi, fichiers du rapport, matrice multi-cibles notifiée (desktop_tools). */
import {
  arrondiPy,
  copieDict,
  ErreurPython,
  FlottantPy,
  floatPy,
  getPy,
  intPy,
  lowerPy,
  ouPy as ou,
  poserCle,
  prefixePy,
  pyJsonLoads,
  quotePy,
  rstripPy,
  stripPy,
  strPy,
  texteOu,
  veritePy,
  versFlottantPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";

import { agentReq, ok, resolveTargetStrict, unknownTargetErr } from "./agent";
import { b64decodePy } from "./image";
import { sequencePy } from "./session";

/** Modules de la bibliothèque standard de Python 3.13 qu'un slug peut masquer (`sys.stdlib_module_names`, identifiants `[a-z][a-z0-9]*`). */
const MODULES_STDLIB =
  "abc antigravity argparse array ast asyncio atexit base64 bdb binascii bisect builtins bz2 calendar cmath cmd code " +
  "codecs codeop collections colorsys compileall concurrent configparser contextlib contextvars copy copyreg csv " +
  "ctypes curses dataclasses datetime dbm decimal difflib dis doctest email encodings ensurepip enum errno " +
  "faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc genericpath getopt getpass gettext " +
  "glob graphlib grp gzip hashlib heapq hmac html http idlelib imaplib importlib inspect io ipaddress itertools " +
  "json keyword linecache locale logging lzma mailbox marshal math mimetypes mmap modulefinder msvcrt " +
  "multiprocessing netrc nt ntpath nturl2path numbers opcode operator optparse os pathlib pdb pickle pickletools " +
  "pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd pyclbr pydoc pyexpat queue " +
  "quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex " +
  "shutil signal site smtplib socket socketserver sqlite3 ssl stat statistics string stringprep struct " +
  "subprocess symtable sys sysconfig syslog tabnanny tarfile tempfile termios textwrap this threading time " +
  "timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle turtledemo types typing " +
  "unicodedata unittest urllib uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xml xmlrpc " +
  "zipapp zipfile zipimport zlib zoneinfo";
/** Modules que le runtime ou l'agent importe sur la VM, hors bibliothèque standard (`_AGENT_IMPORT_NAMES`). */
const MODULES_AGENT =
  "elpis_auto backends normalize lib server sitecustomize usercustomize numpy mss pyautogui pywinauto comtypes " +
  "fastapi uvicorn starlette pydantic anyio requests httpx psutil win32api win32con win32gui win32ui pythoncom " +
  "pywintypes gi";
const MASQUES: ReadonlySet<string> = new Set([...MODULES_STDLIB.split(" "), ...MODULES_AGENT.split(" ")]);

/** `_slug_auto` : même règle que le Studio (accents repliés, minuscules, `[^a-z0-9]+` → `-`, 60 caractères). */
export function slugAuto(name: unknown): string {
  const s = lowerPy(texteOu(name, "").normalize("NFD").replace(/[̀-ͯ]/g, ""))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || "automatisation";
}

/** `_agent_slug` : suffixé `-script` quand il masquerait un module importé sur la VM (`csv`, `json`, `numpy`…). */
export function agentSlug(name: unknown): string {
  const slug = slugAuto(name);
  return /^[a-z_][a-z0-9_]*$/.test(slug) && MASQUES.has(slug) ? `${slug}-script` : slug;
}

/** `int(v)` toléré (`_int_or`) : absent, vide ou illisible → défaut ; un infini lève comme Python. */
export function intOu(v: unknown, defaut: number): number {
  if (v === null || v === undefined || v === "") return defaut;
  try {
    return intPy(v);
  } catch (e) {
    if (e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError")) return defaut;
    throw e;
  }
}

/** `_clamp_timeout_s` : budget par cible borné [30, 3600], `int(float(v))`, illisible → défaut. */
export function clampTimeoutS(v: unknown, defaut = 600): number {
  let n: number;
  if (v === null || v === undefined || v === "") n = intPy(defaut);
  else
    try {
      n = intPy(floatPy(v));
    } catch (e) {
      if (!(e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError"))) throw e;
      n = intPy(defaut);
    }
  return Math.max(30, Math.min(3600, n));
}

/** `push_automation_core` : dépose le script et ses annexes dans `automations/` ; un dépôt d'annexe refusé est rendu dans `push_errors`. */
export async function pushAutomationCore(
  username: string,
  target: string,
  name: unknown,
  code: unknown,
  libs: Dict = {},
  assets: Dict = {},
): Promise<Dict> {
  const cible = await resolveTargetStrict(target, username);
  if (!cible) return unknownTargetErr(target);
  const slug = agentSlug(name);
  const r = await agentReq(cible, "/put_file", { path: `${slug}.py`, content: texteOu(code, "") });
  if (veritePy(getPy(r, "error"))) return r;
  const erreurs: Dict[] = [];
  const deposer = async (rel: string, charge: Dict): Promise<void> => {
    const pr = await agentReq(cible, "/put_file", charge);
    if (veritePy(getPy(pr, "error")))
      erreurs.push({
        path: rel,
        error: ou(getPy(pr, "error"), "agent_error"),
        message: ou(getPy(pr, "message"), "dépôt refusé"),
      });
  };
  for (const [rel, texte] of Object.entries(libs ?? {}))
    if (typeof texte === "string" && rel.startsWith("lib/") && !rel.includes(".."))
      await deposer(rel, { path: rel, content: texte });
  for (const [rel, b64] of Object.entries(assets ?? {}))
    if (typeof b64 === "string" && rel.startsWith("assets/") && !rel.includes(".."))
      await deposer(rel, { path: rel, content_b64: b64 });
  return ok({ target: cible.name, name: slug, push_errors: erreurs });
}

export type OptionsLancementScript = {
  dry_run?: unknown;
  trace?: unknown;
  repeat?: unknown;
  args?: readonly unknown[];
  elpis_url?: string;
  elpis_token?: string;
};

/** `start_automation_core` : lance le script déposé ; l'URL et le jeton de vision ne partent que vers l'agent. */
export async function startAutomationCore(
  username: string,
  target: string,
  name: unknown,
  o: OptionsLancementScript = {},
): Promise<Dict> {
  const cible = await resolveTargetStrict(target, username);
  if (!cible) return unknownTargetErr(target);
  const corps: Dict = {
    name: agentSlug(name),
    dry_run: veritePy(o.dry_run),
    trace: veritePy(o.trace),
    repeat: intPy(ou(o.repeat, 0)),
    args: [...(o.args ?? [])],
  };
  if (o.elpis_url) corps["elpis_url"] = o.elpis_url;
  if (o.elpis_token) corps["elpis_token"] = o.elpis_token;
  const r = await agentReq(cible, "/run_script", corps);
  if (veritePy(getPy(r, "error"))) return r;
  return ok({ target: cible.name, run_id: getPy(r, "run_id"), name: corps["name"] });
}

/** `json.loads(b64decode(x).decode("utf-8"))`, `null` sur toute erreur. */
function rapportJson(b64: unknown): unknown {
  try {
    if (typeof b64 !== "string") return null;
    return pyJsonLoads(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b64decodePy(b64)));
  } catch {
    return null;
  }
}

/** `automation_status_core` : état d'une exécution ; finie, son `rapport.json` est joint (`report`). */
export async function automationStatusCore(
  username: string,
  target: string,
  runId: unknown,
  avecRapport = true,
): Promise<Dict> {
  const cible = await resolveTargetStrict(target, username);
  if (!cible) return unknownTargetErr(target);
  const r = await agentReq(cible, `/run_status?run_id=${quotePy(strPy(runId))}&log_tail=80`, null, "GET");
  if (veritePy(getPy(r, "error"))) return r;
  const sortie = copieDict(r);
  poserCle(sortie, "target", cible.name);
  if (avecRapport && !veritePy(getPy(r, "running")) && veritePy(getPy(r, "report_dir"))) {
    const chemin = `${rstripPy(strPy(r["report_dir"]), "/")}/rapport.json`;
    const f = await agentReq(cible, `/get_file?path=${quotePy(chemin)}`, null, "GET");
    if (veritePy(getPy(f, "content_b64"))) poserCle(sortie, "report", rapportJson(f["content_b64"]));
  }
  return sortie;
}

/** `automation_file_core` : un fichier du rapport sur la cible (`content_b64`). */
export async function automationFileCore(username: string, target: string, chemin: unknown): Promise<Dict> {
  const cible = await resolveTargetStrict(target, username);
  if (!cible) return unknownTargetErr(target);
  return agentReq(cible, `/get_file?path=${quotePy(strPy(chemin))}`, null, "GET");
}

/** Horloge et sommeil de la matrice (secondes) ; remplaçables par les tests. */
export const HORLOGE_AUTOMATISATION = {
  maintenant: (): number => Date.now() / 1000,
  dormir: (s: number): Promise<void> => new Promise((fin) => setTimeout(fin, s * 1000)),
};

/** Sondages d'état ratés à la suite avant d'abandonner le suivi d'une cible. */
export const STATUS_ERRORS_MAX = 8;

/** Notification de fin de matrice (`create_notification`) ; absente, rien n'est notifié. */
export type NotifierAutomatisation = (uid: number, titre: string, corps: string) => Promise<void>;

export type OptionsMatrice = {
  dry_run?: unknown;
  trace?: unknown;
  timeout_s?: unknown;
  libs?: Dict;
  assets?: Dict;
  poll_s?: number;
  notify_user_id?: number | null;
  notifier?: NotifierAutomatisation | null;
  elpis_url?: string;
  elpis_token?: string;
  total_budget_s?: number | null;
};

/** `x == 0` de Python (`0`, `0.0`, `False`). */
function egalZero(v: unknown): boolean {
  if (v instanceof FlottantPy) return v.valeur === 0;
  return v === 0 || v === false || v === 0n;
}

/** `run_automation_core` : le même script sur N cibles en séquence, jusqu'au bout (borne par cible après le dépôt) ; résultats agrégés, notification. */
export async function runAutomationCore(
  username: string,
  targets: readonly unknown[],
  name: unknown,
  code: unknown,
  o: OptionsMatrice = {},
): Promise<Dict> {
  const h = HORLOGE_AUTOMATISATION;
  const delai = clampTimeoutS(o.timeout_s ?? 600);
  const sondage = o.poll_s ?? 1.5;
  const budget = o.total_budget_s ?? null;
  const t0 = h.maintenant();
  const resultats: Dict[] = [];
  for (const target of targets.filter((t) => stripPy(texteOu(t, "")))) {
    const nom = target as string;
    const debut = h.maintenant();
    if (budget !== null && debut - t0 >= budget) {
      resultats.push({
        target,
        ok: false,
        error: "skipped",
        message: `plafond de la matrice atteint (${Math.trunc(budget)} s)`,
      });
      continue;
    }
    const p = await pushAutomationCore(username, nom, name, code, o.libs, o.assets);
    if (veritePy(getPy(p, "error"))) {
      resultats.push({ target, ok: false, error: getPy(p, "error"), message: getPy(p, "message") });
      continue;
    }
    const st = await startAutomationCore(username, nom, name, {
      dry_run: o.dry_run,
      trace: o.trace,
      elpis_url: o.elpis_url ?? "",
      elpis_token: o.elpis_token ?? "",
    });
    if (veritePy(getPy(st, "error"))) {
      resultats.push({
        target,
        ok: false,
        error: getPy(st, "error"),
        message: getPy(st, "message"),
        push_errors: ou(getPy(p, "push_errors"), []),
      });
      continue;
    }
    const runId = getPy(st, "run_id");
    const lance = h.maintenant();
    let echeance = lance + delai;
    if (budget !== null) echeance = Math.min(echeance, t0 + budget);
    let dernier: Dict = {};
    let derniereErreur: Dict = {};
    let erreurs = 0;
    let arret = "";
    for (;;) {
      if (h.maintenant() >= echeance) {
        arret = "timeout";
        break;
      }
      const cur = await automationStatusCore(username, nom, runId);
      if (veritePy(getPy(cur, "error"))) {
        erreurs += 1;
        derniereErreur = cur;
        if (getPy(cur, "status") === 404 || erreurs >= STATUS_ERRORS_MAX) {
          arret = "status_lost";
          break;
        }
        await h.dormir(Math.min(15.0, sondage * 2 ** (erreurs - 1)));
        continue;
      }
      erreurs = 0;
      dernier = cur;
      if (!veritePy(getPy(cur, "running"))) break;
      await h.dormir(sondage);
    }
    if (arret) {
      const cible = await resolveTargetStrict(nom, username);
      if (cible) await agentReq(cible, "/run_stop", { run_id: runId });
      dernier =
        arret === "timeout"
          ? {
              error: "timeout",
              message: `exécution interrompue après ${Math.trunc(echeance - lance)} s`,
              running: false,
            }
          : {
              error: "status_lost",
              running: false,
              message:
                "suivi perdu (" +
                strPy(
                  ou(ou(getPy(derniereErreur, "message"), getPy(derniereErreur, "error")), "état inconnu"),
                ) +
                ") — exécution arrêtée",
            };
    }
    const rep = ou(getPy(dernier, "report"), {});
    resultats.push({
      target,
      run_id: runId,
      ok: egalZero(getPy(dernier, "code")),
      code: getPy(dernier, "code"),
      summary: ou(ou(ou(getPy(rep, "summary"), getPy(dernier, "summary")), getPy(dernier, "message")), ""),
      steps_ok: getPy(rep, "ok"),
      steps_failed: getPy(rep, "failed"),
      healed: sequencePy(ou(getPy(rep, "healed"), [])).n,
      report_dir: getPy(dernier, "report_dir", ""),
      duration_s: versFlottantPy(arrondiPy(h.maintenant() - debut, 1)),
      error: getPy(dernier, "error"),
      push_errors: ou(getPy(p, "push_errors"), []),
    });
  }
  const reussies = resultats.filter((r) => veritePy(r["ok"])).length;
  const doc = ok({
    name: agentSlug(name),
    targets: resultats.length,
    ok_count: reussies,
    results: resultats,
    timeout_s: delai,
    summary: `${reussies}/${resultats.length} cible(s) réussie(s)`,
  });
  const notifier = o.notifier;
  if (veritePy(o.notify_user_id) && notifier)
    await (async () => {
      const corps = resultats
        .map(
          (r) =>
            `${strPy(r["target"])} : ${veritePy(r["ok"]) ? "OK" : "ÉCHEC"} — ` +
            strPy(ou(ou(r["summary"], r["message"]), "")),
        )
        .join("\n");
      await notifier(
        intPy(o.notify_user_id),
        `Automatisation « ${agentSlug(name)} » : ${strPy(doc["summary"])}`,
        prefixePy(corps, 4000),
      );
    })().catch(() => undefined);
  return doc;
}
