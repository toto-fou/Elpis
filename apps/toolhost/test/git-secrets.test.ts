// SPDX-License-Identifier: MIT
/** apps/toolhost/test/git-secrets.test.ts — recherche de secrets du diff indexé (harnais B-06) : familles de motifs, valeurs d'exemple écartées, binaires ignorés, aperçu masqué ; secrets factices assemblés à l'exécution. */
import type { Golden } from "@elpis/outils-mcp";
import goldenGit from "@elpis/outils-mcp/goldens/git.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { cheminDiff, masquer, secretsDuDiff } from "../src/mcp/git/secrets";

/** Morceaux recollés : aucun jeton plausible n'apparaît tel quel dans ce fichier. */
const j = (...m: string[]): string => m.join("");
const F = {
  aws: j("AK", "IA", "Q7RZ3W5T2Y8U4P6M"),
  awsSecret: j("Zq8Rt", "Lm2Kp9", "Xv4Nb7Wc1Hy6Jd3Fs5G", "Qe8Ui2Ok4P"),
  github: j("gh", "p_", "Zq8Rt3Lm2Kp9Xv4Nb7Wc1Hy6Jd3Fs5Ga0Qe8"),
  githubPat: j("github", "_pat_", "11ABCDEFG0", "Zq8Rt3Lm2Kp9Xv4Nb7Wc1Hy6"),
  gitlab: j("gl", "pat-", "Zq8Rt3Lm2Kp9Xv4Nb7Wc"),
  slack: j("xo", "xb-", "1234567890-Zq8Rt3Lm2Kp9"),
  webhook: j("https://hooks.", "slack.com/services/", "T0123ABCD/B0123ABCD/Zq8Rt3Lm2Kp9Xv4Nb7Wc1Hy6"),
  stripe: j("sk", "_live_", "Zq8Rt3Lm2Kp9Xv4Nb7Wc1Hy6"),
  google: j("AI", "za", "Sy", "Zq8Rt3Lm2Kp9Xv4Nb7Wc1Hy6Jd3Fs5Ga0"),
  pem: j("-----BEGIN ", "RSA PRIVATE ", "KEY-----"),
  corps: j("MIIEow", "IBAAKCAQEA", "Zq8Rt3Lm2Kp9Xv4Nb7Wc1Hy6Jd3Fs5Ga0Qe8Ui2Ok4P"),
};

/** Diff `-U0` d'un fichier ajouté avec ces lignes. */
function diff(fichier: string, lignes: string[], debut = 1): string {
  return [
    `diff --git a/${fichier} b/${fichier}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${fichier}`,
    `@@ -0,0 +${debut},${lignes.length} @@`,
    ...lignes.map((l) => "+" + l),
  ].join("\n");
}

describe("secrets du diff indexé (harnais B-06)", () => {
  it("chaque famille est trouvée, à sa ligne, sans jamais montrer la valeur", () => {
    const lignes = [
      `aws_key = "${F.aws}"`,
      `aws_secret_access_key = ${F.awsSecret}`,
      `TOKEN = '${F.github}'`,
      `pat: ${F.githubPat}`,
      `gitlab ${F.gitlab}`,
      `slack = ${F.slack}`,
      `hook = "${F.webhook}"`,
      `stripe = ${F.stripe}`,
      `google = ${F.google}`,
      F.pem,
      F.corps,
    ];
    const t = secretsDuDiff(diff("src/config.py", lignes, 10));
    expect(t.map((x) => [x.line, x.kind])).toEqual([
      [10, "aws_access_key_id"],
      [11, "aws_secret_access_key"],
      [12, "github_token"],
      [13, "github_token"],
      [14, "gitlab_token"],
      [15, "slack_token"],
      [16, "slack_webhook"],
      [17, "stripe_live_key"],
      [18, "google_api_key"],
      [19, "private_key"],
    ]);
    expect(t.every((x) => x.file === "src/config.py")).toBe(true);
    const tout = JSON.stringify(t);
    for (const v of [
      F.aws,
      F.awsSecret,
      F.github,
      F.githubPat,
      F.gitlab,
      F.slack,
      F.webhook,
      F.stripe,
      F.google,
    ])
      expect(tout).not.toContain(v.slice(-12));
    expect(t[2]?.preview).toBe("ghp_****(40 chars)");
  });

  it("fichiers .env : affectations au nom de secret ; modèles, références et valeurs vides écartés", () => {
    const env = [
      "DEBUG=true",
      `DB_PASSWORD=${j("s3cr", "et-Pa", "ss!")}`,
      'API_KEY="Zq8Rt3Lm2Kp9" # clé',
      "export AUTH_TOKEN=$OTHER_VAR",
      "SECRET_KEY=",
      "PASSWORD=changeme",
    ];
    expect(secretsDuDiff(diff(".env.local", env)).map((x) => [x.line, x.kind, x.preview])).toEqual([
      [2, "env_secret", "DB_PASSWORD=****(12 chars)"],
      [3, "env_secret", "API_KEY=****(12 chars)"],
    ]);
    expect(secretsDuDiff(diff(".env.example", env))).toEqual([]);
    expect(secretsDuDiff(diff("config/settings.txt", env))).toEqual([]);
  });

  it("en-tête PEM seul signalé à part (harnais N-17) ; clé sur une ligne (JSON, \\n échappés) signalée comme clé", () => {
    const json = `  "private_key": "${F.pem}\\n${F.corps}\\n-----END RSA PRIVATE KEY-----\\n",`;
    expect(
      secretsDuDiff(diff(".env", ["DEBUG=1", F.pem, "SUITE=1"])).map((x) => [x.line, x.kind, x.preview]),
    ).toEqual([[2, "private_key_header", F.pem]]);
    expect(secretsDuDiff(diff("sa.json", ["{", json, "}"])).map((x) => [x.line, x.kind])).toEqual([
      [2, "private_key"],
    ]);
    expect(JSON.stringify(secretsDuDiff(diff("sa.json", [json])))).not.toContain(F.corps.slice(-12));
    expect(secretsDuDiff(diff("README.md", [`${F.pem} <your key here>`]))).toEqual([]);
  });

  it("pas de faux positif : exemples documentés (clé AWS d'exemple voulue), binaires, lignes retirées", () => {
    const exemples = [
      j("AKIA", "IOSFODNN7", "EXAMPLE"),
      j("gh", "p_", "x".repeat(36)),
      j("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCY", "EXAMPLEKEY"),
      "...",
      j("sk", "_live_", "<your-key-here-0123456789>"),
    ];
    expect(secretsDuDiff(diff("README.md", exemples))).toEqual([]);
    const binaire = [
      "diff --git a/logo.png b/logo.png",
      "new file mode 100644",
      "index 0000000..1111111",
      "Binary files /dev/null and b/logo.png differ",
    ].join("\n");
    expect(secretsDuDiff(binaire)).toEqual([]);
    const retire = [
      "diff --git a/a.py b/a.py",
      "--- a/a.py",
      "+++ b/a.py",
      "@@ -3 +2,0 @@",
      `-k = ${F.github}`,
    ];
    expect(secretsDuDiff(retire.join("\n"))).toEqual([]);
  });

  it("N-17 : AKIA suivi de 16 caractères hors exemples signalé, clé d'exemple ignorée, et la description de git_commit le dit", () => {
    const horsListe = j("AK", "IA", "Z".repeat(16));
    const exemple = j("AKIA", "IOSFODNN7", "EXAMPLE");
    const lignes = [`AWS_KEY=${horsListe}`, `AWS_EXAMPLE=${exemple}`, `aws = "${exemple}"`];
    expect(secretsDuDiff(diff(".env", lignes)).map((x) => [x.line, x.kind, x.preview])).toEqual([
      [1, "aws_access_key_id", "AKIA****(20 chars)"],
    ]);
    const commit = (goldenGit as Golden).outils.find((o) => o["name"] === "git_commit");
    expect(String(commit?.["description"])).toContain(
      `Documentation example values are ignored, e.g. the AWS key \`\`${exemple}\`\``,
    );
  });

  it("une ligne ajoutée commençant par « ++ » n'est pas un en-tête ; chemins entre guillemets décodés", () => {
    const d = [
      "diff --git a/x.txt b/x.txt",
      "--- a/x.txt",
      "+++ b/x.txt",
      "@@ -1 +1,2 @@",
      "+++ b/ailleurs.txt",
      `+k = ${F.gitlab}`,
    ].join("\n");
    expect(secretsDuDiff(d).map((x) => [x.file, x.line])).toEqual([["x.txt", 2]]);
    expect(cheminDiff('+++ "b/r\\303\\251p/f\\"x.txt"')).toBe('rép/f"x.txt');
    expect(cheminDiff("+++ /dev/null")).toBeNull();
    expect(masquer("abcdef")).toBe("****(6 chars)");
  });

  it("lignes géantes du diff indexé analysées en temps linéaire, trouvailles inchangées", () => {
    const env = [
      `API_TOKEN=abcd${" ".repeat(60_000)}x`,
      `API_TOKEN=${"\t".repeat(60_000)}X\r`,
      `DB_PASSWORD=${"<".repeat(60_000)}`,
      "API_TOKEN=\rabcd1234",
    ];
    const cles = [
      `${F.pem}${"<".repeat(60_000)}`,
      `${F.pem}${"\\".repeat(60_000)}x`,
      `${F.pem}\\\\n${F.corps}`,
    ];
    const debut = performance.now();
    const t = [...secretsDuDiff(diff(".env", env)), ...secretsDuDiff(diff("k.txt", cles))];
    expect(performance.now() - debut).toBeLessThan(1000);
    expect(t.map((x) => [x.file, x.line, x.kind])).toEqual([
      [".env", 1, "env_secret"],
      [".env", 3, "env_secret"],
      [".env", 4, "env_secret"],
      ["k.txt", 1, "private_key_header"],
      ["k.txt", 2, "private_key_header"],
      ["k.txt", 3, "private_key"],
    ]);
  });
});
