// SPDX-License-Identifier: MIT
/** frontend/src/entries/diagnostic.ts — entrée de diagnostic, chargée avant l'application : si rien n'est monté après 4 s, la fenêtre d'erreur de la page liste les erreurs capturées. */
import "../styles/diagnostic.css";

interface ErreurCapturee {
  msg: string;
  src?: string;
  line?: number;
}

const erreurs: ErreurCapturee[] = [];

window.addEventListener("error", (e) => {
  erreurs.push({ msg: e.message, src: e.filename, line: e.lineno });
});
window.addEventListener("unhandledrejection", (e) => {
  const raison: unknown = e.reason;
  const msg = raison instanceof Error ? raison.message : String(raison ?? "inconnue");
  erreurs.push({ msg: "Promise: " + msg });
});

function rapport(): string {
  const lignes = ["[KO] application non montée après 4 s"];
  if (erreurs.length) {
    lignes.push("\nErreurs JS capturées :");
    for (const e of erreurs)
      lignes.push("  → " + e.msg + (e.src ? ` (${e.src}:${String(e.line ?? "?")})` : ""));
  } else {
    lignes.push(
      "\nAucune erreur capturée (un module illisible ou absent ne déclenche pas d'erreur visible ici)",
    );
  }
  lignes.push("\nActions à tenter :");
  lignes.push("  1. Ctrl+Shift+R (rechargement sans cache)");
  lignes.push("  2. F12 → Console pour voir les erreurs rouges");
  lignes.push("  3. F12 → Réseau → cocher « Désactiver le cache » et recharger");
  return lignes.join("\n");
}

// Montage tardif (poste lent) : la fenêtre se retire dès que l'application finit par monter, borné à 60 s.
setTimeout(() => {
  const app = document.getElementById("app");
  const fenetre = document.getElementById("vue-error-overlay");
  if (!app?.hasAttribute("v-cloak") || !fenetre) return;
  fenetre.classList.add("active");
  const details = document.getElementById("vue-error-details");
  if (details) details.textContent = rapport();
  let essais = 0;
  const veille = setInterval(() => {
    if (!app.hasAttribute("v-cloak")) {
      fenetre.classList.remove("active");
      clearInterval(veille);
    } else if (++essais > 120) clearInterval(veille);
  }, 500);
}, 4000);
