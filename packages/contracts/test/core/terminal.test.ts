// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/terminal.test.ts — WebSocket du terminal : trames de la vraie boucle du toolhost (PTY et socket factices) décodées par le contrat, contrôles du client compris par le serveur. */
import { describe, expect, it } from "vitest";

import { Terminal, Terminaux } from "../../../../apps/toolhost/src/terminal/pty";
import { boucleWs, tamponner } from "../../../../apps/toolhost/src/terminal/ws";
import { journalMuet } from "../../../../apps/toolhost/test/aides";
import { attendre, FausseSocket, FauxPty } from "../../../../apps/toolhost/test/terminal-aides";
import {
  decoderTrameTerminal,
  encoderControleTerminal,
  FERMETURES_TERMINAL,
  schemaTrameTerminalServeur,
} from "../../src";

function demarrer(): { pty: FauxPty; socket: FausseSocket; boucle: Promise<void> } {
  const pty = new FauxPty();
  const term = new Terminal(pty.commeIPty(), 1, "default", "/tmp", "elpis-sb-x");
  const socket = new FausseSocket();
  const ctx = {
    terminaux: new Terminaux({ journal: journalMuet }),
    base: () => Promise.reject(new Error("sans base")),
    journal: journalMuet,
  };
  return { pty, socket, boucle: boucleWs(socket.commeWs(), term, ctx, tamponner(socket.commeWs())) };
}

function textes(socket: FausseSocket): unknown[] {
  return socket.trames
    .filter((t) => !t.binaire)
    .map((t) => {
      const d = decoderTrameTerminal(String(t.donnees));
      expect(d, String(t.donnees)).not.toBeNull();
      return d;
    });
}

describe("contrat du WebSocket du terminal (boucle réelle du toolhost)", () => {
  it("accueil, pong, sortie binaire, redimensionnement, fin du shell puis 1000", async () => {
    const { pty, socket, boucle } = demarrer();
    await attendre(() => socket.trames.length > 0);
    socket.recevoir(encoderControleTerminal({ op: "resize", rows: 40, cols: 120 }));
    socket.recevoir(encoderControleTerminal({ op: "ping" }));
    socket.recevoir(Buffer.from("ls\r"), true);
    pty.emettre(Buffer.from("fichier.txt\r\n"));
    await attendre(() => socket.trames.length >= 3);
    pty.sortir();
    await boucle;
    expect(textes(socket)).toEqual([
      { type: "hello", fresh_shell: true },
      { type: "pong" },
      { type: "exit" },
    ]);
    expect(socket.trames.filter((t) => t.binaire).map((t) => String(t.donnees))).toEqual(["fichier.txt\r\n"]);
    expect(pty.tailles).toEqual([[40, 120]]);
    expect(Buffer.concat(pty.ecrits).toString()).toBe("ls\r");
    expect(socket.ferme).toBe(FERMETURES_TERMINAL.normale);
  });

  it("trames du serveur : `session_expired` du relais, types inconnus et formes invalides refusés", () => {
    expect(schemaTrameTerminalServeur.parse(JSON.parse('{"type": "session_expired"}'))).toEqual({
      type: "session_expired",
    });
    expect(decoderTrameTerminal('{"type": "hello"}')).toBeNull();
    expect(decoderTrameTerminal('{"type": "autre"}')).toBeNull();
    expect(decoderTrameTerminal("pas du json")).toBeNull();
  });

  it("contrôles du client : bornes de taille et de forme", () => {
    expect(() => encoderControleTerminal({ op: "resize", rows: 0, cols: 80 })).toThrow();
    expect(encoderControleTerminal({ op: "resize", rows: 24, cols: 80 })).toBe(
      '{"op":"resize","rows":24,"cols":80}',
    );
  });
});
