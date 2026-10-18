// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/export.ts — export d'une conversation en JSON, Markdown, texte ou PDF (fenêtre d'impression). */
import * as marked from "marked";

import { escapeHtml, fmtElapsed } from "../../utils/utils-purs.ts";
import { purificateur } from "./rendu/instance.ts";

export type FormatExport = "json" | "md" | "txt" | "pdf";

export interface MessageExporte {
  role?: string;
  content?: string | null;
  metrics?: { duration?: number; write_tps?: number | string; model?: string } | null;
  thinking?: string | null;
  attachments?: readonly { name?: string; type?: string }[] | null;
}

export interface ConversationExportee {
  messages: readonly MessageExporte[];
  titre: string;
  chatId: string;
  utilisateur: string;
  assistant: string;
}

/** Téléchargement d'un Blob : ancre dans le document et révocation différée (sinon Firefox avorte sans erreur). */
export function telechargerBlob(blob: Blob, nom: string): void {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: nom });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Markdown en HTML purifié : la fenêtre d'impression est de la même origine que l'application. */
function versHtml(texte: string): string {
  return purificateur()(marked.parse(texte) as string);
}

function exporterPdf(c: ConversationExportee): void {
  const titre = escapeHtml(c.titre);
  const user = escapeHtml(c.utilisateur);
  const asst = escapeHtml(c.assistant);
  const rows = c.messages
    .filter((m) => m.role && m.content)
    .map((m) => {
      const isUser = m.role === "user";
      const html = versHtml(m.content || "");
      const bg = isUser ? "#f0f4ff" : "#ffffff";
      const border = isUser ? "#c7d2fe" : "#e2e8f0";
      const duree = fmtElapsed(m.metrics && m.metrics.duration);
      const metrics = m.metrics
        ? '<div style="font-size:10px;color:#94a3b8;margin-top:6px">' +
          escapeHtml(m.metrics.write_tps || "") +
          " t/s · " +
          escapeHtml(duree) +
          " · " +
          escapeHtml(m.metrics.model || "") +
          "</div>"
        : "";
      return (
        '<div style="margin-bottom:20px;padding:16px;background:' +
        bg +
        ";border:1px solid " +
        border +
        ';border-radius:12px;"><div style="font-weight:700;font-size:12px;color:#475569;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">' +
        (isUser ? user : asst) +
        '</div><div style="font-size:14px;color:#1e293b;line-height:1.6">' +
        html +
        "</div>" +
        metrics +
        "</div>"
      );
    })
    .join("");
  const w = window.open("", "_blank");
  if (!w) return;
  const date = new Date().toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  w.document.write(
    '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' +
      titre +
      '</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:820px;margin:40px auto;color:#1e293b;background:#fff}h1{font-size:20px;font-weight:800;color:#0f172a;margin-bottom:4px}.meta{font-size:12px;color:#94a3b8;margin-bottom:32px}pre{background:#1e293b;color:#e2e8f0;padding:12px;border-radius:8px;overflow-x:auto;font-size:12px}code{font-family:monospace;font-size:13px;background:#f1f5f9;padding:2px 5px;border-radius:4px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #e2e8f0;padding:8px}@media print{body{margin:0}@page{margin:20mm}}</style></head><body><h1>' +
      titre +
      '</h1><div class="meta">Exporté le ' +
      date +
      " · " +
      c.messages.length +
      " messages</div>" +
      rows +
      "</body></html>",
  );
  w.document.close();
  w.focus();
  // Impression lancée d'ici (même origine) : la fenêtre about:blank hérite de la CSP de la page, sans script en ligne.
  const imprimer = (): void => {
    setTimeout(() => w.print(), 150);
  };
  if (w.document.readyState === "complete") imprimer();
  else w.addEventListener("load", imprimer, { once: true });
}

export function exporterConversation(format: FormatExport, c: ConversationExportee): void {
  if (!c.messages.length) return;
  const nomRole = (m: MessageExporte): string => (m.role === "user" ? c.utilisateur : c.assistant);
  if (format === "json") {
    const data = {
      title: c.titre,
      exported_at: new Date().toISOString(),
      messages: c.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.metrics ? { metrics: m.metrics } : {}),
        ...(m.thinking ? { thinking: m.thinking } : {}),
        ...(m.attachments ? { attachments: m.attachments.map((a) => ({ name: a.name, type: a.type })) } : {}),
      })),
    };
    telechargerBlob(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      "chat_" + c.chatId + ".json",
    );
  } else if (format === "md") {
    let md = "# " + c.titre + "\n\n";
    for (const m of c.messages) md += "### " + nomRole(m) + "\n" + m.content + "\n\n---\n\n";
    telechargerBlob(new Blob([md], { type: "text/markdown" }), "chat_" + c.chatId + ".md");
  } else if (format === "txt") {
    let txt = c.titre + "\n" + "=".repeat(c.titre.length) + "\n\n";
    for (const m of c.messages) txt += "[" + nomRole(m) + "]\n" + m.content + "\n\n";
    telechargerBlob(new Blob([txt], { type: "text/plain" }), "chat_" + c.chatId + ".txt");
  } else if (format === "pdf") {
    exporterPdf(c);
  }
}
