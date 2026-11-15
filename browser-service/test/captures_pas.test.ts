// SPDX-License-Identifier: MIT
// test/captures_pas.test.ts — pas d'un appel : réservé une fois, jamais partagé par deux appels qui se chevauchent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nomCaptureExplicite, pasDeLAppel } from "../src/captures.ts";

type Appel = Parameters<typeof nomCaptureExplicite>[0];
const appel = (session: object): Appel => ({ session, sessionId: "sid" }) as Appel;

test("le pas d'un appel est réservé à sa première demande et ne change plus", () => {
  const session = { screenshotCounter: 4 };
  const a = appel(session);
  assert.equal(pasDeLAppel(a), 5);
  assert.equal(pasDeLAppel(a), 5);
  assert.equal(nomCaptureExplicite(a), "shot_sid_5.png");
  assert.equal(session.screenshotCounter, 5);
});

test("deux appels en cours sur la même session n'ont ni le même pas ni le même fichier", () => {
  const session = {};
  const lent = appel(session);
  const suivant = appel(session);
  // L'appel lent a nommé sa capture et n'a pas encore répondu quand le suivant nomme la sienne.
  assert.equal(nomCaptureExplicite(lent), "shot_sid_1.png");
  assert.equal(nomCaptureExplicite(suivant), "shot_sid_2.png");
  assert.equal(pasDeLAppel(lent), 1);
});
