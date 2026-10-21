// SPDX-License-Identifier: MIT
/** apps/core/src/tour/image.ts — tour « Images » : pré-vol HTTP, puis la demande part au moteur d'images sous le même verrou, le même Stop et le même journal reprenable qu'un tour du modèle ; un client parti laisse le tour finir et persister (chatbot_app/turn/image.py). */
import { randomBytes } from "node:crypto";

import {
  estDict,
  estErreurAnnulation,
  getOu,
  HttpError,
  intPy,
  longueurPy,
  prefixePy,
  splitPy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Base } from "@elpis/db";
import type { FastifyReply } from "fastify";

import { enforceRecentChatsCap, getChat, setTitleIfDefault, upsertChat } from "../chats/stockage";
import {
  buildStateSystemMessage,
  extractCompressionState,
  stripSummaryMessages,
} from "../contexte/etat-compression";
import { runScope } from "../executions/registre";
import { enabledIn, readSettings, userAllowed } from "../images/acces";
import { decodeB64, ImageError } from "../images/base";
import type { ImageRequest } from "../images/base";
import { getImageConfig, imageReady } from "../images/config";
import type { ConfigImage } from "../images/config";
import { enhancePrompt } from "../images/enrichissement";
import { readBytes, validId } from "../images/magasin";
import type { RefImage } from "../images/magasin";
import { caption, failureCaption, sanitizeRequest } from "../images/messages";
import { buildRequest, capabilities, generateAndStore, modelName, ProgressTracker } from "../images/service";
import { journal } from "../journal";
import { canUseEngine } from "../llm/acces-moteurs";
import { EngineUnavailable, resolveLlmTarget, useLlmTarget } from "../llm/cible";
import type { LlmTarget } from "../llm/cible";
import { BUILTIN_KEY, connectorKey } from "../llm/moteurs";
import {
  acquireGenPresence,
  handoverRebaselineOk,
  reclamerVerrou,
  reserverVerrou,
  verifierPlafondRuns,
} from "./admission";
import {
  clearChatCancellation,
  isChatCancelled,
  registerChatTask,
  unregisterChatTask,
  verrousChat,
} from "./etat";
import { DELAI, FileEvenements } from "./evenements";
import { graftStoppedTurnState, msgText, normalizeClientMessages } from "./historique";
import { RunJournal } from "./journal-run";
import { ligneNdjson } from "./ndjson";
import { persistTurn } from "./persistance";
import type { Persister } from "./persistance";
import { ouvrirFlux } from "@elpis/http";
import type { SortieFlux } from "@elpis/http";

const log = journal("image");

const QUEUE_MAX = 200;
const STOPPED = "Génération arrêtée.";
const CHAT_ID_MAX = 191;
/** Images jointes acceptées comme source d'une édition. */
const SOURCE_URL = /^data:image\/(png|jpeg|jpg|webp)[;,]/iu;

const reglages = { pingS: 15.0, attenteStopS: 15.0 };

/** Silence avant un `ping` et attente de la fin d'un tour stoppé (tests) ; `null` rétablit. */
export function reglerTourImagePourTests(r: Partial<typeof reglages> | null): void {
  Object.assign(reglages, { pingS: 15.0, attenteStopS: 15.0 }, r ?? {});
}

/** Première image jointe (`image_url` en data URL) du message ; `ImageError` invalid si elle n'est ni PNG, ni JPEG, ni WEBP. */
export function sourceFromMessage(content: unknown): Uint8Array | null {
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (!estDict(part) || part["type"] !== "image_url") continue;
    const iu = veritePy(part["image_url"]) ? part["image_url"] : {};
    if (!estDict(iu)) throw new Error(`'${typeof iu}' object has no attribute 'get'`);
    const url = strPy(veritePy(iu["url"]) ? iu["url"] : "");
    if (!url.startsWith("data:")) continue;
    if (!SOURCE_URL.test(url))
      throw new ImageError("Image jointe : PNG, JPEG ou WEBP seulement.", { code: "invalid", status: 400 });
    return decodeB64(url);
  }
  return null;
}

/** Message system d'état de compaction à re-préfixer (le client ne renvoie jamais les system) : sans lui, ce tour effacerait le résumé. */
function compressionCarry(existing: Dict | null): Dict[] {
  if (!existing) return [];
  try {
    const st = extractCompressionState(
      (veritePy(existing["messages"]) ? existing["messages"] : []) as unknown[],
    );
    if (!st || !st.summary_xml) return [];
    return [
      buildStateSystemMessage(
        st.summary_xml,
        intPy(st.round || 1),
        intPy(st.covered_turns || 0),
        null,
        st.ledger_block || "",
      ),
    ];
  } catch (e) {
    log.warn(`état de compaction illisible : persisté sans (${String(e)})`);
    return [];
  }
}

async function accessCheck(base: Base, uid: number, cfg: ConfigImage): Promise<string | null> {
  if (!(await userAllowed(base, uid, cfg))) return "La génération d'images n'est pas ouverte à votre compte.";
  if (!enabledIn(await readSettings(base, uid)))
    return "La génération d'images est désactivée dans vos Paramètres.";
  return null;
}

function erreurHttp(exc: ImageError): HttpError {
  const status =
    exc.status === 400 || exc.status === 404
      ? exc.status
      : ["unavailable", "timeout", "busy"].includes(exc.code)
        ? 503
        : 400;
  if (exc.detail) log.info(`pré-vol : ${exc.message} — ${exc.detail}`);
  return new HttpError(status, { code: exc.code, message: exc.message });
}

/** Cible du modèle qui enrichit la description : celle du chat, avec les mêmes droits qu'un tour texte (409 sinon). */
async function resolveEnhanceTarget(base: Base, uid: number, data: Dict): Promise<LlmTarget> {
  const brut = data["connector_id"] ?? null;
  let cid: number | null;
  try {
    cid = [null, "", 0, "0", false].includes(brut as never) ? null : intPy(brut);
  } catch {
    cid = null;
  }
  let cible: LlmTarget;
  try {
    cible = await resolveLlmTarget(uid, cid, typeof data["model"] === "string" ? data["model"] : null, {
      strict: true,
    });
  } catch (e) {
    if (e instanceof EngineUnavailable)
      throw new HttpError(409, { code: "engine_unavailable", reason: e.reason, message: e.message });
    throw e;
  }
  let autorise: boolean;
  try {
    autorise = await canUseEngine(base, uid, cid ? connectorKey(cid) : BUILTIN_KEY);
  } catch (e) {
    log.warn(`[image.engine_access] contrôle d'accès au moteur impossible (${String(e)}) — refus`);
    throw new HttpError(503, {
      code: "engine_unavailable",
      reason: "access_check_failed",
      message: "Contrôle d'accès au serveur indisponible, réessayez.",
    });
  }
  if (!autorise)
    throw new HttpError(409, {
      code: "engine_unavailable",
      reason: "forbidden",
      message: "Ce serveur ne vous est pas ouvert.",
    });
  return cible;
}

export interface DependancesTourImage {
  readonly base: Base;
  readonly arret?: AbortSignal | undefined;
}

interface BaseTour {
  updatedAt: unknown;
  messages: unknown;
  title: string;
}

interface ContexteTourImage {
  readonly db: Base;
  readonly uid: number;
  readonly chatId: string;
  readonly cfg: ConfigImage;
  readonly caps: Dict;
  readonly req: ImageRequest;
  readonly prompt: string;
  readonly data: Dict;
  readonly msgs: Dict[];
  readonly rawCount: number;
  readonly persist: Persister;
  readonly ephemeral: boolean;
  readonly resumable: boolean;
  readonly runId: string;
  readonly execId: string;
  readonly title: string;
  readonly titleGenerated: boolean;
  readonly base: BaseTour;
  readonly carry: Dict[];
  readonly enhanceTarget: LlmTarget | null;
}

/** Gardes communes déjà passées (`admettreTour`) : pré-vol, verrou de présence réservé, puis le flux NDJSON. */
export async function imageTurn(
  dep: DependancesTourImage,
  rep: FastifyReply,
  data: Dict,
  uid: number,
  chatIdDemande: string,
): Promise<void> {
  const cfg = getImageConfig();
  if (!imageReady(cfg))
    throw new HttpError(503, { code: "unavailable", message: "Aucun moteur d'images n'est configuré." });
  const refus = await accessCheck(dep.base, uid, cfg);
  if (refus) throw new HttpError(403, { code: "forbidden", message: refus });
  const opts = data["image_gen"];
  if (!estDict(opts)) throw new HttpError(400, "image_gen doit être un objet");
  const brut = veritePy(data["messages"]) ? data["messages"] : [];
  if (!Array.isArray(brut)) throw new HttpError(400, "messages doit être une liste");
  if (chatIdDemande && longueurPy(chatIdDemande) > CHAT_ID_MAX)
    throw new HttpError(400, "Conversation invalide.");
  const [messages, msgs] = normalizeClientMessages(brut);
  if (!msgs.length || msgs.at(-1)!["role"] !== "user")
    throw new HttpError(400, "messages: le dernier message doit être la demande");
  const prompt = stripPy(msgText(messages.at(-1)!["content"] ?? ""));

  const refId = validId(opts["ref_image_id"]) ? opts["ref_image_id"] : "";
  let caps: Dict;
  let req: ImageRequest;
  try {
    let source: Uint8Array | null;
    if (refId) {
      source = await readBytes(dep.base, uid, refId);
      if (source === null)
        throw new HttpError(404, { code: "invalid", message: "Image à modifier introuvable ou expirée." });
    } else source = sourceFromMessage(messages.at(-1)!["content"]);
    caps = await capabilities(cfg);
    req = await buildRequest(cfg, prompt, opts, caps, source);
  } catch (e) {
    if (e instanceof ImageError) throw erreurHttp(e);
    throw e;
  }
  const enhanceTarget =
    opts["enhance"] === true && cfg.enhance_enabled ? await resolveEnhanceTarget(dep.base, uid, data) : null;

  const ephemeral = veritePy(getOu(data, "ephemeral", false));
  const persist: Persister = ephemeral
    ? async () => null
    : (u, c, titre, m, ts, attendu) => upsertChat(dep.base, u, c, titre, m, ts, attendu);
  const chatId = chatIdDemande || randomBytes(12).toString("hex");
  let existing: Dict | null = null;
  let readFailed = false;
  try {
    existing = await getChat(dep.base, uid, chatId);
  } catch (e) {
    readFailed = true;
    log.warn(`lecture du chat ${Array.from(chatId).slice(0, 12).join("")} échouée : ${String(e)}`);
  }
  if (readFailed && !ephemeral) throw new HttpError(503, "Conversation momentanément illisible : réessayez.");
  if (existing)
    try {
      graftStoppedTurnState(messages, msgs, existing["messages"]);
    } catch (e) {
      log.debug(`[image.graft_stopped_turn_state] ${String(e)}`);
    }

  const titreLu = existing?.["title"];
  const base: BaseTour = {
    updatedAt: existing?.["updated_at"] ?? null,
    messages: existing?.["messages"] ?? null,
    title: stripPy(strPy(veritePy(titreLu) ? titreLu : "")),
  };
  const titleGenerated = !base.title || base.title === "Nouveau chat";
  const title = titleGenerated ? prefixePy(splitPy(prompt).join(" "), 28) || "Images" : base.title;
  msgs.at(-1)!["image_request"] = sanitizeRequest({
    size: `${req.width}x${req.height}`,
    n: req.n,
    seed: opts["seed"] ?? null,
    steps: opts["steps"] ?? null,
    negative_prompt: opts["negative_prompt"] ?? null,
    enhance: opts["enhance"] ?? null,
    strength: opts["strength"] ?? null,
    ref_image_id: refId,
    ratio: opts["ratio"] ?? null,
    side: opts["side"] ?? null,
    model: modelName(cfg, caps),
  });
  const runId = randomBytes(8).toString("hex");

  const passation: boolean[] = [];
  verifierPlafondRuns(uid, chatId);
  const jeton = await acquireGenPresence(uid, chatId, passation);
  if (passation.length && !ephemeral)
    try {
      const frais = await getChat(dep.base, uid, chatId);
      if (frais && handoverRebaselineOk(base.messages, frais["messages"]))
        Object.assign(base, {
          updatedAt: frais["updated_at"] ?? null,
          messages: frais["messages"] ?? null,
          title: stripPy(strPy(veritePy(frais["title"]) ? frais["title"] : "")),
        });
    } catch (e) {
      log.debug(`[image.handover_rebaseline] ${String(e)}`);
    }
  reserverVerrou(uid, chatId, jeton);
  const resumable = veritePy(getOu(data, "resumable", false)) && !ephemeral;
  if (resumable && titleGenerated && existing)
    try {
      await setTitleIfDefault(dep.base, uid, chatId, title);
    } catch (e) {
      log.debug(`[image.early_title] ${String(e)}`);
    }

  const tour = new TourImage({
    db: dep.base,
    uid,
    chatId,
    cfg,
    caps,
    req,
    prompt,
    data,
    msgs,
    rawCount: brut.length,
    persist,
    ephemeral,
    resumable,
    runId,
    execId: `image-${runId}`,
    title,
    titleGenerated,
    base,
    carry: compressionCarry(existing),
    enhanceTarget,
  });
  await tour.diffuser(rep, dep.arret);
}

/** Un tour « Images » : worker (génération, persistance, `final`) et flux NDJSON qui draine sa file. */
class TourImage {
  private readonly c: ContexteTourImage;
  private readonly q = new FileEvenements(QUEUE_MAX);
  private readonly controleur = new AbortController();
  private readonly tracker: ProgressTracker;
  private detache = false;
  private journalRun: RunJournal | null = null;

  constructor(c: ContexteTourImage) {
    this.c = c;
    this.tracker = new ProgressTracker(c.req);
  }

  /** Au journal sans l'aperçu (il pèse) ; une avancée périmée est perdue par un client lent. */
  private async emit(ev: Dict): Promise<void> {
    if (this.journalRun !== null) {
      this.journalRun.append(Object.fromEntries(Object.entries(ev).filter(([k]) => k !== "preview")));
      if (ev["type"] === "final") {
        const j = this.journalRun;
        this.journalRun = null;
        const statut = veritePy(ev["cancelled"])
          ? "cancelled"
          : veritePy(ev["image_error"])
            ? "error"
            : "done";
        void j.close(statut).catch(() => undefined);
      }
    }
    if (this.detache) return;
    if (ev["type"] === "image_progress" && this.q.taille >= QUEUE_MAX) return;
    await this.q.put(ev);
  }

  private ecrire(full: unknown[]): Promise<[boolean | null, string]> {
    const { db, uid, chatId, base } = this.c;
    const liste = this.c.carry.length ? [...this.c.carry, ...stripSummaryMessages(full)] : full;
    return persistTurn(this.c.persist, uid, chatId, this.c.title, liste, {
      baselineUpdatedAt: base.updatedAt,
      baselineMessages: base.messages,
      baselineTitle: base.title,
      readChat: (u, c) => getChat(db, u, c),
    });
  }

  private async persistQuestion(): Promise<void> {
    if (this.c.ephemeral) return;
    try {
      const [ok] = await this.ecrire([...this.c.msgs]);
      if (ok !== false) {
        const frais = await getChat(this.c.db, this.c.uid, this.c.chatId);
        Object.assign(this.c.base, {
          updatedAt: frais?.["updated_at"] ?? null,
          messages: frais?.["messages"] ?? null,
          title: this.c.title,
        });
      }
    } catch (e) {
      log.debug(`[image.persist_question] ${String(e)}`);
    }
  }

  private async worker(): Promise<void> {
    const { cfg, caps } = this.c;
    try {
      await runScope(
        "image",
        {
          runId: this.c.execId,
          userId: this.c.uid,
          chatId: this.c.chatId,
          model: modelName(cfg, caps),
          engine: cfg.provider,
          sampleSandbox: false,
        },
        async (run) => {
          const [statut, kind] = await this.corps();
          run.finish(statut, kind);
        },
      );
    } finally {
      const j = this.journalRun;
      this.journalRun = null;
      if (j !== null) await j.close("error").catch(() => undefined);
    }
  }

  private async corps(): Promise<[string, string]> {
    const { uid, chatId, cfg, caps, prompt, execId } = this.c;
    clearChatCancellation(uid, chatId);
    let refs: RefImage[] = [];
    let meta: Dict = {};
    let err: ImageError | null = null;
    let revised = "";
    try {
      await this.persistQuestion();
      this.controleur.signal.throwIfAborted();
      await this.emit({ type: "mode", kind: "image", text: "Génération d'image…" });
      await this.emit(this.tracker.event());
      if (this.c.enhanceTarget !== null) revised = await this.enrichir();
      ({ refs, meta } = await generateAndStore(cfg, this.c.req, {
        userId: uid,
        chatId: this.c.ephemeral ? null : chatId,
        prompt,
        caps,
        onProgress: () => this.emit(this.tracker.event()),
        signal: this.controleur.signal,
        tracker: this.tracker,
        extra: revised ? { revised_prompt: revised } : null,
        base: this.c.db,
      }));
      log.info(
        `user=${uid} chat=${Array.from(chatId).slice(0, 12).join("")} : ${refs.length} image(s) en ${(performance.now() / 1000 - this.tracker.t0).toFixed(1)} s`,
      );
    } catch (e) {
      if (e instanceof ImageError) {
        if (e.detail) log.warn(`${e.message} — ${e.detail}`);
        err = e.code === "cancelled" ? new ImageError(STOPPED, { code: "cancelled" }) : e;
      } else if (estErreurAnnulation(e) || this.controleur.signal.aborted)
        err = new ImageError(STOPPED, { code: "cancelled" });
      else {
        log.error(
          `génération : erreur inattendue : ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
        );
        err = new ImageError("Erreur interne de génération.", { code: "engine" });
      }
    }
    if (refs.length) await this.emit({ type: "image", items: refs, prompt });
    if (err !== null) await this.emit({ type: "image_error", ...err.payload() });
    const assistant: Dict = { role: "assistant", run_ids: [execId] };
    if (refs.length) {
      Object.assign(assistant, {
        content: caption(prompt, refs.length),
        generated_images: refs,
        image_meta: meta,
      });
      if (revised) assistant["revised_prompt"] = revised;
    } else {
      err ??= new ImageError("Le moteur n'a renvoyé aucune image.", { code: "engine" });
      Object.assign(assistant, {
        content: err.code === "cancelled" ? "[Génération d'image arrêtée]" : failureCaption(err.message),
        image_error: err.payload(),
      });
    }
    const [persisted, persistError] = await this.persistAnswer(assistant);
    const final: Dict = {
      type: "final",
      assistant: assistant["content"],
      chat_id: chatId,
      run_ids: [execId],
      generated_images: refs,
      image: true,
      revised_prompt: revised,
      image_meta: meta,
      persisted,
      metrics: {
        model: veritePy(meta["model"]) ? meta["model"] : modelName(cfg, caps),
        duration_s: meta["duration_s"] ?? null,
      },
    };
    if (err !== null) {
      final["image_error"] = err.payload();
      if (err.code === "cancelled") final["cancelled"] = true;
    }
    if (persistError) final["persist_error"] = persistError;
    if (this.c.titleGenerated) final["title"] = this.c.title;
    await this.emit(final);
    if (refs.length || err === null) return ["ok", ""];
    const statut = err.code === "cancelled" || err.code === "timeout" ? err.code : "error";
    return [statut, err.code];
  }

  private async enrichir(): Promise<string> {
    this.tracker.update("enhancing");
    await this.emit(this.tracker.event());
    const modele = this.c.data["model"];
    const { prompt: revised, raison } = await useLlmTarget(this.c.enhanceTarget, () =>
      enhancePrompt(this.c.prompt, {
        model: veritePy(modele) ? strPy(modele) : null,
        chatId: this.c.chatId,
        signal: this.controleur.signal,
      }),
    );
    this.tracker.update("queued");
    if (revised) {
      this.c.req.prompt = revised;
      await this.emit({ type: "image_prompt", text: revised });
      return revised;
    }
    await this.emit({ type: "info", text: `Description non enrichie (${raison}) : envoyée telle quelle.` });
    return "";
  }

  private async persistAnswer(assistant: Dict): Promise<[boolean, string]> {
    if (this.c.ephemeral) return [true, ""];
    let ret: boolean | null;
    try {
      [ret] = await this.ecrire([...this.c.msgs, assistant]);
    } catch (e) {
      log.warn(`persistance échouée chat=${Array.from(this.c.chatId).slice(0, 12).join("")} : ${String(e)}`);
      return [false, "db"];
    }
    if (ret === false) return [false, "conflict"];
    try {
      await enforceRecentChatsCap(this.c.db, this.c.uid);
    } catch (e) {
      log.debug(`[image.recent_cap] ${String(e)}`);
    }
    return [true, ""];
  }

  private async ouvrirJournal(): Promise<void> {
    if (!this.c.resumable) return;
    try {
      const demande = this.c.msgs.at(-1)!["image_request"];
      const meta: Dict = {
        engine_key: "image",
        model: modelName(this.c.cfg, this.c.caps),
        is_continue: false,
        base_count: this.c.rawCount,
        user_message: prefixePy(this.c.prompt, 20000),
        image_request: veritePy(demande) ? demande : {},
      };
      const j = new RunJournal(this.c.uid, this.c.chatId, this.c.runId, meta);
      if (await j.open({ ...meta, chat_id: this.c.chatId })) this.journalRun = j;
    } catch (e) {
      log.debug(`[image.run_journal.open] ${String(e)}`);
    }
  }

  /** Réclame le verrou réservé, lance le worker, draine sa file ; à la fermeture, attend un tour stoppé (borné) ou le détache. */
  async diffuser(rep: FastifyReply, arret?: AbortSignal): Promise<void> {
    const { uid, chatId } = this.c;
    await this.ouvrirJournal();
    let sortie: SortieFlux;
    try {
      sortie = ouvrirFlux(rep, { "content-type": "application/x-ndjson; charset=utf-8" }, arret);
    } catch (e) {
      verrousChat.release(reclamerVerrou(uid, chatId)?.jeton ?? null);
      await this.journalRun?.close("error").catch(() => undefined);
      throw e;
    }
    const claimed = reclamerVerrou(uid, chatId);
    registerChatTask(uid, this.controleur, chatId, { presenceToken: claimed?.jeton ?? null });
    const etat = { fini: false };
    const tache = this.worker()
      .catch((e: unknown) => log.error(`tour : ${String(e)}`))
      .finally(async () => {
        etat.fini = true;
        if (!this.detache) await this.q.put(null);
      });
    try {
      for (;;) {
        const ev = await this.q.get(reglages.pingS, sortie.signal);
        if (ev === DELAI) {
          if (sortie.signal.aborted) break;
          await sortie.ecrire(ligneNdjson({ type: "ping" }));
          continue;
        }
        if (ev === null) {
          await sortie.ecrire(
            ligneNdjson({
              type: "image_error",
              code: "engine",
              message: "Génération d'image interrompue.",
              retryable: true,
            }),
          );
          break;
        }
        await sortie.ecrire(ligneNdjson(ev));
        if (ev["type"] === "final") break;
      }
    } finally {
      if (!etat.fini && isChatCancelled(uid, chatId)) {
        let minuterie: NodeJS.Timeout | undefined;
        await Promise.race([
          tache,
          new Promise((ok) => (minuterie = setTimeout(ok, reglages.attenteStopS * 1000))),
        ]);
        clearTimeout(minuterie);
      }
      if (etat.fini) unregisterChatTask(uid, chatId, this.controleur);
      else {
        this.detache = true;
        this.q.couper();
        void tache.finally(() => unregisterChatTask(uid, chatId, this.controleur));
      }
      sortie.fermer();
    }
  }
}
