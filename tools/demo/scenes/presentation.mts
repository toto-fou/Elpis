// SPDX-License-Identifier: MIT
// tools/demo/scenes/presentation.mts — présentation du README : graphique et mémoire dans le chat, puis correctif écrit en direct dans l'éditeur de la sandbox et tests lancés.
import type { Page } from "playwright-core";

import type { Conversation } from "../instance.mts";
import type { Scenario } from "../moteur.mts";
import { cliquer, defiler, deplacer, glisser, pause, taper, tirer } from "../curseur.mts";
import {
  CORRECTIF_INIT,
  CORRECTIF_RECHERCHE,
  INDEX_JEUDI_APRES_RECHERCHE,
  INDEX_JEUDI_AVANT,
} from "./projet.mts";

export { semer } from "./projet.mts";

// Accueil avec le logo de l'application plutôt que la mascotte animée (réglage d'administration).
export const config = { welcome: { scene: { mascottes_on: false } } };

/** Historique de la barre latérale : une équipe qui travaille déjà avec Elpis. */
export const conversations: Conversation[] = [
  {
    titre: "Postgres connection pool sizing",
    ilYaH: 2,
    question: "How big should the connection pool be for 4 API replicas on a 16-core Postgres?",
    reponse:
      "Start around 20 connections per replica and watch wait time; past ~2x the core count, Postgres gets slower, not faster.",
  },
  {
    titre: "Review: rate limiter middleware",
    ilYaH: 5,
    question: "Review the token bucket in middleware/ratelimit.ts.",
    reponse:
      "Two issues: the refill uses wall-clock time (use a monotonic clock) and the bucket map never evicts idle clients.",
  },
  {
    titre: "Flaky test in payments suite",
    ilYaH: 27,
    question: "test_refund_webhook fails about one run in ten on CI. Why?",
    reponse:
      "It asserts on a timestamp rounded to the second; when the webhook lands across a second boundary the comparison fails.",
  },
  {
    titre: "Release notes for v2.3",
    ilYaH: 30,
    question: "Draft the release notes for v2.3 from the merged PRs.",
    reponse:
      "Highlights: streaming exports, SSO group mapping, 30% faster cold start. Breaking: the v1 export endpoint is removed.",
  },
  {
    titre: "Shrink the API Docker image",
    ilYaH: 52,
    question: "Our API image is 1.4 GB. How do we shrink it?",
    reponse:
      "Multi-stage build, a slim runtime base and no dev dependencies in the final stage: about 210 MB.",
  },
  {
    titre: "On-call summary, week 42",
    ilYaH: 76,
    question: "Summarize last week's pages from the on-call log.",
    reponse: "Seven pages, five from the queue backlog alert, two disk-space warnings on the build runners.",
  },
  {
    titre: "Migrate cron jobs to routines",
    ilYaH: 98,
    question: "Which of our cron jobs can move to Elpis routines?",
    reponse:
      "The nightly report, the cache warmup and the stale-branch cleanup; the backup job should stay on the host.",
  },
  {
    titre: "Grafana alert for queue backlog",
    ilYaH: 260,
    question: "Write a Grafana alert for the job queue backlog.",
    reponse:
      "Alert when the oldest message is older than 5 minutes for 10 minutes, rather than on the queue length.",
  },
];

const PROMPT_1 =
  "Here is this week's p95 latency of our search API, in ms: Mon 182, Tue 176, Wed 190, Thu 412, " +
  "Fri 398, Sat 405, Sun 401. Chart it and tell me what happened.";
const PROMPT_2 = "Find what changed in search-service on Thursday and fix it, then run the tests.";
const INDEX = "search-service/search_service/index.py";

export const scenario: Scenario = {
  titre: "Search latency regression",
  tours: [
    {
      prompt: "Chart it and tell me what happened.",
      etapes: [
        {
          reflexion:
            "Seven daily p95 values: Mon to Wed around 180-190 ms, then above 395 ms from Thursday on. " +
            "A line chart with the baseline drawn makes the step obvious.",
          outil: {
            nom: "chart_line",
            args: {
              title: "Search API p95 latency, this week",
              x: "day",
              y: ["p95"],
              unit: "ms",
              lines: [{ value: 183, label: "Baseline" }],
              data: [
                { day: "Mon", p95: 182 },
                { day: "Tue", p95: 176 },
                { day: "Wed", p95: 190 },
                { day: "Thu", p95: 412 },
                { day: "Fri", p95: 398 },
                { day: "Sat", p95: 405 },
                { day: "Sun", p95: 401 },
              ],
            },
          },
        },
        {
          reflexion: "Worth remembering the baseline for later comparisons.",
          outil: {
            nom: "memory",
            args: {
              action: "add",
              store: "memory",
              content: "Search API p95 baseline is ~183 ms (Mon-Wed); a regression started on Thursday.",
              title: "Remembering the search API latency baseline",
            },
          },
        },
        {
          reflexion: "Quantify the jump and say what it points to.",
          texte:
            "p95 latency of the search API **more than doubled on Thursday** and has stayed there since.\n\n" +
            "| Period | p95 | vs. baseline |\n|---|---:|---:|\n| Mon-Wed | ~183 ms | |\n| Thu-Sun | ~404 ms | +121 % |\n\n" +
            "**What likely happened:** a step that starts on one day and never recovers points to something " +
            "shipped on Thursday, not to load, which would grow gradually.\n\n" +
            // Graphique en dernier : l'app ne remplace la référence par le dessin qu'en fin de message.
            "Here is the week against the 183 ms baseline:\n\n{{chart}}",
        },
      ],
    },
    {
      prompt: PROMPT_2,
      etapes: [
        {
          reflexion: "The regression starts on Thursday. Check the commit history of search-service.",
          outil: { nom: "git_query", args: { repo: "search-service", action: "log", max_count: 5 } },
        },
        {
          reflexion:
            "Jordan's commit on Thursday, 'Pick up documents added after startup', is the only change that day.",
          outil: { nom: "git_query", args: { repo: "search-service", action: "show", target: "HEAD" } },
        },
        {
          reflexion:
            "Found it: search() now calls self._build() on every query, so each search re-indexes every document. " +
            "Build the index once, and keep it up to date in add().",
          outil: {
            nom: "edit_file",
            args: { path: INDEX, action: "str_replace", old_str: INDEX_JEUDI_AVANT, new_str: CORRECTIF_INIT },
          },
        },
        {
          reflexion: "Now search() can read the cached postings.",
          outil: {
            nom: "edit_file",
            args: {
              path: INDEX,
              action: "str_replace",
              old_str: INDEX_JEUDI_APRES_RECHERCHE,
              new_str: CORRECTIF_RECHERCHE,
            },
          },
        },
        {
          reflexion: "Run the test suite.",
          outil: {
            nom: "execute_shell",
            args: { command: "cd search-service && python3 -m pytest -q", timeout_sec: 60 },
          },
        },
        {
          reflexion: "Tests pass. Summarize the cause and the fix.",
          texte:
            "Fixed. Thursday's commit *Pick up documents added after startup* made `search()` call `_build()` on every " +
            "query, so each search re-indexed every document: that is the jump on the chart.\n\n" +
            "- `__init__` builds the index once again.\n" +
            "- `add()` updates the postings, so new documents are still found.\n" +
            "- `search()` reads the cached postings.\n\n" +
            "Tests: **3 passed**, including `test_search_stays_fast`.",
        },
      ],
    },
  ],
};

/** Fin de génération : le composeur repasse de « Préparez… » à « Envoyer… ». */
async function generationFinie(page: Page): Promise<void> {
  const debut = (p: string) =>
    page.waitForFunction((d) => document.querySelector("textarea")?.placeholder.startsWith(d), p, {
      timeout: 90_000,
    });
  await debut("Préparez");
  await debut("Envoyer");
}

/** Joue la présentation sur une page ouverte sur l'accueil. */
export async function jouer(page: Page): Promise<void> {
  // « Nouveau chat » applique les outils cochés par défaut (fichiers, shell, Git, graphiques, mémoire).
  await cliquer(page, page.getByRole("button", { name: /Nouveau chat/ }).first());
  await pause(page, 300);
  await cliquer(page, page.locator("textarea").first());
  await taper(page, PROMPT_1);
  await pause(page, 400);
  await page.keyboard.press("Enter");
  await deplacer(page, 1300, 560);
  await page.locator(".chart-render, .chart-render-error").first().waitFor({ timeout: 60_000 });
  if (await page.locator(".chart-render-error").count()) throw new Error("graphique en erreur");
  await pause(page, 700);
  const carte = page.locator(".chart-render").first();
  const avant = (await carte.boundingBox())!;
  // Le graphique arrive sous la zone visible : on le remonte au-dessus du composeur (~150 px en bas).
  const ecart = avant.y + avant.height - 900 + 150;
  if (ecart > 0) await defiler(page, ecart, 800);
  await pause(page, 300);
  // Balayage de la courbe jusqu'au pic de jeudi (4e des 7 points, entre 8 % et 91 % de la largeur de la carte).
  const b = (await carte.boundingBox())!;
  await deplacer(page, b.x + b.width * 0.08, b.y + b.height * 0.45);
  await glisser(page, b.x + b.width * 0.494, b.y + b.height * 0.45, 1300);
  await pause(page, 1200);

  await cliquer(page, page.locator("button[title^='Sandbox']:visible").first());
  await deplacer(page, 420, 300);
  await page.getByText("search-service", { exact: true }).first().waitFor({ timeout: 30_000 });
  await pause(page, 400);
  await cliquer(page, page.locator("button[title='Réduire le panneau']:visible").first());
  await pause(page, 300);
  await tirer(page, page.locator("[title='Redimensionner']:visible").first(), 600);
  for (const n of ["search-service", "search_service", "index.py"])
    await cliquer(page, page.getByText(n, { exact: true }).first());
  await pause(page, 700);
  await cliquer(page, page.locator("textarea").first());
  await taper(page, PROMPT_2);
  await pause(page, 300);
  await page.keyboard.press("Enter");
  await deplacer(page, 1250, 760);
  await generationFinie(page);
  await pause(page, 3000);
}
