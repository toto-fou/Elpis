// SPDX-License-Identifier: MIT
/** packages/fichiers/test/amont-git.ts — dépôt Git « distant » des tests du relais (tests/_git_amont.py) : `git http-backend` en CGI derrière un serveur HTTP local qui exige BASIC si `auth`. */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

export const JETON = "jeton-secret";
export const BASIC = "Basic " + Buffer.from(`u:${JETON}`).toString("base64");

export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} : ${r.stderr}`);
  return r.stdout;
}

export interface Amont {
  readonly url: string;
  readonly racine: string;
  readonly src: string;
  /** (méthode, chemin, Authorization) de chaque requête reçue. */
  readonly vus: [string, string, string | undefined][];
  fermer(): Promise<void>;
}

/** Serveur d'un dépôt `depot.git` à un commit (`a.txt`), sur `hote` (boucle locale par défaut). */
export async function demarrerAmont(dossier: string, auth = true, hote = "127.0.0.1"): Promise<Amont> {
  const racine = path.join(dossier, "amont");
  const src = path.join(dossier, "src");
  mkdirSync(src, { recursive: true });
  git(src, "init", "-q", "-b", "main");
  writeFileSync(path.join(src, "a.txt"), "a\n");
  git(src, "add", "a.txt");
  git(src, "commit", "-q", "-m", "a");
  mkdirSync(racine, { recursive: true });
  git(racine, "init", "-q", "--bare", "-b", "main", "depot.git");
  git(src, "push", "-q", path.join(racine, "depot.git"), "main");
  const vus: [string, string, string | undefined][] = [];
  const serveur = createServer((req, res) => {
    vus.push([req.method ?? "", req.url ?? "", req.headers.authorization]);
    if (auth && req.headers.authorization !== BASIC) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="t"', "Content-Length": "0" });
      res.end();
      return;
    }
    res.on("error", () => undefined);
    const morceaux: Buffer[] = [];
    req.on("data", (b: Buffer) => morceaux.push(b));
    req.on("end", () => {
      const corps = Buffer.concat(morceaux);
      const [chemin = "", requete = ""] = (req.url ?? "").split("?", 2);
      const cgi = spawn("git", ["http-backend"], {
        env: {
          PATH: process.env["PATH"] ?? "",
          GIT_PROJECT_ROOT: racine,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: chemin,
          QUERY_STRING: requete,
          REQUEST_METHOD: req.method ?? "GET",
          CONTENT_LENGTH: String(corps.length),
          CONTENT_TYPE: req.headers["content-type"] ?? "",
          REMOTE_USER: "u",
          REMOTE_ADDR: "127.0.0.1",
          HOME: racine,
          GIT_CONFIG_NOSYSTEM: "1",
          HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
          GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
        },
      });
      const sortie: Buffer[] = [];
      cgi.stdout.on("data", (b: Buffer) => sortie.push(b));
      cgi.stdin.on("error", () => undefined);
      cgi.stdin.end(corps);
      cgi.on("close", () => {
        const brut = Buffer.concat(sortie);
        const fin = brut.indexOf("\r\n\r\n");
        const tete = brut.subarray(0, fin).toString();
        const reste = brut.subarray(fin + 4);
        let statut = 200;
        const entetes: Record<string, string> = {};
        for (const ligne of tete.split("\r\n")) {
          const i = ligne.indexOf(":");
          if (i < 0) continue;
          const k = ligne.slice(0, i);
          const v = ligne.slice(i + 1).trim();
          if (k.toLowerCase() === "status") statut = Number(v.split(" ")[0]);
          else entetes[k] = v;
        }
        entetes["Content-Length"] = String(reste.length);
        res.writeHead(statut, entetes);
        res.end(reste);
      });
    });
  });
  await new Promise<void>((ok) => serveur.listen(0, hote, ok));
  const port = (serveur.address() as AddressInfo).port;
  return {
    url: `http://${hote}:${port}/depot.git`,
    racine,
    src,
    vus,
    async fermer() {
      serveur.closeAllConnections();
      await new Promise((ok) => serveur.close(ok));
    },
  };
}
