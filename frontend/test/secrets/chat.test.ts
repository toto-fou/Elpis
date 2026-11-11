// SPDX-License-Identifier: MIT
/** frontend/test/secrets/chat.test.ts — secrets de la conversation : analyse de `/secret`, liste, attach et detach sur un chat existant (PUT, refus en français) et sur un chat neuf (sélection gardée, envoyée avec le premier tour, relue ensuite), puces, chargement d'un chat, menus des noms ; courses : une requête à la fois, puces chargées avant tout calcul, puce périmée relue puis rejouée une fois, réponses d'un autre chat ignorées. */
import { describe, expect, it } from "vitest";
import { ref } from "vue";

import { GestionnaireSession } from "../../src/features/auth/session";
import { creerApiSecrets } from "../../src/features/secrets/api";
import { analyserCommandeSecret, creerSecretsChat } from "../../src/features/secrets/chat";
import { ClientHttp } from "../../src/platform/http/client";
import { fauxServeur, json, refus, secret } from "./aides";
import type { Appel } from "./aides";

const COMPTE = [
  secret(1, { name: "intranet-admin" }),
  secret(2, { name: "proxy-basic", kind: "http-auth", username: "svc" }),
  secret(3, { name: "ax-old", kind: "http-auth", state: "unverified" }),
  secret(4, { name: "gitlab", kind: "git", scope: { host: "gitlab.lan" } }),
];

function monter(chat: string | null, route?: (url: string, methode: string, corps: unknown) => Response) {
  const currentChatId = ref<string | null>(chat);
  const toasts: string[] = [];
  const { api, appels } = fauxServeur(
    route ??
      ((url, methode, corps) => {
        if (url === "/api/secrets") return json({ secrets: COMPTE });
        if (methode === "PUT") {
          const ids = (corps as { ids: number[] }).ids;
          return json({ secrets: COMPTE.filter((s) => ids.includes(s.id)) });
        }
        return json({ secrets: [COMPTE[0]] });
      }),
  );
  const sc = creerSecretsChat({ api, currentChatId, toast: (m) => toasts.push(m) });
  return { sc, appels, currentChatId, toasts };
}

const vers = (appels: readonly Appel[]): string[] => appels.map((a) => `${a.methode} ${a.url}`);

describe("analyse", () => {
  it("verbe en minuscules (vide = liste), noms sans doublon", () => {
    expect(analyserCommandeSecret("")).toEqual({ verbe: "", noms: [] });
    expect(analyserCommandeSecret("  ATTACH a  b a ")).toEqual({ verbe: "attach", noms: ["a", "b"] });
    expect(analyserCommandeSecret("detach --all")).toEqual({ verbe: "detach", noms: ["--all"] });
  });
});

describe("chat existant", () => {
  it("/secret attach : PUT de l'ensemble (ids), puces depuis la réponse", async () => {
    const { sc, appels } = monter("c1");
    const r = await sc.commande.lancer("attach intranet-admin proxy-basic");
    expect(r).toEqual({ ok: true, msg: "Attaché : intranet-admin, proxy-basic." });
    expect(appels.at(-1)).toEqual({ url: "/api/chats/c1/secrets", methode: "PUT", corps: { ids: [1, 2] } });
    expect(sc.attaches.value.map((s) => s.name)).toEqual(["intranet-admin", "proxy-basic"]);
    expect(sc.enAttente()).toBeNull();
  });

  it("secret non vérifié ou d'un autre genre : le refus du serveur est dit en français, puces inchangées", async () => {
    const { sc } = monter("c1", (url, methode) =>
      url === "/api/secrets"
        ? json({ secrets: COMPTE })
        : methode === "PUT"
          ? refus(
              422,
              "secret_unverified",
              "Secret 'ax-old' is unverified: verify it in Settings › Secrets before attaching it.",
            )
          : json({ secrets: [] }),
    );
    expect(await sc.commande.lancer("attach ax-old")).toEqual({
      ok: false,
      msg: "ax-old : unverified, à vérifier dans Paramètres › Secrets.",
    });
    expect(sc.attaches.value).toEqual([]);
  });

  it("nom inconnu : la liste est relue une fois, puis refus sans appel d'attache", async () => {
    const { sc, appels } = monter("c1");
    expect(await sc.commande.lancer("attach nope")).toEqual({ ok: false, msg: "Secret inconnu : nope." });
    expect(vers(appels)).toEqual(["GET /api/secrets", "GET /api/secrets"]);
  });

  it("/secret detach <name> et --all ; un nom non attaché est refusé", async () => {
    const { sc, appels } = monter("c1");
    await sc.commande.lancer("attach intranet-admin proxy-basic");
    expect(await sc.commande.lancer("detach gitlab")).toEqual({ ok: false, msg: "Non attaché : gitlab." });
    expect(await sc.commande.lancer("detach proxy-basic")).toEqual({
      ok: true,
      msg: "Détaché : proxy-basic.",
    });
    expect(appels.at(-1)?.corps).toEqual({ ids: [1] });
    expect(await sc.commande.lancer("detach --all")).toEqual({ ok: true, msg: "Détaché : intranet-admin." });
    expect(appels.at(-1)?.corps).toEqual({ ids: [] });
    expect(await sc.commande.lancer("detach --all")).toEqual({
      ok: true,
      info: true,
      msg: "Aucun secret attaché.",
    });
  });

  it("croix d'une puce : détache ce secret ; refus du serveur en toast", async () => {
    const { sc, appels } = monter("c1");
    await sc.commande.lancer("attach intranet-admin proxy-basic");
    await sc.detacher(1);
    expect(appels.at(-1)?.corps).toEqual({ ids: [2] });
    expect(sc.attaches.value.map((s) => s.id)).toEqual([2]);
    const ko = monter("c1", (url, methode) =>
      methode === "PUT" ? refus(404, "", "chat not found") : json({ secrets: COMPTE }),
    );
    ko.sc.attaches.value = [COMPTE[0]!];
    await ko.sc.detacher(1);
    expect(ko.toasts).toEqual(["chat not found"]);
  });

  it("/secret seul : attachés puis disponibles (web-login et http-auth vérifiés, pas encore attachés)", async () => {
    const { sc } = monter("c1");
    await sc.commande.lancer("attach proxy-basic");
    expect(await sc.commande.lancer("")).toEqual({
      ok: true,
      info: true,
      msg: "Attachés : proxy-basic · disponibles : intranet-admin",
    });
  });

  it("sous-commande inconnue ou nom manquant : usage en une ligne", async () => {
    const { sc } = monter("c1");
    expect(await sc.commande.lancer("ls")).toEqual({
      ok: false,
      msg: "Sous-commande inconnue : ls. attach, detach.",
    });
    expect(await sc.commande.lancer("attach")).toEqual({ ok: false, msg: "Usage : /secret attach <name>…" });
    expect(await sc.commande.lancer("detach")).toEqual({
      ok: false,
      msg: "Usage : /secret detach <name>|--all",
    });
  });
});

describe("chat neuf", () => {
  it("la sélection reste dans le composeur, sans appel d'attache, puis part avec le premier tour", async () => {
    const { sc, appels, currentChatId } = monter(null);
    expect(await sc.commande.lancer("attach intranet-admin")).toEqual({
      ok: true,
      msg: "Attaché : intranet-admin.",
    });
    expect(vers(appels)).toEqual(["GET /api/secrets"]);
    expect(sc.attaches.value.map((s) => s.name)).toEqual(["intranet-admin"]);
    expect(sc.enAttente()).toEqual([1]);
    currentChatId.value = "n1";
    sc.envoyes("n1");
    expect(sc.enAttente()).toBeNull();
    await Promise.resolve();
    expect(vers(appels).at(-1)).toBe("GET /api/chats/n1/secrets");
  });

  it("non vérifié ou genre du coffre non attachable : refus local en une ligne", async () => {
    const { sc } = monter(null);
    expect(await sc.commande.lancer("attach ax-old")).toEqual({
      ok: false,
      msg: "ax-old : unverified, à vérifier dans Paramètres › Secrets.",
    });
    expect(await sc.commande.lancer("attach gitlab")).toEqual({
      ok: false,
      msg: "gitlab : type git, seuls web-login et http-auth s'attachent.",
    });
    expect(sc.attaches.value).toEqual([]);
    expect(sc.enAttente()).toBeNull();
  });

  it("dix secrets au plus par conversation", async () => {
    const beaucoup = Array.from({ length: 11 }, (_, i) => secret(i + 1, { name: `s${i + 1}` }));
    const { sc } = monter(null, () => json({ secrets: beaucoup }));
    const r = await sc.commande.lancer(`attach ${beaucoup.map((s) => s.name).join(" ")}`);
    expect(r).toEqual({ ok: false, msg: "10 secrets au plus par conversation." });
  });

  it("nouveau chat : sélection vidée", async () => {
    const { sc } = monter(null);
    await sc.commande.lancer("attach intranet-admin");
    sc.appliquerDuChat(null, "");
    expect(sc.attaches.value).toEqual([]);
    expect(sc.enAttente()).toBeNull();
  });
});

describe("chargement d'un chat et menus", () => {
  it("chat avec des ids enregistrés : métadonnées relues ; sans ids : aucun appel", async () => {
    const { sc, appels, currentChatId } = monter("c2");
    sc.appliquerDuChat([], "c2");
    expect(appels).toEqual([]);
    sc.appliquerDuChat([1, "x", -2], "c2");
    await Promise.resolve();
    await Promise.resolve();
    expect(vers(appels)).toEqual(["GET /api/chats/c2/secrets"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(sc.attaches.value.map((s) => s.id)).toEqual([1]);
    currentChatId.value = "c3";
    sc.appliquerDuChat([1], "c3");
    expect(sc.attaches.value).toEqual([]);
  });

  it("menus : sous-commandes, puis noms attachables pour attach, --all et attachés pour detach", async () => {
    const { sc } = monter("c1");
    expect(sc.commande.valeurs([]).map((v) => v.value)).toEqual(["attach", "detach"]);
    expect(sc.commande.valeurs(["attach"])).toEqual([]);
    sc.actualiser();
    await new Promise((r) => setTimeout(r, 0));
    expect(sc.commande.valeurs(["attach"]).map((v) => v.value)).toEqual(["intranet-admin", "proxy-basic"]);
    expect(sc.commande.valeurs(["attach", "proxy-basic"]).map((v) => v.value)).toEqual(["intranet-admin"]);
    expect(sc.commande.valeurs(["detach"])).toEqual([]);
    await sc.commande.lancer("attach proxy-basic");
    expect(sc.commande.valeurs(["detach"]).map((v) => v.value)).toEqual(["--all", "proxy-basic"]);
    expect(sc.commande.valeurs(["attach"])[0]).toEqual({
      value: "intranet-admin",
      label: "web-login · https://intranet.example.lan:8443 · user=admin",
      icone: "ph-key",
    });
  });
});

/** Serveur différé : chaque PUT est appliqué à réception, chaque réponse (PUT ou GET) est rendue à la main. */
function serveurDiffere(initial: number[] = [1, 2, 3]) {
  const A = secret(1, { name: "a" });
  const B = secret(2, { name: "b" });
  const C = secret(3, { name: "c" });
  const tous = [A, B, C];
  const vue = (ids: readonly number[]) => tous.filter((s) => ids.includes(s.id));
  let serveur = [...initial];
  const enAttente: Array<() => void> = [];
  const corps: number[][] = [];
  const fetch = (url: string, init?: RequestInit): Promise<Response> => {
    const methode = init?.method ?? "GET";
    if (url === "/api/secrets") return Promise.resolve(json({ secrets: tous }));
    if (methode === "PUT") {
      const ids = (JSON.parse(String(init?.body)) as { ids: number[] }).ids;
      corps.push(ids);
      serveur = ids;
      const vu = [...ids];
      return new Promise((r) => enAttente.push(() => r(json({ secrets: vue(vu) }))));
    }
    const vu = [...serveur];
    return new Promise((r) => enAttente.push(() => r(json({ secrets: vue(vu) }))));
  };
  const api = creerApiSecrets(new ClientHttp(new GestionnaireSession(), fetch));
  /** Rend les réponses en attente une à une jusqu'à ce que plus rien n'arrive. */
  async function toutRendre(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 0));
      const suivante = enAttente.shift();
      if (!suivante) return;
      suivante();
    }
  }
  return { api, corps, enAttente, toutRendre, serveur: () => serveur, tous };
}
const tic = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("courses sur l'ensemble attaché", () => {
  it("deux × rapides : une requête à la fois, la seconde calculée sur la réponse de la première ; serveur et puces d'accord", async () => {
    const s = serveurDiffere();
    const sc = creerSecretsChat({ api: s.api, currentChatId: ref("c1"), toast: () => undefined });
    sc.attaches.value = s.tous;
    const p1 = sc.detacher(1);
    const p2 = sc.detacher(2);
    await tic();
    expect(s.corps).toEqual([[2, 3]]);
    await s.toutRendre();
    await Promise.all([p1, p2]);
    expect(s.corps).toEqual([[2, 3], [3]]);
    expect(s.serveur()).toEqual([3]);
    expect(sc.attaches.value.map((x) => x.id)).toEqual([3]);
  });

  it("attach pendant la lecture des puces d'un chat ouvert : calculé sur les puces chargées, rien de détaché en silence", async () => {
    const s = serveurDiffere([1, 2]);
    const currentChatId = ref<string | null>("c1");
    const sc = creerSecretsChat({ api: s.api, currentChatId, toast: () => undefined });
    sc.appliquerDuChat([1, 2], "c1");
    const r = sc.commande.lancer("attach c");
    await tic();
    expect(s.corps).toEqual([]);
    await s.toutRendre();
    expect(await r).toEqual({ ok: true, msg: "Attaché : c." });
    expect(s.corps).toEqual([[1, 2, 3]]);
    expect(s.serveur()).toEqual([1, 2, 3]);
    expect(sc.attaches.value.map((x) => x.id)).toEqual([1, 2, 3]);
  });

  it("/secret detach pendant la lecture des puces : le nom est cherché dans les puces chargées", async () => {
    const s = serveurDiffere([1, 2]);
    const sc = creerSecretsChat({ api: s.api, currentChatId: ref("c1"), toast: () => undefined });
    sc.appliquerDuChat([1, 2], "c1");
    const r = sc.commande.lancer("detach b");
    await s.toutRendre();
    expect(await r).toEqual({ ok: true, msg: "Détaché : b." });
    expect(s.serveur()).toEqual([1]);
    expect(sc.attaches.value.map((x) => x.id)).toEqual([1]);
  });

  it("puce dont le secret a été supprimé ailleurs : l'ensemble est relu puis le détachement rejoué une fois", async () => {
    const A = secret(1, { name: "a" });
    const B = secret(2, { name: "b" });
    const toasts: string[] = [];
    const appels: string[] = [];
    const fetch = (url: string, init?: RequestInit): Promise<Response> => {
      const methode = init?.method ?? "GET";
      appels.push(`${methode} ${url}`);
      if (methode === "PUT") {
        const ids = (JSON.parse(String(init?.body)) as { ids: number[] }).ids;
        return Promise.resolve(
          ids.includes(2)
            ? refus(404, "secret_unknown", "No secret with id 2.")
            : json({ secrets: [A].filter((x) => ids.includes(x.id)) }),
        );
      }
      return Promise.resolve(json({ secrets: [A] }));
    };
    const api = creerApiSecrets(new ClientHttp(new GestionnaireSession(), fetch));
    const sc = creerSecretsChat({ api, currentChatId: ref("c1"), toast: (m) => toasts.push(m) });
    sc.attaches.value = [A, B];
    await sc.detacher(1);
    expect(appels).toEqual([
      "PUT /api/chats/c1/secrets",
      "GET /api/chats/c1/secrets",
      "PUT /api/chats/c1/secrets",
    ]);
    expect(toasts).toEqual([]);
    expect(sc.attaches.value).toEqual([]);
  });

  it("refus arrivé après un changement de chat : ni « Attaché » ni erreur, puces du nouveau chat intactes", async () => {
    const currentChatId = ref<string | null>("c1");
    let liberer: (() => void) | null = null;
    const fetch = (url: string, init?: RequestInit): Promise<Response> => {
      if ((init?.method ?? "GET") === "PUT")
        return new Promise(
          (r) => (liberer = () => r(refus(422, "secret_unverified", "Secret 'a' is unverified"))),
        );
      return Promise.resolve(json({ secrets: [secret(1, { name: "a" })] }));
    };
    const api = creerApiSecrets(new ClientHttp(new GestionnaireSession(), fetch));
    const sc = creerSecretsChat({ api, currentChatId, toast: () => undefined });
    const r = sc.commande.lancer("attach a");
    await tic();
    currentChatId.value = "c2";
    sc.appliquerDuChat([], "c2");
    liberer!();
    expect(await r).toEqual({ ok: false, silent: true });
    expect(sc.attaches.value).toEqual([]);
  });

  it("lecture des puces d'un chat quitté : réponse ignorée", async () => {
    const s = serveurDiffere([1]);
    const currentChatId = ref<string | null>("c1");
    const sc = creerSecretsChat({ api: s.api, currentChatId, toast: () => undefined });
    sc.appliquerDuChat([1], "c1");
    await tic();
    currentChatId.value = "c2";
    sc.appliquerDuChat([], "c2");
    await s.toutRendre();
    expect(sc.attaches.value).toEqual([]);
  });

  it("puces illisibles à l'ouverture d'un chat : relues avant tout calcul ; toujours illisibles, refus sans PUT", async () => {
    const tous = [secret(1, { name: "a" }), secret(2, { name: "b" }), secret(3, { name: "c" })];
    let lisible = false;
    const appels: string[] = [];
    const fetch = (url: string, init?: RequestInit): Promise<Response> => {
      const methode = init?.method ?? "GET";
      appels.push(`${methode} ${url}`);
      if (url === "/api/secrets") return Promise.resolve(json({ secrets: tous }));
      if (methode === "PUT") {
        const ids = (JSON.parse(String(init?.body)) as { ids: number[] }).ids;
        return Promise.resolve(json({ secrets: tous.filter((x) => ids.includes(x.id)) }));
      }
      return Promise.resolve(lisible ? json({ secrets: tous.slice(0, 2) }) : refus(500, "x", "boom"));
    };
    const api = creerApiSecrets(new ClientHttp(new GestionnaireSession(), fetch));
    const sc = creerSecretsChat({ api, currentChatId: ref("c1"), toast: () => undefined });
    sc.appliquerDuChat([1, 2], "c1");
    expect(await sc.commande.lancer("attach c")).toEqual({ ok: false, msg: "boom" });
    expect(await sc.commande.lancer("")).toEqual({ ok: false, msg: "boom" });
    expect(appels.filter((a) => a.startsWith("PUT"))).toEqual([]);
    lisible = true;
    expect(await sc.commande.lancer("attach c")).toEqual({ ok: true, msg: "Attaché : c." });
    expect(sc.attaches.value.map((x) => x.id)).toEqual([1, 2, 3]);
  });
});
