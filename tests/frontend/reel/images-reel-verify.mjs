// SPDX-License-Identifier: MIT
/** tests/frontend/reel/images-reel-verify.mjs — galerie d'images contre le core TS réel : moteur déclaré prêt, images du compte posées en base, galerie ouverte depuis le composeur, suppression d'une image relue côté serveur */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/images-reel-verify.mjs
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  demarrerCoreReel,
  lancerNavigateur,
  contexteConnecte,
  attendreMontage,
  verifications,
} from "../lib/core-reel.mjs";
import { demarrerFauxImages } from "../lib/faux-images.mjs";

const v = verifications("images-reel");
const moteur = await demarrerFauxImages();
const core = await demarrerCoreReel({
  configSup: { image: { enabled: true, provider: "openai", url: moteur.url, model: "m" } },
});
const nav = await lancerNavigateur();
try {
  const base = new DatabaseSync(path.join(core.dossier, "racine/user_db/app.db"));
  const uid = base.prepare("SELECT id FROM users WHERE username=?").get(core.comptes.user.username).id;
  const ajout = base.prepare(
    "INSERT INTO generated_images(id,user_id,chat_id,prompt,params_json,model,mime,width,height,bytes,rel_path,thumb_rel_path,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const ids = ["a".repeat(32), "b".repeat(32), "c".repeat(32)];
  ids.forEach((id, i) =>
    ajout.run(
      id,
      uid,
      null,
      `Image ${i + 1}`,
      "{}",
      "m",
      "image/png",
      512,
      512,
      10,
      `${id}.png`,
      "",
      1700000000 + i,
    ),
  );
  base.close();
  const dossierImages = path.join(core.dossier, "racine/user_db/generated_images");
  fs.mkdirSync(dossierImages, { recursive: true });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  for (const id of ids) fs.writeFileSync(path.join(dossierImages, `${id}.png`), png);
  const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  const erreurs = [];
  page.on("pageerror", (e) => erreurs.push(String(e.message || e)));
  const total = async () => {
    const r = await ctx.request.get(core.urlMain + "/api/images");
    return r.ok() ? (await r.json()).total : -1;
  };
  await page.goto(core.urlMain + "/");
  await attendreMontage(page);
  v.ok("galerie serveur : 3 images", (await total()) === 3);
  // Le mode Images s'ouvre par Alt+I (ou « /image »), plus depuis le « + ».
  await page.locator("#app textarea").first().focus();
  await page.keyboard.press("Alt+i");
  await page.locator("[data-image-bar]").waitFor({ state: "visible" });
  v.ok("barre du mode Images affichée", await page.locator("[data-image-bar]").isVisible());
  await page.locator("[data-image-gallery-open]").click();
  const cellules = page.locator("[data-image-gallery] .elpis-img-gallery__cell");
  await cellules.first().waitFor({ state: "visible" });
  v.ok(
    "galerie ouverte (dialogue modal)",
    (await page.locator('[data-image-gallery][role="dialog"][aria-modal="true"]').count()) === 1,
  );
  v.ok("trois cellules listées", (await cellules.count()) === 3);
  await cellules.nth(1).hover();
  const suppr = page.waitForResponse(
    (r) => /\/api\/images\/[a-f0-9]{32}$/.test(r.url()) && r.request().method() === "DELETE",
    { timeout: 20000 },
  );
  suppr.catch(() => null);
  await cellules.nth(1).locator('button[aria-label="Supprimer l’image"]').click();
  const rs = await suppr;
  v.ok("DELETE /api/images/:id accepté", rs.ok(), String(rs.status()));
  v.ok(
    "cadre « Supprimée » affiché",
    (await page.locator('[data-image-gallery] .elpis-img-frame:has-text("Supprimée")').count()) === 1,
  );
  v.ok("image retirée côté serveur", (await total()) === 2);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  v.ok("Échap ferme la galerie", (await page.locator("[data-image-gallery]").count()) === 0);
  // Génération : tuile de progression pendant le calcul, puis grille des résultats, rendues dans le DOM.
  await page.evaluate(() => window.__racine().startNewChat());
  // Le mode Images s'ouvre par Alt+I (ou « /image »), plus depuis le « + ».
  await page.locator("#app textarea").first().focus();
  await page.keyboard.press("Alt+i");
  await page.locator("[data-image-bar]").waitFor({ state: "visible" });
  const liberer = moteur.retenir();
  await page.locator("#app textarea").first().fill("Un phare sous l’orage");
  await page.locator("[data-image-send]").click();
  await page.locator("[data-image-progress]").first().waitFor({ state: "visible", timeout: 20000 }).catch(() => null);
  v.ok(
    "génération en cours : tuile de progression rendue (cellule visible)",
    (await page.locator("[data-image-progress] .elpis-img-tile").count()) >= 1 && (await page.locator("[data-image-progress] .elpis-img-tile").first().isVisible()),
  );
  for (let i = 0; i < 100 && !moteur.etat.appels.length; i++) await new Promise((r) => setTimeout(r, 100));
  v.ok("génération en cours : le moteur a reçu la demande", moteur.etat.appels.length === 1 && /phare/.test(moteur.etat.appels[0].prompt || ""));
  liberer();
  await page.locator("[data-image-grid] .elpis-img-cell").first().waitFor({ state: "visible", timeout: 20000 }).catch(() => null);
  v.ok(
    "génération finie : grille de résultats rendue avec son image",
    (await page.locator("[data-image-grid] .elpis-img-cell img").count()) >= 1 && (await page.locator("[data-image-progress]").count()) === 0,
  );
  v.ok("aucune erreur JS", erreurs.length === 0, erreurs.join(" | "));
} finally {
  await nav.close();
  await core.arreter();
  await moteur.arreter();
}
process.exit(v.bilan());
