// SPDX-License-Identifier: MIT
/** apps/core/test/relais/vecteurs.test.ts — relais vers l'hôte d'outils : vecteurs de shared_infra/sandbox/relay.py (Phase 0) rejoués. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ErreurPython } from "@elpis/commun";
import { parseJsonPy } from "@elpis/config";
import { identityToDict } from "@elpis/securite";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { remplacerBase } from "../../src/base";
import { checkPreviewToken, makePreviewToken, previewPathUid } from "../../src/relais/apercu";
import {
  codeFermeture,
  ENREGISTRES_PAR_MAIN,
  entetesReponse,
  entetesRequete,
  FWD_REQ_HEADERS,
  HOP_BY_HOP,
  isPreviewPath,
  isRelayedPath,
  PREVIEW_PREFIXES,
  raisonFermeture,
  RELAY_PREFIXES,
  SERVIS_PAR_MAIN,
  unquotePy,
  upstreamPath,
  urlAmont,
  wsUrl,
} from "../../src/relais/chemins";
import {
  hostFromSpec,
  isLoopback,
  lireHotes,
  oublierHotes,
  sandboxHostFor,
  stripMcpPath,
} from "../../src/relais/hotes";
import { identiteRelais, resolveNetworkProfileId } from "../../src/relais/identite";
import { SESSION_RECHECK_MS } from "../../src/relais/index";
import { leastLoaded } from "../../src/relais/placement";
import { decouperCible } from "@elpis/http";
import { configBacDepuis, DOMAIN_RE, PROFILE_ID_RE, profilParId } from "@elpis/bac";

type Paires = [string, string][];
type Resultat<T> = { valeur: T } | { erreur: string };

interface Vecteurs {
  prefixes: string[];
  prefixes_apercu: string[];
  servis_par_main: string[];
  session_recheck_s: number;
  enregistres_par_main: string[];
  hop_by_hop: string[];
  entetes_retenus: string[];
  chemins: {
    brut: string;
    requete: string;
    decode: string;
    relaye: boolean;
    apercu: boolean;
    upstream_path: string | null;
    url: Resultat<{ chemin: string; requete: string } | null>;
  }[];
  cibles: ({ cible: string } & Resultat<{ chemin: string; requete: string }>)[];
  unquote: { entree: string; sortie: string }[];
  apercu: {
    secret: string;
    maintenant: number;
    jetons: { uid: number; ttl: number; jeton: string; exp: number }[];
    controles: ({ jeton: string; maintenant: number } & Resultat<number | null>)[];
    chemins: ({ chemin: string } & Resultat<number | null>)[];
  };
  http: {
    requetes: { entetes: Paires; amont: Record<string, string> }[];
    sans_ip: Record<string, string>;
    reponses: { entetes: Paires; statut: number; sortie: Paires }[];
  };
  fermetures: { code: number | null; raison: string; client: number; raison_client: string }[];
  ws_url: { url: string; ws: string }[];
  loopback: { url: string; loopback: boolean }[];
  specs: { spec: Record<string, unknown>; hote: Record<string, unknown> | null }[];
  strip_mcp_path: ({ url: string } & Resultat<string>)[];
  profils: { reglages: Record<string, unknown>; profil: string }[];
  identites_relais: { reglages: Record<string, unknown>; identite: Record<string, unknown> }[];
  config_bac: ({ texte: string; avertissements: string[]; profils?: [string, string][] } & (
    { config: Record<string, unknown> } | { erreur: string }
  ))[];
  regles_profils: { texte: string; id: boolean; domaine: boolean }[];
  moins_charges: { comptes: Record<string, number>; choix: string; un_seul: string; aucun: string }[];
  fichiers: Record<string, string>;
  manifestes: {
    nom: string;
    texte: string;
    env: Record<string, string>;
    hotes: [string, Record<string, unknown>][] | null;
    placement: Record<string, unknown> | null;
    hote: { id: string; url: string; token: string; relay: boolean; ws: string } | null;
  }[];
}

const V = JSON.parse(readFileSync(new URL("../vecteurs/relais.json", import.meta.url), "utf-8")) as Vecteurs;

function aplatir(paires: Paires): string[] {
  return paires.flat();
}

function resultat<T>(fn: () => T): Resultat<T> {
  try {
    return { valeur: fn() };
  } catch (e) {
    return {
      erreur: e instanceof ErreurPython ? e.type : e instanceof RangeError ? "ValueError" : String(e),
    };
  }
}

function sansNaN(v: unknown): unknown {
  if (typeof v === "number" && Number.isNaN(v)) return "NaN";
  if (Array.isArray(v)) return v.map(sansNaN);
  if (v !== null && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sansNaN(x)]));
  return v;
}

function parNom(paires: Paires): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const [nom, valeur] of paires) m.set(nom, [...(m.get(nom) ?? []), valeur]);
  return m;
}

describe("constantes du relais", () => {
  it("préfixes, aperçus, chemins servis par main, en-têtes retirés et retenus identiques au Python", () => {
    expect([...RELAY_PREFIXES]).toEqual(V.prefixes);
    expect([...PREVIEW_PREFIXES]).toEqual(V.prefixes_apercu);
    expect([...SERVIS_PAR_MAIN]).toEqual(V.servis_par_main);
    expect(SESSION_RECHECK_MS).toBe(V.session_recheck_s * 1000);
    expect([...ENREGISTRES_PAR_MAIN]).toEqual(V.enregistres_par_main);
    expect([...HOP_BY_HOP].sort()).toEqual(V.hop_by_hop);
    expect([...FWD_REQ_HEADERS]).toEqual(V.entetes_retenus);
  });
});

describe("chemins : décodage, refus et URL amont", () => {
  it.each(V.chemins.map((c) => [`${c.brut} ?${c.requete}`, c] as const))("%s", (_nom, c) => {
    expect(unquotePy(c.brut)).toBe(c.decode);
    expect(isRelayedPath(c.decode)).toBe(c.relaye);
    expect(isPreviewPath(c.decode)).toBe(c.apercu);
    expect(upstreamPath(c.brut)).toBe(c.upstream_path);
    expect("valeur" in c.url).toBe(true);
    const attendu = "valeur" in c.url ? c.url.valeur : undefined;
    const url = urlAmont("http://127.0.0.1:8765", c.brut, c.requete);
    if (attendu === null || attendu === undefined) {
      expect(url).toBeNull();
    } else {
      expect(url).not.toBeNull();
      expect(unquotePy(url?.pathname ?? "")).toBe(attendu.chemin);
      expect(unquotePy((url?.search ?? "").slice(1))).toBe(attendu.requete);
      expect(`${url?.origin}`).toBe("http://127.0.0.1:8765");
    }
  });

  it.each(V.unquote.map((u) => [JSON.stringify(u.entree), u] as const))("unquote %s", (_nom, u) => {
    expect(unquotePy(u.entree)).toBe(u.sortie);
  });

  it.each(V.cibles.map((c) => [c.cible, c] as const))("cible %s (httptools.parse_url)", (_nom, c) => {
    expect(resultat(() => decouperCible(c.cible))).toEqual(
      "valeur" in c ? { valeur: c.valeur } : { erreur: c.erreur },
    );
  });
});

describe("jeton d'aperçu", () => {
  const options = (maintenant: number) => ({ secret: V.apercu.secret, maintenant });

  it("jetons émis à l'identique (clé dérivée du secret, signature tronquée à 32)", () => {
    for (const j of V.apercu.jetons) {
      expect(makePreviewToken(j.uid, j.ttl, options(V.apercu.maintenant))).toEqual([j.jeton, j.exp]);
    }
  });

  it.each(V.apercu.controles.map((c) => [`${c.jeton} @${c.maintenant}`, c] as const))(
    "contrôle %s",
    (_n, c) => {
      const r = resultat(() => checkPreviewToken(c.jeton, options(c.maintenant)));
      expect(r).toEqual("valeur" in c ? { valeur: c.valeur } : { erreur: c.erreur });
    },
  );

  it("propriétaire d'un chemin d'aperçu", () => {
    for (const c of V.apercu.chemins) {
      const r = resultat(() => previewPathUid(c.chemin, options(V.apercu.maintenant)));
      expect(r, c.chemin).toEqual("valeur" in c ? { valeur: c.valeur } : { erreur: c.erreur });
    }
  });
});

describe("en-têtes relayés", () => {
  it("requête : liste blanche, le dernier l'emporte, jeton de service, enveloppe, X-Forwarded-For", () => {
    for (const r of V.http.requetes) {
      const amont = {
        ...entetesRequete(aplatir(r.entetes)),
        authorization: "Bearer svc",
        "x-elpis-identity": "<signé>",
        "x-forwarded-for": "10.0.0.9",
      };
      expect(amont).toEqual(r.amont);
    }
    expect({ ...entetesRequete([]), authorization: "Bearer svc", "x-elpis-identity": "<signé>" }).toEqual(
      V.http.sans_ip,
    );
  });

  it("réponse : hop-by-hop retirés, doublons gardés, x-accel-buffering ajouté", () => {
    for (const r of V.http.reponses) {
      expect(entetesReponse(aplatir(r.entetes))).toEqual(parNom(r.sortie));
    }
  });
});

describe("fermeture WebSocket", () => {
  it("codes réservés ou hors bornes → 1011, comme _relay_ws", () => {
    for (const f of V.fermetures)
      if (f.code !== null) expect(codeFermeture(f.code), String(f.code)).toBe(f.client);
  });

  it("raison tronquée à 120 points de code, puis aux 123 octets d'une trame", () => {
    for (const f of V.fermetures) {
      const r = raisonFermeture(f.raison);
      if (Buffer.byteLength(f.raison_client, "utf8") <= 123) expect(r).toBe(f.raison_client);
      else {
        expect(f.raison_client.startsWith(r)).toBe(true);
        expect(Buffer.byteLength(r, "utf8")).toBeLessThanOrEqual(123);
        expect(Buffer.byteLength(f.raison_client.slice(0, r.length + 2), "utf8")).toBeGreaterThan(123);
      }
    }
  });
});

describe("hôtes d'outils", () => {
  it("URL WebSocket, boucle locale, entrée d'hôte, origine d'une URL MCP, profil réseau", () => {
    for (const w of V.ws_url) expect(wsUrl(w.url)).toBe(w.ws);
    for (const l of V.loopback) expect(isLoopback(l.url), l.url).toBe(l.loopback);
    for (const s of V.specs) expect(hostFromSpec("h", s.spec), JSON.stringify(s.spec)).toEqual(s.hote);
    for (const s of V.strip_mcp_path) {
      expect(resultat(() => stripMcpPath(s.url))).toEqual(
        "valeur" in s ? { valeur: s.valeur } : { erreur: s.erreur },
      );
    }
    for (const p of V.profils) expect(resolveNetworkProfileId(p.reglages)).toBe(p.profil);
  });

  describe("manifeste", () => {
    let dossier = "";
    const variables = [
      "APP_MCP_MANIFEST",
      "LOCAL_MCP_URL",
      "LOCAL_MCP_TOKEN",
      "VECTEUR_URL",
      "VECTEUR_ABSENT",
    ];
    const avant = Object.fromEntries(variables.map((v) => [v, process.env[v]]));

    const restaurer = (): void => {
      for (const [v, x] of Object.entries(avant)) {
        if (x === undefined) delete process.env[v];
        else process.env[v] = x;
      }
    };

    beforeAll(() => {
      dossier = mkdtempSync(join(tmpdir(), "elpis-relais-mcp-"));
      for (const [nom, hex] of Object.entries(V.fichiers))
        writeFileSync(join(dossier, nom), Buffer.from(hex, "hex"));
    });

    afterAll(() => {
      restaurer();
      oublierHotes();
      rmSync(dossier, { recursive: true, force: true });
    });

    it.each(V.manifestes.map((m) => [m.nom, m] as const))("%s", async (nom, m) => {
      const chemin = join(dossier, `${nom}.json`);
      writeFileSync(chemin, m.texte.replaceAll("<dossier>", dossier), "utf-8");
      for (const v of variables) delete process.env[v];
      Object.assign(process.env, m.env, { APP_MCP_MANIFEST: chemin });
      oublierHotes();
      const declares = lireHotes();
      const remplacer = (v: unknown): unknown =>
        JSON.parse(JSON.stringify(v).replaceAll(dossier, "<dossier>"));
      expect(remplacer(sansNaN([...declares.hotes].map(([id, spec]) => [id, { ...spec }])))).toEqual(
        m.hotes ?? [],
      );
      expect({ ...declares.placement }).toEqual(m.placement ?? {});
      const hote = await sandboxHostFor(null);
      expect(hote === null ? null : { ...hote, ws: wsUrl(hote.url) }).toEqual(m.hote);
    });
  });

  describe("moins chargé (placement by_user)", () => {
    it("compte par hôte, ordre de déclaration pour départager, défaut sans URL", async () => {
      const hotes = new Map<string, Record<string, unknown>>([
        ["a", { url: "http://a" }],
        ["b", { url: "http://b" }],
        ["c", { url: " " }],
        ["d", { url: "http://d" }],
      ]);
      for (const cas of V.moins_charges) {
        const t = ouvrirBaseDeTest("sqlite");
        try {
          await initialiserBase(t.base);
          let uid = 1;
          for (const [hote, n] of Object.entries(cas.comptes)) {
            for (let i = 0; i < n; i++) {
              await t.base.run(
                "INSERT INTO sandbox_placements(user_id, host_id, created_at, updated_at) VALUES (?, ?, 0, 0)",
                [uid++, hote],
              );
            }
          }
          remplacerBase(t.base);
          expect(await leastLoaded(hotes, "defaut")).toBe(cas.choix);
          expect(
            await leastLoaded(
              new Map([
                ["c", { url: "" }],
                ["b", { url: "http://b" }],
              ]),
              "defaut",
            ),
          ).toBe(cas.un_seul);
          expect(await leastLoaded(new Map([["c", { url: "  " }]]), "defaut")).toBe(cas.aucun);
        } finally {
          remplacerBase(undefined);
          await t.fermer();
        }
      }
    });
  });
});

describe("profils réseau revérifiés à la lecture (7867257, 4c76244)", () => {
  it("règles de la console : identifiant, domaine en IGNORECASE ASCII", () => {
    for (const r of V.regles_profils) {
      expect([PROFILE_ID_RE.test(r.texte), DOMAIN_RE.test(r.texte)], JSON.stringify(r.texte)).toEqual([
        r.id,
        r.domaine,
      ]);
    }
  });

  it.each(V.config_bac.map((c) => [c.texte.slice(0, 70), c] as const))("executors %s", (_nom, c) => {
    const avertis: string[] = [];
    const r = resultat(() => configBacDepuis(parseJsonPy(c.texte), (m) => avertis.push(`[sandbox] ${m}`)));
    expect([...new Set(avertis)]).toEqual(c.avertissements);
    if ("erreur" in c) {
      expect(r).toEqual({ erreur: c.erreur });
      return;
    }
    if (!("valeur" in r)) throw new Error(`erreur inattendue : ${r.erreur}`);
    expect(r.valeur).toEqual(c.config);
    expect(c.profils?.map(([id]) => [id, profilParId(r.valeur, id).id])).toEqual(c.profils);
  });
});

describe("identité du relais (_identity_for) : profil effectif et imposition transmise", () => {
  it("enveloppe de main pour chaque réglage du compte", async () => {
    const t = ouvrirBaseDeTest("sqlite");
    try {
      await initialiserBase(t.base);
      remplacerBase(t.base);
      for (const [i, cas] of V.identites_relais.entries()) {
        const uid = 100 + i;
        await t.base.run(
          "INSERT INTO users(id, username, pass_salt, pass_hash, created_at, is_admin, settings_json) VALUES (?, ?, 's', 'h', 0, 1, ?)",
          [uid, `hugo${i}`, JSON.stringify(cas.reglages)],
        );
        const obtenu = identityToDict(await identiteRelais(uid));
        expect({ ...obtenu, user_id: 7, username: "hugo" }, JSON.stringify(cas.reglages)).toEqual(
          cas.identite,
        );
      }
    } finally {
      remplacerBase(undefined);
      await t.fermer();
    }
  });
});
