// SPDX-License-Identifier: MIT
/** packages/bac/src/chargeur-image.ts — chargement de l'image du bac depuis son archive hors ligne (executors/_image_loader.py) : état du process, `docker load` en tâche de fond, attente bornée. */
import { statSync } from "node:fs";

import { arrondiPy, FlottantPy, journalDe, prefixePy, stripPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";

import { appelDocker, decoderRemplace } from "./docker";
import { candidateTarPaths, findImageArchive } from "./image";

export type ImageLoadStatus = "not_checked" | "loaded" | "loading" | "not_found" | "error";

export interface ImageLoadState {
  readonly status: ImageLoadStatus;
  readonly started_at: number | null;
  readonly finished_at: number | null;
  readonly error: string | null;
  readonly archive_path: string | null;
  readonly image: string | null;
  readonly progress_msg: string;
}

/** Délais du Python (ms), réglables par les tests. */
export const reglagesChargement = {
  inspectMs: 10_000,
  chargementMs: 300_000,
  attenteMs: 330_000,
  perimeS: 400,
};

function etatVide(): ImageLoadState {
  return {
    status: "not_checked",
    started_at: null,
    finished_at: null,
    error: null,
    archive_path: null,
    image: null,
    progress_msg: "",
  };
}

function etat(champs: Partial<ImageLoadState>): ImageLoadState {
  return { ...etatVide(), ...champs };
}

const maintenant = (): number => Date.now() / 1000;

let courant: ImageLoadState = etatVide();
let fin: Promise<void> | null = null;
let fileVerrou: Promise<unknown> = Promise.resolve();

/** `ImageLoadState.to_dict()` : durées arrondies comme `round(x, 1)` et écrites en flottants Python. */
export function imageStateDict(s: ImageLoadState): Dict {
  const d: Dict = {
    status: s.status,
    image: s.image,
    archive_path: s.archive_path,
    progress_msg: s.progress_msg,
  };
  if (s.error) d["error"] = s.error;
  if (s.started_at && s.status === "loading")
    d["elapsed_s"] = new FlottantPy(arrondiPy(maintenant() - s.started_at, 1));
  if (s.started_at && s.finished_at)
    d["duration_s"] = new FlottantPy(arrondiPy(s.finished_at - s.started_at, 1));
  return d;
}

export function getImageLoadState(): ImageLoadState {
  return courant;
}

/** `reset_state` : revérification au prochain appel. */
export function resetImageLoadState(): void {
  courant = etatVide();
}

/** `_is_image_loaded` : `docker image inspect` (10 s ; délai = absente). */
async function imageChargee(image: string): Promise<boolean> {
  const r = await appelDocker(["image", "inspect", image], reglagesChargement.inspectMs);
  return !r.delaiDepasse && r.code === 0;
}

/** `_docker_load` : `docker load -i <archive>` (5 min), puis l'image doit être listée. */
async function dockerLoad(archive: string, image: string): Promise<[boolean, string]> {
  journalDe("sandbox").info(`[image-loader] docker load -i ${archive} ...`);
  const r = await appelDocker(["load", "-i", archive], reglagesChargement.chargementMs);
  if (r.delaiDepasse) return [false, `Timeout (>5min) sur docker load ${archive}`];
  if (r.code !== 0)
    return [false, `docker load échec : ${prefixePy(stripPy(decoderRemplace(r.erreur)), 500)}`];
  if (!(await imageChargee(image)))
    return [
      false,
      `docker load OK mais l'image '${image}' n'est pas listée. L'archive contient-elle bien cette image ?`,
    ];
  return [true, prefixePy(stripPy(decoderRemplace(r.sortie)), 300)];
}

async function chargerEnFond(archive: string, image: string): Promise<void> {
  const debut = courant.started_at;
  let ok: boolean;
  let message: string;
  try {
    [ok, message] = await dockerLoad(archive, image);
  } catch (e) {
    [ok, message] = [false, `Exception pendant docker load : ${String(e)}`];
    journalDe("sandbox").error(`[image-loader] docker load a levé : ${String(e)}`);
  }
  courant = etat({
    status: ok ? "loaded" : "error",
    image,
    archive_path: archive,
    started_at: debut,
    finished_at: maintenant(),
    error: ok ? null : message,
    progress_msg: ok ? "Image chargée" : "Échec du chargement",
  });
  if (ok) journalDe("sandbox").info(`[image-loader] ✓ ${image} chargée`);
  else journalDe("sandbox").error(`[image-loader] ✗ ${image} : ${message}`);
}

/** File d'exclusion du process (l'`asyncio.Lock` du Python). */
async function sousVerrou<T>(f: () => Promise<T>): Promise<T> {
  const avant = fileVerrou;
  let liberer = (): void => undefined;
  fileVerrou = new Promise<void>((ok) => {
    liberer = ok;
  });
  await avant;
  try {
    return await f();
  } finally {
    liberer();
  }
}

async function attendreFin(signal?: AbortSignal): Promise<void> {
  if (fin === null) return;
  let minuterie: NodeJS.Timeout | undefined;
  let annuler: (() => void) | undefined;
  try {
    await Promise.race([
      fin,
      new Promise<void>((ok, ko) => {
        minuterie = setTimeout(ok, reglagesChargement.attenteMs);
        if (!signal) return;
        annuler = () => ko(signal.reason as Error);
        if (signal.aborted) annuler();
        else signal.addEventListener("abort", annuler, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(minuterie);
    if (annuler) signal?.removeEventListener("abort", annuler);
  }
}

/** `ensure_image_loaded` : image présente, sinon `docker load` de son archive en tâche de fond (`blocking` : attendue 330 s au plus). */
export async function ensureImageLoaded(
  image: string,
  options: { blocking?: boolean; signal?: AbortSignal } = {},
): Promise<ImageLoadState> {
  const bloquant = options.blocking ?? false;
  if (courant.status === "loaded" && courant.image === image) return courant;
  if (courant.status === "loading" && courant.image === image) {
    if (courant.started_at && maintenant() - courant.started_at > reglagesChargement.perimeS) {
      journalDe("sandbox").error(
        `[image-loader] LOADING périmé (${Math.round(maintenant() - courant.started_at)}s) pour ${image} — requalifié en ERROR, nouvel essai`,
      );
      courant = etat({
        status: "error",
        image,
        error: "Chargement interrompu (tâche morte) — nouvel essai en cours.",
        progress_msg: "Échec",
      });
    } else {
      if (bloquant) await attendreFin(options.signal);
      return courant;
    }
  }
  const lance = await sousVerrou(async () => {
    if (courant.status === "loaded" && courant.image === image) return false;
    if (courant.status === "loading" && courant.image === image) return false;
    if (await imageChargee(image)) {
      courant = etat({ status: "loaded", image, progress_msg: "Image déjà présente" });
      return false;
    }
    const archive = findImageArchive(image);
    if (archive === null) {
      courant = etat({
        status: "not_found",
        image,
        error:
          "Archive de l'image introuvable. Cherché dans :\n" +
          candidateTarPaths(image)
            .map((p) => `  • ${p}`)
            .join("\n") +
          "\n\nBuild l'image avec deploy/docker/sandbox/build_offline.sh " +
          "et place le .tar.gz dans <app>/sandbox_images/.",
        progress_msg: "Archive introuvable",
      });
      return false;
    }
    courant = etat({
      status: "loading",
      image,
      archive_path: archive,
      started_at: maintenant(),
      progress_msg: `Chargement de l'image (${Math.floor(statSync(archive).size / (1024 * 1024))} MB)…`,
    });
    fin = chargerEnFond(archive, image);
    return true;
  });
  if (lance && bloquant) await attendreFin(options.signal);
  return courant;
}
