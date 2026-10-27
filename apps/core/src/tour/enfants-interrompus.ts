// SPDX-License-Identifier: MIT
/** apps/core/src/tour/enfants-interrompus.ts — sous-agents d'un run coupé net (redémarrage brutal du core) : lus dans le journal du run, gardés s'ils ont encore un enregistrement de reprise, annoncés au tour suivant pour que « reprends » ait un `task_id`. */
import { estDict, longueurPy, prefixePy, splitPy, strPy } from "@elpis/commun";

import { TASK_RESUME_TTL_S } from "../llm/constantes";
import { peekTs } from "../outils/integres/reprise-taches";
import { currentRun, journalPath, readLines } from "./journal-run";

/** Octets du journal lus au plus (un journal plus gros est lu jusque-là). */
const LECTURE_MAX = 32 * 1024 * 1024;
/** Sous-agents cités au plus dans l'annonce. */
const ANNONCES_MAX = 5;

export interface EnfantInterrompu {
  id: string;
  agent: string;
  label: string;
}

/** Sous-agents lancés par le dernier run du chat sans étape finale, quand ce run n'a jamais été clos (`.end` absent : le process est mort) ; `[]` sinon. */
export function enfantsInterrompus(uid: number, chatId: string, username: string): EnfantInterrompu[] {
  const cur = currentRun(uid, chatId);
  if (cur === null || cur["ended"] === true) return [];
  const chemin = journalPath(uid, chatId, strPy(cur["run_id"]));
  if (chemin === null) return [];
  const ouverts = new Map<string, { agent: string; appel: string }>();
  const libelles = new Map<string, string>();
  try {
    let offset = 0;
    while (offset < LECTURE_MAX) {
      const [lignes, suite] = readLines(chemin, offset);
      if (suite === offset) break;
      offset = suite;
      for (const ligne of lignes) {
        const e = ligne["e"];
        if (!estDict(e)) continue;
        if (e["type"] === "tool_call" && e["name"] === "task" && estDict(e["args"]) && e["call_id"])
          libelles.set(strPy(e["call_id"]), strPy(e["args"]["description"] ?? ""));
        else if (e["type"] === "task_step" && e["status"] === "spawned" && e["child_id"])
          ouverts.set(strPy(e["child_id"]), {
            agent: strPy(e["agent"] ?? ""),
            appel: strPy(e["call_id"] ?? ""),
          });
        else if (e["type"] === "task_step" && e["status"] === "final" && e["child_id"])
          ouverts.delete(strPy(e["child_id"]));
      }
    }
  } catch {
    return [];
  }
  const maintenant = Date.now() / 1000;
  const sortie: EnfantInterrompu[] = [];
  for (const [id, { agent, appel }] of ouverts) {
    const ts = peekTs(username, id);
    if (ts === null || maintenant - ts > TASK_RESUME_TTL_S) continue;
    sortie.push({ id, agent, label: libelles.get(appel) ?? "" });
  }
  return sortie;
}

/** Annonce jointe à la question du premier tour après un run coupé : les sous-agents encore reprenables et comment les reprendre ; `null` s'il n'y en a pas. */
export function annonceEnfantsInterrompus(uid: number, chatId: string, username: string): string | null {
  const liste = enfantsInterrompus(uid, chatId, username);
  if (!liste.length) return null;
  const cites = liste.slice(0, ANNONCES_MAX).map((c) => {
    const libelle = splitPy(c.label).join(" ");
    const court = longueurPy(libelle) > 80 ? prefixePy(libelle, 79) + "…" : libelle;
    return `${c.id} (${c.agent}${court ? `: ${court}` : ""})`;
  });
  const reste = liste.length > cites.length ? ` and ${liste.length - cites.length} more` : "";
  return (
    "<interrupted_subagents>The previous turn of this conversation was cut short by a server restart while these " +
    `sub-agents were running: ${cites.join("; ")}${reste}. Their partial work is kept. If the user asks to continue, ` +
    "resume one with task(task_id=…) and a brief of what is left, and have it check the actual state (files, git, " +
    "processes) first: calls made just before the restart may have run without leaving a trace. Otherwise ignore " +
    "this notice.</interrupted_subagents>"
  );
}
