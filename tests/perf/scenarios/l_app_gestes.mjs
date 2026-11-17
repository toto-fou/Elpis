// SPDX-License-Identifier: MIT
/** tests/perf/scenarios/l_app_gestes.mjs — catalogue des gestes du banc de fluidité de l'application : sélecteur réel, préparation, entrée, prédicats de la réponse visible et de l'état final (évalués dans la page après la peinture) */
// Geste : { nom, groupe, selecteur, mode, entrees, prep, faire, vis, fin, arg, jalons, parImage, apres, delai, nonMesure } ;
// les prédicats sont sérialisés dans la page et n'y voient que window.__racine() et window.__ab.arg.
import {
  MARQUE_LONGUE_DEBUT,
  MARQUE_LONGUE_FIN,
  TITRE_LONGUE,
  titreCourte,
} from "../fixtures/app_fluidity_data.mjs";

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const suiteVisible = () => window.__ab.tIn > 0;
const visible = (page, sel) =>
  page
    .locator(sel)
    .first()
    .isVisible()
    .catch(() => false);
const racine = (page, f, a) => page.evaluate(f, a);

/** Prédicat « l'élément est affiché » pour un sélecteur passé en argument. */
const selAffiche = () => {
  const e = document.querySelector(window.__ab.arg);
  return !!e && e.getClientRects().length > 0;
};
const selAbsent = () => {
  const e = document.querySelector(window.__ab.arg);
  return !e || e.getClientRects().length === 0;
};
/** Prédicat « la fermeture se voit » : élément absent, ou lui, son parent ou son premier enfant en fondu (opacité < 0,95). */
const enFermeture = () => {
  const e = document.querySelector(window.__ab.arg);
  if (!e || !e.getClientRects().length) return true;
  for (const x of [e, e.parentElement, e.firstElementChild])
    if (x && parseFloat(getComputedStyle(x).opacity) < 0.95) return true;
  return false;
};
const sansChargement = () =>
  !document.querySelector('.adm-skeleton, [aria-busy="true"], .animate-spin:not(.elpis-stream-caret)');

// ── Aides de préparation (non mesurées) ──

/** Ferme menus, fenêtres et panneaux ouverts (Échap puis drapeaux de la racine). */
async function fermerTout(h) {
  const { page } = h;
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press("Escape").catch(() => {});
    await pause(60);
  }
  await racine(page, () => {
    const r = window.__racine();
    if (!r) return;
    for (const k of [
      "showSettingsModal",
      "showMcpManagerModal",
      "showHelpModal",
      "showInfoModal",
      "showNotifPanel",
      "showComposerPlus",
      "showModelManager",
      "showSlash",
      "showMentionDropdown",
      "showMcpPanel",
      "showSamplingPanel",
    ])
      if (r[k]) r[k] = false;
    if (r.menuPagesOuvert) r.menuPagesOuvert = false;
  });
}

/** Revient à la vue du chat, volet ouvert. */
async function vueChat(h) {
  const { page } = h;
  await fermerTout(h);
  const etat = await racine(page, () => ({
    vue: window.__racine().currentView,
    volet: window.__racine().showSidebar,
    editeur: window.__racine().showEditor,
  }));
  if (etat.editeur) await racine(page, () => (window.__racine().showEditor = false));
  if (!etat.volet) await page.locator('button[title="Ouvrir le panneau"]:visible').first().click();
  if (etat.vue !== "chat") await ouvrirChat(h, titreCourte(3), { forcer: true });
}

const ligne = (page, titre) => page.locator("[data-chat-row][data-chat-id]", { hasText: titre }).first();
async function idChat(h, titre) {
  return ligne(h.page, titre).getAttribute("data-chat-id", { timeout: 5000 });
}

/** Ouvre une conversation de l'historique et attend qu'elle soit affichée. */
async function ouvrirChat(h, titre, { forcer = false } = {}) {
  const { page } = h;
  const id = await idChat(h, titre);
  const actuel = await racine(page, () => window.__racine().currentChatId);
  if (actuel === id && !forcer) {
    const vue = await racine(page, () => window.__racine().currentView);
    if (vue === "chat") return id;
  }
  await ligne(page, titre).locator("[data-chat-open]").click();
  await page.waitForFunction(
    (i) => {
      const r = window.__racine();
      return (
        r.currentView === "chat" &&
        r.currentChatId === i &&
        !r.chatEnOuverture &&
        document.querySelectorAll(".elpis-msg-user").length > 0
      );
    },
    id,
    { timeout: 20000 },
  );
  await pause(300);
  return id;
}

/** Fait défiler le fil jusqu'en haut (le début de la conversation est rendu) ou jusqu'en bas. */
async function filAuBout(h, haut) {
  const { page } = h;
  for (let i = 0; i < 40; i++) {
    const fini = await racine(
      page,
      ([haut, marque]) => {
        const f = document.querySelector(".elpis-fil");
        if (!f) return true;
        if (haut) f.scrollTop = 0;
        else f.scrollTop = f.scrollHeight;
        const ecart = haut ? f.scrollTop : f.scrollHeight - f.scrollTop - f.clientHeight;
        return ecart <= 2 && (!haut || f.textContent.includes(marque));
      },
      [haut, MARQUE_LONGUE_DEBUT],
    );
    if (fini && i > 1) return;
    await pause(150);
  }
}

/** Composeur vide et focalisé. */
async function composeurVide(h) {
  const t = h.page.locator(".elpis-compose-card textarea").first();
  await t.fill("");
  await t.click();
}

/** Dernier élément visible d'un sélecteur (les éléments du rail et du volet existent en double). */
const dernierVisible = (page, sel) => page.locator(`${sel}:visible`).last();

/** Ouvre les paramètres (si besoin) sur un onglet donné. */
async function parametres(h, onglet) {
  const { page } = h;
  if (!(await visible(page, 'div[role="dialog"][aria-label="Paramètres"]'))) {
    await page.locator('button[title="Paramètres"]:visible').first().click();
    await page.locator('div[role="dialog"][aria-label="Paramètres"]').waitFor({ timeout: 10000 });
  }
  if (onglet) {
    await deplierAvance(h);
    await page.locator(`[data-rail-parametres] nav button:has-text("${onglet}")`).first().click();
    await pause(300);
  }
}
async function deplierAvance(h) {
  const b = h.page.locator('[data-rail-parametres] nav button[aria-expanded="false"]');
  if (await b.count()) await b.first().click();
}

/** Menu contextuel d'une ligne de l'historique. */
async function menuLigne(h, titre) {
  await ligne(h.page, titre).click({ button: "right" });
  await h.page.locator("#custom-context-menu").waitFor({ timeout: 5000 });
}

/** Prochaine conversation « Action NN » encore présente (archiver et supprimer les consomment). */
async function prochaineAction(h) {
  const titres = await h.page.locator("[data-chat-row][data-chat-id]").allInnerTexts();
  const t = titres.map((x) => (x.match(/Action \d\d/) || [])[0]).filter(Boolean);
  const libres = [...new Set(t)].filter((x) => x !== "Action 01").sort();
  if (!libres.length) throw new Error("NON MESURÉ: plus de conversation « Action » disponible");
  return libres[0];
}

const ONGLETS = [
  ["Profil", "profile"],
  ["Apparence", "appearance"],
  ["Chat", "chat"],
  ["Fonctionnalités", "features"],
  ["Modèles IA", "ai_models"],
  ["Prompts", "prompts"],
  ["Skills", "skills"],
  ["Mémoire", "memory"],
  ["Secrets", "secrets"],
  ["Compaction", "compaction"],
  ["Sandbox", "sandbox"],
  ["Archives", "archives"],
  ["Utilisation", "usage"],
];

const PAGES_PLUS = [
  ["Studio", "studio", ".elpis-studio-page", ""],
  ["Agents", "agents", ".elpis-agents-page", ""],
  ["RAG", "rag", ".elpis-rag-page", "services RAG (Qdrant, extracteur) absents : page vide ou en erreur"],
];

/** Démarrages : page neuve (froid) ou rechargée (chaud), sondes armées dès la navigation. */
export function gestesDemarrage() {
  const chat = {
    vis: () => {
      const a = document.getElementById("app");
      const t = document.querySelector(".elpis-compose-card textarea");
      return (
        !!a &&
        !a.hasAttribute("v-cloak") &&
        !!t &&
        t.getClientRects().length > 0 &&
        document.querySelectorAll("[data-chat-row]").length > 0
      );
    },
    fin: () =>
      document.fonts.status === "loaded" &&
      !!document.querySelector("[data-menu-modele] > button") &&
      (document.querySelector("[data-menu-modele] > button").textContent || "").trim().length > 0,
    url: (b) => b.core.urlMain,
    compte: (b) => b.core.comptes.user,
    groupe: "démarrage",
    selecteur: "index.html → .elpis-compose-card textarea + [data-chat-row]",
  };
  const console_ = {
    vis: () =>
      !!document.querySelector(".adm-page-head__title") &&
      !!document.querySelector(".adm-ov section.adm-card"),
    fin: () =>
      document.fonts.status === "loaded" && !document.querySelector('.adm-skeleton, [aria-busy="true"]'),
    url: (b) => b.core.urlAdmin,
    compte: (b) => b.core.comptes.admin,
    groupe: "démarrage",
    selecteur: "admin.html → .adm-page-head__title + .adm-ov section.adm-card",
  };
  return [
    { ...chat, nom: "Démarrage index.html (froid)", chaud: false },
    { ...chat, nom: "Démarrage index.html (chaud)", chaud: true },
    { ...console_, nom: "Démarrage admin.html (froid)", chaud: false },
    { ...console_, nom: "Démarrage admin.html (chaud)", chaud: true },
  ];
}

/** Gestes de la page du chat, dans l'ordre de la passe (la conversation longue n'est ouverte qu'à partir de « Ouvrir la conversation longue (1re fois) »). */
export function gestesChat() {
  const G = [];
  const g = (o) => G.push({ groupe: "chat", mode: "unique", ...o });

  // ── Volet latéral et historique ──
  g({
    nom: "Volet : replier",
    groupe: "volet",
    selecteur: 'button[title="Réduire le panneau"]',
    prep: (h) => vueChat(h),
    faire: (h) => h.page.locator('button[title="Réduire le panneau"]:visible').first().click(),
    vis: () => !window.__racine().showSidebar,
  });
  g({
    nom: "Volet : déplier",
    groupe: "volet",
    selecteur: 'button[title="Ouvrir le panneau"]',
    prep: async (h) => {
      if (await racine(h.page, () => window.__racine().showSidebar))
        await h.page.locator('button[title="Réduire le panneau"]:visible').first().click();
    },
    faire: (h) => h.page.locator('button[title="Ouvrir le panneau"]:visible').first().click(),
    vis: () =>
      window.__racine().showSidebar &&
      [...document.querySelectorAll("[data-chat-open]")].some((e) => e.getClientRects().length),
  });
  g({
    nom: "Historique : survol de 12 lignes",
    groupe: "volet",
    mode: "suite",
    entrees: ["pointerover"],
    selecteur: "[data-chat-row] (survol)",
    prep: async (h) => {
      await vueChat(h);
      await h.page.mouse.move(700, 450);
    },
    faire: async (h) => {
      const boites = await h.page.locator("[data-chat-row][data-chat-id]:visible").evaluateAll((l) =>
        l.slice(0, 12).map((e) => {
          const r = e.getBoundingClientRect();
          return [r.x + r.width / 2, r.y + r.height / 2];
        }),
      );
      for (const [x, y] of boites) {
        await h.page.mouse.move(x, y, { steps: 3 });
        await pause(40);
      }
    },
    vis: suiteVisible,
  });
  g({
    nom: "Historique : défilement (molette)",
    groupe: "volet",
    mode: "suite",
    entrees: ["wheel"],
    selecteur: ".chat-history-scroll (molette)",
    prep: async (h) => {
      await vueChat(h);
      await racine(h.page, () => (document.querySelector(".chat-history-scroll").scrollTop = 0));
    },
    faire: async (h) => {
      const b = await h.page.locator(".chat-history-scroll").boundingBox();
      await h.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      for (let i = 0; i < 14; i++) {
        await h.page.mouse.wheel(0, 120);
        await pause(30);
      }
    },
    vis: suiteVisible,
    apres: (h) => racine(h.page, () => (document.querySelector(".chat-history-scroll").scrollTop = 0)),
  });
  g({
    nom: "Historique : ouvrir la recherche",
    groupe: "volet",
    selecteur: 'button[title="Rechercher un chat"]',
    prep: (h) => vueChat(h),
    faire: (h) => h.page.locator('button[title="Rechercher un chat"]:visible').first().click(),
    vis: () => {
      const e = document.querySelector('input[placeholder="Rechercher un chat…"]');
      return !!e && e.getClientRects().length > 0;
    },
    fin: () =>
      document.activeElement && document.activeElement.matches('input[placeholder="Rechercher un chat…"]'),
  });
  g({
    nom: "Historique : recherche (frappe « Court 1 »)",
    groupe: "volet",
    mode: "suite",
    entrees: ["keydown"],
    selecteur: 'input[placeholder="Rechercher un chat…"]',
    prep: async (h) => {
      if (!(await visible(h.page, 'input[placeholder="Rechercher un chat…"]')))
        await h.page.locator('button[title="Rechercher un chat"]:visible').first().click();
      await h.page.locator('input[placeholder="Rechercher un chat…"]').fill("");
      await h.page.locator('input[placeholder="Rechercher un chat…"]').click();
      await pause(500);
    },
    faire: (h) => h.page.keyboard.type("Court 1", { delay: 90 }),
    vis: suiteVisible,
    fin: () => {
      const r = window.__racine();
      return (
        !r.isSearchingChats &&
        r.chatSearchResults &&
        r.chatSearchResults.length > 0 &&
        (document.querySelector('input[placeholder="Rechercher un chat…"]') || {}).value === "Court 1"
      );
    },
    jalons: {
      resultats: () => {
        const r = window.__racine();
        return !r.isSearchingChats && r.chatSearchResults && r.chatSearchResults.length > 0;
      },
    },
    apres: async (h) => {
      await h.page.locator('input[placeholder="Rechercher un chat…"]').fill("");
      await h.page
        .locator('button[title="Fermer la recherche"]')
        .first()
        .click()
        .catch(() => h.page.keyboard.press("Escape"));
    },
  });
  g({
    nom: "Historique : menu contextuel (clic droit)",
    groupe: "volet",
    selecteur: "[data-chat-row] (clic droit) → #custom-context-menu",
    prep: (h) => vueChat(h),
    faire: (h) => ligne(h.page, "Action 01").click({ button: "right" }),
    arg: "#custom-context-menu",
    vis: selAffiche,
    apres: (h) => h.page.keyboard.press("Escape"),
  });
  g({
    nom: "Historique : renommer (valider)",
    groupe: "volet",
    selecteur: '[data-conv-action="renommer"] → dialogue → bouton « Valider »',
    prep: async (h) => {
      await vueChat(h);
      await menuLigne(h, "Action 01");
      await h.page.locator('#custom-context-menu [data-conv-action="renommer"]').click();
      const champ = h.page.locator('[role="dialog"][aria-labelledby="app-modal-title"] input');
      await champ.waitFor({ timeout: 5000 });
      h.nomRenomme = `Action 01 v${Date.now() % 100000}`;
      await champ.fill(h.nomRenomme);
    },
    faire: (h) =>
      h.page.locator('[role="dialog"][aria-labelledby="app-modal-title"] button:has-text("Valider")').click(),
    arg: (h) => h.nomRenomme,
    vis: () =>
      [...document.querySelectorAll("[data-chat-row]")].some((d) => d.textContent.includes(window.__ab.arg)),
    fin: () => !document.querySelector('[role="dialog"][aria-labelledby="app-modal-title"]'),
  });
  g({
    nom: "Historique : archiver",
    groupe: "volet",
    selecteur: '[data-conv-action="archiver"]',
    prep: async (h) => {
      await vueChat(h);
      const t = await prochaineAction(h);
      h.idCible = await idChat(h, t);
      await menuLigne(h, t);
    },
    faire: (h) => h.page.locator('#custom-context-menu [data-conv-action="archiver"]').click(),
    arg: (h) => h.idCible,
    vis: () => !document.querySelector(`[data-chat-row][data-chat-id="${window.__ab.arg}"]`),
    fin: () => [...document.querySelectorAll(".elpis-toast")].some((t) => t.textContent.includes("archivée")),
  });
  g({
    nom: "Historique : supprimer (confirmer)",
    groupe: "volet",
    selecteur: '[data-conv-action="supprimer"] → dialogue → bouton « Supprimer »',
    prep: async (h) => {
      await vueChat(h);
      const t = await prochaineAction(h);
      h.idCible = await idChat(h, t);
      await menuLigne(h, t);
      await h.page.locator('#custom-context-menu [data-conv-action="supprimer"]').click();
      await h.page.locator('[role="dialog"][aria-labelledby="app-modal-title"]').waitFor({ timeout: 5000 });
    },
    faire: (h) =>
      h.page
        .locator('[role="dialog"][aria-labelledby="app-modal-title"] button:has-text("Supprimer")')
        .last()
        .click(),
    arg: (h) => h.idCible,
    vis: () => !document.querySelector(`[data-chat-row][data-chat-id="${window.__ab.arg}"]`),
    fin: () =>
      [...document.querySelectorAll(".elpis-toast")].some((t) => t.textContent.includes("supprimée")),
  });
  g({
    nom: "Historique : annuler la suppression",
    groupe: "volet",
    selecteur: '.elpis-toast button:has-text("Annuler")',
    calmeAvant: false,
    prep: async (h) => {
      await vueChat(h);
      const t = await prochaineAction(h);
      h.idCible = await idChat(h, t);
      await menuLigne(h, t);
      await h.page.locator('#custom-context-menu [data-conv-action="supprimer"]').click();
      await h.page
        .locator('[role="dialog"][aria-labelledby="app-modal-title"] button:has-text("Supprimer")')
        .last()
        .click();
      await h.page.locator('.elpis-toast button:has-text("Annuler")').last().waitFor({ timeout: 5000 });
      await pause(300);
    },
    faire: (h) => h.page.locator('.elpis-toast button:has-text("Annuler")').last().click(),
    arg: (h) => h.idCible,
    vis: () => !!document.querySelector(`[data-chat-row][data-chat-id="${window.__ab.arg}"]`),
  });
  g({
    nom: "Nouvelle conversation",
    groupe: "volet",
    selecteur: 'button[title="Nouveau chat (Ctrl+Maj+O)"]',
    prep: async (h) => {
      await vueChat(h);
      await ouvrirChat(h, titreCourte(2));
    },
    faire: (h) => h.page.locator('button[title="Nouveau chat (Ctrl+Maj+O)"]:visible').first().click(),
    vis: () => !window.__racine().currentChatId && document.querySelectorAll(".elpis-msg-user").length === 0,
    fin: () => {
      const t = document.querySelector(".elpis-compose-card textarea");
      return !!t && document.activeElement === t;
    },
  });

  // ── Conversations ──
  const ouvrir = (titre, marque) => ({
    selecteur: `[data-chat-row]:has-text("${titre}") [data-chat-open]`,
    faire: (h) => ligne(h.page, titre).locator("[data-chat-open]").click(),
    arg: marque,
    vis: () => {
      const m = document.querySelectorAll(".elpis-fil .elpis-msg-user, .elpis-fil .elpis-msg-assistant");
      return m.length > 0 && m[m.length - 1].textContent.includes(window.__ab.arg);
    },
    fin: () => {
      const r = window.__racine();
      const f = document.querySelector(".elpis-fil");
      return (
        !r.chatEnOuverture &&
        !!f &&
        !f.hasAttribute("aria-busy") &&
        f.scrollHeight - f.scrollTop - f.clientHeight <= 4
      );
    },
  });
  g({
    nom: "Ouvrir une conversation courte",
    groupe: "fil",
    ...ouvrir(titreCourte(7), "Deuxième réponse 7."),
    prep: async (h) => {
      await vueChat(h);
      await ouvrirChat(h, titreCourte(4));
    },
  });
  g({
    nom: "Ouvrir la conversation longue (1re fois)",
    groupe: "fil",
    ...ouvrir(TITRE_LONGUE, MARQUE_LONGUE_FIN),
    prep: async (h) => {
      await vueChat(h);
      await ouvrirChat(h, titreCourte(5));
    },
    delai: 20000,
  });
  g({
    nom: "Ouvrir la conversation longue (2e fois)",
    groupe: "fil",
    ...ouvrir(TITRE_LONGUE, MARQUE_LONGUE_FIN),
    prep: async (h) => {
      await vueChat(h);
      await ouvrirChat(h, titreCourte(6));
    },
    delai: 20000,
  });
  g({
    nom: "Passer d'une courte à une autre courte",
    groupe: "fil",
    ...ouvrir(titreCourte(9), "Deuxième réponse 9."),
    prep: async (h) => {
      await vueChat(h);
      await ouvrirChat(h, titreCourte(8));
    },
  });
  // Image à moitié vide : les lignes rendues du fil couvrent moins de la moitié de la zone visible.
  const imageVide = () => {
    const f = document.querySelector(".elpis-fil");
    if (!f) return 0;
    const r = f.getBoundingClientRect();
    let couvert = 0;
    for (const e of f.querySelectorAll("[data-vs-idx]")) {
      const b = e.getBoundingClientRect();
      const h = Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top);
      if (h > 0) couvert += h;
    }
    return couvert < r.height * 0.5 ? 1 : 0;
  };
  const molette = (sens) => async (h) => {
    const b = await h.page.locator(".elpis-fil").boundingBox();
    await h.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    for (let i = 0; i < 240; i++) {
      await h.page.mouse.wheel(0, sens * 400);
      await pause(16);
      if (i % 10 === 9) {
        const bout = await racine(
          h.page,
          ([s, marque]) => {
            const f = document.querySelector(".elpis-fil");
            return s > 0
              ? f.scrollHeight - f.scrollTop - f.clientHeight <= 4
              : f.scrollTop <= 2 && f.textContent.includes(marque);
          },
          [sens, MARQUE_LONGUE_DEBUT],
        );
        if (bout) return;
      }
    }
  };
  g({
    nom: "Fil long : molette de haut en bas",
    groupe: "fil",
    mode: "suite",
    entrees: ["wheel"],
    selecteur: ".elpis-fil (molette, 400 px par cran)",
    prep: async (h) => {
      await vueChat(h);
      await ouvrirChat(h, TITRE_LONGUE);
      await filAuBout(h, true);
    },
    faire: molette(1),
    vis: suiteVisible,
    fin: () => {
      const f = document.querySelector(".elpis-fil");
      return f.scrollHeight - f.scrollTop - f.clientHeight <= 4;
    },
    parImage: imageVide,
    delai: 15000,
  });
  g({
    nom: "Fil long : molette de bas en haut",
    groupe: "fil",
    mode: "suite",
    entrees: ["wheel"],
    selecteur: ".elpis-fil (molette, 400 px par cran)",
    prep: async (h) => {
      await vueChat(h);
      await ouvrirChat(h, TITRE_LONGUE);
      await filAuBout(h, false);
    },
    faire: molette(-1),
    vis: suiteVisible,
    arg: MARQUE_LONGUE_DEBUT,
    fin: () => {
      const f = document.querySelector(".elpis-fil");
      return f.scrollTop <= 2 && f.textContent.includes(window.__ab.arg);
    },
    parImage: imageVide,
    delai: 15000,
  });
  g({
    nom: "Fil long : bouton « Aller en bas »",
    groupe: "fil",
    selecteur: 'button[aria-label="Aller en bas"]',
    prep: async (h) => {
      await vueChat(h);
      await ouvrirChat(h, TITRE_LONGUE);
      await filAuBout(h, true);
      await pause(500);
    },
    faire: (h) => h.page.locator('button[aria-label="Aller en bas"]').first().click(),
    arg: MARQUE_LONGUE_FIN,
    vis: () => {
      const f = document.querySelector(".elpis-fil");
      const m = document.querySelectorAll(".elpis-fil .elpis-msg-assistant");
      const d = m[m.length - 1];
      if (!f || !d || !d.textContent.includes(window.__ab.arg)) return false;
      const rf = f.getBoundingClientRect();
      const rd = d.getBoundingClientRect();
      return rd.top < rf.bottom && rd.bottom > rf.top;
    },
    fin: () => {
      const f = document.querySelector(".elpis-fil");
      return f.scrollHeight - f.scrollTop - f.clientHeight <= 4;
    },
    parImage: imageVide,
  });
  g({
    nom: "Recherche dans la conversation : ouvrir",
    groupe: "fil",
    selecteur: '[data-menu-conversation] → [data-conv-action="rechercher"]',
    prep: async (h) => {
      await vueChat(h);
      await ouvrirChat(h, TITRE_LONGUE);
      await h.page.locator("[data-menu-conversation]:visible").first().click();
      await h.page.locator('[data-conv-action="rechercher"]:visible').first().waitFor({ timeout: 5000 });
    },
    faire: (h) => h.page.locator('[data-conv-action="rechercher"]:visible').first().click(),
    arg: '[role="search"][aria-label="Rechercher dans la conversation"]',
    vis: selAffiche,
  });
  g({
    nom: "Recherche dans la conversation : frappe « latence »",
    groupe: "fil",
    mode: "suite",
    entrees: ["keydown"],
    selecteur: 'input[aria-label="Rechercher dans la conversation"]',
    prep: async (h) => {
      const champ = h.page
        .locator('[role="search"] input[aria-label="Rechercher dans la conversation"]')
        .first();
      if (!(await champ.isVisible().catch(() => false))) {
        await ouvrirChat(h, TITRE_LONGUE);
        await h.page.locator("[data-menu-conversation]:visible").first().click();
        await h.page.locator('[data-conv-action="rechercher"]:visible').first().click();
      }
      await champ.fill("");
      await champ.click();
      await pause(400);
    },
    faire: (h) => h.page.keyboard.type("latence", { delay: 90 }),
    vis: suiteVisible,
    fin: () => {
      const c = document.querySelector("[data-recherche-compteur]");
      return !!c && /\d/.test(c.textContent);
    },
    jalons: { compteur: () => !!document.querySelector("[data-recherche-compteur]") },
  });
  g({
    nom: "Recherche dans la conversation : résultat suivant",
    groupe: "fil",
    selecteur: "[data-recherche-suivant]",
    prep: async (h) => {
      if (!(await visible(h.page, "[data-recherche-suivant]")))
        throw new Error("NON MESURÉ: barre de recherche absente");
    },
    faire: (h) => h.page.locator("[data-recherche-suivant]").first().click(),
    arg: async (h) => (await h.page.locator("[data-recherche-compteur]").first().textContent()) || "",
    vis: () => {
      const c = document.querySelector("[data-recherche-compteur]");
      return !!c && c.textContent !== window.__ab.arg;
    },
    apres: (h) => h.page.keyboard.press("Escape"),
  });
  g({
    nom: "Message : copier la réponse",
    groupe: "fil",
    selecteur: '.elpis-msg-assistant button[title="Copier la réponse"]',
    prep: async (h) => {
      await vueChat(h);
      await ouvrirChat(h, titreCourte(10));
      await h.page.locator(".elpis-msg-assistant").last().hover();
    },
    faire: (h) => h.page.locator('.elpis-msg-assistant button[title="Copier la réponse"]').last().click(),
    vis: () => !!document.querySelector(".elpis-msg-assistant button[data-copier] i.ph-check"),
  });
  g({
    nom: "Message : éditer (ouvrir)",
    groupe: "fil",
    selecteur: '.elpis-msg-user button[title="Éditer et renvoyer"]',
    prep: async (h) => {
      await vueChat(h);
      await ouvrirChat(h, titreCourte(11));
      await h.page.locator(".elpis-msg-user").last().hover();
    },
    faire: (h) => h.page.locator('.elpis-msg-user button[title="Éditer et renvoyer"]').last().click(),
    arg: "textarea[data-edit-message-input]",
    vis: selAffiche,
    fin: () => document.activeElement && document.activeElement.matches("textarea[data-edit-message-input]"),
    apres: (h) => h.page.keyboard.press("Escape"),
  });
  g({
    nom: "Message : éditer (annuler par Échap)",
    groupe: "fil",
    selecteur: "textarea[data-edit-message-input] (Échap)",
    prep: async (h) => {
      await vueChat(h);
      await ouvrirChat(h, titreCourte(11));
      await h.page.locator(".elpis-msg-user").last().hover();
      await h.page.locator('.elpis-msg-user button[title="Éditer et renvoyer"]').last().click();
      await h.page.locator("textarea[data-edit-message-input]").waitFor({ timeout: 5000 });
    },
    faire: (h) => h.page.keyboard.press("Escape"),
    arg: "textarea[data-edit-message-input]",
    vis: selAbsent,
  });
  g({
    nom: "Outils : déplier le travail de l'assistant",
    groupe: "fil",
    selecteur: "details[data-pipeline] > summary",
    prep: async (h) => {
      await vueChat(h);
      await ouvrirChat(h, TITRE_LONGUE);
      await filAuBout(h, false);
      const s = h.page.locator("details[data-pipeline]:not([open]) > summary").last();
      await s.scrollIntoViewIfNeeded({ timeout: 5000 });
      await pause(300);
    },
    faire: (h) => h.page.locator("details[data-pipeline]:not([open]) > summary").last().click(),
    vis: () => !!document.querySelector("details[data-pipeline][open]"),
  });
  g({
    nom: "Outil : ouvrir le détail d'une étape",
    groupe: "fil",
    selecteur: 'details[class*="toolwrap"] > summary → button[class*="group/toolbtn"]',
    prep: async (h) => {
      const p = h.page.locator("details[data-pipeline][open]").last();
      if (!(await p.count())) throw new Error("NON MESURÉ: travail de l'assistant non déplié");
      const groupe = p.locator('details[class*="toolwrap"]:not([open]) > summary').first();
      if (await groupe.count()) await groupe.click();
      await pause(300);
      await p.locator('button[class*="group/toolbtn"]').first().scrollIntoViewIfNeeded();
    },
    faire: (h) =>
      h.page
        .locator("details[data-pipeline][open]")
        .last()
        .locator('button[class*="group/toolbtn"]')
        .first()
        .click(),
    arg: 'button[aria-label="Fermer le détail"]',
    vis: selAffiche,
  });
  g({
    nom: "Réflexion : déplier",
    groupe: "fil",
    selecteur: "details[data-think] > summary",
    prep: async (h) => {
      await vueChat(h);
      await ouvrirChat(h, TITRE_LONGUE);
      await filAuBout(h, false);
      const s = h.page.locator("details[data-think]:not([open]) > summary:visible").last();
      if (!(await s.count())) {
        const n = await racine(h.page, () => [
          document.querySelectorAll("details[data-think]").length,
          document.querySelectorAll("details[data-think][open]").length,
          document.querySelectorAll("[data-vs-idx]").length,
        ]);
        throw new Error(
          `aucune réflexion repliée visible (data-think ${n[0]}, ouvertes ${n[1]}, lignes rendues ${n[2]})`,
        );
      }
      await s.scrollIntoViewIfNeeded({ timeout: 5000 });
      await pause(300);
    },
    faire: (h) => h.page.locator("details[data-think]:not([open]) > summary:visible").last().click(),
    vis: () => {
      const d = document.querySelector("details[data-think][open]");
      return (
        !!d &&
        d.getBoundingClientRect().height >
          (d.querySelector("summary")?.getBoundingClientRect().height || 0) + 8
      );
    },
  });

  // ── Composeur ──
  const TEXTE = "Peux-tu résumer les mesures de la semaine en trois points ?";
  for (const [nom, titre] of [
    ["Frappe dans un fil court", titreCourte(12)],
    ["Frappe dans le fil long", TITRE_LONGUE],
  ])
    g({
      nom: `${nom} (${TEXTE.length} touches)`,
      groupe: "composeur",
      mode: "suite",
      entrees: ["keydown"],
      selecteur: ".elpis-compose-card textarea (clavier, 70 ms par touche)",
      prep: async (h) => {
        await vueChat(h);
        await ouvrirChat(h, titre);
        await composeurVide(h);
      },
      faire: (h) => h.page.keyboard.type(TEXTE, { delay: 70 }),
      arg: TEXTE.length,
      vis: suiteVisible,
      fin: () =>
        (document.querySelector(".elpis-compose-card textarea") || {}).value?.length >= window.__ab.arg,
      apres: (h) => h.page.locator(".elpis-compose-card textarea").first().fill(""),
    });
  g({
    nom: "Coller 5 000 caractères dans le composeur",
    groupe: "composeur",
    entrees: ["beforeinput"],
    selecteur: ".elpis-compose-card textarea (insertion de 5 000 caractères)",
    prep: async (h) => {
      await vueChat(h);
      await ouvrirChat(h, titreCourte(12));
      await composeurVide(h);
    },
    faire: (h) =>
      h.page.keyboard.insertText("Voici le journal à analyser, ligne par ligne. ".repeat(110).slice(0, 5000)),
    vis: () => (document.querySelector(".elpis-compose-card textarea") || {}).value?.length >= 5000,
    fin: () => {
      const t = document.querySelector(".elpis-compose-card textarea");
      return !!t && t.value.length >= 5000 && t.clientHeight > 60;
    },
    apres: (h) => h.page.locator(".elpis-compose-card textarea").first().fill(""),
  });
  g({
    nom: "Menu « + » du composeur : ouvrir",
    groupe: "composeur",
    selecteur: "button[data-catalogue-plus]",
    prep: (h) => vueChat(h),
    faire: (h) => dernierVisible(h.page, "button[data-catalogue-plus]").click(),
    arg: '[role="menu"][aria-label="Plus d\'actions"]',
    vis: selAffiche,
    apres: (h) => h.page.keyboard.press("Escape"),
  });
  g({
    nom: "Sélecteur de modèle : ouvrir",
    groupe: "composeur",
    selecteur: "[data-menu-modele] > button",
    prep: (h) => vueChat(h),
    faire: (h) => h.page.locator("[data-menu-modele]:visible > button").first().click(),
    arg: '[role="dialog"][aria-label="Modèle"]',
    vis: selAffiche,
    fin: () => !!document.querySelector('[role="option"][data-modele]'),
    apres: (h) => h.page.keyboard.press("Escape"),
  });
  g({
    nom: "Commandes « / » : ouvrir",
    groupe: "composeur",
    selecteur: ".elpis-compose-card textarea (« / ») → #slash-list",
    prep: async (h) => {
      await vueChat(h);
      await composeurVide(h);
    },
    faire: (h) => h.page.keyboard.type("/"),
    arg: "#slash-list",
    vis: selAffiche,
    apres: async (h) => {
      await h.page.keyboard.press("Escape");
      await h.page.locator(".elpis-compose-card textarea").first().fill("");
    },
  });
  g({
    nom: "Mentions « @ » : ouvrir",
    groupe: "composeur",
    selecteur: ".elpis-compose-card textarea (« @ ») → #mention-list",
    prep: async (h) => {
      await vueChat(h);
      await composeurVide(h);
    },
    faire: (h) => h.page.keyboard.type("@"),
    arg: "#mention-list",
    vis: selAffiche,
    fin: () => !!document.querySelector("li[data-mention-row]"),
    apres: async (h) => {
      await h.page.keyboard.press("Escape");
      await h.page.locator(".elpis-compose-card textarea").first().fill("");
    },
  });

  // ── Envoi ──
  const envoi = (nom, prepChat) => ({
    nom,
    groupe: "envoi",
    selecteur: 'button[aria-label="Envoyer le message"]',
    prep: async (h) => {
      await vueChat(h);
      await prepChat(h);
      h.banc.core.llm.etat.file.length = 0;
      h.banc.core.llm.scripter({
        contenu: "Voici la réponse : **trois points** à retenir.\n\n- un\n- deux\n- trois",
        tokParS: 60,
      });
      await h.page
        .locator(".elpis-compose-card textarea")
        .first()
        .fill("Résume en trois points, s'il te plaît.");
    },
    faire: (h) => h.page.locator('button[aria-label="Envoyer le message"]:visible').first().click(),
    arg: async (h) =>
      racine(h.page, () => [
        document.querySelectorAll(".elpis-msg-user").length,
        document.querySelectorAll(".elpis-msg-assistant").length,
      ]),
    vis: () => document.querySelectorAll(".elpis-msg-user").length > window.__ab.arg[0],
    fin: () => {
      const a = document.querySelectorAll(".elpis-msg-assistant");
      if (a.length <= window.__ab.arg[1]) return false;
      const b = a[a.length - 1].querySelector(".markdown-body");
      return !!b && (b.textContent || "").trim().length > 0;
    },
    jalons: {
      bulleAssistant: () => document.querySelectorAll(".elpis-msg-assistant").length > window.__ab.arg[1],
      finDuTour: () =>
        !document.querySelector('button[title="Arrêter la génération"]') &&
        document.querySelectorAll(".elpis-msg-assistant").length > window.__ab.arg[1],
    },
    delai: 20000,
    apres: async (h) => {
      await h.page
        .waitForSelector('button[title="Arrêter la génération"]', { state: "detached", timeout: 30000 })
        .catch(() => {});
      await pause(500);
    },
  });
  g(
    envoi("Envoi : nouvelle conversation (clic → bulle → 1er jeton)", async (h) => {
      await h.page.locator('button[title="Nouveau chat (Ctrl+Maj+O)"]:visible').first().click();
      await pause(400);
    }),
  );
  g(
    envoi("Envoi : suite d'une conversation (clic → bulle → 1er jeton)", (h) =>
      ouvrirChat(h, titreCourte(13)),
    ),
  );
  g({
    nom: "Joindre un fichier",
    groupe: "composeur",
    selecteur: ".elpis-compose-card input[type=file]",
    prep: async (h) => {
      await vueChat(h);
      await ouvrirChat(h, titreCourte(14));
    },
    faire: (h) =>
      h.page
        .locator('.elpis-compose-card input[type="file"]')
        .first()
        .setInputFiles({
          name: "notes-banc.md",
          mimeType: "text/markdown",
          buffer: Buffer.from("# Notes\n\n" + "Une ligne de notes.\n".repeat(800)),
        }),
    arg: '.elpis-compose-card [title="notes-banc.md"]',
    vis: selAffiche,
    apres: (h) =>
      racine(h.page, () => {
        const r = window.__racine();
        if (Array.isArray(r.attachedFiles)) r.attachedFiles.splice(0);
      }),
  });

  // ── Fenêtres et panneaux ──
  const DIALOGUE = 'div[role="dialog"][aria-label="Paramètres"]';
  g({
    nom: "Paramètres : ouvrir",
    groupe: "fenêtres",
    selecteur: 'button[title="Paramètres"]',
    prep: (h) => vueChat(h),
    faire: (h) => h.page.locator('button[title="Paramètres"]:visible').first().click(),
    arg: DIALOGUE,
    vis: selAffiche,
    fin: () =>
      !!document.querySelector("[data-rail-parametres]") &&
      !document.querySelector('div[role="dialog"][aria-label="Paramètres"] .animate-spin'),
  });
  for (const [libelle, id] of ONGLETS)
    g({
      nom: `Paramètres : onglet ${libelle}`,
      groupe: "fenêtres",
      selecteur: `[data-rail-parametres] nav button:has-text("${libelle}")`,
      prep: async (h) => {
        await parametres(h, null);
        await deplierAvance(h);
        const actuel = await racine(h.page, () => window.__racine().settingsTab);
        if (actuel === id)
          await h.page
            .locator(
              `[data-rail-parametres] nav button:has-text("${id === "profile" ? "Apparence" : "Profil"}")`,
            )
            .first()
            .click();
      },
      faire: (h) =>
        h.page.locator(`[data-rail-parametres] nav button:has-text("${libelle}")`).first().click(),
      arg: id,
      vis: () =>
        window.__racine().settingsTab === window.__ab.arg &&
        !!document.querySelector('[data-rail-parametres] nav button[aria-current="page"]'),
      fin: () =>
        !document.querySelector(
          'div[role="dialog"][aria-label="Paramètres"] .animate-spin, div[role="dialog"][aria-label="Paramètres"] [aria-busy="true"]',
        ),
    });
  g({
    nom: "Paramètres : fermer (Échap)",
    groupe: "fenêtres",
    selecteur: `${DIALOGUE} (Échap)`,
    prep: (h) => parametres(h, "Profil"),
    faire: (h) => h.page.keyboard.press("Escape"),
    arg: DIALOGUE,
    vis: enFermeture,
    fin: selAbsent,
  });
  g({
    nom: "Panneau MCP : ouvrir",
    groupe: "fenêtres",
    selecteur: 'button[title^="MCP"]',
    prep: (h) => vueChat(h),
    faire: (h) => h.page.locator('button[title^="MCP"]:visible').first().click(),
    vis: () =>
      window.__racine().showMcpPanel &&
      [...document.querySelectorAll(".elpis-slide-panel")].some(
        (e) => e.querySelector(".ph-plug") && e.getBoundingClientRect().width > 100,
      ),
    fin: () =>
      [...document.querySelectorAll(".elpis-slide-panel")].some(
        (e) => e.querySelector(".ph-plug") && e.getBoundingClientRect().width >= 270,
      ),
  });
  g({
    nom: "Gestionnaire MCP : ouvrir",
    groupe: "fenêtres",
    selecteur: '[title="Gérer / ajouter un serveur"]',
    prep: async (h) => {
      await vueChat(h);
      await h.page.locator('button[title^="MCP"]:visible').first().click();
      await h.page.locator('[title="Gérer / ajouter un serveur"]').first().waitFor({ timeout: 5000 });
      await pause(300);
    },
    faire: (h) => h.page.locator('[title="Gérer / ajouter un serveur"]').first().click(),
    arg: '[role="dialog"][aria-labelledby="mcp-titre"]',
    vis: selAffiche,
    fin: () => !document.querySelector('[role="dialog"][aria-labelledby="mcp-titre"] .animate-spin'),
  });
  g({
    nom: "Gestionnaire MCP : fermer (Échap)",
    groupe: "fenêtres",
    selecteur: '[role="dialog"][aria-labelledby="mcp-titre"] (Échap)',
    prep: async (h) => {
      if (!(await visible(h.page, '[role="dialog"][aria-labelledby="mcp-titre"]')))
        throw new Error("NON MESURÉ: gestionnaire MCP non ouvert");
    },
    faire: (h) => h.page.keyboard.press("Escape"),
    arg: '[role="dialog"][aria-labelledby="mcp-titre"]',
    vis: enFermeture,
    fin: selAbsent,
  });
  g({
    nom: "Panneau MCP : fermer",
    groupe: "fenêtres",
    selecteur: 'button[title^="MCP"]',
    prep: async (h) => {
      await fermerTout(h);
      await racine(h.page, () => (window.__racine().showMcpPanel = true));
      await pause(500);
    },
    faire: (h) => h.page.locator('button[title^="MCP"]:visible').first().click(),
    vis: () => !window.__racine().showMcpPanel,
    fin: () =>
      ![...document.querySelectorAll(".elpis-slide-panel")].some(
        (e) => e.querySelector(".ph-plug") && e.getBoundingClientRect().width > 1,
      ),
  });
  g({
    nom: "Panneau Génération : ouvrir",
    groupe: "fenêtres",
    selecteur: "[data-menu-modele] > button → [data-reglages-generation]",
    prep: async (h) => {
      await vueChat(h);
      await h.page.locator("[data-menu-modele]:visible > button").first().click();
      await h.page.locator("[data-reglages-generation]").first().waitFor({ timeout: 5000 });
    },
    faire: (h) => h.page.locator("[data-reglages-generation]").first().click(),
    vis: () => {
      const e = document.querySelector("[data-panneau-generation]");
      return !!e && e.getBoundingClientRect().width > 100;
    },
    fin: () => {
      const e = document.querySelector("[data-panneau-generation]");
      return !!e && e.getBoundingClientRect().width >= 300;
    },
    apres: (h) => racine(h.page, () => (window.__racine().showSamplingPanel = false)),
  });
  g({
    nom: "Notifications : ouvrir",
    groupe: "fenêtres",
    selecteur: 'button[title*="otification"]',
    prep: (h) => vueChat(h),
    faire: (h) => h.page.locator('button[title*="otification"]:visible').first().click(),
    arg: ".elpis-notif-pop",
    vis: selAffiche,
    apres: (h) => h.page.keyboard.press("Escape"),
  });
  g({
    nom: "Menu du compte : ouvrir",
    groupe: "fenêtres",
    selecteur: "[data-menu-compte]",
    prep: (h) => vueChat(h),
    faire: (h) => h.page.locator("[data-menu-compte]:visible").first().click(),
    arg: '[role="menu"][aria-label="Compte"]',
    vis: selAffiche,
  });
  for (const [entree, label] of [
    ["Aide", "Aide"],
    ["Informations", "À propos"],
  ])
    g({
      nom: `Compte › ${entree} : ouvrir`,
      groupe: "fenêtres",
      selecteur: `[role="menu"][aria-label="Compte"] [role="menuitem"]:has-text("${entree}")`,
      prep: async (h) => {
        await vueChat(h);
        await h.page.locator("[data-menu-compte]:visible").first().click();
        await h.page.locator('[role="menu"][aria-label="Compte"]').waitFor({ timeout: 5000 });
      },
      faire: (h) =>
        h.page
          .locator(`[role="menu"][aria-label="Compte"] [role="menuitem"]:has-text("${entree}")`)
          .first()
          .click(),
      arg: `[role="dialog"][aria-label="${label}"]`,
      vis: selAffiche,
      apres: (h) => h.page.keyboard.press("Escape"),
    });

  // ── Pages ──
  g({
    nom: "Menu Plus : ouvrir",
    groupe: "pages",
    selecteur: "[data-menu-plus]",
    prep: (h) => vueChat(h),
    faire: (h) => h.page.locator("[data-menu-plus]:visible").first().click(),
    arg: '[role="menu"][aria-label="Plus"]',
    vis: selAffiche,
    apres: (h) => h.page.keyboard.press("Escape"),
  });
  const retour = (depuis) => ({
    nom: `Retour au chat depuis ${depuis}`,
    groupe: "pages",
    selecteur: `[data-chat-row]:has-text("${titreCourte(3)}") [data-chat-open]`,
    prep: async (h) => {
      const vue = await racine(h.page, () => window.__racine().currentView);
      if (vue === "chat") throw new Error(`NON MESURÉ: la page ${depuis} n'a pas été ouverte`);
    },
    faire: (h) => ligne(h.page, titreCourte(3)).locator("[data-chat-open]").click(),
    arg: "Deuxième réponse 3.",
    vis: () => {
      const m = document.querySelectorAll(".elpis-fil .elpis-msg-assistant");
      return (
        window.__racine().currentView === "chat" &&
        m.length > 0 &&
        m[m.length - 1].textContent.includes(window.__ab.arg)
      );
    },
  });
  for (const [libelle, vue, racineCss] of PAGES_PLUS) {
    g({
      nom: `Page ${libelle} : ouvrir (menu Plus)`,
      groupe: "pages",
      selecteur: `[data-menu-plus] → [role="menuitem"]:has-text("${libelle}")`,
      prep: async (h) => {
        await vueChat(h);
        await h.page.locator("[data-menu-plus]:visible").first().click();
        await h.page.locator('[role="menu"][aria-label="Plus"]').waitFor({ timeout: 5000 });
      },
      faire: (h) =>
        h.page
          .locator(`[role="menu"][aria-label="Plus"] [role="menuitem"]:has-text("${libelle}")`)
          .first()
          .click(),
      arg: [vue, racineCss],
      vis: () =>
        window.__racine().currentView === window.__ab.arg[0] && !!document.querySelector(window.__ab.arg[1]),
      fin: () =>
        !document.querySelector(
          `${window.__ab.arg[1]} .animate-spin, ${window.__ab.arg[1]} [aria-busy="true"]`,
        ),
    });
    g(retour(libelle));
  }
  g({
    nom: "Page Routines : ouvrir",
    groupe: "pages",
    selecteur: 'button[title="Routines"]',
    prep: (h) => vueChat(h),
    faire: (h) => h.page.locator('button[title="Routines"]:visible').first().click(),
    vis: () =>
      window.__racine().currentView === "routines" && !!document.querySelector(".elpis-routines-page"),
    fin: () =>
      !document.querySelector(".elpis-routines-page .animate-spin, .elpis-routines-page [aria-busy='true']"),
  });
  g(retour("Routines"));
  g({
    nom: "Bibliothèque d'images : ouvrir",
    groupe: "pages",
    nonMesure:
      "moteur d'images absent du cœur de test : l'entrée n'est pas proposée (settings.image_ready faux)",
  });
  g({
    nom: "Éditeur (Sandbox) : ouvrir",
    groupe: "pages",
    selecteur: 'button[title^="Sandbox"]',
    prep: (h) => vueChat(h),
    faire: (h) => h.page.locator('button[title^="Sandbox"]:visible').first().click(),
    vis: () => {
      const e = document.querySelector("[data-editor-root]");
      return (
        window.__racine().showEditor &&
        !!e &&
        e.getBoundingClientRect().width > 200 &&
        parseFloat(getComputedStyle(e).opacity) > 0.05
      );
    },
    fin: () =>
      parseFloat(getComputedStyle(document.querySelector("[data-editor-root]")).opacity) > 0.99 &&
      document.querySelectorAll('[role="tree"] [role="treeitem"]').length > 0,
    delai: 15000,
  });
  g({
    nom: "Éditeur : déplier un dossier de l'arbre",
    groupe: "pages",
    selecteur: '[role="treeitem"][aria-label="Dossier src"]',
    prep: async (h) => {
      if (!(await racine(h.page, () => window.__racine().showEditor)))
        throw new Error("NON MESURÉ: éditeur non ouvert");
      if (!(await visible(h.page, '[role="treeitem"][aria-label="Dossier src"]')))
        throw new Error("NON MESURÉ: arbre de l'éditeur absent");
      if (
        (await h.page
          .locator('[role="treeitem"][aria-label="Dossier src"]')
          .getAttribute("aria-expanded")) === "true"
      )
        await h.page.locator('[role="treeitem"][aria-label="Dossier src"]').click();
    },
    faire: (h) => h.page.locator('[role="treeitem"][aria-label="Dossier src"]').click(),
    arg: '[role="treeitem"][aria-label="Fichier serveur.ts"]',
    vis: selAffiche,
  });
  g({
    nom: "Éditeur : ouvrir un fichier (1re fois, Monaco)",
    groupe: "pages",
    selecteur: '[role="treeitem"][aria-label="Fichier serveur.ts"]',
    prep: async (h) => {
      if (!(await visible(h.page, '[role="treeitem"][aria-label="Fichier serveur.ts"]')))
        throw new Error("NON MESURÉ: fichier absent de l'arbre");
    },
    faire: (h) => h.page.locator('[role="treeitem"][aria-label="Fichier serveur.ts"]').click(),
    arg: "demarrerServeur",
    vis: () =>
      (document.querySelector("#monaco-editor .view-lines") || {}).textContent?.includes(window.__ab.arg),
    delai: 20000,
  });
  g({
    nom: "Éditeur : ouvrir un second fichier",
    groupe: "pages",
    selecteur: '[role="treeitem"][aria-label="Fichier routes.ts"]',
    prep: async (h) => {
      if (!(await racine(h.page, () => window.__racine().showEditor)))
        throw new Error("NON MESURÉ: éditeur non ouvert");
      const src = h.page.locator('[role="treeitem"][aria-label="Dossier src"]');
      // L'explorateur peut se replier à l'ouverture d'un fichier : l'utilisateur le rouvre.
      if (!(await visible(h.page, '[role="treeitem"][aria-label="Dossier src"]')))
        await h.page
          .locator('button[aria-label="Basculer l\'explorateur de fichiers"]:visible')
          .first()
          .click()
          .catch(() => {});
      await pause(300);
      if ((await src.count()) && (await src.getAttribute("aria-expanded")) !== "true") await src.click();
      await pause(300);
      if (!(await visible(h.page, '[role="treeitem"][aria-label="Fichier routes.ts"]'))) {
        const n = await racine(h.page, () => [
          document.querySelectorAll('[role="treeitem"]').length,
          [...document.querySelectorAll('[role="treeitem"]')]
            .map((e) => {
              const r = e.getBoundingClientRect();
              return `${e.getAttribute("aria-label")} ${Math.round(r.width)}x${Math.round(r.height)}`;
            })
            .join(", ")
            .slice(0, 220),
        ]);
        throw new Error(`fichier routes.ts invisible (${n[0]} lignes : ${n[1]})`);
      }
    },
    faire: (h) => h.page.locator('[role="treeitem"][aria-label="Fichier routes.ts"]').click(),
    arg: "declarerRoutes",
    vis: () =>
      (document.querySelector("#monaco-editor .view-lines") || {}).textContent?.includes(window.__ab.arg),
  });
  g({
    nom: "Éditeur : terminal (Ctrl+`)",
    groupe: "pages",
    selecteur: "Ctrl+` → .elpis-ed-terminal",
    prep: async (h) => {
      if (!(await racine(h.page, () => window.__racine().showEditor)))
        throw new Error("NON MESURÉ: éditeur non ouvert");
      await h.page
        .locator("#monaco-editor")
        .click()
        .catch(() => {});
    },
    faire: (h) => h.page.keyboard.press("Control+`"),
    arg: ".elpis-ed-terminal",
    vis: selAffiche,
  });
  g({
    nom: "Éditeur (Sandbox) : fermer",
    groupe: "pages",
    selecteur: 'button[title^="Sandbox"]',
    prep: async (h) => {
      if (!(await racine(h.page, () => window.__racine().showEditor)))
        throw new Error("NON MESURÉ: éditeur non ouvert");
    },
    faire: (h) => h.page.locator('button[title^="Sandbox"]:visible').first().click(),
    arg: "[data-editor-root]",
    vis: enFermeture,
    fin: () => document.querySelector("[data-editor-root]").getBoundingClientRect().width < 1,
  });

  // ── Apparence ──
  for (const [nom, bouton, sombre] of [
    ["Apparence : passer en sombre", "Sombre", true],
    ["Apparence : revenir en clair", "Clair", false],
  ])
    g({
      nom,
      groupe: "apparence",
      selecteur: `[role="radiogroup"] button[role="radio"]:has-text("${bouton}")`,
      prep: async (h) => {
        await parametres(h, "Apparence");
        const actuel = await racine(h.page, () => document.body.classList.contains("elpis-app-dark"));
        if (actuel === sombre) {
          await h.page
            .locator(`[role="radiogroup"] button[role="radio"]:has-text("${sombre ? "Clair" : "Sombre"}")`)
            .first()
            .click();
          await pause(1200);
        }
      },
      faire: (h) =>
        h.page.locator(`[role="radiogroup"] button[role="radio"]:has-text("${bouton}")`).first().click(),
      arg: sombre,
      vis: () => document.body.classList.contains("elpis-app-dark") === window.__ab.arg,
    });
  for (const [nom, skin] of [
    ["Apparence : skin Elpis", "elpis"],
    ["Apparence : skin Veilleuse", "veilleuse"],
    ["Apparence : skin Ardoise (défaut)", ""],
  ])
    g({
      nom,
      groupe: "apparence",
      selecteur: `select#set-skin → « ${skin || "Ardoise"} »`,
      prep: async (h) => {
        await parametres(h, "Apparence");
        if ((await h.page.locator("select#set-skin").inputValue()) === skin) {
          await h.page.locator("select#set-skin").selectOption(skin ? "" : "elpis");
          await pause(1200);
        }
      },
      faire: (h) => h.page.locator("select#set-skin").selectOption(skin),
      arg: skin,
      vis: () => {
        const c = [...document.body.classList].filter((x) => x.startsWith("elpis-skin-"));
        return window.__ab.arg ? c.includes("elpis-skin-" + window.__ab.arg) : c.length === 0;
      },
      fin: () => document.fonts.status === "loaded",
      apres: (h) => pause(1000),
    });
  return G;
}

/** Gestes de la console : chaque page du menu (découverte dans la page), puis tableau, journal, recherche, tiroir, enregistrement. */
export async function gestesConsole(banc, h) {
  const G = [];
  const g = (o) => G.push({ groupe: "console", mode: "unique", ...o });
  const titre = ".adm-page-head__title";
  const vueEnsemble = async (hh) => {
    await hh.page.keyboard.press("Escape").catch(() => {});
    if ((await racine(hh.page, () => window.__racine().adminTab)) !== "overview")
      await hh.page.locator('aside .adm-nav__entry:visible:has-text("Vue d")').first().click();
    await pause(400);
  };
  const allerA = async (hh, sous) => {
    await hh.page.keyboard.press("Escape").catch(() => {});
    await hh.page.locator(`aside .adm-nav__sub:visible:has-text("${sous}")`).first().click();
    await hh.page.locator(titre).first().waitFor({ timeout: 10000 });
    await pause(600);
  };
  const pages = h
    ? await h.page
        .locator("aside .adm-nav__sub:visible")
        .evaluateAll((l) =>
          l.map((e) => [
            e.closest("li[data-groupe]")?.querySelector(".adm-nav__label")?.textContent.trim() || "",
            e.textContent.trim(),
          ]),
        )
    : [["(section)", "(pages découvertes à l'exécution)"]];
  for (const [section, page] of pages)
    g({
      nom: `Console : ${section} › ${page}`,
      selecteur: `aside .adm-nav__sub:has-text("${page}")`,
      prep: vueEnsemble,
      faire: (hh) => hh.page.locator(`aside .adm-nav__sub:visible:has-text("${page}")`).first().click(),
      arg: async (hh) =>
        (await hh.page
          .locator(titre)
          .first()
          .textContent()
          .catch(() => "")) || "",
      vis: () => {
        const t = document.querySelector(".adm-page-head__title");
        return !!t && t.textContent !== window.__ab.arg && t.getClientRects().length > 0;
      },
      fin: sansChargement,
      delai: 15000,
    });
  g({
    nom: "Console : Vue d'ensemble (retour)",
    selecteur: 'aside .adm-nav__entry:has-text("Vue d’ensemble")',
    prep: (hh) => allerA(hh, "Comptes"),
    faire: (hh) => hh.page.locator('aside .adm-nav__entry:visible:has-text("Vue d")').first().click(),
    vis: () => !!document.querySelector(".adm-ov section.adm-card"),
    fin: sansChargement,
  });
  g({
    nom: "Console : Comptes › trier par une colonne",
    selecteur: "table.adm-users th[aria-sort] button[data-tri]",
    prep: (hh) => allerA(hh, "Comptes"),
    faire: (hh) => hh.page.locator("table.adm-users th[aria-sort] button[data-tri]").nth(1).click(),
    arg: async (hh) => [
      await hh.page.locator("table.adm-users th[aria-sort]").nth(1).getAttribute("aria-sort"),
      await hh.page.locator("table.adm-users tbody tr").first().textContent(),
    ],
    vis: () => {
      const th = document.querySelectorAll("table.adm-users th[aria-sort]")[1];
      const tr = document.querySelector("table.adm-users tbody tr");
      return (
        !!th &&
        (th.getAttribute("aria-sort") !== window.__ab.arg[0] || (tr && tr.textContent !== window.__ab.arg[1]))
      );
    },
  });
  g({
    nom: "Console : Comptes › filtrer (frappe « compte1 »)",
    mode: "suite",
    entrees: ["keydown"],
    selecteur: 'input[aria-label="Filtrer les comptes"]',
    prep: async (hh) => {
      await allerA(hh, "Comptes");
      await hh.page.locator('input[aria-label="Filtrer les comptes"]').fill("");
      await hh.page.locator('input[aria-label="Filtrer les comptes"]').click();
    },
    faire: (hh) => hh.page.keyboard.type("compte1", { delay: 90 }),
    vis: suiteVisible,
    fin: () => {
      const l = document.querySelectorAll("table.adm-users tbody tr");
      return l.length > 0 && l.length <= 12;
    },
    apres: (hh) => hh.page.locator('input[aria-label="Filtrer les comptes"]').fill(""),
  });
  g({
    nom: "Console : Comptes › déplier la fiche d'un compte",
    selecteur: 'table.adm-users button[aria-controls^="user-edit-"]',
    prep: (hh) => allerA(hh, "Comptes"),
    faire: (hh) => hh.page.locator('table.adm-users button[aria-controls^="user-edit-"]').nth(2).click(),
    arg: "[data-user-edit]",
    vis: selAffiche,
  });
  g({
    nom: "Console : Journaux › filtrer le journal technique",
    mode: "suite",
    entrees: ["keydown"],
    selecteur: 'input[aria-label="Filtrer les journaux par texte"]',
    prep: async (hh) => {
      await allerA(hh, "Journaux");
      const f = hh.page.locator('input[aria-label="Filtrer les journaux par texte"]');
      if (!(await f.count())) throw new Error("NON MESURÉ: filtre du journal technique absent");
      await f.fill("");
      await f.click();
    },
    faire: (hh) => hh.page.keyboard.type("admin", { delay: 90 }),
    vis: suiteVisible,
    apres: (hh) =>
      hh.page
        .locator('input[aria-label="Filtrer les journaux par texte"]')
        .fill("")
        .catch(() => {}),
  });
  g({
    nom: "Console : Journaux › ouvrir un événement de sécurité (tiroir)",
    selecteur: "tr.sup-ligne → .adm-drawer.sup-secu-tiroir",
    prep: async (hh) => {
      await allerA(hh, "Journaux");
      const onglet = hh.page.locator('.adm-onglets [role="tab"]:has-text("Sécurité")');
      if (await onglet.count()) await onglet.first().click();
      await pause(1200);
      if (!(await hh.page.locator("tr.sup-ligne").count()))
        throw new Error("NON MESURÉ: aucun événement de sécurité (journal jetable vide)");
    },
    faire: (hh) => hh.page.locator("tr.sup-ligne").first().click(),
    arg: ".adm-drawer.sup-secu-tiroir",
    vis: selAffiche,
    apres: (hh) => hh.page.keyboard.press("Escape"),
  });
  g({
    nom: "Console : Inférence › tiroir « Ajouter »",
    selecteur: '.adm-drawer[aria-labelledby="cnx-drawer-title"]',
    prep: (hh) => allerA(hh, "Inférence"),
    faire: (hh) =>
      hh.page
        .locator('main button:has-text("Ajouter"), .adm-page button:has-text("Ajouter")')
        .first()
        .click(),
    arg: '.adm-drawer[aria-labelledby="cnx-drawer-title"]',
    vis: selAffiche,
    apres: (hh) => hh.page.keyboard.press("Escape"),
  });
  g({
    nom: "Console : recherche de réglage (Ctrl+K)",
    selecteur: 'Ctrl+K → [role="combobox"][aria-label="Rechercher une page, un réglage ou une action"]',
    prep: vueEnsemble,
    faire: (hh) => hh.page.keyboard.press("Control+k"),
    arg: ".adm-palette",
    vis: selAffiche,
    fin: () => document.activeElement && document.activeElement.getAttribute("role") === "combobox",
  });
  g({
    nom: "Console : recherche de réglage (frappe « session »)",
    mode: "suite",
    entrees: ["keydown"],
    selecteur: '.adm-palette [role="combobox"]',
    prep: async (hh) => {
      if (!(await visible(hh.page, ".adm-palette"))) await hh.page.keyboard.press("Control+k");
      await hh.page.locator('.adm-palette [role="combobox"]').fill("");
    },
    faire: (hh) => hh.page.keyboard.type("session", { delay: 90 }),
    vis: suiteVisible,
    apres: (hh) => hh.page.keyboard.press("Escape"),
  });
  g({
    nom: "Console : enregistrer un réglage (Instance)",
    selecteur: '.adm-savebar button:has-text("Enregistrer")',
    prep: async (hh) => {
      await allerA(hh, "Instance");
      await hh.page.locator("#cfg-app-name").fill(`Elpis banc ${Date.now() % 1000}`);
      await hh.page.locator(".adm-savebar").waitFor({ timeout: 5000 });
    },
    faire: (hh) => hh.page.locator('.adm-savebar button:has-text("Enregistrer")').first().click(),
    arg: ".adm-savebar",
    vis: enFermeture,
    fin: selAbsent,
  });
  g({
    nom: "Console : basculer en sombre",
    selecteur: 'button[title="Passer en mode sombre"]',
    prep: async (hh) => {
      if (await visible(hh.page, 'button[title="Passer en mode clair"]'))
        await hh.page.locator('button[title="Passer en mode clair"]').first().click();
      await pause(500);
    },
    faire: (hh) => hh.page.locator('button[title="Passer en mode sombre"]:visible').first().click(),
    vis: () =>
      !!document.querySelector('button[title="Passer en mode clair"]') &&
      document.body.classList.contains("elpis-app-dark"),
    apres: (hh) =>
      hh.page
        .locator('button[title="Passer en mode clair"]:visible')
        .first()
        .click()
        .catch(() => {}),
  });
  g({
    nom: "Console : replier le panneau",
    selecteur: 'button[aria-label="Replier le panneau"]',
    prep: vueEnsemble,
    faire: (hh) => hh.page.locator('button[aria-label="Replier le panneau"]:visible').first().click(),
    arg: 'button[aria-label="Déplier le panneau"]',
    vis: selAffiche,
    apres: (hh) =>
      hh.page
        .locator('button[aria-label="Déplier le panneau"]:visible')
        .first()
        .click()
        .catch(() => {}),
  });
  return G;
}

/** Liste des gestes (sans page ouverte) pour --liste. */
export async function listeGestes() {
  return [...gestesDemarrage(), ...gestesChat(), ...(await gestesConsole(null, null))];
}
