// SPDX-License-Identifier: MIT
/** frontend/src/platform/zod-sans-eval.ts — Zod sans évaluation de code (CSP sans 'unsafe-eval') ; importé en premier par les entrées, avant la construction de tout schéma. */
import { z } from "zod";

z.config({ jitless: true });
