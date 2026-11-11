// SPDX-License-Identifier: MIT
/** tests/frontend/reel/skills-reel-verify.mjs — skills du compte contre le core TS réel : parties Global et Perso, création par le formulaire, listée et relue après rechargement, détail, filtre, suppression confirmée */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/skills-reel-verify.mjs
import {
  demarrerCoreReel,
  lancerNavigateur,
  contexteConnecte,
  attendreMontage,
  verifications,
} from "../lib/core-reel.mjs";

const v = verifications("skills-reel");
const core = await demarrerCoreReel();
const nav = await lancerNavigateur();
try {
  const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  const erreurs = [];
  page.on("pageerror", (e) => erreurs.push(String(e.message || e)));
  const noms = async () => {
    const r = await ctx.request.get(core.urlMain + "/api/skills");
    return r.ok() ? (await r.json()).skills.map((s) => s.name) : [];
  };
  const region = () => page.locator('div[aria-label="Gestion des skills"]');
  const ouvrir = async () => {
    await page.locator('button[title="Paramètres"]:visible').first().click();
    await page.locator('aside button:has-text("Skills"):visible').first().click();
    await region().waitFor();
  };
  await page.goto(core.urlMain + "/");
  await attendreMontage(page);
  await ouvrir();
  v.ok("onglet Skills affiché", await region().isVisible());
  const partie = (id) => page.locator(`[data-sous-menu] [data-section="${id}"]`);
  const partieOuverte = async (id) => (await partie(id).getAttribute("aria-current")) === "page";
  v.ok(
    "bandeau des parties : Global, Perso",
    (await page.locator("[data-sous-menu] nav button").allInnerTexts()).join("|") === "Global|Perso",
  );
  v.ok("Global ouvert par défaut", await partieOuverte("global"));
  v.ok(
    "Global : la bibliothèque de l'instance est listée",
    await region()
      .locator('[role="tree"]')
      .first()
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false),
  );
  await partie("perso").click();
  v.ok(
    "Perso vide : l'état qui explique comment commencer",
    await region()
      .getByText("Aucun skill personnel pour l'instant")
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false),
  );
  await partie("global").click();

  await region().locator('button:has-text("Nouveau")').first().click();
  await region().locator('input[placeholder="deploy-staging"]').fill("reel-skill");
  await region()
    .locator('input[placeholder^="Quand et comment"]')
    .fill("Skill de parcours réel : déployer en préproduction.");
  await region().locator("textarea").fill("# Procédure\n1. Construire\n2. Déployer");
  const creation = page.waitForResponse(
    (r) => r.url().includes("/api/skills") && r.request().method() === "POST",
  );
  await region().locator('button:has-text("Créer")').first().click();
  const rc = await creation;
  v.ok("création acceptée", rc.ok(), String(rc.status()));
  v.ok("skill présent côté serveur", (await noms()).includes("reel-skill"));
  await page.locator("[data-sous-menu]").waitFor({ timeout: 5000 }).catch(() => {});
  v.ok("créé depuis Global : Perso s'ouvre, où le skill se trouve", await partieOuverte("perso"));
  // La liste est relue du core après la création (seconde requête) : attendre la ligne avant de juger.
  await region().getByText("reel-skill", { exact: true }).first().waitFor({ timeout: 5000 }).catch(() => {});
  v.ok(
    "skill listé dans l'arbre",
    await region().getByText("reel-skill", { exact: true }).first().isVisible(),
  );

  await page.reload();
  await attendreMontage(page);
  await ouvrir();
  await partie("perso").click();
  // La liste arrive après l'ouverture de l'onglet (requête) : attendre la ligne avant de juger.
  await region().getByText("reel-skill", { exact: true }).first().waitFor({ timeout: 5000 }).catch(() => {});
  v.ok(
    "skill relu après rechargement",
    await region().getByText("reel-skill", { exact: true }).first().isVisible(),
  );
  await region().locator('input[placeholder="Filtrer les skills…"]').fill("introuvable-xyz");
  v.ok(
    "filtre : aucun résultat masque le skill",
    !(await region()
      .getByText("reel-skill", { exact: true })
      .first()
      .isVisible()
      .catch(() => false)),
  );
  await region().locator('button[aria-label="Effacer le filtre"]').click();

  // Filtre depuis Global : le skill est signalé dans l'autre partie, et un clic y mène.
  await partie("global").click();
  await region().locator('input[placeholder="Filtrer les skills…"]').fill("reel-skill");
  const versPerso = region().locator("[data-skills-autre-partie]");
  v.ok(
    "filtre : le résultat de l'autre partie est signalé",
    /1 résultat\s+dans\s+Perso/.test(
      await versPerso
        .innerText({ timeout: 5000 })
        .catch(() => ""),
    ),
  );
  await versPerso.click();
  v.ok("filtre : le clic ouvre Perso", await partieOuverte("perso"));
  await region().locator('button[aria-label="Effacer le filtre"]').click();

  await region().getByText("reel-skill", { exact: true }).first().click();
  await region().locator('button[aria-label="Retour à la liste des skills"]').waitFor();
  v.ok("détail plein cadre : bandeau masqué", (await page.locator("[data-sous-menu]").count()) === 0);
  v.ok(
    "détail : corps affiché",
    await region()
      .getByText("Construire")
      .first()
      .waitFor({ timeout: 8000 })
      .then(() => true)
      .catch(() => false),
  );
  await region().locator('button:has-text("Supprimer")').first().click();
  await page.locator("div.fixed.inset-0 button.bg-red-500").click();
  await page.waitForTimeout(800);
  v.ok("skill supprimé côté serveur", !(await noms()).includes("reel-skill"));
  v.ok("aucune erreur JS", erreurs.length === 0, erreurs.join(" | "));
} finally {
  await nav.close();
  await core.arreter();
}
process.exit(v.bilan());
