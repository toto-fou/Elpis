// SPDX-License-Identifier: MIT
/** apps/toolhost/src/natif.ts — `main.mjs --natif` (pour `elpis doctor`) : modules natifs de l'hôte chargés depuis le bundle, un PTY ouvert et une base SQLite en mémoire. */
import { createRequire } from "node:module";

import { chargerNodePty } from "./terminal/pty";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 0 si node-pty ouvre un PTY et better-sqlite3 une base ; sinon 1, avec la raison. */
export async function verifierNatifs(ecrire: (ligne: string) => void): Promise<number> {
  const cible = `${process.platform}-${process.arch}`;
  try {
    const exiger = createRequire(import.meta.url);
    const pty = chargerNodePty();
    const code = await new Promise<number>((fin, echec) => {
      try {
        const p = pty.spawn("/bin/sh", ["-c", "exit 0"], {
          cols: 80,
          rows: 24,
          env: { PATH: "/usr/bin:/bin" },
        });
        p.onExit((e) => fin(e.exitCode));
      } catch (e) {
        echec(e as Error);
      }
    });
    if (code !== 0) throw new Error(`PTY de contrôle sorti en ${code}`);
    const Database = exiger("better-sqlite3") as new (chemin: string) => {
      prepare(sql: string): { get(): unknown };
      close(): void;
    };
    const db = new Database(":memory:");
    const sqlite = (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
    db.close();
    const version = (nom: string): string => (exiger(`${nom}/package.json`) as { version: string }).version;
    ecrire(
      `node-pty ${version("node-pty")}, better-sqlite3 ${version("better-sqlite3")}, SQLite ${sqlite} (${cible}, Node ${process.version})`,
    );
    return 0;
  } catch (e) {
    ecrire(`module natif inutilisable pour ${cible} : ${message(e)}`);
    return 1;
  }
}
