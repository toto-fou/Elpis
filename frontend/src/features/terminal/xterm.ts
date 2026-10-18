// SPDX-License-Identifier: MIT
/** frontend/src/features/terminal/xterm.ts — chargement à la demande de xterm et création d'un terminal possédé (objets tiers hors réactivité). */
import type { FitAddon } from "@xterm/addon-fit";
import type { ITerminalOptions, Terminal } from "@xterm/xterm";
import { markRaw } from "vue";

import type * as Xterm from "./xterm-module";

type ModuleXterm = typeof Xterm;

let enCours: Promise<ModuleXterm> | null = null;
let charge: ModuleXterm | null = null;

/** Importe le chunk une fois ; un échec purge la mémoïsation pour permettre un nouvel essai. */
export function chargerXterm(): Promise<ModuleXterm> {
  enCours ??= import("./xterm-module").then(
    (m) => {
      charge = m;
      return m;
    },
    (err: unknown) => {
      enCours = null;
      throw err;
    },
  );
  return enCours;
}

export interface TerminalPossede {
  readonly term: Terminal;
  readonly fitAddon: FitAddon;
  /** Libère le terminal et son extension (idempotent). */
  liberer(): void;
}

/** Terminal et ajustement créés après `chargerXterm()`, marqués non réactifs. */
export function creerTerminal(options: ITerminalOptions): TerminalPossede {
  if (!charge) throw new Error("xterm non chargé");
  const term = markRaw(new charge.Terminal(options));
  const fitAddon = markRaw(new charge.FitAddon());
  term.loadAddon(fitAddon);
  let libere = false;
  return {
    term,
    fitAddon,
    liberer() {
      if (libere) return;
      libere = true;
      term.dispose();
    },
  };
}
