// SPDX-License-Identifier: MIT
/** apps/core/test/reponses-py.test.ts — reponseJsonPy : JSON stocké rendu comme JSONResponse (flottants, grands entiers, ordre, refus). */
import { FlottantPy, pyJsonLoads } from "@elpis/commun";
import { describe, expect, it } from "vitest";

import { appTest } from "./aides";
import { reponseJsonPy } from "@elpis/http";

describe("reponseJsonPy", () => {
  it("écrit comme json.dumps(separators=(',', ':'), ensure_ascii=False) ; NaN et demi-paire ⇒ 500", async () => {
    const valeurs: Record<string, unknown> = {
      flottants: pyJsonLoads('{"b": 1.0, "2": [18446744073709551616, 1e-05], "é": "ü"}'),
      nan: { x: new FlottantPy(Number.NaN) },
      demi: { x: "a\ud800" },
    };
    const app = await appTest({
      familles: [
        {
          nom: "essai",
          routes: [
            {
              methode: "GET",
              chemin: "/essai/:cas",
              processus: ["main"],
              acces: "public",
              traiter: (req, rep) =>
                reponseJsonPy(rep, valeurs[(req.params as { cas: string }).cas], { pragma: "no-cache" }),
            },
          ],
        },
      ],
    });
    const ok = await app.inject({ url: "/essai/flottants" });
    expect([ok.statusCode, ok.body, ok.headers["pragma"]]).toEqual([
      200,
      '{"b":1.0,"2":[18446744073709551616,1e-05],"é":"ü"}',
      "no-cache",
    ]);
    expect(ok.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect((await app.inject({ url: "/essai/nan" })).statusCode).toBe(500);
    expect((await app.inject({ url: "/essai/demi" })).statusCode).toBe(500);
    await app.close();
  });
});
