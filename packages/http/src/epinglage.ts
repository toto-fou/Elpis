// SPDX-License-Identifier: MIT
/** packages/http/src/epinglage.ts — agent undici dont chaque connexion est jugée puis jointe aux seules adresses validées, sans nouvelle résolution (Host, SNI et certificat sur le nom d'origine). */
import type { LookupFunction } from "node:net";

import { Agent, buildConnector, fetch as fetchUndici } from "undici";

export interface VerdictHote {
  readonly motif: string | null;
  readonly adresses: readonly string[];
}

/** Juge un hôte (nom ou IP, sans crochets) et son port : motif de refus, ou adresses à joindre. */
export type JugeHote = (hote: string, port: number) => Promise<VerdictHote>;

export const CODE_REFUS = "ELPIS_DESTINATION_REFUSEE";
export const MESSAGE_REFUS = "destination refusée";

/** Connexion refusée par le juge, avant tout octet envoyé. */
export class ConnexionRefusee extends Error {
  readonly code = CODE_REFUS;

  constructor(motif: string) {
    super(`${MESSAGE_REFUS} : ${motif}`);
    this.name = "ConnexionRefusee";
  }
}

function recherche(adresses: readonly string[]): LookupFunction {
  const liste = adresses.map((a) => ({ address: a, family: a.includes(":") ? 6 : 4 }));
  return (hote, options, rappel) => {
    const premiere = liste[0];
    if (premiere === undefined)
      rappel(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hote}`), { code: "ENOTFOUND" }), "", 0);
    else if (options.all) rappel(null, liste);
    else rappel(null, premiere.address, premiere.family);
  };
}

/** Agent dont chaque nouvelle connexion passe par `juger` ; `connexion` : options TLS et délai, transmises au connecteur. */
export function agentEpingle(
  juger: JugeHote,
  connexion: buildConnector.BuildOptions = {},
  options: Agent.Options = {},
): Agent {
  const connecter: buildConnector.connector = (opts, rappel) => {
    const hote = opts.hostname.replace(/^\[(.*)\]$/su, "$1");
    const port = Number(opts.port) || (opts.protocol === "https:" ? 443 : 80);
    juger(hote, port).then(
      (v) => {
        if (v.motif !== null) rappel(new ConnexionRefusee(v.motif), null);
        else if (v.adresses.length === 0)
          rappel(new ConnexionRefusee(`aucune adresse validée (${hote})`), null);
        else buildConnector({ ...connexion, lookup: recherche(v.adresses) })(opts, rappel);
      },
      (e: unknown) => rappel(e instanceof Error ? e : new Error(String(e)), null),
    );
  };
  return new Agent({ ...options, connect: connecter });
}

/** `fetch` passant par `agent` (même implémentation d'undici que l'agent). */
export function fetchPar(agent: Agent): typeof globalThis.fetch {
  return ((entree: Parameters<typeof fetchUndici>[0], init?: Parameters<typeof fetchUndici>[1]) =>
    fetchUndici(entree, { ...init, dispatcher: agent })) as unknown as typeof globalThis.fetch;
}
