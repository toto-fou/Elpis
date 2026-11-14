// SPDX-License-Identifier: MIT
// test/securite-enregistrement-identifiants.integration.test.ts — HAR et trace refusés pour une session liée à l'authentification HTTP du relais (ils garderaient sa clé) ; vidéo admise, liaison mal formée refusée.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { demarrerService, raisonDeSauter } from "./aides/service.ts";
import type { Service } from "./aides/service.ts";

const LIAISON = { key: "ab".repeat(16), origins: ["http://127.0.0.1:9"] };

// Champs des réponses lus par ces essais.
interface Corps {
  code: string;
  error: string;
  session_id: string;
  sessions?: unknown[];
}

let svc!: Service<Corps>;
let saut: string | false = false;
before(async () => {
  saut = await raisonDeSauter();
  if (!saut) svc = await demarrerService<Corps>();
});
after(async () => {
  if (svc) await svc.arreter();
});

test("record_har ou trace avec une liaison du relais : 400 recording_with_credentials, rien démarré", async (t) => {
  if (saut) return t.skip(saut);
  for (const option of ["record_har", "trace"]) {
    const r = await svc.post("/start", {
      owner: "essai",
      url: "about:blank",
      isolated: true,
      relay_binding: LIAISON,
      [option]: true,
    });
    assert.equal(r.statut, 400, `${option} : ${r.texte}`);
    assert.equal(r.corps.code, "recording_with_credentials");
    assert.match(r.corps.error, /^[\x20-\x7e]+$/, "message en anglais, ASCII");
  }
  for (const liaison of [
    { key: "court", origins: LIAISON.origins },
    { key: LIAISON.key, origins: [] },
    { key: LIAISON.key, origins: ["http://127.0.0.1:9/chemin"] },
    "x",
  ]) {
    const r = await svc.post("/start", {
      owner: "essai",
      url: "about:blank",
      isolated: true,
      relay_binding: liaison,
    });
    assert.equal(r.statut, 400, r.texte);
    assert.equal(r.corps.code, "invalid_option");
  }
  assert.equal((await svc.get("/sessions?owner=essai")).corps.sessions?.length ?? 0, 0);
});

test("record_video avec la liaison, ou HAR sans elle : démarrés", async (t) => {
  if (saut) return t.skip(saut);
  for (const corps of [{ record_video: true, relay_binding: LIAISON }, { record_har: true }]) {
    const r = await svc.post("/start", { owner: "essai", url: "about:blank", isolated: true, ...corps });
    assert.equal(r.statut, 200, r.texte);
    await svc.post("/stop", { owner: "essai", session_id: r.corps.session_id });
  }
});
