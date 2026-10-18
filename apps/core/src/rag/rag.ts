// SPDX-License-Identifier: MIT
/** apps/core/src/rag/rag.ts — RAG automatique : contexte documentaire du service `rag_app` inséré après le bloc système de tête. */
import { strPy, stripPy, veritePy } from "@elpis/commun";

import { journal } from "../journal";
import { estDict, lire, longueurPy } from "../python";
import type { Dict } from "../python";
import { callTool, isConfigured, RagServiceError, RagToolError } from "./client";
import { metriqueRag } from "./ports";

const log = journal("rag");

/** Texte d'un contenu de message, multimodal compris (blocs `{text}` joints par une espace). */
function texteDe(contenu: unknown): string {
  if (typeof contenu === "string") return contenu;
  if (Array.isArray(contenu))
    return contenu
      .filter((b) => estDict(b) && typeof b["text"] === "string")
      .map((b) => (b as Dict)["text"] as string)
      .join(" ");
  return "";
}

export interface MetaRag extends Dict {
  enabled: boolean;
  used: boolean;
}

/** Insère le contexte retrouvé après le run système de tête ; tout échec rend les messages inchangés avec la raison dans `meta`. */
export async function applyRag(
  messages: Dict[],
  collection: string | null = null,
  searchMode = "classic",
  signal?: AbortSignal,
): Promise<[Dict[], MetaRag]> {
  if (!isConfigured())
    return [messages, { enabled: false, used: false, error: "RAG service URL non configurée" }];
  let q = "";
  for (const m of [...(messages ?? [])].reverse()) {
    if (lire(m, "role") === "user") {
      const t = stripPy(texteDe(lire(m, "content")));
      if (t) {
        q = t;
        break;
      }
    }
  }
  if (!q) return [messages, { enabled: true, used: false }];
  const payload: Dict = { question: q, search_mode: searchMode };
  if (collection) payload["collection"] = collection;
  let resultat: Dict;
  try {
    resultat = await callTool("rag_inline", payload, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    if (e instanceof RagServiceError) {
      log.warn(`service unreachable for apply_rag: ${e.message}`);
      return [messages, { enabled: true, used: false, error: e.message }];
    }
    if (e instanceof RagToolError) return [messages, { enabled: true, used: false, error: e.message }];
    log.error("unexpected error in apply_rag", e);
    return [messages, { enabled: true, used: false, error: e instanceof Error ? e.message : strPy(e) }];
  }
  if (!veritePy(resultat) || !veritePy(resultat["used"])) {
    const meta: MetaRag = { enabled: true, used: false };
    if (veritePy(resultat) && veritePy(resultat["error"])) meta["error"] = strPy(resultat["error"]);
    return [messages, meta];
  }
  const contexte = veritePy(resultat["context_text"]) ? resultat["context_text"] : "";
  const sources = veritePy(resultat["sources"]) ? resultat["sources"] : [];
  if (!veritePy(contexte)) return [messages, { enabled: true, used: false }];
  let position = 0;
  for (const [i, m] of messages.entries()) {
    if (estDict(m) && m["role"] === "system") position = i + 1;
    else break;
  }
  const nouveaux = [...messages];
  nouveaux.splice(position, 0, { role: "system", content: contexte });
  try {
    await metriqueRag()?.("rag_hit", 1, {
      query_len: longueurPy(q),
      sources_count: Array.isArray(sources) ? sources.length : Object.keys(sources as object).length,
      mode: searchMode,
    });
  } catch (e) {
    log.error(`Metric Error: ${e instanceof Error ? e.message : strPy(e)}`);
  }
  return [nouveaux, { enabled: true, used: true, sources }];
}
