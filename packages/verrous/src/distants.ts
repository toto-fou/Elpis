// SPDX-License-Identifier: MIT
/** packages/verrous/src/distants.ts — dossiers de données sur un système de fichiers réseau, où O_EXCL et les verrous ne tiennent pas (verrou_fichier.systemes_distants, `./elpis doctor`). */
import { readFileSync } from "node:fs";

import { comparePointsDeCode, realpathPy, rstripPy, splitlinesPy, splitPy } from "@elpis/commun";

export const SYSTEMES_DISTANTS: ReadonlySet<string> = new Set([
  "nfs",
  "nfs4",
  "cifs",
  "smb3",
  "smbfs",
  "9p",
  "ceph",
  "glusterfs",
  "afs",
  "lustre",
  "gpfs",
  "vboxsf",
  "davfs",
  "fuse.sshfs",
  "fuse.glusterfs",
  "fuse.s3fs",
  "fuse.rclone",
  "fuse.davfs2",
  "fuse.vmhgfs-fuse",
  "fuse.ceph-fuse",
  "fuse.gcsfuse",
]);

/** `_decoder_montage` : échappements octaux de /proc/self/mounts (`\040` pour l'espace). */
function decoderMontage(champ: string): string {
  return champ.replace(/\\([0-7]{3})/gu, (_t, o: string) => String.fromCharCode(parseInt(o, 8)));
}

/** `systemes_distants` : `[chemin, type]` des chemins sur un système réseau ou contenant un montage réseau, triés. */
export function systemesDistants(chemins: readonly string[], montagesTexte?: string): [string, string][] {
  let texte: string;
  try {
    texte = montagesTexte ?? readFileSync("/proc/self/mounts", "utf-8");
  } catch {
    return [];
  }
  const points = splitlinesPy(texte)
    .map((ligne) => splitPy(ligne))
    .filter((m) => m.length > 2)
    .map((m) => [decoderMontage(m[1] as string), m[2] as string] as const)
    .map((p, i) => [p, i] as const)
    .sort((a, b) => [...b[0][0]].length - [...a[0][0]].length || a[1] - b[1])
    .map(([p]) => p);
  const out = new Map<string, [string, string]>();
  const ajouter = (c: string, fs: string): void => void out.set(`${c}\0${fs}`, [c, fs]);
  for (const c of chemins) {
    const reel = realpathPy(c);
    for (const [point, fs] of points) {
      if (reel === point || reel.startsWith(`${rstripPy(point, "/")}/`)) {
        if (SYSTEMES_DISTANTS.has(fs)) ajouter(c, fs);
        break;
      }
    }
    for (const [point, fs] of points)
      if (SYSTEMES_DISTANTS.has(fs) && point.startsWith(`${rstripPy(reel, "/")}/`)) ajouter(point, fs);
  }
  return [...out.values()].sort((a, b) => comparePointsDeCode(a[0], b[0]) || comparePointsDeCode(a[1], b[1]));
}
