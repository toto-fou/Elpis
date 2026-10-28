// SPDX-License-Identifier: MIT
/** apps/core/src/procedures/demandes.ts — accords humains des gestes sensibles d'une procédure : demande créée par l'hôte, décision du compte connecté seul, consommation unique liée à l'exécution. */
import { randomBytes } from "node:crypto";

import type { DemandeApprobation } from "@elpis/contracts";
import type { Base } from "@elpis/db";

export const DUREE_DEMANDE_S = 15 * 60;
const CONSERVATION_S = 24 * 3600;
const PAR_CONVERSATION_MAX = 20;

export interface NouvelleDemande {
  readonly owner: string;
  readonly uid: number;
  readonly chatId: string;
  readonly sessionId: string;
  readonly procedureId: string;
  readonly version: number;
  readonly path: string;
  readonly fingerprint: string;
  readonly description: string;
  readonly gesture: DemandeApprobation["gesture"];
  readonly page: string;
  readonly once: boolean;
}

export interface LiaisonDemande {
  readonly owner: string;
  readonly chatId: string;
  readonly sessionId: string;
  readonly procedureId: string;
  readonly version: number;
  readonly path: string;
  readonly fingerprint: string;
  readonly page: string;
}

type Ligne = Record<string, unknown>;

const maintenant = (): number => Date.now() / 1000;
const borne = (s: string, n: number): string => s.slice(0, n);

function demande(l: Ligne): DemandeApprobation {
  let gesture: DemandeApprobation["gesture"] = { act: "", targets: [], value: "", url: "" };
  try {
    const g = JSON.parse(String(l["gesture_json"])) as Partial<DemandeApprobation["gesture"]>;
    gesture = {
      act: String(g.act ?? ""),
      targets: Array.isArray(g.targets) ? g.targets.map(String).slice(0, 8) : [],
      value: String(g.value ?? ""),
      url: String(g.url ?? ""),
    };
  } catch {
    // JSON illisible : geste vide, la description porte l'essentiel.
  }
  const etat = String(l["state"]);
  return {
    id: String(l["id"]),
    chat_id: String(l["chat_id"]),
    procedure_id: String(l["procedure_id"]),
    version: Number(l["version"]),
    path: String(l["path"]),
    description: String(l["description"]),
    gesture,
    page: String(l["page"]),
    once: Number(l["once"]) === 1,
    state: etat === "approved" || etat === "refused" || etat === "consumed" ? etat : "pending",
    created_at: Number(l["created_at"]),
    expires_at: Number(l["expires_at"]),
  };
}

/** Crée la demande (état `pending`, 15 min) ; une demande identique encore en attente est rendue telle quelle. Les anciennes lignes sont purgées au passage. */
export async function creerDemande(base: Base, d: NouvelleDemande): Promise<DemandeApprobation> {
  return base.ecriture(async (x) => {
    const t = maintenant();
    await x.run("DELETE FROM ax_procedure_demandes WHERE expires_at < ?", [t - CONSERVATION_S]);
    const existante = await x.get<Ligne>(
      `SELECT * FROM ax_procedure_demandes WHERE user_id=? AND chat_id=? AND session_id=? AND procedure_id=? AND version=?
          AND path=? AND fingerprint=? AND page=? AND state IN ('pending', 'approved') AND expires_at>?`,
      [d.uid, d.chatId, d.sessionId, d.procedureId, d.version, d.path, d.fingerprint, d.page, t],
    );
    if (existante !== undefined) return demande(existante);
    // Au-delà du plafond, les plus anciennes de la conversation partent.
    await x.run(
      `DELETE FROM ax_procedure_demandes WHERE user_id=? AND chat_id=? AND id NOT IN
         (SELECT id FROM ax_procedure_demandes WHERE user_id=? AND chat_id=? ORDER BY created_at DESC LIMIT ${PAR_CONVERSATION_MAX - 1})`,
      [d.uid, d.chatId, d.uid, d.chatId],
    );
    const id = `ap_${randomBytes(18).toString("hex")}`;
    await x.run(
      `INSERT INTO ax_procedure_demandes (id, owner, user_id, chat_id, session_id, procedure_id, version, path, fingerprint, description, gesture_json, page, once, state, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        id,
        d.owner,
        d.uid,
        d.chatId,
        d.sessionId,
        d.procedureId,
        d.version,
        borne(d.path, 300),
        d.fingerprint,
        borne(d.description, 700),
        borne(JSON.stringify(d.gesture), 3000),
        borne(d.page, 1000),
        d.once ? 1 : 0,
        t,
        t + DUREE_DEMANDE_S,
      ],
    );
    const l = await x.get<Ligne>("SELECT * FROM ax_procedure_demandes WHERE id=?", [id]);
    return demande(l ?? {});
  });
}

/** Demandes en attente (non expirées) de la conversation du compte, les plus récentes d'abord. */
export async function demandesEnAttente(
  base: Base,
  uid: number,
  chatId: string,
): Promise<DemandeApprobation[]> {
  const l = await base.all<Ligne>(
    "SELECT * FROM ax_procedure_demandes WHERE user_id=? AND chat_id=? AND state='pending' AND expires_at>? ORDER BY created_at DESC",
    [uid, chatId, maintenant()],
  );
  return l.map(demande);
}

/** Décision du compte connecté sur une de SES demandes encore en attente ; `null` si elle n'existe pas, est d'un autre compte, décidée ou expirée. */
export async function decider(
  base: Base,
  uid: number,
  id: string,
  decision: "approve" | "refuse",
): Promise<DemandeApprobation | null> {
  return base.ecriture(async (x) => {
    const t = maintenant();
    const r = await x.run(
      "UPDATE ax_procedure_demandes SET state=?, decided_at=? WHERE id=? AND user_id=? AND state='pending' AND expires_at>?",
      [decision === "approve" ? "approved" : "refused", t, id, uid, t],
    );
    if (r.changes !== 1) return null;
    const l = await x.get<Ligne>("SELECT * FROM ax_procedure_demandes WHERE id=?", [id]);
    return l === undefined ? null : demande(l);
  });
}

export type IssueConsommation =
  { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string };

const REFUS = (code: string, message: string): IssueConsommation => ({ ok: false, code, message });

/** Consomme l'accord humain (usage unique) s'il est approuvé, non expiré et lié aux mêmes compte, conversation, session, procédure, version, nœud, empreinte et page. */
export async function consommer(base: Base, id: string, l: LiaisonDemande): Promise<IssueConsommation> {
  return base.ecriture(async (x) => {
    const t = maintenant();
    const d = await x.get<Ligne>("SELECT * FROM ax_procedure_demandes WHERE id=?", [id]);
    if (d === undefined || String(d["owner"]) !== l.owner)
      return REFUS("approval_unknown", "no such approval for this account");
    if (String(d["chat_id"]) !== l.chatId)
      return REFUS("approval_other_conversation", "this approval belongs to another conversation");
    const etat = String(d["state"]);
    if (etat === "consumed") return REFUS("approval_consumed", "this approval was already used");
    if (etat === "refused") return REFUS("approval_refused", "the user refused this gesture");
    if (Number(d["expires_at"]) <= t) return REFUS("approval_expired", "this approval expired");
    if (etat !== "approved")
      return REFUS("approval_pending", "the user has not approved yet: no button was pressed");
    const lie =
      String(d["session_id"]) === l.sessionId &&
      String(d["procedure_id"]) === l.procedureId &&
      Number(d["version"]) === l.version &&
      String(d["path"]) === l.path &&
      String(d["fingerprint"]) === l.fingerprint &&
      String(d["page"]) === l.page;
    if (!lie)
      return REFUS(
        "approval_mismatch",
        "the approval was given for another gesture, value, version, session or page",
      );
    const r = await x.run(
      "UPDATE ax_procedure_demandes SET state='consumed', consumed_at=? WHERE id=? AND state='approved'",
      [t, id],
    );
    return r.changes === 1 ? { ok: true } : REFUS("approval_consumed", "this approval was already used");
  });
}

/** Retire les demandes des conversations supprimées. */
export async function retirerDemandesDesChats(
  base: Base,
  uid: number,
  chatIds: readonly string[],
): Promise<void> {
  for (let i = 0; i < chatIds.length; i += 500) {
    const tranche = chatIds.slice(i, i + 500);
    await base.run(
      `DELETE FROM ax_procedure_demandes WHERE user_id=? AND chat_id IN (${tranche.map(() => "?").join(",")})`,
      [uid, ...tranche],
    );
  }
}
