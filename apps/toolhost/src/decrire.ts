// SPDX-License-Identifier: MIT
/** apps/toolhost/src/decrire.ts — message d'une erreur réseau sans URL ni en-tête (jamais de jeton dans un journal). */
export function decrire(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code ?? (e.cause as { code?: unknown } | undefined)?.code;
    return `${e.name}${typeof code === "string" ? ` ${code}` : ""}`;
  }
  return typeof e;
}
