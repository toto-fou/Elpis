// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/procedures/outils.ts — `pw_run` (rejoue une procédure sans LLM) et `pw_procedure` (liste, lecture, enregistrement et suppression des procédures du compte). */
import { randomBytes, randomUUID } from "node:crypto";

import { estDict } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { aControle, mesurer, parcourir, validerProcedure, verifierReparation } from "@elpis/contracts";
import type { Procedure } from "@elpis/contracts";
import { messageErreur } from "@elpis/mcp";
import { errPw } from "@elpis/navigateur";
import { getUsername, Heartbeat } from "@elpis/outils-mcp";
import type { ContexteAppel } from "@elpis/outils-mcp";

import { ouvrirAppel } from "../appel";
import type { ServicesBrowser } from "../appel";
import { jetonSeul, secretsRecents } from "../creds";
import { executer, pageCourante } from "./moteur";
import { contexteReparation } from "./reparation";
import {
  annulerAttentes,
  attenteReparation,
  filiation,
  reparationPermise,
  reprendreReparation,
  reserverReparation,
  rendreReparation,
  terminerReparation,
  attenteEnCours,
  empreinte,
  lire,
  lister,
  lireTexte,
  noterExecution,
  reprendre,
  sauvegarder,
  supprimer,
} from "./stockage";

const PARAM_LONGUEUR = 500;
const FIX_LISTE = "pw_procedure(action='list') lists the saved procedures";

/** Valeurs des paramètres, toutes présentes et du bon type, avant toute exécution ; une référence `⟦creds:…@origine⟧` doit viser l'origine de la procédure. */
export function validerParametres(
  p: Procedure,
  brut: unknown,
): { ok: true; valeurs: Record<string, string | number> } | { ok: false; erreurs: string[] } {
  const erreurs: string[] = [];
  const valeurs = Object.create(null) as Record<string, string | number>;
  if (brut !== null && brut !== undefined && !estDict(brut))
    return { ok: false, erreurs: ["params must be an object"] };
  const donnes = (brut ?? {}) as Dict;
  for (const nom of Object.keys(donnes))
    if (!Object.hasOwn(p.params, nom)) erreurs.push(`unknown parameter ${nom}`);
  for (const [nom, type] of Object.entries(p.params)) {
    const v = Object.hasOwn(donnes, nom) ? donnes[nom] : undefined;
    if (v === undefined || v === null) {
      erreurs.push(`missing parameter ${nom} (${type})`);
      continue;
    }
    if (type === "number") {
      // Décimal simple seulement : ni hexadécimal, ni exposant, ni Infinity.
      const n =
        typeof v === "number"
          ? v
          : typeof v === "string" && /^-?\d{1,15}(\.\d{1,15})?$/u.test(v)
            ? Number(v)
            : Number.NaN;
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
    const demandee = Number(a["version"] ?? 0) > 0 ? Number(a["version"]) : 0;
    try {
      const brut = await lireTexte(ax, username, id, demandee);
      if (brut === undefined)
        return errPw("procedure_not_found", "", {
          message: `no procedure ${id}${demandee ? ` v${demandee}` : ""}`,
          fix: FIX_LISTE,
        });
      let arbre: unknown = null;
      try {
        arbre = JSON.parse(brut.texte);
      } catch {
        arbre = null;
      }
      const version = brut.version;
      const v = validerProcedure(arbre);
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
      const sessionId = String(a["session_id"]);
      const demandes = (Array.isArray(a["confirmed"]) ? a["confirmed"] : []).filter(
        (x): x is string => typeof x === "string",
      );
      const ref = { owner: username, procedureId: v.procedure.id, version, sessionId };
      const resume = String(a["resume"] ?? "").trim();
      if (resume !== "" && demandes.length > 0)
        return errPw("resume_and_confirmed", "", {
          message: "pass either resume= (after a repair) or confirmed= (after a confirmation), not both",
        });
      let confirmes: string[] = [];
      let chain: string = randomUUID();
      let reprise: string | null = null;
      if (resume !== "") {
        // Reprise après réparation : usage unique, même session, version réparée, arbre et page identiques à ceux de la réparation.
        const rr = await reprendreReparation(ax, {
          ...ref,
          token: resume,
          texte: brut.texte,
          page: await pageCourante(client, sessionId),
        });
        if (rr === null)
          return errPw("repair_expired", "", {
            message:
              "no repair matches resume= (already used, expired, other session, other version, the tree changed, or the page is not the one where the run stopped): nothing was done by this call. The steps BEFORE the repaired node already ran",
            fix: "inspect the page first (pw_page); do not blindly replay the procedure from the start, its earlier steps already took effect",
          });
        reprise = rr.chemin;
        chain = rr.chain ?? chain;
      }
      if (demandes.length > 0) {
        // Un accord ne vaut que par l'attente enregistrée pour CE nœud, CETTE version et CET arbre ; sinon aucun geste.
        const attente = await attenteEnCours(ax, ref);
        const noeud =
          attente === null ? undefined : [...parcourir(v.procedure.root)].find(([, c]) => c === attente)?.[0];
        const confirmable =
          noeud !== undefined && "act" in noeud && noeud.confirm === true && !attente?.includes(".retry");
        const rc =
          attente !== null && demandes.includes(attente) && confirmable
            ? await reprendre(ax, {
                ...ref,
                texte: brut.texte,
                chemin: attente,
                page: await pageCourante(client, sessionId),
              })
            : null;
        if (attente === null || rc === null)
          return errPw("confirmation_expired", "", {
            message:
              "no pending confirmation matches (expired, other session, other version, the tree changed, or the page is not the one where the run stopped): nothing was done by this call. The steps BEFORE the confirm node already ran in the earlier call",
            fix: "inspect the page first (pw_page); do not blindly replay the procedure from the start, its earlier steps already took effect. If the user still agrees, rerun it only when repeating those steps is safe",
          });
        confirmes = [attente];
        reprise = attente;
        chain = rc.chain ?? chain;
      }
      // Toute nouvelle exécution annule les attentes précédentes de la session.
      await annulerAttentes(ax, username, sessionId);
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
      // Échec réparable : le modèle reçoit le contexte et un repair_id enregistré comme une confirmation (limites : 2 par exécution logique, 1 par nœud).
      const echec = r.status === "failed" ? r.failed_at : undefined;
      const page =
        r.status === "needs_confirmation" || echec?.repairable === true
          ? await pageCourante(client, sessionId)
          : "";
      let repair: Dict | null = null;
      let token: string | undefined;
      let indisponible: string | undefined;
      if (echec?.repairable === true) {
        if (await reparationPermise(ax, { owner: username, chain, chemin: echec.path })) {
          token = `rp_${randomBytes(12).toString("hex")}`;
          repair = await contexteReparation(client, {
            sessionId,
            procedure: v.procedure,
            echec,
            repairId: token,
            secrets: secretsRecents(username),
          });
        } else indisponible = "repair_limit: at most 2 repairs per run and 1 per node; the failure is final";
      }
      await noterExecution(ax, {
        owner: username,
        procedureId: v.procedure.id,
        version,
        sessionId,
        debut,
        fin: Date.now() / 1000,
        issue: repair !== null ? "needs_repair" : r.status,
        noeudEnEchec: r.failed_at?.path ?? r.node_path ?? null,
        dureeMs: r.duration_ms,
        chain,
        ...(token !== undefined ? { token, pageKey: page } : {}),
        ...(r.status === "needs_confirmation" && r.node_path !== undefined
          ? { empreinte: empreinte(brut.texte, r.node_path, version, page) }
          : {}),
      }).catch((e: unknown) => s.journal.warn(`[procedures] journal d'exécution : ${messageErreur(e)}`));
      const { failed_at: fa, ...reste } = r;
      return {
        ok: r.status === "ok",
        procedure: v.procedure.id,
        version,
        resumed_from: reprise,
        ...reste,
        ...(fa !== undefined
          ? {
              failed_at: {
                path: fa.path,
                reason: fa.reason,
                tried_targets: fa.tried_targets,
                ...(repair !== null ? { repair } : {}),
                ...(indisponible !== undefined ? { repair_unavailable: indisponible } : {}),
              },
            }
          : {}),
        ...(r.status === "needs_confirmation"
          ? {
              next: `ask the user, then pw_run(session_id, procedure='${id}', params, version=${version}, confirmed=['${r.node_path ?? ""}'])`,
            }
          : {}),
        ...(repair !== null
          ? {
              next: `fix the node with pw_procedure(action='repair', id='${v.procedure.id}', repair_id='${token}', node={...}); then pw_run(session_id, procedure='${v.procedure.id}', params, version=<new_version>, resume='${token}')`,
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
        if (t === null || typeof t !== "object")
          return errPw("procedure_corrupted", "", {
            message: `the stored tree of ${id} is unreadable`,
            fix: "save a corrected version with pw_procedure(action='save') or delete it",
          });
        const filio = await filiation(ax, owner, id, Number((t as { version?: unknown }).version) || version);
        return { ok: true, action, procedure: t, ...(filio !== undefined ? { lineage: filio } : {}) };
      }
      if (action === "repair") {
        const token = String(a["repair_id"] ?? "").trim();
        const att = id === "" ? undefined : await attenteReparation(ax, { owner, procedureId: id, token });
        if (att === undefined)
          return errPw("repair_expired", "", {
            message:
              "no pending repair matches (unknown, expired after 15 min, already used, or superseded by another run)",
            fix: "rerun the procedure with pw_run: a new repair_id is given if the failure is repairable. Its earlier steps already took effect once, inspect the page first",
          });
        if (
          att.chain === null ||
          !(await reparationPermise(ax, { owner, chain: att.chain, chemin: att.chemin }))
        )
          return errPw("repair_limit", "", {
            message: "at most 2 repairs per run and 1 per node: this failure is final",
          });
        const stocke = await lireTexte(ax, owner, id, att.version);
        let ancien: unknown = null;
        try {
          ancien = stocke === undefined ? null : JSON.parse(stocke.texte);
        } catch {
          ancien = null;
        }
        const va = validerProcedure(ancien);
        if (!va.ok)
          return errPw("procedure_invalid", "", {
            message: "the failed version is no longer readable: " + va.erreurs.join(" ; "),
          });
        const vr = verifierReparation(va.procedure, att.chemin, a["node"]);
        if (!vr.ok)
          return errPw("repair_refused", "", {
            message: vr.erreurs.join(" ; "),
            fix: "send a corrected node: same origin and params, no new login, confirm kept, goto only to paths already in the tree, at most 15 nodes and 4 KB. The repair_id stays valid",
          });
        if (!(await reserverReparation(ax, att.id)))
          return errPw("repair_expired", "", { message: "this repair_id was just used" });
        try {
          const sv = await sauvegarder(ax, owner, vr.procedure, { parent: att.version, chemin: att.chemin });
          if (!sv.ok) {
            await rendreReparation(ax, att.id);
            return errPw(sv.code, "", { message: sv.message });
          }
          await terminerReparation(ax, att.id, {
            nouvelleVersion: sv.version,
            empreinte: empreinte(sv.texte, att.chemin, sv.version, att.page),
          });
          return {
            ok: true,
            action,
            status: "repaired",
            id,
            new_version: sv.version,
            parent_version: att.version,
            path: att.chemin,
            next: `pw_run(session_id, procedure='${id}', params, version=${sv.version}, resume='${token}') resumes at ${att.chemin} on the same session and page without replaying the earlier steps; or rerun from the start with version=${sv.version} (the earlier steps already took effect once)`,
          };
        } catch (e) {
          await rendreReparation(ax, att.id).catch(() => undefined);
          throw e;
        }
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
        fix: "use: list|get|save|repair|delete",
      });
    } catch (e) {
      return errPw("procedure_store_error", "", { message: messageErreur(e) });
    }
  };
}
