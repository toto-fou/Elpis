// SPDX-License-Identifier: MIT
/** apps/core/src/tour/enfants-interrompus.ts — sous-agents d'un run coupé net (redémarrage brutal du core) : lus dans les journaux du chat restés sans fin, gardés s'ils ont encore un enregistrement de reprise, annoncés une fois au tour suivant pour que « reprends » ait un `task_id`. */
import { estDict, longueurPy, prefixePy, splitPy, strPy } from "@elpis/commun";

import { TASK_RESUME_TTL_S } from "../llm/constantes";
import { peekTs } from "../outils/integres/reprise-taches";
import { journalPath, readLines, runsSansFin } from "./journal-run";

/** Octets de journaux lus au plus, tous runs confondus (un journal plus gros est lu jusque-là). */
const LECTURE_MAX = 32 * 1024 * 1024;
/** Sous-agents cités au plus dans l'annonce. */
const ANNONCES_MAX = 5;

export interface EnfantInterrompu {
  id: string;
  agent: string;
  label: string;
  /** Run dont le journal le porte (celui qui reçoit la marque « annoncé »). */
  run: string;
}

/** Sous-agents lancés sans étape finale par les runs du chat dont le journal n'a jamais été clos (process mort) et pas encore annoncé, s'ils ont encore un enregistrement de reprise ; `exclure` : le run qui commence. */
export function enfantsInterrompus(
  uid: number,
  chatId: string,
  username: string,
  exclure = "",
): EnfantInterrompu[] {
  const sortie: EnfantInterrompu[] = [];
  let restant = LECTURE_MAX;
  for (const run of runsSansFin(uid, chatId, exclure)) {
    if (restant <= 0) break;
    const chemin = journalPath(uid, chatId, run);
    if (chemin === null) continue;
    const ouverts = new Map<string, { agent: string; appel: string }>();
    const libelles = new Map<string, string>();
    try {
      let offset = 0;
      while (offset < restant) {
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
      restant -= offset;
    } catch {
      continue;
    }
    const maintenant = Date.now() / 1000;
    for (const [id, { agent, appel }] of ouverts) {
      const ts = peekTs(username, id);
      if (ts === null || maintenant - ts > TASK_RESUME_TTL_S) continue;
      sortie.push({ id, agent, label: libelles.get(appel) ?? "", run });
    }
  }
  return sortie;
}

/** Annonce jointe à la question du premier tour qui le peut après un run coupé : le texte, et les runs dont elle parle (marqués une fois la question enregistrée) ; `null` s'il n'y a rien à annoncer. */
export function preparerAnnonceEnfants(
  uid: number,
  chatId: string,
  username: string,
  exclure = "",
): { texte: string; runs: string[] } | null {
  const liste = enfantsInterrompus(uid, chatId, username, exclure);
  if (!liste.length) return null;
  const cites = liste.slice(0, ANNONCES_MAX).map((c) => {
    const libelle = splitPy(c.label).join(" ");
    const court = longueurPy(libelle) > 80 ? prefixePy(libelle, 79) + "…" : libelle;
    return `${c.id} (${c.agent}${court ? `: ${court}` : ""})`;
  });
  const reste = liste.length > cites.length ? ` and ${liste.length - cites.length} more` : "";
  const texte =
    "<interrupted_subagents>The previous turn of this conversation was cut short by a server restart while these " +
    `sub-agents were running: ${cites.join("; ")}${reste}. Their partial work is kept. If the user asks to continue, ` +
    "resume one with task(task_id=…) and a brief of what is left, and have it check the actual state (files, git, " +
    "processes) first: calls made just before the restart may have run without leaving a trace. Otherwise ignore " +
    "this notice.</interrupted_subagents>";
  return { texte, runs: [...new Set(liste.map((c) => c.run))] };
}

/** Texte seul de l'annonce (voir `preparerAnnonceEnfants`) ; `null` s'il n'y a rien à annoncer. */
export function annonceEnfantsInterrompus(
  uid: number,
  chatId: string,
  username: string,
  exclure = "",
): string | null {
  return preparerAnnonceEnfants(uid, chatId, username, exclure)?.texte ?? null;
}
