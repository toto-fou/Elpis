// SPDX-License-Identifier: MIT
/** apps/core/src/admin/pilote-bac.ts — pilote du bac de la console (PortBac) : bac d'un hôte distant mis de côté par cet hôte, conteneur et /work locaux par l'hôte de cette machine, jamais par Docker dans le core. */
import { getOu, getPy } from "@elpis/commun";

import { ClientHttp, delais } from "../llm/client-http";
import { hostFromSpec, isLoopback, lireHotes, sandboxHostFor } from "../relais/hotes";
import type { SandboxHost } from "../relais/hotes";
import { entetesRelais } from "../relais/identite";
import type { PortBac } from "./bac";

const DELAI_HOTE_S = 600;
const CONNEXION_HOTE_S = 5;

/** Hôte d'outils du compte (local compris), lu sans affecter le compte ; `null` : aucun hôte déclaré. */
function hoteDuCompte(uid: number): Promise<SandboxHost | null> {
  return sandboxHostFor(uid, false);
}

/** Hôte d'outils du compte s'il est distant (hors loopback) ; `null` : bac local. */
async function hoteDistant(uid: number): Promise<SandboxHost | null> {
  const hote = await hoteDuCompte(uid);
  return hote !== null && !isLoopback(hote.url) ? hote : null;
}

/** Hôte d'outils qui sert le `SANDBOX_DIR` de cette machine : le premier hôte en boucle locale doté d'un jeton de service (sans lui, un hôte ne détient aucun bac), jamais un hôte distant ; `null` : aucun. */
async function hoteDeCetteMachine(): Promise<SandboxHost | null> {
  try {
    for (const [id, spec] of lireHotes().hotes) {
      const hote = hostFromSpec(id, spec);
      if (hote?.token && isLoopback(hote.url)) return hote;
    }
  } catch {
    // manifeste illisible : aucun hôte
  }
  return null;
}

/** Refus d'un hôte d'outils : statut HTTP et `detail` rendus par l'hôte. */
export class ErreurHote extends Error {
  readonly statut: number;
  readonly detail: string;

  constructor(message: string, statut: number, detail: string) {
    super(message);
    this.name = "ErreurHote";
    this.statut = statut;
    this.detail = detail;
  }
}

/** Appel de l'hôte au nom du compte (suspension tolérée seulement pour un arrêt ou un nettoyage ; nom gardé : la base n'a peut-être plus sa ligne), corps JSON rendu ; un refus est levé avec le `detail` de l'hôte. */
export async function appelerHote(
  hote: SandboxHost,
  uid: number,
  username: string,
  methode: "GET" | "POST" | "DELETE",
  chemin: string,
  options: { json?: unknown; delaiS?: number; tolererSuspension?: boolean } = {},
): Promise<unknown> {
  const client = new ClientHttp({
    delais: delais(options.delaiS ?? DELAI_HOTE_S, { connect: CONNEXION_HOTE_S }),
  });
  try {
    const r = await client.request(methode, `${hote.url}${chemin}`, {
      headers: await entetesRelais(hote, uid, username, {
        tolererSuspension: options.tolererSuspension === true,
      }),
      ...(options.json === undefined ? {} : { json: options.json }),
    });
    if (r.isSuccess) return r.json();
    let detail: unknown = null;
    try {
      detail = getPy(r.json(), "detail");
    } catch {
      detail = null;
    }
    const raison = typeof detail === "string" && detail ? detail : `HTTP ${r.statusCode}`;
    throw new ErreurHote(
      `hôte d'outils ${hote.id} : ${raison}`,
      r.statusCode,
      typeof detail === "string" ? detail : "",
    );
  } finally {
    await client.aclose();
  }
}

/** Compte supprimé purgé sur chaque hôte d'outils déclaré avec une URL et un jeton de service (les autres ne détiennent rien) ; un échec par hôte nommé, jamais levé. */
export async function purgerCompteSurHotes(uid: number, username: string): Promise<string[]> {
  let declares: [string, SandboxHost | null][];
  try {
    declares = [...lireHotes().hotes].map(([id, spec]) => [id, hostFromSpec(id, spec)]);
  } catch (e) {
    return [`manifeste des hôtes illisible : ${e instanceof Error ? e.message : String(e)}`];
  }
  const essais = declares.map(async ([id, hote]): Promise<string | null> => {
    if (hote === null || !hote.token) return null;
    try {
      await appelerHote(hote, uid, username, "POST", "/api/internal/account/purge", {
        delaiS: 15,
        tolererSuspension: true,
      });
      return null;
    } catch (e) {
      const raison = e instanceof Error ? e.message : String(e);
      return raison.startsWith(`hôte d'outils ${id} `) ? raison : `hôte d'outils ${id} : ${raison}`;
    }
  });
  return (await Promise.all(essais)).filter((m): m is string => m !== null);
}

/** PortBac de la console : `P` d'un hôte distant mis de côté, remis ou supprimé par l'hôte ; conteneur et /work du reliquat local par l'hôte de cette machine, profil par l'hôte du compte ; seuls les hôtes touchent Docker. */
export function piloteBac(): PortBac {
  return {
    hoteDistantDuCompte: hoteDistant,
    async mettreDeCoteSurHote(hote, uid, username, horodatage) {
      const r = await appelerHote(hote, uid, username, "POST", "/api/internal/sandbox/set-aside", {
        tolererSuspension: true,
        json: { stamp: horodatage },
      });
      return getOu(r, "renamed", false) === true;
    },
    async remettreSurHote(hote, uid, username, horodatage) {
      await appelerHote(hote, uid, username, "POST", "/api/internal/sandbox/restore", {
        tolererSuspension: true,
        json: { stamp: horodatage },
      });
    },
    async supprimerMisDeCoteSurHote(hote, uid, username, horodatage) {
      const r = await appelerHote(hote, uid, username, "POST", "/api/internal/sandbox/discard", {
        tolererSuspension: true,
        json: { stamp: horodatage },
      });
      return getOu(r, "deleted", false) === true;
    },
    async retirerConteneur(uid, username) {
      const hote = await hoteDeCetteMachine();
      if (hote !== null)
        await appelerHote(hote, uid, username, "POST", "/api/internal/sandboxes/destroy", {
          tolererSuspension: true,
        });
    },
    async purgerTravail(uid, username, _travail, horodatage) {
      const hote = await hoteDeCetteMachine();
      if (hote === null) throw new Error("aucun hôte d'outils déclaré");
      await appelerHote(hote, uid, username, "POST", "/api/internal/sandbox/purge-work", {
        tolererSuspension: true,
        json: { stamp: horodatage },
      });
    },
    async detruireConteneur(uid, username) {
      const hote = await hoteDuCompte(uid);
      if (hote === null) throw new Error("aucun hôte d'outils déclaré");
      await appelerHote(hote, uid, username, "POST", "/api/internal/sandboxes/destroy", {
        tolererSuspension: true,
      });
    },
  };
}
