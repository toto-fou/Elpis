// elpis-remote — remonte et pilote les sessions opencode depuis l'app Elpis.
// SPDX-License-Identifier: MIT
// TypeScript NATIF : opencode (Bun) charge les plugins `*.{ts,js}` sans build.
// Install : ~/.config/opencode/plugin/elpis-remote.ts  (fait par install.sh, ou :
//   curl -fsSLk <app>/api/code/plugin.ts -o ~/.config/opencode/plugin/elpis-remote.ts)
// Dans opencode :
//   /remote login     appaire ce poste (code court validé dans la page « Code »)
//   /remote <jeton>   appairage direct, par jeton collé
//   /remote update    met à jour CE plugin depuis l'app (puis relancez opencode)
//   /remote           active (idempotent)  /remote off      coupe ce projet
//   /remote status    état courant du projet
//
// ── Questions de l'outil `question` (v14) ────────────────────────────────────
// `question.asked/replied/rejected` sont remontés comme les permissions, et la
// page répond via le kind "question" du pull (cf. answerQuestion). Sans ça, une
// question posée par le modèle bloquait le tour SANS rien montrer à distance.
//
// ── Portée des réglages (v11) ────────────────────────────────────────────────
// `enabled` est PAR PROCESS opencode (slot réservé par pid, cf. RemoteConf) :
// deux opencode ouverts côte à côte sont indépendants, MÊME dans le même
// dossier. Le jeton et la cible restent partagés — un appairage par machine.
//
// ── Budget perf (raison d'être de la v9) ─────────────────────────────────────
// Le plugin doit coûter ZÉRO quand il ne fait rien :
//   • aucun patch permanent de process.stdout/stderr — le filtre anti-dump
//     n'est armé que quelques secondes autour d'une commande /remote (v8 le
//     laissait à demeure : chaque frame du TUI payait un decode UTF-8 + scan) ;
//   • le hook `event` n'attend JAMAIS le réseau (v8 bloquait le bus d'events
//     d'opencode sur le POST /ingest) — l'ordre reste garanti par la chaîne ;
//   • handlers de signaux installés au premier start(), pas au chargement ;
//   • remote inactif ⇒ hooks à sortie immédiate, aucun timer, aucun fetch.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const APP_DEFAULT = "__APP_URL__";
// Version du plugin (envoyée à chaque ingest) : l'app compare à sa version
// courante et propose la MAJ (/remote update, qui écrase ce fichier).
const PLUGIN_VERSION = 15;
const CONF_PATH = path.join(os.homedir(), ".config", "opencode", "elpis-remote.json");
const FORWARD = new Set<string>([
  "session.created", "session.updated", "session.deleted", "session.idle", "session.error",
  "message.updated", "message.part.updated", "message.removed",
  "permission.updated", "permission.asked", "permission.replied",
  // Questions de l'outil `question` (v14) : BLOQUANTES côté CLI — le tour
  // attend la réponse. Sans remontée, la page voyait une session « occupée »
  // sans fin et rien à faire. Shapes 1.18.16 (lues dans le binaire) :
  //   asked    {id "que_…", sessionID, questions[{question, header,
  //             options[{label, description}], multiple?, custom?}], tool?}
  //   replied  {sessionID, requestID, answers: string[][]}
  //   rejected {sessionID, requestID}
  "question.asked", "question.replied", "question.rejected",
]);

// ── Types (surface opencode réellement utilisée — le SDK complet n'est pas
//    importable : le plugin doit rester un fichier autonome sans node_modules).
type Dict = Record<string, any>;
// ── Portée des réglages : MACHINE vs INSTANCE ────────────────────────────────
// `elpis-remote.json` est UNIQUE par utilisateur, mais plusieurs opencode
// tournent en parallèle (un par projet). Deux portées, à ne pas confondre :
//   • MACHINE  (app_url, token, ca_file, insecure) — la cible et son TLS sont
//     les mêmes pour tous les process : partagés, c'est voulu ;
//   • INSTANCE (enabled) — « cette session-là remonte-t-elle ? » est un choix
//     PAR PROCESS opencode (v11 ; v10 le faisait par RÉPERTOIRE, ce qui
//     couplait encore deux opencode ouverts sur le même dossier). En v9 c'était
//     un flag GLOBAL : `/remote off` dans un projet coupait la reprise auto de
//     tous les autres, et n'importe quel saveConf réécrivait le fichier depuis
//     un `conf` en mémoire périmé (le jeton que l'autre process venait
//     d'appairer était écrasé).
//
// Clé d'instance = SLOT réservé au démarrage : `<répertoire>` pour le premier
// opencode d'un dossier, `<répertoire>#2`, `#3`… pour les suivants. Le slot est
// réservé par pid, et un slot dont le pid est mort est REPRIS — c'est ce qui
// garde la reprise auto d'un redémarrage tout en rendant indépendants deux
// opencode lancés dans le MÊME dossier.
interface InstanceConf {
  enabled?: boolean;
  seen?: number;       // dernier démarrage (ms) — sert à borner la map
  pid?: number;        // process qui OCCUPE ce slot (0 = libéré proprement)
  dir?: string;        // répertoire du slot — lisibilité du fichier
}
interface RemoteConf {
  app_url?: string;
  token?: string;
  ca_file?: string;    // CA locale (Caddy) épinglée par l'installeur — app en https
  insecure?: boolean;  // cert https invérifiable : TLS non vérifié (mémorisé)
  instances?: Record<string, InstanceConf>;
  // LEGACY (≤ v9) : flag global. Plus jamais écrit ; sert encore de défaut aux
  // répertoires sans entrée `instances` — une mise à jour du plugin ne doit pas
  // débrancher en silence un poste dont la reprise auto marchait.
  enabled?: boolean;
}
interface SessionRef { path: { id: string } }
interface ModelRef { providerID: string; modelID: string }
interface OcClient {
  session: {
    get(a: SessionRef): Promise<{ data?: Dict }>;
    messages(a: SessionRef): Promise<{ data?: Dict[] }>;
    create(a: { body: Dict }): Promise<{ data?: Dict }>;
    delete(a: SessionRef): Promise<unknown>;
    update(a: SessionRef & { body: Dict }): Promise<unknown>;
    promptAsync(a: SessionRef & { body: Dict }): Promise<unknown>;
    command(a: SessionRef & { body: Dict }): Promise<unknown>;
    abort(a: SessionRef): Promise<unknown>;
    revert(a: SessionRef & { body: Dict }): Promise<unknown>;
    unrevert(a: SessionRef): Promise<unknown>;
    summarize(a: SessionRef & { body: ModelRef }): Promise<unknown>;
    share(a: SessionRef): Promise<{ data?: Dict }>;
    unshare(a: SessionRef): Promise<unknown>;
    init(a: SessionRef & { body: Dict }): Promise<unknown>;
  };
  // Surface RÉELLE de l'API TUI : append-prompt, clear-prompt, submit-prompt,
  // open-help, open-models, open-sessions, open-themes, execute-command,
  // show-toast, publish, **select-session**.
  // ⚠ CORRECTION v13 : les versions précédentes affirmaient qu'aucune API ne
  // permettait de cibler une session par id — c'est FAUX, `tui.selectSession`
  // (POST /tui/select-session {sessionID}) figure dans l'OpenAPI de 1.17.7 comme
  // de 1.18.16. C'est cette croyance qui rendait « Nouvelle session » inutile.
  // On n'expose ici que ce qu'on utilise VRAIMENT.
  // `executeCommand` est délibérément absent — mesuré inerte (cf. tuiCommand),
  // le déclarer inviterait à le réutiliser.
  tui: {
    showToast(a: { body: Dict }): Promise<unknown>;
    publish(a: { body: Dict }): Promise<unknown>;
    // `selectSession` EXISTE (operationId tui.selectSession, POST
    // /tui/select-session {sessionID}) — vérifié sur l'OpenAPI de 1.17.7 ET
    // 1.18.16. Optionnel : sans TUI au bout (serve), l'appel échoue et l'appelant
    // se rabat proprement.
    selectSession?(a: { body: { sessionID: string } }): Promise<unknown>;
  };
  command: { list(): Promise<{ data?: Dict[] }> };
  config?: { providers?: () => Promise<{ data?: Dict }> };
  // Agents (build / plan / agents personnalisés) — présent depuis 1.17 au moins
  // (GET /agent, operationId app.agents). Optionnel : un binaire plus ancien
  // n'expose rien et la page se contente de masquer le sélecteur.
  app?: { agents?: () => Promise<{ data?: Dict[] }> };
  postSessionIdPermissionsPermissionId(a: { path: { id: string; permissionID: string }; body: Dict }): Promise<unknown>;
  // Questions (outil `question`) — ⚠ ABSENT du SDK v1 reçu par les plugins de
  // 1.17.7 ET 1.18.16 (classe générée : session/tui/command/config/app/… et
  // postSessionIdPermissionsPermissionId, mais AUCUNE ressource `question`),
  // alors que le serveur expose bien POST /question/{requestID}/reply|reject.
  // Déclaré optionnel pour un SDK futur ; le chemin réel passe par `_client`.
  question?: {
    reply?(a: Dict): Promise<unknown>;
    reject?(a: Dict): Promise<unknown>;
  };
  // Client HTTP interne (hey-api) que TOUTES les méthodes générées utilisent :
  // `post({url, path, body})` substitue `{requestID}` depuis `path`. C'est le
  // seul chemin qui marche AUSSI quand opencode tourne sans port (le client est
  // alors câblé sur le fetch in-process de l'app Hono) — un fetch brut sur
  // serverUrl ne le serait pas.
  _client?: { post?(a: Dict): Promise<unknown> };
}
interface PluginInput { client: OcClient; directory: string; serverUrl?: URL | string }
interface PullCommand {
  id: string; sid: string; kind: string;
  text?: string; model?: ModelRef; command?: string; arguments?: string;
  action?: string; title?: string; permissionID?: string; response?: string; target?: string;
  agent?: string;
  // kind "question" (v14) : réponse à l'outil `question` depuis la page —
  // `answers` = un tableau de libellés PAR question (ordre des questions),
  // ou `response: "reject"` pour refuser (le tour reprend sans réponse).
  questionID?: string; answers?: string[][];
}
type ToastVariant = "info" | "success" | "warning" | "error";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));


// #region conf-store — EXTRAIT TEL QUEL par les tests (test_opencode_plugin_files.py)
// Tout ce qui touche à elpis-remote.json vit ici, en fonctions PURES du reste du
// plugin : c'est la seule partie qui a une sémantique multi-process, donc la
// seule qu'on veut pouvoir exécuter en isolation. Ne rien y référencer du corps
// du plugin (client opencode, toasts, état de session).

// Nb max d'entrées `instances` conservées (les plus récemment vues gagnent) :
// sans borne, un utilisateur qui ouvre opencode dans beaucoup de dossiers fait
// grossir le fichier indéfiniment.
const MAX_INSTANCES = 50;

const loadConf = (): RemoteConf => {
  try { return (JSON.parse(fs.readFileSync(CONF_PATH, "utf8")) as RemoteConf) || {}; }
  catch { return {}; }
};
// Nb max de slots par répertoire (= opencode simultanés sur un même dossier).
const MAX_SLOTS_PER_DIR = 8;

// Un pid est-il encore vivant ? `kill(pid, 0)` ne tue rien : il teste l'existence.
const pidAlive = (pid?: number): boolean => {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// Borne la map aux MAX_INSTANCES entrées les plus récentes — SANS jamais jeter
// un slot occupé par un process vivant (ce serait libérer le slot de quelqu'un).
const trimInstances = (c: RemoteConf): void => {
  const inst = c.instances;
  if (!inst) return;
  const keys = Object.keys(inst);
  if (keys.length <= MAX_INSTANCES) return;
  const dead = keys.filter((k) => !pidAlive(inst[k]?.pid));
  dead.sort((a, b) => (inst[b]?.seen || 0) - (inst[a]?.seen || 0));
  const excess = keys.length - MAX_INSTANCES;
  for (const k of dead.slice(Math.max(0, dead.length - excess))) delete inst[k];
};
// ── Écriture CONCURRENTE-SÛRE ────────────────────────────────────────────────
// N process opencode partagent ce fichier. Un `write(conf-en-mémoire)` naïf perd
// les champs qu'un AUTRE process vient d'écrire (token fraîchement appairé,
// bascule insecure, enabled d'un autre projet). On relit donc le disque, on
// n'applique QUE la mutation demandée, et on remplace par rename (atomique :
// jamais de fichier à moitié écrit lu par un voisin). Le tmp porte le pid pour
// que deux écrivains simultanés ne se disputent pas le même fichier temporaire.
const mutateConf = (fn: (c: RemoteConf) => void): RemoteConf => {
  const fresh = loadConf();
  try { fn(fresh); } catch { /* mutation best-effort */ }
  trimInstances(fresh);
  const tmp = CONF_PATH + "." + process.pid + ".tmp";
  try {
    fs.mkdirSync(path.dirname(CONF_PATH), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(fresh, null, 2));
    fs.renameSync(tmp, CONF_PATH);
  } catch {
    try { fs.rmSync(tmp); } catch { /* déjà absent */ }
  }
  return fresh;
};

const dirKey = (directory: string): string => (directory || "").trim() || "(default)";
const slotKey = (dir: string, n: number): string => (n === 1 ? dir : dir + "#" + n);

// Réserve un slot pour CE process. Prend le premier slot du répertoire qui est
// libre OU dont l'occupant est mort (reprise après redémarrage → l'état
// `enabled` de ce slot est conservé). Deux opencode vivants dans le même
// dossier obtiennent donc deux slots distincts, et deviennent indépendants.
const claimInstanceSlot = (directory: string): string => {
  const dir = dirKey(directory);
  let key = dir;
  // mutateConf n'est PAS un verrou inter-process : deux démarrages simultanés
  // peuvent viser le même slot. On relit donc après écriture et on retente —
  // le perdant prend le suivant. Au pire (rafale improbable) on partage un slot,
  // c'est-à-dire le comportement d'avant, jamais pire.
  for (let attempt = 0; attempt < 3; attempt++) {
    mutateConf((c) => {
      const inst = (c.instances = c.instances || {});
      for (let n = 1; n <= MAX_SLOTS_PER_DIR; n++) {
        const k = slotKey(dir, n);
        const e = inst[k];
        if (!e || !pidAlive(e.pid)) {
          key = k;
          inst[k] = { ...(e || {}), pid: process.pid, dir, seen: Date.now() };
          return;
        }
      }
      key = dir;                      // saturé : on retombe sur le 1er slot
      inst[key] = { ...(inst[key] || {}), seen: Date.now() };
    });
    const owner = loadConf().instances?.[key]?.pid;
    if (!owner || owner === process.pid) return key;
  }
  return key;
};

// Réglage `enabled` d'UN slot.
const instanceEnabled = (c: RemoteConf, key: string): boolean => {
  const e = c.instances && c.instances[key] ? c.instances[key].enabled : undefined;
  if (e !== undefined) return !!e;
  // Slot jamais réglé : seul le PREMIER slot d'un répertoire hérite du flag
  // global legacy (≤ v9) — c'est la migration. Un slot supplémentaire, lui,
  // correspond à un 2e opencode ouvert en parallèle : il démarre ÉTEINT, sinon
  // on recréerait le couplage qu'on vient précisément de casser.
  return key.indexOf("#") >= 0 ? false : !!c.enabled;
};

// Libère le slot (sortie propre) sans toucher au réglage `enabled` : le
// prochain démarrage dans ce dossier le reprendra et gardera son état.
const releaseInstanceSlot = (key: string): void => {
  mutateConf((c) => {
    const e = c.instances && c.instances[key];
    if (e && e.pid === process.pid) e.pid = 0;
  });
};

// Écrit une entrée d'instance SANS toucher au reste : les autres projets et les
// champs machine (jeton, TLS) sont relus du disque et préservés.
const writeInstance = (key: string, patch: InstanceConf): void => {
  mutateConf((c) => {
    const inst = (c.instances = c.instances || {});
    inst[key] = { ...(inst[key] || {}), ...patch, seen: Date.now() };
  });
};
// #endregion conf-store

// ── Annulation silencieuse du tour /remote ───────────────────────────────────
// /remote est une commande de CONTRÔLE : on throw ce marqueur dans le hook pour
// annuler le tour AVANT toute création de message (aucune requête au modèle —
// le TUI lance les commandes en fire-and-forget et ignore l'échec ; seul le
// logError serveur partirait sur stderr et corromprait l'écran). Le filtre qui
// avale ce dump n'est armé QUE pendant une courte fenêtre autour du throw, puis
// les write/console d'origine sont RESTAURÉS — coût nul hors fenêtre. Un dump
// retardataire après la fenêtre serait purement cosmétique (le TUI redessine).
const ABORT_MARK = "elpis-remote:silent-abort";
const FILTER_WINDOW_MS = 4000;
type WriteFn = (chunk: any, ...rest: any[]) => boolean;
let filterTimer: ReturnType<typeof setTimeout> | null = null;
let savedWrites: Array<[NodeJS.WriteStream, WriteFn]> | null = null;
let savedConsole: Array<[string, (...a: any[]) => void]> | null = null;

const disarmSilentFilter = (): void => {
  if (filterTimer) { clearTimeout(filterTimer); filterTimer = null; }
  if (savedWrites) { for (const [stream, fn] of savedWrites) stream.write = fn; savedWrites = null; }
  if (savedConsole) { for (const [m, fn] of savedConsole) (console as Dict)[m] = fn; savedConsole = null; }
};

const armSilentFilter = (): void => {
  if (filterTimer) clearTimeout(filterTimer);
  filterTimer = setTimeout(disarmSilentFilter, FILTER_WINDOW_MS);
  if (savedWrites) return;   // déjà armé — fenêtre juste prolongée
  // 1) flux bruts (Node-style)
  savedWrites = [];
  for (const stream of [process.stderr, process.stdout]) {
    const raw = stream.write.bind(stream) as WriteFn;
    savedWrites.push([stream, stream.write]);
    stream.write = ((chunk: any, ...rest: any[]) => {
      try {
        const s = typeof chunk === "string" ? chunk : (chunk && chunk.toString ? chunk.toString("utf8") : "");
        if (s.includes(ABORT_MARK)) {
          const cb = rest.find((a) => typeof a === "function");
          if (cb) cb();
          return true;
        }
      } catch { /* on laisse passer */ }
      return raw(chunk, ...rest);
    }) as WriteFn;
  }
  // 2) console.* — sous Bun, console écrit en natif SANS passer par
  //    process.stderr.write ; le logger par défaut d'Effect (celui du dump)
  //    passe par ici.
  const txt = (a: unknown): string => {
    try {
      if (typeof a === "string") return a;
      if (a instanceof Error) return String(a.message || "") + " " + String(a.stack || "");
      const B = (globalThis as Dict).Bun;
      return B && B.inspect ? B.inspect(a) : (JSON.stringify(a) || "");
    } catch { return ""; }
  };
  savedConsole = [];
  for (const m of ["error", "warn", "log", "info", "debug"]) {
    const orig = (console as Dict)[m];
    if (typeof orig !== "function") continue;
    const bound = orig.bind(console);
    savedConsole.push([m, orig]);
    (console as Dict)[m] = (...args: unknown[]) => {
      try { if (args.some((a) => txt(a).includes(ABORT_MARK))) return; } catch { /* ignore */ }
      bound(...args);
    };
  }
};

const abortTurn = (): never => {
  armSilentFilter();
  const e = new Error(ABORT_MARK);
  e.stack = "";
  throw e;
};

export const ElpisRemote = async ({ client, directory, serverUrl }: PluginInput) => {
  const cid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const conf = loadConf();
  if (!conf.app_url) conf.app_url = APP_DEFAULT;

  const instKey = claimInstanceSlot(directory);
  const persistEnabled = (v: boolean): void => writeInstance(instKey, { enabled: v });
  // Champ machine (token / bascule insecure) : écrit à la source ET reflété
  // dans le `conf` local pour que les appels en cours en profitent tout de suite.
  const persistShared = (fn: (c: RemoteConf) => void): void => {
    fn(conf);
    mutateConf(fn);
  };

  let enabled = false;
  let pollCtl: AbortController | null = null;   // AbortController du long-poll en cours
  let chain: Promise<unknown> = Promise.resolve(); // sérialise les pushes (ordre garanti)
  let warnedDown = false;
  let tokenWarned = false;     // 401 du pull : prévenir UNE fois puis backoff
  let updateNagged = false;    // version plus récente côté app : proposer /remote update UNE fois
  let insecureWarned = false;  // bascule TLS non vérifié : prévenir UNE fois
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const retryTimers: Array<ReturnType<typeof setTimeout>> = []; // pushCommandsSoon — annulés au stop
  const snapshotted = new Set<string>();
  const pending = new Map<string, Dict>();   // sid|mid|pid -> part (coalescing du streaming)

  const appBase = () => (conf.app_url || APP_DEFAULT).replace(/\/+$/, "");
  const isHttps = () => appBase().startsWith("https://");

  // ── TLS : app derrière Caddy https (CA locale auto-signée) ────────────────
  // Bun accepte l'option non-standard `tls` sur fetch : CA épinglée si
  // l'installeur l'a posée (conf.ca_file), sinon repli non-vérifié mémorisé
  // (conf.insecure). En http, aucune option — chemin d'avant inchangé.
  let caData: string | null = null;
  try { if (conf.ca_file) caData = fs.readFileSync(conf.ca_file, "utf8"); } catch { caData = null; }
  const tlsOpts = (): Dict | null => {
    if (!isHttps()) return null;
    if (caData) return { ca: caData };
    if (conf.insecure) return { rejectUnauthorized: false };
    return null;
  };
  const looksLikeTlsError = (e: unknown): boolean =>
    /certificat|certificate|CERT_|self.?signed|UNABLE_TO_VERIFY|TLS|SSL/i.test(String((e as Dict)?.message || e || ""));

  const doFetch = (route: string, opts: Dict, tls: Dict | null): Promise<Response> =>
    fetch(appBase() + route, {
      ...opts,
      headers: { "content-type": "application/json", "x-elpis-token": conf.token || "", ...(opts.headers || {}) },
      ...(tls ? { tls } : {}),
    } as RequestInit);
  const api = async (route: string, opts: Dict = {}): Promise<Response> => {
    try {
      return await doFetch(route, opts, tlsOpts());
    } catch (e) {
      // 1er échec TLS sur cert invérifiable (pas de CA épinglée) : on retente
      // en non-vérifié ; si ça passe, on MÉMORISE — l'app est LAN, auth par
      // jeton, cert auto-signé par design (deploy/caddy).
      if (isHttps() && !caData && !conf.insecure && looksLikeTlsError(e)) {
        const r = await doFetch(route, opts, { rejectUnauthorized: false });
        persistShared((c) => { c.insecure = true; });
        if (!insecureWarned) {
          insecureWarned = true;
          toast("Certificat de l'app non vérifiable — TLS non vérifié. Relancez l'installeur OpenCode pour épingler la CA locale.", "warning");
        }
        return r;
      }
      throw e;
    }
  };
  // ── Piloter le TUI ────────────────────────────────────────────────────────
  // MESURÉ sur opencode 1.17.7 (plugin sonde dans un vrai TUI, écran rendu avec
  // un émulateur) :
  //   • `tui.selectSession` N'EXISTE PAS — et aucune API ne permet de pointer
  //     une session par id ;
  //   • `/tui/execute-command` répond `200 {data:true}` pour N'IMPORTE QUOI,
  //     y compris une commande inventée, et ne fait RIEN. Sa valeur de retour
  //     ne prouve donc jamais un succès ;
  //   • `/tui/publish` avec l'enveloppe `{type:"tui.command.execute"}` agit
  //     réellement (vérifié : `session.list` ouvre le dialogue, `prompt.clear`
  //     vide le prompt).
  // Les identifiants sont POINTÉS (`session.new`) : `session_new` est la clé du
  // KEYBIND, pas le nom de la commande — c'est ce qui a fait échouer /new.
  // Enum officiel : session.list/new/share/interrupt/compact, session.page.*,
  // session.first/last, prompt.clear/submit, agent.cycle. Aucune commande de
  // SORTIE n'existe : /exit passe forcément par un signal (cf. kind "exit").
  const tuiCommand = async (command: string): Promise<void> => {
    try {
      await client.tui.publish({
        body: { type: "tui.command.execute", properties: { command } },
      });
    } catch { /* serve/headless : aucun TUI au bout */ }
  };

  const toast = async (message: string, variant: ToastVariant = "info"): Promise<void> => {
    try { await client.tui.showToast({ body: { title: "Elpis Remote", message, variant, duration: 6000 } }); } catch { /* serve/headless */ }
  };
  const enqueue = (job: () => Promise<unknown>): Promise<unknown> => { chain = chain.then(job, job); return chain; };

  const pushBatch = async (events: Dict[]): Promise<boolean> => {
    if (!events.length) return false;
    try {
      const r = await api("/api/code/ingest", {
        method: "POST",
        body: JSON.stringify({ client: cid, directory, plugin: PLUGIN_VERSION, events }),
      });
      if (r.ok) { warnedDown = false; return true; }
      if (r.status === 401 && !warnedDown) { warnedDown = true; toast("Jeton refusé par l'app — tapez /remote login pour ré-appairer.", "error"); }
    } catch {
      if (!warnedDown) { warnedDown = true; toast("App injoignable (" + appBase() + ") — remontée en pause.", "warning"); }
    }
    return false;
  };

  const flushParts = (): void => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!pending.size) return;
    const evs = [...pending.values()].map((part) => ({ type: "message.part.updated", properties: { part } }));
    pending.clear();
    enqueue(() => pushBatch(evs));
  };

  // Pousse l'état complet d'une session (info + messages) — rattrapage d'historique.
  //
  // ⚠ Une session VIDE est publiée elle aussi (v13). La v12 la retenait pour
  // éviter des entrées fantômes au redémarrage (« ça me crée deux sessions »),
  // mais l'effet de bord était pire : une session fraîche restait invisible dans
  // la page alors que la CLI s'affichait connectée, jusqu'au premier message.
  // Le fantôme est désormais traité à la SOURCE côté app (au plus une session
  // vide par CLI, cf. _code_store.apply_events), là où on a la vue d'ensemble —
  // le plugin, lui, dit simplement la vérité sur ce qui existe.
  const snapshot = (sid: string): Promise<unknown> => {
    if (!sid) return Promise.resolve();
    snapshotted.add(sid);
    return enqueue(async () => {
      try {
        const [s, m] = await Promise.all([
          client.session.get({ path: { id: sid } }),
          client.session.messages({ path: { id: sid } }),
        ]);
        const msgs = (m && m.data) || [];
        if (!s || !s.data) { snapshotted.delete(sid); return; }
        await pushBatch([{ type: "session.snapshot", properties: { session: s.data, messages: msgs } }]);
      } catch {
        // Échec transitoire : sans ce retrait, la session restait marquée
        // « snapshottée » et n'était JAMAIS republiée de tout le run.
        snapshotted.delete(sid);
      }
    });
  };

  // La session EXISTE-t-elle côté opencode ? (sans rien publier)
  // ⚠ Ce n'est pas une question rhétorique : `input.sessionID` est fourni par le
  // TUI même quand opencode n'a encore rien matérialisé — un `session.get` sur
  // un TUI fraîchement ouvert échoue. C'est la différence entre « rien à
  // publier » et « publication ratée », et les messages de /remote en dépendent.
  const sessionExists = async (sid: string): Promise<boolean> => {
    if (!sid) return false;
    try {
      const s = await client.session.get({ path: { id: sid } });
      return !!(s && s.data);
    } catch { return false; }
  };

  const hello = async (): Promise<{ user?: string; error?: string }> => {
    try {
      const r = await api("/api/code/hello");
      if (r.ok) return await r.json();
      return { error: r.status === 401 ? "jeton invalide" : "HTTP " + r.status };
    } catch { return { error: "app injoignable (" + appBase() + ")" }; }
  };

  let commandsPushed = false;   // livraison garantie : retenté à chaque cycle de pull
  const pushCommands = (): Promise<unknown> => enqueue(async () => {
    // Liste des slash commands → autocomplétion « / » de la page Remote code.
    // /remote exclue : la lancer depuis la page couperait la remontée.
    if (commandsPushed || !enabled) return;
    try {
      const r = await client.command.list();
      const commands = ((r && r.data) || [])
        .filter((c) => c && c.name && c.name !== "remote")
        .map((c) => ({
          name: c.name,
          description: c.description || "",
          agent: c.agent || "",
          model: c.model || "",
          // la commande accepte des arguments si son template les référence
          has_args: /\$ARGUMENTS/.test(c.template || ""),
        }));
      if (!commands.length) return;   // pas prêt (init) — on retentera au prochain pull
      commandsPushed = await pushBatch([{ type: "client.commands", properties: { commands } }]);
    } catch { /* CLI pas prête */ }
  });
  let modelsPushed = false;               // même stratégie de livraison que les commandes
  let knownModels: Set<string> | null = null;   // "providerID/modelID" — garde-fou avant promptAsync
  let defaultModels: Record<string, string> = {};  // providerID -> modelID (config/providers .default)
  const pushModels = (): Promise<unknown> => enqueue(async () => {
    // Modèles d'inférence dispo côté CLI (config/providers = providers
    // réellement configurés) → sélecteur /model de la page.
    if (modelsPushed || !enabled) return;
    try {
      if (!(client.config && client.config.providers)) return;
      const r = await client.config.providers();
      const provs = (r && r.data && r.data.providers) || [];
      const providers = (provs as Dict[]).map((p) => {
        let models = p && p.models;
        if (models && !Array.isArray(models)) models = Object.values(models);
        return {
          id: (p && p.id) || "",
          name: (p && p.name) || (p && p.id) || "",
          models: ((models as Dict[]) || []).filter((m) => m && m.id)
            .map((m) => {
              const o: Dict = { id: m.id, name: m.name || m.id };
              // fenêtre de contexte → jauge ctx de la page (plugin v5)
              if (m.limit && typeof m.limit === "object" && (m.limit.context || m.limit.output))
                o.limit = { context: m.limit.context || 0, output: m.limit.output || 0 };
              return o;
            }),
        };
      }).filter((p) => p.id && p.models.length);
      if (!providers.length) return;  // pas prêt — retenté au prochain pull
      knownModels = new Set();
      for (const p of providers) for (const m of p.models) knownModels.add(p.id + "/" + m.id);
      defaultModels = ((r as Dict).data && (r as Dict).data.default) || {};
      modelsPushed = await pushBatch([{ type: "client.models",
        properties: { providers, default: defaultModels } }]);
    } catch { /* CLI pas prête */ }
  });

  let agentsPushed = false;               // même stratégie de livraison que les commandes
  let knownAgents: Set<string> | null = null;   // garde-fou avant promptAsync
  const pushAgents = (): Promise<unknown> => enqueue(async () => {
    // Agents PRIMAIRES d'opencode = les « modes » du TUI (touche tab) :
    // `build` (édite) et `plan` (lecture seule), plus les agents primaires
    // définis par l'utilisateur. On écarte :
    //   • mode "subagent" (explore/general) — invocables par le modèle, pas des
    //     modes de conversation ;
    //   • `hidden` (title/summary/compaction) — agents internes d'opencode, les
    //     proposer n'aurait aucun sens.
    // C'est exactement le filtre du TUI (prompt/autocomplete.tsx).
    if (agentsPushed || !enabled) return;
    try {
      if (!(client.app && client.app.agents)) return;   // binaire trop ancien
      const r = await client.app.agents();
      const all = (r && r.data) || [];
      const agents = (all as Dict[])
        .filter((a) => a && a.name && a.mode === "primary" && !a.hidden)
        .map((a) => ({ name: String(a.name), description: String(a.description || "") }));
      if (!agents.length) return;   // pas prêt — retenté au prochain pull
      knownAgents = new Set(agents.map((a) => a.name));
      // défaut = celui du TUI : `build` s'il existe, sinon le premier primaire
      const def = knownAgents.has("build") ? "build" : agents[0].name;
      agentsPushed = await pushBatch([{ type: "client.agents",
        properties: { agents, default: def } }]);
    } catch { /* CLI pas prête */ }
  });

  // ── Actions natives (kind "action" du pull) : endpoints session opencode ──
  const lastModelOf = async (sid: string, role?: string): Promise<ModelRef | null> => {
    // modèle du dernier message (assistant de préférence) — requis par
    // summarize/init ; fallback = modèle par défaut de la config.
    try {
      const r = await client.session.messages({ path: { id: sid } });
      const msgs = (r && r.data) || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const info = msgs[i] && msgs[i].info;
        if (!info || (role && info.role !== role)) continue;
        if (info.providerID && info.modelID) return { providerID: info.providerID, modelID: info.modelID };
      }
    } catch { /* session illisible */ }
    const pid = Object.keys(defaultModels || {})[0];
    return pid ? { providerID: pid, modelID: defaultModels[pid] } : null;
  };
  const runAction = async (sid: string, action: string): Promise<void> => {
    const ref: SessionRef = { path: { id: sid } };
    try {
      if (action === "undo") {
        // parité TUI : annule le dernier message USER (et la réponse qui suit)
        const r = await client.session.messages(ref);
        const msgs = (r && r.data) || [];
        let target: string | null = null;
        for (let i = msgs.length - 1; i >= 0; i--) {
          const info = msgs[i] && msgs[i].info;
          if (info && info.role === "user") { target = info.id; break; }
        }
        if (!target) return toast("Rien à annuler dans cette session.", "warning");
        await client.session.revert({ ...ref, body: { messageID: target } });
        toast("Dernier échange annulé (/undo, depuis la page Remote code).", "info");
      } else if (action === "redo") {
        await client.session.unrevert(ref);
        toast("Annulation rétablie (/redo, depuis la page Remote code).", "info");
      } else if (action === "compact") {
        const m = await lastModelOf(sid, "assistant");
        if (!m) return toast("Impossible de résumer : aucun modèle connu.", "error");
        await client.session.summarize({ ...ref, body: m });
        toast("Compactage de la session lancé (/compact, depuis la page Remote code).", "info");
      } else if (action === "share") {
        const r = await client.session.share(ref);
        const url = r && r.data && r.data.share && r.data.share.url;
        toast(url ? "Session partagée : " + url : "Session partagée.", "success");
      } else if (action === "unshare") {
        await client.session.unshare(ref);
        toast("Partage de la session désactivé.", "info");
      } else if (action === "init") {
        const r = await client.session.messages(ref);
        const msgs = (r && r.data) || [];
        const last = msgs.length ? ((msgs[msgs.length - 1] || {}).info || {}).id : null;
        const m = await lastModelOf(sid);
        if (!last || !m) return toast("Impossible de lancer /init (session vide ?).", "error");
        await client.session.init({ ...ref, body: { messageID: last, providerID: m.providerID, modelID: m.modelID } });
        toast("Analyse du projet lancée (/init → AGENTS.md).", "info");
      } else if (action === "new") {
        // Seule action SANS session (sid vide, commande ciblée client).
        //
        // ⚠ MESURÉ (1.17.7 ET 1.18.16) : `session.new` du TUI ne matérialise
        // RIEN — pas de `session.created`, rien dans `session.list` tant qu'un
        // message n'a pas été envoyé. La v7 se contentait donc de ce raccourci,
        // et la page restait désespérément vide : « CLI connectée » d'un côté,
        // aucune session de l'autre.
        //
        // v13 : on crée la session POUR DE VRAI (elle existe, donc elle est
        // publiable), puis on y bascule le TUI. `tui.selectSession` EXISTE bien
        // (opérationId `tui.selectSession`, vérifié sur l'OpenAPI des deux
        // binaires — le commentaire « aucune API ne cible une session par id »
        // était périmé). Si la bascule échoue (serve/headless), la session reste
        // pilotable depuis la page : on le dit plutôt que d'en créer une 2e.
        let created = "";
        try {
          const r = await client.session.create({ body: {} });
          created = (r && r.data && (r.data as Dict).id) || "";
        } catch { created = ""; }
        if (!created) {
          await tuiCommand("session.new");    // repli : au moins le raccourci local
          toast("Nouvelle session ouverte dans le terminal — elle apparaîtra dans la page à votre premier message.",
                "warning");
          return;
        }
        snapshot(created);                    // visible tout de suite, même vide
        let switched = false;
        try {
          await (client.tui as Dict).selectSession({ body: { sessionID: created } });
          switched = true;
        } catch { switched = false; }
        toast(switched
          ? "Nouvelle session créée et ouverte dans le terminal."
          : "Nouvelle session créée et visible dans la page (le terminal n'a pas pu y basculer).",
          "success");
      } else if (action === "delete") {
        // suppression demandée depuis la page : stoppe la génération éventuelle
        // puis supprime la session opencode — session.deleted nettoie le store.
        try { await client.session.abort(ref); } catch { /* rien en cours */ }
        await client.session.delete(ref);
        toast("Session supprimée depuis la page Remote code.", "info");
      }
    } catch {
      toast("Commande distante /" + action + " en échec.", "error");
    }
  };
  // ── Questions de l'outil `question` (kind "question" du pull, v14) ────────
  // L'outil bloque le tour jusqu'à la réponse : POST /question/{id}/reply
  // {answers: string[][]} ou /reject. Trois chemins, du plus propre au plus
  // brut, parce que le SDK v1 reçu par les plugins n'a PAS de ressource
  // `question` (vérifié dans les binaires 1.17.7 et 1.18.16) :
  //   1. `client.question.reply/reject` — SDK futur (signature plate) ;
  //   2. `client._client.post` — le client HTTP interne des méthodes générées :
  //      passe par le fetch in-process quand opencode n'écoute sur aucun port ;
  //   3. fetch brut sur `serverUrl` (mode serve) — dernier recours.
  // Un client hey-api ne throw PAS sur un HTTP 4xx/5xx : il renvoie {error} —
  // on le traduit en échec, sinon la page croirait la réponse livrée.
  const failedHttp = (r: unknown): boolean => {
    const d = r as Dict;
    if (!d || typeof d !== "object") return false;
    if (d.error) return true;
    return !!(d.response && typeof d.response === "object" && d.response.ok === false);
  };
  const answerQuestion = async (requestID: string, answers: string[][] | null): Promise<void> => {
    const verb = answers ? "reply" : "reject";
    const q = client.question;
    if (q && typeof q[verb] === "function") {
      const r = await q[verb]!(answers ? { requestID, answers } : { requestID });
      if (failedHttp(r)) throw new Error("question." + verb + " refusé");
      return;
    }
    const route = "/question/{requestID}/" + verb;
    const raw = client._client;
    if (raw && typeof raw.post === "function") {
      const r = await raw.post({
        url: route, path: { requestID },
        ...(answers ? { body: { answers } } : {}),
        headers: { "Content-Type": "application/json" },
      });
      if (failedHttp(r)) throw new Error("question." + verb + " refusé");
      return;
    }
    if (!serverUrl) throw new Error("aucun client opencode capable de répondre");
    const base = String(serverUrl).replace(/\/+$/, "");
    const r = await fetch(base + route.replace("{requestID}", encodeURIComponent(requestID)), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(answers ? { answers } : {}),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
  };
  // au démarrage, command.list() peut répondre vide (init en cours) → retries
  // courts, puis filet de sécurité à chaque cycle de pull (voir poll()).
  // Timers suivis et annulés au stop() : aucun réveil si le remote est coupé.
  const pushCommandsSoon = (): void => {
    pushCommands(); pushModels(); pushAgents();
    for (const ms of [2000, 6000]) {
      const t = setTimeout(() => { pushCommands(); pushModels(); pushAgents(); }, ms);
      retryTimers.push(t);
    }
  };
  const clearRetryTimers = (): void => {
    for (const t of retryTimers) clearTimeout(t);
    retryTimers.length = 0;
  };

  // ── Déconnexion propre à la fermeture d'opencode ──────────────────────────
  // Le hook `dispose` n'est PAS invoqué en mode serve sur SIGINT/SIGTERM
  // (vérifié binaire 1.17.7, qui n'installe AUCUN handler de signal) → on
  // écoute les signaux nous-mêmes — installés PARESSEUSEMENT au premier
  // start() : un plugin jamais activé ne touche pas au process. Un fetch async
  // ne survivrait pas à l'arrêt : curl DÉTACHÉ (fire-and-forget) ; s'il manque
  // (rare), le filet reste le TTL de 40 s côté app.
  let byeSent = false;
  const sendByeDetached = (): void => {
    if (byeSent || !enabled || !conf.token) return;
    byeSent = true;
    try {
      const args = ["-s", "-m", "2", "-X", "POST"];
      if (isHttps()) {
        // Même échelle de confiance que tlsOpts() : CA épinglée d'abord ; « -k »
        // UNIQUEMENT si on a déjà constaté que le certificat est invérifiable.
        // Sans cette condition on désactivait la vérification même quand la CA
        // est dans le magasin système — curl aurait très bien validé.
        if (conf.ca_file) args.push("--cacert", conf.ca_file);
        else if (conf.insecure) args.push("-k");
      }
      args.push(appBase() + "/api/code/bye",
        "-H", "content-type: application/json",
        "-H", "x-elpis-token: " + conf.token,
        "-d", JSON.stringify({ client: cid }));
      spawn("curl", args, { detached: true, stdio: "ignore" }).unref();
    } catch { /* curl absent — filet TTL */ }
  };
  // ── Le signal peut être ABSORBÉ — ne jamais mentir sur son état ────────────
  // Un Ctrl-C sur le TUI ne se termine pas toujours par une sortie : selon le
  // mode du terminal, opentui reçoit la TOUCHE (raw mode) ou le process reçoit
  // le SIGNAL, et son propre gestionnaire natif peut l'absorber sans quitter.
  // La v11 annonçait alors notre mort à l'app (`bye`) puis continuait à tourner :
  // la page affichait « déconnecté » pendant que la CLI se croyait active, et
  // tout ce qu'on envoyait depuis la page tombait dans le vide — le « remote
  // reste actif mais session inaccessible » remonté par les utilisateurs.
  //
  // On garde donc le bye immédiat (badge sans attendre le TTL de 40 s), MAIS on
  // vérifie qu'on est bien morts : encore vivants après SURVIVE_MS ⇒ le signal a
  // été absorbé ⇒ on se ré-annonce et on reprend la remontée. L'état affiché
  // redevient vrai des deux côtés, quel que soit le comportement du terminal.
  //
  // On ne FORCE pas la sortie : `process.exit()` sur un opencode qui a
  // délibérément intercepté le signal tuerait un travail en cours sans le
  // consentement de l'utilisateur. Le contrat reste celui du signal (comportement
  // par défaut reproduit quand personne d'autre n'écoute).
  const SURVIVE_MS = 2500;
  const onFatalSignal = (sig: NodeJS.Signals, self: () => void): void => {
    const wasEnabled = enabled;
    sendByeDetached();
    stop(false);                 // état LOGIQUE cohérent (persist=false : un
                                 // redémarrage doit reprendre le réglage user)
    const t = setTimeout(() => {
      // réarmé en `once` (jamais `on`) : rester listener empêcherait le
      // `listenerCount === 0` du prochain signal, donc le re-raise — opencode
      // ne se fermerait plus JAMAIS par signal.
      try { process.once(sig, self); } catch { /* env exotique */ }
      if (!wasEnabled) return;
      byeSent = false;
      enabled = true;
      announce();                // ingest → revive du tombstone côté app
      poll();
      toast("Signal " + sig + " absorbé par opencode — remote toujours actif.", "warning");
    }, SURVIVE_MS);
    if (typeof (t as Dict).unref === "function") (t as Dict).unref();
    // Plus aucun listener pour ce signal = personne d'autre ne le gère côté
    // opencode → reproduire le comportement par défaut (terminer).
    if (process.listenerCount(sig) === 0) {
      try { process.kill(process.pid, sig); } catch { process.exit(0); }
    }
  };
  const ensureExitHooks = (): void => {
    const g = globalThis as Dict;
    if (g.__elpisRemoteByeHook) return;
    g.__elpisRemoteByeHook = true;
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as NodeJS.Signals[]) {
      // `once` + réarmement dans le garde-fou de survie : pendant qu'on traite
      // le signal on ne doit pas être listener (sinon le re-raise ne fait rien),
      // mais un SECOND Ctrl-C doit rester pris en charge — la v11 ne réarmait
      // jamais et le poste devenait sourd après la première tentative.
      const self = (): void => onFatalSignal(sig, self);
      try { process.once(sig, self); } catch { /* env exotique */ }
    }
    try { process.on("exit", () => sendByeDetached()); } catch { /* idem */ }
  };

  let appEpoch = 0;
  const poll = async (): Promise<void> => {
    while (enabled) {
      try {
        pollCtl = new AbortController();
        const r = await api("/api/code/pull?client=" + cid + "&wait=25", { signal: pollCtl.signal });
        if (r.status === 401) {
          // jeton révoqué/roté : prévenir UNE fois, puis backoff long — PAS de
          // stop : /remote login répare conf.token dans ce même process, et la
          // boucle repart d'elle-même dès que le jeton change (≤ 1 s).
          if (!tokenWarned) {
            tokenWarned = true;
            toast("Jeton refusé par l'app — tapez /remote login pour ré-appairer.", "error");
          }
          const t0 = conf.token;
          for (let i = 0; i < 60 && enabled && conf.token === t0; i++) await sleep(1000);
          continue;
        }
        if (!r.ok) { await sleep(5000); continue; }
        tokenWarned = false;
        const d = await r.json();
        if (d.epoch && d.epoch !== appEpoch) {
          // l'epoch de l'app est persisté (store durable) : il ne change que si
          // sa base a été réinitialisée → re-snapshotter + re-pousser les commandes
          if (appEpoch) {
            snapshotted.clear();
            commandsPushed = false; modelsPushed = false; agentsPushed = false;
          }
          appEpoch = d.epoch;
        }
        if (d.plugin_current && d.plugin_current > PLUGIN_VERSION && !updateNagged) {
          updateNagged = true;
          toast("Plugin elpis-remote v" + d.plugin_current + " disponible — tapez /remote update.", "info");
        }
        if (!commandsPushed) pushCommands();
        if (!modelsPushed) pushModels();
        if (!agentsPushed) pushAgents();
        for (const c of ((d.commands || []) as PullCommand[])) {
          if (c.kind === "prompt" && c.sid && c.text) {
            const body: Dict = { parts: [{ type: "text", text: c.text }] };
            // sélecteur /model de la page : modèle forcé pour ce prompt —
            // VALIDÉ contre config/providers d'abord : un modèle inconnu part
            // en ProviderModelNotFoundError à la génération (et peut tuer le
            // TUI) → on le retire et on prévient, plutôt que de casser.
            if (c.model && c.model.providerID && c.model.modelID) {
              const key = c.model.providerID + "/" + c.model.modelID;
              if (!knownModels || knownModels.has(key)) body.model = c.model;
              else toast("Modèle " + key + " inconnu côté CLI — prompt envoyé avec le modèle par défaut.", "warning");
            }
            // Mode plan / build choisi dans la page. `agent` est accepté par
            // /session/{id}/prompt_async (vérifié sur l'OpenAPI 1.17 ET 1.18) et
            // vaut POUR CE TOUR — c'est ce qui rend le mode pilotable à distance
            // sans toucher au TUI. Validé comme le modèle : un agent inconnu
            // ferait échouer le tour entier.
            if (c.agent) {
              if (!knownAgents || knownAgents.has(c.agent)) body.agent = c.agent;
              else toast("Agent « " + c.agent + " » inconnu côté CLI — prompt envoyé avec l'agent par défaut.", "warning");
            }
            client.session.promptAsync({ path: { id: c.sid }, body })
              .catch(() => toast("Prompt distant refusé (session " + c.sid.slice(0, 12) + "…).", "warning"));
          } else if (c.kind === "command" && c.sid && c.command && c.command !== "remote") {
            // session.command est bloquant (attend la fin du tour) → fire-and-forget
            client.session.command({ path: { id: c.sid }, body: { command: c.command, arguments: c.arguments || "" } })
              .catch(() => toast("Commande /" + c.command + " refusée.", "warning"));
          } else if (c.kind === "action" && c.action && (c.sid || c.action === "new")) {
            // actions natives (undo/redo/compact/share/unshare/init/new) —
            // "new" est la seule action sans session (sid vide, ciblée client)
            runAction(c.sid || "", String(c.action));
          } else if (c.kind === "rename" && c.sid && typeof c.title === "string" && c.title) {
            // renommage depuis la page — session.update émet session.updated (round-trip)
            client.session.update({ path: { id: c.sid }, body: { title: c.title } })
              .catch(() => toast("Renommage refusé (session " + c.sid.slice(0, 12) + "…).", "warning"));
          } else if (c.kind === "permission" && c.sid && c.permissionID && c.response) {
            // réponse à une demande de validation (bannière de la page)
            client.postSessionIdPermissionsPermissionId({
              path: { id: c.sid, permissionID: c.permissionID },
              body: { response: c.response },
            }).catch(() => toast("Réponse de validation refusée par la CLI.", "warning"));
          } else if (c.kind === "question" && c.sid && c.questionID
                     && (Array.isArray(c.answers) || c.response === "reject")) {
            // réponse (ou refus) à une question de l'outil `question`, depuis la
            // page — le tour bloqué côté CLI reprend ; question.replied/rejected
            // remonte par le bus et retire la bannière.
            const answers = Array.isArray(c.answers)
              ? c.answers.map((a) => (Array.isArray(a) ? a.map((x) => String(x)) : [String(a)]))
              : null;
            answerQuestion(String(c.questionID), answers)
              .catch(() => toast("Réponse à la question refusée par la CLI.", "warning"));
          } else if (c.kind === "abort" && c.sid) {
            client.session.abort({ path: { id: c.sid } }).catch(() => { /* déjà finie */ });
          } else if (c.kind === "disconnect") {
            // bouton « Déconnecter » de la page : bye immédiat + reprise auto
            // désactivée POUR CE PROJET seulement — /remote côté CLI pour réactiver.
            toast("Remote déconnecté depuis la page Remote code — /remote pour réactiver.", "info");
            stop();
          } else if (c.kind === "exit") {
            // /exit depuis la page : fermeture de tout le process opencode.
            //
            // ⚠ MESURÉ : l'enum des commandes TUI (session.*, prompt.*,
            // agent.cycle) ne contient AUCUNE commande de sortie — « app_exit »
            // n'existe pas, et /tui/execute-command répond 200 à n'importe quoi
            // sans rien faire. Il n'y a donc pas de « quit » propre à demander
            // au TUI : le seul mécanisme réel est le signal. SIGTERM sur notre
            // propre process = ce que fait un Ctrl-C (opencode déroule ses
            // handlers, restaure le terminal) ; process.exit en dernier filet
            // si un handler intercepte sans quitter.
            toast("Fermeture d'opencode demandée depuis la page Remote code.", "info");
            sendByeDetached();          // badge de la page immédiat, sans TTL
            setTimeout(() => {
              try { process.kill(process.pid, "SIGTERM"); }
              catch { try { process.exit(0); } catch { /* impossible */ } }
              setTimeout(() => { try { process.exit(0); } catch { /* impossible */ } }, 2000);
            }, 300);
          }
        }
      } catch { if (enabled) await sleep(3000); }
    }
  };

  // Ré-annonce : ingest vide qui (re)déclare CE client à l'app — lève un
  // éventuel tombstone `bye`, et repousse commandes + modèles. Extraite de
  // start() parce que la REPRISE AUTO doit la faire aussi : sans elle, un
  // opencode redémarré n'était connu de l'app qu'au premier long-poll, et
  // « /remote on » n'avait plus rien à faire — d'où un message inutile.
  const announce = (): void => {
    commandsPushed = false; modelsPushed = false; agentsPushed = false;
    enqueue(() => api("/api/code/ingest", { method: "POST",
      body: JSON.stringify({ client: cid, directory, plugin: PLUGIN_VERSION, events: [] }) })
      .catch(() => { /* app down — le poll préviendra */ }));
    pushCommandsSoon();
  };

  const start = (): void => {
    if (enabled) return;
    enabled = true;
    byeSent = false;
    tokenWarned = false;
    persistEnabled(true);
    ensureExitHooks();
    snapshotted.clear();
    announce();
    poll();
  };
  // Activation + publication de la session courante. Une session VIDE n'est pas
  // publiée (cf. snapshot) : le message ne doit donc pas promettre qu'elle est
  // visible — elle le sera à son premier message.
  const activate = async (sid: string, who: string): Promise<string> => {
    start();
    // Publier MÊME vide (v13) : « je viens d'activer le remote » et « je ne vois
    // rien dans la page » ne doivent plus coexister.
    // ⚠ Reste un cas irréductible : opencode ne matérialise la session qu'au
    // PREMIER message (mesuré 1.17.7 et 1.18.16 — un TUI fraîchement ouvert n'a
    // aucune session côté serveur). Il n'y a alors rien à publier, et le message
    // doit le dire au lieu de laisser croire à une panne.
    const exists = await sessionExists(sid);
    if (exists) snapshot(sid);
    return "Remote activé (" + who + ")"
      + (exists ? " — session visible dans la page Remote code."
                : " — opencode n'ouvre la session qu'au premier message : elle apparaîtra à ce moment-là.");
  };

  const stop = (persist: boolean = true): void => {
    enabled = false;
    clearRetryTimers();
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    // persist=false : arrêt de process (dispose) — ne pas écraser le réglage user
    if (persist) {
      persistEnabled(false);
      // /remote off : badge « hors ligne » immédiat côté page (pas d'attente TTL)
      try { api("/api/code/bye", { method: "POST", body: JSON.stringify({ client: cid }) }).catch(() => { /* best-effort */ }); } catch { /* idem */ }
    }
    if (pollCtl) { try { pollCtl.abort(); } catch { /* déjà clos */ } pollCtl = null; }
  };

  // Reprise auto : /remote déjà activé pour CE répertoire lors d'un lancement
  // précédent. Un autre projet laissé actif n'entraîne plus celui-ci, et
  // inversement — c'est tout l'intérêt de la clé par instance.
  if (instanceEnabled(conf, instKey) && conf.token) {
    enabled = true; ensureExitHooks(); announce(); poll();
  }
  // (le slot est déjà horodaté/marqué par claimInstanceSlot au démarrage)

  return {
    config: async (input: Dict) => {
      input.command = Object.assign({}, input.command, {
        remote: {
          template: "ELPIS_REMOTE",
          description: "Elpis — publier/piloter cette session depuis l'app (/remote | login | update | off | status)",
        },
      });
    },

    "command.execute.before": async (input: Dict, _output: Dict) => {
      if (input.command !== "remote") return;
      const arg = String(input.arguments || "").trim();
      let msg: string, variant: ToastVariant = "success";
      if (arg.startsWith("pcr_")) {
        persistShared((c) => { c.token = arg; });
        const h = await hello();
        if (h.error) { stop(); msg = "Activation impossible : " + h.error + "."; variant = "error"; }
        else { msg = await activate(input.sessionID, h.user || "ok"); }
      } else if (arg === "login") {
        // Appairage par code (device flow) : start → toast du code → poll du
        // jeton. IIFE fire-and-forget : le hook doit abortTurn() tout de suite.
        const sid0 = input.sessionID;
        (async () => {
          try {
            const r = await api("/api/code/pair/start", { method: "POST" });
            if (!r.ok) {
              toast(r.status === 429 ? "Trop de demandes d'appairage — réessaie dans quelques minutes."
                                     : "Appairage indisponible (HTTP " + r.status + ").", "error");
              return;
            }
            const st = await r.json();
            toast("Code d'appairage : " + st.code + " — saisissez-le dans la page Code (panneau Connecter). Expire dans 5 min.", "info");
            const until = Date.now() + (st.expires_in || 300) * 1000;
            while (Date.now() < until) {
              await sleep((st.interval || 3) * 1000);
              let p: Response;
              try { p = await api("/api/code/pair/poll?id=" + encodeURIComponent(st.id)); } catch { continue; }
              if (p.status === 404) { toast("Code d'appairage expiré — relancez /remote login.", "warning"); return; }
              if (!p.ok) continue;
              const d = await p.json();
              if (d.status === "expired") { toast("Code d'appairage expiré — relancez /remote login.", "warning"); return; }
              if (d.status === "ok" && d.token) {
                persistShared((c) => { c.token = d.token; });
                tokenWarned = false;
                const h = await hello();
                if (h.error) { toast("Appairage validé mais activation impossible : " + h.error + ".", "error"); return; }
                // activate() dit LUI-MÊME si la session a pu être publiée
                // (une session vide ne l'est pas) — on ne le contredit pas.
                const done = await activate(sid0, h.user || "ok");
                toast("Poste appairé. " + done, "success");
                return;
              }
            }
            toast("Code d'appairage expiré — relancez /remote login.", "warning");
          } catch { toast("App injoignable (" + appBase() + ") — appairage abandonné.", "error"); }
        })();
        msg = "Appairage lancé — le code arrive dans une notification."; variant = "info";
      } else if (arg === "update") {
        // Auto-mise à jour : télécharge le plugin TS servi par l'app et se
        // remplace sur disque (elpis-remote.ts) ; purge un éventuel ancien
        // elpis-remote.js (ère pré-TypeScript) pour ne pas charger DEUX
        // plugins au prochain démarrage. Le code déjà chargé reste actif
        // jusqu'au redémarrage d'opencode — pas de hot-reload proprement.
        (async () => {
          try {
            const r = await api("/api/code/plugin.ts");
            if (!r.ok) { toast("Téléchargement du plugin impossible (HTTP " + r.status + ").", "error"); return; }
            const src = await r.text();
            const vm = src.match(/const PLUGIN_VERSION = (\d+)/);
            // garde-fou : ne jamais écraser le fichier avec autre chose qu'un
            // plugin elpis-remote reconnaissable (proxy captif, page d'erreur…)
            if (!src.startsWith("// elpis-remote") || !vm) {
              toast("Réponse inattendue de l'app — plugin NON remplacé.", "error");
              return;
            }
            const nv = parseInt(vm[1], 10);
            if (nv === PLUGIN_VERSION) { toast("Plugin déjà à jour (v" + PLUGIN_VERSION + ").", "info"); return; }
            const pluginDir = path.join(os.homedir(), ".config", "opencode", "plugin");
            const dest = path.join(pluginDir, "elpis-remote.ts");
            fs.mkdirSync(pluginDir, { recursive: true });
            try { fs.copyFileSync(dest, dest + ".bak"); } catch { /* 1re install TS */ }
            fs.writeFileSync(dest, src);
            for (const legacy of ["elpis-remote.js", "elpis-remote.js.bak"]) {
              try { fs.rmSync(path.join(pluginDir, legacy)); } catch { /* absent */ }
            }
            toast("Plugin mis à jour v" + PLUGIN_VERSION + " → v" + nv + " — relancez opencode pour l'appliquer (/exit puis opencode).", "success");
          } catch { toast("App injoignable (" + appBase() + ") — mise à jour abandonnée.", "error"); }
        })();
        msg = "Mise à jour du plugin en cours…"; variant = "info";
      } else if (arg === "off" || arg === "stop") {
        stop(); msg = "Remote désactivé."; variant = "info";
      } else if (arg === "status") {
        // État RÉEL, pas seulement l'état local : « actif » ne veut rien dire si
        // l'app est injoignable ou si le jeton a été roté — c'est précisément le
        // cas où l'utilisateur croyait la remontée en marche. On fait donc un
        // aller-retour /hello, et on l'affiche.
        // `instKey` explicite : avec plusieurs opencode ouverts, savoir DE QUEL
        // projet on parle est la première question qu'on se pose.
        const local = enabled ? "Remote actif" : "Remote inactif";
        let link: string;
        if (!conf.token) link = "non appairé — /remote login";
        else {
          const h = await hello();
          link = h.error ? "app KO : " + h.error : "app OK (" + (h.user || "?") + ") " + appBase();
        }
        msg = local + " · " + link
              + " · projet " + instKey + " · plugin v" + PLUGIN_VERSION + ".";
        variant = enabled && conf.token && !link.startsWith("app KO") ? "success" : "warning";
      } else if (!arg || arg === "on") {
        // `/remote` ACTIVE, il ne bascule pas. En bascule, le cas courant était
        // trompeur : la reprise auto ayant déjà remis `enabled` à true en
        // silence au démarrage, taper /remote pour « activer » répondait
        // « Remote désactivé » — tout en publiant la session (le 1er event
        // déclenche le snapshot). On coupe avec /remote off, explicitement.
        if (enabled) {
          // Déjà actif (typiquement : reprise auto après un redémarrage). On
          // ré-annonce — c'est ce qui rend l'action utile plutôt qu'un simple
          // « déjà actif » — et on republie la session courante, vide ou non :
          // c'est le geste qu'on fait précisément quand la page ne montre pas ce
          // qu'on a sous les yeux.
          announce();
          const exists = await sessionExists(input.sessionID);
          if (exists) snapshot(input.sessionID);
          msg = "Remote actif (" + instKey + ") — CLI ré-annoncée"
              + (exists ? " et session publiée."
                        : " ; opencode n'ouvre la session qu'au premier message.")
              + " /remote off pour couper.";
          variant = "info";
        } else if (!conf.token) { msg = "Poste non appairé — tapez /remote login, puis saisissez le code dans la page Code."; variant = "warning"; }
        else {
          const h = await hello();
          if (h.error) { msg = "Activation impossible : " + h.error + "."; variant = "error"; }
          else { msg = await activate(input.sessionID, h.user || "ok"); }
        }
      } else {
        msg = "Argument inconnu. Usage : /remote [jeton|login|update|on|off|status]"; variant = "warning";
      }
      await toast(msg, variant);
      // Commande de contrôle pure : annule le tour (aucun message, aucune
      // requête modèle). Le filtre anti-dump est armé DANS abortTurn, pour la
      // fenêtre courte qui suit — puis tout est restauré.
      abortTurn();
    },

    event: async ({ event }: { event: Dict }) => {
      // Chemin CHAUD (appelé pour chaque event du bus opencode) : sorties
      // immédiates, jamais d'attente réseau — l'ordre est garanti par `chain`.
      if (!enabled || !event || !FORWARD.has(event.type)) return;
      const props = event.properties || {};
      const sid = props.sessionID
        || (props.info && (props.info.sessionID || props.info.id))
        || (props.part && props.part.sessionID) || "";
      // 1er event d'une session inconnue → snapshot d'abord (historique complet).
      // Une session vide n'est pas publiée (cf. snapshot) ; elle se retire
      // alors de `snapshotted`, donc le message qui suit relance un snapshot
      // complet. Rien de spécial à prévoir pour /new : la session ouverte par
      // le TUI apparaît dans la page dès le premier message.
      if (sid && !snapshotted.has(sid)) snapshot(sid);
      if (event.type === "message.part.updated" && props.part && props.part.id) {
        // Coalescing du streaming : ne garder que la dernière version de chaque part.
        const p = props.part;
        pending.set(p.sessionID + "|" + p.messageID + "|" + p.id, p);
        if (!flushTimer) flushTimer = setTimeout(flushParts, 150);
        return;
      }
      flushParts(); // ordre : vider les parts avant un event structurel
      enqueue(() => pushBatch([{ type: event.type, properties: props }]));
    },

    dispose: async () => {
      disarmSilentFilter();
      flushParts();
      // Slot rendu au pool (le réglage `enabled` du slot, lui, est conservé :
      // le prochain opencode de ce dossier le reprendra tel quel).
      releaseInstanceSlot(instKey);
      const wasEnabled = enabled;
      stop(false);
      await chain.catch(() => { /* dernier push raté — tant pis */ });
      // déconnexion propre : badge « hors ligne » immédiat côté page (le TTL de
      // 40 s reste le filet pour les kill -9). Timeout court : opencode se ferme.
      if (wasEnabled && conf.token && !byeSent) {
        byeSent = true;
        try {
          await api("/api/code/bye", { method: "POST", body: JSON.stringify({ client: cid }),
                                       signal: AbortSignal.timeout(1500) });
        } catch { /* filet TTL */ }
      }
    },
  };
};
export default ElpisRemote;
