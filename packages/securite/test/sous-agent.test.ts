// SPDX-License-Identifier: MIT
/** packages/securite/test/sous-agent.test.ts — périmètre d'un sous-agent : profils par type et lecture seule du manifeste, champ transmis à l'hôte lu en fermant, enveloppe signée compatible, masquage des secrets d'un rapport. */
import { describe, expect, it } from "vitest";

import { creerIdentite, fromMeta, identityFromDict, sign, verify } from "../src/identite";
import { masquerSecretsTexte } from "../src/secrets";
import {
  envShellSousAgent,
  lireSousAgent,
  outilPermisSousAgent,
  OUTILS_JAMAIS_SOUS_AGENT,
  relatifBac,
  sousAgentEnDict,
} from "../src/sous-agent";
import type { SousAgent } from "../src/sous-agent";

const sa = (s: Partial<SousAgent> = {}): SousAgent => ({
  type: "implement",
  read_only: false,
  ...s,
});

describe("manifeste : profils et lecture seule", () => {
  it("shell_job jamais ; verify sans écriture ni git d'écriture ; implement sans commit ; lecture seule = outils annotés lecture, pw_* gardés", () => {
    expect(outilPermisSousAgent(null, "shell_job", false)).toBe(true);
    for (const t of ["explore", "verify", "implement", "pr", "web", "revue"])
      expect(outilPermisSousAgent(sa({ type: t }), "shell_job", false), t).toBe(false);
    for (const o of ["write_file", "edit_file", "manage_files", "git_write", "git_commit", "git_clone"])
      expect(outilPermisSousAgent(sa({ type: "verify" }), o, false), o).toBe(false);
    expect(outilPermisSousAgent(sa({ type: "verify" }), "execute_shell", false)).toBe(true);
    for (const o of ["git_commit", "git_submit", "git_start_work", "git_abandon"])
      expect(outilPermisSousAgent(sa(), o, false), o).toBe(false);
    expect(outilPermisSousAgent(sa(), "write_file", false)).toBe(true);
    expect(outilPermisSousAgent(sa({ type: "pr" }), "git_commit", false)).toBe(true);
    const ro = sa({ type: "explore", read_only: true });
    expect(outilPermisSousAgent(ro, "read_file", true)).toBe(true);
    expect(outilPermisSousAgent(ro, "execute_shell", false)).toBe(false);
    expect(outilPermisSousAgent(ro, "write_file", false)).toBe(false);
    expect(outilPermisSousAgent(ro, "pw_act", false, true)).toBe(true);
  });

  it("pw_* gardés en lecture seule pour le seul serveur d'outils intégré, pas pour un outil tiers du même préfixe", () => {
    const ro = sa({ type: "custom", read_only: true });
    expect(outilPermisSousAgent(ro, "pw_create_ticket", false)).toBe(false);
    expect(outilPermisSousAgent(ro, "pw_delete", false)).toBe(false);
    expect(outilPermisSousAgent(ro, "pw_act", false, true)).toBe(true);
    expect(outilPermisSousAgent(ro, "lancer", false, true)).toBe(false);
  });

  it("jamais offerts, quel que soit le type : task, shell_job, ask_user, routine_save, agent_save et git_submit (hors du bac)", () => {
    expect([...OUTILS_JAMAIS_SOUS_AGENT].sort()).toEqual([
      "agent_save",
      "ask_user",
      "git_submit",
      "routine_save",
      "shell_job",
      "task",
    ]);
    for (const t of ["explore", "verify", "implement", "pr", "web", "custom"])
      for (const o of OUTILS_JAMAIS_SOUS_AGENT)
        expect(outilPermisSousAgent(sa({ type: t }), o, true), `${t}/${o}`).toBe(false);
    expect(outilPermisSousAgent(null, "git_submit", false)).toBe(true);
  });

  it("chemin vu du bac normalisé", () => {
    expect([relatifBac("./a//b/"), relatifBac("~/a"), relatifBac("/work"), relatifBac("../a")]).toEqual([
      "a/b",
      "a",
      "",
      null,
    ]);
  });
});

describe("champ transmis à l'hôte d'outils", () => {
  it("type, id et session de navigateur seulement ; lu en fermant ; environnement shell de verify et d'implement", () => {
    expect(sousAgentEnDict({ ...sa({ deadline_ms: 9 }), id: "t1-ab" })).toEqual({
      type: "implement",
      id: "t1-ab",
    });
    expect(sousAgentEnDict({ type: "web", browser_session: "user" })).toEqual({
      type: "web",
      browser_session: "user",
    });
    expect(lireSousAgent(undefined)).toBeNull();
    expect(lireSousAgent("x")).toEqual({ type: "custom", browser_session: "isolated" });
    expect(
      lireSousAgent({ type: "verify", read_only: false, writable_paths: ["/work/t"], remaining_ms: 5 }),
    ).toEqual({ type: "verify", browser_session: "isolated" });
    expect(lireSousAgent({ type: "Bad Type!", id: "../x", browser_session: "USER" })).toEqual({
      type: "custom",
      browser_session: "isolated",
    });
    expect(lireSousAgent({ type: "web", id: "t2-cd", browser_session: "user" })).toEqual({
      type: "web",
      id: "t2-cd",
      browser_session: "user",
    });
    expect(envShellSousAgent(sa({ type: "verify" }))).toEqual({
      PYTHONDONTWRITEBYTECODE: "1",
      PYTEST_ADDOPTS: "-p no:cacheprovider",
    });
    expect(envShellSousAgent(sa({ type: "implement" }))).toEqual({ PYTHONDONTWRITEBYTECODE: "1" });
    expect(envShellSousAgent(sa({ type: "pr" }))).toEqual({});
    expect(envShellSousAgent(sa({ type: "custom" }))).toEqual({});
    expect(envShellSousAgent(null)).toEqual({});
  });
});

describe("enveloppe d'identité : champ subagent facultatif", () => {
  it("absent : forme signée inchangée (type d'enveloppe compris) ; présent : signé, vérifié et relu ; _meta porte le champ", () => {
    const sans = creerIdentite({ user_id: 7, username: "hugo" });
    const charge = (e: string): string => Buffer.from(e.split(".")[0] ?? "", "base64url").toString("utf8");
    expect(charge(sign(sans, "svc", { now: 1.5 }))).toBe(
      '{"chat_id":"","is_admin":false,"network_profile_id":"","roles":[],"ts":1.5,"typ":"identite","user_id":7,"username":"hugo"}',
    );
    expect(sans).not.toHaveProperty("subagent");
    const enfant = { type: "explore", id: "t1-ab" };
    const avec = creerIdentite({ user_id: 7, username: "hugo", subagent: enfant });
    expect(verify(sign(avec, "svc"), "svc")?.subagent).toEqual({ ...enfant, browser_session: "isolated" });
    expect(identityFromDict({ user_id: 7, username: "hugo" })).not.toHaveProperty("subagent");
    expect(fromMeta({ username: "hugo", subagent: { type: "verify", read_only: false } })?.subagent).toEqual({
      type: "verify",
      browser_session: "isolated",
    });
    expect(fromMeta({ username: "hugo" })).not.toHaveProperty("subagent");
  });
});

describe("masquage des secrets d'un rapport", () => {
  it("jetons connus (4 caractères au plus), affectations nommées, porteur, clé privée ; exemples et prose intacts", () => {
    const aws = ["AKIA", "Q3EGRZ7L", "K2MXN4PB"].join("");
    const gh = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const cle = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA".repeat(4),
      "-----END RSA PRIVATE KEY-----",
    ];
    const { texte, n } = masquerSecretsTexte(
      [
        `clé ${aws} trouvée dans .env.prod`,
        `jeton ${gh}`,
        "DB_PASSWORD=hunter2hunter",
        '"api_key": "s3cr3tvalue"',
        "Authorization: Bearer abcdefghijklmnop123",
        ...cle,
        "author: Jean Dupont ; password: changeme ; token: ${TOKEN}",
      ].join("\n"),
    );
    expect(texte).toBe(
      [
        "clé AKIA**** trouvée dans .env.prod",
        "jeton ghp_****",
        "DB_PASSWORD=****",
        '"api_key": "****"',
        "Authorization: Bearer ****",
        "-----BEGIN RSA PRIVATE KEY-----",
        "****",
        "-----END RSA PRIVATE KEY-----",
        "author: Jean Dupont ; password: changeme ; token: ${TOKEN}",
      ].join("\n"),
    );
    expect(n).toBe(6);
    for (const v of [aws, gh, "hunter2hunter", "s3cr3tvalue", "abcdefghijklmnop123"])
      expect(texte).not.toContain(v);
  });

  it("rapport géant masqué en temps linéaire ; affectations masquées comme avant, nom long compris", () => {
    const debut = performance.now();
    const tirets = masquerSecretsTexte("a-".repeat(32_000));
    const cle = masquerSecretsTexte(`-----BEGIN PRIVATE KEY-----\n${"<".repeat(64_000)}`);
    expect(performance.now() - debut).toBeLessThan(1000);
    // Un en-tête sans corps de clé n'efface plus la suite du texte.
    expect([tirets.n, tirets.texte.length, cle.n, cle.texte.length]).toEqual([0, 64_000, 0, 64_028]);
    const long = "a".repeat(200);
    expect(
      masquerSecretsTexte(
        `--token=abcd1234 config.db_password: 'xyzw1234' 9=token:abcdef ${long}_password=hunter2hunter`,
      ).texte,
    ).toBe(`--token=**** config.db_password: '****' 9=token:**** ${long}_password=****`);
  });

  it("en-têtes de clé avalés par une ligne `Comment:` : chacun n'est pas relu jusqu'à la fin (temps linéaire)", () => {
    const ligne = "Comment: -----BEGIN PRIVATE KEY-----\n";
    for (const taille of [64_000, 2_000_000]) {
      const texte = ligne.repeat(Math.ceil(taille / ligne.length)).slice(0, taille);
      const debut = performance.now();
      const r = masquerSecretsTexte(texte);
      expect(performance.now() - debut).toBeLessThan(500);
      expect(r).toEqual({ texte, n: 0 });
    }
  });

  it("identifiants d'URL, en-têtes quelle que soit la casse, noms en PASS et _KEY ; clé sans fin : la suite reste lisible", () => {
    const corps = "MIIEowIBAAKCAQEA".repeat(4);
    const { texte, n } = masquerSecretsTexte(
      [
        "dépôt https://alice:s3cr3t@git.lan/r.git",
        "authorization: basic YWxpY2U6eA== ; Cookie: sid=abc123; theme=dark",
        "DB_PASS=hunter2x SECRET_KEY: k3yk3yk3y",
        `-----BEGIN PRIVATE KEY-----\n${corps}\nLa clé ci-dessus vient de config/app.env.`,
      ].join("\n"),
    );
    expect(texte).toBe(
      [
        "dépôt https://alice:****@git.lan/r.git",
        "authorization: basic **** ; Cookie: ****",
        "DB_PASS=**** SECRET_KEY: ****",
        "-----BEGIN PRIVATE KEY-----\n****\nLa clé ci-dessus vient de config/app.env.",
      ].join("\n"),
    );
    expect(n).toBe(6);
  });

  it("affectation après un nom ordinaire, jeton en nom d'URL, mots de passe SQL", () => {
    const { texte, n } = masquerSecretsTexte(
      [
        "config: db_password=hunter2xx",
        "url: https://h/x?user=a&password=hunter3xx&next=/",
        '{"password":"hunter4xx"}',
        "https://0123456789abcdef0123456789abcdef01234567@gitea.lan/r.git https://aB3dE5gH7jK9mN1pQ3sT@h/r",
        "https://deploy-bot-account-2024@h/r https://oauth2@h/r",
        "CREATE USER a IDENTIFIED BY 'hunter5xx'; ALTER ROLE b WITH PASSWORD 'hunter6xx'; SELECT PASSWORD('hunter7xx')",
      ].join("\n"),
    );
    expect(texte).toBe(
      [
        "config: db_password=****",
        "url: https://h/x?user=a&password=****&next=/",
        '{"password":"****"}',
        "https://****@gitea.lan/r.git https://****@h/r",
        "https://deploy-bot-account-2024@h/r https://oauth2@h/r",
        "CREATE USER a IDENTIFIED BY '****'; ALTER ROLE b WITH PASSWORD '****'; SELECT PASSWORD('****')",
      ].join("\n"),
    );
    expect(n).toBe(8);
  });

  it("emplacements de format (f-string, str.format, printf) : du code, pas un secret, laissé intact", () => {
    for (const code of [
      'raise ValueError(f"unknown token: {token!r}")',
      'log.info("api_key: {key}")',
      'print("password=%(pwd)s" % d)',
      'print("token: %s" % t)',
    ])
      expect(masquerSecretsTexte(code)).toEqual({ texte: code, n: 0 });
    expect(masquerSecretsTexte("token: abcdef123456").texte).toBe("token: ****");
  });
});
