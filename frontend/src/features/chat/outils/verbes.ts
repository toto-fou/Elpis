// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/outils/verbes.ts — ce que fait une étape, dit en français : verbe de l'outil d'Elpis et son objet ; un outil tiers garde son nom. */
import { toolKeyArg } from "../coeur/formats.ts";
import type { EtapeOutil } from "./types.ts";

const VERBES: Readonly<Record<string, string>> = {
  read_file: "Lit",
  write_file: "Écrit",
  edit_file: "Modifie",
  list_files: "Liste",
  manage_files: "Range",
  code: "Analyse",
  execute_shell: "Exécute",
  shell_job: "Lance",
  git_inspect: "Inspecte",
  git_query: "Consulte",
  git_commit: "Valide",
  git_clone: "Clone",
  pw_page: "Ouvre",
  pw_act: "Agit sur",
  pw_find: "Cherche",
  pw_expect: "Vérifie",
  pw_login: "Connecte",
  pw_run: "Rejoue",
  pw_wait: "Attend",
  pw_observe: "Observe",
  pw_visual: "Capture",
  memory: "Consulte la mémoire",
  ask_user: "Demande",
  routine_save: "Crée la routine",
  generate_image: "Génère",
};

export interface LibelleEtape {
  /** Verbe français, ou `null` pour un outil tiers (le nom de l'outil est alors affiché tel quel). */
  verbe: string | null;
  objet: string;
  /** Nom technique de l'outil, pour l'infobulle. */
  outil: string;
}

function commande(step: EtapeOutil): string {
  const a = step.args;
  const c = String((a && (a["command"] || a["cmd"])) || "")
    .trim()
    .replace(/\s+/g, " ");
  return c.length > 60 ? c.slice(0, 60) + "…" : c;
}

/** Verbe et objet d'une étape (« Exécute » · « npm test ») ; une recherche documentaire garde son libellé. */
export function libelleEtape(step: EtapeOutil): LibelleEtape {
  const outil = step.name || "outil";
  if (outil.startsWith("rag_") && step.ragLabel) return { verbe: "", objet: step.ragLabel, outil };
  // Graphique : « Trace » et son titre.
  if (outil.startsWith("chart_")) {
    const titre = String(step.args?.["title"] ?? "").trim();
    return {
      verbe: "Trace",
      objet: titre.length > 60 ? titre.slice(0, 60) + "…" : titre || "un graphique",
      outil,
    };
  }
  const verbe = VERBES[outil] ?? null;
  const objet = outil === "execute_shell" || outil === "shell_job" ? commande(step) : toolKeyArg(step);
  return { verbe, objet, outil };
}

/** Une ligne de texte : « Exécute npm test », ou « nom_outil objet » pour un outil tiers. */
export function texteEtape(step: EtapeOutil): string {
  const l = libelleEtape(step);
  return [l.verbe ?? l.outil, l.objet].filter(Boolean).join(" ");
}
