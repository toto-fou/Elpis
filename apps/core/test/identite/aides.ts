// SPDX-License-Identifier: MIT
/** apps/core/test/identite/aides.ts — fournisseurs d'exemple, config.json jetable et clé du coffre pour les tests de la connexion d'entreprise. */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { configurerCoffre } from "@elpis/securite";

import { defautsFournisseur } from "../../src/identite/reglages";

/** Fournisseur LDAP complet et valide, éteint, sans groupe requis ; `extra` écrase ses champs. */
export function ldapValide(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...defautsFournisseur("ldap"),
    id: "annuaire",
    label: "Annuaire",
    urls: ["ldaps://ldap.exemple.lan"],
    bind_dn: "uid=svc,cn=users,dc=exemple,dc=lan",
    user_base_dn: "cn=users,dc=exemple,dc=lan",
    user_filter: "(uid={username})",
    ...extra,
  };
}

/** Fournisseur OIDC complet et valide, éteint, sans groupe requis. */
export function oidcValide(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...defautsFournisseur("oidc"),
    id: "sso",
    label: "SSO",
    issuer: "https://idp.exemple.lan/realms/elpis",
    client_id: "elpis",
    ...extra,
  };
}

export interface ConfigDeTest {
  readonly chemin: string;
  /** Réécrit config.json avec ces clés racine (`null` : fichier absent) et relit la configuration. */
  ecrire(contenu: Record<string, unknown> | null): void;
  fermer(): void;
}

/** config.json jetable comme fichier de la configuration ; `https` : toute écriture d'une section `auth` met aussi HTTPS en service (sauf si `security` est donné). */
export function configDeTest(o: { https?: boolean } = {}): ConfigDeTest {
  const dossier = mkdtempSync(join(tmpdir(), "elpis-auth-config-"));
  const chemin = join(dossier, "config.json");
  const restaurer = surchargerConfig({ CONFIG_JSON_PATH: chemin });
  invalidateConfigCache();
  return {
    chemin,
    ecrire(contenu) {
      if (contenu === null) rmSync(chemin, { force: true });
      else {
        const https = o.https === true && "auth" in contenu && !("security" in contenu);
        writeFileSync(
          chemin,
          JSON.stringify(https ? { ...contenu, security: { https: { enabled: true } } } : contenu),
        );
      }
      invalidateConfigCache();
    },
    fermer() {
      restaurer();
      invalidateConfigCache();
      rmSync(dossier, { recursive: true, force: true });
    },
  };
}

/** Clé du coffre des essais (jamais /etc/elpis ni de repli créé). */
export function cleCoffreDeTest(): void {
  configurerCoffre({
    cleEnv: randomBytes(32).toString("base64"),
    systeme: "/nonexistent/elpis-vault.key",
    repli: "/nonexistent/elpis/.vault.key",
  });
}

/** Autorité de certification d'essai (certificat X.509 auto-signé, sans clé privée). */
export const CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBgjCCASegAwIBAgIURW25Vc/vJk27CUSqZ4dg8o7j1RMwCgYIKoZIzj0EAwIw
FTETMBEGA1UEAwwKZWxwaXMtdGVzdDAgFw0yNjExMTgyMjU3NDhaGA8yMTI2MTAy
NTIyNTc0OFowFTETMBEGA1UEAwwKZWxwaXMtdGVzdDBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABNvNnotdJmrDyd1U1vFhyk3LIxZcalq/BW5iSQeDFNRKHQbGt7xJ
zuOinIApogPdVwEakEpPyEYZrLJsIN/kVOSjUzBRMB0GA1UdDgQWBBSS3mqWzTdN
TKuirfcu1KJNMmmeVzAfBgNVHSMEGDAWgBSS3mqWzTdNTKuirfcu1KJNMmmeVzAP
BgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kAMEYCIQCvutwaxYneLItPZLtz
Rs6XQGw4hmoM6X8IyvWHZ341sAIhAJ2dpu4CTa2756be+rBVQvsokGDk0WzA8/Tn
1KIuGbCm
-----END CERTIFICATE-----
`;
