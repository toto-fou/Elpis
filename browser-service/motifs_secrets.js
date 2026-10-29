// SPDX-License-Identifier: MIT
/** browser-service/motifs_secrets.js — motifs des champs et des clés de requête secrets du recorder ; copie identique de packages/contracts/src/motifs-secrets.ts (parité vérifiée par `npm run typecheck`). */
// Motifs appliqués à un texte NORMALISÉ (minuscules, sans accents). Source unique des données ; deux copies identiques,
// vérifiées par `npm run typecheck` (tools/verifier_motifs_secrets.mjs) : browser-service est livré à part et ne peut pas importer le paquet.

/** Champs secrets : [variable d'environnement du recorder, motif]. */
export const CHAMPS_SECRETS = [
  [
    "PASSWORD",
    "pass(?:word|wd|phrase|code)?(?![a-z])|passw|pwd|(?<![a-z])mdp(?![a-z])|mot.?de.?passe|kennwort|contrase|reponse.?secrete",
  ],
  [
    "OTP",
    "(?<![a-z])otp(?![a-z])|totp|one.?time|2fa|mfa|two.?factor|(?:verif|confirm|secur|confidenti|recu|sms)\\w*\\W*code|code\\W*(?:de\\W+)?(?:verif|confirm|secur|confidenti|recu|sms)",
  ],
  ["API_KEY", "api.?key|cle.?api"],
  ["TOKEN", "token|jeton"],
  ["SECRET", "secret"],
  ["PIN", "(?<![a-z])pin(?![a-z])|pin.?code"],
  ["CARD_CVC", "(?<![a-z])(?:cvc|cvv)(?![a-z])|security.?code|card.?code|cryptogramme"],
  ["CARD", "numero.?de.?carte|card.?number|carte.?(?:bancaire|bleue)"],
  ["IBAN", "(?<![a-z])(?:iban|bic|rib)(?![a-z])"],
];

/** Clés de requête ou de fragment dont la valeur est sensible (en plus des champs secrets). */
export const CLES_URL_SECRETES =
  "authori[sz]|auth(?!or)|(?<![a-z])(?:code|key|sig|sid|jwt|otp|pin|hash|state|nonce|magic|reset|h)(?![a-z])|session|sessid|signature|credential|ticket|saml|magic|reset";
