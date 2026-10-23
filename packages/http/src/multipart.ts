// SPDX-License-Identifier: MIT
/** packages/http/src/multipart.ts — formulaires comme `request.form()` de Starlette : limites, fichiers en temporaire, 400 et 422 de FastAPI. */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

import multipart from "@fastify/multipart";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { ErreurValidation, HttpError } from "./erreurs";
import type { ErreurPydantic } from "./erreurs";

export const MAX_CHAMPS = 1000;
export const MAX_FICHIERS = 1000;
export const MAX_PARTIE = 1024 * 1024;
const ERREUR_ANALYSE = "There was an error parsing the body";
const FIN_INATTENDUE = /unexpected end of (form|multipart data)|premature close/iu;

export interface FichierRecu {
  readonly filename: string;
  readonly contentType: string;
  readonly chemin: string;
  readonly taille: number;
}

export type ValeurFormulaire = string | FichierRecu;

/** `FormData` de Starlette : entrées dans l'ordre, `get` rend la dernière valeur du nom. */
export class Formulaire {
  readonly entrees: readonly (readonly [string, ValeurFormulaire])[];

  constructor(entrees: readonly (readonly [string, ValeurFormulaire])[]) {
    this.entrees = entrees;
  }

  get(nom: string): ValeurFormulaire | undefined {
    for (let i = this.entrees.length - 1; i >= 0; i--) {
      const [cle, valeur] = this.entrees[i] as readonly [string, ValeurFormulaire];
      if (cle === nom) return valeur;
    }
    return undefined;
  }

  getAll(nom: string): ValeurFormulaire[] {
    return this.entrees.filter(([cle]) => cle === nom).map(([, valeur]) => valeur);
  }
}

interface Temporaires {
  dossier: string | undefined;
  ferme: boolean;
  envoye: boolean;
  readonly journal: FastifyBaseLogger;
  readonly limiteCorps: number;
}

const formulaires = new WeakMap<FastifyRequest, Promise<Formulaire>>();
const temporaires = new WeakMap<FastifyRequest, Temporaires>();
const suppressions = new Set<Promise<void>>();

/** Dossier supprimé une fois la réponse close ET le traitement fini, dans n'importe quel ordre ; rappelée après chaque création. */
function nettoyer(t: Temporaires): Promise<void> {
  if (t.dossier === undefined || !t.ferme || !t.envoye) return Promise.resolve();
  const suppression = rm(t.dossier, { recursive: true, force: true, maxRetries: 3 })
    .catch((e: unknown) => t.journal.warn({ err: e }, "temporaire du formulaire non supprimé"))
    .finally(() => suppressions.delete(suppression));
  suppressions.add(suppression);
  return suppression;
}

/** `close` de la réponse est toujours émis (envoyée, coupée ou détournée), `onSend` suit la fin du traitement. */
function suivre(requete: FastifyRequest, reponse: FastifyReply, limiteCorps: number): void {
  if (typeDeContenu(requete.headers["content-type"]).type !== "multipart/form-data") return;
  const t: Temporaires = {
    dossier: undefined,
    ferme: false,
    envoye: false,
    journal: requete.log,
    limiteCorps,
  };
  temporaires.set(requete, t);
  reponse.raw.once("close", () => {
    t.ferme = true;
    if (reponse.sent) t.envoye = true;
    void nettoyer(t);
  });
}

/** Greffon multipart aux limites de Starlette (1000 champs, 1000 fichiers, 1 Mo par champ) ; fichier ou formulaire au-delà du plafond du corps = 413 ; temporaires suivis par requête. */
export async function installerMultipart(app: FastifyInstance, limiteFichier: number): Promise<void> {
  await app.register(multipart, {
    preservePath: true,
    defCharset: "latin1",
    throwFileSizeLimit: true,
    isPartAFile: (_champ: string | undefined, _type: string, nom: string | undefined) => nom !== undefined,
    limits: {
      fieldNameSize: Infinity,
      fieldSize: MAX_PARTIE,
      fields: MAX_CHAMPS,
      fileSize: limiteFichier,
      files: MAX_FICHIERS,
      parts: Infinity,
    },
  } as Parameters<typeof multipart>[1]);
  app.addHook("onRequest", (requete, reponse, fait) => {
    suivre(requete, reponse, limiteFichier);
    fait();
  });
  app.addHook("onSend", (requete, _reponse, charge, fait) => {
    const t = temporaires.get(requete);
    if (t === undefined) return fait(null, charge);
    t.envoye = true;
    void nettoyer(t).then(() => fait(null, charge));
  });
  app.addHook("onClose", async () => {
    await Promise.all(suppressions);
  });
}

/** `parse_options_header` : type en minuscules seulement sans paramètres (sinon tel quel), noms de paramètres en minuscules. */
function typeDeContenu(entete: string | undefined): { type: string; params: Map<string, string> } {
  const [type = "", ...reste] = (entete ?? "").split(";");
  const params = new Map<string, string>();
  for (const brut of reste) {
    const egal = brut.indexOf("=");
    if (egal < 0) continue;
    const valeur = brut.slice(egal + 1).trim();
    params.set(
      brut.slice(0, egal).trim().toLowerCase(),
      valeur.length >= 2 && valeur.startsWith('"') && valeur.endsWith('"') ? valeur.slice(1, -1) : valeur,
    );
  }
  return { type: reste.length ? type.trim() : type.trim().toLowerCase(), params };
}

/** `_user_safe_decode` d'une valeur de champ : octets (lus en latin-1 par busboy) relus en UTF-8 strict, sinon latin-1. */
function decodageSur(s: string): string {
  for (const c of s) if (c.charCodeAt(0) > 0xff) return s;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(s, "latin1"));
  } catch {
    return s;
  }
}

/** Chemin Windows complet (IE6) réduit au nom, comme python-multipart ; les chemins `/` restent tels quels. */
function nomDeFichier(nom: string): string {
  return nom.slice(1, 3) === ":\\" || nom.startsWith("\\\\") ? (nom.split("\\").pop() ?? "") : nom;
}

function traduire(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  const code = (e as { code?: unknown }).code;
  if (code === "FST_FIELDS_LIMIT")
    return new HttpError(400, `Too many fields. Maximum number of fields is ${MAX_CHAMPS}.`);
  if (code === "FST_FILES_LIMIT")
    return new HttpError(400, `Too many files. Maximum number of files is ${MAX_FICHIERS}.`);
  if (code === "FST_REQ_FILE_TOO_LARGE") return new HttpError(413, "Request body is too large");
  return new HttpError(400, ERREUR_ANALYSE);
}

/** Plafond propre à une route : un fichier plus gros est tronqué à `limiteFichier` octets (sans 413), la route juge sa taille ; il s'ajoute au plafond du corps pour le total du formulaire. */
export interface OptionsFormulaire {
  readonly limiteFichier?: number;
}

async function analyser(requete: FastifyRequest, options: OptionsFormulaire): Promise<Formulaire> {
  const { type, params } = typeDeContenu(requete.headers["content-type"]);
  if (type === "application/x-www-form-urlencoded")
    return new Formulaire([...new URLSearchParams(requete.corpsBrut.toString("latin1"))]);
  if (type !== "multipart/form-data") return new Formulaire([]);
  if (!params.has("boundary")) throw new HttpError(400, "Missing boundary in multipart.");
  const t = temporaires.get(requete);
  if (t === undefined) throw new Error("formulaire multipart sans suivi de ses temporaires");
  const entrees: [string, ValeurFormulaire][] = [];
  let commencees = 0;
  const plafond = t.limiteCorps + (options.limiteFichier ?? 0);
  let total = 0;
  const compter = (octets: number): void => {
    total += octets;
    if (total > plafond) throw new HttpError(413, "Request body is too large");
  };
  const compteur = async function* (source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    for await (const morceau of source) {
      compter(morceau.length);
      yield morceau;
    }
  };
  try {
    const parts =
      options.limiteFichier === undefined
        ? requete.parts()
        : requete.parts({
            limits: { fileSize: options.limiteFichier },
            throwFileSizeLimit: false,
          } as unknown as Parameters<FastifyRequest["parts"]>[0]);
    for await (const partie of parts) {
      commencees++;
      if (partie.fieldname === undefined)
        throw new HttpError(400, 'The Content-Disposition header field "name" must be provided.');
      const champ = partie.fieldname;
      if (partie.type === "file") {
        if (partie.file.destroyed) throw new Error("Premature close");
        if (t.dossier === undefined) {
          t.dossier = await mkdtemp(join(tmpdir(), "elpis-formulaire-"));
          await nettoyer(t);
        }
        const chemin = join(t.dossier, String(commencees));
        try {
          await pipeline(partie.file, compteur, createWriteStream(chemin, { flags: "wx", mode: 0o600 }));
        } finally {
          await nettoyer(t);
        }
        entrees.push([
          champ,
          {
            filename: nomDeFichier(partie.filename),
            contentType: partie.mimetype,
            chemin,
            taille: (await stat(chemin)).size,
          },
        ]);
      } else {
        if (partie.valueTruncated)
          throw new HttpError(400, `Part exceeded maximum size of ${MAX_PARTIE / 1024}KB.`);
        compter(typeof partie.value === "string" ? Buffer.byteLength(partie.value, "latin1") : 0);
        entrees.push([
          champ,
          typeof partie.value === "string" ? decodageSur(partie.value) : JSON.stringify(partie.value),
        ]);
      }
    }
  } catch (e) {
    if (commencees > 0 && e instanceof Error && FIN_INATTENDUE.test(e.message))
      return new Formulaire(entrees);
    throw traduire(e);
  }
  return new Formulaire(entrees);
}

/** `await request.form()` : lu une fois par requête (options du premier appel) ; fichiers supprimés après la réponse. */
export function lireFormulaire(
  requete: FastifyRequest,
  options: OptionsFormulaire = {},
): Promise<Formulaire> {
  let f = formulaires.get(requete);
  if (f === undefined) {
    f = analyser(requete, options);
    formulaires.set(requete, f);
  }
  return f;
}

export interface ParametreFormulaire {
  readonly type: "fichier" | "texte";
  readonly requis: boolean;
}

type ValeurDe<P extends ParametreFormulaire> = P["type"] extends "fichier"
  ? P["requis"] extends true
    ? FichierRecu
    : FichierRecu | null
  : P["requis"] extends true
    ? string
    : string | null;

/** Paramètres `File(...)` / `Form(...)` d'une route : un seul 422 groupé dans l'ordre de la spec ; "" vaut absent comme dans FastAPI. */
export function valeursFormulaire<S extends Readonly<Record<string, ParametreFormulaire>>>(
  f: Formulaire,
  spec: S,
): { [K in keyof S]: ValeurDe<S[K]> } {
  const erreurs: ErreurPydantic[] = [];
  const sortie: Record<string, ValeurFormulaire | null> = {};
  for (const [nom, p] of Object.entries(spec)) {
    const v = f.get(nom);
    if (v === undefined || v === "") {
      if (p.requis) erreurs.push({ type: "missing", loc: ["body", nom], msg: "Field required", input: null });
      sortie[nom] = null;
    } else if (p.type === "fichier" && typeof v === "string") {
      const erreur: ErreurPydantic & { ctx: unknown } = {
        type: "value_error",
        loc: ["body", nom],
        msg: "Value error, Expected UploadFile, received: <class 'str'>",
        input: v,
        ctx: { error: {} },
      };
      erreurs.push(erreur);
    } else if (p.type === "texte" && typeof v !== "string") {
      erreurs.push({
        type: "string_type",
        loc: ["body", nom],
        msg: "Input should be a valid string",
        input: { filename: v.filename, size: v.taille },
      });
    } else {
      sortie[nom] = v;
    }
  }
  if (erreurs.length) throw new ErreurValidation(erreurs);
  return sortie as { [K in keyof S]: ValeurDe<S[K]> };
}

/** `save_upload_bounded` : copie plafonnée ; au-delà, destination supprimée et 413 en Mo entiers. */
export async function enregistrerBorne(
  f: FichierRecu,
  destination: string,
  maxOctets: number,
): Promise<number> {
  await mkdir(dirname(destination), { recursive: true });
  if (f.taille > maxOctets) {
    await rm(destination, { force: true });
    throw new HttpError(
      413,
      `Fichier trop volumineux (plafond : ${Math.floor(maxOctets / (1024 * 1024))} Mo).`,
    );
  }
  await pipeline(createReadStream(f.chemin), createWriteStream(destination));
  return f.taille;
}
