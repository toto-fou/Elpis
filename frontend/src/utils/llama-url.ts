// SPDX-License-Identifier: MIT
/** frontend/src/utils/llama-url.ts — l'URL complète du moteur local suit l'hôte et le port quand elle visait l'ancien hôte:port (console › Inférence). */

function hote(ip: unknown, port: unknown): string {
  const h = String(ip ?? "").trim();
  const p = String(port ?? "").trim();
  if (!h) return "";
  const hh = h.includes(":") && !h.startsWith("[") ? "[" + h + "]" : h;
  return p ? hh + ":" + p : hh;
}

/** URL recalée sur le nouvel hôte:port si elle visait l'ancien (schéma et chemin gardés), sinon renvoyée telle quelle. */
export function suivreHotePort(
  url: string,
  ancienIp: unknown,
  ancienPort: unknown,
  nouvelIp: unknown,
  nouveauPort: unknown,
): string {
  const u = String(url ?? "").trim();
  if (!u) return url;
  const avant = hote(ancienIp, ancienPort);
  const apres = hote(nouvelIp, nouveauPort);
  if (!avant || !apres || avant === apres) return url;
  const m = /^(https?:\/\/)([^/?#]+)(.*)$/i.exec(u);
  if (!m || m[2]!.toLowerCase() !== avant.toLowerCase()) return url;
  return m[1]! + apres + m[3]!;
}
