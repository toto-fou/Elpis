// SPDX-License-Identifier: MIT
/** apps/core/src/familles/webhooks.ts — livraison publique d'un webhook de routine (scheduling/routes_webhooks.py) : signature HMAC du corps brut ou jeton, réponses indifférenciées, filtres, dédup, débit par IP. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";

import {
  ErreurJsonPy,
  ErreurLecturePy,
  ErreurPython,
  ErreurValidation,
  estDict,
  estErreurAnnulation,
  getPy,
  HttpError,
  intPy,
  iterExige,
  lire,
  lowerPy,
  nomTypePy,
  ouPy,
  pyJsonLoads,
  reprPy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Base } from "@elpis/db";
import type { FastifyReply, FastifyRequest } from "fastify";

import { journal } from "../journal";
import {
  forgetWebhookDelivery,
  getRoutineInternal,
  getRoutineWebhookSecret,
  recordWebhookDelivery,
} from "../routines/magasin";
import type { Planificateur } from "../routines/planificateur";
import { brancheDe, CORPS_MAX, LimiteurDebit, resumeEvenement } from "../routines/webhooks";
import type { Famille } from "../routes";
import { entrees, py, reponseJsonPy } from "@elpis/http";

export interface DependancesWebhooks {
  readonly base: Base;
  readonly planificateur: Planificateur;
}

const CHEMIN = "/api/webhooks/routines/:routine_id";
const TROP_GROS = { ok: false, error: "payload trop volumineux" };
const log = journal("webhooks");

/** Réponse décidée avant la lecture du corps (débit, taille) : écrite telle quelle par le gestionnaire de la famille. */
class ReponseWebhook extends Error {
  readonly statut: number;
  readonly corps: Dict;

  constructor(statut: number, corps: Dict) {
    super(String(corps["error"] ?? ""));
    this.statut = statut;
    this.corps = corps;
  }
}

/** Livraison lue : id de la routine (`null` au-delà de 2^53 : inexistante, comme hors des bornes de SQLite) et octets reçus. */
interface Livraison {
  readonly id: number | null;
  readonly brut: Buffer;
}

/** `request.headers.get(nom)` de Starlette : la première occurrence, "" si absente. */
function entete(req: FastifyRequest, nom: string): string {
  const brut = req.raw.rawHeaders;
  for (let i = 0; i + 1 < brut.length; i += 2)
    if ((brut[i] ?? "").toLowerCase() === nom) return brut[i + 1] ?? "";
  return "";
}

/** `request.client.host` sous uvicorn : IPv4 transposée en IPv6 ramenée à IPv4. */
function hoteClient(req: FastifyRequest): string {
  const ip = req.ip;
  return ip.startsWith("::ffff:") && ip.includes(".") ? ip.slice(7) : ip;
}

/** Id du chemin (422 s'il n'est pas entier) ; au-delà de 2^53, `null` plutôt que le 400 de l'E19 : pas d'oracle. */
function idDuChemin(req: FastifyRequest): number | null {
  try {
    return entrees(req, { path: { routine_id: py.int() } }).path.routine_id;
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 400) return null;
    throw e;
  }
}

/** `hmac.compare_digest` sur octets : longueurs différentes = faux, sans court-circuit sur le contenu. */
function egalConstant(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** `(x or "").strip()` d'une valeur du filtre : autre chose qu'une chaîne lève comme Python. */
function texteFiltre(v: unknown): string {
  const t = ouPy(v, "");
  if (typeof t !== "string")
    throw new ErreurPython("AttributeError", `'${nomTypePy(t)}' object has no attribute 'strip'`);
  return stripPy(t);
}

/** `json.loads(raw.decode("utf-8", errors="replace")) or {}`, `{}` hors dict ou sur ValueError. */
function lirePayload(brut: Buffer): Dict {
  try {
    const v = pyJsonLoads(brut.toString("utf8"));
    return estDict(v) ? v : {};
  } catch (e) {
    if (e instanceof ErreurJsonPy || (e instanceof ErreurLecturePy && e.nature !== "RecursionError"))
      return {};
    throw e;
  }
}

/** Raison du refus du filtre de la routine, `null` si la livraison passe. */
function horsFiltre(r: Dict, event: string, payload: Dict): string | null {
  const flt = ouPy(r["webhook_filter"], {});
  const events: string[] = [];
  for (const e of iterExige(ouPy(getPy(flt, "events"), []))) {
    const s = stripPy(strPy(e));
    if (s) events.push(lowerPy(s));
  }
  if (events.length && !events.includes(event)) return `event ${reprPy(event)} hors filtre`;
  const branche = texteFiltre(getPy(flt, "branch"));
  if (branche && brancheDe(event, payload) !== branche) return "branche hors filtre";
  const depot = lowerPy(texteFiltre(getPy(flt, "repo")));
  if (depot) {
    const repository = lire(payload, "repository");
    const depotRecu = estDict(repository) ? lire(repository, "full_name") : undefined;
    if (lowerPy(strPy(ouPy(depotRecu, ""))) !== depot) return "dépôt hors filtre";
  }
  return null;
}

/** Secret présenté par signature HMAC (prioritaire, elle fait foi) ou par jeton ; aucune valeur journalisée. */
function authentifier(req: FastifyRequest, secret: string, brut: Buffer): [boolean, string] {
  let sig = stripPy(
    entete(req, "x-gitea-signature") ||
      entete(req, "x-hub-signature-256") ||
      entete(req, "x-webhook-signature"),
  );
  if (lowerPy(sig).startsWith("sha256=")) sig = sig.slice("sha256=".length);
  const parRequete = entrees(req, { query: { token: py.str().defaut("") } }).query.token;
  const jeton = stripPy(entete(req, "x-webhook-token") || parRequete);
  const nature = sig ? "signature" : jeton ? "token" : "absent";
  if (sig) {
    const attendu = createHmac("sha256", Buffer.from(secret, "utf8")).update(brut).digest("hex");
    return [egalConstant(Buffer.from(attendu, "ascii"), Buffer.from(lowerPy(sig), "utf8")), nature];
  }
  if (jeton) return [egalConstant(Buffer.from(secret, "utf8"), Buffer.from(jeton, "utf8")), nature];
  return [false, nature];
}

/** Route publique : routine absente, désactivée, sans secret ou mauvais secret répondent le même 202 ; une panne (500) se journalise sans la requête (`?token=`). */
export function creerFamilleWebhooks(dep: DependancesWebhooks): Famille {
  const { base, planificateur } = dep;
  const debit = new LimiteurDebit();
  const livraisons = new WeakMap<FastifyRequest, Livraison>();
  const ok = (rep: FastifyReply, extra: Dict = {}): FastifyReply =>
    reponseJsonPy(rep.code(202), { ok: true, ...extra });

  /** Avant toute lecture, comme Python : chemin (422), débit (429), longueur annoncée (413) ; puis lecture bornée en flux. */
  async function lireLivraison(
    req: FastifyRequest,
    charge: AsyncIterable<unknown> | Iterable<unknown>,
  ): Promise<Livraison> {
    const id = idDuChemin(req);
    if (debit.limite(hoteClient(req))) throw new ReponseWebhook(429, { ok: false, error: "rate limited" });
    let annonce: number;
    try {
      annonce = intPy(req.headers["content-length"] || 0);
    } catch {
      annonce = 0;
    }
    if (annonce > CORPS_MAX) throw new ReponseWebhook(413, TROP_GROS);
    const morceaux: Buffer[] = [];
    let total = 0;
    for await (const m of charge) {
      const octets = Buffer.isBuffer(m) ? m : Buffer.from(m as string);
      total += octets.length;
      if (total > CORPS_MAX) throw new ReponseWebhook(413, TROP_GROS);
      morceaux.push(octets);
    }
    const livraison = { id, brut: Buffer.concat(morceaux) };
    livraisons.set(req, livraison);
    return livraison;
  }

  async function livrer(req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> {
    const { id, brut } = livraisons.get(req) ?? (await lireLivraison(req, []));
    if (id === null) return ok(rep);
    const r = await getRoutineInternal(base, id);
    const secret = r ? await getRoutineWebhookSecret(base, id) : null;
    if (!r || !veritePy(r["enabled"]) || !veritePy(r["webhook_enabled"]) || !secret) return ok(rep);
    const ip = hoteClient(req);
    const [authentifie, nature] = authentifier(req, secret, brut);
    if (!authentifie) {
      log.warn(`[webhooks] secret invalide routine=${id} ip=${ip} (${nature})`);
      return ok(rep);
    }
    let event = lowerPy(
      stripPy(
        entete(req, "x-gitea-event") || entete(req, "x-github-event") || entete(req, "x-webhook-event"),
      ),
    );
    const payload = lirePayload(brut);
    const champEvent = lire(payload, "event");
    if (!event && typeof champEvent === "string") event = lowerPy(stripPy(champEvent));
    const raison = horsFiltre(r, event, payload);
    if (raison !== null) return ok(rep, { filtered: true, reason: raison });
    const livraison = stripPy(
      entete(req, "x-gitea-delivery") ||
        entete(req, "x-github-delivery") ||
        entete(req, "x-webhook-delivery"),
    );
    const contexte = resumeEvenement(event, payload);
    if (livraison && !(await recordWebhookDelivery(base, livraison, id))) return ok(rep, { duplicate: true });
    let runId: number | null;
    try {
      runId = await planificateur.lancerRun(r, { trigger: "webhook", context: contexte });
    } catch (e) {
      if (estErreurAnnulation(e)) throw e;
      if (livraison) await forgetWebhookDelivery(base, livraison, id);
      const exc = e instanceof Error ? `${e.name}(${reprPy(e.message)})` : reprPy(e);
      log.warn(
        `[webhooks] routine=${id} : lancement échoué (${exc}) — dédup retirée, l'émetteur peut retenter`,
      );
      return reponseJsonPy(rep.code(503), {
        ok: false,
        error: "lancement temporairement impossible, retentez",
      });
    }
    if (runId === null) return ok(rep, { skipped: true });
    log.info(`[webhooks] routine=${id} run=${runId} event=${event || "?"} ip=${ip}`);
    return ok(rep, { run_id: runId });
  }

  return {
    nom: "webhooks",
    contexte: (app) => {
      app.setErrorHandler((erreur, req, rep) => {
        if (erreur instanceof ReponseWebhook) return reponseJsonPy(rep.code(erreur.statut), erreur.corps);
        const statut = (erreur as { statusCode?: unknown } | null)?.statusCode;
        if (erreur instanceof HttpError || erreur instanceof ErreurValidation) throw erreur;
        if (typeof statut === "number" && statut >= 400 && statut < 500) throw erreur;
        log.error({ err: erreur }, `500 sur ${req.method} ${req.url.split("?", 1)[0] ?? ""}`);
        return rep.code(500).type("text/plain; charset=utf-8").send("Internal Server Error");
      });
      app.addHook("preParsing", async (req, _rep, charge) => {
        if (req.routeOptions.url !== CHEMIN) return charge;
        const { brut } = await lireLivraison(req, charge);
        const flux = Readable.from([brut], { objectMode: false }) as Readable & {
          receivedEncodedLength?: number;
        };
        flux.receivedEncodedLength = brut.length;
        return flux;
      });
    },
    routes: [{ methode: "POST", chemin: CHEMIN, processus: ["main"], acces: "public", traiter: livrer }],
  };
}
