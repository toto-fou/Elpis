// SPDX-License-Identifier: MIT
/** packages/bac/src/docker.ts — CLI Docker locale (`shutil.which("docker")`, appels bornés, tués au dépassement) et noms/étiquettes des conteneurs (shared_infra/sandbox/naming.py). */
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

export const CONTAINER_PREFIX = "elpis-sb-";
export const LABEL_NS = "elpis";
const DOCKER_PAR_DEFAUT = "/usr/bin/docker";
const DECODEUR_REMPLACE = new TextDecoder("utf-8", { ignoreBOM: true });

export interface ResultatDocker {
  /** Code de sortie ; `null` si le processus a été tué (dépassement du délai) ou terminé par un signal. */
  readonly code: number | null;
  /** Signal qui a terminé le processus, sinon `null`. */
  readonly signal: NodeJS.Signals | null;
  readonly sortie: Buffer;
  readonly erreur: Buffer;
  readonly delaiDepasse: boolean;
}

/** `container_name(username)` : nom du conteneur d'un compte (nom déjà assaini). */
export function containerName(username: string): string {
  return `${CONTAINER_PREFIX}${username}`;
}

/** `label(key, value)` : `elpis.<key>` ou `elpis.<key>=<value>`. */
export function label(key: string, value: string | null = null): string {
  return value === null ? `${LABEL_NS}.${key}` : `${LABEL_NS}.${key}=${value}`;
}

/** `label_filter` : arguments `--filter label=elpis.<key>[=<value>]` d'un `docker ps`. */
export function labelFilter(key: string, value: string | null = null): string[] {
  return ["--filter", `label=${label(key, value)}`];
}

/** `label_tpl` : gabarit Go de lecture de l'étiquette (`docker ps` si `ps`, sinon `docker inspect`). */
export function labelTpl(key: string, ps = false): string {
  return ps ? `{{.Label "${LABEL_NS}.${key}"}}` : `{{index .Config.Labels "${LABEL_NS}.${key}"}}`;
}

/** `shutil.which(nom)` : premier exécutable (fichier, droit d'exécution) du PATH, sinon `null`. */
export function which(nom: string, chemins = process.env["PATH"] ?? ""): string | null {
  for (const dossier of chemins.split(path.delimiter)) {
    const candidat = path.join(dossier || ".", nom);
    try {
      if (!statSync(candidat).isFile()) continue;
      accessSync(candidat, constants.X_OK);
      return candidat;
    } catch {
      continue;
    }
  }
  return null;
}

/** `shutil.which("docker") or "/usr/bin/docker"`, relu à chaque appel. */
export function binaireDocker(): string {
  return which("docker") ?? DOCKER_PAR_DEFAUT;
}

/** `bytes.decode("utf-8", errors="replace")`. */
export function decoderRemplace(octets: Buffer): string {
  return DECODEUR_REMPLACE.decode(octets);
}

export interface OptionsAppelDocker {
  /** Octets écrits sur l'entrée standard, fermée ensuite ; sans eux, l'entrée est fermée d'emblée. */
  readonly entree?: Buffer;
  /** Annulation (la `CancelledError` de Python) : le processus est tué, sa fin attendue, puis la raison levée. */
  readonly signal?: AbortSignal;
  readonly binaire?: string;
}

/** `create_subprocess_exec` + `communicate()` borné : au délai, le processus est tué (SIGKILL) et rendu dès sa fin, sans attendre un descendant qui tiendrait ses tubes ; une erreur de lancement (ENOENT…) est levée. */
export function appelDocker(
  args: readonly string[],
  delaiMs: number | null,
  options: OptionsAppelDocker = {},
): Promise<ResultatDocker> {
  const { entree, signal } = options;
  if (signal?.aborted) return Promise.reject(signal.reason as Error);
  return new Promise((resoudre, rejeter) => {
    const proc = spawn(options.binaire ?? binaireDocker(), [...args], {
      stdio: [entree ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const sortie: Buffer[] = [];
    const erreur: Buffer[] = [];
    let delaiDepasse = false;
    let minuterie: NodeJS.Timeout | undefined;
    const annuler = (): void => {
      clearTimeout(minuterie);
      proc.removeListener("close", fin);
      const lever = (): void => rejeter(signal?.reason as Error);
      if (proc.exitCode !== null || proc.signalCode !== null) return lever();
      proc.once("exit", lever);
      proc.kill("SIGKILL");
    };
    proc.stdout?.on("data", (b: Buffer) => sortie.push(b));
    proc.stderr?.on("data", (b: Buffer) => erreur.push(b));
    proc.once("error", (e) => {
      clearTimeout(minuterie);
      signal?.removeEventListener("abort", annuler);
      rejeter(e);
    });
    function fin(code: number | null): void {
      clearTimeout(minuterie);
      signal?.removeEventListener("abort", annuler);
      resoudre({
        code,
        signal: proc.signalCode,
        sortie: Buffer.concat(sortie),
        erreur: Buffer.concat(erreur),
        delaiDepasse,
      });
    }
    proc.once("close", fin);
    signal?.addEventListener("abort", annuler, { once: true });
    if (entree && proc.stdin) {
      proc.stdin.on("error", () => undefined);
      proc.stdin.end(entree);
    }
    if (delaiMs !== null) {
      minuterie = setTimeout(() => {
        delaiDepasse = true;
        proc.removeListener("close", fin);
        if (proc.exitCode !== null || proc.signalCode !== null) return fin(null);
        proc.once("exit", () => fin(null));
        proc.kill("SIGKILL");
      }, delaiMs);
    }
  });
}
