// SPDX-License-Identifier: MIT
/** apps/toolhost/src/fichiers/travail.ts — /work d'un compte lu et écrit pour la sauvegarde et la restauration du core : entrées de l'agent en trames, bac arrêté démarré le temps de la lecture, écriture d'un fichier. */
import { lstatSync } from "node:fs";
import { Readable } from "node:stream";

import { estErreurAgent } from "@elpis/bac";
import type { ArchiveAgent } from "@elpis/bac";
import { HttpError } from "@elpis/commun";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { DefinitionRoute } from "../app";
import { ouvrirArchive } from "./aides";
import { parAgent, reponseJson, uidDe } from "./commun";
import type { ContexteFichiers } from "./commun";

const MIO = 1024 * 1024;
const FICHIER_MAX_BYTES = 2 * 1024 * MIO;
const TRAVAIL_MAX_BYTES = 2 ** 40;
const TRAVAIL_MAX_ENTREES = 5_000_000;
const PARCOURS_S = 240;
const MORCEAU = MIO;
const TROP_TRAVAIL = "/work trop volumineux pour une sauvegarde";

function mtimeNs(chemin: string): bigint | null {
  try {
    return lstatSync(chemin, { bigint: true }).mtimeNs;
  } catch {
    return null;
  }
}

/** Trame « J » (objet JSON) ou « D » (octets) : genre, longueur sur 4 octets, corps. */
function trame(genre: "J" | "D", corps: Buffer): Buffer {
  const tete = Buffer.alloc(5);
  tete.write(genre, 0, "latin1");
  tete.writeUInt32BE(corps.length, 1);
  return Buffer.concat([tete, corps]);
}

function trameJson(objet: unknown): Buffer {
  const texte = JSON.stringify(objet, (_c, v: unknown) => (typeof v === "bigint" ? Number(v) : v));
  return trame("J", Buffer.from(texte));
}

/** Fichiers de l'agent (entrée puis octets), puis le bilan ; un refus de l'agent en route devient une trame d'erreur. */
async function* trames(flux: ArchiveAgent, liberer: () => Promise<void>): AsyncGenerator<Buffer> {
  try {
    for await (const x of flux) {
      if (Buffer.isBuffer(x)) {
        for (let i = 0; i < x.length; i += MORCEAU) yield trame("D", x.subarray(i, i + MORCEAU));
      } else if (Object.hasOwn(x, "entry") && x["kind"] === "file") {
        yield trameJson({
          entry: String(x["entry"]),
          size: Number(x["size"]),
          mtime_ns: Number(x["mtime_ns"]),
          mode: Number(x["mode"]),
        });
      }
    }
    yield trameJson({ fin: flux.fin ?? {} });
  } catch (e) {
    if (!estErreurAgent(e)) throw e;
    yield trameJson({ error: e.code, message: e.message });
  } finally {
    await liberer();
  }
}

/** `POST /api/internal/sandbox/backup-work` : /work lu en flux ; un bac arrêté est démarré puis arrêté de nouveau si personne ne s'en est servi entre-temps. */
async function sauvegarderTravail(
  ctx: ContexteFichiers,
  q: FastifyRequest,
  r: FastifyReply,
): Promise<unknown> {
  const uid = uidDe(q);
  let travail = "";
  let arretee = false;
  let avant: bigint | null = null;
  let flux: ArchiveAgent | null = null;
  let corps: Readable | null = null;
  let occupe = true;
  let annule = false;
  let liberation: Promise<void> | null = null;
  const liberer = (): Promise<void> =>
    (liberation ??= (async () => {
      r.raw.off("close", couper);
      ctx.arret?.removeEventListener("abort", couper);
      await flux?.fermer().catch(() => undefined);
      if (arretee && mtimeNs(travail) === avant) await ctx.bac.arreter?.(uid).catch(() => undefined);
    })());
  function couper(): void {
    annule = true;
    if (corps && !corps.destroyed) corps.destroy();
    if (!occupe) void liberer();
  }
  r.raw.once("close", couper);
  ctx.arret?.addEventListener("abort", couper, { once: true });
  if (r.raw.destroyed || ctx.arret?.aborted) annule = true;
  try {
    const agent = await parAgent("Sauvegarde", () => ctx.bac.agent(uid));
    const bac = agent.sandbox;
    travail = bac.sandboxPath;
    arretee = !(await bac.status()).running;
    if (arretee) await bac.ensureRunning();
    avant = mtimeNs(travail);
    if (!annule)
      flux = await ouvrirArchive(agent, [""], "Sauvegarde", TROP_TRAVAIL, {
        format: "raw",
        strict: false,
        maxBytes: TRAVAIL_MAX_BYTES,
        maxFiles: TRAVAIL_MAX_ENTREES,
        deadlineS: PARCOURS_S,
        activity: false,
      });
  } catch (e) {
    occupe = false;
    await liberer();
    throw e;
  }
  occupe = false;
  if (flux === null || annule) {
    await liberer();
    return r.status(499).send();
  }
  corps = Readable.from(trames(flux, liberer), { objectMode: false });
  return r.headers({ "content-type": "application/octet-stream", "cache-control": "no-store" }).send(corps);
}

/** Valeur de champ de formulaire (décodée en latin1 par le greffon) relue en UTF-8. */
function texteChamp(v: unknown): string {
  const brut = Buffer.from(typeof v === "string" ? v : "", "latin1");
  return brut.toString("utf8");
}

/** `POST /api/internal/sandbox/work-file` : champs `path` et `size` puis fichier `data`, envoyé en flux à l'agent sans copie locale ; un refus de l'agent est rendu avec son code. */
async function restaurerFichier(ctx: ContexteFichiers, q: FastifyRequest): Promise<Record<string, unknown>> {
  const uid = uidDe(q);
  const agent = await parAgent("Restauration", () => ctx.bac.agent(uid));
  let rel = "";
  let taille = -1;
  let vu = false;
  try {
    const parties = q.parts({
      limits: { fileSize: FICHIER_MAX_BYTES + 1 },
      throwFileSizeLimit: false,
    } as unknown as Parameters<FastifyRequest["parts"]>[0]);
    for await (const partie of parties) {
      if (partie.type !== "file") {
        if (partie.fieldname === "path") rel = texteChamp(partie.value);
        else if (partie.fieldname === "size") taille = Number(texteChamp(partie.value));
        continue;
      }
      if (partie.fieldname !== "data" || vu) {
        partie.file.resume();
        continue;
      }
      vu = true;
      if (!rel || !Number.isSafeInteger(taille) || taille < 0)
        throw new HttpError(400, "champs path et size attendus avant data");
      if (taille > FICHIER_MAX_BYTES) throw new HttpError(413, "fichier trop volumineux");
      let recus = 0;
      const compte = async function* (): AsyncGenerator<Buffer> {
        for await (const b of partie.file as AsyncIterable<Buffer>) {
          recus += b.length;
          if (recus > taille) throw new HttpError(400, "fichier plus long que sa taille annoncée");
          yield b;
        }
        if (recus !== taille) throw new HttpError(400, "fichier tronqué");
      };
      try {
        await agent.write(rel, { flux: compte(), taille }, { parents: true });
      } catch (e) {
        if (!estErreurAgent(e)) throw e;
        return { ok: false, code: e.code, status: e.status };
      }
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "There was an error parsing the body");
  }
  if (!vu) throw new HttpError(422, "champ data requis");
  return { ok: true };
}

export function routesTravail(ctx: ContexteFichiers): DefinitionRoute[] {
  const route = (chemin: string, traiter: DefinitionRoute["traiter"]): DefinitionRoute => ({
    methode: "POST",
    chemin,
    processus: ["toolhost"],
    acces: "enveloppe",
    traiter,
  });
  return [
    route("/api/internal/sandbox/backup-work", (q, r) => sauvegarderTravail(ctx, q, r)),
    route("/api/internal/sandbox/work-file", async (q, r) => reponseJson(r, await restaurerFichier(ctx, q))),
  ];
}
