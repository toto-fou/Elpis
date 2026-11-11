// SPDX-License-Identifier: MIT
/** apps/toolhost/test/browser-bac.test.ts — navigateur du bac côté hôte d'outils : certificat de l'autorité posé dans le dossier où le bac écrit sans jamais suivre de lien ; relais d'un compte inactif rendu ; autorité renouvelée avant son terme. */
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

import { chargerAutorite, RelaisNavigateur, reglagesAutorite } from "@elpis/navigateur";

import {
  arreterNavigateursBac,
  balayerNavigateursBac,
  dureeLiaisonMs,
  poserCertificat,
  poserRelaisPourTests,
  reglagesNavigateurBac,
  relaisDe,
} from "../src/mcp/browser/bac";

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

describe("relais d'un compte inactif et autorité", () => {
  it("relais rendu (liaisons oubliées, socket fermé) une fois le service arrêté pour inactivité, pas avant", async () => {
    const ac = chargerAutorite(path.join(dossier, "ca"));
    const relais = new RelaisNavigateur({
      socket: path.join(dossier, "relais.sock"),
      jeton: "j",
      juger: async () => ({ ok: false, motif: "non" }),
      autorite: ac,
    });
    await relais.ouvrir();
    try {
      relais.lier({
        id: "l",
        nom: "s",
        kind: "http-auth",
        origines: ["https://a.example"],
        tls: "strict",
        substitut: null,
        resoudre: async () => null,
      });
      const t = Date.now();
      poserRelaisPourTests("inactif", relais, t);
      const terme = t + dureeLiaisonMs() + reglagesNavigateurBac.margeInactiviteMs;
      expect(await balayerNavigateursBac(terme - 1)).toEqual([]);
      expect(relaisDe("inactif")).toBe(relais);
      expect(await balayerNavigateursBac(terme + 1)).toEqual(["inactif"]);
      expect(relaisDe("inactif")).toBeNull();
      expect(relais.ids()).toEqual([]);
      expect(relais.ecoute()).toBe(false);
    } finally {
      await arreterNavigateursBac();
    }
  });

  it("autorité d'un an au plus, renouvelée quand il lui reste moins de 30 jours", () => {
    const d = path.join(dossier, "ca-terme");
    const a = chargerAutorite(d);
    expect(a.echeance - Date.now()).toBeLessThanOrEqual(reglagesAutorite.jours * 86400_000);
    expect(chargerAutorite(d).empreinte).toBe(a.empreinte);
    const b = chargerAutorite(d, a.echeance - 29 * 86400_000);
    expect(b.empreinte).not.toBe(a.empreinte);
    expect(statSync(path.join(d, "ca.key")).mode & 0o777).toBe(0o600);
    expect(readdirSync(d).sort()).toEqual(["ca.crt", "ca.key"]);
  });
});
