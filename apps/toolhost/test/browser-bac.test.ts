// SPDX-License-Identifier: MIT
/** apps/toolhost/test/browser-bac.test.ts — navigateur du bac côté hôte d'outils : certificat de l'autorité posé dans le dossier où le bac écrit sans jamais suivre de lien. */
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { poserCertificat } from "../src/mcp/browser/bac";

const dossier = mkdtempSync(path.join(tmpdir(), "nav-bac-"));
afterAll(() => rmSync(dossier, { recursive: true, force: true }));

describe("certificat de l'autorité dans /run/elpis du bac", () => {
  it("lien posé par le bac remplacé sans être suivi, FIFO sans blocage, rotation signalée, aucun temporaire laissé", () => {
    const hote = path.join(dossier, "config.json");
    writeFileSync(hote, "{}", { mode: 0o600 });
    const ca = path.join(dossier, "browser-ca.crt");
    symlinkSync(hote, ca);
    expect(poserCertificat(ca, "PEM-1")).toBe(false);
    expect(readFileSync(hote, "utf8")).toBe("{}");
    expect(statSync(hote).mode & 0o777).toBe(0o600);
    expect(lstatSync(ca).isFile()).toBe(true);
    expect(readFileSync(ca, "utf8")).toBe("PEM-1");
    expect(statSync(ca).mode & 0o777).toBe(0o644);
    expect(poserCertificat(ca, "PEM-1")).toBe(false);
    expect(poserCertificat(ca, "PEM-2")).toBe(true);
    rmSync(ca);
    execFileSync("mkfifo", [ca]);
    expect(poserCertificat(ca, "PEM-2")).toBe(false);
    expect(readFileSync(ca, "utf8")).toBe("PEM-2");
    expect(readdirSync(dossier).sort()).toEqual(["browser-ca.crt", "config.json"]);
  });
});
