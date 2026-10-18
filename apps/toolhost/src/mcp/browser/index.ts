// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/index.ts — famille `browser` servie par l'hôte : 14 outils pw_* de @elpis/navigateur sur les définitions du golden Python, propriétaire imposé, mémoire AX dans la base de l'hôte. */
import type { Dict } from "@elpis/commun";
import { outilDuGolden, signatureDuGolden } from "@elpis/outils-mcp";
import type { ContexteAppel, DefinitionOutil, Golden } from "@elpis/outils-mcp";
import goldenBrowser from "@elpis/outils-mcp/goldens/browser.json" with { type: "json" };

import { baseHote } from "../../base-hote";
import type { Journal } from "../../journal";
import type { ServicesBrowser } from "./appel";
import { pwAct, pwChain, pwFind } from "./elements";
import { pwA11y, pwMock, pwObserve, pwRecorder, pwVisual } from "./essais";
import { pwMemory } from "./memoire";
import { pwDialog, pwExpect, pwPage, pwWait } from "./page";
import { pwSession } from "./session";

export type { ServicesBrowser } from "./appel";

const GOLDEN = goldenBrowser as unknown as Golden;

type Traitement = (args: Dict, ctx: ContexteAppel, brut: Dict) => Promise<unknown>;

/** Les 14 outils dans l'ordre d'enregistrement Python (`firefox_tools.register`). */
export function outilsBrowser(s: ServicesBrowser): DefinitionOutil[] {
  const traitements: [string, (s: ServicesBrowser) => Traitement][] = [
    ["pw_session", pwSession],
    ["pw_find", pwFind],
    ["pw_act", pwAct],
    ["pw_page", pwPage],
    ["pw_dialog", pwDialog],
    ["pw_wait", pwWait],
    ["pw_expect", pwExpect],
    ["pw_chain", pwChain],
    ["pw_mock", pwMock],
    ["pw_recorder", pwRecorder],
    ["pw_observe", pwObserve],
    ["pw_a11y", pwA11y],
    ["pw_visual", pwVisual],
    ["pw_memory", pwMemory],
  ];
  return traitements.map(([nom, fabrique]) =>
    outilDuGolden(GOLDEN, nom, { signature: signatureDuGolden(GOLDEN, nom), traiter: fabrique(s) }),
  );
}

/** Famille `browser` de l'hôte (forme de `FabriqueNative`) : mémoire AX dans la base ouverte au démarrage (`baseHote`). */
export const familleBrowser = (o: { journal: Journal }): { famille: string; outils: DefinitionOutil[] } => ({
  famille: "browser",
  outils: outilsBrowser({ ax: baseHote, journal: o.journal }),
});
