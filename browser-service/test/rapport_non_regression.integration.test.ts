// SPDX-License-Identifier: MIT
// browser-service/test/rapport_non_regression.integration.test.ts — vrai service et Chromium contre des pages locales : étapes de /chain (attente d'un texte ou d'un rang, cible couverte, geste inconnu, clic droit, double-clic), texte caché d'une attente, élément caché de /locator, script de l'enregistreur, dossier des téléchargements d'un sous-agent.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";

import { demarrerService, portDe, raisonDeSauter } from "./aides/service.ts";
import type { Service } from "./aides/service.ts";

const SAUTER = await raisonDeSauter();
const OWNER = "rapport";
const NOM_LONG = "Un bouton au nom vraiment long pour le rejeu du script enregistré";
const BOUTON = (id: string, clic: string, texte: string) =>
  `<button id="${id}" ${clic} oncontextmenu="out.textContent += 'droit '; return false">${texte}</button>`;
const PAGES: Record<string, string> = {
  "/": "<title>Accueil</title><p>accueil</p>",
  "/attente":
    '<title>Attente</title><p id="fin" style="display:none">Hello World!</p>' +
    '<button id="go" onclick="setTimeout(() => { fin.style.display = \'block\'; }, 1200)">Start</button>',
  "/couvert":
    '<title>Couvert</title><button id="b" onclick="document.title = \'clic\'">Bouton fermé</button>' +
    '<div id="calque" style="position:fixed;inset:0;background:rgba(0,0,0,.2)"></div>',
  "/lignes":
    '<title>Lignes</title><p id="out"></p>' +
    [1, 2, 3]
      .map(
        (n) =>
          `<span style="position:relative;display:inline-block"><button onclick="out.textContent += '${n} '">Remove</button>` +
          (n === 3 ? '<span style="position:absolute;inset:0"></span>' : "") +
          "</span>",
      )
      .join(""),
  "/masque":
    '<title>Masque</title><button id="b" onclick="document.title = \'clic\'">Valider</button>' +
    '<div id="calque" style="position:fixed;inset:0"></div><script>setTimeout(() => calque.remove(), 1200)</script>',
  "/flux":
    '<title>Flux</title><ul id="l"></ul><script>let n = 0; const t = setInterval(() => { const li = document.createElement("li");' +
    ' li.textContent = "Result"; l.append(li); if (++n === 3) { clearInterval(t); const d = document.createElement("div");' +
    ' d.className = "result"; d.textContent = "fini"; document.body.append(d); } }, 500)</script>',
  "/flottant":
    '<title>Flottant</title><div id="c" style="height:0"><span style="float:left">Texte flottant</span></div>',
  "/gestes":
    '<title>Gestes</title><p id="out"></p>' +
    BOUTON("d", "ondblclick=\"out.textContent += 'dbl '\"", "Cible") +
    BOUTON("g", "onclick=\"out.textContent += 'gauche '\"", "Autre"),
  "/cache":
    '<title>Caché</title><div id="z" style="width:0;height:0;overflow:hidden">50.3</div><p>visible</p>',
  "/long": `<title>Long</title><button onclick="document.title = 'long'">${NOM_LONG}</button>`,
  "/telecharger": '<title>Fichier</title><a id="dl" href="/fichier" download="f.txt">fichier</a>',
};

// Étape d'une chaîne.
interface Etape {
  step: number;
  action: string;
  success: boolean;
  code?: string;
  error?: string;
  fix?: string;
  duration_ms: number;
}
// Champs des réponses lus par ces essais.
interface Corps {
  session_id: string;
  ok: boolean;
  executed: number;
  failed: number;
  results: Etape[];
  status: string;
  error: string;
  polled_value: { text: string; visible: boolean };
  count: number;
  total: number;
  matches: { ref: string }[];
  hidden_matches?: { ref: string; visible: boolean; text: string }[];
  usage_hint: string;
  script: string;
  result: unknown;
  downloads?: { file: string; path: string }[];
}

let service!: Service<Corps>;
let pages!: http.Server;
let base = "";
let sid = "";

function gestionnaire(req: http.IncomingMessage, res: http.ServerResponse) {
  const chemin = req.url!.split("?")[0]!;
  if (chemin === "/fichier") {
    res.writeHead(200, {
      "content-type": "text/plain",
      "content-disposition": 'attachment; filename="f.txt"',
    });
    res.end("contenu");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGES[chemin] || `<title>${chemin}</title>`);
}

const api = (route: string, corps: Record<string, unknown> = {}) =>
  service.post(route, { owner: OWNER, session_id: sid, ...corps });
const ouvrir = (chemin: string) => api("/action", { type: "goto", url: `${base}${chemin}` });
const evaluer = async (script: string) => (await api("/evaluate", { script })).corps.result;
const sortie = () => evaluer("document.getElementById('out').textContent");

before(async () => {
  if (SAUTER) return;
  pages = http.createServer(gestionnaire);
  await new Promise<void>((r) => pages.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${portDe(pages)}`;
  service = await demarrerService<Corps>();
  const r = await service.post("/start", { owner: OWNER, url: `${base}/`, isolated: true });
  assert.equal(r.statut, 200, r.texte);
  sid = r.corps.session_id;
});

after(async () => {
  if (service) await service.arreter();
  if (pages) {
    pages.closeAllConnections();
    await new Promise((r) => pages.close(r));
  }
});

test(
  "chaîne : l'étape wait attend un texte comme les autres étapes le désignent (by_text et repli), jusqu'à ce qu'il se voie",
  { skip: SAUTER, timeout: 60000 },
  async () => {
    await ouvrir("/attente");
    // Ce que l'hôte d'outils envoie pour target="text=Hello World!" : by_text et le texte en sélecteur de repli.
    const r = await api("/chain", {
      actions: [
        { type: "click", by_css: "#go" },
        { type: "wait", by_text: "Hello World!", selector: "Hello World!", timeout: 8000 },
      ],
    });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(r.corps.ok, true, r.texte);
    assert.equal(r.corps.results[1]!.success, true, r.texte);
    assert.ok(r.corps.results[1]!.duration_ms >= 800, r.texte);
    // Texte seul, sans by_* (appel direct) : cherché comme un texte, pas comme un sélecteur CSS.
    const seul = await api("/chain", {
      actions: [{ type: "wait", selector: "Hello World!", timeout: 3000 }],
    });
    assert.equal(seul.corps.ok, true, seul.texte);
  },
);

test(
  "chaîne : wait attend le n-ième élément demandé, un sélecteur CSS seul reste un sélecteur, une cible absente échoue à l'échéance",
  { skip: SAUTER, timeout: 60000 },
  async () => {
    await ouvrir("/flux");
    const rang = await api("/chain", {
      actions: [{ type: "wait", by_text: "Result", nth: 2, selector: "Result", timeout: 6000 }],
    });
    assert.equal(rang.corps.ok, true, rang.texte);
    assert.equal(await evaluer("document.querySelectorAll('li').length"), 3);
    await ouvrir("/flux");
    const css = await api("/chain", { actions: [{ type: "wait", selector: "div.result", timeout: 6000 }] });
    assert.equal(css.corps.ok, true, css.texte);
    assert.ok(css.corps.results[0]!.duration_ms >= 1000, css.texte);
    const jamais = await api("/chain", {
      actions: [{ type: "wait", by_text: "Absent", selector: "Absent", timeout: 1200 }],
      screenshot_on_fail: false,
    });
    assert.equal(jamais.corps.results[0]!.code, "element_not_found", jamais.texte);
  },
);

test(
  "attente text_contains : un texte présent dans un élément caché ne compte pas, il compte dès qu'il se voit",
  { skip: SAUTER, timeout: 60000 },
  async () => {
    await ouvrir("/attente");
    const attente = { by_css: "#fin", condition: "text_contains", expected_text: "Hello World!" };
    const cache = await api("/wait_for_dynamic", { ...attente, timeout: 800 });
    assert.equal(cache.statut, 408, cache.texte);
    assert.equal(cache.corps.polled_value.visible, false, cache.texte);
    assert.match(cache.corps.error, /the text is there, but the element is hidden/, cache.texte);
    await api("/action", { type: "click", by_css: "#go" });
    const vu = await api("/wait_for_dynamic", { ...attente, timeout: 6000 });
    assert.equal(vu.statut, 200, vu.texte);
    assert.equal(vu.corps.status, "matched", vu.texte);
    assert.equal(vu.corps.polled_value.visible, true, vu.texte);
    // Conteneur sans hauteur dont le texte se voit (enfant flottant) : il compte.
    await ouvrir("/flottant");
    const flottant = await api("/wait_for_dynamic", {
      by_css: "#c",
      condition: "text_contains",
      expected_text: "Texte flottant",
      timeout: 3000,
    });
    assert.equal(flottant.corps.status, "matched", flottant.texte);
  },
);

test(
  "chaîne : une cible encore couverte à l'échéance dit click_intercepted, garde son rang, et un masque passager a le temps de partir",
  { skip: SAUTER, timeout: 60000 },
  async () => {
    for (const etape of [
      { type: "click", by_css: "#b", timeout: 1500 },
      { type: "click", by_css: "#b", selector: "#b", timeout: 1500 },
      { type: "dblclick", by_css: "#b", timeout: 1500 },
    ]) {
      await ouvrir("/couvert");
      const r = await api("/chain", { actions: [etape], screenshot_on_fail: false });
      assert.equal(r.corps.ok, false, r.texte);
      assert.equal(r.corps.results[0]!.code, "click_intercepted", r.texte);
      assert.equal(await evaluer("document.title"), "Couvert");
    }
    // Le troisième bouton, couvert, n'est jamais remplacé par le premier du même nom.
    await ouvrir("/lignes");
    const rang = await api("/chain", {
      actions: [
        { type: "click", by_role: "button", by_name: "Remove", nth: 2, selector: "Remove", timeout: 1500 },
      ],
      screenshot_on_fail: false,
    });
    assert.equal(rang.corps.results[0]!.code, "click_intercepted", rang.texte);
    assert.equal(await sortie(), "");
    await ouvrir("/masque");
    const passager = await api("/chain", { actions: [{ type: "click", by_css: "#b" }] });
    assert.equal(passager.corps.ok, true, passager.texte);
    assert.equal(await evaluer("document.title"), "clic");
  },
);

test(
  "chaîne : clic droit et double-clic comme pw_act ; un geste inconnu fait échouer la chaîne et l'arrête",
  { skip: SAUTER, timeout: 60000 },
  async () => {
    await ouvrir("/gestes");
    const r = await api("/chain", {
      actions: [
        { type: "rclick", by_css: "#d" },
        { type: "dblclick", by_css: "#d" },
      ],
    });
    assert.equal(r.corps.ok, true, r.texte);
    assert.deepEqual(
      r.corps.results.map((e) => e.action),
      ["rclick", "dblclick"],
    );
    assert.equal(await sortie(), "droit dbl ");
    // Clic droit par sélecteur seul : l'échelle de repli ne le change jamais en clic gauche.
    await ouvrir("/gestes");
    const seul = await api("/chain", { actions: [{ type: "rclick", selector: "#g", human: true }] });
    assert.equal(seul.corps.ok, true, seul.texte);
    assert.equal(await sortie(), "droit ");

    const inconnu = await api("/chain", {
      actions: [
        { type: "click", by_css: "#d" },
        { type: "voler", by_css: "#d" },
        { type: "click", by_css: "#d" },
      ],
    });
    assert.equal(inconnu.statut, 200, inconnu.texte);
    assert.equal(inconnu.corps.ok, false, inconnu.texte);
    assert.equal(inconnu.corps.failed, 1, inconnu.texte);
    assert.equal(inconnu.corps.executed, 2, inconnu.texte);
    assert.equal(inconnu.corps.results[1]!.code, "unknown_action", inconnu.texte);
    assert.match(inconnu.corps.results[1]!.fix || "", /click, rclick, dblclick/, inconnu.texte);
  },
);

test(
  "locator : un élément présent mais caché est rendu à part, avec sa ref et sans son texte, quand aucun n'est visible",
  { skip: SAUTER, timeout: 60000 },
  async () => {
    await ouvrir("/cache");
    const r = await api("/locator", { by_css: "#z" });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(r.corps.count, 0, r.texte);
    assert.equal(r.corps.total, 1, r.texte);
    assert.deepEqual(r.corps.matches, [], r.texte);
    assert.equal(r.corps.hidden_matches!.length, 1, r.texte);
    assert.equal(r.corps.hidden_matches![0]!.visible, false, r.texte);
    assert.equal(r.corps.hidden_matches![0]!.text, "", r.texte);
    assert.match(r.corps.hidden_matches![0]!.ref, /\S/, r.texte);
    assert.match(r.corps.usage_hint, /hidden/, r.texte);
    // Un élément visible : rien ne change, aucun élément caché n'est joint.
    const vu = await api("/locator", { by_css: "p" });
    assert.equal(vu.corps.count, 1, vu.texte);
    assert.equal(vu.corps.hidden_matches, undefined, vu.texte);
  },
);

test(
  "enregistreur : démarré sur une page ouverte il commence par son goto ; un nom coupé par « … » s'exporte rejouable",
  { skip: SAUTER, timeout: 60000 },
  async () => {
    await ouvrir("/long");
    assert.equal((await api("/recorder/start")).statut, 200);
    const coupe = `${NOM_LONG.slice(0, 30)}…`;
    const clic = await api("/action", { type: "click", by_role: "button", by_name: coupe });
    assert.equal(clic.statut, 200, clic.texte);
    assert.equal(await evaluer("document.title"), "long");
    const dump = async (format: string) =>
      (await service.get(`/recorder/dump?owner=${OWNER}&session_id=${sid}&format=${format}`)).corps.script;
    const evenements = JSON.parse(await dump("json")) as { action: string; url?: string }[];
    assert.equal(evenements[0]!.action, "goto");
    assert.equal(evenements[0]!.url, `${base}/long`);
    const debut = NOM_LONG.slice(0, 30).trimEnd();
    const pw = await dump("playwright");
    assert.ok(pw.includes(`page.goto('${base}/long')`), pw);
    assert.ok(pw.includes(`getByRole('button', { name: '${debut}' })`), pw);
    assert.ok(!pw.includes("…"), pw);
    const robot = await dump("robot");
    // Cellule Robot : chaque « = » y est échappé.
    assert.ok(robot.includes(`role\\=button[name\\=/^${debut}/]`), robot);
    assert.ok(!robot.includes("…"), robot);
    await api("/recorder/stop");
  },
);

test(
  "téléchargements d'un sous-agent : rangés avec ceux de son compte (le groupe), jamais par-dessus un fichier déjà là",
  { skip: SAUTER, timeout: 60000 },
  async () => {
    const telecharger = async (enfant: string) => {
      const r = await service.post("/start", {
        owner: enfant,
        group: OWNER,
        url: `${base}/telecharger`,
        isolated: true,
      });
      assert.equal(r.statut, 200, r.texte);
      const clic = await service.post("/action", {
        owner: enfant,
        session_id: r.corps.session_id,
        type: "click",
        by_css: "#dl",
      });
      assert.equal(clic.statut, 200, clic.texte);
      return clic.corps.downloads![0]!;
    };
    const premier = await telecharger("s_0123456789abcdef");
    assert.equal(premier.file, "f.txt");
    assert.ok(premier.path.includes(`/downloads/${OWNER}/`), premier.path);
    assert.ok(!premier.path.includes("s_0123456789abcdef"), premier.path);
    const second = await telecharger("s_fedcba9876543210");
    assert.equal(second.file, "f (1).txt");
    assert.equal(fs.readFileSync(premier.path, "utf8"), "contenu");
    assert.equal(fs.readFileSync(second.path, "utf8"), "contenu");
  },
);

test(
  "débit des appels borné : au-delà de la limite par seconde, 429 rate_limited, puis le service répond de nouveau",
  { skip: SAUTER, timeout: 60000 },
  async () => {
    const borne = await demarrerService<Corps & { code?: string; retryable?: boolean }>({
      env: { PW_RATE_MAX_PER_S: "5" },
    });
    try {
      const rafale = await Promise.all(
        Array.from({ length: 30 }, () =>
          borne.post("/recorder/status", { owner: OWNER, session_id: "aucune" }),
        ),
      );
      const refuses = rafale.filter((r) => r.statut === 429);
      assert.ok(refuses.length >= 20, `${refuses.length} refus`);
      assert.equal(refuses[0]!.corps.code, "rate_limited", refuses[0]!.texte);
      assert.equal(refuses[0]!.corps.retryable, true, refuses[0]!.texte);
      await new Promise((r) => setTimeout(r, 1200));
      assert.notEqual((await borne.get("/health")).statut, 429);
    } finally {
      await borne.arreter();
    }
  },
);
