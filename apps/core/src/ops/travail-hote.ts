// SPDX-License-Identifier: MIT
/** apps/core/src/ops/travail-hote.ts — /work des comptes lu et écrit par l'hôte d'outils de leur bac pour la sauvegarde et la restauration (routes/_helpers.py : _zip_work ; admin/lifecycle.py : _restaurer_work). */
import { randomBytes } from "node:crypto";

import { getUsernameById } from "@elpis/auth";
import { estDict, getPy, intPy, pyJsonLoads, strPy, texteJsonPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Executeur } from "@elpis/db";
import { Agent, request } from "undici";

import type { CycleDeVie } from "../cycle";
import type { Journal } from "../journal";
import { ClientHttp, delais } from "../llm/client-http";
import type { ReponseFlux } from "../llm/client-http";
import { sandboxHostFor } from "../relais/hotes";
import type { SandboxHost } from "../relais/hotes";
import { entetesRelais } from "../relais/identite";
import { brancherTravail, dateZip } from "./sauvegarde";
import type { PortTravail } from "./sauvegarde";
import { ZIP64_LIMIT } from "./zip-disque";
import type { EcrivainZip } from "./zip-disque";

/** Bornes données à l'hôte : la copie se fait en flux, rien n'est gardé en mémoire. */
export const BACKUP_WORK_MAX_ENTREES = 5_000_000;

const DELAI_S = 600;
const CONNEXION_S = 5;
const TRAME_MAX = 64 * 1024 * 1024;
const AGENT_ABSENT = "agent_unavailable";

/** Refus de l'hôte ou de l'agent de son bac ; `code` vide : le message se lit tel quel. */
class ErreurTravail extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Raison d'un /work non lu, sans détail interne quand l'hôte n'a pas répondu. */
function raison(e: ErreurTravail): string {
  return e.code ? `${e.code}: ${e.message}` : e.message;
}

type Trame = readonly ["J", Dict] | readonly ["D", Buffer];

/** Trames « genre, longueur sur 4 octets, corps » du flux de l'hôte : « D » des octets, « J » un objet JSON. */
async function* lireTrames(corps: AsyncIterable<Uint8Array>): AsyncGenerator<Trame> {
  let morceaux: Buffer[] = [];
  let longueur = 0;
  let attendu = 5;
  let genre = "";
  const prendre = (n: number): Buffer => {
    const tout = morceaux.length === 1 ? (morceaux[0] as Buffer) : Buffer.concat(morceaux, longueur);
    morceaux = longueur > n ? [tout.subarray(n)] : [];
    longueur -= n;
    return tout.subarray(0, n);
  };
  for await (const morceau of corps) {
    morceaux.push(Buffer.from(morceau.buffer, morceau.byteOffset, morceau.byteLength));
    longueur += morceau.byteLength;
    while (longueur >= attendu) {
      if (genre === "") {
        const tete = prendre(5);
        const g = tete.toString("latin1", 0, 1);
        const n = tete.readUInt32BE(1);
        if ((g !== "J" && g !== "D") || n > TRAME_MAX)
          throw new ErreurTravail("bad_response", "trame invalide");
        genre = g;
        attendu = n;
        continue;
      }
      const contenu = Buffer.from(prendre(attendu));
      const g = genre;
      genre = "";
      attendu = 5;
      if (g === "D") {
        yield ["D", contenu];
        continue;
      }
      const objet = pyJsonLoads(texteJsonPy(contenu));
      if (!estDict(objet)) throw new ErreurTravail("bad_response", "trame invalide");
      yield ["J", objet];
    }
  }
  if (longueur > 0 || genre !== "") throw new ErreurTravail("bad_response", "trame tronquée");
}

/** Flux du /work d'un compte : entrées (`entry`) et octets ; `fin` (bilan) une fois tout lu. */
class FluxHote implements AsyncIterable<Buffer | Dict> {
  fin: Dict | null = null;
  private readonly reponse: ReponseFlux;
  private readonly client: ClientHttp;

  constructor(reponse: ReponseFlux, client: ClientHttp) {
    this.reponse = reponse;
    this.client = client;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer | Dict> {
    for await (const [genre, corps] of lireTrames(this.reponse.aiterBytes())) {
      if (genre === "D") {
        yield corps;
      } else if (Object.hasOwn(corps, "fin")) {
        const fin = corps["fin"];
        this.fin = estDict(fin) ? fin : {};
        return;
      } else if (Object.hasOwn(corps, "error")) {
        throw new ErreurTravail(strPy(corps["error"]), strPy(getPy(corps, "message") ?? ""));
      } else {
        yield corps;
      }
    }
    throw new ErreurTravail("bad_response", "flux interrompu");
  }

  async fermer(): Promise<void> {
    await this.reponse.aclose();
    await this.client.aclose();
  }
}

/** Détail d'un refus de l'hôte (`detail` de sa réponse JSON). */
function detailHote(statut: number, contenu: Uint8Array): string {
  try {
    const detail = getPy(pyJsonLoads(texteJsonPy(contenu)), "detail");
    return typeof detail === "string" && detail ? detail : `HTTP ${statut}`;
  } catch {
    return `HTTP ${statut}`;
  }
}

/** Hôte d'outils du compte et nom sous lequel il le connaît ; sans hôte déclaré, le /work n'est pas lu. */
async function hoteDuCompte(x: Executeur, uid: number): Promise<[SandboxHost, string]> {
  const hote = await sandboxHostFor(uid, false);
  if (hote === null) throw new ErreurTravail("", "hôte d'outils non déclaré");
  return [hote, (await getUsernameById(x, uid)) || `user_${uid}`];
}

/** Flux du /work du compte par l'hôte d'outils (qui démarre un bac arrêté puis le rend) ; hôte muet : « injoignable ». */
async function ouvrirFlux(hote: SandboxHost, uid: number, nom: string): Promise<FluxHote> {
  const client = new ClientHttp({ delais: delais(DELAI_S, { connect: CONNEXION_S }) });
  let reponse: ReponseFlux;
  try {
    reponse = await client.stream("POST", `${hote.url}/api/internal/sandbox/backup-work`, {
      headers: await entetesRelais(hote, uid, nom),
    });
  } catch {
    await client.aclose();
    throw new ErreurTravail("", "hôte d'outils injoignable (démarrez-le : ./elpis start)");
  }
  if (reponse.statusCode >= 200 && reponse.statusCode < 300) return new FluxHote(reponse, client);
  try {
    throw new ErreurTravail("", `hôte d'outils : ${detailHote(reponse.statusCode, await reponse.aread())}`);
  } finally {
    await reponse.aclose();
    await client.aclose();
  }
}

/** Entrées de l'hôte écrites dans le zip sous `arcroot` ; un fichier coupé est commenté « incomplet » ; rend le bilan de l'hôte. */
async function copierFlux(
  flux: FluxHote,
  arcroot: string,
  zip: EcrivainZip,
  incomplets: string[],
): Promise<Dict> {
  const it = flux[Symbol.asyncIterator]();
  let courant = await it.next();
  while (!courant.done) {
    const x = courant.value;
    if (Buffer.isBuffer(x)) throw new ErreurTravail("bad_response", "octets hors d'une entrée");
    if (!Object.hasOwn(x, "entry")) {
      courant = await it.next();
      continue;
    }
    const entree = strPy(x["entry"]);
    const taille = Number(x["size"]);
    let ecrits = 0;
    const corps = async function* (): AsyncGenerator<Buffer> {
      for (;;) {
        courant = await it.next();
        if (courant.done) return;
        const v = courant.value;
        if (!Buffer.isBuffer(v)) {
          if (Object.hasOwn(v, "entry")) return;
          continue;
        }
        ecrits += v.length;
        yield v;
      }
    };
    try {
      await zip.ajouterFlux(
        {
          nom: `${arcroot}/${entree}`,
          dateHeure: dateZip(Number(x["mtime_ns"]) / 1e9),
          attributsExternes: (0o100000 | (Number(x["mode"]) & 0o7777)) * 0x10000,
          forceZip64: taille >= ZIP64_LIMIT,
        },
        corps(),
      );
    } finally {
      if (ecrits < taille) {
        zip.commenterDernier("incomplet");
        incomplets.push(`${entree} — incomplet (${ecrits}/${taille} octets)`);
      }
    }
  }
  return flux.fin ?? {};
}

/** Un fichier envoyé sous /work par l'hôte (formulaire `path` + `data`) ; rend sa réponse, ou l'échec du transport en `agent_unavailable`. */
async function envoyerFichier(
  agent: Agent,
  hote: SandboxHost,
  uid: number,
  nom: string,
  rel: string,
  contenu: Buffer,
): Promise<{ ok: boolean; code: string; status: number }> {
  const limite = randomBytes(16).toString("hex");
  const corps = Buffer.concat([
    Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="path"\r\n\r\n${rel}\r\n`),
    Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="size"\r\n\r\n${contenu.length}\r\n`),
    Buffer.from(
      `--${limite}\r\nContent-Disposition: form-data; name="data"; filename="f"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    contenu,
    Buffer.from(`\r\n--${limite}--\r\n`),
  ]);
  try {
    const r = await request(`${hote.url}/api/internal/sandbox/work-file`, {
      dispatcher: agent,
      method: "POST",
      headers: {
        ...(await entetesRelais(hote, uid, nom)),
        "content-type": `multipart/form-data; boundary=${limite}`,
      },
      body: corps,
    });
    const brut = Buffer.from(await r.body.arrayBuffer());
    if (r.statusCode === 413) return { ok: false, code: "too_large", status: 413 };
    if (r.statusCode !== 200) return { ok: false, code: AGENT_ABSENT, status: 0 };
    const d = pyJsonLoads(texteJsonPy(brut));
    return {
      ok: veritePy(getPy(d, "ok")),
      code: strPy(getPy(d, "code") ?? ""),
      status: intPy(getPy(d, "status") ?? 0),
    };
  } catch {
    return { ok: false, code: AGENT_ABSENT, status: 0 };
  }
}

/** Accès au /work des comptes par l'hôte d'outils de leur bac (`brancherTravail`). */
export function portTravailHote(x: Executeur, journal?: Journal): PortTravail {
  return {
    async sauvegarder(userId, arcroot, zip, skipped) {
      const incomplets: string[] = [];
      let fin: Dict;
      let flux: FluxHote | null = null;
      try {
        const [hote, nom] = await hoteDuCompte(x, userId);
        flux = await ouvrirFlux(hote, userId, nom);
        fin = await copierFlux(flux, arcroot, zip, incomplets);
      } catch (e) {
        if (e instanceof ErreurTravail) {
          skipped.push(`${arcroot} — ${raison(e)} : /work non sauvegardé`);
        } else {
          journal?.warn({ err: e }, `[backup] /work du compte ${userId} illisible`);
          const nom = e instanceof Error ? e.name : "Exception";
          skipped.push(
            `${arcroot} — ${nom}: ${e instanceof Error ? e.message : String(e)} : /work incomplet`,
          );
        }
        return false;
      } finally {
        await flux?.fermer();
        skipped.push(...incomplets.map((i) => `${arcroot}/${i}`));
      }
      const omis = Array.isArray(fin["skipped"]) ? fin["skipped"] : [];
      for (const o of omis)
        if (estDict(o)) skipped.push(`${arcroot}/${strPy(getPy(o, "path"))} — ${strPy(getPy(o, "error"))}`);
      const reste = intPy(veritePy(fin["omitted"]) ? fin["omitted"] : 0) - omis.length;
      if (reste > 0) skipped.push(`${arcroot} — ${reste} autre(s) entrée(s) omise(s)`);
      if (veritePy(fin["truncated"]))
        skipped.push(`${arcroot} — sauvegarde tronquée (${BACKUP_WORK_MAX_ENTREES} entrées au plus)`);
      return true;
    },

    async restaurer(userId, lot, lire, restored, errors) {
      const [hote, nom] = await hoteDuCompte(x, userId).catch(() => [null, ""] as const);
      if (hote === null) {
        for (const [n] of lot) errors.push(`${n}: ${AGENT_ABSENT}`);
        return;
      }
      const agent = new Agent({
        connect: { timeout: CONNEXION_S * 1000 },
        headersTimeout: DELAI_S * 1000,
        bodyTimeout: DELAI_S * 1000,
      });
      try {
        for (const [i, [entree, rel]] of lot.entries()) {
          const r = await envoyerFichier(agent, hote, userId, nom, rel, await lire(entree));
          if (r.ok) {
            restored.push(entree);
          } else if (r.status) {
            errors.push(`${entree}: ${r.code}`);
          } else {
            for (const [n] of lot.slice(i)) errors.push(`${n}: ${r.code}`);
            return;
          }
        }
      } finally {
        void agent.destroy();
      }
    },
  };
}

/** Process du core : la console, l'envoi distant planifié et la restauration passent par l'hôte d'outils du bac de chaque compte. */
export function brancherTravailDesComptes(cycle: CycleDeVie, x: Executeur, journal: Journal): void {
  brancherTravail(portTravailHote(x, journal));
  cycle.alArret("accès au /work des comptes", () => brancherTravail(null));
}
