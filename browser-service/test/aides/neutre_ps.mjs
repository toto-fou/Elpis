// SPDX-License-Identifier: MIT
// test/aides/neutre_ps.mjs — préchargé (--import) par tout service lancé par les essais : `ps` rend une liste vide, le service ne tue donc aucun processus orphelin de la machine.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const reel = cp.execSync;
cp.execSync = (cmd, ...reste) => (/^\s*ps\b/.test(String(cmd)) ? '' : reel(cmd, ...reste));
syncBuiltinESMExports();
