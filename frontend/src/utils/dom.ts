// SPDX-License-Identifier: MIT
/** frontend/src/utils/dom.ts — petites aides DOM partagées par les composants : préférence de mouvement, presse-papiers, dépliage d'une réflexion. */

export function mouvementReduit(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Copie dans le presse-papiers, repli `execCommand` hors contexte sécurisé ; lève en cas d'échec. */
export async function copierTexte(texte: string): Promise<void> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    await navigator.clipboard.writeText(texte);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = texte;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

/** À l'ouverture d'un `<details>` de réflexion : le ramène dans la vue et cale son `<pre>` en bas. */
export function suivreReflexionOuverte(el: HTMLDetailsElement): void {
  if (!el.open) return;
  setTimeout(() => {
    el.scrollIntoView({ behavior: mouvementReduit() ? "auto" : "smooth", block: "nearest" });
    const p = el.querySelector("pre");
    if (p) p.scrollTop = p.scrollHeight;
  }, 60);
}

export function messageErreur(e: unknown): string {
  return e instanceof Error ? e.message : "";
}
