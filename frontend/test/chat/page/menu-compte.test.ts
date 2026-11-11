// SPDX-License-Identifier: MIT
/** frontend/test/chat/page/menu-compte.test.ts — menu du compte dans le pied du volet : nom et rôle, Aide, Informations, Installer opencode, Se déconnecter ; rail réduit. */
import { nextTick } from "vue";
import type { InjectionKey } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import BarreLaterale from "../../../src/components/chat/page/BarreLaterale.vue";
import { libelleRole, positionCompte } from "../../../src/features/chat/page/compte";
import { CLE_BARRE } from "../../../src/features/chat/page/domaines";
import { barre, demonter, monter, noms } from "./montage";

afterEach(demonter);

const cle = CLE_BARRE as InjectionKey<object>;
const texte = (e: Element | null | undefined): string => (e?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("rôle et position", () => {
  it("rôle lisible ; menu au-dessus du bouton (volet) ou à sa droite (rail)", () => {
    expect(libelleRole({ is_admin: 1 })).toBe("Administrateur");
    expect(libelleRole({ is_admin: true })).toBe("Administrateur");
    expect(libelleRole({ is_admin: 0, role: "moderator" })).toBe("Modérateur");
    expect(libelleRole({ is_admin: false, role: "user" })).toBe("Utilisateur");
    const r = { left: 12, right: 44, top: 850, bottom: 882 } as DOMRect;
    expect(positionCompte(r, false, 900)).toEqual({ left: "12px", bottom: "56px" });
    expect(positionCompte(r, true, 900)).toEqual({ left: "52px", bottom: "18px" });
  });
});

describe("pied du volet", () => {
  it("le nom ouvre le menu du compte ; le pied garde notifications, Paramètres, Admin", async () => {
    const b = barre({ user: { username: "alice", is_admin: 1 }, features: { opencode: true } });
    const hote = monter(BarreLaterale, [[cle, b]]);
    const pied = hote.querySelector(".elpis-rail-foot:last-child") as HTMLElement;
    expect(pied.querySelector('button[title="Déconnexion"]')).toBeNull();
    expect(pied.querySelector('button[title="Paramètres"]')).not.toBeNull();
    expect(pied.querySelector('button[title="Administration"]')).not.toBeNull();
    const bouton = pied.querySelector("[data-menu-compte]") as HTMLButtonElement;
    expect(bouton.getAttribute("aria-label")).toBe("Compte : alice");
    expect(texte(bouton)).toContain("alice");
    bouton.click();
    await nextTick();
    await nextTick();
    const menu = document.querySelector('[role="menu"][aria-label="Compte"]') as HTMLElement;
    expect(texte(menu.querySelector("[data-compte-identite]"))).toBe("aliceAdministrateur");
    const items = [...menu.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
    expect(items.map(texte)).toEqual(["Aide", "Informations", "Installer opencode", "Se déconnecter"]);
    expect(document.activeElement).toBe(items[0]);
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
    items[1]?.click();
    expect(b.showInfoModal).toBe(true);
    await nextTick();
    bouton.click();
    await nextTick();
    (document.querySelector("[data-compte-sortie]") as HTMLElement).click();
    expect(noms()).toContain("logout");
  });

  it("Échap ferme et rend le focus ; sans opencode, pas d'installation", async () => {
    const hote = monter(BarreLaterale, [[cle, barre()]]);
    const bouton = hote.querySelector("[data-menu-compte]") as HTMLButtonElement;
    bouton.click();
    await nextTick();
    const menu = document.querySelector('[role="menu"][aria-label="Compte"]') as HTMLElement;
    expect(menu.textContent).not.toContain("opencode");
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(bouton.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(bouton);
  });

  it("rail réduit : l'avatar ouvre le même menu, plus de bouton Déconnexion", async () => {
    const hote = monter(BarreLaterale, [[cle, barre({ showSidebar: false })]]);
    const rail = hote.querySelector("aside > div") as HTMLElement;
    expect(rail.querySelector('button[title="Déconnexion"]')).toBeNull();
    (rail.querySelector("[data-menu-compte]") as HTMLElement).click();
    await nextTick();
    expect(document.querySelector('[role="menu"][aria-label="Compte"]')).not.toBeNull();
    expect(noms()).not.toContain("showSidebar");
  });
});
