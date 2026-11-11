// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/ax.test.ts — contrats de la mémoire AX des sites rejoués contre le core TS réel, base remplie à la main ; identifiants d'un site lus dans le coffre du compte (une ancienne ligne `ax_credentials` n'est plus montrée, seulement purgée). */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configurerCoffre } from "@elpis/securite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { creerSecret } from "../../../../apps/core/src/secrets/stockage";
import { CONTRATS_REST } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let cookieLou = "";
let uidZoe = 0;
let dossier = "";

async function remplir(): Promise<void> {
  await core.base.run(
    "INSERT INTO ax_nodes(id,site,path,parent_id,node_type,region_tag,role,name,node_key,verified_count,last_ok,stale) VALUES(1,'ex.fr','/',NULL,'region','main','region','Principal','k1',2,1700000000.5,0)",
  );
  await core.base.run(
    "INSERT INTO ax_nodes(id,site,path,parent_id,node_type,region_tag,role,name,node_key,verified_count,last_ok,stale) VALUES(2,'ex.fr','/',1,'element',NULL,'button','Valider','k2',3,1700000100.5,0)",
  );
  await core.base.run(
    "INSERT INTO ax_nodes(id,site,path,parent_id,node_type,region_tag,role,name,node_key,verified_count,last_ok,stale) VALUES(3,'ex.fr','/vieux',NULL,'element',NULL,'link','Ancien','k3',1,1700000050.5,1)",
  );
  await core.base.run(
    "INSERT INTO ax_selectors(node_id,strategy,value,success_count,failure_count) VALUES(2,'css','#ok',4,1)",
  );
  await core.base.run(
    "INSERT INTO ax_transitions(site,from_path,action_node_id,to_path,verified_count,last_ok) VALUES('ex.fr','/',2,'/vieux',2,1700000200.5)",
  );
  await core.base.run(
    "INSERT INTO ax_credentials(owner,site,username,password,last_ok,use_count) VALUES('zoe','ex.fr','zoe@ex.fr','x',1700000300.5,3)",
  );
  await core.base.run(
    "INSERT INTO ax_nodes(id,site,path,parent_id,node_type,region_tag,role,name,node_key,verified_count,last_ok,stale) VALUES(4,'b.fr','/',NULL,'element',NULL,'button','Ok','k4',1,1700000400.5,0)",
  );
  await creerSecret(
    core.base,
    uidZoe,
    {
      name: "ex",
      kind: "web-login",
      scope: { origins: ["https://ex.fr"] },
      username: "zoe.coffre@ex.fr",
      value: "mdp-du-coffre",
    },
    { userId: uidZoe, username: "zoe" },
  );
}

beforeAll(async () => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-contrats-ax-"));
  configurerCoffre({
    cleEnv: randomBytes(32).toString("base64"),
    systeme: join(dossier, "absente.key"),
    repli: join(dossier, ".vault.key"),
  });
  core = await demarrerCore();
  uidZoe = await creerCompte(core.base, "zoe", "mdp-de-zoe-1", 1);
  await creerCompte(core.base, "lou", "mdp-de-lou-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
  cookieLou = await core.connecter("lou", "mdp-de-lou-1");
});

afterAll(async () => {
  await core.fermer();
  rmSync(dossier, { recursive: true, force: true });
});

describe("contrats REST : mémoire AX (core réel)", () => {
  it("base vide : sites, sites inconnus, refus sans session", async () => {
    expect(await core.appeler("GET", "/api/ax/sites", { cookie })).toEqual({ sites: [], count: 0 });
    await core.appeler("GET", "/api/ax/sites");
    await core.appeler("GET", "/api/ax/sites/absent.fr/stats", { cookie });
    await core.appeler("GET", "/api/ax/sites/absent.fr/tree", { cookie });
    await core.appeler("GET", "/api/ax/sites/absent.fr/tree-ascii", { cookie });
  });

  it("lecture : sites, statistiques, arbre, arbre texte, identifiants du coffre du seul propriétaire", async () => {
    await remplir();
    expect(await core.appeler("GET", "/api/ax/sites", { cookie })).toMatchObject({
      count: 2,
      sites: [
        { site: "b.fr", has_credentials: false },
        {
          site: "ex.fr",
          elements: 1,
          regions: 1,
          transitions: 1,
          has_credentials: true,
          cred_username: "zoe.coffre@ex.fr",
          cred_origin: "https://ex.fr",
        },
      ],
    });
    expect(await core.appeler("GET", "/api/ax/sites/ex.fr/stats", { cookie: cookieLou })).toMatchObject({
      elements_ok: 1,
      elements_stale: 1,
      selectors: 1,
      has_credentials: false,
    });
    expect(await core.appeler("GET", "/api/ax/sites/ex.fr/tree", { cookie })).toMatchObject({
      site: "ex.fr",
      paths: [{ path: "/" }, { path: "/vieux" }],
    });
    expect(await core.appeler("GET", "/api/ax/sites/ex.fr/tree-ascii", { cookie })).toMatchObject({
      site: "ex.fr",
    });
  });

  it("écriture : purges réservées à l'équipe, effacement total à l'admin", async () => {
    await core.appeler("POST", "/api/ax/sites/ex.fr/mark-stale", { cookie: cookieLou });
    await core.appeler("DELETE", "/api/ax/sites/ex.fr", { cookie: cookieLou });
    await core.appeler("DELETE", "/api/ax/sites/ex.fr/credentials", { cookie: cookieLou });
    await core.appeler("POST", "/api/ax/bulk-delete", { cookie: cookieLou, corps: { sites: ["ex.fr"] } });
    await core.appeler("DELETE", "/api/ax/all?confirm=WIPE", { cookie: cookieLou });
    expect(await core.appeler("POST", "/api/ax/sites/ex.fr/mark-stale", { cookie })).toEqual({ marked: 1 });
    expect(
      await core.appeler("POST", "/api/ax/bulk-mark-stale", { cookie, corps: { sites: ["ex.fr", "b.fr"] } }),
    ).toEqual({ marked: 1, sites_processed: 2 });
    await core.appeler("POST", "/api/ax/bulk-mark-stale", { cookie, corps: { sites: [] } });
    expect(await core.appeler("DELETE", "/api/ax/sites/ex.fr/credentials", { cookie })).toEqual({
      deleted: 1,
    });
    expect(await core.appeler("DELETE", "/api/ax/sites/ex.fr", { cookie })).toMatchObject({
      deleted: { nodes: 2, selectors: 1, transitions: 1 },
    });
    expect(
      await core.appeler("POST", "/api/ax/bulk-delete", { cookie, corps: { sites: ["b.fr"] } }),
    ).toMatchObject({ deleted: { nodes: 1, sites_processed: 1 } });
    await core.appeler("POST", "/api/ax/bulk-delete", { cookie, corps: { sites: [] } });
    await core.appeler("DELETE", "/api/ax/all", { cookie });
    expect(await core.appeler("DELETE", "/api/ax/all?confirm=WIPE", { cookie })).toMatchObject({
      deleted: { nodes: 0 },
    });
  });

  it("toutes les routes du domaine ont été interrogées", () => {
    const manquantes = CONTRATS_REST.filter((r) => r.domaine === "ax" && !core.couvertes.has(cle(r)));
    expect(manquantes.map(cle)).toEqual([]);
  });
});
