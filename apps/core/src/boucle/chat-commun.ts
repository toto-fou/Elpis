// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/chat-commun.ts — ce que la boucle reprend de `_chat_classic.py` (E23) : raisonnement dans le texte, system unique, refus 4xx. */
import { estDict, longueurPy, motifPy, stripPy, strPy } from "@elpis/commun";

import { HTTPStatusError } from "../llm/client-http";
import { ProviderError } from "../llm/reprises";

const THINK = motifPy("<think>");
const THINK_FIN = motifPy("</think>");
const ALT = motifPy("<|thinking|>");
const ALT_FIN = motifPy("<|/thinking|>");
const ORPHAN_CLOSE_RE = new RegExp(`${THINK_FIN}|${ALT_FIN}`, "u");
const OUVRANTE_RE = new RegExp(`${THINK}|${ALT}`, "u");
const BLOC_THINK = new RegExp(`${THINK}(.*?)${THINK_FIN}`, "su");
const BLOCS_THINK = new RegExp(`${THINK}.*?${THINK_FIN}`, "gsu");
const BLOC_ALT = new RegExp(`${ALT}(.*?)${ALT_FIN}`, "su");
const BLOCS_ALT = new RegExp(`${ALT}.*?${ALT_FIN}`, "gsu");
const THINK_SEUL = new RegExp(THINK, "u");

function compter(s: string, motif: string): number {
  return s.split(motif).length - 1;
}

/** `(raisonnement, réponse)` si `content` porte une fermante de raisonnement sans ouvrante (hors code cité), sinon `null`. */
export function splitOrphanThinkClose(content: string | null | undefined): [string, string] | null {
  if (!content) return null;
  const m = ORPHAN_CLOSE_RE.exec(content);
  if (m === null || OUVRANTE_RE.test(content)) return null;
  const before = content.slice(0, m.index);
  if (compter(before, "```") % 2 === 1 || compter(before, "`") % 2 === 1) return null;
  return [stripPy(before), stripPy(content.slice(m.index + m[0].length))];
}

/** `(raisonnement, réponse)` d'un texte à balises ; `truncated` : un `<think>` jamais refermé est du raisonnement tronqué. */
export function extractThinking(content: string, o: { truncated?: boolean } = {}): [string, string] {
  let m = BLOC_THINK.exec(content);
  if (m) return [stripPy(m[1] ?? ""), stripPy(content.replace(BLOCS_THINK, ""))];
  m = BLOC_ALT.exec(content);
  if (m) return [stripPy(m[1] ?? ""), stripPy(content.replace(BLOCS_ALT, ""))];
  m = THINK_SEUL.exec(content);
  if (m) {
    const prefix = stripPy(content.slice(0, m.index));
    const suffix = stripPy(content.slice(m.index + m[0].length));
    if (o.truncated) return [suffix, prefix];
    if (longueurPy(prefix) >= 20) {
      if (longueurPy(prefix) <= 80 && longueurPy(suffix) >= 3 * longueurPy(prefix))
        return ["", stripPy(prefix + "\n\n" + suffix)];
      return [suffix, prefix];
    }
    return ["", prefix ? stripPy(prefix + " " + suffix) : suffix];
  }
  return splitOrphanThinkClose(content) ?? ["", content];
}

function estSystem(m: unknown): boolean {
  return estDict(m) && m["role"] === "system";
}

function enTexte(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .filter((b) => estDict(b) && typeof b["text"] === "string")
      .map((b) => (b as Record<string, string>)["text"])
      .join("\n");
  return c === null || c === undefined ? "" : strPy(c);
}

/** Tous les `system` fusionnés en un seul, en tête ; liste rendue telle quelle si elle est déjà conforme. */
export function coalesceSystemMessages<T>(messages: T[]): T[] {
  const positions = messages.flatMap((m, i) => (estSystem(m) ? [i] : []));
  if (positions.length === 0 || (positions.length === 1 && positions[0] === 0)) return messages;
  const texte = positions
    .map((i) => enTexte((messages[i] as Record<string, unknown>)["content"]))
    .filter((t) => t && stripPy(t))
    .join("\n\n");
  const sortie: T[] = texte ? [{ role: "system", content: texte } as T] : [];
  for (const m of messages) if (!estSystem(m)) sortie.push(m);
  return sortie;
}

/** Refus HTTP 4xx définitif (hors 408 et 429) ; un refus arrivé dans un flux 200 n'en est jamais un. */
export function http4xx(err: unknown): boolean {
  if (err instanceof ProviderError || !(err instanceof HTTPStatusError)) return false;
  const sc = err.response.statusCode;
  return sc >= 400 && sc < 500 && sc !== 408 && sc !== 429;
}
