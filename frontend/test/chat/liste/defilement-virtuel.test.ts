// SPDX-License-Identifier: MIT
/** frontend/test/chat/liste/defilement-virtuel.test.ts — fenêtrage des longues conversations : seuil, fenêtre initiale, marge dans l'image et au repos, cales, écran blanc évité, garde du rAF (files manuelles), dernier assistant. */
import { strict as assert } from "node:assert";
import { computed, nextTick, ref, watch } from "vue";
import { afterEach, beforeEach, it, vi } from "vitest";

import { creerDefilementVirtuel } from "../../../src/features/chat/liste/defilement-virtuel";
import type { MessageListe } from "../../../src/features/chat/liste/defilement-virtuel";

const SEUIL = 30;
const TAMPON = 10;
const PAS = 180 + 32;

/** rAF et repos en FILES vidées explicitement : un rappel synchrone laisserait le garde armé et le test vert sans rien tester. */
let file = new Map<number, FrameRequestCallback>();
let fileRepos = new Map<number, IdleRequestCallback>();
let prochain = 0;
/** Temps de repos rendu par l'échéance des rappels (0 : un pas par rappel). */
let tempsRepos = 0;
function videRaf(plafond = 20): number {
  let passes = 0;
  while (file.size > 0 && passes < plafond) {
    const lot = [...file.values()];
    file.clear();
    for (const cb of lot) cb(0);
    passes++;
  }
  return passes;
}
/** Un moment de repos : les rappels en attente, puis leurs suites (microtâches). */
async function repos(): Promise<number> {
  const lot = [...fileRepos.values()];
  fileRepos.clear();
  for (const cb of lot) cb({ didTimeout: false, timeRemaining: () => tempsRepos });
  for (let k = 0; k < 50; k++) await nextTick();
  return lot.length;
}
/** Images et moments de repos jusqu'à ce que plus rien ne soit planifié ; rend le nombre de moments de repos. */
async function vider(plafond = 200): Promise<number> {
  let n = 0;
  while ((file.size > 0 || fileRepos.size > 0) && n < plafond) {
    videRaf();
    if (fileRepos.size) n += await repos();
  }
  return n;
}

beforeEach(() => {
  file = new Map();
  fileRepos = new Map();
  prochain = 0;
  tempsRepos = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    prochain += 1;
    file.set(prochain, cb);
    return prochain;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => file.delete(id));
  vi.stubGlobal("requestIdleCallback", (cb: IdleRequestCallback) => {
    prochain += 1;
    fileRepos.set(prochain, cb);
    return prochain;
  });
  vi.stubGlobal("cancelIdleCallback", (id: number) => fileRepos.delete(id));
  vi.stubGlobal("ResizeObserver", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Message extends MessageListe {
  content?: string;
}

interface Options {
  scrollTop?: number;
  hauteurVue?: number;
  sansConteneur?: boolean;
  /** Hauteur mesurée de chaque ligne rendue (sinon rien n'est mesuré : hauteurs estimées). */
  hauteurLigne?: number;
}

function monter(nbMessages: number, o: Options = {}) {
  let rendus: () => number[] = () => [];
  const mesures = new Set<number>();
  const conteneur = {
    scrollTop: o.scrollTop || 0,
    clientHeight: o.hauteurVue !== undefined ? o.hauteurVue : 900,
    querySelectorAll: () => {
      const h = o.hauteurLigne;
      if (!h) return [];
      const r = rendus();
      // Ancrage du navigateur : une ligne au-dessus de la vue qui prend sa vraie hauteur décale la position d'autant.
      for (const i of r) {
        if (mesures.has(i)) continue;
        let haut = 0;
        for (let j = 0; j < i; j++) haut += mesures.has(j) ? h + 32 : PAS;
        mesures.add(i);
        if (haut < conteneur.scrollTop) conteneur.scrollTop += h + 32 - PAS;
      }
      return r.map((i) => ({ dataset: { vsIdx: String(i) }, offsetHeight: h }));
    },
    getBoundingClientRect: () => ({ top: 0 }),
  };
  const refs = {
    messages: ref<Message[]>(
      Array.from({ length: nbMessages }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        content: "m" + i,
      })),
    ),
    chatContainer: ref((o.sansConteneur ? null : conteneur) as unknown as HTMLElement | null),
    isUserScrolling: ref(false),
  };
  const a = creerDefilementVirtuel({ ref, computed, watch, nextTick }, refs, {}) as unknown as Api;
  rendus = () => a.visibleMessages.value.map((v) => v.idx);
  return {
    api: a,
    refs,
    conteneur,
    /** Défilement : l'image seule (ce qui est monté dans l'image). */
    scroller(px: number) {
      conteneur.scrollTop = px;
      a.onChatScroll();
      videRaf();
    },
    /** Défilement, puis repos jusqu'à la fenêtre de lecture. */
    async defiler(px: number) {
      conteneur.scrollTop = px;
      a.onChatScroll();
      await vider();
    },
    videRaf: () => videRaf(),
    indices: (): number[] => a.visibleMessages.value.map((v) => v.idx),
    /** i-ième indice rendu (négatif : depuis la fin), -1 hors fenêtre. */
    at(i: number): number {
      return a.visibleMessages.value.at(i)?.idx ?? -1;
    },
  };
}

interface Api {
  visibleMessages: { value: { idx: number; msg: Message }[] };
  vsTopPad: { value: number };
  vsBotPad: { value: number };
  lastAssistantIdx: { value: number };
  onChatScroll(): void;
  _vsInitTail(n: number): void;
  _vsEnsureTail(): void;
  _vsReset(): void;
}

// ── Les constantes ───────────────────────────────────────────

it("sous le seuil, TOUS les messages sont rendus et les cales sont nulles", () => {
  const v = monter(SEUIL);
  assert.equal(v.api.visibleMessages.value.length, SEUIL);
  assert.equal(v.api.vsTopPad.value, 0);
  assert.equal(v.api.vsBotPad.value, 0);
});

it("à seuil + 1, le fenêtrage s'active", () => {
  const v = monter(SEUIL + 1);
  v.api._vsInitTail(SEUIL + 1);
  assert.ok(
    v.api.visibleMessages.value.length < SEUIL + 1,
    "le fenêtrage devrait avoir réduit la liste rendue",
  );
});

it("une conversation vide ne casse pas", () => {
  const v = monter(0);
  assert.deepStrictEqual(v.indices(), []);
  v.scroller(0);
  assert.deepStrictEqual(v.indices(), []);
});

// ── visibleMessages : forme du rendu ─────────────────────────

it("chaque entrée porte le message ET son index absolu", () => {
  const v = monter(5);
  const e = v.api.visibleMessages.value[2];
  assert.equal(e?.idx, 2);
  assert.equal(e?.msg.content, "m2");
});

it("les index restent ABSOLUS dans une fenêtre décalée", () => {
  // C'est ce qui permet à _patch de remplacer le bon message.
  const v = monter(100);
  v.api._vsInitTail(100);
  const idx = v.indices();
  assert.equal(idx[idx.length - 1], 99);
  assert.ok(v.at(0) > 0, "la fenêtre devrait être décalée vers la fin");
  for (let i = 1; i < idx.length; i++) assert.equal(idx[i], (idx[i - 1] ?? 0) + 1, "index non contigus");
});

// ── _vsInitTail : la fenêtre initiale ────────────────────────

it("_vsInitTail sous le seuil : les 8 derniers à la première image, tout et sans cale au repos", async () => {
  const v = monter(10);
  v.api._vsInitTail(10);
  assert.deepStrictEqual(v.indices(), [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(v.api.vsTopPad.value, 2 * PAS);
  v.videRaf();
  assert.equal(v.indices().length, 8, "rien de plus dans l'image qui suit");
  await vider();
  assert.deepStrictEqual(v.indices(), [...Array(10).keys()]);
  assert.equal(v.api.vsTopPad.value, 0);
  assert.equal(v.api.vsBotPad.value, 0);
});

it("_vsInitTail jusqu'à 8 messages rend tout d'un coup, sans cale ni image planifiée", () => {
  const v = monter(8);
  v.api._vsInitTail(8);
  assert.deepStrictEqual(v.indices(), [...Array(8).keys()]);
  assert.equal(v.api.vsTopPad.value, 0);
  assert.equal(v.videRaf(), 0);
});

// Vue de 900 px en bas de 100 messages estimés : premier message visible, puis début de la fenêtre de lecture.
const PREMIER_EN_BAS = Math.floor((100 * PAS - 900) / PAS);

it("_vsInitTail ouvre sur la FIN de la conversation", async () => {
  const v = monter(100);
  v.api._vsInitTail(100);
  assert.equal(v.at(-1), 99, "le dernier message doit être rendu");
  assert.equal(v.indices().length, 8, "huit messages à la première image");
  await vider();
  const idx = v.indices();
  assert.equal(idx[idx.length - 1], 99);
  assert.equal(idx[0], PREMIER_EN_BAS - TAMPON, "au repos : la vue et la marge de messages au-dessus");
});

it("ouverture : rien avant la première image peinte, puis un message par moment de repos", async () => {
  const v = monter(100);
  v.api._vsInitTail(100);
  assert.equal(fileRepos.size, 0, "rien au repos avant la première image");
  videRaf();
  assert.equal(v.indices().length, 8, "aucun montage dans l'image qui suit");
  for (let attendu = 9; attendu <= 100 - (PREMIER_EN_BAS - TAMPON); attendu++) {
    assert.equal(await repos(), 1);
    assert.equal(v.indices().length, attendu);
    assert.equal(v.at(-1), 99);
  }
  assert.equal(fileRepos.size + file.size, 0, "plus rien de planifié une fois la fenêtre complète");
});

it("ouverture : un repos assez long monte plusieurs messages à la suite", async () => {
  const v = monter(100);
  v.api._vsInitTail(100);
  videRaf();
  tempsRepos = 50;
  assert.equal(await repos(), 1);
  assert.equal(v.indices().length, 100 - (PREMIER_EN_BAS - TAMPON), "tout dans un seul moment de repos");
});

it("ouverture d'un fil de longs messages : les derniers couvrent la marge, rien de plus n'est monté", async () => {
  const v = monter(100, { hauteurLigne: 1500 });
  v.api._vsInitTail(100);
  await vider();
  assert.equal(v.indices().length, 8);
});

it("ouverture : un recalcul sans geste (taille, défilement programmé) ne l'étend pas d'un coup", () => {
  const v = monter(100);
  v.api._vsInitTail(100);
  v.api.onChatScroll();
  videRaf();
  assert.equal(v.indices().length, 8);
});

it("ouverture : un défilement de l'utilisateur la coupe, la fenêtre suit le viewport", async () => {
  const v = monter(100);
  v.api._vsInitTail(100);
  v.refs.isUserScrolling.value = true;
  await v.defiler(50 * PAS);
  assert.equal(v.indices()[0], 50 - TAMPON);
  assert.equal(v.videRaf(), 0, "l'ouverture ne reprend pas derrière le geste");
});

it("ouverture : un message ajouté pendant l'extension est rendu sans étendre la fenêtre d'un coup", async () => {
  const v = monter(100);
  v.api._vsInitTail(100);
  v.refs.messages.value = [...v.refs.messages.value, { role: "assistant", content: "suite" }];
  v.api._vsEnsureTail();
  assert.equal(v.at(-1), 100);
  assert.equal(v.indices().length, 9);
  await vider();
  assert.equal(v.at(-1), 100);
  assert.ok(v.indices().length > 9);
});

it("flux après l'ouverture : seul le message ajouté est monté, la queue ne dépasse pas 25 messages", () => {
  const v = monter(100);
  v.api._vsInitTail(100);
  const msgs = [...v.refs.messages.value];
  for (let k = 0; k < 30; k++) {
    msgs.push({ role: "assistant", content: "r" + k });
    v.refs.messages.value = [...msgs];
    v.api._vsEnsureTail();
    assert.equal(v.at(-1), msgs.length - 1);
    assert.equal(v.indices().length, Math.min(9 + k, TAMPON * 2 + 5));
  }
});

it("retour en bas depuis le haut d'un long fil : les derniers messages seuls dans l'image, la marge au repos après elle", async () => {
  const v = monter(100);
  v.refs.isUserScrolling.value = true;
  await v.defiler(0);
  v.refs.isUserScrolling.value = false;
  v.api._vsEnsureTail();
  assert.deepStrictEqual(v.indices(), [92, 93, 94, 95, 96, 97, 98, 99]);
  assert.equal(v.api.vsBotPad.value, 0);
  assert.equal(fileRepos.size, 0, "rien au repos avant l'image");
  await vider();
  assert.equal(v.indices()[0], PREMIER_EN_BAS - TAMPON, "la marge au-dessus de la vue est montée au repos");
});

it("ouverture : un saut vers un message la termine d'un coup", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const v = monter(20);
  (v.conteneur as unknown as Record<string, unknown>).style = {};
  (v.conteneur as unknown as Record<string, unknown>).querySelector = () => null;
  v.api._vsInitTail(20);
  assert.equal(v.indices().length, 8);
  (v.api as unknown as { scrollToMessage(i: number): void }).scrollToMessage(2);
  assert.deepStrictEqual(v.indices(), [...Array(20).keys()]);
  vi.useRealTimers();
});

it("_vsReset annule une ouverture en vol", () => {
  const v = monter(100);
  v.api._vsInitTail(100);
  v.api._vsReset();
  assert.equal(v.videRaf(), 0);
});

it("_vsInitTail ne laisse AUCUNE cale sous la fenêtre", () => {
  // On ouvre en bas : il n'y a rien après.
  const v = monter(100);
  v.api._vsInitTail(100);
  assert.equal(v.api.vsBotPad.value, 0);
});

it("_vsEnsureTail juste après _vsInitTail garde la fenêtre : pas de second rendu à l'ouverture", () => {
  const v = monter(100);
  v.api._vsInitTail(100);
  const avant = v.api.visibleMessages.value;
  v.api._vsEnsureTail();
  assert.strictEqual(v.api.visibleMessages.value, avant);
});

it("_vsInitTail pose une cale au-dessus égale aux messages sautés", async () => {
  const v = monter(100);
  v.api._vsInitTail(100);
  assert.equal(v.api.vsTopPad.value, (100 - 8) * PAS);
  await vider();
  assert.equal(v.api.vsTopPad.value, (PREMIER_EN_BAS - TAMPON) * PAS);
});

// ── Fenêtrage au scroll ──────────────────────────────────────

it("en haut de la conversation, la fenêtre part du début", () => {
  const v = monter(100);
  v.scroller(0);
  assert.equal(v.indices()[0], 0);
  assert.equal(v.api.vsTopPad.value, 0);
});

it("scroller au milieu déplace la fenêtre sur le viewport", async () => {
  const v = monter(100);
  v.scroller(50 * PAS); // ~message 50
  const idx = v.indices();
  assert.ok(
    idx.includes(50),
    "le message visé doit être rendu dans l'image — reçu " + idx[0] + ".." + idx[idx.length - 1],
  );
  assert.equal(idx[0], 50 - Math.ceil(900 / PAS), "dans l'image : une hauteur de vue au-dessus");
  await vider();
  assert.equal(v.indices()[0], 50 - TAMPON, "au repos : le tampon amont doit être de " + TAMPON);
});

it("la fenêtre englobe le viewport plus un tampon de chaque côté", async () => {
  const v = monter(200);
  await v.defiler(100 * PAS);
  const idx = v.indices();
  const vus = Math.ceil(900 / PAS); // messages tenant dans la vue
  assert.equal(idx[0], 100 - TAMPON);
  assert.ok(idx.length >= vus + TAMPON, "fenêtre trop étroite : " + idx.length);
});

it("une vue plus haute rend plus de messages", async () => {
  const petite = monter(200, { hauteurVue: 400 });
  await petite.defiler(100 * PAS);
  const grande = monter(200, { hauteurVue: 2000 });
  await grande.defiler(100 * PAS);
  assert.ok(grande.indices().length > petite.indices().length);
});

it("remontée d'un fil de longs messages : au repos, la marge haute s'arrête à trois hauteurs de vue", async () => {
  const v = monter(100, { hauteurLigne: 1500 });
  v.api._vsInitTail(100);
  await vider();
  v.refs.isUserScrolling.value = true;
  v.conteneur.scrollTop = v.api.vsTopPad.value + 8 * 1532 - 900;
  for (let k = 0; k < 40; k++) {
    await v.defiler(v.conteneur.scrollTop - 400);
    const marge = v.conteneur.scrollTop - v.api.vsTopPad.value;
    assert.ok(marge >= 900, "marge haute sous une vue au cran " + k + " : " + marge);
    if (k > 25)
      assert.ok(marge >= 3 * 900 && marge < 3 * 900 + 1532, "marge haute au cran " + k + " : " + marge);
  }
  assert.ok(
    v.indices().length < 2 * TAMPON,
    "moins de messages que la marge en nombre : " + v.indices().length,
  );
});

it("un cran de molette dans la marge ne monte rien dans l'image ; le repos la complète", async () => {
  const v = monter(100);
  v.refs.isUserScrolling.value = true;
  await v.defiler(50 * PAS);
  const avant = v.indices();
  v.scroller(50 * PAS - 120);
  assert.deepStrictEqual(v.indices(), avant, "aucun montage dans l'image du cran");
  for (let k = 1; k <= 10; k++) v.scroller(50 * PAS - 120 * k);
  assert.equal(v.indices()[0], avant[0], "toujours rien tant que la marge d'une vue tient");
  assert.ok(fileRepos.size > 0, "le complément est planifié au repos");
  await vider();
  assert.equal(v.indices()[0], Math.floor((50 * PAS - 1200) / PAS) - TAMPON);
});

it("saut en haut d'un fil de messages courts : les lignes mesurées, la vue est couverte avant d'être peinte", async () => {
  const v = monter(100, { hauteurLigne: 50 });
  v.api._vsInitTail(100);
  await vider();
  v.refs.isUserScrolling.value = true;
  v.scroller(0);
  await nextTick();
  await nextTick();
  assert.equal(file.size, 0, "sans image de plus");
  assert.ok(v.indices().length * (50 + 32) >= 900, "bande vide sous les lignes : " + v.indices().length);
});

it("un saut au-delà de la marge ne monte dans l'image que la vue et une hauteur de vue de chaque côté", () => {
  const v = monter(200);
  v.refs.isUserScrolling.value = true;
  v.scroller(150 * PAS);
  const idx = v.indices();
  const vus = Math.ceil(900 / PAS);
  assert.equal(idx[0], 150 - vus);
  assert.ok(idx.length <= 3 * vus + 2, "montés dans l'image : " + idx.length);
});

it("les cales encadrent exactement les messages non rendus", () => {
  const v = monter(100);
  v.scroller(50 * PAS);
  const idx = v.indices();
  assert.equal(v.api.vsTopPad.value, v.at(0) * PAS);
  assert.equal(v.api.vsBotPad.value, (100 - (v.at(-1) + 1)) * PAS);
  assert.ok(idx.length > 0);
});

it("INVARIANT : cale haute + messages rendus + cale basse = hauteur totale", () => {
  // Si cette somme dérive, la barre de défilement ment et le scroll saute.
  for (const px of [0, 10 * PAS, 50 * PAS, 99 * PAS]) {
    const v = monter(100);
    v.scroller(px);
    const rendus = v.indices().length;
    const total = v.api.vsTopPad.value + rendus * PAS + v.api.vsBotPad.value;
    assert.equal(total, 100 * PAS, "à scrollTop=" + px);
  }
});

it("INVARIANT : le dernier message reste rendu quand on est en bas", () => {
  const v = monter(100);
  v.scroller(100 * PAS);
  assert.ok(v.indices().includes(99));
});

// ── LE BUG HISTORIQUE : scrollTop au-delà du total ───────────

it("ÉCRAN BLANC : un scrollTop très au-delà du total garde des messages rendus", () => {
  // Sans le clamp `first >= total`, la fenêtre devient vide : l'écran
  // se vide sans la moindre erreur en console.
  const v = monter(100);
  v.scroller(999999);
  const idx = v.indices();
  assert.ok(idx.length > 0, "la fenêtre est vide : écran blanc");
  assert.ok(idx.includes(99), "le dernier message doit rester rendu");
});

it("ÉCRAN BLANC : le cas survient aussi juste après une suppression de messages", () => {
  // On scrolle en bas d'une longue conversation, puis elle raccourcit.
  const v = monter(100);
  v.scroller(99 * PAS);
  v.refs.messages.value = v.refs.messages.value.slice(0, 40);
  v.scroller(99 * PAS); // scrollTop périmé, bien au-delà du nouveau total
  const idx = v.indices();
  assert.ok(idx.length > 0, "la fenêtre est vide après raccourcissement");
  assert.ok(idx.includes(39), "le nouveau dernier message doit être rendu");
});

it("ÉCRAN BLANC : la garde tient pour TOUTE taille au-dessus du seuil", () => {
  // Le clamp du source est inopérant tant que VS_THRESHOLD (30) reste
  // très au-dessus de VS_BUFFER (10) — cf. l'en-tête. Ce cas vérifie la
  // propriété qui compte vraiment, sur les tailles où le rapport entre
  // les deux constantes est le plus serré.
  for (const total of [SEUIL + 1, SEUIL + 2, SEUIL + 5, 50, 100, 500]) {
    const v = monter(total);
    v.scroller(total * PAS * 10);
    const idx = v.indices();
    assert.ok(idx.length > 0, "fenêtre vide à " + total + " messages : écran blanc");
    assert.ok(idx.includes(total - 1), "le dernier message doit rester rendu à " + total + " messages");
  }
});

it("un scrollTop négatif n'explose pas", () => {
  const v = monter(100);
  v.scroller(-500);
  assert.ok(v.indices().length > 0);
  assert.equal(v.indices()[0], 0);
});

it("sans conteneur monté, la fenêtre reste complète plutôt que vide", () => {
  const v = monter(100, { sansConteneur: true });
  v.api.onChatScroll();
  v.videRaf();
  assert.equal(v.indices().length, 100);
});

// ── Le garde anti-réentrance du rAF ──────────────────────────

it("plusieurs scrolls dans la même frame ne planifient qu'UN recalcul", () => {
  const v = monter(100);
  v.conteneur.scrollTop = 10 * PAS;
  v.api.onChatScroll();
  v.api.onChatScroll();
  v.api.onChatScroll();
  const passes = v.videRaf();
  assert.equal(passes, 1, "le garde _vsRafId doit dédupliquer les scrolls d'une même frame");
});

it("le garde se RÉARME après exécution — les scrolls suivants comptent", () => {
  // C'est le cœur du piège du rAF synchrone : si le garde ne se
  // réarmait pas, tout scroll ultérieur serait ignoré en silence et la
  // fenêtre resterait figée sur son premier calcul.
  const v = monter(100);
  v.scroller(10 * PAS);
  const premier = v.indices()[0];
  v.scroller(60 * PAS);
  const second = v.indices()[0];
  assert.notEqual(second, premier, "la fenêtre n'a pas bougé au second scroll : le garde rAF est resté armé");
  assert.equal(second, 60 - Math.ceil(900 / PAS));
});

it("_vsReset annule un recalcul en vol", () => {
  // Sinon un scroll planifié juste avant un changement de conversation
  // s'exécute APRÈS l'initialisation et mesure l'ancien DOM.
  const v = monter(100);
  v.conteneur.scrollTop = 50 * PAS;
  v.api.onChatScroll();
  v.api._vsReset();
  const passes = v.videRaf();
  assert.equal(passes, 0, "le rAF en vol devait être annulé");
});

// ── lastAssistantIdx ─────────────────────────────────────────

it("lastAssistantIdx pointe le dernier assistant, pas le dernier message", () => {
  const v = monter(0);
  v.refs.messages.value = [{ role: "user" }, { role: "assistant" }, { role: "user" }];
  assert.equal(v.api.lastAssistantIdx.value, 1);
});

it("lastAssistantIdx vaut -1 sans aucun assistant", () => {
  const v = monter(0);
  v.refs.messages.value = [{ role: "user" }];
  assert.equal(v.api.lastAssistantIdx.value, -1);
  v.refs.messages.value = [];
  assert.equal(v.api.lastAssistantIdx.value, -1);
});

// ── Réveils regroupés dans la bulle qu'ils continuent ────────

const REVEIL = { role: "user", origin: "job_wake" };

it("réveils : une seule ligne rendue pour la réponse et sa suite, index absolus gardés", () => {
  const v = monter(0);
  v.refs.messages.value = [
    { role: "user", content: "q" },
    { role: "assistant", content: "lancé" },
    { ...REVEIL, content: "w1" },
    { role: "assistant", content: "r1" },
    { ...REVEIL, content: "w2" },
    { role: "assistant", content: "r2" },
    { role: "user", content: "q2" },
  ];
  const lignes = v.api.visibleMessages.value as unknown as { idx: number; suite?: { idx: number }[] }[];
  assert.deepStrictEqual(
    lignes.map((l) => l.idx),
    [0, 1, 6],
  );
  assert.deepStrictEqual(
    lignes[1]?.suite?.map((s) => s.idx),
    [2, 3, 4, 5],
  );
  assert.equal(lignes[0]?.suite, undefined);
  assert.equal(v.api.lastAssistantIdx.value, 5);
});

it("réveils : entrée stable tant que la bulle ne change pas, nouvelle quand un membre change", () => {
  const v = monter(0);
  v.refs.messages.value = [
    { role: "assistant", content: "lancé" },
    { ...REVEIL, content: "w1" },
    { role: "assistant", content: "r1" },
  ];
  const avant = v.api.visibleMessages.value[0];
  v.refs.messages.value = [...v.refs.messages.value];
  assert.equal(v.api.visibleMessages.value[0], avant, "même bulle : même entrée");
  const msgs = [...v.refs.messages.value];
  msgs[2] = { role: "assistant", content: "r1 complétée" };
  v.refs.messages.value = msgs;
  const apres = v.api.visibleMessages.value[0] as unknown as { suite: { msg: Message }[] };
  assert.notEqual(apres, avant, "membre remplacé : nouvelle entrée (le v-memo de la liste la voit)");
  assert.equal(apres.suite[1]?.msg.content, "r1 complétée");
});

it("réveils, fenêtrage : membres regroupés sans hauteur propre, fenêtre jamais coupée au milieu d'une bulle", async () => {
  const v = monter(100);
  const msgs = [...v.refs.messages.value];
  // 41 = réponse de l'agent ; 42..59 = réveils et réponses qui la continuent.
  for (let i = 42; i < 60; i++) msgs[i] = i % 2 ? { role: "assistant", content: "r" + i } : { ...REVEIL };
  v.refs.messages.value = msgs;
  v.refs.isUserScrolling.value = true;
  for (const px of [0, 30 * PAS, 45 * PAS, 55 * PAS, 99 * PAS]) {
    for (const attendre of [false, true]) {
      if (attendre) await v.defiler(px);
      else v.scroller(px);
      const idx = v.indices();
      assert.ok(!idx.some((i) => i > 41 && i < 60), "un membre regroupé a sa propre ligne à " + px);
      const rendus = idx.length;
      assert.equal(v.api.vsTopPad.value + rendus * PAS + v.api.vsBotPad.value, (100 - 18) * PAS, "à " + px);
    }
  }
  await v.defiler(48 * PAS);
  assert.ok(v.indices().includes(41), "la tête de la bulle est rendue quand la fenêtre tombe dans sa suite");
  v.api._vsInitTail(100);
  assert.equal(v.at(-1), 99);
});

it("réveils, saut vers un membre regroupé : la bulle est rendue et la partie visée amenée en vue", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const partie = { getBoundingClientRect: () => ({ top: 516 }) };
  const v = monter(0);
  v.conteneur.scrollTop = 1000;
  (v.conteneur as unknown as Record<string, unknown>).getBoundingClientRect = () => ({ top: 0 });
  (v.conteneur as unknown as Record<string, unknown>).style = {};
  (v.conteneur as unknown as Record<string, unknown>).querySelector = (sel: string) =>
    sel === '[data-vs-part="3"]' ? partie : null;
  v.refs.messages.value = [
    { role: "user" },
    { role: "assistant" },
    { ...REVEIL },
    { role: "assistant" },
    { role: "user" },
  ];
  (v.api as unknown as { scrollToMessage(i: number): void }).scrollToMessage(3);
  await nextTick();
  assert.equal(v.conteneur.scrollTop, 1500, "la partie visée est ramenée à 16 px du haut");
  vi.useRealTimers();
});

it("réveils : un flush en queue ne relit pas la conversation hors de la fenêtre", () => {
  const v = monter(0);
  const lus = new Set<number>();
  const espion = (m: Message, i: number): Message =>
    new Proxy(m, {
      get(c, k, r) {
        if (k === "role" || k === "origin") lus.add(i);
        return Reflect.get(c, k, r) as unknown;
      },
    });
  v.refs.messages.value = Array.from({ length: 300 }, (_, i) =>
    espion(i === 280 ? { ...REVEIL } : { role: i % 2 ? "assistant" : "user" }, i),
  );
  v.api._vsInitTail(300);
  assert.ok(v.api.visibleMessages.value.length > 0);
  lus.clear();
  v.refs.messages.value[299] = espion({ role: "assistant", content: "flush" }, 299);
  assert.ok(v.api.visibleMessages.value.length > 0);
  assert.ok(
    lus.size > 0 && Math.min(...lus) >= 250,
    "messages relus : " + Math.min(...lus) + ".." + Math.max(...lus),
  );
});
