// SPDX-License-Identifier: MIT
/** apps/toolhost/src/bac/instantanes.ts — instantanés du `/work` d'un compte (sandbox/routes_snapshots.py) : archive produite et extraite par l'agent du conteneur, progression en NDJSON, rétention, marqueur de restauration interrompue. */
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  opendirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";

import { agentFor, estErreurAgent, PANNES_AGENT } from "@elpis/bac";
import type { ArchiveAgent, ErreurAgent } from "@elpis/bac";
import {
  arrondiPy,
  decoderUtf8,
  estAlnumPy,
  estDict,
  ErreurJsonPy,
  estErreurPython,
  FlottantPy,
  getOu,
  getPy,
  HttpError,
  intPy,
  messageErreurOs,
  nomTypePy,
  ouPy,
  prefixePy,
  pyJsonDumps,
  pyJsonLoads,
  pyJsonLoadsOctets,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config, configView, pyJoin, realpathPy } from "@elpis/config";
import { entrees, ouvrirFlux, py } from "@elpis/http";
import { usernameFor } from "@elpis/securite";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { DefinitionRoute } from "../app";
import { reponseJson } from "../socle";
import { uidDe } from "./routes-me";

const MAX_SNAPSHOTS_PER_USER_DEFAULT = 10;
const SNAP_ID_RE = /^[0-9a-f]{32}$/u;
const NAME_MAX_LEN = 80;
const MAX_ENTREES = 500_000;
const RESTORE_MARKER_NAME = ".elpis_restore_incomplete";
const ENTETES_FLUX = {
  "content-type": "application/x-ndjson; charset=utf-8",
  "x-accel-buffering": "no",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "content-encoding": "identity",
};

/** Comptes ayant une création ou une restauration en cours (verrou du process par compte). */
const occupes = new Set<number>();
/** `invalidate_sandbox_usage` (jauge de quota des routes de fichiers) : branché par la composition. */
let invaliderUsage: (uid: number) => void = () => undefined;

export function installerInvalidationUsage(f: ((uid: number) => void) | null): void {
  invaliderUsage = f ?? (() => undefined);
}

/** `SNAPSHOT_MAX_MEMBER_MB` (1024) et `SNAPSHOT_MAX_TOTAL_GB` (8), en octets. */
function plafonds(): { membre: number; total: number } {
  return {
    membre: intPy(process.env["SNAPSHOT_MAX_MEMBER_MB"] ?? "1024") * 1024 * 1024,
    total: intPy(process.env["SNAPSHOT_MAX_TOTAL_GB"] ?? "8") * 1024 * 1024 * 1024,
  };
}

/** `_safe_username` : nom du compte réduit aux alphanumériques Unicode, `-` et `_` (≠ safe_sandbox_name). */
export function nomDossierInstantanes(brut: string, uid: number): string {
  return (
    Array.from(brut)
      .filter((c) => estAlnumPy(c) || c === "-" || c === "_")
      .join("") || `user_${uid}`
  );
}

function racineInstantanes(): string {
  const racine = realpathPy(pyJoin(config.SANDBOX_DIR, "_snapshots"));
  mkdirSync(racine, { recursive: true });
  return racine;
}

/** `_user_snap_dir` : dossier du compte sous `_snapshots`, créé à la demande ; 403 s'il en sortait. */
async function dossierCompte(uid: number): Promise<string> {
  const racine = racineInstantanes();
  const p = realpathPy(pyJoin(racine, nomDossierInstantanes(await usernameFor(uid), uid)));
  if (p !== racine && !p.startsWith(racine + "/")) throw new HttpError(403, "Snapshot path escape");
  mkdirSync(p, { recursive: true });
  return p;
}

function exigerId(snapId: string): void {
  if (!SNAP_ID_RE.test(snapId)) throw new HttpError(400, "Invalid snapshot id");
}

/** `_read_meta` : objet JSON relu comme `json.loads`, `null` si absent ou illisible (UTF-8 invalide : levée). */
function lireMeta(chemin: string): unknown {
  let octets: Buffer;
  try {
    octets = readFileSync(chemin);
  } catch {
    return null;
  }
  const texte = decoderUtf8(octets);
  try {
    return pyJsonLoads(texte);
  } catch (e) {
    if (e instanceof ErreurJsonPy) return null;
    throw e;
  }
}

/** Clé de tri `m.get("ts", 0)` : nombres comparés entre eux, textes entre eux, sinon TypeError (500) comme le Python. */
function cleTs(m: Dict): number | string {
  const v = getOu(m, "ts", 0);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof FlottantPy) return v.valeur;
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "bigint") return Number(v);
  throw new TypeError("'<' not supported between instances");
}

/** `_list_user_snapshots` : métadonnées dont l'archive existe, du plus récent au plus ancien. */
async function listerInstantanes(uid: number): Promise<Dict[]> {
  const dossier = await dossierCompte(uid);
  const out: Dict[] = [];
  const d = opendirSync(dossier);
  try {
    for (let e = d.readSync(); e !== null; e = d.readSync()) {
      if (!e.name.endsWith(".json")) continue;
      const meta = lireMeta(pyJoin(dossier, e.name));
      if (!veritePy(meta)) continue;
      if (!estDict(meta)) throw new TypeError(`'${nomTypePy(meta)}' object has no attribute 'get'`);
      const id = getOu(meta, "id", null);
      if (!veritePy(id)) continue;
      if (typeof id !== "string") throw new TypeError("expected string or bytes-like object");
      if (!SNAP_ID_RE.test(id) || !existsSync(pyJoin(dossier, `${id}.tar.gz`))) continue;
      out.push(meta);
    }
  } finally {
    d.closeSync();
  }
  if (out.length < 2) return out;
  const cles = out.map(cleTs);
  const types = new Set(cles.map((c) => typeof c));
  if (types.size > 1) throw new TypeError("'<' not supported between instances of 'str' and 'int'");
  const ordre = out.map((m, i) => [m, cles[i] as number | string] as const);
  ordre.sort(([, a], [, b]) => (a < b ? 1 : a > b ? -1 : 0));
  return ordre.map(([m]) => m);
}

/** `_max_snapshots` : `app.sandbox_max_snapshots` relu à chaud, entre 1 et 50. */
function maxInstantanes(): number {
  const app = getPy(ouPy(configView(), {}), "app", {});
  const valeur = getPy(app, "sandbox_max_snapshots", MAX_SNAPSHOTS_PER_USER_DEFAULT);
  let n: number;
  try {
    n = intPy(valeur);
  } catch (e) {
    if (!estErreurPython(e, "TypeError", "ValueError")) throw e;
    n = MAX_SNAPSHOTS_PER_USER_DEFAULT;
  }
  return Math.max(1, Math.min(50, n));
}

/** `_prune_old_snapshots` : les plus anciennes au-delà de la rétention supprimées, au mieux. */
async function elaguer(uid: number): Promise<number> {
  const garder = maxInstantanes();
  const dossier = await dossierCompte(uid);
  let n = 0;
  for (const ancien of (await listerInstantanes(uid)).slice(garder)) {
    try {
      const id = String(ancien["id"]);
      for (const f of [`${id}.tar.gz`, `${id}.json`])
        if (existsSync(pyJoin(dossier, f))) unlinkSync(pyJoin(dossier, f));
      n += 1;
    } catch {
      // au mieux
    }
  }
  return n;
}

/** Une ligne NDJSON : `json.dumps(ensure_ascii=False, separators=(",", ":"))` + `\n`. */
function ev(charge: Dict): string {
  return pyJsonDumps(charge, { ensureAscii: false, separators: [",", ":"] }) + "\n";
}

/** `_message_agent` : refus ou panne de l'agent en message pour l'utilisateur. */
function messageAgent(e: ErreurAgent, quoi: string): string {
  const mo = 1024 * 1024;
  const { membre, total } = plafonds();
  if (e.code === "too_large") {
    const limite = getOu(e.data, "limit", null);
    if (limite === "member")
      return `Archive refusée : un fichier dépasse le cap par membre (${Math.floor(membre / mo)} Mo ; SNAPSHOT_MAX_MEMBER_MB pour ajuster)`;
    if (limite === "total")
      return `Archive refusée : taille décompressée totale au-delà du cap (${Math.floor(total / mo)} Mo ; SNAPSHOT_MAX_TOTAL_GB pour ajuster)`;
    if (limite === "count") return `Archive refusée : plus de ${MAX_ENTREES} entrées`;
    return `Sandbox trop volumineuse pour une snapshot (plus de ${Math.floor(total / mo)} Mo ou ${MAX_ENTREES} entrées ; SNAPSHOT_MAX_TOTAL_GB pour ajuster)`;
  }
  if (e.code === "bad_archive") return `Archive invalide : ${e.message}`;
  if (e.code === "timeout") return `Erreur ${quoi} : délai dépassé`;
  if (PANNES_AGENT.includes(e.code)) return "Environnement sandbox indisponible — réessayez dans un instant.";
  return `Erreur ${quoi} : ${e.code}${e.message ? " — " + e.message : ""}`;
}

/** `time.strftime("Snapshot %d/%m/%Y %H:%M")`, heure locale. */
function nomParDefaut(): string {
  const d = new Date();
  const z = (n: number): string => String(n).padStart(2, "0");
  return `Snapshot ${z(d.getDate())}/${z(d.getMonth() + 1)}/${d.getFullYear()} ${z(d.getHours())}:${z(d.getMinutes())}`;
}

/** `str(e)` d'une panne inattendue. */
function texte(e: unknown): string {
  if (e instanceof HttpError) return `${e.statusCode}: ${strPy(e.detail)}`;
  if (typeof (e as { syscall?: unknown } | null)?.syscall === "string")
    return messageErreurOs(e, String((e as { path?: unknown }).path ?? ""));
  return e instanceof Error ? e.message : String(e);
}

/** `_create_snapshot_stream` : `preparing`, `start`, `progress`…, `done` (ou `error`) ; l'archive n'apparaît qu'entière. */
async function* fluxCreation(uid: number, nom: string): AsyncGenerator<string> {
  yield ev({ event: "preparing", phase: "snapshot" });
  if (occupes.has(uid)) {
    yield ev({ event: "error", message: "Une opération est déjà en cours sur la sandbox" });
    return;
  }
  occupes.add(uid);
  let provisoire: string | null = null;
  let fichier: FileHandle | null = null;
  let flux: ArchiveAgent | null = null;
  try {
    const snapId = randomUUID().replaceAll("-", "");
    const dossier = await dossierCompte(uid);
    const final = pyJoin(dossier, `${snapId}.tar.gz`);
    provisoire = pyJoin(dossier, `${snapId}.${randomBytes(6).toString("hex").slice(0, 8)}.tar.gz.tmp`);
    closeSync(openSync(provisoire, "wx", 0o600));
    fichier = await open(provisoire, "w");
    const debut = Date.now() / 1000;
    const { total } = plafonds();
    flux = await (
      await agentFor(uid)
    ).archive([""], {
      format: "tgz",
      dirs: true,
      maxBytes: total,
      maxFiles: MAX_ENTREES,
      deadlineS: 240,
    });
    const totalFichiers = intPy(ouPy(getPy(flux.debut, "files"), 0));
    const totalOctets = intPy(ouPy(getPy(flux.debut, "bytes"), 0));
    yield ev({ event: "start", phase: "snapshot", total_files: totalFichiers, total_bytes: totalOctets });
    for await (const x of flux) {
      if (Buffer.isBuffer(x)) {
        await fichier.write(x);
        continue;
      }
      const faits = intPy(ouPy(getPy(x, "files"), 0));
      const octets = intPy(ouPy(getPy(x, "bytes"), 0));
      const pct =
        totalOctets > 0
          ? (octets / totalOctets) * 100
          : totalFichiers > 0
            ? (faits / totalFichiers) * 100
            : 100;
      yield ev({
        event: "progress",
        phase: "snapshot",
        files_done: faits,
        total_files: totalFichiers,
        bytes_done: octets,
        total_bytes: totalOctets,
        pct: new FlottantPy(arrondiPy(Math.min(pct, 100), 1)),
        current_file: strPy(ouPy(getPy(x, "current"), "")),
      });
    }
    const fin = flux.fin ?? {};
    await flux.fermer();
    flux = null;
    await fichier.close();
    fichier = null;
    const meta: Dict = {
      id: snapId,
      name: prefixePy(stripPy(nom), NAME_MAX_LEN) || nomParDefaut(),
      ts: Math.trunc(Date.now() / 1000),
      duration_sec: new FlottantPy(arrondiPy(Date.now() / 1000 - debut, 2)),
      file_count: intPy(ouPy(getPy(fin, "files"), 0)),
      src_bytes: intPy(ouPy(getPy(fin, "bytes"), 0)),
      archive_bytes: statSync(provisoire).size,
    };
    renameSync(provisoire, final);
    provisoire = null;
    writeFileSync(
      pyJoin(dossier, `${snapId}.json`),
      pyJsonDumps(meta, { ensureAscii: false, indent: 2 }),
      "utf-8",
    );
    const elaguees = await elaguer(uid);
    if (elaguees) meta["pruned"] = elaguees;
    yield ev({ event: "done", phase: "snapshot", snapshot: meta });
  } catch (e) {
    yield ev({
      event: "error",
      message: estErreurAgent(e) ? messageAgent(e, "snapshot") : `Erreur snapshot : ${texte(e)}`,
    });
  } finally {
    await flux?.fermer().catch(() => undefined);
    await fichier?.close().catch(() => undefined);
    if (provisoire !== null) {
      try {
        unlinkSync(provisoire);
      } catch {
        // déjà absent
      }
    }
    occupes.delete(uid);
  }
}

/** `creer_snapshot` : instantané par le même chemin que le bouton (verrou compris) ; métadonnées, ou Error avec le message de l'échec. */
export async function creerSnapshot(uid: number, nom: string): Promise<Dict> {
  let meta: Dict | null = null;
  let erreur = "instantané interrompu";
  for await (const ligne of fluxCreation(uid, nom)) {
    const evt = pyJsonLoads(ligne) as Dict;
    if (evt["event"] === "done") meta = evt["snapshot"] as Dict;
    else if (evt["event"] === "error") erreur = strPy(ouPy(evt["message"], erreur));
  }
  if (!meta) throw new Error(erreur);
  return meta;
}

function leverMarqueur(dossier: string): void {
  try {
    unlinkSync(pyJoin(dossier, RESTORE_MARKER_NAME));
  } catch {
    // absent
  }
}

/** `_restaurer` : extraction par l'agent (/work remplacé une fois l'archive entière extraite et bornée) ; marqueur levé à la réponse. */
async function restaurer(
  uid: number,
  dossier: string,
  archive: string,
  envoye: { n: number },
): Promise<Dict> {
  const { membre, total } = plafonds();
  let res: Dict;
  try {
    res = await (
      await agentFor(uid)
    ).extract(
      "",
      { chemin: archive },
      {
        maxBytes: total,
        maxFile: membre,
        maxMembers: MAX_ENTREES,
        onSent: (n) => {
          envoye.n += n;
        },
      },
    );
  } catch (e) {
    if (estErreurAgent(e) && e.status) leverMarqueur(dossier);
    throw e;
  } finally {
    try {
      invaliderUsage(uid);
    } catch {
      // jauge au mieux
    }
  }
  leverMarqueur(dossier);
  return res;
}

/** `_restore_snapshot_stream` : `preparing`, `start`, `phase`, `progress`…, `done` ; un client parti n'interrompt pas la restauration. */
async function* fluxRestauration(uid: number, snapId: string): AsyncGenerator<string> {
  yield ev({ event: "preparing", phase: "restore" });
  if (occupes.has(uid)) {
    yield ev({ event: "error", message: "Une opération est déjà en cours sur la sandbox" });
    return;
  }
  occupes.add(uid);
  let tache: Promise<Dict> | null = null;
  try {
    exigerId(snapId);
    const dossier = await dossierCompte(uid);
    const archive = pyJoin(dossier, `${snapId}.tar.gz`);
    if (!existsSync(archive)) {
      yield ev({ event: "error", message: "Snapshot introuvable" });
      return;
    }
    const meta = ouPy(lireMeta(pyJoin(dossier, `${snapId}.json`)), {});
    const taille = Math.max(1, statSync(archive).size);
    yield ev({
      event: "start",
      phase: "restore",
      total_files: intPy(ouPy(getPy(meta, "file_count"), 0)),
      total_bytes: intPy(ouPy(getPy(meta, "src_bytes"), 0)),
    });
    try {
      writeFileSync(
        pyJoin(dossier, RESTORE_MARKER_NAME),
        pyJsonDumps({ snap_id: snapId, ts: new FlottantPy(Date.now() / 1000) }),
        "utf-8",
      );
    } catch {
      // au mieux
    }
    yield ev({ event: "phase", phase: "extract" });
    const envoye = { n: 0 };
    let fini = false;
    tache = restaurer(uid, dossier, archive, envoye);
    tache.then(
      () => (fini = true),
      () => (fini = true),
    );
    while (!fini) {
      await Promise.race([tache.catch(() => undefined), new Promise((r) => setTimeout(r, 250))]);
      yield ev({
        event: "progress",
        phase: "extract",
        pct: new FlottantPy(arrondiPy(Math.min(99, (envoye.n * 100) / taille), 1)),
      });
    }
    const res = await tache;
    const chemins = ouPy(getPy(res, "conflict_paths"), []);
    yield ev({
      event: "done",
      phase: "restore",
      files_restored: intPy(ouPy(getPy(res, "files"), 0)),
      bytes_restored: intPy(ouPy(getPy(res, "bytes"), 0)),
      conflicts: intPy(ouPy(getPy(res, "conflicts"), 0)),
      conflict_paths: (Array.isArray(chemins) ? chemins : Array.from(strPy(chemins)))
        .slice(0, 50)
        .map((x) => prefixePy(strPy(x), 512)),
    });
  } catch (e) {
    yield ev({
      event: "error",
      message: estErreurAgent(e) ? messageAgent(e, "restore") : `Erreur restore : ${texte(e)}`,
    });
  } finally {
    const en = tache;
    if (en === null) occupes.delete(uid);
    else
      void en.then(
        () => occupes.delete(uid),
        () => occupes.delete(uid),
      );
  }
}

/** Réponse NDJSON écrite à la main ; le générateur est refermé (ses `finally` joués) si le client part. */
async function diffuser(
  reponse: FastifyReply,
  generateur: AsyncGenerator<string>,
  arret: AbortSignal | undefined,
): Promise<void> {
  const sortie = ouvrirFlux(reponse, ENTETES_FLUX, arret);
  try {
    for await (const ligne of generateur) {
      if (sortie.signal.aborted) break;
      await sortie.ecrire(ligne);
    }
  } finally {
    await generateur.return(undefined);
    sortie.fermer();
  }
}

function idChemin(requete: FastifyRequest): string {
  return entrees(requete, { path: { snap_id: py.str() } }).path.snap_id;
}

export function routesInstantanes(arret?: AbortSignal): DefinitionRoute[] {
  const route = (
    methode: "GET" | "POST" | "DELETE",
    chemin: string,
    traiter: (q: FastifyRequest, r: FastifyReply) => Promise<unknown>,
  ): DefinitionRoute => ({ methode, chemin, processus: ["toolhost"], acces: "enveloppe", traiter });
  return [
    route("POST", "/api/sandbox/snapshots/create", async (q, r) => {
      let nom = "";
      try {
        const corps = pyJsonLoadsOctets(q.corpsBrut);
        if (estDict(corps) && typeof corps["name"] === "string") nom = corps["name"];
      } catch {
        // corps absent ou invalide : nom par défaut
      }
      await diffuser(r, fluxCreation(uidDe(q), nom), arret);
    }),
    route("GET", "/api/sandbox/snapshots", async (q, r) => {
      const uid = uidDe(q);
      const items = await listerInstantanes(uid);
      const marqueur = pyJoin(await dossierCompte(uid), RESTORE_MARKER_NAME);
      let incomplet: unknown;
      try {
        incomplet = pyJsonLoads(decoderUtf8(readFileSync(marqueur)));
      } catch (e) {
        incomplet = (e as { code?: unknown }).code === "ENOENT" ? null : {};
      }
      return reponseJson(r.header("cache-control", "no-cache"), {
        items,
        max: maxInstantanes(),
        last_restore_incomplete: incomplet,
      });
    }),
    route("POST", "/api/sandbox/snapshots/:snap_id/restore", async (q, r) => {
      const uid = uidDe(q);
      const snapId = idChemin(q);
      exigerId(snapId);
      await diffuser(r, fluxRestauration(uid, snapId), arret);
    }),
    route("DELETE", "/api/sandbox/snapshots/restore-marker", async (q, r) => {
      const chemin = pyJoin(await dossierCompte(uidDe(q)), RESTORE_MARKER_NAME);
      try {
        unlinkSync(chemin);
      } catch (e) {
        if ((e as { code?: unknown }).code !== "ENOENT")
          throw new HttpError(500, `Impossible d'effacer le marqueur : ${messageErreurOs(e, chemin)}`);
      }
      return reponseJson(r, { ok: true });
    }),
    route("DELETE", "/api/sandbox/snapshots/:snap_id", async (q, r) => {
      const uid = uidDe(q);
      const snapId = idChemin(q);
      exigerId(snapId);
      const dossier = await dossierCompte(uid);
      const fichiers = [pyJoin(dossier, `${snapId}.tar.gz`), pyJoin(dossier, `${snapId}.json`)];
      if (!fichiers.some((f) => existsSync(f))) throw new HttpError(404, "Snapshot not found");
      let erreur: string | null = null;
      for (const f of fichiers) {
        try {
          if (existsSync(f)) unlinkSync(f);
        } catch (e) {
          erreur = messageErreurOs(e, f);
        }
      }
      if (erreur !== null) throw new HttpError(500, `Delete error: ${erreur}`);
      return reponseJson(r, { ok: true, id: snapId });
    }),
  ];
}
