// SPDX-License-Identifier: MIT
/** frontend/test/routines/liste.test.ts — colonne des routines : la roue ne remplace la liste qu'au premier chargement, une relecture garde les lignes affichées. */
import { nextTick } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import ListeRoutines from "../../src/components/routines/ListeRoutines.vue";
import { CLE_ROUTINES } from "../../src/features/routines/domaine";
import { demonter, etat, monter } from "../chat/page/montage";

afterEach(demonter);

const ligne = {
  id: 3,
  name: "Veille",
  enabled: true,
  cron_expr: "0 9 * * *",
  running_count: 1,
  last_run: null,
};

describe("liste des routines", () => {
  it("roue seulement sans lignes ; une relecture garde la liste", async () => {
    const rt = etat({ routineIsEditing: false, routinesLoading: true, routinesError: "", routines: [] });
    const hote = monter(ListeRoutines, [[CLE_ROUTINES, rt]]);
    expect(hote.querySelector(".ph-spinner")).not.toBeNull();
    rt["routines"] = [ligne];
    await nextTick();
    expect(hote.querySelector(".ph-spinner")).toBeNull();
    expect(hote.querySelectorAll("button").length).toBe(1);
    rt["routinesLoading"] = false;
    await nextTick();
    expect(hote.textContent).toContain("Veille");
  });
});
