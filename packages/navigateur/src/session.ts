// SPDX-License-Identifier: MIT
/** packages/navigateur/src/session.ts — sessions Playwright : propriétaire transmis au service navigateur, propriété des sessions (mémoire et fichiers compagnons), captures du fil. */
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";

import {
  ErreurPython,
  estDict,
  journalDe,
  lire,
  ouPy,
  pyJsonLoads,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { pyJoin, safeSandboxName } from "@elpis/config";

const log = (): ReturnType<typeof journalDe> => journalDe("pw_owner");

const OWNER_OK = /^[A-Za-z0-9_-]{1,64}$/;
/** Forme des propriétaires dérivés (`u_` nom non sûr, `s_` enfant, `r_` nom sûr de cette forme) : jamais un nom de compte rendu tel quel. */
const OWNER_DERIVE = /^[sur]_[0-9a-f]{32}$/;

const empreinte = (texte: string): string =>
  createHash("sha256").update(texte, "utf-8").digest("hex").slice(0, 32);

/** Propriétaire transmis au service navigateur : le nom s'il est sûr et d'une forme libre, sinon une empreinte stable (jamais deux comptes confondus, jamais un nom qui imite un propriétaire dérivé). */
export function pwOwner(username: string | null | undefined): string {
  const u = stripPy(username || "") || "guest";
  if (OWNER_OK.test(u) && !OWNER_DERIVE.test(u)) return u;
  if (!u.isWellFormed())
    throw new ErreurPython("ValueError", "'utf-8' codec can't encode character: surrogates not allowed");
  return OWNER_OK.test(u) ? "r_" + empreinte(`reserve\u0000${u}`) : "u_" + empreinte(u);
}

/** Propriétaire d'un enfant à session isolée : empreinte du compte et de l'enfant (le NUL sépare, un nom de compte n'en porte pas), donc une session, un quota et un nettoyage distincts de ceux du compte. */
export function pwOwnerEnfant(
  username: string | null | undefined,
  enfantId: string | null | undefined,
): string {
  const u = stripPy(username || "") || "guest";
  const e = stripPy(enfantId || "") || "-";
  return "s_" + empreinte(`${u}\u0000task\u0000${e}`);
}

/** Propriétaire que les outils `pw_*` transmettent pour un compte : `pw_owner(safe_sandbox_name(compte))`. */
export function proprietaire(compte: string | null | undefined): string {
  return pwOwner(safeSandboxName(compte ?? null));
}

/** Synonymes du verbe de chaque outil `pw_*` (le nom canonique `action` l'emporte). */
export const PW_VERB_ALIASES: Readonly<Record<string, readonly string[]>> = {
  pw_session: ["action"],
  pw_mock: ["action"],
  pw_recorder: ["action"],
  pw_act: ["action", "do"],
  pw_page: ["action", "op"],
  pw_memory: ["action", "op"],
  pw_expect: ["action", "assertion"],
  pw_observe: ["action", "mode"],
};

/** Verbe effectif d'un appel `pw_*`, synonymes résolus et blancs retirés ; `""` sinon. */
export function pwVerbOf(outil: string, args: unknown): string {
  if (!estDict(args)) return "";
  const cles = Object.hasOwn(PW_VERB_ALIASES, outil) ? (PW_VERB_ALIASES[outil] ?? ["action"]) : ["action"];
  for (const k of cles) {
    const v = lire(args, k);
    if (typeof v === "string" && stripPy(v)) return stripPy(v);
  }
  return "";
}

const proprietaires = new Map<string, string>();
const PROPRIETAIRES_MAX = 500;
const SID_RE = /^[A-Za-z0-9-]{8,64}$/;
const SID_CAPTURE = /^[A-Za-z0-9_-]{8,64}$/;
const TTL_S = 24 * 3600;

/** `PW_OWNERS_DIR`, sinon `<ELPIS_RUNTIME_DIR ou /tmp>/elpis_pw_owners` (partagé par tous les processus). */
export function pwOwnersDir(): string {
  return (
    process.env["PW_OWNERS_DIR"] ||
    pyJoin(stripPy(process.env["ELPIS_RUNTIME_DIR"] ?? "") || "/tmp", "elpis_pw_owners")
  );
}

/** Dossier des compagnons à nous et fermé aux autres comptes ; sinon on n'y lit ni n'y écrit (contrôle en mémoire seul). */
async function dossierOk(): Promise<boolean> {
  const dossier = pwOwnersDir();
  let infos: Awaited<ReturnType<typeof lstat>>;
  try {
    await mkdir(dossier, { recursive: true, mode: 0o700 });
    infos = await lstat(dossier);
  } catch {
    return false;
  }
  if (!infos.isDirectory() || infos.uid !== process.geteuid?.() || infos.mode & 0o077) {
    log().warn(`${dossier} n'est pas un dossier privé de ce compte : sidecars ignorés`);
    return false;
  }
  return true;
}

/** Chemin du compagnon d'une session, `null` si l'identifiant permettrait une traversée. */
export function pwOwnerPath(sid: unknown): string | null {
  const texte = veritePy(sid) ? strPy(sid) : "";
  return SID_RE.test(texte) ? pyJoin(pwOwnersDir(), `${texte}.owner`) : null;
}

async function elaguer(): Promise<void> {
  const dossier = pwOwnersDir();
  const maintenant = Date.now() / 1000;
  let noms: string[];
  try {
    noms = await readdir(dossier);
  } catch {
    return;
  }
  for (const nom of noms) {
    if (!nom.endsWith(".owner")) continue;
    try {
      const chemin = pyJoin(dossier, nom);
      if (maintenant - (await stat(chemin)).mtimeMs / 1000 > TTL_S) await unlink(chemin);
    } catch {
      continue;
    }
  }
}

async function ecrireCompagnon(sid: string, username: string): Promise<void> {
  const chemin = pwOwnerPath(sid);
  if (chemin === null || !(await dossierOk())) return;
  try {
    await elaguer();
    const tmp = chemin + ".tmp";
    await writeFile(tmp, username, "utf-8");
    await rename(tmp, chemin);
  } catch (e) {
    log().warn(`sidecar non écrit (${sid.slice(0, 8)}) : ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function lireCompagnon(sid: unknown): Promise<string | null> {
  const chemin = pwOwnerPath(sid);
  if (chemin === null || !(await dossierOk())) return null;
  try {
    const owner = stripPy(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(chemin)),
    );
    return owner || null;
  } catch {
    return null;
  }
}

/** Session Playwright → compte propriétaire (mémoire bornée à 500, compagnon écrit d'abord) ; faux si rien n'est posé. */
async function poser(sid: string, username: string): Promise<boolean> {
  if (!sid || !username) return false;
  await ecrireCompagnon(sid, username);
  proprietaires.set(sid, username);
  if (proprietaires.size > PROPRIETAIRES_MAX)
    for (const k of [...proprietaires.keys()].slice(0, proprietaires.size - PROPRIETAIRES_MAX))
      proprietaires.delete(k);
  return true;
}

export async function registerPwSessionOwner(sid: string, username: string): Promise<void> {
  if (await poser(sid, username)) log().info(`Session ${sid.slice(0, 8)} → user ${username}`);
}

/** `record_pw_session_owner` : propriété posée par l'outil `pw_session` lui-même sur l'hôte d'outils (même pose, sans ligne de journal). */
export async function recordPwSessionOwner(sid: string, username: string): Promise<void> {
  await poser(sid, username);
}

export async function unregisterPwSessionOwner(sid: string): Promise<void> {
  if (!sid) return;
  proprietaires.delete(sid);
  const chemin = pwOwnerPath(sid);
  if (chemin !== null) await unlink(chemin).catch(() => undefined);
}

/** Propriétaire d'une session : mémoire, sinon compagnon disque (session ouverte par un autre processus). */
export async function getPwSessionOwner(sid: unknown): Promise<string | null> {
  if (!veritePy(sid)) return null;
  const cle = strPy(sid);
  const connu = proprietaires.get(cle);
  if (connu !== undefined) return connu;
  const owner = await lireCompagnon(sid);
  if (owner) proprietaires.set(cle, owner);
  return owner;
}

/** Suit `pw_session` : `start` enregistre, `stop` réussi de son propre compte retire, `cleanup` vide la mémoire de ce compte. */
export async function trackPwSessionOwnership(
  outil: string,
  args: unknown,
  resultat: unknown,
  username: string,
): Promise<void> {
  if (outil !== "pw_session" || !estDict(args)) return;
  const action = pwVerbOf("pw_session", args);
  if (!action) return;
  let data: unknown;
  try {
    data = veritePy(resultat) ? pyJsonLoads(resultat as string) : {};
  } catch {
    data = {};
  }
  if (!estDict(data)) return;
  if (action === "start") {
    const sid = ouPy(lire(data, "session_id") ?? null, lire(data, "sid") ?? null);
    if (typeof sid === "string" && sid) await registerPwSessionOwner(sid, username);
  } else if (action === "stop") {
    const sid = lire(args, "session_id") ?? null;
    const echec = data["ok"] === false || veritePy(lire(data, "error") ?? null);
    if (veritePy(sid) && !echec && (await getPwSessionOwner(sid)) === username)
      await unregisterPwSessionOwner(strPy(sid));
  } else if (action === "cleanup") {
    const retires = [...proprietaires].filter(([, u]) => u === username).map(([s]) => s);
    for (const s of retires) proprietaires.delete(s);
    if (retires.length > 0) log().info(`Cleanup user ${username}: ${retires.length} sessions retirées`);
  }
}

/** Capture injectée par le service (`screenshot_step`) dans le résultat d'un outil `pw_*` → URL de la capture, sinon `null`. */
export function extractPwScreenshotUrl(
  outil: unknown,
  args: unknown,
  resultat: unknown,
  maintenant = Date.now() / 1000,
): Dict | null {
  if (typeof outil !== "string" || !outil.startsWith("pw_") || !estDict(args)) return null;
  const sid = ouPy(lire(args, "session_id") ?? null, lire(args, "sid") ?? null);
  if (typeof sid !== "string" || !sid || !SID_CAPTURE.test(sid)) return null;
  if (typeof resultat !== "string" || !resultat) return null;
  let data: unknown;
  try {
    data = pyJsonLoads(resultat);
  } catch {
    return null;
  }
  if (!estDict(data)) return null;
  const pas = lire(data, "screenshot_step");
  const entier =
    typeof pas === "boolean" || typeof pas === "bigint" || (typeof pas === "number" && Number.isInteger(pas));
  if (!entier || Number(pas) <= 0) return null;
  return {
    url: `/api/playwright/screenshot/step_${sid}_${strPy(pas)}.png?t=${Math.trunc(maintenant * 1000)}`,
    step: pas,
    session_id: sid,
  };
}
