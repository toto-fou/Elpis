// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/travail.ts — messages de travail d'un run en forme canonique (ce que le moteur a vu, tête brute, paires appel/résultat complètes) : reprise d'un sous-agent, futur fork. */
import { config } from "@elpis/config";
import { estDict, strPy, stripPy } from "@elpis/commun";

import { applyPruneMarks, prepareToolResultForModel, stripInternalKeys } from "../contexte/elagage";
import { isSummaryCarrier } from "../contexte/etat-compression";
import type { Dict } from "../python";
import { sansAlerteDisque } from "./dispatch-outils";
import { contentText } from "./run";
import type { RunContext, RunRecord } from "./run";

function appelsDe(m: Dict): Dict[] {
  const appels = m["role"] === "assistant" ? m["tool_calls"] : undefined;
  return Array.isArray(appels) ? appels.filter(estDict) : [];
}

/** Résultats déjà obtenus du lot interrompu (la boucle ne les a pas encore rendus au modèle), mis en forme comme ceux de `runToolBatch`. */
function resultatsDuLotInterrompu(ctx: RunContext, rec: RunRecord, messages: readonly Dict[]): Dict[] {
  let dernier = -1;
  messages.forEach((m, i) => {
    if (appelsDe(m).length) dernier = i;
  });
  if (dernier < 0 || !messages.slice(dernier + 1).every((m) => m["role"] === "tool")) return [];
  const demandes = new Set(appelsDe(messages[dernier]!).map((c) => strPy(c["id"])));
  const presents = new Set(messages.slice(dernier + 1).map((m) => strPy(m["tool_call_id"])));
  const sortie: Dict[] = [];
  rec.batchPrepared.forEach((p, i) => {
    const id = strPy(p["call_id"] ?? "");
    const brut = rec.batchPartial.get(i);
    if (!id || brut === undefined || !demandes.has(id) || presents.has(id)) return;
    const vu = ctx.c.subagent ? sansAlerteDisque(brut) : brut;
    const model = ctx.c.model || config.LLAMA_MODEL || null;
    sortie.push({
      role: "tool",
      tool_call_id: p["call_id"],
      content: prepareToolResultForModel(strPy(p["tool_name"]), vu, rec.ctxSize, model),
    });
  });
  return sortie;
}

/** Appels sans résultat retirés (jamais un appel sans sa réponse), assistant vidé de ses appels gardé s'il porte du texte, résultats orphelins retirés. */
function appelsRepondus(messages: readonly Dict[]): Dict[] {
  const repondus = new Set(messages.filter((m) => m["role"] === "tool").map((m) => strPy(m["tool_call_id"])));
  const gardes = new Set<string>();
  const sortie: Dict[] = [];
  for (const m of messages) {
    const appels = appelsDe(m);
    if (!appels.length) {
      sortie.push(m);
      continue;
    }
    const vivants = appels.filter((c) => repondus.has(strPy(c["id"])));
    for (const c of vivants) gardes.add(strPy(c["id"]));
    if (vivants.length === appels.length) sortie.push(m);
    else if (vivants.length) sortie.push({ ...m, tool_calls: vivants });
    else if (stripPy(contentText(m["content"]))) {
      const reste: Dict = { ...m };
      delete reste["tool_calls"];
      sortie.push(reste);
    }
  }
  return sortie.filter((m) => m["role"] !== "tool" || gardes.has(strPy(m["tool_call_id"])));
}

/** Messages système de tête de l'entrée de la boucle, sans les porteurs de résumé : ce que l'assemblage refusionne. */
function teteBrute(entree: readonly unknown[]): Dict[] {
  const sortie: Dict[] = [];
  for (const m of entree) {
    if (!estDict(m) || m["role"] !== "system") break;
    if (!isSummaryCarrier(m)) sortie.push(m);
  }
  return sortie;
}

/** Messages sans la tête assemblée (système de tête hors porteurs de résumé). */
function sansTeteAssemblee(messages: readonly Dict[]): Dict[] {
  let fin = 0;
  while (fin < messages.length && messages[fin]!["role"] === "system") fin++;
  return messages.filter((m, i) => i >= fin || isSummaryCarrier(m));
}

/** Messages de travail courants sous forme rejouable : `[tête brute de l'entrée, ce que le moteur a vu après la tête assemblée]` (jalons et suffixe fusionné compris, marques d'élagage appliquées, sans clés `_…`), copie indépendante de la boucle. */
export function travailCanonique(ctx: RunContext, rec: RunRecord, entree: readonly unknown[]): Dict[] {
  const brut = rec.travail.filter(estDict);
  const complet = [...brut, ...resultatsDuLotInterrompu(ctx, rec, brut)];
  const vue = applyPruneMarks(complet, rec.runPruneKeys) as Dict[];
  const propres = stripInternalKeys(appelsRepondus(vue)) as Dict[];
  return structuredClone([...teteBrute(entree), ...sansTeteAssemblee(propres)]);
}
