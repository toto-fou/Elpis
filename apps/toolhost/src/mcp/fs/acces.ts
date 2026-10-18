// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/fs/acces.ts — accès de la famille fs au `/work` par l'agent (fs_tools.py) : chemins, refus de l'agent, état avant remplacement, écriture gardée, lectures et recherches groupées, historique et verrous. */
import path from "node:path";

import { estErreurAgent } from "@elpis/bac";
import type { ErreurAgent } from "@elpis/bac";
import { comparePointsDeCode, ErreurPython, guessTypePy, intPy, prefixePy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import {
  AgentError,
  avecVerrouEcriture,
  currentSession,
  MAX_FILE,
  recordMove,
  recordWrite,
  sha256Bytes,
  shaOf,
  TOO_BIG,
} from "@elpis/fichiers";
import type { ContenuHistorique } from "@elpis/fichiers";
import { unquote } from "@elpis/outils-mcp";
import { lexicalRel, toContainer } from "@elpis/securite";

import { agentEnAnglais } from "../anglais";
import type { Espace } from "../espace";
import { errFs, HASH_PERIME } from "./edition";

export const PROFONDEUR = 4096;
export const GREP_LOT = 5000;
export const CONTENU_MAX = 64 * 1024 * 1024;
export const HASH_MAX = 2 ** 30;
export const FC_MAX = 50;

/** Contenu relu avant un remplacement : octets, absent (`null`) ou trop gros (`TOO_BIG`). */
export type Contenu = Buffer | null | typeof TOO_BIG;
/** `(entrée stat, contenu, sha256)` de `_actuel`. */
export type Etat = [Dict, Contenu, string];

/** `_rel` : chemin du modèle relatif à /work, sans lire le disque (guillemets tolérés, contrôle, NUL et vide refusés). */
export function relDe(racine: string, chemin: unknown, allowRoot = true): string {
  const p = unquote(chemin);
  if (!p) throw new ErreurPython("ValueError", "path required");
  if (p.includes("\0")) throw new ErreurPython("ValueError", "null byte in path");
  for (const c of p)
    if (c.charCodeAt(0) < 32 && c !== "\t") throw new ErreurPython("ValueError", "control character in path");
  return lexicalRel(racine, p, { allowRoot });
}

/** `int(x or 0)` d'un entier de l'agent (bigint au-delà de 2^53). */
export function grand(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (!veritePy(v)) return 0n;
  return BigInt(intPy(v));
}

/** `oct(n)`. */
export function octPy(n: number): string {
  return n < 0 ? `-0o${(-n).toString(8)}` : `0o${n.toString(8)}`;
}

/** `int(e.get("mtime_ns") or 0) // 1_000_000_000`. */
export function secondes(ns: unknown): number {
  const n = grand(ns);
  const q = n / 1_000_000_000n;
  return Number(n < 0n && q * 1_000_000_000n !== n ? q - 1n : q);
}

/** `p.name` de `sb / rel`. */
export function nomDe(esp: Espace, rel: string): string {
  return rel ? (rel.split("/").pop() as string) : path.basename(esp.racine);
}

const TYPES: Readonly<Record<string, string>> = {
  dir: "dir",
  file: "file",
  link: "symlink",
  other: "special",
  fifo: "fifo",
  socket: "socket",
  char_device: "device",
  block_device: "device",
};
const SPECIAUX: ReadonlySet<unknown> = new Set(["fifo", "socket", "char_device", "block_device"]);

/** Type affiché d'un genre de l'agent (`special` précise `other`) : lien non suivi `symlink`, périphérique `device`, spécial inconnu ou agent ancien `special`. */
export function typeAffiche(genre: unknown, special?: unknown): string {
  const g = genre === "other" && SPECIAUX.has(special) ? special : genre;
  return typeof g === "string" && Object.hasOwn(TYPES, g) ? (TYPES[g] as string) : "file";
}

/** `_stat_entree` : name, path, type, size, mtime, mode, rel d'une entrée `stat` de l'agent. */
export function statEntree(esp: Espace, rel: string, e: Dict): Dict {
  return {
    name: nomDe(esp, rel),
    path: toContainer(rel),
    type: typeAffiche(e["kind"], e["special"]),
    size: intPy(e["size"] || 0),
    mtime: secondes(e["mtime_ns"]),
    mode: octPy(intPy(e["mode"] || 0) & 0o777),
    rel,
  };
}

/** `_mime` : type MIME d'après le nom, ou la cible d'un lien ; `application/octet-stream` sinon. */
export function mime(esp: Espace, rel: string, ent: Dict = {}): string {
  const cible = ent["link"] === true && typeof ent["target"] === "string" ? ent["target"] : "";
  const parCible = cible ? guessTypePy(cible)[0] : null;
  return (
    parCible ?? guessTypePy(rel ? path.join(esp.racine, rel) : esp.racine)[0] ?? "application/octet-stream"
  );
}

/** Refus de format d'un `expected_sha256` non vide qui n'est pas un sha256 hexadécimal de 64 car. ; `null` si valide. */
export function refusShaMalForme(attendu: string): Dict | null {
  if (!attendu || /^[0-9a-f]{64}$/u.test(attendu)) return null;
  return errFs("bad_sha256", "expected_sha256 must be the 64-character hex sha256 returned by read_file.", {
    expected: attendu.slice(0, 80),
  });
}

/** Refus d'une cible dans un dossier `.git` (toute profondeur, toute casse) ; seul `.git/info/exclude` passe quand `exclude` est vrai. */
export function refusDansGit(rel: string, exclude = false): Dict | null {
  const parts = rel.split("/").map((x) => x.toLowerCase());
  const k = parts.indexOf(".git");
  if (k < 0) return null;
  const queue = parts.slice(k + 1).join("/");
  if (exclude && queue === "info/exclude") return null;
  return errFs("path_in_git_dir", "Writing inside a .git directory is refused; use the git tools.", {
    path: toContainer(rel),
  });
}

/** Dossiers parents de `rel` (relatif à /work), racine comprise. */
function parents(rel: string): string[] {
  const p = rel.split("/");
  return p.map((_, i) => p.slice(0, i).join("/"));
}

const sous = (d: string, nom: string): string => (d ? `${d}/${nom}` : nom);

/** Chemin réel de `rel` comme l'agent le résout (liens suivis, 40 sauts au plus), `null` s'il sort de /work. */
export async function cheminReel(esp: Espace, rel: string): Promise<string | null> {
  let reste = rel.split("/");
  let fait: string[] = [];
  let sauts = 0;
  while (reste.length) {
    const nom = reste.shift() as string;
    if (nom === "" || nom === ".") continue;
    if (nom === "..") {
      if (!fait.length) return null;
      fait.pop();
      continue;
    }
    const e = (await esp.stats([[...fait, nom].join("/")]))[0] ?? {};
    const cible = e["target"];
    if (e["link"] !== true || typeof cible !== "string") {
      fait.push(nom);
      continue;
    }
    if (++sauts > 40) return null;
    if (cible.startsWith("/")) {
      const base = [esp.racine, "/work"].find((r) => cible === r || cible.startsWith(r + "/"));
      if (base === undefined) return null;
      fait = [];
      reste = [...cible.slice(base.length).split("/"), ...reste];
    } else reste = [...cible.split("/"), ...reste];
  }
  return fait.join("/");
}

/** Vrai si écrire `rel` toucherait un dossier git : composant `.git` (toute casse) ou parent en forme de dossier git (HEAD, objects, refs), liens suivis. */
export async function dansDossierGit(esp: Espace, rel: string): Promise<boolean> {
  const temoins = (r: string): string[] =>
    parents(r).flatMap((d) => [sous(d, "HEAD"), sous(d, "objects"), sous(d, "refs")]);
  const forme = (r: string, st: Dict[]): boolean =>
    r.split("/").some((n) => n.toLowerCase() === ".git") ||
    parents(r).some(
      (_, i) =>
        st[3 * i]?.["kind"] === "file" &&
        st[3 * i + 1]?.["kind"] === "dir" &&
        st[3 * i + 2]?.["kind"] === "dir",
    );
  const n = parents(rel).length;
  const st = await esp.stats([...temoins(rel), ...parents(rel).filter(Boolean), rel]);
  if (!st.slice(3 * n).some((e) => e["link"] === true)) return forme(rel, st);
  const reel = await cheminReel(esp, rel);
  return reel !== null && forme(reel, await esp.stats(temoins(reel)));
}

/** `refusDansGit`, puis sur le chemin réel (liens suivis) : dossier git ou en forme de dossier git (dépôt nu) ; `.git/info/exclude` passe quand `exclude` est vrai et que le chemin réel y mène. */
export async function refusDansGitReel(esp: Espace, rel: string, exclude = false): Promise<Dict | null> {
  const lexical = refusDansGit(rel, exclude);
  if (lexical !== null) return lexical;
  if (exclude && /(?:^|\/)info\/exclude$/iu.test(rel)) {
    const reel = await cheminReel(esp, rel);
    if (reel !== null && /(?:^|\/)\.git\/info\/exclude$/iu.test(reel)) return null;
  }
  if (!(await dansDossierGit(esp, rel))) return null;
  return errFs(
    "path_in_git_dir",
    "Writing inside a git directory is refused (symlinks followed); use the git tools.",
    { path: toContainer(rel) },
  );
}

export function sha256(data: Uint8Array): string {
  return sha256Bytes(data);
}

export const ERREURS_AGENT: Readonly<Record<string, readonly [string, string]>> = {
  not_found: ["not_found", "Check the path."],
  is_dir: ["is_directory", "Use list_files for directories."],
  not_file: ["not_a_regular_file", "FIFOs, sockets and device files are not read."],
  outside_root: [
    "path_outside_sandbox",
    "Use a path inside /work that does not go through a symlink leading outside it.",
  ],
  bad_path: ["bad_path", "Use a path relative to /work."],
  denied: ["permission_denied", "The sandbox user cannot access this path."],
  read_only: ["permission_denied", "Read-only location."],
  no_space: ["no_space", "The sandbox disk is full."],
  too_large: ["too_large", "Read a range (offset/length, head, tail) instead."],
  timeout: ["timeout", "The sandbox took too long to answer: narrow the request (path, pattern) and retry."],
  inside: ["dest_inside_source", "Cannot copy or move a directory into itself."],
};
export const INJOIGNABLE = new Set(["agent_unavailable", "container_down", "transport", "bad_response"]);

/** `_err_agent` : refus de l'agent → enveloppe d'erreur de l'outil (chemin affiché : `rel`) ; un code inconnu prend son texte anglais pour message. */
export function errAgent(e: ErreurAgent, rel: string): Dict {
  const connu = Object.hasOwn(ERREURS_AGENT, e.code) ? ERREURS_AGENT[e.code] : undefined;
  const p = toContainer(rel);
  if (connu === undefined) {
    if (INJOIGNABLE.has(e.code))
      return errFs("sandbox_unavailable", "The sandbox container could not be reached; retry in a moment.", {
        detail: prefixePy(e.message, 200),
      });
    const r = errFs(e.code, "", { path: p });
    const texte = agentEnAnglais(e.code, e.message) || e.code.replaceAll("_", " ");
    r["message"] = `${texte.charAt(0).toUpperCase()}${texte.slice(1)}: '${p}'.`;
    return r;
  }
  const r = errFs(connu[0], connu[1], { path: p });
  if (e.code === "outside_root") r["message"] = `Path '${p}' leaves the sandbox through a symlink.`;
  return r;
}

/** `errAgent` dont le refus `outside_root` nomme le lien qui sort du bac et sa cible (lue par l'agent, jamais suivie). */
export async function errAgentLien(esp: Espace, e: ErreurAgent, rel: string): Promise<Dict> {
  const r = errAgent(e, rel);
  if (e.code !== "outside_root" || !rel) return r;
  const parties = rel.split("/");
  const prefixes = parties.map((_, k) => parties.slice(0, k + 1).join("/"));
  try {
    const st = await esp.stats(prefixes);
    const k = st.findIndex((x) => x["link"] === true && veritePy(x["outside"]));
    const lien = st[k];
    if (lien !== undefined)
      r["message"] =
        `Path leaves the sandbox through a symlink: '${prefixes[k] as string}' -> '${String(lien["target"])}'`;
  } catch (x) {
    if (!estErreurAgent(x)) throw x;
  }
  return r;
}

/** `str(e)` d'une exception, AgentError compris (`code: message`). */
export function strErreur(e: unknown): string {
  if (estErreurAgent(e)) return e.message ? `${e.code}: ${e.message}` : e.code;
  return e instanceof Error ? e.message : String(e);
}

/** `_actuel` : le fichier `rel` avant de le remplacer ; absent ou lien pendant sous /work : `(e, null, "")`. */
export async function actuel(esp: Espace, rel: string, e?: Dict, maxContenu = CONTENU_MAX): Promise<Etat> {
  const ent = e ?? (await esp.stat(rel));
  if (ent["kind"] === "missing" || (ent["kind"] === "link" && !veritePy(ent["outside"])))
    return [ent, null, ""];
  if (ent["kind"] !== "file") {
    const code = ent["kind"] === "dir" ? "is_dir" : veritePy(ent["outside"]) ? "outside_root" : "not_file";
    throw new AgentError(code, String(ent["kind"]));
  }
  if (intPy(ent["size"] || 0) > maxContenu) {
    const h = await esp.stat(rel, { hash: true, hashMax: HASH_MAX });
    return [h, TOO_BIG, veritePy(h["sha256"]) ? String(h["sha256"]) : ""];
  }
  const data = (await esp.lire(rel, { maxBytes: maxContenu })).data;
  return [ent, data, sha256(data)];
}

/** `_mode_ecrit` : droits du fichier remplacé, `undefined` : défaut de l'agent. */
export function modeEcrit(e: Dict): string | undefined {
  return e["kind"] === "file" ? (intPy(e["mode"] || 0) & 0o777).toString(8) : undefined;
}

/** Clé du verrou d'écriture partagé avec l'éditeur : `racine/rel` après résolution des liens PAR L'AGENT (jamais de realpath sur l'hôte, invariant 9). */
async function cleVerrou(esp: Espace, rel: string): Promise<string> {
  let reel: string | null = rel;
  try {
    const prefixes = rel ? rel.split("/").map((_, i, p) => p.slice(0, i + 1).join("/")) : [];
    if (prefixes.length && (await esp.stats(prefixes)).some((e) => e["link"] === true))
      reel = await cheminReel(esp, rel);
  } catch (e) {
    if (!(e instanceof AgentError)) throw e;
  }
  const r = reel ?? rel;
  return r ? path.join(esp.racine, r) : esp.racine;
}

/** `_optimistic_write_lock` : verrou de fichier partagé avec `/api/sandbox/save`. */
export async function avecVerrou<T>(esp: Espace, rel: string, f: () => Promise<T>): Promise<T> {
  return avecVerrouEcriture(await cleVerrou(esp, rel), () => f());
}

/** `_locks_for` : verrous de plusieurs chemins, dans l'ordre des clés. */
export async function avecVerrous<T>(esp: Espace, rels: readonly string[], f: () => Promise<T>): Promise<T> {
  const cles = [...new Set(await Promise.all(rels.map((r) => cleVerrou(esp, r))))].sort(comparePointsDeCode);
  const prendre = (i: number): Promise<T> =>
    i >= cles.length ? f() : avecVerrouEcriture(cles[i] as string, () => prendre(i + 1));
  return prendre(0);
}

/** `_history_record` : écriture notée dans l'historique de session (compte connu) ; un historique indisponible ne bloque jamais. */
export async function noterEcriture(
  esp: Espace,
  rel: string,
  avant: ContenuHistorique,
  apres: ContenuHistorique,
): Promise<void> {
  if (esp.uid <= 0) return;
  await currentSession(esp.uid)
    .then(() => recordWrite(esp.uid, rel || ".", avant, apres, "assistant"))
    .catch(() => undefined);
}

/** `_history_move`. */
export async function noterDeplacement(esp: Espace, a: string, b: string): Promise<void> {
  if (esp.uid <= 0) return;
  await currentSession(esp.uid)
    .then(() => recordMove(esp.uid, a || ".", b || "."))
    .catch(() => undefined);
}

/** `_fc_entry` : entrée `files_changed` (empreintes = clés des versions de l'historique). */
export function entreeChangee(
  rel: string,
  change: string,
  avant: ContenuHistorique,
  apres: ContenuHistorique,
  extra: Dict = {},
): Dict {
  return { path: toContainer(rel), change, old_sha256: shaOf(avant), new_sha256: shaOf(apres), ...extra };
}

const SEUIL_AGREGAT = 10;

/** `files_changed` d'une suppression : `.git/` en une entrée comptée, puis par dossier au-delà de 10 entrées. */
export function resumerChangements(fc: readonly Dict[], changeGit = "deleted"): Dict[] {
  const git = new Map<string, number>();
  const autres: Dict[] = [];
  for (const x of fc) {
    const p = String(x["path"]);
    const k = p.split("/").findIndex((s) => s.toLowerCase() === ".git");
    if (k < 0) autres.push(x);
    else {
      const dossier = `${p
        .split("/")
        .slice(0, k + 1)
        .join("/")}/`;
      git.set(dossier, (git.get(dossier) ?? 0) + 1);
    }
  }
  const sortie: Dict[] = [];
  if (autres.length > SEUIL_AGREGAT) {
    const parDossier = new Map<string, [number, Set<string>]>();
    for (const x of autres) {
      const p = String(x["path"]);
      const d = `${p.slice(0, Math.max(p.lastIndexOf("/"), 0))}/`;
      const [n, genres] = parDossier.get(d) ?? [0, new Set<string>()];
      genres.add(String(x["change"]));
      parDossier.set(d, [n + 1, genres]);
    }
    for (const [d, [n, genres]] of parDossier)
      sortie.push({ path: d, change: genres.size === 1 ? [...genres][0] : "changed", files: n });
  } else sortie.push(...autres);
  for (const [d, n] of git) sortie.push({ path: d, change: changeGit, files: n });
  return sortie;
}

/** `_ecrire_garde` : remplace `rel` par l'agent sous précondition (`strict` : `concurrent_modification`, sinon relu et réessayé) ; `[réponse, null]` ou `[null, erreur]`. */
export async function ecrireGarde(
  esp: Espace,
  rel: string,
  data: Buffer,
  o: { etat: Etat; expectedSha256?: string; strict?: boolean },
): Promise<[Dict | null, Dict | null]> {
  let [eActuel, base, baseSha] = o.etat;
  const attendu = o.expectedSha256 ?? "";
  return avecVerrou(esp, rel, async (): Promise<[Dict | null, Dict | null]> => {
    for (let essai = 0; essai < 3; essai++) {
      if (attendu && baseSha && baseSha !== attendu)
        return [
          null,
          errFs("hash_mismatch", HASH_PERIME, {
            expected: attendu,
            actual: baseSha,
          }),
        ];
      const condition =
        base === null
          ? { ifAbsent: true }
          : baseSha
            ? { ifSha256: baseSha }
            : { ifMtimeNs: grand(eActuel["mtime_ns"]) };
      let r: Dict;
      try {
        const mode = modeEcrit(eActuel);
        r = await esp.ecrire(rel, data, {
          parents: true,
          ...(mode === undefined ? {} : { mode }),
          ...condition,
        });
      } catch (e) {
        if (!estErreurAgent(e) || !["changed", "exists"].includes(e.code)) throw e;
        if (o.strict)
          return [
            null,
            errFs(
              "concurrent_modification",
              "The file changed while this edit was being computed (editor save, shell or another agent). Nothing was written: re-read the file then retry.",
              { expected: baseSha, actual: veritePy(e.data["sha256"]) ? String(e.data["sha256"]) : "" },
            ),
          ];
        [eActuel, base, baseSha] = await actuel(esp, rel);
        continue;
      }
      const avant: ContenuHistorique =
        base === null || base === TOO_BIG || base.length <= MAX_FILE ? base : TOO_BIG;
      await noterEcriture(esp, rel, avant, data);
      return [r, null];
    }
    return [null, errFs("concurrent_modification", "The file kept changing; retry.", { expected: baseSha })];
  });
}

/** `_grep_lots` : `esp.grep` par lots de chemins, même résultat et même bilan qu'un seul appel. */
export async function grepLots(
  esp: Espace,
  chemins: readonly string[],
  aiguille: string,
  o: { maxHits: number; ignoreCase?: boolean; maxFileBytes?: number; filesOnly?: boolean },
): Promise<[Dict[], Dict]> {
  const trouves: Dict[] = [];
  const bilan: Dict = { hits_truncated: false, skipped_large: 0, skipped_binary: 0 };
  for (let i = 0; i < chemins.length; i += GREP_LOT) {
    const [t, b] = await esp.grep(chemins.slice(i, i + GREP_LOT), aiguille, {
      maxHits: o.maxHits - trouves.length,
      ...(o.ignoreCase === undefined ? {} : { ignoreCase: o.ignoreCase }),
      ...(o.maxFileBytes === undefined ? {} : { maxFileBytes: o.maxFileBytes }),
      ...(o.filesOnly === undefined ? {} : { filesOnly: o.filesOnly }),
    });
    trouves.push(...t);
    bilan["skipped_large"] = (bilan["skipped_large"] as number) + intPy(b["skipped_large"] || 0);
    bilan["skipped_binary"] = (bilan["skipped_binary"] as number) + intPy(b["skipped_binary"] || 0);
    if (veritePy(b["hits_truncated"]) || trouves.length >= o.maxHits) {
      bilan["hits_truncated"] = veritePy(b["hits_truncated"]);
      break;
    }
  }
  return [trouves, bilan];
}

/** `_lire_lots` : (chemin, octets ou `null`) de chaque fichier, dans l'ordre, par requêtes d'au plus `budget` octets. */
export async function* lireLots(
  esp: Espace,
  chemins: readonly string[],
  maxFichier: number,
  budget = 32 * 1024 * 1024,
): AsyncGenerator<[string, Buffer | null]> {
  const maxi = Math.min(maxFichier, budget);
  let i = 0;
  while (i < chemins.length) {
    const lot = chemins.slice(i, i + 1000);
    const lus = await esp.lirePlusieurs(lot, { maxFile: maxi, maxTotal: budget });
    let n = 0;
    for (const c of lot) {
      if (!lus.has(c)) break;
      yield [c, lus.get(c) ?? null];
      n++;
    }
    if (n === 0) throw new AgentError("bad_response", "grouped read made no progress");
    i += n;
  }
}

/** `_instantane_agent` : [(fichier, octets ou `TOO_BIG`)] sous `rel` (ou `rel` lui-même) pour l'historique, bornés en nombre et en volume. */
export async function instantane(
  esp: Espace,
  rel: string,
  e: Dict,
  maxFiles = 200,
  maxTotal = 32 * 1024 * 1024,
): Promise<[string, Buffer | typeof TOO_BIG][]> {
  const sortie: [string, Buffer | typeof TOO_BIG][] = [];
  try {
    let fichiers: [string, number][];
    if (e["kind"] === "file") fichiers = [[rel, intPy(e["size"] || 0)]];
    else if (e["kind"] === "dir") {
      const liste = await esp.lister(rel, { depth: PROFONDEUR, maxEntries: maxFiles * 4, hidden: true });
      fichiers = liste.entries
        .filter((x) => x["kind"] === "file")
        .map((x) => [String(x["path"]), intPy(x["size"] || 0)] as [string, number])
        .slice(0, maxFiles);
    } else return sortie;
    const petits = fichiers.filter(([, t]) => t <= MAX_FILE).map(([f]) => f);
    const lus = petits.length ? await esp.lirePlusieurs(petits, { maxFile: MAX_FILE, maxTotal }) : new Map();
    for (const [f, taille] of fichiers) {
      if (taille > MAX_FILE) sortie.push([f, TOO_BIG]);
      else {
        const d = lus.get(f) as Buffer | null | undefined;
        if (d !== null && d !== undefined) sortie.push([f, d]);
      }
    }
  } catch (x) {
    if (!estErreurAgent(x)) throw x;
  }
  return sortie;
}

/** `_sauvegarde` : `<rel>.bak` (copie du contenu actuel, droits compris) ; erreur si un dossier porte ce nom. */
export async function sauvegarde(esp: Espace, rel: string): Promise<Dict | null> {
  try {
    await esp.fsop("copy", { src: rel, dst: `${rel}.bak`, overwrite: true, follow: true });
  } catch (e) {
    if (estErreurAgent(e) && e.code === "is_dir")
      return errFs(
        "backup_is_directory",
        `${toContainer(`${rel}.bak`)} is a directory: rename it or pass backup=False. Nothing was written.`,
      );
    throw e;
  }
  return null;
}
