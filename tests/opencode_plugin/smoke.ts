// SPDX-License-Identifier: MIT
// Smoke comportemental du plugin elpis-remote (v11, TypeScript) — sous Bun,
// le runtime réel d'opencode. PAS dans pytest (Bun absent des VM offline) :
//   HOME=$(mktemp -d) bun tests/opencode_plugin/smoke.ts
// (bun via `npm i --no-save bun` ou https://bun.sh ; voir README.md à côté)
//
// Couvre les invariants PERF et protocole (v9 perf, v11 portée/sessions) :
//   1. import + idle  : AUCUN patch stdout/stderr, aucun timer, aucun fetch ;
//   2. /remote <jeton>: hello → start → snapshot poussé à l'ingest ; le tour
//      est annulé par le marqueur (throw), filtre armé PUIS restauré (~4 s) ;
//   3. hook event     : ne bloque JAMAIS sur le réseau (ingest lent ≠ TUI lent) ;
//   4. coalescing     : N updates d'une même part → 1 event dans le lot ;
//   5. pull           : une commande kind=prompt déclenche session.promptAsync ;
//   6. /remote off    : bye POSTé, boucle stoppée ;
//   7. bootstrap      : migre .js → .ts (télécharge, vérifie, s'efface) et
//      délègue au plugin TS ; si le .ts était déjà chargé, s'efface SANS
//      créer de 2e instance ;
//   8. questions (v14): question.asked/replied remontés ; kind=question du
//      pull → POST /question/{id}/reply|reject via le client HTTP INTERNE du
//      SDK (le SDK v1 des plugins n'a pas de ressource `question`), SDK récent
//      (client.question.*) préféré s'il existe, {error} hey-api = échec + toast.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let failures = 0;
const ok = (cond: unknown, label: string) => {
  if (cond) console.log("  ✓ " + label);
  else { failures++; console.error("  ✗ " + label); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Faux serveur app (ingest/pull/hello/plugin.ts) ───────────────────────────
const ingested: any[] = [];
let ingestDelayMs = 0;
let pullCommands: any[] = [];
const byeSeen: any[] = [];
const REPO = path.resolve(import.meta.dir, "../..");
const TS_SRC = fs.readFileSync(path.join(REPO, "shared_infra/opencode/plugin/elpis-remote.ts"), "utf8");
const BOOTSTRAP_SRC = fs.readFileSync(path.join(REPO, "shared_infra/opencode/plugin/elpis-remote-bootstrap.js"), "utf8");
// version courante = celle du .ts (source unique) — plus de littéral à re-figer ici
const PLUGIN_VERSION = Number((TS_SRC.match(/const PLUGIN_VERSION = (\d+)/) || [])[1]);
if (!PLUGIN_VERSION) { console.error("PLUGIN_VERSION introuvable dans le .ts"); process.exit(2); }

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/api/code/hello") return Response.json({ ok: true, user: "smoke" });
    if (u.pathname === "/api/code/ingest") {
      const body = await req.json();
      if (ingestDelayMs) await sleep(ingestDelayMs);
      ingested.push(body);
      return Response.json({ ok: true, applied: (body.events || []).length });
    }
    if (u.pathname === "/api/code/pull") {
      const commands = pullCommands; pullCommands = [];
      if (!commands.length) await sleep(120);   // évite un busy-loop du poll
      return Response.json({ commands, epoch: 42, plugin_current: PLUGIN_VERSION });
    }
    if (u.pathname === "/api/code/bye") { byeSeen.push(await req.json()); return Response.json({ ok: true }); }
    if (u.pathname === "/api/code/plugin.ts")
      return new Response(TS_SRC.replace("__APP_URL__", BASE), { headers: { "content-type": "application/typescript" } });
    return new Response("nf", { status: 404 });
  },
});
const BASE = "http://127.0.0.1:" + server.port;

// ── Faux client opencode ─────────────────────────────────────────────────────
const calls: Record<string, any[]> = {};
const rec = (name: string, ret: any = {}) => (...a: any[]) => {
  (calls[name] ||= []).push(a);
  return Promise.resolve(ret);
};
const fakeClient: any = {
  session: {
    get: rec("session.get", { data: { id: "ses_1", title: "Smoke" } }),
    // v11 : une session SANS message n'est plus publiée (au redémarrage le
    // TUI en ouvre une vide → elle créait une 2e entrée fantôme dans la page).
    // Ce fixture représente donc une vraie session de travail.
    messages: rec("session.messages", { data: [{ info: { id: "msg_1", role: "user", sessionID: "ses_1" }, parts: [] }] }),
    create: rec("session.create", { data: { id: "ses_new" } }),
    delete: rec("session.delete"), update: rec("session.update"),
    promptAsync: rec("session.promptAsync"), command: rec("session.command"),
    abort: rec("session.abort"), revert: rec("session.revert"),
    unrevert: rec("session.unrevert"), summarize: rec("session.summarize"),
    share: rec("session.share", { data: {} }), unshare: rec("session.unshare"),
    init: rec("session.init"),
  },
  tui: {
    // Surface RÉELLE de l'API TUI (SDK 1.17) : ni selectSession, ni
    // executeCommand utilisable (mesuré inerte). Le faux client ne doit pas
    // offrir plus que le vrai, sinon on re-valide un chemin inexistant en
    // production — c'était précisément le bug de /new.
    showToast: rec("tui.showToast"),
    // Le pilotage passe par publish + {type:"tui.command.execute"}.
    publish: rec("tui.publish", { data: true }),
  },
  command: { list: rec("command.list", { data: [{ name: "help", template: "" }] }) },
  config: { providers: rec("config.providers", { data: { providers: [
    { id: "elpis", name: "Elpis", models: [{ id: "m1", name: "M1" }] }], default: { elpis: "m1" } } }) },
  postSessionIdPermissionsPermissionId: rec("permission.reply"),
  // Client HTTP interne du SDK v1 (hey-api) : c'est LUI que le plugin utilise
  // pour /question/{id}/reply|reject, faute de ressource `question` dans le SDK
  // reçu par les plugins (1.17.7 et 1.18.16). Résultat pilotable : un client
  // hey-api ne throw pas sur 4xx, il renvoie {error}.
  _client: { post: (...a: any[]) => { (calls["http.post"] ||= []).push(a); return Promise.resolve(httpPostResult); } },
};
let httpPostResult: any = { data: true, response: { ok: true } };

// ── Charge le plugin comme le ferait opencode (fichier .ts, APP_URL bakée) ──
const home = process.env.HOME || os.homedir();
if (!home.startsWith("/tmp") && !home.includes("smoke")) {
  console.error("Refus : lance avec HOME=$(mktemp -d) pour ne pas toucher ta vraie config.");
  process.exit(2);
}
const stage = path.join(home, "stage");
fs.mkdirSync(stage, { recursive: true });
const pluginPath = path.join(stage, "elpis-remote.ts");
fs.writeFileSync(pluginPath, TS_SRC.replace("__APP_URL__", BASE));

console.log("1. import + repos (aucun effet de bord)");
const w0 = process.stdout.write, e0 = process.stderr.write, c0 = console.error;
const mod = await import(pathToFileURL(pluginPath).href);
const hooks = await mod.ElpisRemote({ client: fakeClient, directory: "/tmp/proj" });
ok(typeof hooks.event === "function" && typeof hooks.dispose === "function", "hooks exportés");
ok(process.stdout.write === w0 && process.stderr.write === e0 && console.error === c0,
   "stdout/stderr/console NON patchés à l'init (coût zéro au repos)");
ok(ingested.length === 0, "aucun fetch au repos");
await hooks.event({ event: { type: "message.updated", properties: { info: { sessionID: "s" } } } });
ok(ingested.length === 0, "event ignoré quand remote inactif");

console.log("2. /remote <jeton> : activation + annulation silencieuse du tour");
let thrown: any = null;
try { await hooks["command.execute.before"]({ command: "remote", arguments: "pcr_smoke", sessionID: "ses_1" }, {}); }
catch (e) { thrown = e; }
ok(thrown && String(thrown.message).includes("elpis-remote:silent-abort"), "tour annulé (marqueur throwé)");
ok(process.stdout.write !== w0, "filtre armé pendant la fenêtre post-/remote");
const swallowed = process.stderr.write("Error: elpis-remote:silent-abort\n" as any);
ok(swallowed === true, "dump contenant le marqueur avalé");
await sleep(600);   // hello + ingest d'annonce + snapshot
const types = ingested.flatMap((b) => (b.events || []).map((e: any) => e.type));
ok(types.includes("session.snapshot"), "snapshot de la session poussé à l'ingest");
ok(ingested.every((b) => b.plugin === PLUGIN_VERSION), "version v" + PLUGIN_VERSION + " déclarée à l'ingest");

console.log("3. hook event non-bloquant (ingest lent ≠ TUI lent)");
ingestDelayMs = 400;
const t0 = performance.now();
await hooks.event({ event: { type: "session.updated", properties: { info: { id: "ses_1" } } } });
const dt = performance.now() - t0;
ok(dt < 100, `event() rend la main en ${dt.toFixed(1)} ms (< 100 ms malgré un ingest à 400 ms)`);
await sleep(900); ingestDelayMs = 0;

console.log("4. coalescing du streaming");
const nIngest = ingested.length;
for (let i = 0; i < 5; i++)
  await hooks.event({ event: { type: "message.part.updated",
    properties: { part: { id: "prt_1", messageID: "msg_1", sessionID: "ses_1", text: "t" + i } } } });
await hooks.event({ event: { type: "message.part.updated",
  properties: { part: { id: "prt_2", messageID: "msg_1", sessionID: "ses_1", text: "x" } } } });
await sleep(500);
const partBatches = ingested.slice(nIngest).filter((b) => (b.events || []).some((e: any) => e.type === "message.part.updated"));
const partEvents = partBatches.flatMap((b) => b.events.filter((e: any) => e.type === "message.part.updated"));
ok(partEvents.length === 2, `6 updates → ${partEvents.length} events poussés (1 par part)`);
ok(partEvents.some((e: any) => e.properties.part.text === "t4"), "dernière version de la part conservée");

console.log("5. commande tirée du pull");
pullCommands = [{ id: "c1", sid: "ses_1", kind: "prompt", text: "hello from page" }];
await sleep(600);
ok((calls["session.promptAsync"] || []).length === 1, "prompt distant → session.promptAsync");

console.log("5b. questions de l'outil `question` (v14)");
const nBefore = ingested.length;
await hooks.event({ event: { type: "question.asked", properties: { id: "que_1", sessionID: "ses_1",
  questions: [{ question: "Quelle base ?", header: "Base", options: [{ label: "Postgres", description: "" }] }] } } });
await hooks.event({ event: { type: "question.replied", properties: { sessionID: "ses_1", requestID: "que_0", answers: [["x"]] } } });
await sleep(400);
const qTypes = ingested.slice(nBefore).flatMap((b) => (b.events || []).map((e: any) => e.type));
ok(qTypes.includes("question.asked") && qTypes.includes("question.replied"), "question.asked / question.replied remontés à l'ingest");
const askedEv = ingested.slice(nBefore).flatMap((b) => b.events || []).find((e: any) => e.type === "question.asked");
ok(askedEv && askedEv.properties.id === "que_1" && askedEv.properties.questions[0].options[0].label === "Postgres",
   "payload question.asked transmis intact (QuestionRequest)");
// réponse depuis la page → client HTTP interne (SDK v1 sans ressource question)
pullCommands = [{ id: "q1", sid: "ses_1", kind: "question", questionID: "que_1", answers: [["Postgres"]] }];
await sleep(600);
const post1 = (calls["http.post"] || [])[0]?.[0];
ok(!!post1 && post1.url === "/question/{requestID}/reply" && post1.path?.requestID === "que_1",
   "reply → _client.post('/question/{requestID}/reply', path.requestID)");
ok(!!post1 && JSON.stringify(post1.body) === JSON.stringify({ answers: [["Postgres"]] }), "body {answers: [[…]]} (shape QuestionReply)");
// refus depuis la page → /reject sans body
pullCommands = [{ id: "q2", sid: "ses_1", kind: "question", questionID: "que_2", response: "reject" }];
await sleep(600);
const post2 = (calls["http.post"] || [])[1]?.[0];
ok(!!post2 && post2.url === "/question/{requestID}/reject" && post2.path?.requestID === "que_2" && post2.body === undefined,
   "reject → _client.post('/question/{requestID}/reject') sans body");
// garde-fou : ni answers ni reject → aucun appel
pullCommands = [{ id: "q3", sid: "ses_1", kind: "question", questionID: "que_3" }];
await sleep(600);
ok((calls["http.post"] || []).length === 2, "commande sans answers ni reject ignorée (aucun appel)");
// SDK récent : client.question.reply/reject préférés au client interne
fakeClient.question = { reply: rec("question.reply", { data: true }), reject: rec("question.reject", { data: true }) };
pullCommands = [{ id: "q4", sid: "ses_1", kind: "question", questionID: "que_4", answers: [["a"], ["b", "c"]] }];
await sleep(600);
const sdkArg = (calls["question.reply"] || [])[0]?.[0];
ok(!!sdkArg && sdkArg.requestID === "que_4" && JSON.stringify(sdkArg.answers) === JSON.stringify([["a"], ["b", "c"]]),
   "SDK récent : client.question.reply({requestID, answers})");
ok((calls["http.post"] || []).length === 2, "…et le client interne n'est alors PAS appelé");
delete fakeClient.question;
// {error} hey-api = échec → toast (jamais un faux succès silencieux)
const toastsBefore = (calls["tui.showToast"] || []).length;
httpPostResult = { error: { message: "nope" }, response: { ok: false, status: 400 } };
pullCommands = [{ id: "q5", sid: "ses_1", kind: "question", questionID: "que_5", answers: [["z"]] }];
await sleep(600);
httpPostResult = { data: true, response: { ok: true } };
const lastToast = (calls["tui.showToast"] || []).slice(toastsBefore).map((a) => a[0]?.body?.message || "");
ok(lastToast.some((m) => m.includes("Réponse à la question refusée")), "réponse HTTP {error} → toast d'échec dans le TUI");

console.log("6. /remote off : bye + arrêt");
thrown = null;
try { await hooks["command.execute.before"]({ command: "remote", arguments: "off", sessionID: "ses_1" }, {}); }
catch (e) { thrown = e; }
ok(thrown, "tour /remote off annulé aussi");
await sleep(400);
ok(byeSeen.length >= 1, "bye POSTé à l'app (badge hors-ligne immédiat)");
const conf = JSON.parse(fs.readFileSync(path.join(home, ".config", "opencode", "elpis-remote.json"), "utf8"));
// v10 : `enabled` est PAR PROJET (clé = directory passé au plugin), le jeton
// reste machine-wide. Un flag global `enabled` serait la régression d'avant.
ok(conf.instances?.["/tmp/proj"]?.enabled === false && conf.token === "pcr_smoke",
   "conf persistée (enabled=false pour /tmp/proj, jeton gardé)");
ok(conf.enabled === undefined, "aucun flag `enabled` global réécrit");

console.log("7. filtre restauré après la fenêtre (perf : zéro coût permanent)");
await sleep(4200);   // FILTER_WINDOW_MS = 4000
ok(process.stdout.write === w0 && process.stderr.write === e0 && console.error === c0,
   "write/console d'origine restaurés");

console.log("8. bootstrap : migration .js → .ts");
const pluginDir = path.join(home, ".config", "opencode", "plugin");
fs.mkdirSync(pluginDir, { recursive: true });
const jsPath = path.join(pluginDir, "elpis-remote.js");
const tsPath = path.join(pluginDir, "elpis-remote.ts");
fs.rmSync(tsPath, { force: true });
fs.writeFileSync(jsPath, BOOTSTRAP_SRC.replace("__APP_URL__", BASE));
const boot1 = await import(pathToFileURL(jsPath).href + "?run=1");
const impl = await boot1.ElpisRemote({ client: fakeClient, directory: "/tmp/proj" });
ok(fs.existsSync(tsPath), "elpis-remote.ts téléchargé et installé");
ok(!fs.existsSync(jsPath), "elpis-remote.js (shim) effacé après migration");
ok(typeof impl.event === "function", "hooks du plugin TS délégués (actif sans redémarrage)");
ok(fs.readFileSync(tsPath, "utf8").startsWith("// elpis-remote"), "marqueur du fichier installé intact");

console.log("9. bootstrap : .ts déjà chargé → pas de 2e instance");
fs.writeFileSync(jsPath, BOOTSTRAP_SRC.replace("__APP_URL__", BASE));
const boot2 = await import(pathToFileURL(jsPath).href + "?run=2");
const impl2 = await boot2.ElpisRemote({ client: fakeClient, directory: "/tmp/proj" });
ok(!fs.existsSync(jsPath), "shim effacé");
ok(!impl2 || !impl2.event, "aucun hook actif (le .ts chargé par opencode fait le travail)");

await hooks.dispose();
if (impl && impl.dispose) await impl.dispose();
server.stop(true);
console.log(failures ? `\nÉCHEC : ${failures} assertion(s)` : "\nOK — smoke complet");
process.exit(failures ? 1 : 0);
