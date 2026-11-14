// SPDX-License-Identifier: MIT
// Test d'intégration du service (vrai service construit, dist/main.mjs) : un état sauvegardé inconnu ou d'un autre compte répond 404 state_not_found avant tout lancement du navigateur.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demarrerService } from "./aides/service.ts";
import type { Service } from "./aides/service.ts";

const SERVICE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAUTER = ["express", "playwright"].every((m) => fs.existsSync(path.join(SERVICE, "node_modules", m)))
  ? false
  : "dépendances du service absentes (npm ci)";
const ID_ALICE = "5a5a5a5a-0000-1111-2222-333344445555";

// Champs des réponses lus par l'essai.
interface Corps {
  code: string;
  fix: string;
  browser_connected: boolean;
}

let svc!: Service<Corps>;
before(async () => {
  if (SAUTER) return;
  svc = await demarrerService<Corps>();
  fs.writeFileSync(
    path.join(svc.dossier, "cookies", `state_alice__${ID_ALICE}.json`),
    JSON.stringify({ cookies: [], origins: [] }),
  );
});
after(async () => {
  if (svc) await svc.arreter();
});

test(
  "/start : 404 state_not_found pour un état inconnu ou d’un autre compte, navigateur jamais lancé",
  { skip: SAUTER },
  async () => {
    for (const corps of [
      { owner: "alice", load_state_id: "inconnu-0000-1111" },
      { owner: "bob", load_state_id: ID_ALICE },
    ]) {
      const r = await svc.post("/start", { url: "about:blank", ...corps });
      assert.equal(r.statut, 404, r.texte);
      assert.equal(r.corps.code, "state_not_found");
      assert.ok(!r.corps.fix.includes("alice"), r.corps.fix);
    }
    assert.equal((await svc.get("/health")).corps.browser_connected, false);
  },
);
