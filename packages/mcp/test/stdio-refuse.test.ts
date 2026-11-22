// SPDX-License-Identifier: MIT
/** packages/mcp/test/stdio-refuse.test.ts — un serveur perso stdio est refusé à l'enregistrement pour tous ; la confiance de l'administrateur (adresse interne) est inchangée. */
import { describe, expect, it } from "vitest";

import {
  BUILTIN_SENTINEL,
  clientBuiltinRef,
  mergePersonalMcp,
  personalToConfig,
  StdioRefused,
  UrlNotAllowed,
} from "../src";

const LOCAL = { id: "loc", name: "Loc", type: "stdio", command: "run-a" };
const INTERNE = { id: "int", name: "Int", type: "http", url: "http://127.0.0.1:9/mcp" };

describe("serveurs perso : stdio à l'enregistrement", () => {
  for (const [nom, confiance] of [
    ["administrateur", true],
    ["compte ordinaire", false],
  ] as const) {
    it(`${nom} : un stdio neuf ou changé est refusé, un stdio inchangé est gardé`, async () => {
      await expect(mergePersonalMcp([], [LOCAL], { confiance })).rejects.toBeInstanceOf(StdioRefused);
      await expect(
        mergePersonalMcp([LOCAL], [{ ...LOCAL, command: "run-b" }], { confiance }),
      ).rejects.toBeInstanceOf(StdioRefused);
      const gardee = await mergePersonalMcp([LOCAL], [LOCAL], { confiance });
      expect(gardee[0]?.entree).toMatchObject({ id: "loc", type: "stdio", command: "run-a" });
    });
  }

  it("adresse interne : refusée à un compte ordinaire, permise (et de confiance) à un administrateur", async () => {
    await expect(mergePersonalMcp([], [INTERNE], { confiance: false })).rejects.toBeInstanceOf(UrlNotAllowed);
    const admin = await mergePersonalMcp([], [INTERNE], { confiance: true });
    expect(admin[0]?.entree).toMatchObject({ url: INTERNE.url });
    expect(await personalToConfig(INTERNE, { confiance: false })).toEqual({});
    expect(await personalToConfig(INTERNE, { confiance: true })).toMatchObject({
      type: "http",
      url: INTERNE.url,
    });
  });

  it("outils intégrés : la référence « Outils locaux » est reconstruite hors de l'enregistrement", () => {
    expect(clientBuiltinRef({ command: BUILTIN_SENTINEL, name: "Outils locaux" })).toMatchObject({
      type: "stdio",
      command: BUILTIN_SENTINEL,
    });
  });

  it("stdio gardé : même commande avec une autre variable ou un autre nom = l'entrée enregistrée, telle quelle", async () => {
    const stocke = { ...LOCAL, secret_id: 7, env_enc: "x" };
    for (const confiance of [true, false]) {
      const out = await mergePersonalMcp(
        [stocke],
        [{ ...LOCAL, name: "Autre", env: [{ name: "T", value: "n" }] }],
        {
          confiance,
        },
      );
      expect(out).toEqual([{ entree: stocke, valeur: null, changee: false }]);
    }
  });

  it("stdio gardé : le seul réglage « visible » du client est repris", async () => {
    const out = await mergePersonalMcp(
      [{ ...LOCAL, visible: true }],
      [{ ...LOCAL, visible: false, command: "run-a" }],
    );
    expect(out[0]?.entree).toMatchObject({ id: "loc", command: "run-a", visible: false });
  });

  it("stdio ancien sans identifiant : retrouvé par son contenu et gardé ; un autre contenu est refusé", async () => {
    const ancien = { name: "Vieux", type: "stdio", command: "run-z" };
    for (const confiance of [true, false]) {
      const out = await mergePersonalMcp([ancien], [{ ...ancien }], { confiance });
      expect(out).toEqual([{ entree: ancien, valeur: null, changee: false }]);
      await expect(
        mergePersonalMcp([ancien], [{ ...ancien, command: "run-y" }], { confiance }),
      ).rejects.toBeInstanceOf(StdioRefused);
    }
  });
});
