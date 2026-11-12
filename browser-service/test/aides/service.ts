// SPDX-License-Identifier: MIT
// test/aides/service.ts — vrai service navigateur des essais d'intégration : dossier temporaire, socket unix et jeton comme dans le bac.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { BrowserType } from "playwright";

const SERVICE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Service construit (npm run build:browser) : celui que le bac lance.
export const SERVEUR = path.join(SERVICE, "dist", "main.mjs");
export const NEUTRE_PS = pathToFileURL(path.join(SERVICE, "test", "aides", "neutre_ps.ts")).href;

/** Corps JSON d'une réponse dont l'essai ne précise pas la forme. */
export interface CorpsJson {
  readonly [cle: string]: unknown;
}

/** Réponse du service : statut, corps JSON lu comme `T` (null si la réponse n'est pas du JSON), texte et en-têtes. */
export interface Reponse<T = CorpsJson> {
  statut: number;
  corps: T;
  texte: string;
  entetes: http.IncomingHttpHeaders;
}

/** Corps (envoyé en JSON hors GET) et en-têtes d'une requête. */
export interface OptionsRequete {
  corps?: unknown;
  entetes?: http.OutgoingHttpHeaders;
}

/** Service démarré ; `T` : forme des corps JSON que lit l'essai, précisable à chaque appel. */
export interface Service<T = CorpsJson> {
  dossier: string;
  socket: string;
  jeton: string;
  journal: () => string;
  post: <U = T>(route: string, corps?: unknown) => Promise<Reponse<U>>;
  get: <U = T>(route: string) => Promise<Reponse<U>>;
  brute: <U = T>(methode: string, route: string, options?: OptionsRequete) => Promise<Reponse<U>>;
  arreter: () => Promise<void>;
}

/** Port TCP d'un serveur qui écoute. */
export function portDe(serveur: net.Server): number {
  const adresse = serveur.address();
  if (adresse === null || typeof adresse === "string") throw new Error(`pas d'adresse TCP : ${adresse}`);
  return adresse.port;
}

export async function portLibre(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = portDe(srv);
  await new Promise((r) => srv.close(r));
  return port;
}

// Raison de sauter un essai : dépendances du service ou headless shell de Chromium absents ; false s'il peut tourner, toute autre erreur de lancement remonte.
export async function raisonDeSauter(): Promise<string | false> {
  if (!fs.existsSync(path.join(SERVICE, "node_modules", "playwright")))
    return "dépendances du service absentes (npm ci)";
  if (!fs.existsSync(SERVEUR))
    throw new Error(`${SERVEUR} absent : construire le service d'abord (npm run build:browser)`);
  const { chromium }: { chromium: BrowserType } = await import(
    pathToFileURL(path.join(SERVICE, "node_modules", "playwright", "index.mjs")).href
  );
  try {
    await (await chromium.launch({ headless: true })).close();
    return false;
  } catch (e) {
    const message = typeof e === "object" && e !== null && "message" in e ? e.message : undefined;
    if (/Executable doesn't exist/.test(String(message)))
      return "headless shell de Chromium absent (PLAYWRIGHT_BROWSERS_PATH)";
    throw e;
  }
}

// Requête HTTP au service par son socket : statut, corps JSON (null sinon), texte et en-têtes.
export function requeteSocket<T = CorpsJson>(
  socket: string,
  methode: string,
  route: string,
  { corps, entetes = {} }: OptionsRequete = {},
): Promise<Reponse<T>> {
  return new Promise((resolve, reject) => {
    const charge = methode === "GET" ? null : JSON.stringify(corps ?? {});
    const rq = http.request(
      {
        socketPath: socket,
        path: route,
        method: methode,
        headers: {
          host: "browser",
          ...(charge === null ? {} : { "Content-Type": "application/json" }),
          ...entetes,
        },
      },
      (r) => {
        const morceaux: Buffer[] = [];
        r.on("data", (m: Buffer) => morceaux.push(m));
        r.on("end", () => {
          const texte = Buffer.concat(morceaux).toString("utf8");
          let json: unknown = null;
          try {
            json = JSON.parse(texte);
          } catch {
            /* corps non JSON */
          }
          // Forme annoncée par l'essai (`T`), non vérifiée : seule conversion du corps.
          resolve({ statut: r.statusCode ?? 0, corps: json as T, texte, entetes: r.headers });
        });
        r.on("error", reject);
      },
    );
    rq.on("error", reject);
    rq.end(charge ?? undefined);
  });
}

// Service démarré et prêt (/health) dans un dossier temporaire (son dossier courant, comme /work/.elpis-browser) : appels JSON, journal et arrêt (dossier supprimé).
export async function demarrerService<T = CorpsJson>({
  env = {},
  jeton = env.BROWSER_SERVICE_TOKEN || crypto.randomBytes(16).toString("hex"),
}: { env?: Record<string, string>; jeton?: string } = {}): Promise<Service<T>> {
  const dossier = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "elpis-pw-essai-")));
  const socket = path.join(dossier, "browser.sock");
  let journal = "";
  const auth = { Authorization: `Bearer ${jeton}` };
  const enfant = spawn(process.execPath, ["--import", NEUTRE_PS, SERVEUR], {
    cwd: dossier,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      FIREFOX_SERVICE_SOCKET: socket,
      BROWSER_RELAY_SOCKET: path.join(dossier, "relais-absent.sock"),
      ...env,
      BROWSER_SERVICE_TOKEN: jeton,
    },
  });
  enfant.stdout.on("data", (d: Buffer) => {
    journal += d;
  });
  enfant.stderr.on("data", (d: Buffer) => {
    journal += d;
  });
  const appel = <U>(methode: string, route: string, corps?: unknown) =>
    requeteSocket<U>(socket, methode, route, { corps, entetes: auth });
  const arreter = async () => {
    if (enfant.exitCode === null) {
      enfant.kill("SIGTERM");
      await new Promise<void>((r) => {
        const t = setTimeout(r, 8000);
        enfant.on("exit", () => {
          clearTimeout(t);
          r();
        });
      });
      try {
        enfant.kill("SIGKILL");
      } catch {
        /* déjà arrêté */
      }
    }
    fs.rmSync(dossier, { recursive: true, force: true });
  };
  const limite = Date.now() + 20000;
  for (;;) {
    if (enfant.exitCode !== null) {
      await arreter();
      throw new Error(`service arrêté (${enfant.exitCode}) : ${journal}`);
    }
    try {
      if ((await appel<CorpsJson | null>("GET", "/health")).corps?.ok) break;
    } catch {
      /* pas encore prêt */
    }
    if (Date.now() > limite) {
      await arreter();
      throw new Error(`service muet après 20 s : ${journal}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    dossier,
    socket,
    jeton,
    journal: () => journal,
    post: <U = T>(route: string, corps?: unknown) => appel<U>("POST", route, corps),
    get: <U = T>(route: string) => appel<U>("GET", route),
    brute: <U = T>(methode: string, route: string, options?: OptionsRequete) =>
      requeteSocket<U>(socket, methode, route, options),
    arreter,
  };
}
