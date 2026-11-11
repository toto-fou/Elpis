// SPDX-License-Identifier: MIT
/** apps/toolhost/test/browser-memoire.test.ts — mémoire AX de la famille browser : transitions apprises des gestes qui naviguent (pw_act, étapes de pw_chain), navigations directes non apprises, chemin rendu par pw_memory. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { initialiserBase, ouvrirBase } from "@elpis/db";
import type { Base } from "@elpis/db";
import { ouvrirEnMemoire, ServeurOutils } from "@elpis/outils-mcp";
import type { ConnexionEnMemoire } from "@elpis/outils-mcp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ClientBrut } from "../../../packages/outils-mcp/test/aides";
import { outilsBrowser } from "../src/mcp/browser";
import { journalMuet } from "./aides";
import { FauxNavigateur, SESSION, SITE } from "./faux-navigateur";

const dossier = mkdtempSync(path.join(tmpdir(), "elpis-browser-memoire-"));
const HOTE = "93.184.216.34";
let faux: FauxNavigateur;
let base: Base;
let connexion: ConnexionEnMemoire;
let b: ClientBrut;

beforeAll(async () => {
  faux = await FauxNavigateur.demarrer();
});

beforeEach(async () => {
  vi.stubEnv("PLAYWRIGHT_API_URL", faux.url);
  vi.stubEnv("PW_OWNERS_DIR", path.join(dossier, "owners"));
  base = ouvrirBase({ backend: "sqlite", path: path.join(dossier, `ax-${Date.now()}.db`) });
  await initialiserBase(base);
  const serveur = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
  serveur.enregistrerFamille("browser", outilsBrowser({ ax: () => base, journal: journalMuet }));
  connexion = await ouvrirEnMemoire(serveur);
  b = new ClientBrut(connexion.transport);
  await b.demarrer();
  await b.initialiser();
  await b.appeler("pw_session", { action: "start", url: `${SITE}/login` }, { username: "bob" });
});

afterEach(async () => {
  await connexion.fermer();
  await base.fermer();
  vi.unstubAllEnvs();
  faux.reinitialiser();
});

afterAll(async () => {
  await faux.arreter();
  rmSync(dossier, { recursive: true, force: true });
});

const resultat = (r: Dict): Dict => (r["structuredContent"] as { result: Dict }).result;
const memoire = async (args: Dict): Promise<Dict> =>
  resultat(await b.appeler("pw_memory", { site: HOTE, ...args }, { username: "bob" }));

/** Le prochain `/action` (ou `/chain`) du service factice rend `corps`. */
function imposer(route: string, corps: Dict): void {
  faux.imposees.set(route, [[200, corps]]);
}

describe("mémoire AX : transitions des gestes qui naviguent", () => {
  it("connexion par pw_act (clic qui soumet) puis déconnexion par pw_chain : chemins appris dans les deux sens, d'au moins une étape", async () => {
    imposer("POST /action", {
      status: "success",
      url: `${SITE}/secure`,
      url_before: `${SITE}/login`,
      navigated: true,
    });
    await b.appeler(
      "pw_act",
      { session_id: SESSION, action: "click", target: "role=button|name=Login" },
      { username: "bob" },
    );
    imposer("POST /chain", {
      ok: true,
      results: [
        { step: 0, action: "fill", success: true },
        {
          step: 1,
          action: "click",
          success: true,
          navigated: true,
          url_before: `${SITE}/secure`,
          url: `${SITE}/login`,
        },
        {
          step: 2,
          action: "click",
          success: false,
          navigated: true,
          url: `${SITE}/x`,
          url_before: `${SITE}/login`,
        },
      ],
    });
    await b.appeler(
      "pw_chain",
      {
        session_id: SESSION,
        actions: [
          { action: "fill", target: "label=Note", value: "x" },
          { action: "click", target: "role=link|name=Logout" },
          { action: "click", target: "text=Ailleurs" },
        ],
      },
      { username: "bob" },
    );

    expect(await memoire({ action: "path", from_path: "/login", to_path: "/secure" })).toMatchObject({
      found: true,
      depth: 1,
      steps: [
        { from: "/login", to: "/secure", action_name: "Login", action_target: "role=button|name=Login" },
      ],
    });
    expect(await memoire({ action: "path", to_path: "/secure" })).toMatchObject({
      found: true,
      from_path: "/login",
      depth: 1,
    });
    expect(await memoire({ action: "path", to_path: "/login" })).toMatchObject({
      found: true,
      from_path: "/secure",
      steps: [{ action_role: "link", action_name: "Logout", action_target: "role=link|name=Logout" }],
    });
    const transitions = await base.all("SELECT from_path, to_path FROM ax_transitions ORDER BY id");
    expect(transitions).toEqual([
      { from_path: "/login", to_path: "/secure" },
      { from_path: "/secure", to_path: "/login" },
    ]);
  });

  it("goto, back : ni élément de rôle navigation ni transition", async () => {
    await b.appeler(
      "pw_act",
      { session_id: SESSION, action: "goto", url: `${SITE}/produits` },
      { username: "bob" },
    );
    await b.appeler("pw_act", { session_id: SESSION, action: "back" }, { username: "bob" });
    expect(await base.all("SELECT role, name FROM ax_nodes")).toEqual([]);
    expect(await base.all("SELECT * FROM ax_transitions")).toEqual([]);
    expect(await memoire({ action: "path", to_path: "/produits" })).toMatchObject({
      found: false,
      steps: [],
    });
  });
});
