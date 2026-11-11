// SPDX-License-Identifier: MIT
/** tests/frontend/reel/reglages-reel-verify.mjs — réglages du compte contre le core TS réel : ouverture de la modale, onglet par le rail en groupes, groupe d'affichage du fil, seuil de compaction enregistré à l'instant, relu après rechargement */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/reglages-reel-verify.mjs
import {
  demarrerCoreReel,
  lancerNavigateur,
  contexteConnecte,
  attendreMontage,
  verifications,
} from "../lib/core-reel.mjs";

const v = verifications("reglages-reel");
const core = await demarrerCoreReel();
const nav = await lancerNavigateur();
try {
  const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
  const page = await ctx.newPage();
  const erreurs = [];
  page.on("pageerror", (e) => erreurs.push(String(e.message || e)));
  await page.goto(core.urlMain + "/");
  await attendreMontage(page);
  await page.locator('button[title="Paramètres"]:visible').first().click();
  const dialogue = page.locator('[role="dialog"][aria-label="Paramètres"]');
  // Rail en groupes : « Compaction » est dans « Avancé », replié tant qu'aucune de ses sections n'est ouverte.
  const rail = dialogue.getByRole("navigation", { name: "Sections des paramètres" });
  const ouvrirCompaction = async () => {
    const avance = rail.getByRole("button", { name: /^Avancé/ });
    if ((await avance.getAttribute("aria-expanded")) === "false") await avance.click();
    await rail.getByRole("button", { name: "Compaction", exact: true }).click();
  };
  await dialogue.waitFor({ timeout: 10000 }).catch(() => {});
  v.ok("modale Paramètres ouverte", await dialogue.isVisible());
  await ouvrirCompaction();
  const interrupteur = dialogue.locator('label:has-text("Compaction automatique") input[type="checkbox"]');
  await interrupteur.waitFor({ state: "attached", timeout: 10000 });
  if (!(await interrupteur.isChecked())) await interrupteur.locator("xpath=ancestor::label").click();
  await page.waitForFunction(
    () => document.querySelector("label input[type=checkbox].sr-only.peer:checked") !== null,
    null,
    { timeout: 10000 },
  );
  const unite = page.locator("#set-compact-unit");
  await unite.waitFor({ timeout: 10000 }).catch(() => {});
  v.ok("onglet Compaction affiché", await unite.isVisible());
  const reponse = page
    .waitForResponse(
      (r) =>
        r.url().endsWith("/api/settings") &&
        r.request().method() === "PUT" &&
        (r.request().postData() || "").includes("compression_threshold_pct"),
      { timeout: 10000 },
    )
    .catch(() => null);
  await unite.selectOption("pct");
  const r = await reponse;
  v.ok("PUT /api/settings accepté à l'instant", !!r && r.ok(), r ? String(r.status()) : "aucune requête");
  const corps = r ? JSON.parse(r.request().postData() || "{}") : {};
  v.ok(
    "le couple de seuils part ensemble",
    corps.compression_threshold_pct === 70 && corps.compression_threshold_tokens === 0,
    JSON.stringify(corps),
  );
  await page.reload();
  await attendreMontage(page);
  await page.locator('button[title="Paramètres"]:visible').first().click();
  await ouvrirCompaction();
  const seuilRelu = () =>
    page
      .waitForFunction(() => document.querySelector("#set-compact-unit")?.value === "pct", null, {
        timeout: 10000,
      })
      .then(() => true)
      .catch(() => false);
  v.ok("seuil relu après rechargement", await seuilRelu());

  // Plus d'interface classique : le groupe « Affichage » de l'onglet Chat est là, l'interrupteur n'existe plus.
  await rail.getByRole("button", { name: "Chat", exact: true }).click();
  await dialogue.locator('[data-section="affichage"]').click();
  const affichage = dialogue.locator("[data-affichage-chat]");
  await affichage.waitFor({ timeout: 10000 }).catch(() => {});
  v.ok("onglet Chat : groupe d'affichage du fil présent", (await affichage.count()) === 1);
  await rail.getByRole("button", { name: "Apparence", exact: true }).click();
  await dialogue.locator("#set-skin").waitFor({ timeout: 10000 }).catch(() => {});
  v.ok(
    "onglet Apparence : plus d'interrupteur « Interface classique »",
    (await dialogue.locator("[data-interface-classique]").count()) === 0 &&
      (await dialogue.getByText("Interface classique").count()) === 0,
  );
  v.ok("aucune erreur JS", erreurs.length === 0, erreurs.join(" | "));
} finally {
  await nav.close();
  await core.arreter();
}
process.exit(v.bilan());
