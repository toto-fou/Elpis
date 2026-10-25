// SPDX-License-Identifier: MIT
// tools/demo/instance.mts — instance isolée pour la démo : racine à part sous .instance/ (liens vers le code), ports 38xxx, faux moteur, hôte d'outils et sandbox du seul compte de démo.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEPOT = path.resolve(import.meta.dirname, "..", "..");
export const RACINE = path.join(import.meta.dirname, ".instance");
export const PORTS = { main: 38001, admin: 38002, toolhost: 38765, moteur: 38080 } as const;
export const URL_MAIN = `http://127.0.0.1:${PORTS.main}`;
// Id et nom propres à la démo : les conteneurs sont nommés `elpis-sb-<nom>` et étiquetés `elpis.user_id`, communs à toutes les instances.
export const COMPTE = { id: 4242, username: "alex", password: "demo-Passw0rd-2026" } as const;

const SECRET = randomBytes(36).toString("base64");
const FAMILLES = ["elpis-fs", "elpis-shell", "elpis-git", "elpis-chart", "elpis-memory", "elpis-todo"];
// Propre à une installation : jamais repris du dépôt.
const PROPRES = new Set([
  "user_db",
  "user_sandboxes",
  "logs",
  "config.json",
  "mcp.json",
  ".env",
  "tools",
  ".git",
  "node_modules",
]);

function config(): Record<string, unknown> {
  return {
    llama: { ip: "127.0.0.1", port: String(PORTS.moteur), model: "team-coder-32b", engine: "llamacpp" },
    security: { https: { enabled: false }, listen: "local", session: { https_only: false } },
    rag: { enabled: false },
    executors: { idle_kill_hours: 0 },
  };
}

/** `mcp.json` de l'exemple réduit aux familles de la démo, sur le port de démo ; sans hôte d'outils pendant l'amorçage. */
function manifeste(avecHote: boolean): string {
  const ex = JSON.parse(readFileSync(path.join(DEPOT, "mcp.example.json"), "utf8")) as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  const serveurs = Object.fromEntries(
    Object.entries(ex["mcpServers"]!)
      .filter(([nom, s]) => FAMILLES.includes(nom) && (avecHote || s["type"] === "inprocess"))
      .map(([nom, s]) => [nom, { ...s, "x-elpis": { ...(s["x-elpis"] as object), default_on: true } }]),
  );
  const m = avecHote ? { ...ex, mcpServers: serveurs } : { version: 1, mcpServers: serveurs };
  return JSON.stringify(m, null, 1)
    .replaceAll(":8765", `:${PORTS.toolhost}`)
    .replaceAll(": 8765", `: ${PORTS.toolhost}`);
}

const docker = (...a: string[]) =>
  execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Conteneur et dossier de la sandbox de démo supprimés : seul `elpis-sb-<compte>` étiqueté avec l'id de démo est touché. */
export function nettoyer(): void {
  const nom = `elpis-sb-${COMPTE.username}`;
  const uid = (() => {
    try {
      return docker("inspect", "--format", '{{index .Config.Labels "elpis.user_id"}}', nom);
    } catch {
      return null;
    }
  })();
  if (uid !== null && uid !== String(COMPTE.id))
    throw new Error(`${nom} appartient à une autre instance (user_id=${uid}) : rien supprimé`);
  if (uid !== null) docker("rm", "-f", nom);
  const bacs = path.join(RACINE, "user_sandboxes");
  // Fichiers de /work passés à l'utilisateur du conteneur : supprimés par un conteneur jetable de l'image sandbox.
  if (existsSync(path.join(bacs, COMPTE.username))) {
    const image = docker("image", "ls", "elpis/sandbox", "--format", "{{.Repository}}:{{.Tag}}").split(
      "\n",
    )[0]!;
    docker(
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${bacs}:/bacs`,
      "--entrypoint",
      "rm",
      image,
      "-rf",
      `/bacs/${COMPTE.username}`,
    );
  }
  rmSync(RACINE, { recursive: true, force: true });
}

function preparer(o: OptionsInstance): void {
  nettoyer();
  mkdirSync(RACINE);
  for (const nom of readdirSync(DEPOT))
    if (!PROPRES.has(nom)) symlinkSync(path.join(DEPOT, nom), path.join(RACINE, nom));
  for (const d of ["user_db/logs", "user_db/run/charts", "user_sandboxes", "logs"])
    mkdirSync(path.join(RACINE, d), { recursive: true });
  for (const d of ["user_db", "user_db/run", "user_db/run/charts"]) chmodSync(path.join(RACINE, d), 0o700);
  writeFileSync(path.join(RACINE, "user_db", ".local_mcp_token"), randomBytes(24).toString("base64url"), {
    mode: 0o600,
  });
  writeFileSync(path.join(RACINE, "config.json"), JSON.stringify({ ...config(), ...o.config }, null, 1));
  writeFileSync(path.join(RACINE, "mcp.json"), manifeste(false));
  o.semer?.(path.join(RACINE, "user_sandboxes", COMPTE.username, "work"));
}

/** Environnement d'un service : rien d'hérité d'une autre instance (APP_, ELPIS_, LLAMA_…), tout pointe sous .instance/. */
function environnement(service: "main" | "toolhost"): NodeJS.ProcessEnv {
  const e = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !/^(APP_|ELPIS_|LLAMA_|LOCAL_MCP|MAIN_|ADMIN_|BIND|PLAYWRIGHT_|CHART_|RAG_|TOOLHOST_|FIREFOX_)/.test(
          k,
        ),
    ),
  );
  const commun = {
    ...e,
    ELPIS_RACINE: RACINE,
    ELPIS_HTTPS_MODE: "off",
    APP_SANDBOX_DIR: path.join(RACINE, "user_sandboxes"),
    CHART_CACHE_DIR: path.join(RACINE, "user_db", "run", "charts"),
    PLAYWRIGHT_API_URL: "http://127.0.0.1:1",
  };
  if (service === "toolhost")
    return {
      ...commun,
      LOCAL_MCP_TRANSPORT: "streamable-http",
      LOCAL_MCP_HOST: "127.0.0.1",
      LOCAL_MCP_PORT: String(PORTS.toolhost),
      TOOLHOST_APP_URL: URL_MAIN,
    };
  return {
    ...commun,
    APP_MODE: service,
    APP_SERVICE: service,
    BIND: `127.0.0.1:${PORTS[service]}`,
    APP_SESSION_SECRET: SECRET,
    LOCAL_MCP_URL: `http://127.0.0.1:${PORTS.toolhost}/mcp`,
    MAIN_INTERNAL_URL: URL_MAIN,
    MAIN_PUBLIC_URL: `${URL_MAIN}/`,
    ADMIN_PUBLIC_URL: `http://127.0.0.1:${PORTS.admin}/admin`,
  };
}

function lancer(nom: string, argv: string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const journal = openSync(path.join(RACINE, "logs", `${nom}.log`), "a");
  return spawn(argv[0]!, argv.slice(1), {
    cwd: RACINE,
    env,
    stdio: ["ignore", journal, journal],
    detached: true,
  });
}

function arreter(p: ChildProcess): Promise<void> {
  return new Promise((ok) => {
    if (p.exitCode !== null) return ok();
    p.once("exit", () => ok());
    try {
      process.kill(-p.pid!, "SIGTERM");
    } catch {
      ok();
    }
  });
}

async function sante(url: string, delai = 60_000): Promise<void> {
  const fin = Date.now() + delai;
  while (Date.now() < fin) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      /* pas encore prêt */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} injoignable (journaux : ${path.join(RACINE, "logs")})`);
}

export async function connexion(username: string = COMPTE.username): Promise<string> {
  const r = await fetch(`${URL_MAIN}/api/login-lite`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: COMPTE.password }),
  });
  if (!r.ok) throw new Error(`connexion ${username} : ${r.status} ${await r.text()}`);
  return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
}

/** Amorçage local (« admin », sans hôte d'outils déclaré), puis compte renommé et renuméroté avant tout accès à Docker ; conversations passées insérées. */
async function amorcerCompte(conversations: readonly Conversation[]): Promise<void> {
  await connexion("admin");
  const base = new DatabaseSync(path.join(RACINE, "user_db", "app.db"));
  base
    .prepare("UPDATE users SET id = ?, username = ? WHERE username = 'admin'")
    .run(COMPTE.id, COMPTE.username);
  const inserer = base.prepare(
    "INSERT INTO chats(id, user_id, title, messages_json, updated_at, archived) VALUES (?, ?, ?, ?, ?, 0)",
  );
  const maintenant = Date.now() / 1000;
  for (const c of conversations) {
    const messages = [
      { role: "user", content: c.question },
      { role: "assistant", content: c.reponse },
    ];
    inserer.run(
      randomBytes(12).toString("hex"),
      COMPTE.id,
      c.titre,
      JSON.stringify(messages),
      maintenant - c.ilYaH * 3600,
    );
  }
  base.close();
}

export type Semis = (work: string) => void;

/** Conversation passée de la liste latérale, datée de `ilYaH` heures. */
export interface Conversation {
  titre: string;
  ilYaH: number;
  question: string;
  reponse: string;
}

/** Ce qu'une scène fournit à son instance : sandbox semée, sections de config.json, historique de conversations. */
export interface OptionsInstance {
  semer?: Semis;
  config?: Record<string, unknown>;
  conversations?: readonly Conversation[];
}

export interface Instance {
  arreter(): Promise<void>;
}

/** Démarre moteur, hôte d'outils et main sur une racine neuve, préparée selon les options de la scène ; tout est arrêté si un démarrage échoue. */
export async function demarrerInstance(scene: string, o: OptionsInstance = {}): Promise<Instance> {
  preparer(o);
  const fils: ChildProcess[] = [];
  const arreterTout = async () => {
    await Promise.all(fils.map(arreter));
    nettoyer();
  };
  try {
    const moteur = path.join(import.meta.dirname, "moteur.mts");
    const core = path.join(DEPOT, "apps", "core", "dist", "main.mjs");
    const journalMoteur = path.join(RACINE, "logs", "moteur.jsonl");
    fils.push(lancer("moteur", [process.execPath, moteur, String(PORTS.moteur), scene, journalMoteur]));
    await sante(`http://127.0.0.1:${PORTS.moteur}/health`, 15_000);
    const amorce = lancer("main", [process.execPath, "--enable-source-maps", core], environnement("main"));
    fils.push(amorce);
    await sante(`${URL_MAIN}/api/me`);
    await amorcerCompte(o.conversations ?? []);
    await arreter(amorce);
    writeFileSync(path.join(RACINE, "mcp.json"), manifeste(true));
    const hote = path.join(DEPOT, "apps", "toolhost", "dist", "main.mjs");
    fils.push(
      lancer("toolhost", [process.execPath, "--enable-source-maps", hote], environnement("toolhost")),
    );
    await sante(`http://127.0.0.1:${PORTS.toolhost}/health`);
    fils.push(lancer("main", [process.execPath, "--enable-source-maps", core], environnement("main")));
    await sante(`${URL_MAIN}/api/me`);
    const r = await fetch(`${URL_MAIN}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: await connexion() },
      body: JSON.stringify({ memory_enabled: true }),
    });
    if (!r.ok) throw new Error(`réglages : ${r.status} ${await r.text()}`);
  } catch (e) {
    await arreterTout();
    throw e;
  }
  return { arreter: arreterTout };
}
