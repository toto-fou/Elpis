// SPDX-License-Identifier: MIT
/** tools/verifier_motifs_secrets.mjs — parité des motifs de secrets : browser-service/motifs_secrets.js (livré à part) et packages/contracts/src/motifs-secrets.ts doivent porter les mêmes données ; échantillon de termes reconnus. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as recorder from "../browser-service/motifs_secrets.js";
import { masquerUrl, variableSecrete } from "../browser-service/recorder_util.js";
import * as contrats from "../packages/contracts/src/motifs-secrets.ts";

assert.deepEqual(
  contrats.CHAMPS_SECRETS,
  recorder.CHAMPS_SECRETS,
  "CHAMPS_SECRETS diffère entre browser-service et contracts",
);
assert.equal(
  contrats.CLES_URL_SECRETES,
  recorder.CLES_URL_SECRETES,
  "CLES_URL_SECRETES diffère entre browser-service et contracts",
);

// Même découpage du camelCase des deux côtés (recorder et apprentissage) avant la mise en minuscules.
const DECOUPAGE = "([a-z])([A-Z])|([A-Z])([A-Z][a-z])";
for (const f of ["../browser-service/recorder_util.js", "../packages/contracts/src/apprentissage.ts"])
  assert.ok(
    readFileSync(new URL(f, import.meta.url), "utf8").includes(DECOUPAGE),
    `découpage camelCase absent de ${f}`,
  );
const norm = (t) =>
  t.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(new RegExp(DECOUPAGE, "g"), "$1$3 $2$4").toLowerCase();
const champs = new RegExp(contrats.CHAMPS_SECRETS.map(([, s]) => s).join("|"), "u");
for (const t of [
  "Code de vérification",
  "Code reçu par SMS",
  "One-time code",
  "one_time_code",
  "Card code",
  "Security code",
  "Réponse secrète",
  "MDP",
  "Code confidentiel",
  "Numéro de carte",
  "IBAN",
  "CVC",
  "CVV",
  "Code PIN",
  "Mot de passe",
  "Clé API",
  "api key",
  "jeton",
  "totpCode",
  "myTotpCode",
  "mytotpcode",
  "otpCode",
  "twoFactorCode",
  "two-factor",
  "APIKey",
])
  assert.ok(champs.test(norm(t)), `champ secret non reconnu : ${t}`);
const cles = new RegExp(contrats.CLES_URL_SECRETES, "u");
for (const t of [
  "authorization",
  "auth",
  "state",
  "nonce",
  "hash",
  "magic",
  "reset",
  "sig",
  "signature",
  "jwt",
  "sid",
  "session",
  "h",
])
  assert.ok(cles.test(t), `clé de requête non reconnue : ${t}`);
assert.ok(!cles.test("author") && !champs.test(norm("Montant")), "faux positif");
for (const t of ["totpCode", "myTotpCode", "otpCode", "twoFactorCode"])
  assert.equal(variableSecrete({ name: t }), "OTP", `recorder : ${t} non reconnu`);
assert.equal(
  masquerUrl("https://x.test/a?h=abc&n=1"),
  "https://x.test/a?h=***&n=1",
  "recorder : ?h= non masqué",
);
console.log("motifs de secrets : parité vérifiée");
