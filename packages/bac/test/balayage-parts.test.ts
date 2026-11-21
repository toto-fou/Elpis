// SPDX-License-Identifier: MIT
/** packages/bac/test/balayage-parts.test.ts — tmp d'envoi par morceaux abandonnés dans les bacs en marche de cette instance (docker simulé), balayés par l'hôte d'outils. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { balayerPartsOrphelines, RUN_SPEC } from "../src/index";

let dossier = "";

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-balayage-parts-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dossier, { recursive: true, force: true });
});

describe("balayerPartsOrphelines (docker simulé)", () => {
  function fauxDocker(corps: string): string {
    const bin = join(dossier, "bin");
    mkdirSync(bin);
    const script = join(bin, "docker");
    writeFileSync(script, `#!/bin/sh\necho "$@" >> "${join(dossier, "appels")}"\n${corps}\n`);
    chmodSync(script, 0o755);
    vi.stubEnv("PATH", bin);
    return join(dossier, "appels");
  }

  it("un find -delete par conteneur de sandbox en marche DE CETTE INSTANCE (/work sous ses bacs), lignes comptées, conteneur en échec ignoré, celui d'une autre instance jamais touché", async () => {
    const bacs = join(dossier, "bacs");
    const appels = fauxDocker(`case "$1" in
  ps) echo "elpis-sb-a elpis-sb-b"; echo elpis-sb-c; echo elpis-sb-autre ;;
  inspect) echo "/elpis-sb-a|${bacs}/a/work"; echo "/elpis-sb-b|${bacs}/b/work"; echo "/elpis-sb-c|${bacs}/c/work"
    echo "/elpis-sb-autre|/srv/autre-instance/bacs/a/work"; echo "/elpis-sb-x|${bacs}x/a/work" ;;
  exec) case "$8" in
    elpis-sb-a) echo /work/x.elpis-upload.part; echo; echo /work/d/y.elpis-upload.part ;;
    elpis-sb-b) exit 1 ;;
    *) echo /work/z.elpis-upload.part ;;
  esac ;;
esac`);
    expect(await balayerPartsOrphelines(undefined, bacs)).toBe(3);
    const lignes = readFileSync(appels, "utf8").trim().split("\n");
    expect(lignes[0]).toBe(
      `ps --filter label=elpis.user_id --filter label=elpis.spec=${RUN_SPEC} --format {{.Names}}`,
    );
    expect(lignes[1]).toMatch(/^inspect --format .* elpis-sb-a elpis-sb-b elpis-sb-c elpis-sb-autre$/u);
    expect(lignes[2]).toBe(
      "exec -u 0:0 -e PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin -w / elpis-sb-a find /work -xdev -type f -name *.elpis-upload.part -mmin +1440 -print -delete",
    );
    expect(lignes).toHaveLength(5);
    expect(lignes.some((l) => l.includes("elpis-sb-autre") && l.startsWith("exec"))).toBe(false);
  });

  it("âge en minutes d'au moins 1 ; sans dossier de bacs, inspection en échec, docker absent ou en panne : rien", async () => {
    const appels = fauxDocker(
      `case "$1" in ps) echo c ;; inspect) echo "/c|${join(dossier, "bacs")}/c/work" ;; esac`,
    );
    await balayerPartsOrphelines(30, join(dossier, "bacs"));
    expect(readFileSync(appels, "utf8")).toContain("-mmin +1 ");
    expect(await balayerPartsOrphelines(30, "")).toBe(0);
    vi.stubEnv("PATH", join(dossier, "vide"));
    expect(await balayerPartsOrphelines()).toBe(0);
  });
});
