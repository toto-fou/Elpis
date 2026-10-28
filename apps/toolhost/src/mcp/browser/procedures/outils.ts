// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/procedures/outils.ts — `pw_run` (rejoue une procédure sans LLM) et `pw_procedure` (liste, lecture, enregistrement et suppression des procédures du compte). */
import { estDict } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { aControle, mesurer, validerProcedure } from "@elpis/contracts";
import type { Procedure } from "@elpis/contracts";
import { messageErreur } from "@elpis/mcp";
import { errPw } from "@elpis/navigateur";
import { getUsername, Heartbeat } from "@elpis/outils-mcp";
import type { ContexteAppel } from "@elpis/outils-mcp";

import { ouvrirAppel } from "../appel";
import type { ServicesBrowser } from "../appel";
import { jetonSeul } from "../creds";
import { executer } from "./moteur";
import { lire, lister, noterExecution, reprendre, sauvegarder, supprimer } from "./stockage";

const PARAM_LONGUEUR = 500;
const CONFIRMES_MAX = 20;
const FIX_LISTE = "pw_procedure(action='list') lists the saved procedures";

/** Valeurs des paramètres, toutes présentes et du bon type, avant toute exécution ; une référence `⟦creds:…@origine⟧` doit viser l'origine de la procédure. */
export function validerParametres(
  p: Procedure,
  brut: unknown,
): { ok: true; valeurs: Record<string, string | number> } | { ok: false; erreurs: string[] } {
  const erreurs: string[] = [];
  const valeurs: Record<string, string | number> = {};
  if (brut !== null && brut !== undefined && !estDict(brut))
    return { ok: false, erreurs: ["params must be an object"] };
  const donnes = (brut ?? {}) as Dict;
  for (const nom of Object.keys(donnes))
    if (!Object.hasOwn(p.params, nom)) erreurs.push(`unknown parameter ${nom}`);
  for (const [nom, type] of Object.entries(p.params)) {
    const v = donnes[nom];
    if (v === undefined || v === null) {
      erreurs.push(`missing parameter ${nom} (${type})`);
      continue;
    }
    if (type === "number") {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
      if (Number.isFinite(n)) valeurs[nom] = n;
      else erreurs.push(`parameter ${nom} must be a number`);
      continue;
    }
    if (typeof v !== "string" || v.length > PARAM_LONGUEUR || (type === "string" && aControle(v))) {
      erreurs.push(`parameter ${nom} must be a string of ${PARAM_LONGUEUR} characters at most`);
      continue;
    }
    if (type === "string") {
      if (v.includes("⟦"))
        erreurs.push(`parameter ${nom}: a ⟦creds:…⟧ reference is only valid for a creds parameter`);
      else valeurs[nom] = v;
      continue;
    }
    const origine = /^⟦\s*creds:[^⟧@]*@([^⟧]*)⟧/u.exec(v)?.[1]?.trim();
    if (jetonSeul(v) === null)
      erreurs.push(`parameter ${nom} must be a ⟦creds:TOKEN@ORIGIN⟧ supplied by the user`);
    else if (origine !== undefined && origine !== "" && origine !== p.origin)
      erreurs.push(`parameter ${nom}: the login is bound to ${origine}, the procedure targets ${p.origin}`);
    else valeurs[nom] = v;
  }
  return erreurs.length > 0 ? { ok: false, erreurs } : { ok: true, valeurs };
}

/** `pw_run` : valide la procédure et les paramètres, puis la rejoue (budget, annulation, arrêt sur geste ambigu) et journalise l'issue. */
export function pwRun(s: ServicesBrowser) {
  return async (a: Dict, ctx: ContexteAppel): Promise<unknown> => {
    const o = await ouvrirAppel(ctx, s, a["session_id"]);
    if (o.refus !== null) return o.refus;
    const { client, ax, username } = o.appel;
    if (ax === null)
      return errPw("procedures_unavailable", "", {
        message: "the procedure store is unavailable (no database)",
      });
    const id = String(a["procedure"] ?? "").trim();
    const version = Number(a["version"] ?? 0) > 0 ? Number(a["version"]) : 0;
    try {
      const brut = await lire(ax, username, id, version);
      if (brut === undefined)
        return errPw("procedure_not_found", "", {
          message: `no procedure ${id}${version ? ` v${version}` : ""}`,
          fix: FIX_LISTE,
        });
      const v = validerProcedure(brut);
      if (!v.ok)
        return errPw("procedure_invalid", "", {
          message: v.erreurs.join(" ; "),
          fix: "save a corrected version with pw_procedure(action='save')",
        });
      const params = validerParametres(v.procedure, a["params"]);
      if (!params.ok)
        return errPw("params_invalid", "", {
          message: params.erreurs.join(" ; "),
          fix: `pass params={${Object.entries(v.procedure.params)
            .map(([k, t]) => `${k}: <${t}>`)
            .join(", ")}}`,
        });
      const confirmes = (Array.isArray(a["confirmed"]) ? a["confirmed"] : [])
        .filter((x): x is string => typeof x === "string" && /^0(\.[A-Za-z0-9]+)*$/u.test(x))
        .slice(0, CONFIRMES_MAX);
      const sessionId = String(a["session_id"]);
      const reprise = await reprendre(ax, {
        owner: username,
        procedureId: v.procedure.id,
        version: v.procedure.version,
        sessionId,
        chemins: confirmes,
      });
      const debut = Date.now() / 1000;
      const r = await new Heartbeat(ctx).avec(() =>
        executer(s, ctx, client, v.procedure, {
          sessionId,
          username,
          params: params.valeurs,
          confirmed: confirmes,
          reprise,
        }),
      );
      await noterExecution(ax, {
        owner: username,
        procedureId: v.procedure.id,
        version: v.procedure.version,
        sessionId,
        debut,
        fin: Date.now() / 1000,
        issue: r.status,
        noeudEnEchec: r.failed_at?.path ?? r.node_path ?? null,
        dureeMs: r.duration_ms,
      }).catch((e: unknown) => s.journal.warn(`[procedures] journal d'exécution : ${messageErreur(e)}`));
      return {
        ok: r.status === "ok",
        procedure: v.procedure.id,
        version: v.procedure.version,
        resumed_from: reprise,
        ...r,
        ...(r.status === "needs_confirmation"
          ? {
              next: `ask the user, then pw_run(session_id, procedure='${id}', params, confirmed=['${r.node_path ?? ""}'])`,
            }
          : {}),
      };
    } catch (e) {
      return errPw("procedure_run_failed", "", { message: messageErreur(e) });
    }
  };
}

/** `pw_procedure` : procédures du compte (les arbres valides seulement sont enregistrés ; chaque `save` crée une version). */
export function pwProcedure(s: ServicesBrowser) {
  return async (a: Dict, ctx: ContexteAppel): Promise<unknown> => {
    const ax = s.ax();
    if (ax === null)
      return errPw("procedures_unavailable", "", {
        message: "the procedure store is unavailable (no database)",
      });
    const owner = getUsername(ctx);
    const action = String(a["action"] ?? "").trim();
    const id = String(a["id"] ?? "").trim();
    const version = Number(a["version"] ?? 0) > 0 ? Number(a["version"]) : 0;
    try {
      if (action === "list") {
        const l = await lister(ax, owner, String(a["origin"] ?? "").trim());
        return { ok: true, action, count: l.length, procedures: l };
      }
      if (action === "get") {
        if (!id) return errPw("id_required", "", { message: "get needs id", fix: FIX_LISTE });
        const t = await lire(ax, owner, id, version);
        if (t === undefined)
          return errPw("procedure_not_found", "", { message: `no procedure ${id}`, fix: FIX_LISTE });
        return { ok: true, action, procedure: t };
      }
      if (action === "save") {
        const v = validerProcedure(a["procedure"]);
        if (!v.ok)
          return errPw("procedure_invalid", "", {
            message: v.erreurs.join(" ; "),
            fix: "fix the tree and save again; see the pw_procedure description for the format",
          });
        const r = await sauvegarder(ax, owner, v.procedure);
        if (!r.ok) return errPw(r.code, "", { message: r.message });
        return { ok: true, action, id: r.id, version: r.version, nodes: mesurer(v.procedure.root).noeuds };
      }
      if (action === "delete") {
        if (!id) return errPw("id_required", "", { message: "delete needs id", fix: FIX_LISTE });
        return { ok: true, action, id, deleted: await supprimer(ax, owner, id, version) };
      }
      return errPw("unknown_action", "", {
        message: `action ${JSON.stringify(action)} unknown`,
        fix: "use: list|get|save|delete",
      });
    } catch (e) {
      return errPw("procedure_store_error", "", { message: messageErreur(e) });
    }
  };
}
