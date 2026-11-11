// SPDX-License-Identifier: MIT
/** frontend/test/chat/liste/defilement-virtuel.test.ts — fenêtrage des longues conversations : seuil, fenêtre initiale, marge, cales, écran blanc évité, garde du rAF (file manuelle), dernier assistant. */
import { strict as assert } from "node:assert";
import { computed, nextTick, ref, watch } from "vue";
import { afterEach, beforeEach, it, vi } from "vitest";

import { creerDefilementVirtuel } from "../../../src/features/chat/liste/defilement-virtuel";
import type { MessageListe } from "../../../src/features/chat/liste/defilement-virtuel";

const SEUIL = 30;
const TAMPON = 10;
const PAS = 180 + 32;

/** rAF en FILE vidée explicitement : un rAF synchrone laisserait le garde armé et le test vert sans rien tester. */
let file = new Map<number, FrameRequestCallback>();
let prochain = 0;
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

beforeEach(() => {
  file = new Map();
  prochain = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    prochain += 1;
    file.set(prochain, cb);
    return prochain;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => file.delete(id));
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
}

function monter(nbMessages: number, o: Options = {}) {
  const conteneur = {
    scrollTop: o.scrollTop || 0,
    clientHeight: o.hauteurVue !== undefined ? o.hauteurVue : 900,
    querySelectorAll: () => [],
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
  return {
    api: a,
    refs,
    conteneur,
    scroller(px: number) {
      conteneur.scrollTop = px;
      a.onChatScroll();
      videRaf();
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

it("_vsInitTail sous le seuil : les 8 derniers à la première image, tout et sans cale à la suivante", () => {
  const v = monter(10);
  v.api._vsInitTail(10);
  assert.deepStrictEqual(v.indices(), [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(v.api.vsTopPad.value, 2 * PAS);
  v.videRaf();
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

it("_vsInitTail ouvre sur la FIN de la conversation", () => {
  const v = monter(100);
  v.api._vsInitTail(100);
  assert.equal(v.at(-1), 99, "le dernier message doit être rendu");
  assert.equal(v.indices().length, 8, "huit messages à la première image");
  v.videRaf();
  const idx = v.indices();
  assert.equal(idx[idx.length - 1], 99);
  assert.equal(idx.length, TAMPON * 2 + 5, "fenêtre finale de 2×tampon + 5");
  assert.equal(idx[0], 100 - (TAMPON * 2 + 5));
});

it("ouverture : rien avant la première image peinte, puis six messages de plus par image", () => {
  const v = monter(100);
  v.api._vsInitTail(100);
  for (const attendu of [8, 14, 20, 25]) {
    videRaf(1);
    assert.equal(v.indices().length, attendu);
    assert.equal(v.at(-1), 99);
  }
  assert.equal(v.videRaf(), 0, "plus rien de planifié une fois la queue complète");
});

it("ouverture : un recalcul sans geste (taille, défilement programmé) ne l'étend pas d'un coup", () => {
  const v = monter(100);
  v.api._vsInitTail(100);
  v.api.onChatScroll();
  videRaf(1);
  assert.equal(v.indices().length, 8);
});

it("ouverture : un défilement de l'utilisateur la coupe, la fenêtre suit le viewport", () => {
  const v = monter(100);
  v.api._vsInitTail(100);
  v.refs.isUserScrolling.value = true;
  v.scroller(50 * PAS);
  assert.equal(v.indices()[0], 50 - TAMPON);
  assert.equal(v.videRaf(), 0, "l'ouverture ne reprend pas derrière le geste");
});

it("ouverture : un message ajouté pendant l'extension est rendu sans étendre la fenêtre d'un coup", () => {
  const v = monter(100);
  v.api._vsInitTail(100);
  v.refs.messages.value = [...v.refs.messages.value, { role: "assistant", content: "suite" }];
  v.api._vsEnsureTail();
  assert.equal(v.at(-1), 100);
  assert.equal(v.indices().length, 9);
  v.videRaf();
  assert.equal(v.at(-1), 100);
  assert.ok(v.indices().length >= TAMPON * 2 + 5);
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

it("_vsInitTail pose une cale au-dessus égale aux messages sautés", () => {
  const v = monter(100);
  v.api._vsInitTail(100);
  assert.equal(v.api.vsTopPad.value, (100 - 8) * PAS);
  v.videRaf();
  assert.equal(v.api.vsTopPad.value, (100 - (TAMPON * 2 + 5)) * PAS);
});

// ── Fenêtrage au scroll ──────────────────────────────────────

it("en haut de la conversation, la fenêtre part du début", () => {
  const v = monter(100);
  v.scroller(0);
  assert.equal(v.indices()[0], 0);
  assert.equal(v.api.vsTopPad.value, 0);
});

it("scroller au milieu déplace la fenêtre sur le viewport", () => {
  const v = monter(100);
  v.scroller(50 * PAS); // ~message 50
  const idx = v.indices();
  assert.ok(
    idx.includes(50),
    "le message visé doit être rendu — reçu " + idx[0] + ".." + idx[idx.length - 1],
  );
  assert.equal(idx[0], 50 - TAMPON, "le tampon amont doit être de " + TAMPON);
});

it("la fenêtre englobe le viewport plus un tampon de chaque côté", () => {
  const v = monter(200);
  v.scroller(100 * PAS);
  const idx = v.indices();
  const vus = Math.ceil(900 / PAS); // messages tenant dans la vue
  assert.equal(idx[0], 100 - TAMPON);
  assert.ok(idx.length >= vus + TAMPON, "fenêtre trop étroite : " + idx.length);
});

it("une vue plus haute rend plus de messages", () => {
  const petite = monter(200, { hauteurVue: 400 });
  petite.scroller(100 * PAS);
  const grande = monter(200, { hauteurVue: 2000 });
  grande.scroller(100 * PAS);
  assert.ok(grande.indices().length > petite.indices().length);
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
  assert.equal(second, 60 - TAMPON);
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

it("réveils, fenêtrage : membres regroupés sans hauteur propre, fenêtre jamais coupée au milieu d'une bulle", () => {
  const v = monter(100);
  const msgs = [...v.refs.messages.value];
  // 41 = réponse de l'agent ; 42..59 = réveils et réponses qui la continuent.
  for (let i = 42; i < 60; i++) msgs[i] = i % 2 ? { role: "assistant", content: "r" + i } : { ...REVEIL };
  v.refs.messages.value = msgs;
  for (const px of [0, 30 * PAS, 45 * PAS, 55 * PAS, 99 * PAS]) {
    v.scroller(px);
    const idx = v.indices();
    assert.ok(!idx.some((i) => i > 41 && i < 60), "un membre regroupé a sa propre ligne à " + px);
    const rendus = idx.length;
    assert.equal(v.api.vsTopPad.value + rendus * PAS + v.api.vsBotPad.value, (100 - 18) * PAS, "à " + px);
  }
  v.scroller(48 * PAS);
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
