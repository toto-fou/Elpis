// SPDX-License-Identifier: MIT
/** apps/core/src/familles/memoire.ts — mémoire long terme du compte : état, édition, audit, effacement, détail et annulation des écritures (shared_infra/memory/routes.py). */
import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { getUsernameById } from "@elpis/auth";
import {
  arrondiPy,
  comparePointsDeCode,
  ErreurJsonPy,
  ErreurPython,
  estDict,
  FlottantPy,
  HttpError,
  iterPy,
  lire,
  longueurPy,
  lowerPy,
  messageErreurPy,
  messageRmtree,
  nomTypePy,
  ouPy,
  poserCle,
  pyJsonDumps,
  pyJsonLoads,
  stMtimePy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config, reloadMemoryConfigFromDisk } from "@elpis/config";
import type { Base } from "@elpis/db";
import type { FastifyRequest } from "fastify";

import {
  DEFAULT_LOCK_TIMEOUT_S,
  entryIds,
  memoryJournal,
  migrateLegacyMemory,
  parseEntries,
  storeFor,
  storeTransaction,
  StoreBusyError,
} from "../memoire";
import type { MarkdownStore, StoreOpResult } from "../memoire";
import { exigerUtf8, lireTextePy } from "../memoire/magasin";
import { rmtree } from "../skills/chemins";
import type { Famille } from "../routes";
import { utilisateur } from "./comptes";
import { corpsJsonValeurs, entrees, py, reponseJsonPy } from "@elpis/http";

export interface DependancesMemoire {
  readonly base: Base;
}

const MAX_ENTREES = 500;
const MAX_CARACTERES = 200_000;
const OCCUPE_EFFACEMENT = "écriture mémoire en cours, réessaie";
const OCCUPE_ECRITURE = "écriture mémoire en cours, réessayez";
const OP_INCONNUE = "écriture inconnue (journal effacé ou trop ancien)";
const ERRNO_IGNORES = new Set(["ENOENT", "ENOTDIR", "EBADF", "ELOOP"]);

const code = (e: unknown): string => String((e as { code?: unknown } | null)?.code ?? "");

/** `Path.exists()` de Python 3.13 : faux si absent, toute autre erreur d'E/S remonte. */
async function existePy(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (e) {
    if (ERRNO_IGNORES.has(code(e))) return false;
    throw e;
  }
}

/** `Path.is_dir()` de Python 3.13 : faux si absent, toute autre erreur d'E/S remonte. */
async function estDossierPy(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch (e) {
    if (ERRNO_IGNORES.has(code(e))) return false;
    throw e;
  }
}

/** `_limits` : `(memory, user)` relues sur disque comme l'outil `memory` (config illisible : limites courantes). */
function limites(): [number, number] {
  try {
    reloadMemoryConfigFromDisk();
  } catch {
    return [Math.trunc(config.MEMORY_MD_CHAR_LIMIT), Math.trunc(config.USER_MD_CHAR_LIMIT)];
  }
  return [Math.trunc(config.MEMORY_MD_CHAR_LIMIT), Math.trunc(config.USER_MD_CHAR_LIMIT)];
}

function magasinDe(username: string, kind: string): MarkdownStore {
  const [memoryLimit, userLimit] = limites();
  return storeFor(kind === "user" ? "user" : "memory", username, "user", config.MEMORY_DIR, {
    memoryLimit,
    userLimit,
  });
}

/** `_resolve_username` : compte supprimé sous une session valide = état serveur incohérent (500). */
async function nomDuCompte(base: Base, uid: number): Promise<string> {
  const nom = await getUsernameById(base, uid);
  if (!nom) throw new HttpError(500, "user record missing for authenticated session");
  return nom;
}

function dossierMemoire(username: string): Promise<string> {
  return migrateLegacyMemory(config.MEMORY_DIR, username);
}

/** `_file_stat` : entrées, compteurs et date d'un USER.md / MEMORY.md (illisible = vide). */
async function etatFichier(p: string): Promise<Dict> {
  const [limMemoire, limUtilisateur] = limites();
  const limit = basename(p) === "USER.md" ? limUtilisateur : limMemoire;
  if (!(await existePy(p)))
    return {
      exists: false,
      path: p,
      limit,
      chars: 0,
      usage_pct: new FlottantPy(0),
      entries: [],
      entry_ids: [],
      last_modified: null,
    };
  const brut = await lireTextePy(p).catch(() => "");
  const entries = parseEntries(brut);
  const chars = longueurPy(brut);
  return {
    exists: true,
    path: p,
    limit,
    chars,
    usage_pct: new FlottantPy(limit ? arrondiPy((100 * chars) / limit, 1) : 0),
    n_entries: entries.length,
    entries,
    entry_ids: entryIds(entries),
    last_modified: new FlottantPy(stMtimePy((await stat(p, { bigint: true })).mtimeNs)),
  };
}

/** `_chat_titles` : titres des chats du compte (best-effort, `{}` en échec). */
async function titresDesChats(base: Base, uid: number, ids: readonly string[]): Promise<Map<string, string>> {
  const uniques = [...new Set(ids.filter((c) => c))].sort(comparePointsDeCode);
  if (uniques.length === 0) return new Map();
  try {
    const lignes = await base.all(
      `SELECT id, title FROM chats WHERE user_id = ? AND id IN (${uniques.map(() => "?").join(",")})`,
      [uid, ...uniques],
    );
    return new Map(lignes.map((r) => [String(r["id"]), (r["title"] as string | null) || ""]));
  } catch {
    return new Map();
  }
}

/** `_add_origins` : date, source et chat de chaque note ; un `chat_id` non textuel n'a pas de titre, un mélange de types lève comme `sorted`. */
async function ajouterOrigines(base: Base, uid: number, dossier: string, out: Dict): Promise<void> {
  const parMagasin: [Dict, (Dict | null)[]][] = [];
  const chats: unknown[] = [];
  for (const [kind, cle] of [
    ["user", "user_md"],
    ["memory", "memory_md"],
  ] as const) {
    const etat = out[cle] as Dict;
    const origines = await memoryJournal.origins(
      dossier,
      kind,
      (etat["entries"] as string[] | undefined) ?? [],
    );
    parMagasin.push([etat, origines]);
    for (const o of origines) {
      const chat = o === null ? null : lire(o, "chat_id");
      if (!veritePy(chat)) continue;
      if (Array.isArray(chat) || estDict(chat))
        throw new ErreurPython("TypeError", `unhashable type: '${nomTypePy(chat)}'`);
      chats.push(chat);
    }
  }
  const textes = chats.filter((c): c is string => typeof c === "string");
  if (textes.length > 0 && textes.length < chats.length)
    throw new ErreurPython("TypeError", "'<' not supported between instances of 'int' and 'str'");
  const titres = await titresDesChats(base, uid, textes);
  for (const [etat, origines] of parMagasin) {
    for (const o of origines) {
      const chat = o === null ? null : lire(o, "chat_id");
      if (o === null || !veritePy(chat)) continue;
      poserCle(o, "chat_title", typeof chat === "string" ? (titres.get(chat) ?? "") : "");
      poserCle(o, "chat_exists", typeof chat === "string" && titres.has(chat));
    }
    poserCle(etat, "origins", origines);
  }
}

/** `api_memory_state` : USER.md, MEMORY.md (avec l'origine de chaque note) et les portées matérialisées. */
async function etatMemoire(base: Base, uid: number, username: string): Promise<Dict> {
  const dossier = await dossierMemoire(username);
  const out: Dict = {
    username,
    user_md: await etatFichier(join(dossier, "USER.md")),
    memory_md: await etatFichier(join(dossier, "MEMORY.md")),
    scopes: [],
  };
  await ajouterOrigines(base, uid, dossier, out).catch(() => undefined);
  const scopes = join(dossier, "scopes");
  if (await existePy(scopes)) {
    for (const nom of (await readdir(scopes)).sort(comparePointsDeCode)) {
      const d = join(scopes, nom);
      if (!(await estDossierPy(d))) continue;
      const mf = join(d, "MEMORY.md");
      if (!(await existePy(mf))) continue;
      const etat = await etatFichier(mf);
      etat["scope_hash"] = nom;
      (out["scopes"] as Dict[]).push(etat);
    }
  }
  return out;
}

/** `_unlink_store_file_capture` : supprime sous le verrou du magasin et rend `(supprimé, erreur, contenu lu sous verrou)`. */
async function supprimerSousVerrou(p: string): Promise<[boolean, string | null, string | null]> {
  let contenu: string | null = null;
  const lireEtSupprimer = async (): Promise<void> => {
    try {
      contenu = await lireTextePy(p);
    } catch {
      contenu = null;
    }
    await unlink(p);
  };
  try {
    if (!(await existePy(p))) return [false, null, null];
    if (p.endsWith(".md"))
      await storeTransaction(p, DEFAULT_LOCK_TIMEOUT_S, async () => {
        if (await existePy(p)) await lireEtSupprimer();
      });
    else await lireEtSupprimer();
    return [true, null, contenu];
  } catch (e) {
    if (e instanceof StoreBusyError) return [false, OCCUPE_EFFACEMENT, null];
    return [false, messageErreurPy(e, p), null];
  }
}

/** `_audit` : ligne du journal lu par GET /api/memory/audit (best-effort). */
async function auditer(dossier: string, ligne: Dict): Promise<void> {
  const ecrire = async (): Promise<void> => {
    const texte = pyJsonDumps(ligne, { ensureAscii: false }) + "\n";
    exigerUtf8(texte);
    const p = join(dossier, ".audit.jsonl");
    await mkdir(dirname(p), { recursive: true });
    await appendFile(p, texte, "utf8");
  };
  await ecrire().catch(() => undefined);
}

const horodatage = (): FlottantPy => new FlottantPy(Date.now() / 1000);

/** Champs communs d'une ligne d'audit d'écriture réussie ou refusée. */
function ligneResultat(res: StoreOpResult): Dict {
  return {
    ok: res.ok,
    error: res.error,
    error_code: res.error_code,
    chars: res.chars,
    limit: res.limit,
    usage_pct: res.usage_pct,
    n_entries: res.n_entries,
  };
}

/** `list(x)` de Python sur une valeur JSON : TypeError hors itérable. */
function listePy(x: unknown): unknown[] {
  const elements = iterPy(x);
  if (elements === null) throw new ErreurPython("TypeError", `'${nomTypePy(x)}' object is not iterable`);
  return [...elements];
}

/** `len(x)` de Python sur une valeur JSON. */
function longueurValeurPy(x: unknown): number {
  if (typeof x === "string") return longueurPy(x);
  if (Array.isArray(x)) return x.length;
  if (estDict(x)) return Object.keys(x).length;
  throw new ErreurPython("TypeError", `object of type '${nomTypePy(x)}' has no len()`);
}

/** `_op_view` : entrées ajoutées et retirées, annulée ou non, annulable si le magasin est resté dans l'état « après ». */
async function vueOp(dossier: string, username: string, rec: Dict): Promise<Dict> {
  const d = memoryJournal.diff(rec);
  const annulation = await memoryJournal.undoneBy(dossier, rec["op"]);
  let courant: string[] | null;
  try {
    const store = ouPy(lire(rec, "store"), "memory");
    courant = await magasinDe(username, store === "user" ? "user" : "memory").entries();
  } catch {
    courant = null;
  }
  const apres = listePy(ouPy(lire(rec, "after"), []));
  return {
    op: rec["op"],
    ts: lire(rec, "ts") ?? null,
    action: lire(rec, "action") ?? null,
    store: lire(rec, "store") ?? null,
    source: lire(rec, "source") ?? null,
    title: lire(rec, "title") ?? null,
    added: d.added,
    removed: d.removed,
    n_before: longueurValeurPy(ouPy(lire(rec, "before"), [])),
    n_after: longueurValeurPy(ouPy(lire(rec, "after"), [])),
    undone: annulation !== null,
    can_undo:
      annulation === null &&
      lire(rec, "source") !== "undo" &&
      courant !== null &&
      courant.length === apres.length &&
      courant.every((e, i) => e === apres[i]),
  };
}

/** `_valid_op` : 4 à 16 chiffres hexadécimaux, sinon 404. */
function opValide(brut: string): string {
  const op = lowerPy(stripPy(brut));
  if (!/^[0-9a-f]{4,16}$/u.test(op)) throw new HttpError(404, "écriture inconnue");
  return op;
}

/** Totaux de l'audit : actions, réussites, échecs par `error_code` (repli sur les messages anglais des lignes anciennes). */
function resumeAudit(entries: readonly unknown[]): Dict {
  const counts: Record<string, number> = {
    add: 0,
    replace: 0,
    remove: 0,
    rewrite: 0,
    ok: 0,
    failed: 0,
    over_limit: 0,
    ambiguous: 0,
    no_match: 0,
    store_busy: 0,
  };
  const compter = (cle: unknown): void => {
    if (Array.isArray(cle) || estDict(cle))
      throw new ErreurPython("TypeError", `unhashable type: '${nomTypePy(cle)}'`);
    if (typeof cle === "string" && Object.hasOwn(counts, cle)) counts[cle] = (counts[cle] ?? 0) + 1;
  };
  for (const e of entries) {
    if (!estDict(e))
      throw new ErreurPython("AttributeError", `'${nomTypePy(e)}' object has no attribute 'get'`);
    compter(lire(e, "action") ?? null);
    if (veritePy(lire(e, "ok"))) {
      counts["ok"] = (counts["ok"] ?? 0) + 1;
      continue;
    }
    counts["failed"] = (counts["failed"] ?? 0) + 1;
    let c: unknown = lire(e, "error_code") ?? null;
    if (!veritePy(c)) {
      const brut = ouPy(lire(e, "error") ?? null, "");
      if (typeof brut !== "string")
        throw new ErreurPython("AttributeError", `'${nomTypePy(brut)}' object has no attribute 'lower'`);
      const err = lowerPy(brut);
      if (err.includes("over char limit")) c = "over_limit";
      else if (err.includes("ambiguous")) c = "ambiguous";
      else if (err.includes("no entry")) c = "no_match";
    }
    compter(c);
  }
  return counts;
}

/** Les `limite` dernières lignes JSON lisibles de `.audit.jsonl` ; une ligne non JSON est sautée, une erreur arrête la lecture. */
async function lignesAudit(chemin: string, limite: number): Promise<unknown[]> {
  const sortie: unknown[] = [];
  if (!(await existePy(chemin))) return sortie;
  let lignes: string[];
  try {
    lignes = (await lireTextePy(chemin)).split("\n");
  } catch {
    return sortie;
  }
  if (lignes.at(-1) === "") lignes.pop();
  for (const brute of lignes.slice(-limite)) {
    const ligne = stripPy(brute);
    if (!ligne) continue;
    try {
      sortie.push(pyJsonLoads(ligne));
    } catch (e) {
      if (e instanceof ErreurJsonPy) continue;
      break;
    }
  }
  return sortie;
}

export function creerFamilleMemoire(dep: DependancesMemoire): Famille {
  const base = dep.base;
  const parametre = (req: FastifyRequest, nom: string): string =>
    entrees(req, { path: { [nom]: py.str() } }).path[nom] as string;
  return {
    nom: "memoire",
    routes: [
      {
        methode: "GET",
        chemin: "/api/memory/state",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => {
          const uid = utilisateur(req);
          return reponseJsonPy(rep, await etatMemoire(base, uid, await nomDuCompte(base, uid)));
        },
      },
      {
        methode: "PUT",
        chemin: "/api/memory/state/:kind",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => {
          const uid = utilisateur(req);
          const kind = parametre(req, "kind");
          if (kind !== "user" && kind !== "memory") throw new HttpError(404, "magasin inconnu");
          const username = await nomDuCompte(base, uid);
          let charge: unknown;
          try {
            charge = corpsJsonValeurs(req);
          } catch {
            throw new HttpError(400, "corps JSON invalide");
          }
          const brut = estDict(charge) ? lire(charge, "entries") : undefined;
          if (!Array.isArray(brut)) throw new HttpError(400, "champ « entries » manquant (liste attendue)");
          if (brut.length > MAX_ENTREES) throw new HttpError(400, `trop d'entrées (max ${MAX_ENTREES})`);
          const entries = brut.map((e) => stripPy(strPy(ouPy(e, "")))).filter((e) => e !== "");
          if (entries.reduce((n, e) => n + longueurPy(e), 0) > MAX_CARACTERES)
            throw new HttpError(400, "contenu démesuré");
          const dossier = await dossierMemoire(username);
          const chemin = join(dossier, kind === "user" ? "USER.md" : "MEMORY.md");
          if (entries.length === 0) {
            const [supprime, erreur, avantTexte] = await supprimerSousVerrou(chemin);
            if (erreur) throw new HttpError(409, erreur);
            if (supprime)
              await (async () =>
                memoryJournal.append(dossier, {
                  action: "rewrite",
                  store: kind,
                  before: avantTexte ? parseEntries(avantTexte) : [],
                  after: [],
                  source: "settings",
                }))().catch(() => undefined);
            await auditer(dossier, {
              ts: horodatage(),
              action: "rewrite",
              store: kind,
              scope: "user",
              source: "settings",
              ok: true,
              error: null,
              error_code: null,
              chars: 0,
              n_entries: 0,
              cleared: supprime,
            });
            return reponseJsonPy(rep, { ok: true, state: await etatFichier(chemin) });
          }
          let res: StoreOpResult;
          try {
            res = await magasinDe(username, kind).setEntries(entries);
          } catch (e) {
            if (e instanceof StoreBusyError) throw new HttpError(409, OCCUPE_ECRITURE);
            throw e;
          }
          await auditer(dossier, {
            ts: horodatage(),
            action: "rewrite",
            store: kind,
            scope: "user",
            source: "settings",
            ...ligneResultat(res),
          });
          if (!res.ok) throw new HttpError(400, res.error || "écriture refusée");
          await memoryJournal
            .append(dossier, {
              action: "rewrite",
              store: kind,
              before: res.before,
              after: res.entries,
              source: "settings",
            })
            .catch(() => undefined);
          return reponseJsonPy(rep, { ok: true, state: await etatFichier(chemin) });
        },
      },
      {
        methode: "GET",
        chemin: "/api/memory/audit",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => {
          const uid = utilisateur(req);
          const { limit } = entrees(req, { query: { limit: py.int().defaut(50) } }).query;
          const username = await nomDuCompte(base, uid);
          const lim = Math.max(1, Math.min(1000, limit));
          const entries = await lignesAudit(join(await dossierMemoire(username), ".audit.jsonl"), lim);
          return reponseJsonPy(rep, {
            username,
            count: entries.length,
            summary: resumeAudit(entries),
            entries,
          });
        },
      },
      {
        methode: "DELETE",
        chemin: "/api/memory/state",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const username = await nomDuCompte(base, utilisateur(req));
          const dossier = await dossierMemoire(username);
          const removed: string[] = [];
          const errors: string[] = [];
          for (const nom of ["USER.md", "MEMORY.md", ".audit.jsonl"]) {
            const [ok, erreur] = await supprimerSousVerrou(join(dossier, nom));
            if (ok) removed.push(nom);
            else if (erreur) errors.push(`${nom}: ${erreur}`);
          }
          try {
            if (await memoryJournal.purge(dossier)) removed.push(memoryJournal.JOURNAL_NAME);
          } catch (e) {
            errors.push(
              `${memoryJournal.JOURNAL_NAME}: ${messageErreurPy(e, memoryJournal.journalPath(dossier))}`,
            );
          }
          const scopes = join(dossier, "scopes");
          try {
            if (await existePy(scopes)) {
              await rmtree(scopes);
              removed.push("scopes/");
            }
          } catch (e) {
            errors.push(`scopes: ${messageRmtree(e, scopes)}`);
          }
          return { ok: errors.length === 0, removed, errors };
        },
      },
      {
        methode: "GET",
        chemin: "/api/memory/ops/:op",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => {
          const uid = utilisateur(req);
          const op = opValide(parametre(req, "op"));
          const username = await nomDuCompte(base, uid);
          const dossier = await dossierMemoire(username);
          const rec = await memoryJournal.get(dossier, op);
          if (rec === null) throw new HttpError(404, OP_INCONNUE);
          return reponseJsonPy(rep, await vueOp(dossier, username, rec));
        },
      },
      {
        methode: "POST",
        chemin: "/api/memory/ops/:op/undo",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => {
          const uid = utilisateur(req);
          const op = opValide(parametre(req, "op"));
          const username = await nomDuCompte(base, uid);
          const dossier = await dossierMemoire(username);
          const rec = await memoryJournal.get(dossier, op);
          if (rec === null) throw new HttpError(404, OP_INCONNUE);
          if (lire(rec, "source") === "undo") throw new HttpError(409, "une annulation ne s'annule pas");
          if ((await memoryJournal.undoneBy(dossier, op)) !== null)
            throw new HttpError(409, "écriture déjà annulée");
          const store = lire(rec, "store");
          const kind = store === "user" || store === "memory" ? store : "memory";
          let res: StoreOpResult;
          try {
            res = await magasinDe(username, kind).restore(
              listePy(ouPy(lire(rec, "after") ?? null, [])),
              listePy(ouPy(lire(rec, "before") ?? null, [])),
            );
          } catch (e) {
            if (e instanceof StoreBusyError) throw new HttpError(409, OCCUPE_ECRITURE);
            throw e;
          }
          if (!res.ok) {
            if (res.error_code === "changed")
              throw new HttpError(409, "la mémoire a changé depuis cette écriture");
            throw new HttpError(409, res.error || "annulation refusée");
          }
          await memoryJournal
            .append(dossier, {
              action: "undo",
              store: kind,
              before: res.before,
              after: res.entries,
              source: "undo",
              undo_of: op,
              chat_id: (lire(rec, "chat_id") ?? null) as string | null,
            })
            .catch(() => undefined);
          await auditer(dossier, {
            ts: horodatage(),
            action: "undo",
            store: kind,
            scope: "user",
            source: "undo",
            ok: true,
            error: null,
            error_code: null,
            chars: res.chars,
            limit: res.limit,
            usage_pct: res.usage_pct,
            n_entries: res.n_entries,
            undo_of: op,
          });
          return reponseJsonPy(rep, { ok: true, op: await vueOp(dossier, username, rec) });
        },
      },
    ],
  };
}
