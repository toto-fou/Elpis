// SPDX-License-Identifier: MIT
/** frontend/test/utils-portee-git.test.ts — portée d'un compte git côté interface : mêmes chemins, même couverture et mêmes URL que le serveur (vecteurs partagés), casse selon le type de forge, saisie « hôte/chemin », niveaux d'un dépôt, compte qui sert une URL, portée proposée pour des identifiants saisis. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  cheminCouvre,
  cheminDepot,
  cheminExact,
  cheminPourType,
  cibleCompte,
  compteCouvrant,
  depotDeLUrl,
  lirePortee,
  niveauxPortee,
  porteeDesSaisis,
} from "../src/utils/portee-git";

const V = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../apps/core/test/vecteurs/portee-git.json"), "utf-8"),
) as {
  chemins: [string, string | null][];
  couverture: [string, string | null, boolean][];
  urls: [string, string | null][];
};
const c = (id: number, host: string, path: string | null, provider_type = "github") => ({
  id,
  host,
  path,
  provider_type,
});

describe("portée d'un compte git", () => {
  it("chemins, couverture et URL : les vecteurs du serveur", () => {
    for (const [brut, attendu] of V.chemins) expect(cheminDepot(brut), JSON.stringify(brut)).toBe(attendu);
    for (const [portee, chemin, attendu] of V.couverture)
      expect(cheminCouvre(portee, chemin), JSON.stringify([portee, chemin])).toBe(attendu);
    for (const [url, attendu] of V.urls) expect(depotDeLUrl(url)?.chemin ?? null, url).toBe(attendu);
    expect(cheminExact("acme/api")).toBe("acme/api");
    expect(cheminExact("/acme/api")).toBeNull();
    expect(cheminPourType("Acme/API", "gitea")).toBe("acme/api");
    expect(cheminPourType("Acme/API", "generic")).toBe("Acme/API");
  });

  it("affichage et niveaux : `hôte` ou `hôte/chemin` ; un dépôt propose l'hôte, puis chaque parent, puis lui-même", () => {
    expect(cibleCompte(c(1, "github.com", ""))).toBe("github.com");
    expect(cibleCompte(c(1, "github.com", null))).toBe("github.com");
    expect(cibleCompte(c(1, "github.com", "acme/api"))).toBe("github.com/acme/api");
    expect(niveauxPortee("g/sous/depot")).toEqual(["", "g", "g/sous", "g/sous/depot"]);
    expect(niveauxPortee(null)).toEqual([""]);
    expect(niveauxPortee("")).toEqual([""]);
  });

  it("saisie « S'applique à » : hôte seul, hôte et chemin (casse gardée), URL collée ; espace, hôte vide ou chemin douteux : null", () => {
    expect(lirePortee("GitHub.com")).toEqual({ host: "github.com", path: "" });
    expect(lirePortee(" forge.lan:3000/Equipe/Depot.git ")).toEqual({
      host: "forge.lan:3000",
      path: "Equipe/Depot",
    });
    expect(lirePortee("https://u:p@Forge.lan/Equipe")).toEqual({ host: "forge.lan", path: "Equipe" });
    for (const brut of ["", "/acme", "github.com/a b", "git hub.com", "github.com/a/../b", "u@github.com/x"])
      expect(lirePortee(brut), brut).toBeNull();
  });

  it("URL de clonage : hôte, port compris ; autre schéma ou texte : null", () => {
    expect(depotDeLUrl("https://GitHub.com/Acme/API.git")).toEqual({
      host: "github.com",
      chemin: "Acme/API",
    });
    expect(depotDeLUrl(" http://u@forge.lan:3000/g/sous/depot/ ")?.host).toBe("forge.lan:3000");
    expect(depotDeLUrl("https://github.com")).toEqual({ host: "github.com", chemin: null });
    for (const url of ["git@github.com:acme/api.git", "ftp://h/a/b", "acme/api", ""])
      expect(depotDeLUrl(url), url).toBeNull();
  });

  it("compte qui sert un dépôt : le plus précis de son hôte, selon la casse de son type ; jamais un compte sans portée ni d'un autre hôte ; dépôt illisible : aucun dès qu'un compte de l'hôte est borné", () => {
    const tous = [
      c(1, "github.com", ""),
      c(2, "github.com", "acme"),
      c(3, "github.com", "acme/api"),
      c(4, "github.com", null),
      c(5, "gitlab.com", "acme/api/plus"),
    ];
    expect(compteCouvrant(tous, "github.com", "Acme/API")?.id).toBe(3);
    expect(compteCouvrant(tous, "github.com", "acme/web")?.id).toBe(2);
    expect(compteCouvrant(tous, "github.com", "autre/x")?.id).toBe(1);
    expect(compteCouvrant(tous, "github.com", null)).toBeNull();
    expect(compteCouvrant([c(1, "github.com", "")], "github.com", null)?.id).toBe(1);
    expect(compteCouvrant(tous, "gitlab.com", "acme/api")).toBeNull();
    expect(compteCouvrant([c(4, "github.com", null)], "github.com", "acme/api")).toBeNull();
    const generiques = [c(1, "h", "", "generic"), c(2, "h", "Equipe/Depot", "generic")];
    expect(compteCouvrant(generiques, "h", "Equipe/Depot")?.id).toBe(2);
    expect(compteCouvrant(generiques, "h", "equipe/depot")?.id).toBe(1);
  });

  it("identifiants saisis : tout l'hôte s'il est libre, le compte à chemin qui couvre, sinon le parent du dépôt, dans la casse de l'URL ; dépôt illisible et hôte déjà pris : rien d'office", () => {
    expect(porteeDesSaisis([], "h", "acme/api")).toBe("");
    expect(porteeDesSaisis([c(1, "autre", "")], "h", "acme/api")).toBe("");
    expect(porteeDesSaisis([c(1, "h", "")], "h", "Acme/API")).toBe("Acme");
    expect(porteeDesSaisis([c(1, "h", "")], "h", "g/sous/depot")).toBe("g/sous");
    expect(porteeDesSaisis([c(1, "h", ""), c(2, "h", "acme")], "h", "Acme/web")).toBe("Acme");
    expect(porteeDesSaisis([], "h", null)).toBe("");
    expect(porteeDesSaisis([c(2, "h", "acme")], "h", null)).toBe("");
    expect(porteeDesSaisis([c(1, "h", "")], "h", null)).toBeNull();
  });
});
