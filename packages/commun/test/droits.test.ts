// SPDX-License-Identifier: MIT
/** packages/commun/test/droits.test.ts — droits de l'état partagé : modes privés en compte unique, modes du groupe des données sous `ELPIS_GROUPE_DONNEES`, dossier sûr (à ce compte, ou à ce groupe sans droit pour les autres). */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bitsInterdits, dossierDeConfiance, gidGroupeCle, groupeDonnees, modePartage } from "../src/droits";

const UID = process.geteuid?.() ?? 0;
const GID = process.getgid?.() ?? 0;

/** Nom du groupe principal de ce compte dans `/etc/group`, `null` s'il n'y est pas. */
function nomGroupePrincipal(): string | null {
  for (const ligne of readFileSync("/etc/group", "utf8").split("\n")) {
    const [nom, , gid] = ligne.split(":");
    if (nom && gid === String(GID)) return nom;
  }
  return null;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("compte unique (ELPIS_GROUPE_DONNEES absente ou vide)", () => {
  it("modes et bits interdits d'aujourd'hui", () => {
    vi.stubEnv("ELPIS_GROUPE_DONNEES", " ");
    expect(groupeDonnees()).toBeNull();
    expect([modePartage(0o600), modePartage(0o700), modePartage(0o640), modePartage(0o777)]).toEqual([
      0o600, 0o700, 0o640, 0o777,
    ]);
    expect(modePartage(0o600, true)).toBe(0o600);
    expect(bitsInterdits()).toBe(0o077);
  });

  it("dossier sûr : à ce compte et fermé au groupe comme aux autres", () => {
    vi.stubEnv("ELPIS_GROUPE_DONNEES", "");
    expect(dossierDeConfiance({ uid: UID, gid: GID, mode: 0o40700 })).toBe(true);
    expect(dossierDeConfiance({ uid: UID, gid: GID, mode: 0o42770 })).toBe(false);
    expect(dossierDeConfiance({ uid: UID + 1, gid: GID, mode: 0o40700 })).toBe(false);
  });
});

describe("groupe des données", () => {
  it("le groupe reçoit les droits du propriétaire (lecture seule sur demande), les autres aucun", () => {
    vi.stubEnv("ELPIS_GROUPE_DONNEES", String(GID));
    expect(groupeDonnees()).toBe(String(GID));
    expect([modePartage(0o600), modePartage(0o700), modePartage(0o640), modePartage(0o777)]).toEqual([
      0o660, 0o770, 0o660, 0o770,
    ]);
    expect([modePartage(0o600, true), modePartage(0o700, true)]).toEqual([0o640, 0o750]);
    expect(bitsInterdits()).toBe(0o007);
  });

  it("dossier sûr : au groupe sans droit pour les autres, quel que soit son propriétaire", () => {
    vi.stubEnv("ELPIS_GROUPE_DONNEES", String(GID));
    expect(dossierDeConfiance({ uid: UID + 1, gid: GID, mode: 0o42770 })).toBe(true);
    expect(dossierDeConfiance({ uid: UID, gid: GID, mode: 0o40770 })).toBe(true);
    expect(dossierDeConfiance({ uid: UID + 1, gid: GID, mode: 0o42771 })).toBe(false);
    expect(dossierDeConfiance({ uid: UID, gid: GID + 1, mode: 0o40770 })).toBe(false);
    expect(dossierDeConfiance({ uid: UID, gid: GID + 1, mode: 0o40700 })).toBe(true);
  });

  it.skipIf(nomGroupePrincipal() === null)("nom du groupe résolu par /etc/group", () => {
    vi.stubEnv("ELPIS_GROUPE_DONNEES", nomGroupePrincipal() ?? "");
    expect(dossierDeConfiance({ uid: UID + 1, gid: GID, mode: 0o42770 })).toBe(true);
    expect(dossierDeConfiance({ uid: UID + 1, gid: GID + 1, mode: 0o42770 })).toBe(false);
  });

  it("nom inconnu de /etc/group : groupe principal du process", () => {
    vi.stubEnv("ELPIS_GROUPE_DONNEES", "groupe-absent-de-l-annuaire");
    expect(dossierDeConfiance({ uid: UID + 1, gid: GID, mode: 0o42770 })).toBe(true);
    expect(dossierDeConfiance({ uid: UID + 1, gid: GID + 1, mode: 0o42770 })).toBe(false);
  });
});

describe("groupe de clé (ELPIS_GROUPE_CLE)", () => {
  it("absent : aucun ; valeur numérique ou nom de /etc/group : son GID ; introuvable : aucun, jamais le groupe principal", () => {
    vi.stubEnv("ELPIS_GROUPE_CLE", "");
    expect(gidGroupeCle()).toBeNull();
    vi.stubEnv("ELPIS_GROUPE_CLE", String(GID));
    expect(gidGroupeCle()).toBe(GID);
    vi.stubEnv("ELPIS_GROUPE_CLE", "groupe-de-cle-absent-de-l-annuaire");
    expect(gidGroupeCle()).toBeNull();
    const nom = nomGroupePrincipal();
    if (nom !== null) {
      vi.stubEnv("ELPIS_GROUPE_CLE", nom);
      expect(gidGroupeCle()).toBe(GID);
    }
  });
});
