// SPDX-License-Identifier: MIT
/** apps/core/test/admin/admin-executeurs-etat.test.ts — état réseau des sandboxes pour la console : comptes et profil de leur sandbox, résolu comme pour les conteneurs, avec son origine (imposé, choisi, repli sur le profil isolé). */
import { describe, expect, it } from "vitest";

import { comptesDesProfils } from "../../src/administration/executeurs";
import { resolveNetworkProfileId } from "../../src/relais/identite";

const PROFILS = [{ id: "isolated" }, { id: "web" }, { id: "lan" }];

describe("état réseau des sandboxes : comptes par profil", () => {
  it("imposé, choisi, par défaut ; profil disparu et imposition vide : profil isolé", () => {
    const comptes = [
      { id: 1, username: "alice", reglages: { network_profile_id: "web" } },
      { id: 2, username: "bob", reglages: { network_profile_id: "web", forced_network_profile_id: "lan" } },
      { id: 3, username: "carole", reglages: {} },
      { id: 4, username: "david", reglages: { network_profile_id: "ancien" } },
      { id: 5, username: "eve", reglages: { forced_network_profile_id: "  ", network_profile_id: " web " } },
      {
        id: 6,
        username: "fanny",
        reglages: { forced_network_profile_id: "ancien", network_profile_id: "web" },
      },
      { id: 7, username: "gaston", reglages: { forced_network_profile_id: "isolated" } },
    ];
    expect(comptesDesProfils(comptes, PROFILS, resolveNetworkProfileId)).toEqual([
      { user_id: 1, username: "alice", profile_id: "web", origin: "chosen" },
      { user_id: 2, username: "bob", profile_id: "lan", origin: "forced" },
      { user_id: 3, username: "carole", profile_id: "isolated", origin: "default" },
      { user_id: 4, username: "david", profile_id: "isolated", origin: "default" },
      { user_id: 5, username: "eve", profile_id: "web", origin: "chosen" },
      { user_id: 6, username: "fanny", profile_id: "isolated", origin: "default" },
      { user_id: 7, username: "gaston", profile_id: "isolated", origin: "forced" },
    ]);
  });
});
