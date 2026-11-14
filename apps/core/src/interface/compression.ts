// SPDX-License-Identifier: MIT
/** apps/core/src/interface/compression.ts — compression HTTP : encodage négocié, variantes en mémoire des fichiers statiques hors build, corps JSON volumineux compressés à la volée. */
import { readFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

import type { FastifyInstance, FastifyReply } from "fastify";

export type Encodage = "br" | "gzip";

/** Types textuels qui gagnent à être compressés ; images, polices woff2 et archives le sont déjà. */
export const COMPRESSIBLE =
  /\.(?:js|mjs|cjs|css|html?|json|svg|txt|md|xml|webmanifest|map|csv|ya?ml|ttf|otf|eot|wasm)$/;

/** Corps JSON compressé à partir de cette taille : en deçà, le gain ne se voit pas. */
export const SEUIL_JSON = 16 * 1024;

const brotli = promisify(brotliCompress);
const deflate = promisify(gzip);

/** Niveau fort pour un fichier compressé une fois, rapide pour un corps compressé à chaque réponse. */
export function compresser(donnees: string | Buffer, encodage: Encodage, rapide: boolean): Promise<Buffer> {
  return encodage === "br"
    ? brotli(donnees, { params: { [constants.BROTLI_PARAM_QUALITY]: rapide ? 4 : 9 } })
    : deflate(donnees, { level: rapide ? 4 : 9 });
}

/** Encodage préféré d'`Accept-Encoding` : brotli puis gzip, `q=0` refuse, `*` vaut pour les absents. */
export function encodageAccepte(entete: string | string[] | undefined): Encodage | null {
  const poids = new Map<string, number>();
  for (const partie of String(entete ?? "")
    .toLowerCase()
    .split(",")) {
    const [nom = "", ...params] = partie.split(";").map((s) => s.trim());
    const q = params.find((p) => p.startsWith("q="));
    poids.set(nom, q === undefined ? 1 : Number(q.slice(2)));
  }
  const de = (nom: string): number => poids.get(nom) ?? poids.get("*") ?? 0;
  const br = de("br");
  const gz = de("gzip");
  if (br > 0 && br >= gz) return "br";
  return gz > 0 ? "gzip" : null;
}

interface Variante {
  version: string;
  corps: Promise<Buffer>;
  octets: number;
}

/** Variantes compressées par fichier, encodage et version (date, taille), une seule compression même pour des requêtes simultanées ; les moins récemment servies sortent au-delà du plafond. */
export class VariantesEnMemoire {
  private readonly entrees = new Map<string, Variante>();
  private octets = 0;
  private readonly plafond: number;

  constructor(plafond = 8 * 1024 * 1024) {
    this.plafond = plafond;
  }

  obtenir(chemin: string, st: Pick<Stats, "mtimeMs" | "size">, encodage: Encodage): Promise<Buffer> {
    const cle = `${encodage}:${chemin}`;
    const version = `${st.mtimeMs}:${st.size}`;
    const deja = this.entrees.get(cle);
    if (deja?.version === version) {
      this.entrees.delete(cle);
      this.entrees.set(cle, deja);
      return deja.corps;
    }
    this.retirer(cle);
    const v: Variante = {
      version,
      octets: 0,
      corps: readFile(chemin).then((o) => compresser(o, encodage, false)),
    };
    this.entrees.set(cle, v);
    void v.corps.then(
      (corps) => {
        if (this.entrees.get(cle) !== v) return;
        v.octets = corps.length;
        this.octets += corps.length;
        for (const ancienne of this.entrees.keys()) {
          if (this.octets <= this.plafond) break;
          this.retirer(ancienne);
        }
      },
      () => {
        if (this.entrees.get(cle) === v) this.entrees.delete(cle);
      },
    );
    return v.corps;
  }

  private retirer(cle: string): void {
    const e = this.entrees.get(cle);
    if (e === undefined) return;
    this.entrees.delete(cle);
    this.octets -= e.octets;
  }
}

/** `Vary: Accept-Encoding` ajouté aux valeurs déjà posées (Origin, Cookie…). */
function ajouterVary(reponse: FastifyReply): void {
  const avant = reponse.getHeader("vary");
  const liste = Array.isArray(avant) ? avant.join(", ") : String(avant ?? "");
  if (/(?:^|,)\s*(?:accept-encoding|\*)\s*(?:,|$)/i.test(liste)) return;
  void reponse.header("vary", liste ? `${liste}, Accept-Encoding` : "Accept-Encoding");
}

/** Corps JSON d'au moins 16 Kio compressé pour une requête de même origine seulement (pas de BREACH inter-site) ; jamais un flux, une pièce jointe, une plage ni un ETag. */
export function installerCompressionJson(app: FastifyInstance): void {
  app.addHook("onSend", async (requete, reponse, charge) => {
    if (typeof charge !== "string" && !Buffer.isBuffer(charge)) return charge;
    if (
      reponse.statusCode !== 200 ||
      requete.headers["sec-fetch-site"] !== "same-origin" ||
      requete.headers.range !== undefined ||
      Buffer.byteLength(charge) < SEUIL_JSON ||
      !/^application\/json\s*(?:;|$)/i.test(String(reponse.getHeader("content-type") ?? "")) ||
      reponse.hasHeader("content-encoding") ||
      reponse.hasHeader("content-disposition") ||
      reponse.hasHeader("etag") ||
      String(reponse.getHeader("cache-control") ?? "").includes("no-transform")
    )
      return charge;
    ajouterVary(reponse);
    const encodage = encodageAccepte(requete.headers["accept-encoding"]);
    if (encodage === null) return charge;
    void reponse.header("content-encoding", encodage).removeHeader("content-length");
    return compresser(charge, encodage, true);
  });
}
