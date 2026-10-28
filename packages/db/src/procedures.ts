// SPDX-License-Identifier: MIT
/** packages/db/src/procedures.ts — purge des procédures du navigateur (`ax_procedures`, `ax_procedure_runs`, `ax_procedure_counters`) d'un compte supprimé. */
import type { Executeur } from "./base";

/** Retire procédures et exécutions du compte (rangées par nom de compte) ; nombre de procédures retirées. */
export async function retirerProceduresDuCompte(x: Executeur, proprietaire: string): Promise<number> {
  if (!proprietaire) return 0;
  await x.run("DELETE FROM ax_procedure_runs WHERE owner = ?", [proprietaire]);
  await x.run("DELETE FROM ax_procedure_counters WHERE owner = ?", [proprietaire]);
  await x.run("DELETE FROM ax_procedure_approvals WHERE owner = ?", [proprietaire]);
  return (await x.run("DELETE FROM ax_procedures WHERE owner = ?", [proprietaire])).changes;
}
