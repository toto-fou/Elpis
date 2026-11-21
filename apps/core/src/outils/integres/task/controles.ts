// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/task/controles.ts — appels du harnais de `task` à l'hôte d'outils du compte, hors boucle : santé du navigateur avant un agent `web`, navigateur privé de l'enfant fermé en fin de run (et au démarrage, ceux du process précédent, par le service de chaque bac), rapport complet sauvé dans le bac, branche relue en fin de run. */
import { estDict, jsonLoads, prefixePy, strPy } from "@elpis/commun";
import { BUILTIN_SENTINEL } from "@elpis/mcp";
import { sousAgentEnDict } from "@elpis/securite";
import type { SousAgent } from "@elpis/securite";

import { appelerHote } from "../../../admin/pilote-bac";
import { sandboxHostFor } from "../../../relais/hotes";
import type { Dict } from "../../../python";
import { collectMcpTools } from "../../catalogue";
import { executerOutilMcp } from "../../mcp/clients";

/** Ce que le harnais demande à l'hôte d'outils (doublé par les tests). */
export interface PortsHoteTache {
  /** Cause d'indisponibilité du service navigateur, `null` s'il répond ; un quota de sessions atteint porte son propre `fix`. `isolee` : l'enfant aura sa session (faux : celle du compte, aucune place à prendre). */
  santeNavigateur(o: CompteTache & { isolee?: boolean }): Promise<string | IndisponibiliteNavigateur | null>;
  /** Ferme les sessions de navigateur PRIVÉES de l'enfant par `cleanup_own`, que seul l'hôte à jour connaît (un ancien hôte répond « unknown action » et ne ferme rien : jamais le `cleanup` du compte) ; vrai si l'hôte l'a confirmé, faux sans erreur sinon. */
  fermerNavigateur(o: CompteTache & { enfant: SousAgent }): Promise<boolean>;
  /** Texte écrit dans le bac du compte à `chemin` (relatif à /work) ; vrai si l'outil l'a confirmé. */
  sauverRapport(o: CompteTache & { chemin: string; texte: string }): Promise<boolean>;
  /** Branche courante du dépôt `repo` (relatif à /work), lue sans écriture ; `null` si la lecture échoue. */
  brancheCourante(o: CompteTache & { repo: string }): Promise<string | null>;
}

/** Navigateur joignable mais sans place pour un enfant : la cause et ce que le modèle doit faire. */
export interface IndisponibiliteNavigateur {
  raison: string;
  fix: string;
}

export interface CompteTache {
  username: string;
  userId: number | null;
  chatId: string | null;
  signal?: AbortSignal | undefined;
}

/** `_meta` d'un appel du harnais à l'hôte : compte, conversation, enfant éventuel. */
function metaDe(o: CompteTache, enfant?: SousAgent): Dict {
  return {
    username: o.username,
    ...(o.userId ? { user_id: strPy(Math.trunc(o.userId)) } : {}),
    ...(o.chatId ? { chat_id: o.chatId } : {}),
    ...(enfant ? { subagent: sousAgentEnDict(enfant) } : {}),
  };
}

/** Un outil du serveur local d'une catégorie, appelé une fois ; `null` : outil absent ou hôte injoignable. */
async function appelLocal(
  o: CompteTache,
  categorie: string,
  nom: string,
  args: Dict,
  delaiS: number,
  enfant?: SousAgent,
): Promise<Dict | "absent" | null> {
  let carte: ReadonlyMap<string, Dict>;
  try {
    const cat = await collectMcpTools(
      [
        {
          type: "stdio",
          name: `task-${categorie}`,
          command: BUILTIN_SENTINEL,
          filter_categories: [categorie],
        },
      ],
      null,
      null,
      { signal: o.signal, memoryEnabled: false },
    );
    carte = cat.toolCfgMap;
  } catch {
    return null;
  }
  if (!carte.has(nom)) return "absent";
  const brut = await executerOutilMcp(carte, nom, args, {
    meta: metaDe(o, enfant),
    timeoutS: delaiS,
    queueTimeoutS: 5,
    signal: o.signal,
  });
  try {
    const d = jsonLoads(brut);
    return estDict(d) ? d : { value: d };
  } catch {
    return { value: brut };
  }
}

/** Branche marquée `*` dans la sortie de `git branch -vv` ; `null` en HEAD détachée ou sans ligne courante. */
export function brancheDeLaListe(sortie: string): string | null {
  for (const ligne of sortie.split("\n")) {
    if (!ligne.startsWith("* ")) continue;
    const nom = ligne.slice(2).trim().split(/\s+/u)[0] ?? "";
    return nom && !nom.startsWith("(") ? nom : null;
  }
  return null;
}

export const hoteTacheParDefaut: PortsHoteTache = {
  async santeNavigateur(o) {
    const r = await appelLocal(o, "browser", "pw_session", { action: "health" }, 8);
    if (r === null) return "tool host unreachable";
    if (r === "absent") return "browser tools (pw_*) are not served by this tool host";
    if (r["ok"] === false || r["error"])
      return prefixePy(`${strPy(r["error"] || "error")}: ${strPy(r["message"] || r["fix"] || "")}`, 300);
    if (o.isolee !== false && typeof r["child_slots_left"] === "number" && r["child_slots_left"] <= 0)
      return {
        raison: `browser session quota reached for this account (${strPy(r["max_sessions_per_group"] ?? "?")} sessions, sub-agents included)`,
        fix: "wait for a running browser sub-agent to finish and launch this one again, or launch fewer browser agents at once. If you hold several browser sessions of your own, pw_session(action='stop', session_id=...) closes one you no longer need. pw_session(action='cleanup') also closes the browsers of this account's sub-agents in every conversation: use it only when no browser sub-agent is running in any conversation of this account",
      };
    return null;
  },
  async fermerNavigateur(o) {
    try {
      const r = await appelLocal(
        { username: o.username, userId: o.userId, chatId: o.chatId },
        "browser",
        "pw_session",
        { action: "cleanup_own" },
        12,
        o.enfant,
      );
      return r !== null && r !== "absent" && r["ok"] !== false && !r["error"];
    } catch {
      return false;
    }
  },
  async sauverRapport(o) {
    const r = await appelLocal(o, "fs", "write_file", { path: o.chemin, content: o.texte }, 30);
    return r !== null && r !== "absent" && r["ok"] !== false && !r["error"];
  },
  async brancheCourante(o) {
    const r = await appelLocal(o, "git", "git_query", { action: "branches", repo: o.repo }, 10);
    if (r === null || r === "absent" || r["ok"] === false || r["error"] || typeof r["stdout"] !== "string")
      return null;
    return brancheDeLaListe(r["stdout"]);
  },
};

/** Compte dont l'hôte du bac reçoit le nettoyage : son identité signe l'enveloppe. */
export interface CompteNettoyage {
  readonly id: number;
  readonly username: string;
}

/** Nettoyage demandé à l'hôte du bac d'un compte, sous l'identité de ce compte : corps JSON rendu, `null` sur toute panne. */
async function posterNettoyageEnfants(compte: CompteNettoyage, corps: Dict): Promise<unknown> {
  try {
    const hote = await sandboxHostFor(compte.id, false);
    if (hote === null || hote.token === "") return null;
    return await appelerHote(
      hote,
      compte.id,
      compte.username,
      "POST",
      "/api/internal/browser/cleanup-children",
      {
        json: corps,
        delaiS: 10,
      },
    );
  } catch {
    return null;
  }
}

/** Au démarrage de main : pour chaque compte, quatre à la fois, l'hôte de son bac fait fermer par son service navigateur les sessions de sous-agents ouvertes avant ce process (runs interrompus), jamais celles du compte ; rend le nombre fermé. */
export async function fermerNavigateursEnfantsOrphelins(
  o: {
    ageMs?: () => number;
    comptes?: () => Promise<readonly CompteNettoyage[]>;
    poster?: (c: CompteNettoyage, corps: Dict) => Promise<unknown>;
  } = {},
): Promise<number> {
  const age = o.ageMs ?? ((): number => Math.floor(process.uptime() * 1000));
  const poster = o.poster ?? posterNettoyageEnfants;
  const comptes = await (o.comptes ?? (async (): Promise<readonly CompteNettoyage[]> => []))().catch(
    (): readonly CompteNettoyage[] => [],
  );
  let total = 0;
  for (let i = 0; i < comptes.length; i += 4) {
    const corps = { older_than_ms: age() };
    const r = await Promise.all(comptes.slice(i, i + 4).map((c) => poster(c, corps)));
    total += r.reduce<number>(
      (n, x) => n + (estDict(x) && typeof x["cleaned"] === "number" ? x["cleaned"] : 0),
      0,
    );
  }
  return total;
}
