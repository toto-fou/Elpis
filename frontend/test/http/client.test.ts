// SPDX-License-Identifier: MIT
/** frontend/test/http/client.test.ts — `ApiResult` : statuts, décodage des erreurs, payload invalide, génération de session, aucun rejeu. */
import { schemaReponseMoi } from "@elpis/contracts";
import { describe, expect, it, vi } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { ClientHttp } from "../../src/platform/http/client";
import { decoderErreur, estAmbigu, messageErreur, valeurOuNull } from "../../src/platform/http/resultat";
import { abandon, COMPTE_A, COMPTE_B, fetchManuel, json, texte } from "../aides";

const MOI = { logged_in: true, id: 1, username: "alice", is_admin: false, role: "user", avatar: null };

function client(rep: Response | Error) {
  const session = new GestionnaireSession();
  session.ouvrir(COMPTE_A);
  const f = vi.fn((_u: string, _i?: RequestInit) =>
    rep instanceof Error ? Promise.reject(rep) : Promise.resolve(rep),
  );
  return { session, http: new ClientHttp(session, f), f };
}

describe("classement des réponses", () => {
  it("succès validé par le schéma, credentials same-origin", async () => {
    const { http, f } = client(json(MOI));
    const r = await http.requete("/api/me-lite", {}, { schema: schemaReponseMoi });
    expect(r).toEqual({ type: "ok", statut: 200, valeur: MOI });
    expect(f.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin" });
  });

  it("payload invalide : forme inattendue ou JSON illisible, jamais accepté", async () => {
    const a = await client(json({ logged_in: "oui" })).http.requete("/x", {}, { schema: schemaReponseMoi });
    expect(a.type).toBe("invalide");
    const b = await client(texte("<html>", 200)).http.requete("/x", {}, { schema: schemaReponseMoi });
    expect(b).toMatchObject({ type: "invalide", raison: "JSON illisible" });
    expect(valeurOuNull(b)).toBeNull();
  });

  it("204 sans schéma : ok sans valeur", async () => {
    const r = await client(new Response(null, { status: 204 })).http.requete("/api/auth/check");
    expect(r).toEqual({ type: "ok", statut: 204, valeur: undefined });
  });

  it("401 : expiration, la session se ferme", async () => {
    const { http, session } = client(json({ detail: "not logged in" }, 401));
    expect(await http.requete("/x")).toEqual({ type: "expiration", statut: 401 });
    expect(session.etat).toMatchObject({ statut: "deconnecte", raison: "expiration" });
  });

  it("401 de la connexion (sans401) : refus de requête, session intacte", async () => {
    const { http, session } = client(json({ detail: "Identifiants invalides" }, 401));
    const r = await http.requete("/api/login-lite", { method: "POST" }, { sans401: true });
    expect(r).toMatchObject({ type: "requete", statut: 401, erreur: { detail: "Identifiants invalides" } });
    expect(session.etat.statut).toBe("connecte");
  });

  it("403 : refus, pas une expiration", async () => {
    const { http, session } = client(json({ detail: "Accès administrateur requis" }, 403));
    const r = await http.requete("/x");
    expect(r).toMatchObject({
      type: "refus",
      motDePasseAChanger: false,
      erreur: { detail: "Accès administrateur requis" },
    });
    expect(session.etat.statut).toBe("connecte");
    expect(messageErreur(r)).toBe("Accès administrateur requis");
  });

  it("403 must_change_password : la session passe en changement forcé", async () => {
    const { http, session } = client(json({ detail: "must_change_password" }, 403));
    expect(await http.requete("/x")).toMatchObject({ type: "refus", motDePasseAChanger: true });
    expect(session.etat.statut).toBe("mot_de_passe_a_changer");
  });

  it("409 conflit avec ses champs annexes", async () => {
    const r = await client(json({ detail: "modifié ailleurs", conflicts: ["a"] }, 409)).http.requete("/x");
    expect(r).toMatchObject({
      type: "conflit",
      erreur: { detail: "modifié ailleurs", brut: { conflicts: ["a"] } },
    });
  });

  it("500 en texte brut : erreur serveur sans détail décodé", async () => {
    const r = await client(texte("Internal Server Error", 500)).http.requete("/x");
    expect(r).toMatchObject({
      type: "serveur",
      statut: 500,
      erreur: { detail: null, brut: "Internal Server Error" },
    });
    expect(estAmbigu(r)).toBe(true);
    expect(messageErreur(r)).toBe("Erreur serveur (HTTP 500)");
  });

  it("panne réseau : ni expiration ni rejeu", async () => {
    const { http, session, f } = client(new TypeError("Failed to fetch"));
    const r = await http.requete("/api/chat/cancel", { method: "POST" });
    expect(r).toEqual({ type: "reseau", raison: "Failed to fetch" });
    expect(session.etat.statut).toBe("connecte");
    expect(f).toHaveBeenCalledTimes(1);
    expect(estAmbigu(r)).toBe(true);
  });

  it("annulation par l'appelant", async () => {
    expect(await client(abandon()).http.requete("/x")).toEqual({ type: "annulation" });
  });
});

describe("décodage des erreurs", () => {
  it("422 de validation : liste lisible", () => {
    const corps = JSON.stringify({
      detail: [{ type: "missing", loc: ["body", "chat_id"], msg: "Field required", input: null }],
    });
    const d = decoderErreur(corps, "application/json");
    expect(d.detail).toBe("body.chat_id : Field required");
    expect(d.validation).toHaveLength(1);
  });

  it("detail non texte ou corps non JSON : detail null", () => {
    expect(decoderErreur(JSON.stringify({ detail: { code: 3 } }), "application/json").detail).toBeNull();
    expect(decoderErreur("{oups", "application/json").detail).toBeNull();
    expect(decoderErreur("texte", null)).toEqual({ detail: null, brut: "texte", validation: null });
  });

  it("422 texte simple (HTTPException) reste une ErreurApi", () => {
    expect(decoderErreur(JSON.stringify({ detail: "titre vide" }), "application/json")).toMatchObject({
      detail: "titre vide",
      validation: null,
    });
  });
});

describe("génération de session", () => {
  it("réponse tardive après déconnexion : périmée, rien n'est réinjecté", async () => {
    const session = new GestionnaireSession();
    session.ouvrir(COMPTE_A);
    const m = fetchManuel();
    const http = new ClientHttp(session, m.fetch);
    const p = http.requete("/api/me-lite", {}, { schema: schemaReponseMoi });
    session.fermer("deconnexion");
    m.appels[0]?.repondre(json(MOI));
    expect(await p).toEqual({ type: "perime" });
  });

  it("401 tardif d'un ancien compte : la session du nouveau compte reste ouverte", async () => {
    const session = new GestionnaireSession();
    session.ouvrir(COMPTE_A);
    const m = fetchManuel();
    const http = new ClientHttp(session, m.fetch);
    const p = http.requete("/x");
    session.fermer("deconnexion");
    session.ouvrir(COMPTE_B);
    m.appels[0]?.repondre(json({ detail: "not logged in" }, 401));
    expect(await p).toEqual({ type: "perime" });
    expect(session.compte?.id).toBe(2);
  });

  it("401 concurrents : une seule fin de session", async () => {
    const session = new GestionnaireSession();
    session.ouvrir(COMPTE_A);
    const fins: string[] = [];
    session.surChangement((e) => fins.push(e.statut));
    const m = fetchManuel();
    const http = new ClientHttp(session, m.fetch);
    const ps = [http.requete("/a"), http.requete("/b"), http.requete("/c")];
    for (const a of m.appels) a.repondre(json({ detail: "not logged in" }, 401));
    const rs = await Promise.all(ps);
    expect(fins).toEqual(["deconnecte"]);
    expect(rs.map((r) => r.type).sort()).toEqual(["expiration", "perime", "perime"]);
  });

  it("corps lu après une fin de session : périmé", async () => {
    const session = new GestionnaireSession();
    session.ouvrir(COMPTE_A);
    let lire: (t: string) => void = () => {};
    const rep = {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => new Promise<string>((r) => (lire = r)),
    };
    const http = new ClientHttp(session, () => Promise.resolve(rep as unknown as Response));
    const p = http.requete("/x", {}, { schema: schemaReponseMoi });
    await new Promise((r) => setTimeout(r, 0));
    session.fermer("expiration");
    lire(JSON.stringify(MOI));
    expect(await p).toEqual({ type: "perime" });
  });
});
