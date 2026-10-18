// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/coeur/persistance.ts — projection unique des messages vers leur forme persistée (charge du flux d'envoi, instantané de session) et blocs `--- FILE: … ---` d'un message utilisateur (portés d'`app-chat.js`). */
import { copyImageFields } from "../../images/formats.ts";
import type { MessageChat, Objet } from "./types.ts";

const nonVide = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

/** Vrai si le message survit à un aller-retour de persistance (notice, texte, images, outils, raisonnement coupé, erreur d'image). */
export function garderPourPersistance(m: MessageChat | null | undefined): boolean {
  return !!(
    m &&
    m.role &&
    (m.role === "notice" ||
      m.content ||
      nonVide(m.images) ||
      nonVide(m.tool_history) ||
      (m.thinking && m.thinkingTruncated) ||
      (m["image_error"] && typeof m["image_error"] === "object"))
  );
}

/** Forme persistée d'un message (format aller-retour du backend : images en `parts`, notice structurée). */
export function projeterPourPersistance(m: MessageChat): Objet {
  if (m.role === "notice")
    return {
      role: "notice",
      kind: m.kind || "compaction",
      ts: m.ts || null,
      round: m.round || null,
      tokens_after: m.tokens_after || null,
      summary: m.summary || null,
      content: m.content || "",
    };
  let o: Objet;
  if (m.images && m.images.length > 0) {
    const parts: Objet[] = m.images.map((img) => ({ type: "image_url", image_url: { url: img.dataUrl } }));
    if (m.content) parts.push({ type: "text", text: m.content });
    o = { role: m.role, content: parts };
  } else o = { role: m.role, content: m.content };
  if (m.tool_history && m.tool_history.length > 0) {
    o["tool_history"] = m.tool_history;
    if (m.tool_history_delta) o["tool_history_delta"] = true;
  }
  if (m.taskRuns && m.taskRuns.length) o["task_runs"] = m.taskRuns;
  copyImageFields(m, o);
  if (m.run_ids && m.run_ids.length) o["run_ids"] = m.run_ids;
  if (m.files_changed && m.files_changed.length) o["files_changed"] = m.files_changed;
  if (m.compactions && m.compactions.length) o["compactions"] = m.compactions;
  if (m.pruned) o["pruned"] = m.pruned;
  if (m.metrics && typeof m.metrics === "object") {
    const { thinking: _t, tool_history: _h, ...pied } = m.metrics;
    o["metrics"] = pied;
  }
  if (m.isTruncated) o["isTruncated"] = true;
  if (m.thinkingTruncated && (m.resume_thinking || m.thinking)) {
    o["resume_thinking"] = m.resume_thinking || m.thinking;
    o["thinkingTruncated"] = true;
  }
  return o;
}

export interface BlocsFichiers {
  files: { name: string; lines: number }[] | undefined;
  displayContent: string | undefined;
}

/** Fichiers joints injectés dans un message utilisateur, et le texte affiché sans eux. */
export function analyserBlocsFichiers(content: unknown): BlocsFichiers {
  if (typeof content !== "string" || !content.includes("FILE:"))
    return { files: undefined, displayContent: undefined };
  const re = /---\s*FILE:\s*(.+?)\s*---\r?\n([\s\S]*?)\r?\n?---\s*END FILE\s*---/g;
  const files: { name: string; lines: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    files.push({ name: (m[1] ?? "").trim(), lines: (m[2] || "").split("\n").length });
  }
  if (files.length === 0) return { files: undefined, displayContent: undefined };
  const displayContent = content
    .replace(/---\s*FILE:\s*.+?\s*---\r?\n[\s\S]*?\r?\n?---\s*END FILE\s*---\s*/g, "")
    .trim();
  return { files, displayContent };
}
