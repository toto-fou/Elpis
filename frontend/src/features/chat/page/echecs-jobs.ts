// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/page/echecs-jobs.ts — échec d'une tâche de fond de la conversation signalé par un toast « Aller au message » (interface nouvelle), sans rien afficher au-dessus du composeur. */
import { watch } from "vue";

import type { ResumeJob } from "@elpis/contracts";

import { issueJob } from "../jobs/format";
import type { IssueJob } from "../jobs/format";
import { allerALEtape, appelDuJob } from "./activite";
import type { DomaineConversation, DomainePage } from "./types";

type PageJobs = Pick<DomainePage, "currentChatId" | "jobsChat" | "messages" | "showToast" | "jobsBasculer">;

const nomJob = (j: ResumeJob): string => j.label || j.command;
const sortie = (j: ResumeJob): string => (j.signal ? j.signal : `code ${j.exit_code ?? "?"}`);

/** Toast au passage d'un job d'« actif » à « échec » ; rien quand `actif()` est faux (interface classique). */
export function utiliserEchecsJobs(
  p: PageJobs,
  conv: Pick<DomaineConversation, "isUserScrolling">,
  actif: () => boolean,
): void {
  // Étape absente du fil chargé : le volet des tâches de fond montre la tâche et son journal.
  function allerAuJob(j: ResumeJob): void {
    conv.isUserScrolling = true;
    if (!allerALEtape(appelDuJob(p.messages, j.id))) p.jobsBasculer(true);
  }

  const vus = new Map<string, IssueJob>();
  let chatSuivi: string | null | undefined;
  watch(
    () => [p.currentChatId, p.jobsChat] as const,
    ([chat, jobs]) => {
      if (chat !== chatSuivi) {
        chatSuivi = chat;
        vus.clear();
      }
      for (const j of jobs) {
        const avant = vus.get(j.id);
        const issue = issueJob(j);
        vus.set(j.id, issue);
        if (avant !== "actif" || issue !== "echec" || !actif()) continue;
        p.showToast(`« ${nomJob(j)} » s'est arrêté : ${sortie(j)}`, "error", {
          duration: 10000,
          actionLabel: "Aller au message",
          onAction: () => allerAuJob(j),
        });
      }
    },
    { immediate: true },
  );
}
