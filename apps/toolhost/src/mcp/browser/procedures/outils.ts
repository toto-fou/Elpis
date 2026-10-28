// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/procedures/outils.ts — `pw_run` (rejoue une procédure sans LLM) et `pw_procedure` (liste, lecture, enregistrement et suppression des procédures du compte). */
import { randomBytes, randomUUID } from "node:crypto";

import { estDict } from "@elpis/commun";
import type { Base } from "@elpis/db";
import type { Dict } from "@elpis/commun";
import {
  aConfirm,
  aControle,
  confirmesAffaiblis,
  mesurer,
  parcourir,
  validerProcedure,
  verifierReparation,
} from "@elpis/contracts";
import type { Act, Procedure } from "@elpis/contracts";
import { messageErreur } from "@elpis/mcp";
import { errPw } from "@elpis/navigateur";
import { getAccessToken, getUsername, Heartbeat, readMetaField } from "@elpis/outils-mcp";
import type { ContexteAppel } from "@elpis/outils-mcp";

import { ouvrirAppel } from "../appel";
import type { ServicesBrowser } from "../appel";
import { jetonSeul, secretsRecents } from "../creds";
import { lireSousAgent } from "@elpis/securite";

import type { CompteSigne } from "../../../rappel";
import { empreinteSubstituee, executer, pageCourante } from "./moteur";
import { contexteReparation } from "./reparation";
import {
  annulerAttentes,
  approbations,
  approuveesDe,
  versionApprouvee,
  rendreConfirmation,
  dejaReussi,
  oublierApprobations,
  enregistrerApprobations,
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
    if (typeof v === "string" && !v.isWellFormed()) {
      erreurs.push(`parameter ${nom} must be valid text (no lone surrogate)`);
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

/** Compte signé pour les accords humains : client de confiance (l'application), conversation connue ; sinon la raison du refus. */
async function compteAccord(
  s: ServicesBrowser,
  ctx: ContexteAppel,
  username: string,
): Promise<{ compte: CompteSigne } | { raison: string }> {
  if (s.rappel === null || !s.rappel.actif)
    return { raison: "the approval service is not reachable from the tools host" };
  if (getAccessToken()?.claims["trusted_meta"] !== true)
    return { raison: "approvals are only available from the user's own conversation" };
  const chatId = readMetaField(ctx, "chat_id") ?? "";
  if (chatId === "") return { raison: "no conversation to show the approval in" };
  const identite = await s.rappel.identityForUsername(username);
  if (identite === null) return { raison: "account not resolvable for approvals" };
  return {
    compte: {
      user_id: identite.user_id,
      username,
      chat_id: chatId,
      subagent: lireSousAgent(ctx.meta?.["subagent"]),
    },
  };
}

/** Un humain est là : client de confiance, conversation ordinaire (ni routine ni sous-agent) ; sinon seules les versions approuvées s'exécutent. */
function contexteHumain(ctx: ContexteAppel): boolean {
  const chat = readMetaField(ctx, "chat_id") ?? "";
  return (
    getAccessToken()?.claims["trusted_meta"] === true &&
    chat !== "" &&
    !chat.startsWith("routine:") &&
    !lireSousAgent(ctx.meta?.["subagent"])
  );
}

/** Le nœud est (sous) le chemin réparé par la version : son `once` vient d'une réparation, sinon d'un enregistrement. */
async function venantDUneReparation(
  ax: Base,
  owner: string,
  id: string,
  version: number,
  chemin: string,
): Promise<boolean> {
  const f = await filiation(ax, owner, id, version);
  const rp = f?.repaired_path ?? null;
  return rp !== null && (chemin === rp || chemin.startsWith(`${rp}.`));
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
      if (!contexteHumain(ctx) && !(await versionApprouvee(ax, username, v.procedure.id, version)))
        return errPw("version_not_approved", "", {
          message: `version ${version} of ${v.procedure.id} was not approved by the user: without a human in the conversation (routine, sub-agent) only approved versions run. Nothing was done`,
          fix: "tell the user to approve this version in Paramètres › Procédures (a version created or repaired by the model is never approved)",
        });
      if (a["confirmed"] !== undefined)
        return errPw("confirmed_removed", "", {
          message:
            "confirmed= no longer exists: a sensitive gesture needs the USER's approval, given by a button in the chat that you cannot press",
          fix: "run the procedure: when it stops with needs_confirmation, tell the user to press « Approuver » on the card in the chat, wait for their message « Approuvé : … », then call pw_run(..., approval='<approval id>')",
        });
      const approval = String(a["approval"] ?? "").trim();
      const ref = { owner: username, procedureId: v.procedure.id, version, sessionId };
      const resume = String(a["resume"] ?? "").trim();
      if (resume !== "" && approval !== "")
        return errPw("resume_and_approval", "", {
          message: "pass either resume= (after a repair) or approval= (after the user's approval), not both",
        });
      let confirmes: string[] = [];
      let approbation: { path: string; fp: string } | null = null;
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
      if (approval !== "") {
        // L'accord vaut pour l'attente enregistrée de CE nœud, CETTE version, CET arbre, CETTE page ET CES valeurs substituées, vérifié côté serveur.
        const expire = (): unknown =>
          errPw("confirmation_expired", "", {
            message:
              "no pending confirmation matches (expired, other session, other version, the tree changed, or the page is not the one where the run stopped): nothing was done by this call. The steps BEFORE the confirm node already ran in the earlier call",
            fix: "inspect the page first (pw_page); do not blindly replay the procedure from the start, its earlier steps already took effect. If the user still agrees, rerun it only when repeating those steps is safe",
          });
        const attente = await attenteEnCours(ax, ref);
        const noeud =
          attente === null ? undefined : [...parcourir(v.procedure.root)].find(([, c]) => c === attente)?.[0];
        if (
          attente === null ||
          noeud === undefined ||
          !("act" in noeud) ||
          !aConfirm(noeud) ||
          attente.includes(".retry")
        )
          return expire();
        const page = await pageCourante(client, sessionId);
        const rc = await reprendre(ax, { ...ref, texte: brut.texte, chemin: attente, page });
        if (rc === null) return expire();
        const fp = empreinteSubstituee(attente, noeud as Act, params.valeurs, v.procedure.origin);
        const c = await compteAccord(s, ctx, username);
        const cr =
          "compte" in c
            ? await s.rappel?.consommerApprobation(c.compte, approval, {
                session_id: sessionId,
                procedure_id: v.procedure.id,
                version,
                path: attente,
                fingerprint: fp,
                page,
              })
            : null;
        if (cr === null || cr === undefined || !cr.ok) {
          await rendreConfirmation(ax, rc.id).catch(() => undefined);
          const code = cr === null || cr === undefined ? "approval_unavailable" : cr.code;
          return errPw(code, "", {
            message:
              cr === null || cr === undefined
                ? `the approval could not be checked: ${"raison" in c ? c.raison : "the approval service did not answer"}. Nothing was done`
                : `${cr.message}. Nothing was done by this call`,
            fix: "tell the user that the gesture still needs their approval by the « Approuver » button of the card in the chat (rerun pw_run without approval to get a new request if it expired); never claim they approved",
          });
        }
        confirmes = [attente];
        approbation = { path: attente, fp };
        reprise = attente;
        chain = rc.chain ?? chain;
      }
      // Toute nouvelle exécution annule les attentes précédentes de la session.
      await annulerAttentes(ax, username, sessionId);
      const debut = Date.now() / 1000;
      const approuves = await approbations(ax, username, v.procedure.id);
      const r = await new Heartbeat(ctx).avec(() =>
        executer(s, ctx, client, v.procedure, {
          sessionId,
          username,
          params: params.valeurs,
          confirmed: confirmes,
          approbation,
          reprise,
          approuves,
        }),
      );
      // Les gestes `confirm: "once"` exécutés avec accord sont validés si l'exécution a réussi (ils ne redemandent plus).
      if ((r.onceFaits ?? []).length > 0 || r.status === "ok")
        await enregistrerApprobations(ax, {
          owner: username,
          id: v.procedure.id,
          chain,
          gestes: r.onceFaits ?? [],
          ok: r.status === "ok",
        }).catch((e: unknown) => s.journal.warn(`[procedures] approbations : ${messageErreur(e)}`));
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
        ...(token !== undefined
          ? {
              token,
              pageKey: page,
              played: (echec?.played ?? []).flatMap((g) => (g.target_used === null ? [] : [g.target_used])),
            }
          : {}),
        ...(r.status === "needs_confirmation" && r.node_path !== undefined
          ? { empreinte: empreinte(brut.texte, r.node_path, version, page) }
          : {}),
      }).catch((e: unknown) => s.journal.warn(`[procedures] journal d'exécution : ${messageErreur(e)}`));
      // Geste sensible : la demande d'accord humain est créée côté serveur (le modèle ne fait que la relayer).
      let demande: { id: string; expires_at: number } | null = null;
      let demandeRefus: string | undefined;
      if (r.status === "needs_confirmation" && r.node_path !== undefined && r.accord !== undefined) {
        const c = await compteAccord(s, ctx, username);
        if ("raison" in c) demandeRefus = c.raison;
        else {
          demande =
            (await s.rappel?.creerDemandeApprobation(c.compte, {
              session_id: sessionId,
              procedure_id: v.procedure.id,
              version,
              path: r.node_path,
              fingerprint: r.accord.fp,
              description: r.description ?? "",
              gesture: r.accord.gesture,
              page,
              once: r.first_run_after_repair === true,
              repaired: await venantDUneReparation(ax, username, v.procedure.id, version, r.node_path),
            })) ?? null;
          if (demande === null) demandeRefus = "the approval service did not answer";
        }
      }
      const { failed_at: fa, onceFaits: _once, accord: _accord, ...reste } = r;
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
        ...(demande !== null
          ? {
              approval_id: demande.id,
              approval_expires_in_s: Math.max(0, Math.round(demande.expires_at - Date.now() / 1000)),
              next: `the user was shown a « Confirmer » card with an « Approuver » button in the chat for this gesture; STOP and tell them to press « Approuver ». Only after their message « Approuvé : … », call pw_run(session_id, procedure='${id}', params, version=${version}, approval='${demande.id}'). Never say the user approved before that message`,
            }
          : r.status === "needs_confirmation"
            ? {
                approval_unavailable: demandeRefus ?? "no approval request",
                next: "the gesture needs the user's approval but no approval button could be shown: tell the user, do not retry and do not work around it",
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
        const derniere = await lireTexte(ax, owner, id, 0);
        if (derniere !== undefined && derniere.version !== att.version)
          return errPw("repair_outdated", "", {
            message: `version ${att.version} is no longer the latest (${derniere.version})`,
            fix: "run the latest version with pw_run: if it fails in a repairable way you get a new repair_id for it",
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
        const vr = verifierReparation(va.procedure, att.chemin, a["node"], {
          played: att.played,
          dejaReussi: await dejaReussi(ax, owner, id),
        });
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
          const fin = await terminerReparation(ax, att.id, {
            nouvelleVersion: sv.version,
            empreinte: empreinte(sv.texte, att.chemin, sv.version, att.page),
          });
          if (!fin) {
            // L'attente a été annulée pendant l'enregistrement : la version qui vient d'être écrite est retirée.
            await supprimer(ax, owner, id, sv.version).catch(() => 0);
            return errPw("repair_expired", "", {
              message: "the repair was superseded by another run while being saved; nothing was kept",
            });
          }
          await oublierApprobations(ax, owner, id, att.chemin);
          return {
            ok: true,
            action,
            status: "repaired",
            ...(vr.confirmations.length > 0
              ? {
                  confirm_once: vr.confirmations,
                  note: 'these gestures were put under confirm: "once": the user is asked once, then they run freely after a successful run',
                }
              : {}),
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
        // Un enregistrement ne lève ni n'affaiblit un `confirm` de la dernière version : seul l'utilisateur le peut, hors de cet outil.
        const derniere = await lireTexte(ax, owner, v.procedure.id, 0);
        if (derniere !== undefined) {
          let ancienne: unknown = null;
          try {
            ancienne = JSON.parse(derniere.texte);
          } catch {
            ancienne = null;
          }
          const va = validerProcedure(ancienne);
          const manques = va.ok ? confirmesAffaiblis(va.procedure, v.procedure) : [];
          if (manques.length > 0)
            return errPw("confirm_protected", "", {
              message: `the latest version asks the user before: ${manques.join(", ")}. A save cannot remove or weaken a confirm`,
              fix: "keep those gestures unchanged with the same confirm (true stays true). This guard only prevents mistakes: the protection that matters is the user's approval of a version",
            });
        }
        const r = await sauvegarder(ax, owner, v.procedure);
        if (!r.ok) return errPw(r.code, "", { message: r.message });
        return { ok: true, action, id: r.id, version: r.version, nodes: mesurer(v.procedure.root).noeuds };
      }
      if (action === "delete") {
        if (!id) return errPw("id_required", "", { message: "delete needs id", fix: FIX_LISTE });
        // Une version approuvée par l'utilisateur ne se supprime que depuis l'écran Procédures.
        if ((await approuveesDe(ax, owner, id, version)) > 0)
          return errPw("delete_approved", "", {
            message: `${id} holds a version approved by the user: only the user can delete it (Paramètres › Procédures)`,
            fix: "tell the user; versions that were never approved can still be deleted",
          });
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
