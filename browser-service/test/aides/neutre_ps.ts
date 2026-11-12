// SPDX-License-Identifier: MIT
// test/aides/neutre_ps.ts — préchargé (--import) par tout service lancé par les essais : `ps` rend une liste vide, le service ne tue donc aucun processus orphelin de la machine.
import cp from 'node:child_process';
import type { ExecSyncOptions } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const reel = cp.execSync;
// Posé par Object.assign : '' rendu pour `ps` quel que soit l'encodage demandé, ce que les surcharges de execSync ne décrivent pas.
Object.assign(cp, { execSync: (cmd: string, ...reste: [options?: ExecSyncOptions]) => (/^\s*ps\b/.test(String(cmd)) ? '' : reel(cmd, ...reste)) });
syncBuiltinESMExports();
