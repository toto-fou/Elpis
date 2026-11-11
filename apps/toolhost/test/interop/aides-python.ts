// SPDX-License-Identifier: MIT
/** apps/toolhost/test/interop/aides-python.ts — essais croisés : interpréteur Python (agent du bac, `ELPIS_INTEROP_PYTHON`) et ports libres. */
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

/** Interpréteur des essais croisés (`ELPIS_INTEROP_PYTHON`) ; vide : essais sautés. */
export const PYTHON = process.env["ELPIS_INTEROP_PYTHON"] ?? "";

export function portLibre(): Promise<number> {
  return new Promise((fin) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => fin(p));
    });
  });
}
