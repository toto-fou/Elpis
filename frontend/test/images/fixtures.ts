// SPDX-License-Identifier: MIT
/** frontend/test/images/fixtures.ts — statut du moteur d'images commun aux tests. */
import type { StatutImages } from "../../src/features/images/formats";

export const STATUT: StatutImages = {
  ready: true,
  available: true,
  ratios: ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"],
  sides: [512, 768, 1024, 1536, 2048],
  default_side: 1024,
  max_side: 1536,
  step: 64,
  max_n: 3,
  size_policy: "free",
  sizes: [],
  features: { seed: true, negative: true, steps: true, strength: true },
  prefs: { ratio: "16:9", side: 1024, n: 2, enhance: true },
  enhance_enabled: true,
};
