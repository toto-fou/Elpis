// SPDX-License-Identifier: MIT
/** tools/verifier_motifs_secrets.mjs — parité des motifs de secrets : browser-service/motifs_secrets.js (livré à part) et packages/contracts/src/motifs-secrets.ts doivent porter les mêmes données ; échantillon de termes reconnus. */
import assert from "node:assert/strict";

import * as recorder from "../browser-service/motifs_secrets.js";
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

const norm = (t) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
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
])
  assert.ok(cles.test(t), `clé de requête non reconnue : ${t}`);
assert.ok(!cles.test("author") && !champs.test(norm("Montant")), "faux positif");
console.log("motifs de secrets : parité vérifiée");
