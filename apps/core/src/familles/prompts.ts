// SPDX-License-Identifier: MIT
/** apps/core/src/familles/prompts.ts — prompts enregistrés, partagés et templates du compte (shared_infra/chat/routes_prompts.py). */
import { getUsersLite } from "@elpis/auth";
import {
  entierOuNulPy,
  ErreurPython,
  estDict,
  getPy,
  HttpError,
  intPy,
  iterExige,
  longueurPy,
  nomTypePy,
  prefixePy,
  reprPy,
  stripPy,
  veritePy,
} from "@elpis/commun";
import type { Base, Ligne } from "@elpis/db";

import {
  createTemplate,
  deleteTemplate,
  ErreurGabarit,
  listTemplates,
  updateTemplate,
} from "../chats/gabarits";
import {
  clearAllSharedPrompts,
  deletePrompt,
  deleteSharedPrompt,
  getPromptById,
  listSavedPrompts,
  listSharedPrompts,
  savePrompt,
  sharePromptToUsers,
} from "../chats/prompts";
import type { Famille } from "../routes";
import { utilisateur } from "./comptes";
import { corpsJsonValeurs, entrees, py } from "@elpis/http";

export interface DependancesPrompts {
  readonly base: Base;
}

/** `data.get(cle, "").strip()` : une valeur qui n'est pas du texte lève comme `.strip()`. */
function texteNettoye(data: unknown, cle: string): string {
  const v = getPy(data, cle, "");
  if (typeof v !== "string")
    throw new ErreurPython("AttributeError", `'${nomTypePy(v)}' object has no attribute 'strip'`);
  return stripPy(v);
}

/** `_tpl_body` : corps JSON objet, sinon 400. */
function corpsGabarit(req: Parameters<typeof corpsJsonValeurs>[0]): Record<string, unknown> {
  let data: unknown;
  try {
    data = corpsJsonValeurs(req);
  } catch {
    throw new HttpError(400, "Corps JSON attendu.");
  }
  if (!estDict(data)) throw new HttpError(400, "Corps JSON attendu.");
  return data;
}

function gabaritOuErreur<T>(f: () => Promise<T>): Promise<T> {
  return f().catch((e: unknown) => {
    if (e instanceof ErreurGabarit) throw new HttpError(e.status, e.message);
    throw e;
  });
}

export function creerFamillePrompts(dep: DependancesPrompts): Famille {
  const base = dep.base;
  const idDe = (req: Parameters<typeof utilisateur>[0], nom: string): number =>
    entrees(req, { path: { [nom]: py.int() } }).path[nom] as number;
  const route = (
    methode: "GET" | "POST" | "PUT" | "DELETE",
    chemin: string,
    traiter: Famille["routes"][number]["traiter"],
  ) => ({
    methode,
    chemin,
    processus: ["main"] as const,
    acces: "session" as const,
    traiter,
  });
  return {
    nom: "prompts",
    routes: [
      route("GET", "/api/prompts", async (req) => ({
        items: await listSavedPrompts(base, utilisateur(req)),
      })),
      route("POST", "/api/prompts", async (req) => {
        const uid = utilisateur(req);
        const data = corpsJsonValeurs(req);
        const content = texteNettoye(data, "content");
        let title = texteNettoye(data, "title");
        if (!content) throw new HttpError(400, "Content required");
        if (!title) title = longueurPy(content) > 30 ? `${prefixePy(content, 30)}...` : content;
        return { id: await savePrompt(base, uid, title, content), ok: true };
      }),
      route("DELETE", "/api/prompts/:prompt_id", async (req) => {
        const uid = utilisateur(req);
        if (await deletePrompt(base, uid, idDe(req, "prompt_id"))) return { ok: true };
        throw new HttpError(404, "Prompt not found");
      }),
      route("GET", "/api/prompts/shared", async (req) => ({
        items: await listSharedPrompts(base, utilisateur(req)),
      })),
      route("POST", "/api/prompts/share", async (req) => {
        const uid = utilisateur(req);
        const data = corpsJsonValeurs(req);
        const promptId = getPy(data, "prompt_id");
        const cibles = getPy(data, "user_ids", []);
        if (!veritePy(promptId) || !veritePy(cibles)) throw new HttpError(400, "Données manquantes");
        if (!Array.isArray(cibles)) throw new HttpError(400, "user_ids doit être une liste");
        const ids: number[] = [];
        for (const x of cibles) {
          const n = entierOuNulPy(x);
          if (n === null) throw new HttpError(400, "user_ids doit contenir uniquement des entiers");
          ids.push(n);
        }
        if (ids.length === 0) throw new HttpError(400, "user_ids vide");
        if (ids.length > 500) throw new HttpError(400, "Trop de destinataires (max 500)");
        const moi = await base.get<{ is_admin: unknown }>("SELECT * FROM users WHERE id=?", [uid]);
        if (!(moi && Number(moi.is_admin) === 1)) {
          const permis = new Set((await getUsersLite(base, uid, true)).map((u) => Number(u.id)));
          const hors = ids.filter((t) => !permis.has(t));
          if (hors.length)
            throw new HttpError(403, `Destinataire(s) hors de votre périmètre : ${reprPy(hors.slice(0, 5))}`);
        } else {
          const existants = new Set((await getUsersLite(base, uid, false)).map((u) => Number(u.id)));
          existants.add(uid);
          const absents = ids.filter((t) => !existants.has(t));
          if (absents.length)
            throw new HttpError(404, `Destinataire(s) introuvable(s) : ${reprPy(absents.slice(0, 5))}`);
        }
        const prompt: Ligne | null = await getPromptById(base, uid, intPy(promptId));
        if (!prompt) throw new HttpError(404, "Prompt introuvable");
        await sharePromptToUsers(base, uid, ids, prompt["title"], prompt["content"]);
        return { ok: true, shared_count: ids.length };
      }),
      route("DELETE", "/api/prompts/shared/all", async (req) => {
        await clearAllSharedPrompts(base, utilisateur(req));
        return { ok: true };
      }),
      route("DELETE", "/api/prompts/shared/:prompt_id", async (req) => {
        const uid = utilisateur(req);
        if (await deleteSharedPrompt(base, uid, idDe(req, "prompt_id"))) return { ok: true };
        throw new HttpError(404, "Prompt partagé introuvable");
      }),
      route("POST", "/api/prompts/shared/delete-batch", async (req) => {
        const uid = utilisateur(req);
        let n = 0;
        for (const pid of iterExige(getPy(corpsJsonValeurs(req), "ids", [])))
          if (await deleteSharedPrompt(base, uid, intPy(pid))) n++;
        return { ok: true, deleted: n };
      }),
      route("GET", "/api/prompt-templates", async (req) => ({
        items: await listTemplates(base, utilisateur(req)),
      })),
      route("POST", "/api/prompt-templates", async (req) => {
        const uid = utilisateur(req);
        const data = corpsGabarit(req);
        return { ok: true, item: await gabaritOuErreur(() => createTemplate(base, uid, data)) };
      }),
      route("PUT", "/api/prompt-templates/:template_id", async (req) => {
        const uid = utilisateur(req);
        const id = idDe(req, "template_id");
        const data = corpsGabarit(req);
        const item = await gabaritOuErreur(() => updateTemplate(base, uid, id, data));
        if (item === null) throw new HttpError(404, "Template introuvable.");
        return { ok: true, item };
      }),
      route("DELETE", "/api/prompt-templates/:template_id", async (req) => {
        const uid = utilisateur(req);
        if (!(await deleteTemplate(base, uid, idDe(req, "template_id"))))
          throw new HttpError(404, "Template introuvable.");
        return { ok: true };
      }),
    ],
  };
}
