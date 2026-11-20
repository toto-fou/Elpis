// SPDX-License-Identifier: MIT
/** frontend/test/admin/sandbox-reseau.test.ts — console › Sandbox : saisie des IP, réseaux et résolveurs d'un profil, IPv4 seulement. */
import * as Vue from "vue";
import { ref } from "vue";
import { describe, expect, it } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { setupAdmin } from "../../src/features/admin/console";
import type { CtxAdmin, RefsAdmin } from "../../src/features/admin/types";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

function domaine() {
  const refs: RefsAdmin = {
    user: ref({ username: "root", role: "admin", is_admin: 1 }),
    isAdminView: ref(true),
  };
  const ctx: CtxAdmin = {
    showToast: () => undefined,
    fetchAuth: () => Promise.resolve(json({})),
    openConfirm: () => Promise.resolve(true),
    openChoice: () => Promise.resolve("save"),
    nextTick: () => Vue.nextTick(),
    loadPublicConfig: () => undefined,
    systemAlert: ref(""),
  };
  return setupAdmin(
    Vue,
    refs,
    ctx,
    new ClientHttp(new GestionnaireSession(), () => Promise.resolve(json({}))),
  );
}

/** Saisit `texte` dans le champ `cle` d'un profil neuf ; rend les valeurs gardées, le brouillon refusé et le message. */
function saisir(cle: "ips" | "dns", texte: string): { gardees: unknown[]; refuse: string; erreur: string } {
  const A = domaine();
  A.addNetworkProfile();
  const p = A.execConfig.value.network_profiles.at(-1);
  if (!p) throw new Error("profil absent");
  p._draft[cle] = texte;
  A.commitNetValue(p, cle);
  return { gardees: [...p[cle]], refuse: String(p._draft[cle]), erreur: String(p._err[cle]) };
}

describe("console › Sandbox : réseau IPv4 seulement", () => {
  it.each([
    ["10.0.0.5", ["10.0.0.5"]],
    ["10.0.0.0/24 192.168.1.1", ["10.0.0.0/24", "192.168.1.1"]],
    ["1.2.3.4/32, 0.0.0.0/0", ["1.2.3.4/32", "0.0.0.0/0"]],
  ])("ips %j acceptées", (texte, attendu) => {
    expect(saisir("ips", texte)).toEqual({ gardees: attendu, refuse: "", erreur: "" });
  });

  it.each([
    ["fe80::1", "« fe80::1 » n'est ni une adresse IPv4 ni un réseau IPv4"],
    ["::1/128", "« ::1/128 » n'est ni une adresse IPv4 ni un réseau IPv4"],
    ["10.0.0.0/33", "Préfixe invalide dans « 10.0.0.0/33 » (0 à 32)"],
    ["10.0.0.0/100", "Préfixe invalide dans « 10.0.0.0/100 » (0 à 32)"],
    ["10.0.0.256", "« 10.0.0.256 » n'est ni une adresse IPv4 ni un réseau IPv4"],
    ["a/b/c", "« a/b/c » n'est ni une adresse IPv4 ni un réseau IPv4"],
  ])("ips %j refusée", (texte, message) => {
    expect(saisir("ips", texte)).toEqual({ gardees: [], refuse: texte, erreur: message });
  });

  it("résolveurs : une adresse IPv4 seulement", () => {
    expect(saisir("dns", "9.9.9.9 1.1.1.1")).toEqual({
      gardees: ["9.9.9.9", "1.1.1.1"],
      refuse: "",
      erreur: "",
    });
    for (const mauvais of ["fe80::1", "10.0.0.0/24", "dns.local"])
      expect(saisir("dns", mauvais)).toEqual({
        gardees: [],
        refuse: mauvais,
        erreur: `« ${mauvais} » doit être l'adresse IPv4 d'un résolveur`,
      });
  });

  it("saisie mixte : les valeurs valides restent, les refusées restent dans le champ", () => {
    expect(saisir("ips", "10.0.0.1 fe80::1")).toEqual({
      gardees: ["10.0.0.1"],
      refuse: "fe80::1",
      erreur: "« fe80::1 » n'est ni une adresse IPv4 ni un réseau IPv4",
    });
  });
});
