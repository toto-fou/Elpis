// SPDX-License-Identifier: MIT
/** apps/core/src/admin/pilote-bac.ts — pilote du bac de la console (PortBac) : Docker local par @elpis/bac comme le Python (création et retrait du conteneur sous le verrou de cycle de vie) ; bac d'un hôte d'outils distant par cet hôte. */
import { getUserSandbox, resetUserSandboxCache, which } from "@elpis/bac";
import { getOu, getPy } from "@elpis/commun";

import { ClientHttp, delais } from "../llm/client-http";
import { hostFromSpec, isLoopback, lireHotes, sandboxHostFor } from "../relais/hotes";
import type { SandboxHost } from "../relais/hotes";
import { entetesRelais } from "../relais/identite";
import type { PortBac } from "./bac";

const DELAI_HOTE_S = 600;
const CONNEXION_HOTE_S = 5;

/** Hôte d'outils du compte s'il est distant (hors loopback), lu sans affecter le compte ; `null` : bac local. */
async function hoteDistant(uid: number): Promise<SandboxHost | null> {
  const hote = await sandboxHostFor(uid, false);
  return hote !== null && !isLoopback(hote.url) ? hote : null;
}

/** Appel de l'hôte au nom du compte (nom gardé : la base n'a peut-être plus sa ligne), corps JSON rendu ; un refus est levé avec le `detail` de l'hôte. */
export async function appelerHote(
  hote: SandboxHost,
  uid: number,
  username: string,
  methode: "POST" | "DELETE",
  chemin: string,
  options: { json?: unknown; delaiS?: number } = {},
): Promise<unknown> {
  const client = new ClientHttp({
    delais: delais(options.delaiS ?? DELAI_HOTE_S, { connect: CONNEXION_HOTE_S }),
  });
  try {
    const r = await client.request(methode, `${hote.url}${chemin}`, {
      headers: await entetesRelais(hote, uid, username),
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
    throw new Error(`hôte d'outils ${hote.id} : ${raison}`);
  } finally {
    await client.aclose();
  }
}

/** Compte supprimé purgé sur chaque hôte d'outils déclaré (sa base peut être distincte de celle du core) ; échecs rendus, jamais levés. */
export async function purgerCompteSurHotes(uid: number, username: string): Promise<string[]> {
  let hotes: SandboxHost[];
  try {
    hotes = [...lireHotes().hotes].flatMap(([id, spec]) => hostFromSpec(id, spec) ?? []);
  } catch (e) {
    return [`manifeste des hôtes illisible : ${e instanceof Error ? e.message : String(e)}`];
  }
  const sansJeton = hotes.filter((h) => !h.token).map((h) => `hôte d'outils ${h.id} : sans jeton de service`);
  const essais = await Promise.allSettled(
    hotes
      .filter((h) => h.token)
      .map((h) => appelerHote(h, uid, username, "POST", "/api/internal/account/purge", { delaiS: 15 })),
  );
  return sansJeton.concat(
    essais.flatMap((r) =>
      r.status === "rejected" ? [String(r.reason instanceof Error ? r.reason.message : r.reason)] : [],
    ),
  );
}

/** PortBac de la console : `P` d'un hôte distant supprimé par l'hôte, conteneur et purge locaux par @elpis/bac. */
export function piloteBac(): PortBac {
  return {
    async supprimerSurHote(uid, username) {
      const hote = await hoteDistant(uid);
      if (hote === null) return null;
      const r = await appelerHote(hote, uid, username, "POST", "/api/internal/sandbox/delete");
      return getOu(r, "deleted", false) === true;
    },
    async retirerConteneur(uid, username, travail) {
      if (which("docker") === null) return;
      try {
        await getUserSandbox(uid, username, travail).destroy();
      } finally {
        resetUserSandboxCache(uid);
      }
    },
    async purgerTravail(uid, username, travail) {
      try {
        await getUserSandbox(uid, username, travail).purge();
      } finally {
        resetUserSandboxCache(uid);
      }
    },
    async detruireConteneur(uid, username, travail, profilAvant) {
      const hote = await hoteDistant(uid);
      try {
        if (hote !== null) await appelerHote(hote, uid, username, "DELETE", "/api/sandbox/me");
        else await getUserSandbox(uid, username, travail, profilAvant).destroy();
      } finally {
        resetUserSandboxCache(uid);
      }
    },
  };
}
