// SPDX-License-Identifier: MIT
/** packages/outils-mcp/src/modeles.ts — formes des résultats d'outils (llm_core/tools/_models.py) ; les schémas de sortie publiés viennent des goldens. */
import { estDict } from "@elpis/commun";
import type { Dict } from "@elpis/commun";

type Opt<T> = T | null | undefined;

/** `_SuccessBase` : `ok` vrai, champs supplémentaires permis. */
export interface SuccessBase {
  ok: true;
  [extra: string]: unknown;
}

/** `ErrEnvelope` : forme de `err()`, contexte supplémentaire permis. */
export interface ErrEnvelope {
  ok: false;
  error: string;
  message?: Opt<string>;
  fix?: Opt<string>;
  next_action?: Opt<string>;
  retryable?: Opt<boolean>;
  [extra: string]: unknown;
}

/** Enveloppe d'échec `{ok: false}` (dict dont `ok` est exactement `False`). */
export function estEnveloppeErreur(v: unknown): v is ErrEnvelope {
  return estDict(v) && v["ok"] === false;
}

export interface ReadFileSingle extends SuccessBase {
  path: string;
  rel_path?: Opt<string>;
  content?: Opt<string>;
  encoding?: Opt<string>;
  mime?: Opt<string>;
  size?: Opt<number>;
  type?: Opt<string>;
  sha256?: Opt<string>;
  total_lines?: Opt<number>;
  format?: Opt<string>;
  truncated?: Opt<boolean>;
  base64?: Opt<string>;
  next_expected_sha256?: Opt<string>;
}

export interface ReadFileBatch extends SuccessBase {
  action: "batch_read";
  count: number;
  succeeded: number;
  failed: number;
  files: Record<string, Dict>;
}

export type ReadFileResult = ReadFileBatch | ReadFileSingle;

export interface WriteFileResult extends SuccessBase {
  path: string;
  action: string;
  bytes?: Opt<number>;
  old_sha256?: Opt<string>;
  new_sha256?: Opt<string>;
  next_expected_sha256?: Opt<string>;
  lines_added?: Opt<number>;
  lines_removed?: Opt<number>;
  unchanged?: Opt<boolean>;
  note?: Opt<string>;
  dry_run?: Opt<boolean>;
  bytes_before?: Opt<number>;
  bytes_after?: Opt<number>;
  would_create?: Opt<boolean>;
}

export interface EditFileResult extends SuccessBase {
  path: string;
  action: string;
  dry_run: boolean;
  diff?: Opt<string>;
  old_sha256?: Opt<string>;
  new_sha256?: Opt<string>;
  next_expected_sha256?: Opt<string>;
  bytes_before?: Opt<number>;
  bytes_after?: Opt<number>;
  lines_before?: Opt<number>;
  lines_after?: Opt<number>;
  lines_added?: Opt<number>;
  lines_removed?: Opt<number>;
  applied?: Opt<Dict[]>;
  formatter?: Opt<string>;
  unchanged?: Opt<boolean>;
  note?: Opt<string>;
}

export interface FileEntry {
  name: string;
  path: string;
  type: string;
  size?: Opt<number>;
  mtime?: Opt<number>;
  mode?: Opt<string>;
  rel?: Opt<string>;
  [extra: string]: unknown;
}

export interface ListFilesResult extends SuccessBase {
  path: string;
  items: unknown[];
  count: number;
  truncated?: Opt<boolean>;
}

export interface ManageFilesResult extends SuccessBase {
  action: string;
  path?: Opt<string>;
  src?: Opt<string>;
  dest?: Opt<string>;
  mode?: Opt<string>;
  deleted?: Opt<string[]>;
  count?: Opt<number>;
  dry_run?: Opt<boolean>;
  plan?: Opt<Dict[]>;
  created?: Opt<boolean>;
  would_create?: Opt<boolean>;
}

export interface StatPathResult extends SuccessBase {
  path?: Opt<string>;
  paths?: Opt<string[]>;
  files?: Opt<Dict>;
  exists?: Opt<boolean>;
  type?: Opt<string>;
  size?: Opt<number>;
  mtime?: Opt<number>;
  mode?: Opt<string>;
  sha256?: Opt<string>;
}

export interface CodeOutlineEntry {
  kind: string;
  name: string;
  line: number;
  [extra: string]: unknown;
}

export interface CodeOutlineResult extends SuccessBase {
  path?: Opt<string>;
  outline?: Opt<CodeOutlineEntry[]>;
  files?: Opt<Dict>;
  language?: Opt<string>;
}

export interface CodeNavigateResult extends SuccessBase {
  matches: Dict[];
  count: number;
  truncated?: Opt<boolean>;
}

/** `ok` reflète le code de sortie (`returncode == 0`), pas une enveloppe d'erreur. */
export interface ExecuteShellResult {
  ok: boolean;
  cmd: string;
  cwd: string;
  returncode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  duration_ms: number;
  executor: string;
  saved_to?: Opt<string>;
  saved_bytes?: Opt<number>;
  [extra: string]: unknown;
}

export interface BackgroundShellResult extends SuccessBase {
  background: boolean;
  pid: number;
  cmd: string;
  log: string;
  hint: string;
}

/** `shell_job` : job de fond tel que rendu par `status` et `list`. */
export interface ShellJobEntry {
  job_id: string;
  label: string;
  state: string;
  pid?: Opt<number>;
  runtime_s?: Opt<number>;
  exit_code?: Opt<number>;
  signal?: Opt<string>;
  wake_on: string[];
  fired?: Opt<string[]>;
  last_line?: Opt<string>;
  log: string;
  [extra: string]: unknown;
}

/** `shell_job(action="start")` : job lancé, à attendre sans sonder. */
export interface ShellJobStartResult extends SuccessBase {
  job_id: string;
  pid: number;
  state: string;
  log: string;
  wake_on: string[];
  active_jobs: number;
  max_jobs: number;
  hint: string;
}

/** `shell_job(action="status" | "list")`. */
export interface ShellJobStatusResult extends SuccessBase {
  jobs: ShellJobEntry[];
  active_jobs: number;
  max_jobs: number;
}

/** `shell_job(action="logs")` : fin du journal ou lignes trouvées, 4 Ko au plus. */
export interface ShellJobLogsResult extends SuccessBase {
  job_id: string;
  log: string;
  total_lines?: Opt<number>;
  bytes?: Opt<number>;
  lines: string[];
  truncated: boolean;
}

/** `shell_job(action="kill")` : groupe arrêté, pids tués. */
export interface ShellJobKillResult extends SuccessBase {
  job_id: string;
  killed_pids: number[];
  state: string;
  exit_code?: Opt<number>;
  signal?: Opt<string>;
}

export interface GitQueryResult extends SuccessBase {
  action?: Opt<string>;
  repo?: Opt<string>;
  count?: Opt<number>;
  truncated?: Opt<boolean>;
}

export interface GitWriteResult extends SuccessBase {
  action?: Opt<string>;
  path?: Opt<string>;
  repo?: Opt<string>;
  bytes?: Opt<number>;
  sha256?: Opt<string>;
  dry_run?: Opt<boolean>;
}

export interface GitActionResult extends SuccessBase {
  action?: Opt<string>;
  repo?: Opt<string>;
  branch?: Opt<string>;
  dry_run?: Opt<boolean>;
}

export interface GitRfResult extends SuccessBase {
  count?: Opt<number>;
  libraries_found?: Opt<number>;
  import_summary?: Opt<Dict[]>;
  catalog_text?: Opt<string>;
  found?: Opt<boolean>;
  query?: Opt<string>;
  matches?: Opt<Dict[]>;
  settings_block?: Opt<string>;
  resolved?: Opt<Dict[]>;
  unresolved?: Opt<string[]>;
}

export interface GitInspectResult extends SuccessBase {
  action?: Opt<string>;
  repo?: Opt<string>;
}

export interface GitStartWorkResult extends SuccessBase {
  repo?: Opt<string>;
  branch?: Opt<string>;
  base_branch?: Opt<string>;
  cloned?: Opt<boolean>;
  pulled?: Opt<boolean>;
}

export interface GitCommitResult extends SuccessBase {
  repo?: Opt<string>;
  sha?: Opt<string>;
  message?: Opt<string>;
  files?: Opt<string[]>;
  dry_run?: Opt<boolean>;
}

export interface GitSubmitResult extends SuccessBase {
  repo?: Opt<string>;
  branch?: Opt<string>;
  pushed?: Opt<boolean>;
  pr_url?: Opt<string>;
  pr_number?: Opt<number>;
}

export interface GitAbandonResult extends SuccessBase {
  repo?: Opt<string>;
  branch?: Opt<string>;
  deleted?: Opt<boolean>;
}

export interface GitCloneResult extends SuccessBase {
  repo?: Opt<string>;
  url?: Opt<string>;
  branch?: Opt<string>;
}

export interface ChartResult extends SuccessBase {
  ref: string;
  chart_id: string;
  chart_type: string;
  summary?: Opt<string>;
  fixes?: Opt<string[]>;
  warnings?: Opt<string[]>;
}

export interface OfficeResult extends SuccessBase {
  path?: Opt<string>;
  summary?: Opt<string>;
  old_sha256?: Opt<string>;
  new_sha256?: Opt<string>;
  fixes?: Opt<string[]>;
  warnings?: Opt<string[]>;
}

export interface PWSessionResult extends SuccessBase {
  action?: Opt<string>;
  session_id?: Opt<string>;
  sessions?: Opt<Dict[]>;
  url?: Opt<string>;
}

export interface PWFindResult extends SuccessBase {
  session_id?: Opt<string>;
  found?: Opt<boolean>;
  count?: Opt<number>;
  total?: Opt<number>;
  matches?: Opt<Dict[]>;
  ref_ttl_s?: Opt<number>;
  ref_reusable?: Opt<boolean>;
  usage_hint?: Opt<string>;
  node?: Opt<Dict>;
  nodes?: Opt<Dict[]>;
}

export interface PWActResult extends SuccessBase {
  session_id?: Opt<string>;
  action?: Opt<string>;
  target?: Opt<string>;
  status?: Opt<string>;
  strategy?: Opt<string>;
  resolved_selector?: Opt<string>;
  attempts?: Opt<Dict[]>;
  url?: Opt<string>;
  selected?: Opt<Dict>;
  expanded?: Opt<boolean>;
  page_after?: Opt<Dict>;
  screenshot_url?: Opt<string>;
  step?: Opt<number>;
}

/** `status` : code HTTP (entier) ou issue du service (« success », « found »). */
export interface PWPageResult extends SuccessBase {
  session_id?: Opt<string>;
  action?: Opt<string>;
  url?: Opt<string>;
  title?: Opt<string>;
  status?: Opt<number | string>;
  screenshot?: Opt<string>;
  screenshot_url?: Opt<string>;
  screenshot_step?: Opt<number>;
}

export interface PWExpectResult extends SuccessBase {
  session_id?: Opt<string>;
  expectation?: Opt<string>;
  passed?: Opt<boolean>;
}

/** Délai expiré sans la condition : `ok` faux et `timed_out`, issue normale. */
export interface PWWaitResult {
  ok: boolean;
  session_id?: Opt<string>;
  mode?: Opt<string>;
  condition?: Opt<string>;
  status?: Opt<string>;
  selector?: Opt<string>;
  via?: Opt<string>;
  polled_value?: unknown;
  elapsed_ms?: Opt<number>;
  timed_out?: Opt<boolean>;
  [extra: string]: unknown;
}

/** Une étape en échec : `ok` faux avec les résultats par étape, issue normale. */
export interface PWChainResult {
  ok: boolean;
  session_id?: Opt<string>;
  total?: Opt<number>;
  executed?: Opt<number>;
  failed?: Opt<number>;
  results?: Opt<Dict[]>;
  page_after?: Opt<Dict>;
  steps?: Opt<Dict[]>;
  completed?: Opt<number>;
  failed_at?: Opt<number>;
  [extra: string]: unknown;
}

export interface PWMockResult extends SuccessBase {
  session_id?: Opt<string>;
  action?: Opt<string>;
  mock_id?: Opt<string>;
  active_mocks?: Opt<number>;
}

export interface PWRecorderResult extends SuccessBase {
  session_id?: Opt<string>;
  action?: Opt<string>;
  recording?: Opt<boolean>;
  steps_captured?: Opt<number>;
}

export interface PWObserveResult extends SuccessBase {
  session_id?: Opt<string>;
  mode?: Opt<string>;
  url?: Opt<string>;
  items?: Opt<Dict[]>;
  count?: Opt<number>;
  screenshot_url?: Opt<string>;
}

export interface PWMemoryResult extends SuccessBase {
  op?: Opt<string>;
  site?: Opt<string>;
  sites?: Opt<Dict[]>;
  steps?: Opt<Dict[]>;
  hits?: Opt<Dict[]>;
  count?: Opt<number>;
}

export interface PWA11yResult extends SuccessBase {
  scope?: Opt<string>;
  violations?: Opt<Dict[]>;
  total?: Opt<number>;
  truncated?: Opt<boolean>;
  by_impact?: Opt<Record<string, number>>;
  by_rule?: Opt<Record<string, number>>;
  rules_run?: Opt<string[]>;
  contrast_sampled?: Opt<number>;
  contrast_capped?: Opt<boolean>;
  passed?: Opt<boolean>;
}

export interface PWVisualResult extends SuccessBase {
  name?: Opt<string>;
  baseline_created?: Opt<boolean>;
  passed?: Opt<boolean>;
  diff_ratio?: Opt<number>;
  diff_pixels?: Opt<number>;
  threshold?: Opt<number>;
  screenshot_url?: Opt<string>;
  baseline_url?: Opt<string>;
  diff_url?: Opt<string>;
  size_mismatch?: Opt<boolean>;
  pixel_diff_failed?: Opt<boolean>;
  fail_reason?: Opt<string>;
  dims?: Opt<Dict>;
}

export interface AskUserResult extends SuccessBase {
  displayed: boolean;
  count: number;
  note: string;
  warning?: Opt<string>;
}

export interface SkillSaveResult extends SuccessBase {
  name: string;
  path: string;
  source: "user" | "learned" | "global";
  domain?: Opt<string>;
  description?: Opt<string>;
  tags?: Opt<string[]>;
  note?: Opt<string>;
}

export interface SkillGetResult extends SuccessBase {
  name: string;
  body: string;
  description?: Opt<string>;
  domain?: Opt<string>;
  tags?: Opt<string[]>;
  source?: Opt<string>;
  is_folder: boolean;
  files?: Opt<string[]>;
  sandbox_path?: Opt<string>;
}

export interface SkillFileResult extends SuccessBase {
  name: string;
  path: string;
  content: string;
  size: number;
  truncated: boolean;
}

/** `ok` reflète le code de sortie du script, comme `execute_shell`. */
export interface SkillRunResult {
  ok: boolean;
  name: string;
  script: string;
  returncode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  note?: Opt<string>;
  [extra: string]: unknown;
}
