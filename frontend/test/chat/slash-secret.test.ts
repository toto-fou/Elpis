// SPDX-License-Identifier: MIT
/** frontend/test/chat/slash-secret.test.ts — commande /secret dans le menu « / » : sous-commandes avec leurs indications, complétion des noms (attach : disponibles ; detach : --all puis attachés), lancement par le menu ou par Entrée, liste par « /secret » seul. */
import * as Vue from "vue";
import { afterEach, describe, expect, it } from "vitest";

import { creerMenuSlash } from "../../src/features/chat/composeur/slash";
import type { CtxSlash, SecretSlash, ValeurArgument } from "../../src/features/chat/composeur/slash";
import { creerSecretsChat } from "../../src/features/secrets/chat";
import { fauxServeur, json, secret } from "../secrets/aides";

afterEach(() => {
  document.body.innerHTML = "";
});

const COMPTE = [
  secret(1, { name: "intranet-admin" }),
  secret(2, { name: "proxy-basic", kind: "http-auth" }),
  secret(3, { name: "gitlab", kind: "git", scope: { host: "gitlab.lan" } }),
];

function monter(chat: string | null = "c1") {
  const ta = document.createElement("textarea");
  document.body.appendChild(ta);
  const inputRef = Vue.ref<HTMLTextAreaElement | null>(ta);
  const inputMessage = Vue.ref("");
  const toasts: { m: string; t?: string }[] = [];
  const { api, appels } = fauxServeur((url, methode, corps) => {
    if (url === "/api/secrets") return json({ secrets: COMPTE });
    const ids = methode === "PUT" ? (corps as { ids: number[] }).ids : [];
    return json({ secrets: COMPTE.filter((s) => ids.includes(s.id)) });
  });
  const sc = creerSecretsChat({ api, currentChatId: Vue.ref(chat), toast: () => undefined });
  const ctx: CtxSlash = {
    fetchAuth: () => Promise.resolve(null),
    showToast: (m, t) => toasts.push({ m, t }),
    secrets: sc.commande as SecretSlash,
  };
  const menu = creerMenuSlash(Vue, { inputRef, inputMessage }, ctx);
  const taper = (texte: string): void => {
    inputMessage.value = texte;
    ta.value = texte;
    ta.setSelectionRange(texte.length, texte.length);
    menu.onInput();
  };
  return { menu, taper, toasts, inputMessage, sc, appels };
}

const valeurs = (b: ReturnType<typeof monter>): string[] =>
  (b.menu.slashList.value as readonly ValeurArgument[]).map((v) => v.value);
const attendre = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("/secret : menu", () => {
  it("proposée avec son icône de clé ; absente sans module de secrets", () => {
    const b = monter();
    b.taper("/sec");
    expect(b.menu.slashList.value[0]).toMatchObject({ name: "secret", icon: "ph-key" });
    const sans = creerMenuSlash(
      Vue,
      { inputRef: Vue.ref(null), inputMessage: Vue.ref("") },
      { fetchAuth: () => Promise.resolve(null), showToast: () => undefined },
    );
    expect(sans.slashResolve("/secret attach x")).toBeNull();
  });

  it("« /secret » puis espace : attach (name…) et detach (name|--all), en-tête Secrets", () => {
    const b = monter();
    b.taper("/secret ");
    expect(b.menu.slashLevel.value).toBe("values");
    expect(valeurs(b)).toEqual(["attach", "detach"]);
    expect(b.menu.slashList.value[0]).toMatchObject({ indice: "name…", label: "Attacher à la conversation" });
    expect(b.menu.slashList.value[1]).toMatchObject({ indice: "name|--all" });
    expect(b.menu.slashHeaderLabel.value).toBe("Secrets");
  });

  it("attach : noms attachables (ni git, ni déjà attachés), filtrés par la frappe ; le choix attache aussitôt", async () => {
    const b = monter();
    b.taper("/secret attach ");
    await attendre();
    b.taper("/secret attach ");
    expect(valeurs(b)).toEqual(["intranet-admin", "proxy-basic"]);
    expect(b.menu.slashHeaderLabel.value).toBe("Secrets à attacher");
    expect(b.menu.slashHeaderCmd.value).toBe("/secret attach");
    b.taper("/secret attach prox");
    expect(valeurs(b)).toEqual(["proxy-basic"]);
    await b.menu.selectSlash(b.menu.slashList.value[0]);
    await attendre();
    expect(b.appels.at(-1)).toEqual({ url: "/api/chats/c1/secrets", methode: "PUT", corps: { ids: [2] } });
    expect(b.inputMessage.value).toBe("");
    expect(b.toasts).toEqual([{ m: "Attaché : proxy-basic.", t: "success" }]);
    b.taper("/secret attach ");
    expect(valeurs(b)).toEqual(["intranet-admin"]);
  });

  it("detach : --all puis les attachés ; « --all » détache tout", async () => {
    const b = monter();
    await b.sc.commande.lancer("attach intranet-admin proxy-basic");
    b.taper("/secret detach ");
    expect(valeurs(b)).toEqual(["--all", "intranet-admin", "proxy-basic"]);
    expect(b.menu.slashHeaderLabel.value).toBe("Secrets attachés");
    await b.menu.selectSlash(b.menu.slashList.value[0]);
    await attendre();
    expect(b.appels.at(-1)?.corps).toEqual({ ids: [] });
    expect(b.sc.attaches.value).toEqual([]);
  });

  it("commande tapée en entier puis Entrée : plusieurs noms attachés d'un coup", async () => {
    const b = monter();
    const coup = b.menu.slashResolve("/secret attach intranet-admin proxy-basic");
    expect(coup?.cmd.name).toBe("secret");
    await b.menu.slashRun(coup);
    expect(b.appels.at(-1)?.corps).toEqual({ ids: [1, 2] });
  });

  it("« /secret » validé tel quel : liste en un toast d'information", async () => {
    const b = monter();
    b.taper("/secret");
    expect(b.menu.slashList.value[0]).toMatchObject({ name: "secret" });
    await b.menu.selectSlash(b.menu.slashList.value[0]);
    await attendre();
    expect(b.toasts).toEqual([
      { m: "Attachés : aucun · disponibles : intranet-admin, proxy-basic", t: "info" },
    ]);
  });
});
