// SPDX-License-Identifier: MIT
/** apps/core/test/securite-ouverture-unique.test.ts — second filet textuel : seuls les fichiers prévus ouvrent, renouvellent ou construisent une session. */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const RACINE = join(__dirname, "..", "..", "..");
const AUTH = join("packages", "auth", "src") + "/";
const OUVERTURE = join("packages", "auth", "src", "ouverture.ts");
const SESSION = join("packages", "auth", "src", "session.ts");
const INDEX_AUTH = join("packages", "auth", "src", "index.ts");
const CONNEXION = join("apps", "core", "src", "comptes", "ouverture.ts");
const FAMILLE_COMPTES = join("apps", "core", "src", "familles", "comptes.ts");

function sources(dossier: string): string[] {
  return readdirSync(dossier, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === "dist" || e.name === "test") return [];
    const chemin = join(dossier, e.name);
    if (e.isDirectory()) return sources(chemin);
    return /\.(ts|mts|vue)$/u.test(e.name) ? [chemin] : [];
  });
}

const FICHIERS = [...sources(join(RACINE, "apps")), ...sources(join(RACINE, "packages"))].map((f) =>
  relative(RACINE, f),
);
const lire = (f: string): string => readFileSync(join(RACINE, f), "utf8");

/** Fichiers qui contiennent le motif, hors ceux dont le chemin est permis (préfixe ou égalité). */
function fautifs(motif: RegExp, permis: string[]): string[] {
  return FICHIERS.filter((f) => !permis.some((p) => f === p || (p.endsWith("/") && f.startsWith(p)))).filter(
    (f) => motif.test(lire(f)),
  );
}

const REGLES: { nom: string; motif: RegExp; permis: string[]; fautif: string; correct: string }[] = [
  {
    nom: "ouvrirSession (toute mention)",
    motif: /(?<!this\.|async\s)\bouvrirSession\b/u,
    permis: [OUVERTURE, CONNEXION, INDEX_AUTH, SESSION],
    fautif: "import { ouvrirSession as o } from '@elpis/auth'\nconst f = ouvrirSession; f?.(s)",
    correct: "const x = this.ouvrirSession(1); async ouvrirSession() {}",
  },
  {
    nom: "renouvelerSession (toute mention)",
    motif: /\brenouvelerSession\b/u,
    permis: [OUVERTURE, FAMILLE_COMPTES, INDEX_AUTH],
    fautif: "import { renouvelerSession as r } from '@elpis/auth'\nconst g = renouvelerSession",
    correct: "// rien",
  },
  {
    nom: "ECRIRE_IDENTITE (toute mention)",
    motif: /\bECRIRE_IDENTITE\b/u,
    permis: [OUVERTURE, SESSION],
    fautif: "import { ECRIRE_IDENTITE as E } from './session'\ns[ECRIRE_IDENTITE]('uid', 1)",
    correct: "const ECRIRE = 1;",
  },
  {
    nom: "new Session(",
    motif: /\bnew\s+Session\s*\(/u,
    permis: [AUTH],
    fautif: "const s = new  Session({ user_id: 1 })",
    correct: "new SessionHttp()",
  },
  {
    nom: "signerSession(",
    motif: /\bsignerSession\s*(\?\.)?\(/u,
    permis: [AUTH],
    fautif: "const s = signerSession?.({}, 'k', 1)",
    correct: "const signer = 1;",
  },
  {
    nom: "identiteToolhost =",
    motif: /\bidentiteToolhost\s*=[^=]/u,
    permis: [],
    fautif: "req.identiteToolhost = { userId: 1 }",
    correct: "if (req.identiteToolhost === undefined) {}",
  },
  {
    nom: ".utilisateur =",
    motif: /\.\s*utilisateur\s*=[^=]/u,
    permis: [AUTH],
    fautif: "const r = req; r.utilisateur = { id: 1 }",
    correct: "if (r.utilisateur === null) {}",
  },
];

describe("ouverture de session unique (garde textuelle)", () => {
  it.each(REGLES)("$nom n'apparaît que dans les fichiers prévus", (r) => {
    expect(fautifs(r.motif, r.permis)).toEqual([]);
  });

  it.each(REGLES)("le motif de $nom attrape une forme fautive et pas une forme saine", (r) => {
    expect(r.motif.test(r.fautif)).toBe(true);
    expect(r.motif.test(r.correct)).toBe(false);
  });

  it("aucun fichier hors ouverture.ts n'écrit une clé d'identité par session.set", () => {
    const motif = /\.\s*set\s*(\?\.)?\(\s*["'`](user_id|uid|user|_sid|_auth|_login_ts)["'`]/u;
    expect(fautifs(motif, [])).toEqual([]);
    expect(motif.test('session?.set("user_id", 1)')).toBe(true);
  });

  it("les fichiers autorisés existent et portent bien l'appel", () => {
    expect(lire(OUVERTURE)).toMatch(/export function ouvrirSession\(/u);
    expect(lire(CONNEXION)).toMatch(/\bouvrirSession\(/u);
    expect(lire(FAMILLE_COMPTES)).toMatch(/\brenouvelerSession\(/u);
    expect(lire(SESSION)).toMatch(/export const ECRIRE_IDENTITE/u);
  });
});
