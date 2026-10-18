// SPDX-License-Identifier: MIT
/** apps/toolhost/src/fichiers/metrique.ts — `log_metric` des écritures de l'éditeur dans la base de l'hôte (shared_infra/db/_connection.py) : best-effort, jamais levé. */
import { intPy, pyJsonDumps, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";

import { baseHote } from "../base-hote";
import type { Journal } from "../journal";

/** Une ligne `metric_events`, compte d'après `tags.user` (sans le cache de noms du Python) ; hôte sans base : rien ; erreur journalisée. */
export async function metriqueHote(
  journal: Journal,
  eventType: string,
  value: number,
  tags: Dict,
): Promise<void> {
  const base = baseHote();
  if (base === null) return;
  try {
    const nom = tags["user"];
    const ligne =
      typeof nom === "string" && nom
        ? await base.get<{ id: unknown }>("SELECT id FROM users WHERE username=?", [nom])
        : undefined;
    await base.run(
      "INSERT INTO metric_events(event_type, value, tags_json, created_at, user_id) VALUES(?,?,?,?,?)",
      [
        eventType,
        value,
        pyJsonDumps(veritePy(tags) ? tags : {}),
        Date.now() / 1000,
        ligne ? intPy(ligne.id) : null,
      ],
    );
  } catch (e) {
    journal.error(`Metric Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
