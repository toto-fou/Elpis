// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/index.ts — famille `browser` servie par l'hôte : 15 outils pw_* de @elpis/navigateur sur les définitions du golden, propriétaire imposé, mémoire AX dans la base de l'hôte, secrets du coffre par le core. */
import type { Dict } from "@elpis/commun";
import { outilDuGolden, signatureDuGolden } from "@elpis/outils-mcp";
import type { ContexteAppel, DefinitionOutil, Golden } from "@elpis/outils-mcp";
import goldenBrowser from "@elpis/outils-mcp/goldens/browser.json" with { type: "json" };

import { baseHote } from "../../base-hote";
import type { Journal } from "../../journal";
import type { ServicesBrowser } from "./appel";
import type { PortSecrets } from "./secrets";
import { pwAct, pwChain, pwFind } from "./elements";
import { pwA11y, pwMock, pwObserve, pwRecorder, pwVisual } from "./essais";
import { pwLogin } from "./login";
import { pwMemory } from "./memoire";
import { pwDialog, pwExpect, pwPage, pwWait } from "./page";
import { pwSession } from "./session";

export type { ServicesBrowser } from "./appel";

const GOLDEN = goldenBrowser as unknown as Golden;

type Traitement = (args: Dict, ctx: ContexteAppel, brut: Dict) => Promise<unknown>;

/** Les 15 outils dans l'ordre d'enregistrement (`firefox_tools.register`, puis `pw_login` après `pw_chain`). */
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
    ["pw_login", pwLogin],
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

/** Famille `browser` de l'hôte (forme de `FabriqueNative`) : mémoire AX dans la base ouverte au démarrage (`baseHote`), coffre par les rappels du core (`rappel`). */
export const familleBrowser = (o: {
  journal: Journal;
  rappel?: PortSecrets | null;
}): { famille: string; outils: DefinitionOutil[] } => ({
  famille: "browser",
  outils: outilsBrowser({ ax: baseHote, journal: o.journal, secrets: o.rappel ?? null }),
});
