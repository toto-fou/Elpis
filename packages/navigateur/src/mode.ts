// SPDX-License-Identifier: MIT
/** packages/navigateur/src/mode.ts — service navigateur d'un compte, dans son bac (socket de `<P>/.elpis-agent`, jeton du bac), et la requête qui le joint. */
import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync } from "node:fs";

import { NOMS_HOTE } from "@elpis/bac";
import { config, pyJoin, safeSandboxName } from "@elpis/config";
import { O_PATH } from "@elpis/securite";
import { Agent, request } from "undici";

const O_CLOEXEC = 0o2000000;
/** Dossier de l'agent dans `<P>` (`AGENT_RUN_DIR` de @elpis/bac), monté sur /run/elpis. */
const DOSSIER_AGENT = ".elpis-agent";
/** Jeton du service du bac, sur l'hôte seul (`<P>`, jamais monté). */
const FICHIER_JETON_BAC = ".browser-service.token";

/** Bornes des lectures au service d'un bac (le bac est hostile) ; réglables par les tests. */
export const reglagesServiceBac = {
  /** Octets d'une réponse du service du bac lus au plus (captures et PDF compris) ; au-delà, la requête échoue. */
  reponseMax: 64 * 1024 * 1024,
};

/** Service navigateur d'un compte, dans son bac : socket unix sur l'hôte et jeton du bac. */
export interface ServiceNavigateur {
  readonly socket: string;
  readonly jeton: string;
}

/** Chemins sur l'hôte du navigateur d'un compte : `<P>` (`<SANDBOX_DIR>/<nom sûr>`), socket du service, socket du relais, certificat, jeton. */
export function cheminsNavigateurBac(username: string): {
  dossier: string;
  socket: string;
  relais: string;
  ca: string;
  jeton: string;
} {
  const dossier = pyJoin(config.SANDBOX_DIR, safeSandboxName(username));
  const run = pyJoin(dossier, DOSSIER_AGENT);
  return {
    dossier,
    socket: pyJoin(run, NOMS_HOTE.socket),
    relais: pyJoin(run, NOMS_HOTE.relais),
    ca: pyJoin(run, NOMS_HOTE.ca),
    jeton: pyJoin(dossier, FICHIER_JETON_BAC),
  };
}

/** Jeton du service du bac (première ligne du fichier de l'hôte), `""` s'il manque. */
export function jetonDuBac(chemin: string): string {
  try {
    return (readFileSync(chemin, "utf8").split("\n")[0] ?? "").trim();
  } catch {
    return "";
  }
}

/** LE résolveur : service navigateur du bac du compte `username` ; ne démarre rien. */
export function serviceNavigateur(username: string): ServiceNavigateur {
  const c = cheminsNavigateurBac(username);
  return { socket: c.socket, jeton: jetonDuBac(c.jeton) };
}

/** Services des bacs dont le jeton existe (service lancé au moins une fois) : un par dossier de `SANDBOX_DIR`, nom sûr d'un compte. */
export function servicesDesBacs(): ServiceNavigateur[] {
  let noms: string[];
  try {
    noms = readdirSync(config.SANDBOX_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  return noms.map(serviceNavigateur).filter((s) => s.jeton !== "");
}

/** En-têtes d'appel d'un service : `authorization` quand il a un jeton. */
function enTetesDuService(s: ServiceNavigateur, autres: Record<string, string> = {}): Record<string, string> {
  return s.jeton ? { ...autres, authorization: `Bearer ${s.jeton}` } : { ...autres };
}

export interface OptionsRequeteService {
  readonly methode?: string;
  readonly entetes?: Record<string, string>;
  readonly corps?: string | Buffer;
  readonly delaiMs: number;
  readonly signal?: AbortSignal;
}

/** Socket du bac saisi sans suivre de lien et vérifié (le bac écrit dans ce dossier) : descripteur à fermer ; erreur `ENOENT`/`ENOTSOCK` sinon. */
function saisirSocket(chemin: string): number {
  const fd = openSync(chemin, O_PATH | constants.O_NOFOLLOW | O_CLOEXEC);
  let ok: boolean;
  try {
    ok = fstatSync(fd).isSocket();
  } catch {
    ok = false;
  }
  if (!ok) {
    closeSync(fd);
    throw Object.assign(new Error(`${chemin}: not a socket`), { code: "ENOTSOCK" });
  }
  return fd;
}

/** Requête au service d'un compte (`chemin` avec sa requête) : statut et corps ; les échecs de transport lèvent comme undici (codes `E…`, `UND_ERR_*`). */
export async function requeteService(
  s: ServiceNavigateur,
  chemin: string,
  o: OptionsRequeteService,
): Promise<{ statut: number; corps: Buffer }> {
  const options = {
    method: (o.methode ?? "GET") as "GET",
    headers: enTetesDuService(s, o.entetes ?? {}),
    body: o.corps,
    headersTimeout: o.delaiMs,
    bodyTimeout: o.delaiMs,
    ...(o.signal ? { signal: o.signal } : {}),
  };
  const fd = saisirSocket(s.socket);
  const agent = new Agent({
    connect: { socketPath: `/proc/self/fd/${fd}`, timeout: 5_000 },
    maxResponseSize: reglagesServiceBac.reponseMax,
  });
  try {
    const r = await request(`http://browser${chemin}`, { ...options, dispatcher: agent });
    return { statut: r.statusCode, corps: Buffer.from(await r.body.arrayBuffer()) };
  } finally {
    await agent.close().catch(() => undefined);
    closeSync(fd);
  }
}
