// SPDX-License-Identifier: MIT
/** apps/core/test/journal-securite/diff-config.test.ts — différence de config.json pour le journal : feuilles, ajouts, suppressions, secrets à toute profondeur (env, en-têtes, arguments, query d'URL), URL, valeurs longues, plafonds. */
import { describe, expect, it } from "vitest";

import { cheminLisible, diffConfig, DIFF_MAX, DIFF_OCTETS_MAX } from "../../src/journal-securite/diff-config";

describe("diffConfig", () => {
  it("liste les feuilles modifiées, ajoutées et supprimées, dicts parcourus", () => {
    const d = diffConfig(
      { a: { b: 1, c: "x", gone: true }, same: 1, liste: [1, 2] },
      { a: { b: 2, c: "x", neuf: { z: 1 } }, same: 1, liste: [1, 3] },
    );
    expect(d.changes).toEqual([
      { path: "a.b", before: 1, after: 2 },
      { path: "a.gone", before: true, after: null },
      { path: "a.neuf.z", before: null, after: 1 },
      { path: "liste", before: [1, 2], after: [1, 3] },
    ]);
    expect(d.more).toBeUndefined();
  });

  it("n'écrit rien quand les objets sont égaux (1 et 1.0 compris)", () => {
    expect(diffConfig({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 2 }] } }).changes).toEqual([]);
  });

  it("masque les secrets, connus ou reconnus à leur dernière clé, sans révéler les valeurs", () => {
    const d = diffConfig(
      { llm: { api_key: "ancien-secret" }, x: { mon_token: "", motdepasse_db: "a", password: "p" } },
      { llm: { api_key: "nouveau-secret" }, x: { mon_token: "t", motdepasse_db: "b", password: "" } },
    );
    expect(d.changes).toEqual([
      { path: "llm.api_key", before: "********", after: "********" },
      { path: "x.mon_token", before: "", after: "********" },
      { path: "x.motdepasse_db", before: "********", after: "********" },
      { path: "x.password", before: "********", after: "" },
    ]);
    expect(JSON.stringify(d)).not.toMatch(/ancien-secret|nouveau-secret/u);
  });

  it("résume une valeur longue par sa longueur et douze chiffres de SHA-256", () => {
    const longue = "y".repeat(300);
    const d = diffConfig({ prompt: "court" }, { prompt: longue });
    expect(d.changes).toEqual([
      {
        path: "prompt",
        before: "court",
        after: { len: 302, sha256: expect.stringMatching(/^[0-9a-f]{12}$/u) },
      },
    ]);
    expect(JSON.stringify(d)).not.toContain(longue);
  });

  it("retire le mot de passe d'une URL", () => {
    const d = diffConfig({ u: "http://a" }, { u: "http://admin:Secret-Url@hote:5432/db" });
    expect(JSON.stringify(d)).not.toContain("Secret-Url");
  });

  it("jetons clients du pont MCP : chemin coupé au secret, clés jamais écrites", () => {
    const d = diffConfig(
      { mcp: { local_client_tokens: { "Jeton-Ancien-1234567890": "git" }, public_url: "x" } },
      { mcp: { local_client_tokens: { "Jeton-Nouveau-0987654321": "git,fs" }, public_url: "x" } },
    );
    expect(d.changes).toEqual([{ path: "mcp.local_client_tokens", before: "********", after: "********" }]);
    expect(JSON.stringify(d)).not.toMatch(/Jeton-Ancien|Jeton-Nouveau/u);
  });

  it("masque les secrets imbriqués : listes, dict remplacé par null, segment du chemin, en-têtes", () => {
    const d = diffConfig(
      {
        desktop: { targets: [] },
        voice: { stt: { url: "http://stt", token: "Secret-Stt-1" } },
        api_keys: { openai: "Secret-Openai-1" },
        mcp_http: { headers: { Authorization: "Bearer Secret-Bearer-1", "X-Api-Key": "Secret-Xkey-1" } },
      },
      {
        desktop: {
          targets: [{ name: "poste", agent_url: "http://p", agent_token: "Secret-Agent-1234567890" }],
        },
        voice: { stt: null },
        api_keys: { openai: "Secret-Openai-2" },
        mcp_http: { headers: { Authorization: "Bearer Secret-Bearer-2", "X-Api-Key": "Secret-Xkey-2" } },
      },
    );
    expect(d.changes).toEqual([
      { path: "api_keys", before: "********", after: "********" },
      {
        path: "desktop.targets",
        before: [],
        after: [{ name: "poste", agent_url: "http://p", agent_token: "********" }],
      },
      { path: "mcp_http.headers.Authorization", before: "********", after: "********" },
      { path: "mcp_http.headers.X-Api-Key", before: "********", after: "********" },
      { path: "voice.stt", before: { url: "http://stt", token: "********" }, after: null },
    ]);
    expect(JSON.stringify(d)).not.toContain("Secret-");
  });

  it("résidus : query d'URL, arguments, env et en-têtes, objet sous un nom de secret, nombre sous un secret", () => {
    const d = diffConfig(
      { llama: { api_key: 1 }, foo: { tokens: {} }, mcp: { servers: [] }, x: { url: "https://mcp.lan/sse" } },
      {
        llama: { api_key: 987654321 },
        foo: { tokens: { "Secret-Cle-Jeton-123": "alice" } },
        auth: { ldap: { bind_password: 123456789, ldap_bindpw: "Secret-Pw-1", bindDN_pw: "Secret-Pw-2" } },
        mcp: {
          servers: [
            {
              command: "npx",
              args: ["srv", "--token", "Secret-Arg-1", "--api-key=Secret-Arg-2"],
              env: { GITHUB_PAT: "Secret-Env-1", SLACK_BOT: "Secret-Env-2", PORT: 8080 },
              headers: { "X-Custom": "Secret-Hdr-1" },
            },
          ],
        },
        x: {
          url: "https://mcp.lan/sse?api_key=Secret-Q-1&token=Secret-Q-2&page=2",
          cb: "https://h/cb#access_token=Secret-Q-3",
          sas: "https://compte.blob/c?sv=1&sig=Secret-Q-4",
        },
      },
    );
    expect(d.changes).toEqual([
      { path: "auth.ldap.bindDN_pw", before: null, after: "********" },
      { path: "auth.ldap.bind_password", before: null, after: "********" },
      { path: "auth.ldap.ldap_bindpw", before: null, after: "********" },
      { path: "foo.tokens", before: {}, after: "********" },
      { path: "llama.api_key", before: "********", after: "********" },
      {
        path: "mcp.servers",
        before: [],
        after: [
          {
            command: "npx",
            args: ["srv", "--token", "****", "--api-key=****"],
            env: { GITHUB_PAT: "********", SLACK_BOT: "********", PORT: "********" },
            headers: { "X-Custom": "********" },
          },
        ],
      },
      { path: "x.cb", before: null, after: "https://h/cb#access_token=***" },
      { path: "x.sas", before: null, after: "https://compte.blob/c?sv=1&sig=***" },
      {
        path: "x.url",
        before: "https://mcp.lan/sse",
        after: "https://mcp.lan/sse?api_key=***&token=***&page=2",
      },
    ]);
    expect(JSON.stringify(d)).not.toContain("Secret-");
  });

  it("serveur MCP présenté : arguments, variables d'environnement et en-têtes masqués, clés lisibles", () => {
    const serveur = {
      args: ["--token", "Secret-Arg-1"],
      env: { GITHUB_PAT: "Secret-Env-1", PORT: 8080 },
      headers: { "X-Custom": "Secret-Hdr-1" },
    };
    expect(diffConfig({ mcp: { servers: [] } }, { mcp: { servers: [serveur] } }).changes).toEqual([
      {
        path: "mcp.servers",
        before: [],
        after: [
          {
            args: ["--token", "****"],
            env: { GITHUB_PAT: "********", PORT: "********" },
            headers: { "X-Custom": "********" },
          },
        ],
      },
    ]);
    expect(
      diffConfig({ s: { env: { A: "Secret-1" } } }, { s: { env: { A: "Secret-2", B: 3 } } }).changes,
    ).toEqual([
      { path: "s.env.A", before: "********", after: "********" },
      { path: "s.env.B", before: null, after: "********" },
    ]);
  });

  it("règles de mot de passe parcourues et lisibles ; chemin du journal de l'app coupé à une clé de secret", () => {
    const d = diffConfig(
      { security: { password_policy: { min_length: 8, require_digit: false } } },
      { security: { password_policy: { min_length: 12, require_digit: true } } },
    );
    expect(d.changes).toEqual([
      { path: "security.password_policy.min_length", before: 8, after: 12 },
      { path: "security.password_policy.require_digit", before: false, after: true },
    ]);
    expect(cheminLisible(["foo", "tokens", "Secret-Cle"])).toBe("foo.tokens");
    expect(cheminLisible(["api_keys", "openai"])).toBe("api_keys");
    expect(cheminLisible(["x", "env", "GITHUB_PAT"])).toBe("x.env.GITHUB_PAT");
    expect(cheminLisible(["security", "password_policy", "min_length"])).toBe(
      "security.password_policy.min_length",
    );
  });

  it("un nombre ou un booléen sous un nom de secret reste lisible (réglages *_tokens)", () => {
    const d = diffConfig(
      { llm: { compaction: { buffer_tokens: 1000, threshold_tokens: 8000 } }, x: { token_on: false } },
      { llm: { compaction: { buffer_tokens: 2000, threshold_tokens: 8000 } }, x: { token_on: true } },
    );
    expect(d.changes).toEqual([
      { path: "llm.compaction.buffer_tokens", before: 1000, after: 2000 },
      { path: "x.token_on", before: false, after: true },
    ]);
  });

  it("identifiants d'URL : retirés quand l'URL se lit, valeur masquée sinon", () => {
    const d = diffConfig(
      { a: "", b: "", c: "", e: "" },
      {
        a: "http://u:Secret-Arobase@ss@proxy:3128",
        b: "redis://:Secret-Pa/ss@h:6379",
        c: "postgres://u:Secret pass@h/db",
        e: "http://h/p?mail=a@b",
      },
    );
    expect(d.changes.map((c) => c.after)).toEqual([
      "http://***@proxy:3128/",
      "********",
      "postgres://***@h/db",
      "http://h/p?mail=a@b",
    ]);
    expect(JSON.stringify(d)).not.toContain("Secret");
  });

  it("borne les changements en octets : la ligne du journal tient en 4096 octets", () => {
    const apres = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`k${String(i).padStart(2, "0")}`, "é".repeat(190)]),
    );
    const d = diffConfig({}, apres);
    expect(Buffer.byteLength(JSON.stringify(d.changes), "utf8")).toBeLessThanOrEqual(DIFF_OCTETS_MAX);
    expect(d.changes.length + (d.more ?? 0)).toBe(50);
    expect(d.more).toBeGreaterThan(0);
  });

  it("plafonne à 50 changements et compte le reste", () => {
    const apres = Object.fromEntries(
      Array.from({ length: 70 }, (_, i) => [`k${String(i).padStart(2, "0")}`, i]),
    );
    const d = diffConfig({}, apres);
    expect(d.changes).toHaveLength(DIFF_MAX);
    expect(d.more).toBe(20);
  });
});
