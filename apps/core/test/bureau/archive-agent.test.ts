// SPDX-License-Identifier: MIT
/** apps/core/test/bureau/archive-agent.test.ts — archive publique de l'agent de bureau (`/api/desktop/agent-bundle`) : sources servies, jeton `agent_token.txt` et `.env` d'un agent déjà lancé jamais inclus. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { archiveAgent } from "@elpis/bureau";
import { finArchive } from "@elpis/commun";
import { afterAll, describe, expect, it } from "vitest";

const racine = mkdtempSync(path.join(tmpdir(), "elpis-archive-agent-"));

afterAll(() => {
  rmSync(racine, { recursive: true, force: true });
});

/** Noms du répertoire central de l'archive. */
function noms(zip: Buffer): string[] {
  const fin = finArchive(zip);
  if (fin === null) throw new Error("archive illisible");
  const sortie: string[] = [];
  for (let i = fin.decalage; i < fin.decalage + fin.taille;) {
    expect(zip.readUInt32LE(i)).toBe(0x02014b50);
    const n = zip.readUInt16LE(i + 28);
    sortie.push(zip.subarray(i + 46, i + 46 + n).toString("utf8"));
    i += 46 + n + zip.readUInt16LE(i + 30) + zip.readUInt16LE(i + 32);
  }
  return sortie.sort();
}

describe("archive de l'agent de bureau", () => {
  it("sources zippées ; agent_token.txt et .env (à la racine comme plus bas), caches et .pyc exclus", async () => {
    const agent = path.join(racine, "desktop-agent");
    mkdirSync(path.join(agent, "elpis_auto"), { recursive: true });
    mkdirSync(path.join(agent, "__pycache__"), { recursive: true });
    writeFileSync(path.join(agent, "server.py"), "print('agent')\n");
    writeFileSync(path.join(agent, "run.ps1"), "Write-Host agent\n");
    writeFileSync(path.join(agent, "agent_token.txt"), "jeton-secret-de-la-machine\n");
    writeFileSync(path.join(agent, ".env"), "DESKTOP_AGENT_TOKEN=jeton-secret-de-la-machine\n");
    writeFileSync(path.join(agent, "elpis_auto", "__init__.py"), "");
    writeFileSync(path.join(agent, "elpis_auto", "agent_token.txt"), "autre-jeton\n");
    writeFileSync(path.join(agent, "__pycache__", "server.cpython-313.pyc"), "x");
    writeFileSync(path.join(agent, "vieux.pyc"), "x");
    const zip = await archiveAgent(racine);
    expect(zip).not.toBeNull();
    expect(noms(zip as Buffer)).toEqual([
      "desktop-agent/elpis_auto/__init__.py",
      "desktop-agent/run.ps1",
      "desktop-agent/server.py",
    ]);
    expect((zip as Buffer).includes(Buffer.from("agent_token"))).toBe(false);
  });
});
