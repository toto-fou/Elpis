// SPDX-License-Identifier: MIT
/** apps/toolhost/test/anglais-shell-git.test.ts — textes rendus au modèle par shell et git en anglais (harnais B-13) : pannes du bac, refus de l'agent et du relais traduits à la frontière, aucun littéral français dans les sources. */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { erreurAgent } from "@elpis/bac";
import { AgentError, RelayRefused } from "@elpis/fichiers";
import { describe, expect, it } from "vitest";

import { agentEnAnglais, enAnglais, strErreurAnglais } from "../src/mcp/anglais";
import { tronquer } from "../src/mcp/git/commun";

describe("textes du bac, de l'agent et du relais en anglais (harnais B-13)", () => {
  it("messages connus du bac et du relais traduits, le reste inchangé", () => {
    for (const [fr, en] of [
      ["Container elpis-sb-a n'a pas pu démarrer", "container elpis-sb-a could not start"],
      ["docker run a échoué : boom", "docker run failed: boom"],
      ["Agent non démarré dans elpis-sb-a : sortie", "sandbox agent not started in elpis-sb-a: sortie"],
      ["Container a crashé au démarrage (état=exited).", "container crashed at startup (state=exited)."],
      ["Remote « origin » introuvable", "remote 'origin' not found"],
      [
        "Dépôt refusé (anti-SSRF) : blocked_ip (127.0.0.1)",
        "repository refused (SSRF protection): blocked_ip (127.0.0.1)",
      ],
      [
        "URL de dépôt invalide (identifiants, requête ou hôte)",
        "invalid repository URL (credentials, query or host)",
      ],
      [
        "fatal: x\nRelais Git : push vers refs/heads/main hors de l'opération autorisée",
        "fatal: x\nGit relay: push to refs/heads/main is outside the authorized operation",
      ],
      [
        "Relais Git : l'amont redirige (301 vers forge/x) ; corrigez l'URL du remote",
        "Git relay: the upstream redirects (301 to forge/x); fix the remote URL",
      ],
      [
        "Relais Git : l'amont redirige (302) ; corrigez l'URL du remote",
        "Git relay: the upstream redirects (302); fix the remote URL",
      ],
      ["fatal: repository not found", "fatal: repository not found"],
    ] as const)
      expect(enAnglais(fr)).toBe(en);
  });

  it("refus de l'agent : texte du code, strerror du système gardé, message français écarté", () => {
    expect(agentEnAnglais("not_found", "dossier de travail absent")).toBe("not found");
    expect(agentEnAnglais("outside_root", "un lien sort de /work")).toBe("a link leads outside /work");
    expect(agentEnAnglais("io_error", "No space left on device")).toBe("No space left on device");
    expect(agentEnAnglais("bad_request", "JSON invalide")).toBe("invalid request to the sandbox agent");
    expect(agentEnAnglais("inconnu", "boum")).toBe("");
    expect(strErreurAnglais(new AgentError("denied", "accès refusé"))).toBe("denied: permission denied");
    expect(strErreurAnglais(erreurAgent("agent_unavailable", "client de l'agent non installé"))).toBe(
      "agent_unavailable: sandbox agent unavailable",
    );
    expect(strErreurAnglais(new RelayRefused("no_remote", "Remote « up » introuvable"))).toBe(
      "no_remote: remote 'up' not found",
    );
    expect(strErreurAnglais(new Error("Container elpis-sb-b n'a pas pu démarrer"))).toBe(
      "container elpis-sb-b could not start",
    );
  });

  it("coupe des sorties git en anglais", () => {
    expect(tronquer("abcdef", 2)).toEqual(["ab\n...[truncated: 4 of 6 characters omitted]", true]);
  });

  it("aucun littéral français dans les sources des familles shell et git (commentaires et journaux exceptés)", () => {
    const racine = path.join(import.meta.dirname, "../src/mcp");
    const fautifs: string[] = [];
    for (const dossier of ["shell", "git"])
      for (const nom of readdirSync(path.join(racine, dossier)).filter((n) => n.endsWith(".ts")))
        readFileSync(path.join(racine, dossier, nom), "utf-8")
          .split("\n")
          .forEach((l, i) => {
            const t = l.trim();
            if (/^(?:\/\/|\/\*\*|\*)/u.test(t) || /journalDe\(|\.(?:warn|info)\(/u.test(t)) return;
            if (/[àâçéèêëîïôûùü]/iu.test(t.replace(/\/\/.*$/u, "")))
              fautifs.push(`${dossier}/${nom}:${i + 1}`);
          });
    expect(fautifs).toEqual([]);
  });
});
