// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-skins.ts — console › Système › Apparence : liste, état, import, formulaire, export et suppression des skins (routes/admin/skins.py). */
import { open } from "node:fs/promises";

import type { FastifyReply, FastifyRequest } from "fastify";

import { deleteSkin, exportZip, importZip, saveFromEditor, setState } from "../apparence/ecritures";
import {
  defaultSkin,
  listSkins,
  MAX_ZIP_BYTES,
  SkinError,
  SkinExistsError,
  SkinNotFoundError,
  skinDetail,
} from "../apparence/skins";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import { ErreurValidation, HttpError } from "@elpis/commun";
import type { ErreurPydantic } from "@elpis/commun";
import { corpsJson, lireFormulaire, py, valeursFormulaire, validerPy } from "@elpis/http";
import type { FichierRecu } from "@elpis/http";

/** Erreurs d'E/S que le gestionnaire commun rend en 400 : le moteur Python les laisse en 500 (R6 de B1-25). */
const CODES_REQUALIFIES = new Set(["ENAMETOOLONG", "ELOOP", "EINVAL", "EILSEQ"]);

function charge(): Record<string, unknown> {
  return { skins: listSkins(true), default: defaultSkin() };
}

/** `_err` : introuvable 404, existe déjà 409, autre refus 400 ; une erreur d'E/S reste une panne 500. */
async function moteur<T>(f: () => T | Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof SkinNotFoundError) throw new HttpError(404, e.message);
    if (e instanceof SkinExistsError) throw new HttpError(409, e.message);
    if (e instanceof SkinError) throw new HttpError(400, e.message);
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && CODES_REQUALIFIES.has(code)) throw new Error(String(e), { cause: e });
    throw e;
  }
}

function route(
  methode: "GET" | "POST" | "PUT" | "DELETE",
  chemin: string,
  traiter: Traitement,
): DefinitionRoute {
  return { methode, chemin, processus: ["admin"], acces: "admin", traiter };
}

function idDe(req: FastifyRequest): string {
  return (req.params as { skin_id: string }).skin_id;
}

/** `await file.read(MAX_ZIP_BYTES + 1)` : au plus un octet de plus que le plafond, l'import refuse alors l'archive. */
async function lireBorne(f: FichierRecu, max: number): Promise<Buffer> {
  const fd = await open(f.chemin, "r");
  try {
    const tampon = Buffer.alloc(Math.min(f.taille, max));
    const { bytesRead } = await fd.read(tampon, 0, tampon.length, 0);
    return tampon.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}

/** `file: UploadFile = File(...)`, `overwrite: bool = Form(False)` : un seul 422 dans l'ordre des paramètres. */
async function formulaireImport(req: FastifyRequest): Promise<{ fichier: FichierRecu; overwrite: boolean }> {
  const f = await lireFormulaire(req);
  const erreurs: ErreurPydantic[] = [];
  let fichier: FichierRecu | null = null;
  try {
    fichier = valeursFormulaire(f, { file: { type: "fichier", requis: true } }).file;
  } catch (e) {
    if (!(e instanceof ErreurValidation)) throw e;
    erreurs.push(...e.erreurs);
  }
  let overwrite = false;
  const brut = f.get("overwrite");
  if (brut !== undefined && brut !== "") {
    const r = validerPy(py.bool(), typeof brut === "string" ? brut : { filename: brut.filename }, [
      "body",
      "overwrite",
    ]);
    if (r.ok) overwrite = r.valeur;
    else erreurs.push(...r.erreurs);
  }
  if (erreurs.length > 0 || fichier === null) throw new ErreurValidation(erreurs);
  return { fichier, overwrite };
}

export function creerFamilleAdminSkins(): Famille {
  return {
    nom: "admin-skins",
    routes: [
      route("GET", "/api/admin/skins", (_req, rep: FastifyReply) =>
        rep.header("cache-control", "no-cache").send(charge()),
      ),
      route("PUT", "/api/admin/skins", async (req) => {
        const corps = corpsJson(req);
        if (corps === null || typeof corps !== "object" || Array.isArray(corps))
          throw new HttpError(400, "Objet JSON attendu.");
        const c = corps as Record<string, unknown>;
        await moteur(() =>
          setState(
            Object.hasOwn(c, "enabled") ? c["enabled"] : null,
            Object.hasOwn(c, "default") ? c["default"] : null,
          ),
        );
        return charge();
      }),
      route("POST", "/api/admin/skins/import", async (req) => {
        const { fichier, overwrite } = await formulaireImport(req);
        const octets = await lireBorne(fichier, MAX_ZIP_BYTES + 1);
        const skin = await moteur(() => importZip(octets, overwrite));
        return { ok: true, skin, ...charge() };
      }),
      route("POST", "/api/admin/skins", async (req) => {
        const corps = corpsJson(req);
        const skin = await moteur(() => saveFromEditor(corps));
        return { ok: true, skin, ...charge() };
      }),
      route("GET", "/api/admin/skins/:skin_id/export", async (req, rep) => {
        const [nom, octets] = await moteur(() => exportZip(idDe(req)));
        return rep
          .type("application/zip")
          .headers({ "content-disposition": `attachment; filename="${nom}"`, "cache-control": "no-store" })
          .send(octets);
      }),
      route("GET", "/api/admin/skins/:skin_id", (req) => moteur(() => skinDetail(idDe(req)))),
      route("DELETE", "/api/admin/skins/:skin_id", async (req) => {
        await moteur(() => deleteSkin(idDe(req)));
        return { ok: true, ...charge() };
      }),
    ],
  };
}
