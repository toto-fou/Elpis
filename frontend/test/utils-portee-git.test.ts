// SPDX-License-Identifier: MIT
/** frontend/test/utils-portee-git.test.ts — portée d'un compte git côté interface : mêmes chemins et même couverture que le serveur, saisie « hôte/chemin », niveaux d'un dépôt, compte qui sert une URL, portée proposée pour des identifiants saisis. */
import { describe, expect, it } from "vitest";

import {
  cheminCouvre,
  cheminDepot,
  cibleCompte,
  compteCouvrant,
  depotDeLUrl,
  lirePortee,
  niveauxPortee,
  porteeDesSaisis,
} from "../src/utils/portee-git";

const c = (id: number, host: string, path: string | null) => ({ id, host, path });

describe("portée d'un compte git", () => {
  it("chemin : segments simples en minuscules, sans `.git` ; vide = tout l'hôte ; illisible = null (comme le serveur)", () => {
    expect(cheminDepot("")).toBe("");
    expect(cheminDepot("/Acme/API.git/")).toBe("acme/api");
    expect(cheminDepot("scm/~bob/outils")).toBe("scm/~bob/outils");
    for (const brut of ["a//b", "a/../b", "a b", "a%2fb", "a/b?x=1", "a/b/c/d/e/f/g/h/i", "é"])
      expect(cheminDepot(brut), brut).toBeNull();
    expect(cheminCouvre("", null)).toBe(true);
    expect(cheminCouvre("acme", "acme/api")).toBe(true);
    expect(cheminCouvre("acme", "acme-corp/api")).toBe(false);
    expect(cheminCouvre("acme/api", "acme")).toBe(false);
    expect(cheminCouvre("acme", null)).toBe(false);
  });

  it("affichage et niveaux : `hôte` ou `hôte/chemin` ; un dépôt propose l'hôte, puis chaque parent, puis lui-même", () => {
    expect(cibleCompte(c(1, "github.com", ""))).toBe("github.com");
    expect(cibleCompte(c(1, "github.com", null))).toBe("github.com");
    expect(cibleCompte(c(1, "github.com", "acme/api"))).toBe("github.com/acme/api");
    expect(niveauxPortee("g/sous/depot")).toEqual(["", "g", "g/sous", "g/sous/depot"]);
    expect(niveauxPortee(null)).toEqual([""]);
    expect(niveauxPortee("")).toEqual([""]);
  });

  it("saisie « S'applique à » : hôte seul, hôte et chemin, URL collée ; espace, hôte vide ou chemin douteux : null", () => {
    expect(lirePortee("GitHub.com")).toEqual({ host: "github.com", path: "" });
    expect(lirePortee(" forge.lan:3000/Equipe/Depot.git ")).toEqual({
      host: "forge.lan:3000",
      path: "equipe/depot",
    });
    expect(lirePortee("https://u:p@Forge.lan/Equipe")).toEqual({ host: "forge.lan", path: "equipe" });
    for (const brut of ["", "/acme", "github.com/a b", "git hub.com", "github.com/a/../b", "u@github.com/x"])
      expect(lirePortee(brut), brut).toBeNull();
  });

  it("URL de clonage : hôte (port compris) et chemin du dépôt ; requête, encodage ou un seul segment : chemin null ; autre schéma : null", () => {
    expect(depotDeLUrl("https://GitHub.com/Acme/API.git")).toEqual({
      host: "github.com",
      chemin: "acme/api",
    });
    expect(depotDeLUrl(" http://u@forge.lan:3000/g/sous/depot/ ")).toEqual({
      host: "forge.lan:3000",
      chemin: "g/sous/depot",
    });
    for (const url of [
      "https://github.com/acme/api?x=1",
      "https://github.com/acme/..%2fautre/depot",
      "https://github.com/seul.git",
      "https://github.com",
    ])
      expect(depotDeLUrl(url)?.chemin, url).toBeNull();
    for (const url of ["git@github.com:acme/api.git", "ftp://h/a/b", "acme/api", ""])
      expect(depotDeLUrl(url), url).toBeNull();
  });

  it("compte qui sert un dépôt : le plus précis de son hôte, jamais un compte sans portée ni d'un autre hôte", () => {
    const tous = [
      c(1, "github.com", ""),
      c(2, "github.com", "acme"),
      c(3, "github.com", "acme/api"),
      c(4, "github.com", null),
      c(5, "gitlab.com", "acme/api/plus"),
    ];
    expect(compteCouvrant(tous, "github.com", "acme/api")?.id).toBe(3);
    expect(compteCouvrant(tous, "github.com", "acme/web")?.id).toBe(2);
    expect(compteCouvrant(tous, "github.com", "autre/x")?.id).toBe(1);
    expect(compteCouvrant(tous, "github.com", null)?.id).toBe(1);
    expect(compteCouvrant(tous, "gitlab.com", "acme/api")).toBeNull();
    expect(compteCouvrant([c(4, "github.com", null)], "github.com", "acme/api")).toBeNull();
  });

  it("identifiants saisis : tout l'hôte s'il est libre, le compte à chemin qui couvre, sinon le parent du dépôt", () => {
    expect(porteeDesSaisis([], "h", "acme/api")).toBe("");
    expect(porteeDesSaisis([c(1, "autre", "")], "h", "acme/api")).toBe("");
    expect(porteeDesSaisis([c(1, "h", "")], "h", "acme/api")).toBe("acme");
    expect(porteeDesSaisis([c(1, "h", "")], "h", "g/sous/depot")).toBe("g/sous");
    expect(porteeDesSaisis([c(1, "h", "")], "h", null)).toBe("");
    expect(porteeDesSaisis([c(1, "h", ""), c(2, "h", "acme")], "h", "acme/web")).toBe("acme");
  });
});
