// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/index.ts — famille `browser` servie par l'hôte : 15 outils pw_* de @elpis/navigateur sur les définitions du golden, propriétaire imposé, mémoire AX dans la base de l'hôte, secrets du coffre par le core. */
import { estDict, strPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { getUsername, outilDuGolden, signatureDuGolden } from "@elpis/outils-mcp";
import type { ContexteAppel, DefinitionOutil, Golden } from "@elpis/outils-mcp";
import goldenBrowser from "@elpis/outils-mcp/goldens/browser.json" with { type: "json" };

import { baseHote } from "../../base-hote";
import type { Journal } from "../../journal";
import { proprietaireDe, sousAgentDe } from "./appel";
import type { ServicesBrowser } from "./appel";
import { liaison, oublier } from "./liaisons";
import { conseilSecret, declencheurSecret } from "./secrets";
import type { PortSecrets } from "./secrets";
import { pwAct, pwChain, pwFind } from "./elements";
import { pwA11y, pwMock, pwObserve, pwRecorder, pwVisual } from "./essais";
import { pwLogin } from "./login";
import { pwMemory } from "./memoire";
import { pwDialog, pwExpect, pwPage, pwWait } from "./page";
import { pwSession, SESSION_DISPARUE } from "./session";

export type { ServicesBrowser } from "./appel";

const GOLDEN = goldenBrowser as unknown as Golden;

type Traitement = (args: Dict, ctx: ContexteAppel, brut: Dict) => Promise<unknown>;

/** Résultat d'un outil pw_* : liaison oubliée pour une session disparue ; session fermée sur un déclencheur : secret détaché par le core, erreur en clair ; refus `secret_*` réécrits pour le modèle. */
async function apresOutil(s: ServicesBrowser, a: Dict, ctx: ContexteAppel, r: unknown): Promise<unknown> {
  const sid = typeof a["session_id"] === "string" ? a["session_id"] : "";
  if (sid && estDict(r) && r["ok"] === false) {
    const owner = proprietaireDe(getUsername(ctx), sousAgentDe(ctx)).owner;
    const code = strPy(r["error"] ?? "");
    if (SESSION_DISPARUE.has(code)) oublier(owner, sid);
    if (code === "secret_session_closed") {
      const nom = liaison(owner, sid)?.secret ?? (typeof r["secret"] === "string" ? r["secret"] : null);
      oublier(owner, sid);
      return declencheurSecret(s.secrets ?? null, nom);
    }
  }
  return conseilSecret(r);
}

/** Les 15 outils dans l'ordre d'enregistrement (`firefox_tools.register`, puis `pw_login` après `pw_chain`) ; résultats revus par `apresOutil`. */
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
  return traitements.map(([nom, fabrique]) => {
    const traiter = fabrique(s);
    return outilDuGolden(GOLDEN, nom, {
      signature: signatureDuGolden(GOLDEN, nom),
      traiter: async (a, ctx, brut) => apresOutil(s, a, ctx, await traiter(a, ctx, brut)),
    });
  });
}

/** Famille `browser` de l'hôte (forme de `FabriqueNative`) : mémoire AX dans la base ouverte au démarrage (`baseHote`), coffre par les rappels du core (`rappel`). */
export const familleBrowser = (o: {
  journal: Journal;
  rappel?: PortSecrets | null;
}): { famille: string; outils: DefinitionOutil[] } => ({
  famille: "browser",
  outils: outilsBrowser({ ax: baseHote, journal: o.journal, secrets: o.rappel ?? null }),
});
