// SPDX-License-Identifier: MIT
/** apps/core/test/admin/aides-bac.ts — console d'administration composée comme en service (session d'administrateur, base du process posée) pour les essais du pilote du bac. */
import { createUser, signerSession } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance } from "fastify";

import { remplacerBase } from "../../src/base";
import { composer } from "../../src/composition";
import { installerCrochetJournal } from "../../src/journal";
import { installerRelaisModeles } from "../../src/llm/cache-modeles";
import { installerDiffusion } from "../../src/llm/ports";
import { appTest, journalMuet } from "../aides";

const T = 1_791_331_200;
const SECRET = "secret-de-test";

export interface ConsoleDeTest {
  readonly app: FastifyInstance;
  readonly t: BaseDeTest;
  /** Comptes créés (non administrateurs) : nom → id. */
  readonly ids: ReadonlyMap<string, number>;
  /** En-têtes d'une session de l'administrateur `root`. */
  readonly entetes: Record<string, string>;
  fermer(): Promise<void>;
}

/** Process admin composé sur une base SQLite jetable : `root` administrateur et les comptes demandés. */
export async function ouvrirConsole(comptes: readonly string[]): Promise<ConsoleDeTest> {
  const t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  remplacerBase(t.base);
  const id = async (nom: string): Promise<number> =>
    Number((await t.base.get<{ id: number }>("SELECT id FROM users WHERE username=?", [nom]))?.id);
  await createUser(t.base, "root", "mdp-root", { isAdmin: 1, maintenant: T });
  const ids = new Map<string, number>();
  for (const nom of comptes) {
    await createUser(t.base, nom, `mdp-${nom}`, { isAdmin: 0, maintenant: T });
    ids.set(nom, await id(nom));
  }
  const c = await composer("admin", t.base, journalMuet, {
    base: t.base,
    config: () => ({}),
    attributsCookie: () => ({
      cookie_name: "mcpwebui_session",
      same_site: "lax",
      https_only: false,
      max_age: 86400,
    }),
    secret: () => SECRET,
    jetonService: () => "",
    maintenant: () => T,
  });
  const app = await appTest({ ...c, mode: "admin" });
  const session = signerSession({ user_id: await id("root"), _login_ts: T - 10 }, SECRET, T);
  return {
    app,
    t,
    ids,
    entetes: { cookie: `mcpwebui_session=${session}` },
    async fermer() {
      await app.close();
      installerCrochetJournal(null);
      installerDiffusion(null);
      installerRelaisModeles(null);
      remplacerBase(undefined);
      await t.fermer();
    },
  };
}
