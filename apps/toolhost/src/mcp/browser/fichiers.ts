// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/fichiers.ts — fichiers d'un upload de `pw_act` : chemins lus dans le `/work` du compte par l'agent de son bac (garde des outils fichiers), ou contenus base64 fournis ; le service navigateur ne reçoit que des contenus. */
import { estErreurAgent } from "@elpis/bac";
import { guessTypePy, strPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { errPw } from "@elpis/navigateur";
import { toContainer } from "@elpis/securite";

import { Espace } from "../espace";
import { relDe } from "../fs/acces";

/** Taille totale admise des fichiers d'un upload (octets), envoyés en base64 au service. */
export const UPLOAD_MAX_OCTETS = 20 * 1024 * 1024;
export const UPLOAD_MAX_FICHIERS = 10;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

export interface FichierEnvoye {
  readonly name: string;
  readonly mime_type: string;
  readonly content_base64: string;
}

export type Resultat = { readonly fichiers: FichierEnvoye[] } | { readonly refus: Dict };

const CORRECTIF =
  "pw_act(session_id, action='upload', target='css=input[type=file]', files=['report.pdf']) — paths inside your sandbox /work, or {name, content_base64}.";

/** Type MIME deviné du nom, `application/octet-stream` à défaut. */
function typeDe(nom: string): string {
  return guessTypePy(nom)[0] ?? "application/octet-stream";
}

/** Un chemin du modèle lu dans le bac : refus hors de /work, absent, dossier, trop gros ou illisible. */
async function lireDuBac(esp: Espace, chemin: string, reste: number): Promise<FichierEnvoye | Dict> {
  let rel: string;
  try {
    rel = relDe(esp.racine, chemin, false);
  } catch (e) {
    return errPw("path_outside_sandbox", "", {
      message: `The path '${chemin}' is not a file path inside your sandbox (/work): ${e instanceof Error ? e.message : strPy(e)}.`,
      fix: "Pass a path inside /work (relative, or starting with /work/), without '..'.",
      path: chemin,
    });
  }
  const p = toContainer(rel);
  try {
    const e = await esp.stat(rel);
    if (e["kind"] === "missing")
      return errPw("file_not_found", "", {
        message: `No such file in your sandbox: '${p}'.`,
        fix: "Check the path with list_files, or write the file first.",
        path: p,
      });
    if (e["kind"] !== "file")
      return errPw("not_a_file", "", { message: `'${p}' is not a regular file.`, path: p });
    const taille = Number(e["size"] ?? 0);
    if (taille > reste)
      return errPw("file_too_large", "", {
        message: `'${p}' (${taille} bytes) exceeds the upload limit of ${UPLOAD_MAX_OCTETS} bytes in total.`,
        path: p,
      });
    const data = (await esp.lire(rel, { maxBytes: reste })).data;
    const nom = rel.split("/").pop() as string;
    return { name: nom, mime_type: typeDe(nom), content_base64: data.toString("base64") };
  } catch (e) {
    const code = estErreurAgent(e) ? strPy((e as { code: unknown }).code) : "";
    if (code.includes("outside") || code.includes("symlink"))
      return errPw("path_outside_sandbox", "", {
        message: `The path '${p}' leaves your sandbox (/work).`,
        fix: "Pass a regular file inside /work, not a link that points outside.",
        path: p,
      });
    return errPw("file_read_failed", "", {
      message: `Could not read '${p}' from your sandbox: ${e instanceof Error ? e.message : strPy(e)}.`,
      path: p,
    });
  }
}

/** Contenu base64 fourni par le modèle : nom et base64 valides, type donné ou deviné. */
function contenuFourni(d: Dict, i: number, reste: number): FichierEnvoye | Dict {
  const nom = typeof d["name"] === "string" ? (d["name"].trim().split("/").pop() ?? "") : "";
  const b64 = typeof d["content_base64"] === "string" ? d["content_base64"].replace(/\s+/gu, "") : null;
  if (!nom || b64 === null || !BASE64.test(b64) || b64.length % 4 !== 0)
    return errPw("invalid_files", "", {
      message: `files[${i}] must be a path inside /work or {name, content_base64, mime_type?} with valid base64.`,
      fix: CORRECTIF,
    });
  if ((b64.length / 4) * 3 > reste + 2)
    return errPw("file_too_large", "", {
      message: `files[${i}] exceeds the upload limit of ${UPLOAD_MAX_OCTETS} bytes in total.`,
    });
  const mime = typeof d["mime_type"] === "string" && d["mime_type"] ? d["mime_type"] : typeDe(nom);
  return { name: nom, mime_type: mime, content_base64: b64 };
}

/** Fichiers à poser dans un `<input type=file>` : liste de chemins du bac ou de `{name, content_base64}`, ou l'enveloppe du refus. */
export async function fichiersUpload(brut: unknown, username: string): Promise<Resultat> {
  if (!Array.isArray(brut) || brut.length === 0)
    return {
      refus: errPw("files_required", "", {
        message: "upload needs files: the files to put in the file input.",
        fix: CORRECTIF,
      }),
    };
  if (brut.length > UPLOAD_MAX_FICHIERS)
    return {
      refus: errPw("too_many_files", "", {
        message: `upload takes at most ${UPLOAD_MAX_FICHIERS} files at once.`,
      }),
    };
  let esp: Espace | null = null;
  const fichiers: FichierEnvoye[] = [];
  let reste = UPLOAD_MAX_OCTETS;
  for (const [i, f] of brut.entries()) {
    let r: FichierEnvoye | Dict;
    if (typeof f === "string" && f.trim()) {
      if (esp === null)
        try {
          esp = await Espace.pour(username);
        } catch (e) {
          return {
            refus: errPw("sandbox_unavailable", "", {
              message: `Your sandbox could not be reached to read the files: ${e instanceof Error ? e.message : strPy(e)}.`,
            }),
          };
        }
      r = await lireDuBac(esp, f.trim(), reste);
    } else if (f !== null && typeof f === "object" && !Array.isArray(f))
      r = contenuFourni(f as Dict, i, reste);
    else
      r = errPw("invalid_files", "", {
        message: `files[${i}] is neither a path nor {name, content_base64}.`,
        fix: CORRECTIF,
      });
    if ("ok" in r) return { refus: r };
    fichiers.push(r as FichierEnvoye);
    reste -= Math.floor(((r as FichierEnvoye).content_base64.length / 4) * 3);
  }
  return { fichiers };
}
