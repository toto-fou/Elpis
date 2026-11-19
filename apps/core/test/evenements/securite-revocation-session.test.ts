// SPDX-License-Identifier: MIT
/** apps/core/test/evenements/securite-revocation-session.test.ts — une révocation par session ferme aussi les terminaux de cette session et d'elle seule ; une révocation de compte ferme tous ceux du compte. */
import { describe, expect, it } from "vitest";

import { applySessionRevocation } from "../../src/evenements/revocation";
import type { SystemEvents } from "../../src/evenements/systeme";

const evenements = { disconnectSession: () => 1, disconnectUser: () => 2 } as unknown as SystemEvents;

describe("révocation de session et terminaux", () => {
  it("avec `sid`, les terminaux sont fermés pour ce compte et cette session ; sans `sid`, pour le compte", async () => {
    const appels: [number | null, string | undefined][] = [];
    const cibles = {
      systemEvents: evenements,
      fermerTerminaux: (uid: number | null, sid?: string) => (appels.push([uid, sid]), 3),
    };
    expect(await applySessionRevocation({ type: "session_revoked", uid: 7, sid: "s-1" }, cibles)).toEqual({
      uid: 7,
      systeme: 1,
      terminaux: 3,
    });
    expect(await applySessionRevocation({ type: "session_revoked", uid: 7 }, cibles)).toEqual({
      uid: 7,
      systeme: 2,
      terminaux: 3,
    });
    expect(appels).toEqual([
      [7, "s-1"],
      [7, undefined],
    ]);
  });

  it("une fermeture de terminaux en échec ne bloque pas la révocation", async () => {
    const r = await applySessionRevocation(
      { type: "session_revoked", uid: 7, sid: "s-1" },
      {
        systemEvents: evenements,
        fermerTerminaux: () => Promise.reject(new Error("panne")),
      },
    );
    expect(r).toEqual({ uid: 7, systeme: 1, terminaux: 0 });
  });
});
