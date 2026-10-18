// SPDX-License-Identifier: MIT
/** apps/core/src/ops/travail-agent.ts — /work des comptes lu et écrit par l'agent de leur bac pour la sauvegarde et la restauration (routes/_helpers.py : _zip_work ; admin/lifecycle.py : _restaurer_work). */
import { lstatSync } from "node:fs";

import { getUserSettings, getUsernameById } from "@elpis/auth";
import type { AgentBac, BacPourAgent, OptionsArchive } from "@elpis/bac";
import {
  definirFabriqueAgent,
  erreurAgent,
  estErreurAgent,
  fabriqueAgent,
  getUserSandbox,
  racineTravail,
  resolveNetworkProfileIdReglages,
} from "@elpis/bac";
import { estDict, getPy, intPy, strPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Executeur } from "@elpis/db";
import { AgentClient } from "@elpis/fichiers";

import type { CycleDeVie } from "../cycle";
import type { Journal } from "../journal";
import { brancherTravail, dateZip } from "./sauvegarde";
import type { PortTravail } from "./sauvegarde";
import { ZIP64_LIMIT } from "./zip-disque";
import type { EcrivainZip } from "./zip-disque";

/** Bornes données à l'agent : la copie se fait en flux, rien n'est gardé en mémoire. */
export const BACKUP_WORK_MAX_BYTES = 2 ** 40;
export const BACKUP_WORK_MAX_ENTREES = 5_000_000;

/** Écriture d'un fichier de /work par l'agent (`AgentClient.write`). */
interface AgentEcrivain extends AgentBac {
  write(p: string, data: Uint8Array, o: { parents?: boolean }): Promise<Dict>;
}

/** Bac d'un compte vu de la sauvegarde : état, démarrage, arrêt et agent. */
export interface BacSauvegarde extends BacPourAgent {
  readonly agent: AgentBac;
  stop(): Promise<void>;
}

export type BacDuCompte = (uid: number) => Promise<BacSauvegarde>;

/** `_get_sandbox_for_user` : bac du compte, nom et profil réseau lus en base (« isolated » si illisible). */
export function bacsEnBase(x: Executeur): BacDuCompte {
  return async (uid) => {
    const profil = await getUserSettings(x, uid)
      .then(resolveNetworkProfileIdReglages)
      .catch(() => "isolated");
    const nom = (await getUsernameById(x, uid)) || `user_${uid}`;
    return getUserSandbox(uid, nom, await racineTravail(nom), profil);
  };
}

function mtimeNs(chemin: string): bigint | null {
  try {
    return lstatSync(chemin, { bigint: true }).mtimeNs;
  } catch {
    return null;
  }
}

function aEcriture(a: AgentBac): a is AgentEcrivain {
  return typeof (a as Partial<AgentEcrivain>).write === "function";
}

/** Entrées `raw` de l'agent écrites dans le zip sous `arcroot` ; un fichier coupé est commenté « incomplet » ; rend le bilan de l'agent. */
async function copierFlux(
  agent: AgentBac,
  arcroot: string,
  zip: EcrivainZip,
  incomplets: string[],
): Promise<Dict> {
  const options: OptionsArchive = {
    format: "raw",
    strict: false,
    maxBytes: BACKUP_WORK_MAX_BYTES,
    maxFiles: BACKUP_WORK_MAX_ENTREES,
    deadlineS: 240,
    activity: false,
  };
  const flux = await agent.archive([""], options);
  try {
    const it = flux[Symbol.asyncIterator]();
    let courant = await it.next();
    while (!courant.done) {
      const x = courant.value;
      if (Buffer.isBuffer(x)) throw erreurAgent("bad_response", "octets hors d'une entrée");
      if (!Object.hasOwn(x, "entry") || x["kind"] !== "file") {
        courant = await it.next();
        continue;
      }
      const entree = strPy(x["entry"]);
      const taille = Number(x["size"]);
      let ecrits = 0;
      const corps = async function* (): AsyncGenerator<Buffer> {
        for (;;) {
          courant = await it.next();
          if (courant.done) return;
          const v = courant.value;
          if (!Buffer.isBuffer(v)) {
            if (Object.hasOwn(v, "entry")) return;
            continue;
          }
          ecrits += v.length;
          yield v;
        }
      };
      try {
        await zip.ajouterFlux(
          {
            nom: `${arcroot}/${entree}`,
            dateHeure: dateZip(Number(x["mtime_ns"]) / 1e9),
            attributsExternes: (0o100000 | (Number(x["mode"]) & 0o7777)) * 0x10000,
            forceZip64: taille >= ZIP64_LIMIT,
          },
          corps(),
        );
      } finally {
        if (ecrits < taille) {
          zip.commenterDernier("incomplet");
          incomplets.push(`${entree} — incomplet (${ecrits}/${taille} octets)`);
        }
      }
    }
    return flux.fin ?? {};
  } finally {
    await flux.fermer();
  }
}

/** Bacs démarrés pour une lecture en cours, avec la date de leur /work avant la lecture. */
const ouverts = new Map<BacSauvegarde, bigint | null>();

/** Arrête de nouveau les bacs démarrés pour une lecture en cours, s'ils n'ont pas servi entre-temps (arrêt par signal). */
export async function rendreBacsOuverts(): Promise<void> {
  const bacs = [...ouverts];
  ouverts.clear();
  await Promise.all(
    bacs.map(([sb, avant]) =>
      mtimeNs(sb.sandboxPath) === avant ? sb.stop().catch(() => undefined) : Promise.resolve(),
    ),
  );
}

/** `copier` de `_zip_work` : bac arrêté démarré pour la lecture puis arrêté de nouveau si personne ne s'en est servi entre-temps. */
async function copierTravail(
  sb: BacSauvegarde,
  arcroot: string,
  zip: EcrivainZip,
  incomplets: string[],
): Promise<Dict> {
  const arretee = !(await sb.status()).running;
  if (arretee) await sb.ensureRunning();
  const avant = mtimeNs(sb.sandboxPath);
  if (arretee) ouverts.set(sb, avant);
  try {
    return await copierFlux(sb.agent, arcroot, zip, incomplets);
  } finally {
    if (arretee && ouverts.delete(sb) && mtimeNs(sb.sandboxPath) === avant)
      await sb.stop().catch(() => undefined);
  }
}

/** Accès au /work des comptes par l'agent de leur bac (`brancherTravail`). */
export function portTravailAgent(bacDe: BacDuCompte, journal?: Journal): PortTravail {
  return {
    async sauvegarder(userId, arcroot, zip, skipped) {
      const incomplets: string[] = [];
      let fin: Dict;
      try {
        fin = await copierTravail(await bacDe(userId), arcroot, zip, incomplets);
      } catch (e) {
        if (estErreurAgent(e)) {
          skipped.push(`${arcroot} — ${e.code}: ${e.message} : /work non sauvegardé`);
        } else {
          journal?.warn({ err: e }, `[backup] /work du compte ${userId} illisible`);
          const nom = e instanceof Error ? e.name : "Exception";
          skipped.push(
            `${arcroot} — ${nom}: ${e instanceof Error ? e.message : String(e)} : /work incomplet`,
          );
        }
        return false;
      } finally {
        skipped.push(...incomplets.map((i) => `${arcroot}/${i}`));
      }
      const omis = Array.isArray(fin["skipped"]) ? fin["skipped"] : [];
      for (const o of omis)
        if (estDict(o)) skipped.push(`${arcroot}/${strPy(getPy(o, "path"))} — ${strPy(getPy(o, "error"))}`);
      const reste = intPy(veritePy(fin["omitted"]) ? fin["omitted"] : 0) - omis.length;
      if (reste > 0) skipped.push(`${arcroot} — ${reste} autre(s) entrée(s) omise(s)`);
      if (veritePy(fin["truncated"]))
        skipped.push(`${arcroot} — sauvegarde tronquée (${BACKUP_WORK_MAX_ENTREES} entrées au plus)`);
      return true;
    },

    async restaurer(userId, lot, lire, restored, errors) {
      const agent = (await bacDe(userId)).agent;
      if (!aEcriture(agent)) throw erreurAgent("agent_unavailable", "écriture par l'agent indisponible");
      for (const [i, [entree, rel]] of lot.entries()) {
        try {
          await agent.write(rel, await lire(entree), { parents: true });
          restored.push(entree);
        } catch (e) {
          if (!estErreurAgent(e)) throw e;
          if (e.status) {
            errors.push(`${entree}: ${e.code}`);
            continue;
          }
          for (const [n] of lot.slice(i)) errors.push(`${n}: ${e.code}`);
          return;
        }
      }
    },
  };
}

/** Client de l'agent posé pour les bacs de ce process s'il ne l'est pas déjà (l'hôte d'outils pose le sien). */
export function assurerFabriqueAgent(): void {
  if (fabriqueAgent() === null) definirFabriqueAgent((bac) => new AgentClient(bac));
}

/** Process du core : la console, l'envoi distant planifié et la restauration passent par l'agent du bac de chaque compte, comme main en Python. */
export function brancherTravailDesComptes(cycle: CycleDeVie, x: Executeur, journal: Journal): void {
  assurerFabriqueAgent();
  brancherTravail(portTravailAgent(bacsEnBase(x), journal));
  cycle.alArret("accès au /work des comptes", () => brancherTravail(null));
}
