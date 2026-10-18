// SPDX-License-Identifier: MIT
/** apps/toolhost/src/fichiers/outils.ts — analyse et formatage du Python de l'éditeur par `ruff` (routes_files.py `/lint`, `/format`), lancé sur l'hôte avec le texte sur l'entrée standard. */
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

import { which } from "@elpis/bac";
import {
  getPy,
  HttpError,
  nomTypePy,
  pyJsonLoads,
  pyJsonLoadsOctets,
  splitlinesPy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { interpreteurPython } from "@elpis/mcp";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { DefinitionRoute } from "../app";
import { reponseJson } from "./commun";
import { nomDe } from "./lecture";

const FORMAT_MAX_BYTES = 2 * 1024 * 1024;

/** `_find_ruff` : `ruff` du PATH, sinon celui du dossier de l'interpréteur Python des services. */
export function trouverRuff(): string | null {
  const trouve = which("ruff");
  if (trouve !== null) return trouve;
  const candidat = path.join(path.dirname(interpreteurPython()), "ruff");
  try {
    if (!statSync(candidat).isFile()) return null;
    accessSync(candidat, constants.X_OK);
    return candidat;
  } catch {
    return null;
  }
}

/** Fin d'un sous-processus : code, sorties, ou échéance dépassée. */
interface Sortie {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  delaiDepasse: boolean;
}

/** `subprocess.run(argv, input=…, capture_output=True, timeout=…)`. */
function executer(argv: readonly string[], entree: Buffer, delaiS: number): Promise<Sortie> {
  return new Promise((fin, echec) => {
    const p = spawn(argv[0] as string, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let depasse = false;
    const minuterie = setTimeout(() => {
      depasse = true;
      p.kill("SIGKILL");
    }, delaiS * 1000);
    p.stdout.on("data", (b: Buffer) => out.push(b));
    p.stderr.on("data", (b: Buffer) => err.push(b));
    p.once("error", (e) => {
      clearTimeout(minuterie);
      echec(e);
    });
    p.once("close", (code) => {
      clearTimeout(minuterie);
      fin({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), delaiDepasse: depasse });
    });
    p.stdin.on("error", () => undefined);
    p.stdin.end(entree);
  });
}

function route(
  chemin: string,
  traiter: (q: FastifyRequest, r: FastifyReply) => Promise<unknown>,
): DefinitionRoute {
  return { methode: "POST", chemin, processus: ["toolhost"], acces: "enveloppe", traiter };
}

/** `api_sandbox_lint` : diagnostics de `ruff check` au format de Monaco ; toute panne rendue dans `error`. */
async function analyser(q: FastifyRequest): Promise<Dict> {
  const d = pyJsonLoadsOctets(q.corpsBrut);
  const code = getPy(d, "content", "");
  const nom = getPy(d, "filename", "file.py");
  if (typeof nom !== "string") throw new TypeError(`'${nomTypePy(nom)}' object has no attribute 'endswith'`);
  if (!nom.endsWith(".py")) return { diagnostics: [] };
  const ruff = trouverRuff();
  if (ruff === null) return { diagnostics: [], error: "ruff not found on server" };
  try {
    if (typeof code !== "string") throw new Error(`'${nomTypePy(code)}' object has no attribute 'encode'`);
    if (!code.isWellFormed()) throw new Error("'utf-8' codec can't encode character: surrogates not allowed");
    const p = await executer(
      [ruff, "check", "--stdin-filename", nom, "--output-format", "json", "--select", "E,F,W,I", "-"],
      Buffer.from(code, "utf-8"),
      10,
    );
    if (p.delaiDepasse) throw new Error(`Command '${ruff}' timed out after 10 seconds`);
    const brut = pyJsonLoads(p.stdout.length ? p.stdout.toString("utf-8") : "[]");
    if (!Array.isArray(brut)) throw new Error("diagnostics illisibles");
    const diagnostics = brut.map((x: unknown) => {
      const lieu = getPy(x, "location");
      const fin = getPy(x, "end_location", {});
      const c = getPy(x, "code");
      return {
        row: getPy(lieu, "row"),
        col: getPy(lieu, "column"),
        end_row: getPy(fin, "row", getPy(lieu, "row")),
        end_col: getPy(fin, "column", Number(getPy(lieu, "column")) + 1),
        code: c,
        message: getPy(x, "message"),
        severity: typeof c === "string" && (c.startsWith("E") || c.startsWith("F")) ? 8 : 4,
      };
    });
    return { diagnostics };
  } catch (e) {
    return { diagnostics: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** `api_sandbox_format` : `ruff format` d'un fichier Python ; erreur de syntaxe en 422 avec le message de ruff. */
async function formater(q: FastifyRequest): Promise<Dict> {
  const d = pyJsonLoadsOctets(q.corpsBrut);
  const code = getPy(d, "content");
  const brutNom = getPy(d, "filename");
  const nom = strPy(veritePy(brutNom) ? brutNom : "file.py");
  if (typeof code !== "string") throw new HttpError(400, "content (texte) requis");
  if (!nom.endsWith(".py") && !nom.endsWith(".pyi"))
    throw new HttpError(400, "Formatage disponible pour Python seulement");
  if (!code.isWellFormed()) throw new Error("'utf-8' codec can't encode character: surrogates not allowed");
  const octets = Buffer.from(code, "utf-8");
  if (octets.length > FORMAT_MAX_BYTES)
    throw new HttpError(413, "Fichier trop gros pour le formatage (2 Mo max)");
  const ruff = trouverRuff();
  if (ruff === null) throw new HttpError(501, "ruff absent du serveur");
  const p = await executer([ruff, "format", "--stdin-filename", nomDe(nom), "-"], octets, 15);
  if (p.delaiDepasse) throw new HttpError(504, "Formatage trop long");
  if (p.code !== 0) {
    const msg = stripPy(new TextDecoder("utf-8").decode(p.stderr));
    const premiere = splitlinesPy(msg)[0] ?? "Formatage impossible";
    throw new HttpError(422, Array.from(premiere).slice(0, 300).join(""));
  }
  return { content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(p.stdout) };
}

export function routesOutils(): DefinitionRoute[] {
  return [
    route("/api/sandbox/lint", async (q, r) => reponseJson(r, await analyser(q))),
    route("/api/sandbox/format", async (q, r) => reponseJson(r, await formater(q))),
  ];
}
