// SPDX-License-Identifier: MIT
/** tests/frontend/reel/routines-reel-verify.mjs — routines contre le core TS réel : création par le formulaire, relue après rechargement, pause et reprise, renommage, suppression confirmée */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/routines-reel-verify.mjs
import {
  demarrerCoreReel,
  lancerNavigateur,
  contexteConnecte,
  attendreMontage,
  verifications,
} from "../lib/core-reel.mjs";

const v = verifications("routines-reel");
const core = await demarrerCoreReel();
const nav = await lancerNavigateur();
try {
  const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  const erreurs = [];
  page.on("pageerror", (e) => erreurs.push(String(e.message || e)));
  const liste = async () => {
    const r = await ctx.request.get(core.urlMain + "/api/routines");
    return r.ok() ? (await r.json()).items : [];
  };
  const racine = () => page.locator(".elpis-routines-page");
  const ouvrir = async () => {
    await page.locator('button[title="Routines"]:visible').first().click();
    await racine().waitFor();
  };
  await page.goto(core.urlMain + "/");
  await attendreMontage(page);
  await ouvrir();
  v.ok("page routines ouverte, liste vide", (await racine().isVisible()) && (await liste()).length === 0);

  await racine().locator('button:has-text("Nouvelle")').first().click();
  await racine().locator('input[placeholder="Veille quotidienne"]').fill("Veille réelle");
  await racine().locator('[data-routine-tabs] button:has-text("Tâche")').click();
  await racine().locator('textarea[placeholder^="Liste les fichiers"]').fill("Résume les fichiers modifiés.");
  const creation = page.waitForResponse(
    (r) => r.url().endsWith("/api/routines") && r.request().method() === "POST",
  );
  await racine().locator('button:has-text("Créer")').first().click();
  const rc = await creation;
  v.ok("POST /api/routines accepté", rc.ok(), String(rc.status()));
  const apres = await liste();
  v.ok(
    "routine créée côté serveur",
    apres.length === 1 && apres[0].name === "Veille réelle" && apres[0].enabled === true,
  );
  v.ok(
    "routine listée dans la page",
    await racine().locator('button:has-text("Veille réelle")').first().isVisible(),
  );

  await page.reload();
  await attendreMontage(page);
  await ouvrir();
  // La liste arrive après l'ouverture de la page (requête) : attendre la ligne avant de juger.
  await racine().locator('button:has-text("Veille réelle")').first().waitFor({ timeout: 5000 }).catch(() => {});
  v.ok(
    "routine relue après rechargement",
    await racine().locator('button:has-text("Veille réelle")').first().isVisible(),
  );

  await racine().locator('button:has-text("Veille réelle")').first().click();
  await racine().locator('button:has-text("Configurer")').first().click();
  await racine().locator('input[placeholder="Veille quotidienne"]').fill("Veille renommée");
  const maj = page.waitForResponse(
    (r) => /\/api\/routines\/\d+$/.test(r.url()) && r.request().method() === "PUT",
  );
  await racine().locator('button:has-text("Enregistrer")').first().click();
  const rm = await maj;
  v.ok("PUT /api/routines/:id accepté", rm.ok(), String(rm.status()));
  v.ok("nom mis à jour côté serveur", (await liste())[0]?.name === "Veille renommée");

  const id = (await liste())[0].id;
  const pause = await ctx.request.post(core.urlMain + `/api/routines/${id}/disable`);
  v.ok("pause acceptée", pause.ok());
  await page.reload();
  await attendreMontage(page);
  await ouvrir();
  await racine().locator('button:has-text("Veille renommée")').first().click();
  v.ok(
    "routine en pause : exécution désactivée",
    await racine().locator('button:has-text("Exécuter")').first().isDisabled(),
  );
  await ctx.request.post(core.urlMain + `/api/routines/${id}/enable`);

  await racine().locator('button:has-text("Configurer")').first().click();
  await racine().locator('button:has-text("Supprimer")').first().click();
  await page.locator('div.fixed.inset-0 button:has-text("Supprimer")').click();
  await page.waitForTimeout(800);
  v.ok("routine supprimée côté serveur", (await liste()).length === 0);
  v.ok("aucune erreur JS", erreurs.length === 0, erreurs.join(" | "));
} finally {
  await nav.close();
  await core.arreter();
}
process.exit(v.bilan());
