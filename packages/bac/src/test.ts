// SPDX-License-Identifier: MIT
/** packages/bac/src/test.ts — faux binaire `docker` à état pour les essais (un conteneur par nom, options de `run` gardées, `find /work … -delete` joué sur le montage) : core, hôte TS et toolhost Python. */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Script shell : `$FAUX_DOCKER/<nom>.run` = argv du `docker run` ; `sans-image`, `demon-ko`, `run-ko` changent les réponses ; chaque appel journalisé. */
const SCRIPT = `#!/bin/sh
d="$FAUX_DOCKER"
printf '%s\\n' "$*" >> "$d/appels.log"
nom() { for a; do n="$a"; done; printf '%s' "$n"; }
case "$1" in
  version)
    [ -f "$d/demon-ko" ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
    echo "27.3.1"; exit 0 ;;
  image)
    [ -f "$d/sans-image" ] && exit 1; exit 0 ;;
  container)
    n="$3"
    [ -f "$d/$n.run" ] || { echo "Error: No such container: $n" >&2; exit 1; }
    case "$*" in
      *NetworkSettings*) echo "172.17.0.9 " ;;
      *) echo "0123456789abcdef0123|/$n|true|elpis/sandbox:1.7.0|2026-10-10T00:00:00Z" ;;
    esac
    exit 0 ;;
  inspect)
    n=$(nom "$@")
    [ -f "$d/$n.run" ] || { echo "Error: No such object: $n" >&2; exit 1; }
    case "$*" in
      *Mounts*) sed -n 's/^\\(.*\\):\\/work:rw$/\\1/p' "$d/$n.run" ;;
      *elpis.netcfg*)
        net=$(sed -n 's/^elpis.netcfg=//p' "$d/$n.run"); spec=$(sed -n 's/^elpis.spec=//p' "$d/$n.run")
        ag=$(sed -n 's/^elpis.agent=//p' "$d/$n.run")
        echo "$net|$spec|elpis/sandbox:1.7.0|$ag" ;;
      *State.Status*) echo "running|0" ;;
      *ExitCode*) echo "0|false" ;;
      *) echo "" ;;
    esac
    exit 0 ;;
  run)
    [ -f "$d/run-ko" ] && { echo "docker: Error response from daemon: boom." >&2; exit 125; }
    n=""; prev=""
    for a; do [ "$prev" = "--name" ] && n="$a"; prev="$a"; done
    : > "$d/$n.run"; for a; do printf '%s\\n' "$a" >> "$d/$n.run"; done
    echo "f00dcafe"; exit 0 ;;
  rm)
    for a; do case "$a" in -*) ;; rm) ;; *) rm -f "$d/$a.run" ;; esac; done; exit 0 ;;
  stats) echo '{"cpu":"0.50%","mem":"12MiB / 2GiB","mem_pct":"0.59%","pids":"4"}'; exit 0 ;;
  logs) echo "journal du conteneur"; exit 0 ;;
  exec)
    shift; while :; do case "$1" in -u|-e|-w) shift 2 ;; -*) shift ;; *) break ;; esac; done
    n="$1"; shift
    case "$*" in
      "find /work "*-delete)
        src=$(sed -n 's/^\\(.*\\):\\/work:rw$/\\1/p' "$d/$n.run" 2>/dev/null)
        [ -n "$src" ] || { echo "Error: No such container: $n" >&2; exit 1; }
        chmod -R u+rwx "$src" && find "$src" -xdev -mindepth 1 -delete; exit $? ;;
    esac
    exit 0 ;;
  ps) exit 0 ;;
esac
exit 0
`;

export interface FauxDocker {
  readonly bin: string;
  readonly etat: string;
  appels(): string[];
  poser(drapeau: "sans-image" | "demon-ko" | "run-ko", actif?: boolean): void;
}

/** Crée `<dossier>/bin/docker` et l'état `<dossier>/etat` ; à mettre en tête du PATH avec `FAUX_DOCKER`. */
export function creerFauxDocker(dossier: string): FauxDocker {
  const bin = path.join(dossier, "bin");
  const etat = path.join(dossier, "etat");
  mkdirSync(bin, { recursive: true });
  mkdirSync(etat, { recursive: true });
  writeFileSync(path.join(bin, "docker"), SCRIPT);
  chmodSync(path.join(bin, "docker"), 0o755);
  writeFileSync(path.join(etat, "appels.log"), "");
  return {
    bin,
    etat,
    appels: () =>
      readFileSync(path.join(etat, "appels.log"), "utf-8")
        .split("\n")
        .filter((l) => l !== ""),
    poser(drapeau, actif = true) {
      if (actif) writeFileSync(path.join(etat, drapeau), "");
      else rmSync(path.join(etat, drapeau), { force: true });
    },
  };
}
