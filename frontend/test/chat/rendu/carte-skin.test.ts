// SPDX-License-Identifier: MIT
/** frontend/test/chat/rendu/carte-skin.test.ts — carte ```elpis-skin : vérification unique, états, import désactivé sur erreur, remplacement, demande de correction, repli hors réponse finale. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/platform/vendor", () => ({
  ensureVendor: () => Promise.reject(new Error("Chargement impossible")),
}));
import { enrichirBlocs } from "../../../src/features/chat/rendu/enrichissement";
import {
  apercuSkin,
  configurerSkinsPerso,
  EVT_SKIN_CORRECTION,
  EVT_SKINS_PERSO,
  fermerApercuSkin,
} from "../../../src/features/reglages/skins-perso";
import { json } from "../../aides";

const BLOC = '{"id":"mon-style","label":"Mon style","tokens":{"light":{"--accent":"#123456"}}}';
const RAPPORT = { ok: true, erreurs: [], avertissements: [], contrastes: [], css: "body.elpis-skin-perso{}" };
const ECHEC = {
  ...RAPPORT,
  ok: false,
  erreurs: ["Contraste insuffisant (clair) : --text-900 / --surface = 2:1, 4.5:1 exigé."],
  contrastes: [{ paire: "--text-900 / --surface", mode: "light", ratio: 2, seuil: 4.5, ok: false }],
};
const SKIN = {
  id: "mon-style",
  label: "Mon style",
  desc: "",
  darkBase: false,
  sw: [],
  builtin: false,
  perso: true,
  css_url: "/x",
};

let appels: string[] = [];
let verifier: Response;
let importer: () => Response;

function corps(texte: string, parent: Element = document.body): HTMLElement {
  const el = document.createElement("div");
  el.className = "markdown-body";
  const code = document.createElement("code");
  code.className = "language-elpis-skin";
  code.textContent = texte;
  const pre = document.createElement("pre");
  pre.appendChild(code);
  el.appendChild(pre);
  parent.appendChild(el);
  return el;
}
const attendre = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const bouton = (el: Element, texte: string): HTMLButtonElement =>
  [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(texte)) as HTMLButtonElement;

beforeEach(() => {
  appels = [];
  verifier = json(RAPPORT);
  importer = () => json({ ok: true, remplace: false, skin: SKIN, rapport: RAPPORT });
  configurerSkinsPerso(async (url) => {
    appels.push(url);
    return url.endsWith("/verifier") ? verifier.clone() : importer();
  });
});
afterEach(() => {
  document.body.innerHTML = "";
  fermerApercuSkin();
});

describe("carte elpis-skin", () => {
  it("bloc valide : Valide, trois boutons actifs, une seule vérification par contenu", async () => {
    const a = corps(BLOC);
    enrichirBlocs(a);
    expect(a.querySelector("[data-carte-skin]")).not.toBeNull();
    expect(a.textContent).toContain("Mon style");
    await attendre();
    expect(a.textContent).toContain("Valide");
    expect(bouton(a, "Importer").disabled).toBe(false);
    expect(bouton(a, "Importer et appliquer").disabled).toBe(false);
    expect(bouton(a, "Demander une correction")).toBeUndefined();
    const b = corps(BLOC);
    enrichirBlocs(b);
    await attendre();
    expect(appels.filter((u) => u.endsWith("/verifier")).length).toBe(1);
  });

  it("erreurs : compte, import désactivé, correction envoyée", async () => {
    verifier = json(ECHEC);
    const a = corps(BLOC.replace("mon-style", "style-ko"));
    enrichirBlocs(a);
    await attendre();
    expect(a.textContent).toContain("1 problème");
    expect(a.textContent).toContain("Contraste insuffisant");
    expect(bouton(a, "Importer").disabled).toBe(true);
    expect(bouton(a, "Importer et appliquer").disabled).toBe(true);
    const textes: unknown[] = [];
    const ecoute = (e: Event): number => textes.push((e as CustomEvent).detail.texte);
    window.addEventListener(EVT_SKIN_CORRECTION, ecoute);
    bouton(a, "Demander une correction").click();
    window.removeEventListener(EVT_SKIN_CORRECTION, ecoute);
    expect(String(textes[0])).toContain("--text-900 / --surface (clair) : 2:1, 4.5:1 exigé");
  });

  it("bloc illisible : « Demander une correction » propose un texte, rien n'est envoyé", () => {
    const a = corps("{pas du json");
    enrichirBlocs(a);
    const textes: string[] = [];
    const ecoute = (e: Event): number => textes.push((e as CustomEvent).detail.texte);
    window.addEventListener(EVT_SKIN_CORRECTION, ecoute);
    bouton(a, "Demander une correction").click();
    window.removeEventListener(EVT_SKIN_CORRECTION, ecoute);
    expect(textes[0]).toContain("n'est pas lisible");
    expect(appels).toEqual([]);
  });

  it("JSON invalide : carte en erreur lisible, aucun appel réseau", () => {
    const a = corps("{pas du json");
    enrichirBlocs(a);
    expect(a.textContent).toContain("Bloc illisible");
    expect(a.textContent).toContain("JSON invalide");
    expect(appels).toEqual([]);
  });

  it("le contenu du modèle n'est jamais inséré en HTML", async () => {
    const a = corps('{"id":"x","label":"<img src=x onerror=alert(1)>","tokens":{}}');
    enrichirBlocs(a);
    await attendre();
    expect(a.querySelector("img")).toBeNull();
    expect(a.textContent).toContain("<img src=x");
  });

  it("Importer et appliquer : POST puis événement avec l'id perso:", async () => {
    const a = corps(BLOC.replace("mon-style", "style-ok"));
    enrichirBlocs(a);
    await attendre();
    const vus: unknown[] = [];
    const ecoute = (e: Event): number => {
      (e as CustomEvent).detail.promesse = Promise.resolve(true);
      return vus.push((e as CustomEvent).detail.appliquer);
    };
    window.addEventListener(EVT_SKINS_PERSO, ecoute);
    bouton(a, "Importer et appliquer").click();
    await attendre();
    await attendre();
    window.removeEventListener(EVT_SKINS_PERSO, ecoute);
    expect(vus).toEqual(["perso:mon-style"]);
    expect(a.textContent).toContain("Habillage importé et appliqué.");
  });

  it("409 existe déjà : propose Remplacer, qui renvoie overwrite", async () => {
    importer = () => json({ detail: "L'habillage « mon-style » existe déjà." }, 409);
    const a = corps(BLOC.replace("mon-style", "style-409"));
    enrichirBlocs(a);
    await attendre();
    bouton(a, "Importer").click();
    await attendre();
    await attendre();
    expect(a.textContent).toContain("existe déjà");
    importer = () => json({ ok: true, remplace: true, skin: SKIN, rapport: RAPPORT });
    bouton(a, "Remplacer").click();
    await attendre();
    await attendre();
    expect(a.textContent).toContain("Habillage remplacé.");
  });

  it("Prévisualiser ouvre la modale partagée avec la feuille du serveur", async () => {
    const a = corps(BLOC.replace("mon-style", "style-pv"));
    enrichirBlocs(a);
    await attendre();
    bouton(a, "Prévisualiser").click();
    expect(apercuSkin.value?.css).toBe(RAPPORT.css);
    expect(apercuSkin.value?.corps?.id).toBe("style-pv");
  });

  it("hors réponse finale : simple mention, pas de carte ni d'appel", () => {
    const zone = document.createElement("div");
    zone.setAttribute("data-sans-graphiques", "");
    document.body.appendChild(zone);
    const a = corps(BLOC, zone);
    enrichirBlocs(a);
    expect(a.querySelector("[data-carte-skin]")).toBeNull();
    expect(a.textContent).toContain("habillage dans la réponse");
    expect(appels).toEqual([]);
  });
});
