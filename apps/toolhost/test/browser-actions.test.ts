// SPDX-License-Identifier: MIT
/** apps/toolhost/test/browser-actions.test.ts — pw_act de l'hôte : fichiers d'upload lus dans le bac du compte (garde de /work), `strict` et `nth` transmis, erreurs codées du service rendues avec leur contexte, codes fixes. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { AgentClient } from "@elpis/fichiers";
import { ouvrirEnMemoire, ServeurOutils } from "@elpis/outils-mcp";
import type { ConnexionEnMemoire } from "@elpis/outils-mcp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BacTest, dossierTemporaire, PYTHON } from "../../../packages/fichiers/test/aides";
import { ClientBrut } from "../../../packages/outils-mcp/test/aides";
import { familleBrowser } from "../src/mcp/browser";
import { Espace, installerFabriqueEspace } from "../src/mcp/espace";
import { journalMuet } from "./aides";
import { FauxNavigateur, SESSION, SITE } from "./faux-navigateur";

const dossier = mkdtempSync(path.join(tmpdir(), "elpis-browser-actions-"));
let faux: FauxNavigateur;
const ouvertes: ConnexionEnMemoire[] = [];

beforeAll(async () => {
  faux = await FauxNavigateur.demarrer();
});

afterEach(async () => {
  for (const c of ouvertes.splice(0)) await c.fermer();
  vi.unstubAllEnvs();
  faux.reinitialiser();
});

afterAll(async () => {
  await faux.arreter();
  rmSync(dossier, { recursive: true, force: true });
});

/** Client en mémoire de la famille browser, session ouverte au nom de bob. */
async function client(): Promise<ClientBrut> {
  vi.stubEnv("PLAYWRIGHT_API_URL", faux.url);
  vi.stubEnv("PW_OWNERS_DIR", path.join(dossier, "owners"));
  const serveur = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
  serveur.enregistrerFamille("browser", familleBrowser({ journal: journalMuet }).outils);
  const c = await ouvrirEnMemoire(serveur);
  ouvertes.push(c);
  const b = new ClientBrut(c.transport);
  await b.demarrer();
  await b.initialiser();
  await b.appeler("pw_session", { action: "start", url: `${SITE}/` }, { username: "bob" });
  faux.vues.length = 0;
  return b;
}

/** Résultat d'un outil : contenu structuré, sinon le texte JSON de l'erreur. */
function resultat(r: Dict): Dict {
  const sc = r["structuredContent"] as Dict | undefined;
  if (sc?.["result"]) return sc["result"] as Dict;
  return JSON.parse(((r["content"] as Dict[])[0] as Dict)["text"] as string) as Dict;
}

/** Corps reçus par le service pour `POST /action`. */
const actions = (): Dict[] =>
  faux.vues.filter((v) => v.chemin === "/action").map((v) => JSON.parse(v.corps) as Dict);

describe("pw_act : strict, nth et erreurs codées du service", () => {
  it("strict et nth du DSL transmis au service, seulement quand ils sont donnés", async () => {
    const b = await client();
    const agir = (args: Dict): Promise<Dict> =>
      b.appeler("pw_act", { session_id: SESSION, observe: false, ...args }, { username: "bob" });
    await agir({ action: "click", target: "role=link|name=delete|nth=2", strict: true });
    await agir({ action: "click", target: "role=link|name=delete" });
    const [a, c] = actions();
    expect(a).toMatchObject({ by_role: "link", by_name: "delete", nth: 2, strict: true });
    expect(c).not.toHaveProperty("nth");
    expect(c).not.toHaveProperty("strict");
  });

  it("erreur codée du service (tout statut) : code, message, correctif et contexte (suggestions, candidats)", async () => {
    const b = await client();
    const suggestions = [{ role: "button", name: "Valider", target: "role=button|name=Valider" }];
    faux.imposees.set("POST /action", [
      [404, { code: "element_not_found", error: "No element matches x.", fix: "f", suggestions, url: SITE }],
      [
        409,
        {
          code: "ambiguous_target",
          error: "4 elements match.",
          matched: 4,
          candidates: [{ ref: "loc_a#0" }],
        },
      ],
      [500, { error: "Cannot read properties of undefined (reading 'buffer')" }],
    ]);
    const agir = (): Promise<Dict> =>
      b.appeler(
        "pw_act",
        { session_id: SESSION, action: "click", target: "role=button|name=Validr", observe: false },
        { username: "bob" },
      );
    expect(resultat(await agir())).toMatchObject({
      ok: false,
      error: "element_not_found",
      message: "No element matches x.",
      fix: "f",
      suggestions,
    });
    expect(resultat(await agir())).toMatchObject({ error: "ambiguous_target", matched: 4 });
    expect(resultat(await agir())).toMatchObject({
      error: "browser_error",
      message: "Cannot read properties of undefined (reading 'buffer')",
    });
  });

  it("codes fixes sans donnée pour une action inconnue", async () => {
    const b = await client();
    const r = await b.appeler("pw_act", { session_id: SESSION, action: "voler" }, { username: "bob" });
    expect(resultat(r)).toMatchObject({ ok: false, error: "unknown_action" });
  });
});

describe("pw_act upload : fichiers du bac ou contenus fournis", () => {
  it("sans fichier ou entrée mal formée : refus avant tout appel au service", async () => {
    const b = await client();
    const agir = (files: unknown): Promise<Dict> =>
      b.appeler(
        "pw_act",
        { session_id: SESSION, action: "upload", target: "css=#f", files, observe: false },
        { username: "bob" },
      );
    expect(resultat(await agir(null))).toMatchObject({ ok: false, error: "files_required" });
    expect(resultat(await agir([]))).toMatchObject({ ok: false, error: "files_required" });
    expect(resultat(await agir([{ name: "a.txt", content_base64: "pas du base64 !" }]))).toMatchObject({
      error: "invalid_files",
    });
    expect(resultat(await agir([42]))).toMatchObject({ error: "invalid_files" });
    expect(actions()).toEqual([]);
    await agir([{ name: "dir/note.txt", content_base64: Buffer.from("salut").toString("base64") }]);
    expect(actions()[0]?.["files"]).toEqual([
      { name: "note.txt", mime_type: "text/plain", content_base64: Buffer.from("salut").toString("base64") },
    ]);
  });
});

describe.skipIf(!PYTHON)("pw_act upload : chemins lus par l'agent du bac", () => {
  let racine = "";
  let nettoyer: () => void = () => undefined;
  let bac: BacTest;

  beforeEach(() => {
    [racine, nettoyer] = dossierTemporaire("elpis-pw-upload-");
    bac = new BacTest(racine, "bob");
    installerFabriqueEspace(async () => new Espace(bac.sandboxPath, 7, new AgentClient(bac)));
  });

  afterEach(async () => {
    installerFabriqueEspace(null);
    await bac.arreter();
    nettoyer();
  });

  it("fichiers sous /work envoyés en contenu ; hors du bac, absent, dossier ou lien sortant refusés", async () => {
    mkdirSync(path.join(bac.sandboxPath, "docs"));
    writeFileSync(path.join(bac.sandboxPath, "docs", "rapport.csv"), "a;b\n");
    writeFileSync(path.join(racine, "secret.txt"), "hors du bac");
    symlinkSync(path.join(racine, "secret.txt"), path.join(bac.sandboxPath, "lien.txt"));
    const b = await client();
    const agir = (files: unknown): Promise<Dict> =>
      b.appeler(
        "pw_act",
        { session_id: SESSION, action: "upload", target: "css=#f", files, observe: false },
        { username: "bob" },
      );
    const ok = resultat(await agir(["docs/rapport.csv", "/work/docs/rapport.csv"]));
    expect(ok["ok"]).not.toBe(false);
    const fichier = {
      name: "rapport.csv",
      mime_type: "text/csv",
      content_base64: Buffer.from("a;b\n").toString("base64"),
    };
    expect(actions()[0]?.["files"]).toEqual([fichier, fichier]);
    expect(resultat(await agir(["../secret.txt"]))).toMatchObject({ error: "path_outside_sandbox" });
    expect(resultat(await agir([path.join(racine, "secret.txt")]))).toMatchObject({
      error: "path_outside_sandbox",
    });
    expect(resultat(await agir(["absent.txt"]))).toMatchObject({
      error: "file_not_found",
      path: "/work/absent.txt",
    });
    expect(resultat(await agir(["docs"]))).toMatchObject({ error: "not_a_file" });
    const lien = resultat(await agir(["lien.txt"]));
    expect(lien["ok"]).toBe(false);
    expect(JSON.stringify(lien)).not.toContain("hors du bac");
    expect(actions()).toHaveLength(1);
  });
});
