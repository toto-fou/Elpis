// SPDX-License-Identifier: MIT
/** packages/fichiers/src/ecritures.ts — écritures de l'éditeur dans le bac, faites par son agent (sandbox/exec_bridge.py : agent_http, sandbox_write_*, mkdir, delete, rename, copy, clear, stat_mtime) ; refus de l'agent traduits en erreurs HTTP de l'éditeur. */
import { getPy, HttpError, intPy, journalDe, stripPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { estErreurAgent } from "@elpis/bac";
import type { ErreurAgent } from "@elpis/bac";
import { stripWorkPrefix } from "@elpis/securite";

import type { AgentClient } from "./agent";

/** Refus de l'agent → réponse HTTP de l'éditeur (mêmes statuts et messages que les scripts d'avant ; le front s'y fie). */
const HTTP_AGENT: ReadonlyMap<string, readonly [number, unknown]> = new Map<
  string,
  readonly [number, unknown]
>([
  ["not_found", [404, "Introuvable"]],
  ["exists", [409, "Un élément porte déjà ce nom"]],
  ["is_dir", [409, { code: "is_dir", message: "Un dossier porte ce nom" }]],
  ["not_dir", [409, { code: "not_dir", message: "Un élément du chemin est un fichier, pas un dossier" }]],
  ["not_file", [409, { code: "not_file", message: "Ce chemin n'est pas un fichier ordinaire" }]],
  ["outside_root", [403, "Lien symbolique hors sandbox : écriture refusée"]],
  ["inside", [400, "Impossible de copier ou déplacer un dossier dans lui-même"]],
  ["denied", [403, "Accès refusé dans la sandbox"]],
  ["read_only", [403, "Emplacement en lecture seule"]],
  ["no_space", [507, "Espace disque de la sandbox épuisé"]],
  ["too_large", [413, "Contenu trop volumineux"]],
  ["bad_path", [400, "Chemin invalide"]],
  ["name_too_long", [400, "Nom trop long"]],
  ["invalid", [400, "Nom ou chemin invalide"]],
  ["loop", [400, "Trop de liens symboliques imbriqués"]],
  ["bad_regex", [400, "Expression régulière invalide"]],
  ["bad_request", [400, "Requête invalide"]],
  ["not_empty", [409, "Dossier non vide"]],
  ["cross_device", [409, "Déplacement impossible entre deux volumes"]],
  ["changed", [412, { code: "conflict", message: "Le fichier a changé sur le disque" }]],
]);
const INDISPONIBLE: ReadonlySet<string> = new Set(["agent_unavailable", "container_down", "transport"]);

/** `agent_http` : `AgentError` → erreur HTTP de l'éditeur (503 panne, 502 réponse invalide, 504 délai, sinon la table). */
export function agentHttp(e: ErreurAgent, libelle: string): HttpError {
  if (INDISPONIBLE.has(e.code))
    return new HttpError(503, "Environnement sandbox arrêté — nouvelle tentative dans quelques instants.");
  if (e.code === "bad_response")
    return new HttpError(502, `${libelle} : réponse invalide de l'environnement sandbox`);
  if (e.code === "timeout") return new HttpError(504, `${libelle} : délai dépassé`);
  const [statut, detail] = HTTP_AGENT.get(e.code) ?? [500, `${libelle} : ${e.code}`];
  return new HttpError(statut, typeof detail === "object" ? { ...(detail as Dict) } : detail);
}

/** `_agent` : `op(agent)` ; un refus de l'agent en erreur HTTP (`agent_http`, `libelle`). */
export async function parAgent<A, T>(agent: A, libelle: string, op: (a: A) => Promise<T>): Promise<T> {
  try {
    return await op(agent);
  } catch (e) {
    if (estErreurAgent(e)) throw agentHttp(e, libelle);
    throw e;
  }
}

/** `_validate_rel_path` : vue conteneur ramenée au relatif ; vide, absolu ou `..` refusés avant tout appel à l'agent. */
export function validateRelPath(rel: unknown): string {
  if (typeof rel !== "string" || !stripPy(rel)) throw new HttpError(400, "Chemin requis");
  const rp = stripWorkPrefix(rel);
  if (!stripPy(rp)) throw new HttpError(400, "Chemin requis");
  if (rp.startsWith("/") || rp.startsWith("\\"))
    throw new HttpError(400, "Chemin absolu refusé — utiliser un chemin relatif");
  if (rp.replaceAll("\\", "/").split("/").includes("..")) throw new HttpError(403, "Chemin avec '..' refusé");
  return rp;
}

/** `sandbox_write_text` : écriture atomique d'un texte (un lien sous /work est suivi, un dossier à ce nom refusé, le mode gardé). */
export async function sandboxWriteText(agent: AgentClient, rel: string, contenu: string): Promise<void> {
  const rp = validateRelPath(rel);
  if (!contenu.isWellFormed()) throw new HttpError(400, "Contenu invalide (caractère non encodable)");
  const data = Buffer.from(contenu, "utf-8");
  await parAgent(agent, "Sauvegarde", (a) => a.write(rp, data, { parents: true }));
}

/** `sandbox_write_bytes` : écriture atomique d'octets (mêmes règles). */
export async function sandboxWriteBytes(agent: AgentClient, rel: string, data: Uint8Array): Promise<void> {
  const rp = validateRelPath(rel);
  await parAgent(agent, "Upload", (a) => a.write(rp, data, { parents: true }));
}

/** `sandbox_append_chunk` : un morceau d'un import par morceaux (`truncate` : 1er morceau) ; rend la taille du fichier provisoire. */
export async function sandboxAppendChunk(
  agent: AgentClient,
  rel: string,
  data: Uint8Array,
  o: { truncate: boolean },
): Promise<number> {
  const rp = validateRelPath(rel);
  const r = await parAgent(agent, "Upload (chunk)", (a) =>
    a.append(rp, data, { parents: o.truncate, truncate: o.truncate }),
  );
  const taille = getPy(r, "size");
  return intPy(veritePy(taille) ? taille : 0);
}

export async function sandboxMkdir(agent: AgentClient, rel: string): Promise<void> {
  const rp = validateRelPath(rel);
  await parAgent(agent, "Création dossier", (a) => a.fsop("mkdir", { path: rp, parents: true }));
}

/** `sandbox_delete` : fichier, lien (lui-même) ou dossier (récursivement) ; absent : rien ; la racine est refusée. */
export async function sandboxDelete(agent: AgentClient, rel: string): Promise<void> {
  const r = stripPy(stripWorkPrefix(rel));
  if (r === "" || r === ".") throw new HttpError(400, "Cible invalide pour suppression");
  const rp = validateRelPath(rel);
  const norm = rp.replace(/^\/+|\/+$/gu, "");
  if (!norm || norm === "." || norm === "/work" || norm === "work")
    throw new HttpError(400, "Cible invalide pour suppression");
  await parAgent(agent, "Suppression", (a) =>
    a.fsop("remove", { path: rp, recursive: true, missing_ok: true }),
  );
}

/** `sandbox_rename` : cible existante refusée ; `overwrite` (promotion d'un `.part`) remplace un FICHIER, jamais un dossier. */
export async function sandboxRename(
  agent: AgentClient,
  ancien: string,
  nouveau: string,
  o: { overwrite?: boolean } = {},
): Promise<void> {
  const src = validateRelPath(ancien);
  const dst = validateRelPath(nouveau);
  await parAgent(agent, "Renommage", (a) =>
    a.fsop("rename", { src, dst, overwrite: o.overwrite ?? false, parents: true }),
  );
}

/** `sandbox_copy` : fichier ou dossier (modes gardés, liens copiés tels quels) ; cible existante refusée. */
export async function sandboxCopy(agent: AgentClient, srcRel: string, dstRel: string): Promise<void> {
  const src = validateRelPath(srcRel);
  const dst = validateRelPath(dstRel);
  await parAgent(agent, "Copie", (a) => a.fsop("copy", { src, dst, parents: true }));
}

/** `sandbox_clear` : vide /work (pas /work lui-même), au mieux ; rend le nombre d'entrées retirées. */
export async function sandboxClear(agent: AgentClient, uid: number): Promise<number> {
  const r = await parAgent(agent, "Vidage sandbox", (a) => a.fsop("clear"));
  const echecs = getPy(r, "failed");
  if (veritePy(echecs))
    journalDe("sandbox").warn(
      `[sandbox] vidage de la sandbox ${uid} : ${String(echecs)} entrée(s) non supprimée(s)`,
    );
  const retirees = getPy(r, "removed");
  return intPy(veritePy(retirees) ? retirees : 0);
}

/** `sandbox_stat_mtime` : mtime (s, comme `st_mtime`) par l'agent ; `null` sur toute erreur. */
export async function sandboxStatMtime(agent: AgentClient, rel: string): Promise<number | null> {
  const rp = validateRelPath(rel);
  let entrees: Dict[];
  try {
    entrees = await agent.stat([rp]);
  } catch (e) {
    if (estErreurAgent(e)) return null;
    throw e;
  }
  if (entrees.length !== 1) return null;
  const ns = getPy(entrees[0], "mtime_ns");
  if (!(
    (typeof ns === "number" && Number.isInteger(ns)) ||
    typeof ns === "bigint" ||
    typeof ns === "boolean"
  ))
    return null;
  const b = BigInt(ns);
  const s = b >= 0n ? b / 1_000_000_000n : -((-b + 999_999_999n) / 1_000_000_000n);
  return Number(s) + Number(b - s * 1_000_000_000n) * 1e-9;
}
