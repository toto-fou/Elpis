// SPDX-License-Identifier: MIT
/** apps/core/src/relais/services.ts — appels de service vers l'hôte d'un compte : actifs (vision), miroir des skills, session d'historique au login. */
import { statSync } from "node:fs";
import { gzipSync } from "node:zlib";

import { strPy, veritePy } from "@elpis/commun";
import { parseJsonPy } from "@elpis/config";
import { Agent, FormData, request } from "undici";

import { journal as journalDomaine } from "../journal";
import type { Journal } from "../journal";
import { urlAmont } from "./chemins";
import { estDict, lire } from "./dict";
import { isLoopback, sandboxHostFor } from "./hotes";
import { decrire } from "./http";
import { entetesRelais } from "./identite";
import { archiverDossier } from "./tar";
import { decouperCible } from "@elpis/http";

export const FILE_HISTORY_SESSION_PATH = "/internal/file-history/session";

export interface OptionsService {
  readonly delaiMs?: number;
  readonly journal?: Journal;
}

function agentBorne(connexionMs: number, lectureMs: number): Agent {
  return new Agent({ connect: { timeout: connexionMs }, headersTimeout: lectureMs, bodyTimeout: lectureMs });
}

/** Octets d'un chemin relayé (capture, trame) pour ce compte ; `null` sans hôte, hors préfixes, hors 200 ou en échec. */
export async function fetchRelayedBytes(
  uid: number,
  chemin: string,
  options: OptionsService = {},
): Promise<Buffer | null> {
  const delaiMs = options.delaiMs ?? 10_000;
  const hote = await sandboxHostFor(uid);
  if (hote === null || !hote.token) return null;
  const agent = agentBorne(delaiMs, delaiMs);
  try {
    const cible = decouperCible(chemin);
    const url = urlAmont(hote.url, cible.chemin, cible.requete);
    if (url === null) return null;
    const r = await request(url, {
      dispatcher: agent,
      method: "GET",
      headers: await entetesRelais(hote, uid),
    });
    if (r.statusCode !== 200) {
      await r.body.dump();
      return null;
    }
    return Buffer.from(await r.body.arrayBuffer());
  } catch (e) {
    (options.journal ?? journalDomaine("sandbox-relay")).info(`actif ${chemin} : ${decrire(e)}`);
    return null;
  } finally {
    void agent.destroy();
  }
}

/** Pousse le store de skills (tar.gz) vers l'hôte DISTANT du compte ; `false` en loopback (même disque), sans hôte ou en échec. */
export async function pushSkillsMirror(
  uid: number,
  dossier: string,
  options: OptionsService = {},
): Promise<boolean> {
  const delaiMs = options.delaiMs ?? 30_000;
  const hote = await sandboxHostFor(uid);
  if (hote === null || !hote.relay || !hote.token || isLoopback(hote.url)) return false;
  try {
    if (!statSync(dossier).isDirectory()) return false;
  } catch {
    return false;
  }
  const agent = agentBorne(delaiMs, delaiMs);
  try {
    const formulaire = new FormData();
    const archive = gzipSync(archiverDossier(dossier), { level: 9 });
    formulaire.append("archive", new Blob([archive], { type: "application/gzip" }), "skills.tar.gz");
    const r = await request(hote.url + "/api/sandbox/skills-mirror", {
      dispatcher: agent,
      method: "POST",
      headers: await entetesRelais(hote, uid),
      body: formulaire,
    });
    await r.body.dump();
    return r.statusCode === 200;
  } catch (e) {
    (options.journal ?? journalDomaine("sandbox-relay")).warn(
      `miroir des skills non poussé (${hote.id}) : ${decrire(e)}`,
    );
    return false;
  } finally {
    void agent.destroy();
  }
}

/** Session d'historique ouverte sur l'hôte du compte au login : bornée (3 s), jamais d'exception, avertissement en cas d'échec. */
export async function ouvrirSessionHistorique(
  uid: number,
  options: OptionsService = {},
): Promise<string | null> {
  const delaiMs = options.delaiMs ?? 3_000;
  const log = options.journal ?? journalDomaine("sandbox-relay");
  const signal = AbortSignal.timeout(delaiMs);
  const agent = agentBorne(Math.min(1_500, delaiMs), delaiMs);
  try {
    const hote = await sandboxHostFor(uid);
    if (hote === null) {
      log.warn("session d'historique non ouverte : aucun hôte d'outils déclaré (mcp.json › sandboxHosts)");
      return null;
    }
    if (!hote.token) {
      log.warn(`session d'historique non ouverte (${hote.id}) : hôte d'outils sans jeton de service`);
      return null;
    }
    const r = await request(hote.url + FILE_HISTORY_SESSION_PATH, {
      dispatcher: agent,
      method: "POST",
      headers: await entetesRelais(hote, uid),
      signal,
    });
    const texte = await r.body.text();
    const corps = r.statusCode === 200 ? parseJsonPy(texte) : {};
    if (estDict(corps) && veritePy(lire(corps, "ok")) && veritePy(lire(corps, "id")))
      return strPy(lire(corps, "id"));
    log.warn(`session d'historique non ouverte (${hote.id}) : HTTP ${r.statusCode}`);
  } catch (e) {
    log.warn(`session d'historique non ouverte : ${decrire(e)}`);
  } finally {
    void agent.destroy();
  }
  return null;
}
