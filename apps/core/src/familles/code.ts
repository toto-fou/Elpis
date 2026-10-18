// SPDX-License-Identifier: MIT
/** apps/core/src/familles/code.ts — page « Code » : jetons, appairage, ingest et tirage du greffon, pilotage et flux (shared_infra/opencode/routes_code.py). */
import { createHash } from "node:crypto";

import {
  adressePair,
  creerJeton,
  ErreurJeton,
  getUsernameById,
  listerJetons,
  politique,
  resoudreJeton,
  revaliderFlux,
  revoquerType,
  verifierQuota,
} from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import {
  dormirMs,
  entierExactPy,
  ErreurPython,
  estAlnumPy,
  estDict,
  floatPy,
  FlottantPy,
  flottantStrictPy,
  getPy,
  HttpError,
  itemPy,
  longueurPy,
  maxPy,
  minPy,
  ouPy,
  prefixePy,
  pyJsonDumps,
  pyJsonLoads,
  splitPy,
  stripPy,
  strPy,
  veritePy,
  versFlottantPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { featureEnabled } from "@elpis/config";
import type { Base, Executeur } from "@elpis/db";
import { compareDigest, tokenUrlsafe } from "@elpis/securite";
import type { FastifyReply, FastifyRequest } from "fastify";

import { urlDeBase } from "../comptes/aides";
import { chargerGreffon, remplacerTout } from "../code/greffon";
import type { Greffon } from "../code/greffon";
import {
  CLIENT_TTL,
  estErreurTypeOuValeur,
  MagasinCode,
  maintenant,
  normalizePermission,
  normalizeQuestion,
  QUESTION_MAX_OPTIONS,
  QUESTION_MAX_QUESTIONS,
  QUESTION_MAX_TEXT,
  reel,
} from "../code/magasin";
import type { Horloge } from "../code/magasin";
import type { OptionsListenPipeline } from "../evenements/pipeline";
import { servirFluxSse } from "../evenements/sse";
import type { Message } from "../evenements/systeme";
import type { Journal } from "../journal";
import type { Famille } from "../routes";
import { utilisateur } from "./comptes";
import {
  corpsJsonValeurs,
  entrees,
  installerCorpsBorne,
  premierEntete,
  py,
  reponseJsonPy,
} from "@elpis/http";

/** Ce que la page Code attend du bus par compte (`PipelineEvents`) : diffusion et écoute. */
export interface BusCode {
  broadcastToUser(userId: number, message: Message): void;
  listen(userId: number, options?: OptionsListenPipeline): AsyncGenerator<string, void, undefined>;
}

/** `secrets.token_urlsafe` et `secrets.choice`, remplaçables par les tests. */
export interface Aleatoire {
  jeton(nbytes: number): string;
  choix(alphabet: string): string;
}

export interface DependancesCode {
  readonly base: Base;
  readonly auth: DependancesAuth & DependancesJetons;
  readonly bus: BusCode;
  readonly journal?: Journal;
  /** Arrêt du process : le flux se ferme et le long-poll rend la main. */
  readonly arret?: AbortSignal;
  readonly maintenant?: Horloge;
  readonly aleatoire?: Aleatoire;
  readonly greffon?: Greffon;
  readonly pingMs?: number;
  readonly graceArretMs?: number;
}

const ALEATOIRE: Aleatoire = {
  jeton: (n) => tokenUrlsafe(n),
  choix: (alphabet) => {
    const octet = new Uint32Array(1);
    for (;;) {
      crypto.getRandomValues(octet);
      const v = octet[0] ?? 0;
      if (v < Math.floor(0x100000000 / alphabet.length) * alphabet.length)
        return alphabet.charAt(v % alphabet.length);
    }
  },
};

/** Events que le greffon fait suivre (plus `session.snapshot` et les listes de la CLI). */
const FORWARD: ReadonlySet<string> = new Set([
  "session.created",
  "session.updated",
  "session.deleted",
  "session.idle",
  "session.error",
  "message.updated",
  "message.part.updated",
  "message.removed",
  "permission.updated",
  "permission.asked",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "session.snapshot",
  "client.commands",
  "client.models",
  "client.agents",
]);

const ACTIONS: ReadonlySet<string> = new Set([
  "undo",
  "redo",
  "compact",
  "share",
  "unshare",
  "init",
  "new",
  "delete",
]);
const CONTROLE: ReadonlySet<string> = new Set(["session_expired", "worker_recycling", "error"]);
const PAIR_TTL = 300.0;
const PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PAIR_MAX_PER_IP = 3;
const PAIR_CONFIRM_MAX = 10;
const VERROU_PAIR_ADRESSE = 0x454c5031;
const VERROU_PAIR_COMPTE = 0x454c5032;

/** Verrou de transaction PostgreSQL propre à une clé (adresse, compte) ; une transaction SQLite est déjà exclusive. */
async function verrouCle(x: Executeur, espace: number, cle: string): Promise<void> {
  if (x.dialecte !== "postgres") return;
  await x.get("SELECT pg_advisory_xact_lock(?, ?) AS v", [
    espace,
    createHash("sha256").update(cle).digest().readInt32BE(0),
  ]);
}
const INACTIF = "OpenCode est désactivé par l'administrateur.";
/** Routes du greffon : le jeton passe avant la lecture du corps, comme `_token_uid` avant `_body`. */
const ROUTES_JETON: ReadonlySet<string> = new Set([
  "/api/code/hello",
  "/api/code/ingest",
  "/api/code/pull",
  "/api/code/bye",
]);
const SANS_CLI = "Aucune CLI opencode connectée — tapez /remote côté CLI.";
const PLUS_CONNECTEE = "Cette CLI n'est plus connectée.";
const REPONSE_LISTE = "Réponse invalide — `answers` doit être une liste (une entrée par question).";

/** `_render_code_event` : `code.event` rendu tel quel, contrôle du bus enveloppé `__control`, le reste filtré. */
export function rendreEvenementCode(payload: Message): string | null {
  if (!estDict(payload)) return null;
  const kind = getPy(payload, "type");
  if (kind === "code.event") return pyJsonDumps(ouPy(getPy(payload, "data"), {}), { ensureAscii: false });
  if (Array.isArray(kind) || estDict(kind))
    throw new TypeError(`unhashable type: '${Array.isArray(kind) ? "list" : "dict"}'`);
  if (typeof kind === "string" && CONTROLE.has(kind))
    return pyJsonDumps({ __control: payload }, { ensureAscii: false });
  return null;
}

/** `(ev.get("type") or "") in _FORWARD` : un type liste ou dict lève comme un `in` sur un ensemble. */
function transmis(t: unknown): boolean {
  if (Array.isArray(t) || estDict(t))
    throw new ErreurPython("TypeError", `unhashable type: '${Array.isArray(t) ? "list" : "dict"}'`);
  return typeof t === "string" && FORWARD.has(t);
}

/** `_body` : un corps illisible ou qui n'est pas un objet vaut `{}`. */
function corps(requete: FastifyRequest): Dict {
  try {
    const v = corpsJsonValeurs(requete);
    return estDict(v) ? v : {};
  } catch {
    return {};
  }
}

function parametre(requete: FastifyRequest, nom: string): string {
  return (requete.params as Record<string, string>)[nom] ?? "";
}

function requete(requete: FastifyRequest, ...noms: string[]): Record<string, string> {
  const champs = Object.fromEntries(noms.map((n) => [n, py.str().defaut("")]));
  return entrees(requete, { query: champs }).query as Record<string, string>;
}

function texte(corpsDict: Dict, cle: string): string {
  return strPy(ouPy(getPy(corpsDict, cle), ""));
}

/** Libellé de question accepté : texte, entier (booléen compris) ou flottant, non vide une fois rogné. */
function libelle(x: unknown): boolean {
  const scalaire =
    typeof x === "string" ||
    typeof x === "number" ||
    typeof x === "bigint" ||
    typeof x === "boolean" ||
    x instanceof FlottantPy;
  return scalaire && stripPy(strPy(x)) !== "";
}

export function creerFamilleCode(dep: DependancesCode): Famille {
  const horloge = dep.maintenant ?? maintenant;
  const alea = dep.aleatoire ?? ALEATOIRE;
  const greffon = dep.greffon ?? chargerGreffon();
  const magasin = new MagasinCode(dep.base, horloge);
  const journal = dep.journal;

  const publier = (uid: number, data: Dict): void => {
    try {
      dep.bus.broadcastToUser(uid, { type: "code.event", data });
    } catch (e) {
      journal?.error({ err: e }, "code: broadcast SSE échoué");
    }
  };

  const creerJetonOpencode = async (uid: number, nom: string): Promise<string> => {
    try {
      return (await creerJeton(dep.auth, uid, "opencode", nom || "opencode"))[0];
    } catch (e) {
      if (e instanceof ErreurJeton) throw new HttpError(409, e.message);
      throw e;
    }
  };

  const compteDuJeton = async (req: FastifyRequest): Promise<number> => {
    const d = await resoudreJeton(dep.auth, stripPy(premierEntete(req, "x-elpis-token") ?? ""), ["opencode"]);
    if (!d) throw new HttpError(401, "Token elpis-remote invalide.");
    return d.user_id;
  };

  const comptesVerifies = new WeakMap<FastifyRequest, number>();
  const compteVerifie = (req: FastifyRequest): number => {
    const uid = comptesVerifies.get(req);
    if (uid === undefined) throw new HttpError(401, "Token elpis-remote invalide.");
    return uid;
  };

  const exigerCli = async (uid: number, message = SANS_CLI): Promise<string[]> => {
    const actifs = await magasin.activeClients(uid);
    if (actifs.length === 0) throw new HttpError(409, message);
    return actifs;
  };

  const ok = { ok: true, queued: true };

  const nouveauCode = async (x: Executeur): Promise<string> => {
    let code = "";
    for (let i = 0; i < 5; i++) {
      code = Array.from({ length: 6 }, () => alea.choix(PAIR_ALPHABET)).join("");
      if (!(await x.get("SELECT 1 AS un FROM code_pairings WHERE code=?", [code]))) return code;
    }
    return code;
  };

  const tirer = async (req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> => {
    const uid = compteVerifie(req);
    const q = requete(req, "client", "wait");
    const cid = q["client"] ?? "";
    let attente: number;
    try {
      attente = minPy(25.0, maxPy(0.0, floatPy(q["wait"] || 0)));
    } catch (e) {
      if (!(e instanceof ErreurPython && e.type === "ValueError")) throw e;
      attente = 0.0;
    }
    const fin = new AbortController();
    rep.raw.once("close", () => {
      if (!rep.raw.writableFinished) fin.abort();
    });
    const signal = dep.arret ? AbortSignal.any([fin.signal, dep.arret]) : fin.signal;
    await magasin.seenClient(uid, cid);
    let cmds = await magasin.claimCommands(uid, cid);
    const limite = horloge() + attente;
    while (cmds.length === 0 && horloge() < limite && !signal.aborted) {
      try {
        await dormirMs(minPy(0.4, maxPy(0.05, limite - horloge())) * 1000, signal);
      } catch {
        break;
      }
      cmds = await magasin.claimCommands(uid, cid);
    }
    await magasin.seenClient(uid, cid);
    const epoch = await magasin.getEpoch();
    return reponseJsonPy(rep, {
      commands: cmds,
      epoch: versFlottantPy(epoch),
      plugin_current: greffon.version,
    });
  };

  const ingerer = async (req: FastifyRequest): Promise<Dict> => {
    const uid = compteVerifie(req);
    const body = corps(req);
    const cid = texte(body, "client");
    const directory = ouPy(getPy(body, "directory"), "");
    let version: number | bigint;
    try {
      version = entierExactPy(ouPy(getPy(body, "plugin"), 0));
    } catch (e) {
      if (!estErreurTypeOuValeur(e)) throw e;
      version = 0;
    }
    await magasin.seenClient(uid, cid, version, directory, true);
    let events = getPy(body, "events");
    if (!Array.isArray(events)) events = veritePy(getPy(body, "type")) ? [body] : [];
    const lot = (events as unknown[]).filter(
      (ev): ev is Dict => estDict(ev) && transmis(ouPy(getPy(ev, "type"), "")),
    );
    const applied = await magasin.applyEvents(uid, lot, cid, directory);
    for (const ev of lot) {
      const typ = itemPy(ev, "type") as string;
      const props = ouPy(getPy(ev, "properties"), {});
      if (typ === "session.snapshot") {
        publier(uid, { type: typ, properties: { session: ouPy(getPy(props, "session"), {}) } });
      } else if (typ === "permission.updated" || typ === "permission.asked") {
        const norme = normalizePermission(props);
        if (norme) publier(uid, { type: "permission.updated", properties: norme });
      } else if (typ === "permission.replied") {
        const id = getPy(props, "permissionID");
        publier(uid, {
          type: "permission.replied",
          properties: {
            sessionID: getPy(props, "sessionID"),
            permissionID: veritePy(id) ? id : getPy(props, "requestID"),
          },
        });
      } else if (typ === "question.asked") {
        const norme = normalizeQuestion(props);
        if (norme) publier(uid, { type: "question.asked", properties: norme });
      } else if (typ === "question.replied" || typ === "question.rejected") {
        const id = getPy(props, "requestID");
        publier(uid, {
          type: typ,
          properties: {
            sessionID: getPy(props, "sessionID"),
            questionID: veritePy(id) ? id : getPy(props, "questionID"),
          },
        });
      } else {
        publier(uid, { type: typ, properties: props });
      }
    }
    await magasin.prune();
    return { ok: true, applied };
  };

  /** Compte des demandes de l'adresse et insertion dans une même transaction, sous le verrou de cette adresse. */
  const appairer = async (req: FastifyRequest): Promise<Dict> => {
    const ip = adressePair(req);
    const t = horloge();
    const [pid, code] = await dep.base.transaction(async (x): Promise<[string, string]> => {
      await verrouCle(x, VERROU_PAIR_ADRESSE, ip);
      await x.run("DELETE FROM code_pairings WHERE expires_at<?", [reel(t)]);
      const r = await x.get<{ n: unknown }>(
        "SELECT COUNT(*) AS n FROM code_pairings WHERE ip=? AND created_at>?",
        [ip, reel(t - PAIR_TTL)],
      );
      if (r && Number(r.n) >= PAIR_MAX_PER_IP)
        throw new HttpError(429, "Trop de demandes d'appairage — réessayez dans quelques minutes.");
      const nouveau = await nouveauCode(x);
      const id = alea.jeton(16);
      await x.run("INSERT INTO code_pairings(id,code,ip,created_at,expires_at) VALUES(?,?,?,?,?)", [
        id,
        nouveau,
        ip,
        reel(t),
        reel(t + PAIR_TTL),
      ]);
      return [id, nouveau];
    });
    return { id: pid, code: code.slice(0, 3) + "-" + code.slice(3), expires_in: PAIR_TTL, interval: 3 };
  };

  const sonder = async (req: FastifyRequest): Promise<Dict> => {
    const pid = requete(req, "id")["id"] ?? "";
    const t = horloge();
    const sortie = await dep.base.transaction(async (x): Promise<Dict> => {
      const r = await x.get<{ expires_at: unknown; confirmed_uid: unknown }>(
        "SELECT expires_at, confirmed_uid FROM code_pairings WHERE id=?",
        [pid],
      );
      if (!r) throw new HttpError(404, "Demande d'appairage inconnue.");
      const expire = flottantStrictPy(ouPy(r.expires_at, 0));
      const uid = r.confirmed_uid;
      if (veritePy(uid) && t <= expire) {
        try {
          await verifierQuota(x, Number(uid), politique(dep.auth.config()), t);
        } catch (e) {
          if (e instanceof ErreurJeton) throw new HttpError(409, e.message);
          throw e;
        }
      }
      if (t > expire || veritePy(uid)) {
        const fait = await x.run("DELETE FROM code_pairings WHERE id=?", [pid]);
        if (t > expire) return { status: "expired" };
        if (fait.changes) return { status: "ok", uid: Number(uid) };
        throw new HttpError(404, "Demande d'appairage inconnue.");
      }
      return { status: "pending" };
    });
    if (sortie["status"] !== "ok") return sortie;
    return { status: "ok", token: await creerJetonOpencode(sortie["uid"] as number, "opencode (appairage)") };
  };

  /** Compteur d'échecs du compte lu, vérifié et réécrit dans la même transaction que la confirmation, sous le verrou du compte. */
  const confirmer = async (req: FastifyRequest): Promise<Dict> => {
    const uid = utilisateur(req);
    const body = corps(req);
    const code = Array.from(texte(body, "code").toUpperCase()).filter(estAlnumPy).join("");
    if (!code) throw new HttpError(422, "Code d'appairage vide.");
    const t = horloge();
    const issue = await dep.base.transaction(async (x): Promise<"trop" | "inconnu" | "ok"> => {
      await verrouCle(x, VERROU_PAIR_COMPTE, String(uid));
      const brut = await magasin.metaGet(uid, "pair_fail", x);
      let echecs: unknown;
      try {
        echecs = pyJsonLoads(ouPy(brut, "{}") as string);
        if (!estDict(echecs)) echecs = {};
      } catch {
        echecs = {};
      }
      let n = Number(entierExactPy(ouPy(getPy(echecs, "n"), 0)));
      let depuis = flottantStrictPy(ouPy(getPy(echecs, "since"), 0));
      if (t - depuis > PAIR_TTL) {
        n = 0;
        depuis = t;
      }
      if (n >= PAIR_CONFIRM_MAX) return "trop";
      let id = "";
      await x.run("DELETE FROM code_pairings WHERE expires_at<?", [reel(t)]);
      const lignes = await x.valeurs<[unknown, unknown]>(
        "SELECT id, code FROM code_pairings WHERE confirmed_uid IS NULL ORDER BY created_at",
      );
      for (const [pid, pcode] of lignes) if (compareDigest(strPy(pcode), code) && !id) id = strPy(pid);
      const pose = id
        ? await x.run("UPDATE code_pairings SET confirmed_uid=? WHERE id=? AND confirmed_uid IS NULL", [
            uid,
            id,
          ])
        : null;
      if (!pose?.changes) {
        await magasin.metaSet(uid, "pair_fail", pyJsonDumps({ n: n + 1, since: versFlottantPy(depuis) }), x);
        return "inconnu";
      }
      await magasin.metaSet(uid, "pair_fail", pyJsonDumps({ n: 0, since: versFlottantPy(t) }), x);
      return "ok";
    });
    if (issue === "trop")
      throw new HttpError(429, "Trop d'essais de code — réessayez dans quelques minutes.");
    if (issue === "inconnu") throw new HttpError(404, "Code d'appairage inconnu ou expiré.");
    return { ok: true };
  };

  const repondreQuestion = async (req: FastifyRequest): Promise<Dict> => {
    const uid = utilisateur(req);
    const body = corps(req);
    const refus = veritePy(getPy(body, "reject"));
    let reponses: string[][] | null = null;
    if (!refus) {
      const brut = getPy(body, "answers");
      if (!Array.isArray(brut) || brut.length === 0 || brut.length > QUESTION_MAX_QUESTIONS)
        throw new HttpError(422, REPONSE_LISTE);
      reponses = [];
      for (const brute of brut) {
        const a: unknown = typeof brute === "string" ? [brute] : brute;
        if (!Array.isArray(a) || a.length > QUESTION_MAX_OPTIONS)
          throw new HttpError(422, "Réponse invalide — chaque entrée est une liste de libellés.");
        reponses.push(a.filter(libelle).map((x) => prefixePy(stripPy(strPy(x)), QUESTION_MAX_TEXT)));
      }
      if (!reponses.some((l) => l.length > 0))
        throw new HttpError(422, "Réponse vide — choisissez une option ou saisissez un texte.");
    }
    await exigerCli(uid);
    if ((await magasin.minPluginVersion(uid)) < 14)
      throw new HttpError(
        409,
        "Le plugin elpis-remote v14 est requis pour répondre aux questions — tapez /remote update côté CLI.",
      );
    const cmd: Dict = {
      id: alea.jeton(8),
      sid: parametre(req, "sid"),
      kind: "question",
      questionID: parametre(req, "qid"),
    };
    if (refus) cmd["response"] = "reject";
    else cmd["answers"] = reponses;
    await magasin.queueCommand(uid, cmd);
    return ok;
  };

  const ciblerClient = (kind: "disconnect" | "exit", objet: string) => async (req: FastifyRequest) => {
    const uid = utilisateur(req);
    const cid = parametre(req, "cid");
    if (!(await magasin.activeClients(uid)).includes(cid)) throw new HttpError(409, PLUS_CONNECTEE);
    if ((await magasin.clientPluginVersion(uid, cid)) < 7)
      throw new HttpError(
        409,
        `Le plugin elpis-remote v7 est requis pour ${objet} — tapez /remote update côté CLI.`,
      );
    await magasin.queueCommand(uid, { id: alea.jeton(8), sid: "", kind, target: cid });
    return { ok: true, queued: true, client: cid };
  };

  const noter = async (uid: number, sid: string, id: string, kind: string, label: string, detail = "") => {
    const note = await magasin.addNote(uid, sid, id, kind, label, detail);
    publier(uid, { type: "code.note", properties: { sessionID: sid, note } });
  };

  return {
    nom: "code",
    /** 404 si la fonction est coupée, jeton avant le corps ; `pair/start` ne lit jamais le sien (Python non plus). */
    contexte: (app) => {
      app.addHook("onRequest", async (requete) => {
        const url = requete.routeOptions.url ?? "";
        if (!featureEnabled("opencode")) throw new HttpError(404, INACTIF);
        if (ROUTES_JETON.has(url)) comptesVerifies.set(requete, await compteDuJeton(requete));
      });
      installerCorpsBorne(app, (req) =>
        req.routeOptions.url === "/api/code/pair/start" ? { limite: 0, avant: () => false } : null,
      );
    },
    routes: [
      {
        methode: "GET",
        chemin: "/api/code/health",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          for (const perdue of await magasin.sweepUndeliverable(uid)) {
            if (!perdue.sid) continue;
            await noter(
              uid,
              perdue.sid,
              perdue.id + ":lost",
              "error",
              "Non délivré",
              "CLI opencode déconnectée",
            );
          }
          const connected =
            (await magasin.activeClients(uid)).length > 0 ||
            horloge() - (await magasin.lastIngest(uid)) < CLIENT_TTL;
          return {
            available: true,
            connected,
            sessions: await magasin.sessionCount(uid),
            plugin_version: await magasin.minPluginVersion(uid),
            plugin_current: greffon.version,
          };
        },
      },
      {
        methode: "GET",
        chemin: "/api/code/config",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          const base = urlDeBase(req);
          const n = (await listerJetons(dep.base, uid)).filter((t) => t.kind === "opencode").length;
          return { app_url: base, plugin_url: `${base}/api/code/plugin.ts`, tokens: n };
        },
      },
      {
        methode: "POST",
        chemin: "/api/code/token",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          return { token: await creerJetonOpencode(uid, texte(corps(req), "name")) };
        },
      },
      {
        methode: "POST",
        chemin: "/api/code/token/rotate",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          await revoquerType(dep.base, uid, "opencode");
          return { token: await creerJetonOpencode(uid, "") };
        },
      },
      {
        methode: "GET",
        chemin: "/api/code/plugin.ts",
        processus: ["main"],
        acces: "public",
        traiter: (req, rep) =>
          rep
            .header("content-type", "application/typescript; charset=utf-8")
            .send(remplacerTout(greffon.ts, "__APP_URL__", urlDeBase(req))),
      },
      {
        methode: "GET",
        chemin: "/api/code/plugin.js",
        processus: ["main"],
        acces: "public",
        traiter: (req, rep) =>
          rep
            .header("content-type", "text/javascript; charset=utf-8")
            .send(remplacerTout(greffon.js, "__APP_URL__", urlDeBase(req))),
      },
      {
        methode: "GET",
        chemin: "/api/code/hello",
        processus: ["main"],
        acces: "public",
        traiter: async (req) => {
          const uid = compteVerifie(req);
          const nom = await getUsernameById(dep.base, uid).catch(() => null);
          return { ok: true, user: nom || `user #${uid}` };
        },
      },
      {
        methode: "POST",
        chemin: "/api/code/pair/start",
        processus: ["main"],
        acces: "public",
        traiter: appairer,
      },
      {
        methode: "GET",
        chemin: "/api/code/pair/poll",
        processus: ["main"],
        acces: "public",
        traiter: sonder,
      },
      {
        methode: "POST",
        chemin: "/api/code/pair/confirm",
        processus: ["main"],
        acces: "session",
        traiter: confirmer,
      },
      { methode: "POST", chemin: "/api/code/ingest", processus: ["main"], acces: "public", traiter: ingerer },
      { methode: "GET", chemin: "/api/code/pull", processus: ["main"], acces: "public", traiter: tirer },
      {
        methode: "GET",
        chemin: "/api/code/sessions",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => reponseJsonPy(rep, await magasin.sessionsList(utilisateur(req))),
      },
      {
        methode: "GET",
        chemin: "/api/code/sessions/:sid/messages",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) =>
          reponseJsonPy(rep, await magasin.messagesList(utilisateur(req), parametre(req, "sid"))),
      },
      {
        methode: "POST",
        chemin: "/api/code/sessions/:sid/prompt",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          const body = corps(req);
          const text = stripPy(texte(body, "text"));
          if (!text) throw new HttpError(422, "Prompt vide.");
          await exigerCli(uid);
          const cmd: Dict = { id: alea.jeton(8), sid: parametre(req, "sid"), kind: "prompt", text };
          const modele = getPy(body, "model");
          if (estDict(modele) && veritePy(getPy(modele, "providerID")) && veritePy(getPy(modele, "modelID")))
            cmd["model"] = { providerID: strPy(modele["providerID"]), modelID: strPy(modele["modelID"]) };
          const agent = stripPy(texte(body, "agent"));
          if (agent) {
            const liste = (await magasin.agentsList(uid))["agents"];
            const connus = new Set(
              (veritePy(liste) ? (liste as unknown[]) : []).map((a) => itemPy(a, "name")),
            );
            if (connus.size > 0 && !connus.has(agent)) throw new HttpError(422, `Agent inconnu (${agent}).`);
            cmd["agent"] = agent;
          }
          await magasin.queueCommand(uid, cmd);
          return ok;
        },
      },
      {
        methode: "GET",
        chemin: "/api/code/commands",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => reponseJsonPy(rep, await magasin.commandsList(utilisateur(req))),
      },
      {
        methode: "GET",
        chemin: "/api/code/models",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => reponseJsonPy(rep, await magasin.modelsList(utilisateur(req))),
      },
      {
        methode: "GET",
        chemin: "/api/code/agents",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => reponseJsonPy(rep, await magasin.agentsList(utilisateur(req))),
      },
      {
        methode: "POST",
        chemin: "/api/code/sessions/:sid/command",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          const sid = parametre(req, "sid");
          const body = corps(req);
          const command = stripPy(texte(body, "command")).replace(/^\/+/u, "");
          if (!command) throw new HttpError(422, "Commande vide.");
          if (command === "remote")
            throw new HttpError(422, "/remote se pilote depuis la CLI (couperait la remontée).");
          await exigerCli(uid);
          const args = texte(body, "arguments");
          const id = alea.jeton(8);
          await magasin.queueCommand(uid, { id, sid, kind: "command", command, arguments: args });
          await noter(uid, sid, id, "command", "/" + command, args);
          return ok;
        },
      },
      {
        methode: "POST",
        chemin: "/api/code/sessions/:sid/abort",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          await exigerCli(uid, "Aucune CLI opencode connectée.");
          await magasin.queueCommand(uid, { id: alea.jeton(8), sid: parametre(req, "sid"), kind: "abort" });
          return ok;
        },
      },
      {
        methode: "POST",
        chemin: "/api/code/sessions/:sid/action",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          const sid = parametre(req, "sid");
          const action = stripPy(texte(corps(req), "action"));
          if (!ACTIONS.has(action)) throw new HttpError(422, `Action inconnue (${action || "vide"}).`);
          await exigerCli(uid);
          if (action === "delete") {
            const proprietaire = await magasin.sessionOwner(uid, sid);
            if ((await magasin.clientPluginVersion(uid, proprietaire)) < 7)
              throw new HttpError(
                409,
                "Le plugin elpis-remote v7 est requis pour supprimer — tapez /remote update côté CLI.",
              );
          }
          const id = alea.jeton(8);
          await magasin.queueCommand(uid, { id, sid, kind: "action", action });
          if (action !== "delete") await noter(uid, sid, id, "action", "/" + action);
          return ok;
        },
      },
      {
        methode: "GET",
        chemin: "/api/code/clients",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => reponseJsonPy(rep, await magasin.clientsList(utilisateur(req))),
      },
      {
        methode: "POST",
        chemin: "/api/code/clients/:cid/disconnect",
        processus: ["main"],
        acces: "session",
        traiter: ciblerClient("disconnect", "déconnecter"),
      },
      {
        methode: "POST",
        chemin: "/api/code/clients/:cid/exit",
        processus: ["main"],
        acces: "session",
        traiter: ciblerClient("exit", "/exit"),
      },
      {
        methode: "POST",
        chemin: "/api/code/new",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          let cible = texte(corps(req), "client");
          const actifs = await exigerCli(uid);
          if (!cible) {
            if (actifs.length > 1)
              throw new HttpError(409, "Plusieurs CLI connectées — précisez la CLI cible.");
            cible = actifs[0] ?? "";
          } else if (!actifs.includes(cible)) throw new HttpError(409, PLUS_CONNECTEE);
          if ((await magasin.clientPluginVersion(uid, cible)) < 13)
            throw new HttpError(
              409,
              "Le plugin elpis-remote v13 est requis pour créer une session depuis la page — tapez /remote update côté CLI.",
            );
          await magasin.queueCommand(uid, {
            id: alea.jeton(8),
            sid: "",
            kind: "action",
            action: "new",
            target: cible,
          });
          return { ok: true, queued: true, client: cible };
        },
      },
      {
        methode: "DELETE",
        chemin: "/api/code/sessions/:sid",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          await magasin.dismissSession(utilisateur(req), parametre(req, "sid"));
          return { ok: true };
        },
      },
      {
        methode: "POST",
        chemin: "/api/code/bye",
        processus: ["main"],
        acces: "public",
        traiter: async (req) => {
          const uid = compteVerifie(req);
          const cid = texte(corps(req), "client");
          await magasin.clientBye(uid, cid);
          publier(uid, { type: "client.disconnected", properties: { client: cid } });
          return { ok: true };
        },
      },
      {
        methode: "POST",
        chemin: "/api/code/sessions/:sid/rename",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          const titre = splitPy(texte(corps(req), "title")).join(" ");
          if (!titre || longueurPy(titre) > 200)
            throw new HttpError(422, "Titre vide ou trop long (200 caractères max).");
          await exigerCli(uid);
          if ((await magasin.minPluginVersion(uid)) < 5)
            throw new HttpError(
              409,
              "Le plugin elpis-remote v5 est requis pour renommer — tapez /remote update côté CLI.",
            );
          await magasin.queueCommand(uid, {
            id: alea.jeton(8),
            sid: parametre(req, "sid"),
            kind: "rename",
            title: titre,
          });
          return ok;
        },
      },
      {
        methode: "GET",
        chemin: "/api/code/sessions/:sid/permissions",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) =>
          reponseJsonPy(rep, await magasin.permissionsList(utilisateur(req), parametre(req, "sid"))),
      },
      {
        methode: "POST",
        chemin: "/api/code/sessions/:sid/permissions/:pid",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          const reponse = stripPy(texte(corps(req), "response"));
          if (!["once", "always", "reject"].includes(reponse))
            throw new HttpError(422, `Réponse invalide (${reponse || "vide"}) — once, always ou reject.`);
          await exigerCli(uid);
          await magasin.queueCommand(uid, {
            id: alea.jeton(8),
            sid: parametre(req, "sid"),
            kind: "permission",
            permissionID: parametre(req, "pid"),
            response: reponse,
          });
          return ok;
        },
      },
      {
        methode: "GET",
        chemin: "/api/code/sessions/:sid/questions",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) =>
          reponseJsonPy(rep, await magasin.questionsList(utilisateur(req), parametre(req, "sid"))),
      },
      {
        methode: "POST",
        chemin: "/api/code/sessions/:sid/questions/:qid",
        processus: ["main"],
        acces: "session",
        traiter: repondreQuestion,
      },
      {
        methode: "GET",
        chemin: "/api/code/stream",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => {
          const uid = utilisateur(req);
          const loginTs = req.session.get("_login_ts");
          const sid = req.session.get("_sid");
          await servirFluxSse(
            rep,
            (signal) =>
              dep.bus.listen(uid, {
                validityCheck: () => revaliderFlux(dep.auth, uid, loginTs, sid),
                render: rendreEvenementCode,
                signal,
              }),
            { journal, arret: dep.arret, pingMs: dep.pingMs, graceMs: dep.graceArretMs },
          );
        },
      },
    ],
  };
}
