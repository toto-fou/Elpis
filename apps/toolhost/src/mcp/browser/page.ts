// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/page.ts — `pw_page` (inspection relevée par la mémoire AX, captures, texte, onglets…), `pw_dialog`, `pw_wait` (pause ou condition sondée par tranches, battement) et `pw_expect`. */
import { setTimeout as dormir } from "node:timers/promises";

import { estDict, prefixePy, pyJsonDumps, reprPy, stripPy, strPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import {
  axExtractNodesFromInspect,
  buildLocatorPayload,
  clampItems,
  dslToSelector,
  errPw,
  first,
  mergeTarget,
  mergeValue,
  recordInspection,
  refusUrl,
  screenshotResult,
} from "@elpis/navigateur";
import type { ClientNavigateur } from "@elpis/navigateur";
import { Heartbeat } from "@elpis/outils-mcp";
import type { ContexteAppel } from "@elpis/outils-mcp";

import { borne, entierEnv, ouChamps, ouvrirAppel } from "./appel";
import type { ServicesBrowser } from "./appel";
import { byNonNuls } from "./elements";

const CONDITIONS = [
  "hidden",
  "visible",
  "attached",
  "detached",
  "text_contains",
  "text_changes",
  "count_increases",
  "count_decreases",
  "attribute_changes",
];

/** `selector` brut nettoyé, sinon le sélecteur de la cible DSL. */
function selecteur(a: Dict): string {
  return stripPy((a["selector"] as string) || "") || dslToSelector(a["target"] as string);
}

/** `eval` : résultat texte plus long que `PLAYWRIGHT_EVAL_MAX_CHARS` coupé, liste ou objet trop long remplacé par un aperçu. */
function borneEval(r: unknown): unknown {
  if (!estDict(r)) return r;
  const max = entierEnv("PLAYWRIGHT_EVAL_MAX_CHARS", "50000");
  const res = r["result"];
  if (typeof res === "string" && Array.from(res).length > max)
    return {
      ...r,
      result: prefixePy(res, max),
      truncated: true,
      original_length: Array.from(res).length,
      hint: "Result too large; narrow the script (e.g. .slice(0, N) or specific properties).",
    };
  if (Array.isArray(res) || estDict(res)) {
    const texte = pyJsonDumps(res);
    if (texte.length > max)
      return {
        ...r,
        result_preview: prefixePy(texte, 5000),
        result: null,
        truncated: true,
        original_length: texte.length,
        hint: "Result too large; narrow the script.",
      };
  }
  return r;
}

/** `pw_page` : opérations de page (`action`/`op`) ; l'inspection alimente la mémoire AX (périmés revus ou supprimés). */
export function pwPage(s: ServicesBrowser) {
  return async (a: Dict, ctx: ContexteAppel): Promise<unknown> => {
    const o = await ouvrirAppel(ctx, s, a["session_id"]);
    if (o.refus !== null) return o.refus;
    const { client, ax } = o.appel;
    const op = first(a["action"], a["op"]);
    const v = mergeValue(a["value"], a["v"]);
    const sid = a["session_id"];
    if (!op)
      return errPw("action_required", "", {
        message: "pw_page needs to know WHICH page operation to run.",
        fix: "pw_page(session_id, action='inspect'|'text'|'screenshot'|'extract'|…). action= (legacy synonym: op=) is required.",
      });
    if (op === "inspect") {
      const level = a["level"] as string;
      const params: Dict = {
        session_id: sid,
        level: ["lite", "nav", "full"].includes(level) ? level : "lite",
        viewport_only: a["viewport_only"] ? "true" : "false",
        max_items: borne(a["max_items"], 1, 200),
        skip_screenshot: a["skip_screenshot"] || level === "lite" ? "true" : "false",
      };
      if (Number(a["since_step"]) > 0) params["since_step"] = a["since_step"];
      if (a["include_frames"]) params["include_frames"] = "true";
      if (!a["pierce_shadow"]) params["pierce_shadow"] = "false";
      const r = await client.req("GET", "/smart_inspect", { params });
      if (ax !== null && estDict(r)) {
        const url = ouChamps(r, "url", "current_url");
        if (veritePy(url))
          await recordInspection(ax, url as string, axExtractNodesFromInspect(r)).catch(() => undefined);
      }
      return r;
    }
    if (op === "screenshot") {
      const cible = mergeTarget(a["target"] as string, a["selector"] as string);
      let r: unknown;
      if (cible) {
        const [charge] = buildLocatorPayload({ target: cible });
        charge["session_id"] = sid;
        r = await client.req("POST", "/element_screenshot", { json: charge });
      } else
        r = await client.req("POST", "/screenshot", { json: { session_id: sid, full_page: a["full_page"] } });
      return screenshotResult(r, { fullPage: a["full_page"], target: cible });
    }
    if (op === "wait") {
      const css = selecteur(a);
      if (!css)
        return errPw("target_required", "", {
          message: "pw_page(action='wait') needs the element to wait for.",
          fix: "pw_page(action='wait', target='css=#done') — target= (DSL) or selector= (raw CSS) is required.",
        });
      return client.req("POST", "/wait_for", { json: { session_id: sid, selector: css, timeout: 5000 } });
    }
    if (op === "eval")
      return borneEval(await client.req("POST", "/evaluate", { json: { session_id: sid, script: v } }));
    if (op === "extract") {
      const corps: Dict = { session_id: sid, max_rows: a["max"] };
      const css = selecteur(a);
      if (css) corps["selector"] = css;
      return client.req("POST", "/extract_table", { json: corps });
    }
    if (op === "element") {
      const css = selecteur(a);
      if (!css)
        return errPw("target_required", "", {
          message: "element needs to know WHICH element to describe.",
          fix: "pw_page(action='element', target='css=#save')",
        });
      return client.req("POST", "/element_info", { json: { session_id: sid, selector: css } });
    }
    if (op === "frames") return client.req("GET", "/frames", { params: { session_id: sid } });
    if (op === "text") {
      const corps: Dict = { session_id: sid };
      const css = selecteur(a);
      if (css) corps["selector"] = css;
      if (a["include_frames"]) corps["include_frames"] = true;
      if (!a["pierce_shadow"]) corps["pierce_shadow"] = false;
      const delai = a["include_frames"] ? Math.max(client.delaiS, 30) : null;
      return client.req("POST", "/extract_text", { json: corps, timeout: delai });
    }
    if (op === "tabs") return client.req("GET", "/list_tabs", { params: { session_id: sid } });
    if (op === "tab_new") {
      if (v) {
        const bloque = await refusUrl(v);
        if (bloque !== null) return bloque;
      }
      return client.req("POST", "/new_tab", {
        json: { session_id: sid, url: v, ...(a["switch"] ? { switch: true } : {}) },
      });
    }
    if (op === "tab_switch" || op === "tab_close")
      return client.req("POST", op === "tab_switch" ? "/switch_tab" : "/close_tab", {
        json: { session_id: sid, tab_index: a["index"] },
      });
    if (op === "network") {
      const params: Dict = { session_id: sid, last: clampItems(a["max"], 50) };
      if (v) params["filter"] = v;
      return client.req("GET", "/network", { params });
    }
    if (op === "pdf") return client.req("POST", "/print_pdf", { json: { session_id: sid } });
    return errPw(
      `action=${reprPy(op)} unknown`,
      "use: inspect|screenshot|wait|eval|extract|text|element|frames|tabs|tab_new|tab_switch|tab_close|network|pdf",
    );
  };
}

/** `pw_dialog` : politique de réponse au prochain dialogue natif (accept, dismiss, status, reset). */
export function pwDialog(s: ServicesBrowser) {
  return async (a: Dict, ctx: ContexteAppel): Promise<unknown> => {
    const o = await ouvrirAppel(ctx, s, a["session_id"]);
    if (o.refus !== null) return o.refus;
    const action = first(a["action"]) || "status";
    if (!["accept", "dismiss", "status", "reset"].includes(action))
      return errPw(`action=${reprPy(action)} unknown`, "use: accept|dismiss|status|reset");
    return o.appel.client.req("POST", "/dialog", {
      json: {
        session_id: a["session_id"],
        action,
        input_text: a["text"],
        times: a["times"],
        sticky: veritePy(a["sticky"]),
      },
    });
  };
}

/** `pw_wait` en mode condition : tranches de `/wait_for_dynamic` (ligne de base repassée) jusqu'à l'échéance, 423/429 = session occupée. */
async function attendreCondition(client: ClientNavigateur, a: Dict, ctx: ContexteAppel): Promise<unknown> {
  const sid = a["session_id"];
  const cibleDsl = mergeTarget(a["target"] as string, a["selector"] as string);
  const sel = dslToSelector(cibleDsl);
  const by = byNonNuls(cibleDsl);
  if (!sel && !Object.keys(by).length)
    return errPw(
      "target or selector required for a condition wait",
      "pass target='css=.spinner' (or selector=) and a condition",
    );
  const condition = a["condition"] as string;
  if (!CONDITIONS.includes(condition))
    return errPw(`condition=${reprPy(condition)} unknown`, `use: ${CONDITIONS.join("|")}`);
  const maxS = entierEnv("PLAYWRIGHT_WAIT_MAX_S", "300");
  const trancheMs = entierEnv("PLAYWRIGHT_WAIT_CHUNK_MS", "8000");
  const budget = borne(a["max_wait_s"], 1, maxS);
  const sonde = borne(a["poll_ms"], 50, 5000);
  const t0 = performance.now();
  const echeance = t0 + budget * 1000;
  const ecoule = (): number => Math.trunc(performance.now() - t0);
  let ligneDeBase: Dict | null = null;
  let dernier: Dict = {};
  return new Heartbeat(ctx).avec(async () => {
    for (;;) {
      const reste = echeance - performance.now();
      if (reste <= 0) break;
      const tranche = Math.max(200, Math.trunc(Math.min(trancheMs, reste)));
      const charge: Dict = {
        session_id: sid,
        selector: sel,
        condition,
        expected_text: a["expected_text"],
        attribute: a["attribute"],
        expected_value: a["expected_value"],
        timeout: tranche,
        poll_interval: sonde,
        ...by,
      };
      if (ligneDeBase !== null) charge["baseline"] = ligneDeBase;
      const [code, corps] = await client.reqStatus("POST", "/wait_for_dynamic", {
        json: charge,
        timeout: tranche / 1000 + 5,
      });
      if (code === 200) {
        const out: Dict = {
          ok: true,
          mode: "condition",
          condition,
          status: corps["status"] ?? null,
          selector: sel,
          session_id: sid,
          elapsed_ms: ecoule(),
        };
        for (const k of ["via", "polled_value", "text", "from", "to", "box", "attribute", "value"])
          if (Object.hasOwn(corps, k)) out[k] = corps[k];
        return out;
      }
      if (code === 408) {
        dernier = corps;
        if (estDict(dernier["baseline"])) ligneDeBase = dernier["baseline"];
        continue;
      }
      if (code === 404) return errPw("Session not found", "start one with pw_session(action='start')");
      if (code === 410) return errPw("Session expired", "reopen with pw_session(action='start')");
      if (code === 423 || code === 429) {
        await dormir(300);
        continue;
      }
      return errPw(
        strPy(veritePy(corps["error"]) ? corps["error"] : `wait failed (${code})`),
        "check the selector and that the session is alive",
      );
    }
    return {
      ok: false,
      mode: "condition",
      condition,
      status: "timeout",
      selector: sel,
      session_id: sid,
      timed_out: true,
      via: dernier["via"] ?? null,
      polled_value: dernier["polled_value"] ?? null,
      elapsed_ms: ecoule(),
      hint: `condition '${condition}' on '${sel || cibleDsl}' not met within ${budget}s — polled_value shows what the element displayed last`,
    };
  });
}

/** `pw_wait` : pause fixe (`seconds`, sans session ni cible) ou attente d'une condition sur une cible. */
export function pwWait(s: ServicesBrowser) {
  return async (a: Dict, ctx: ContexteAppel): Promise<unknown> => {
    const o = await ouvrirAppel(ctx, s, a["session_id"]);
    if (o.refus !== null) return o.refus;
    const secondes = a["seconds"] as number;
    if (secondes && secondes > 0 && !(a["session_id"] && (a["target"] || a["selector"]))) {
      const duree = Math.max(0, Math.min(secondes, entierEnv("PLAYWRIGHT_WAIT_MAX_S", "300")));
      const t0 = performance.now();
      await new Heartbeat(ctx).avec(() => dormir(duree * 1000));
      return { ok: true, mode: "duration", elapsed_ms: Math.trunc(performance.now() - t0) };
    }
    if (!a["session_id"])
      return errPw(
        "session_id required for a condition wait",
        "pw_wait(session_id=..., target=..., condition='hidden') — or pw_wait(seconds=N) for a fixed pause",
      );
    return attendreCondition(o.appel.client, a, ctx);
  };
}

/** `pw_expect` : assertion sur un élément (cible DSL en `by_*`) ou sur la page, délai de requête au-delà du délai de l'assertion. */
export function pwExpect(s: ServicesBrowser) {
  return async (a: Dict, ctx: ContexteAppel): Promise<unknown> => {
    const o = await ouvrirAppel(ctx, s, a["session_id"]);
    if (o.refus !== null) return o.refus;
    const { client } = o.appel;
    const assertion = first(a["action"], a["assertion"]);
    const target = mergeTarget(a["target"] as string, a["selector"] as string);
    if (!assertion)
      return errPw("action_required", "", {
        message: "pw_expect needs to know WHICH assertion to check.",
        fix: "pw_expect(session_id, action='visible'|'text-equals'|'url-contains'|…). action= (legacy synonym: assertion=) is required.",
      });
    const corps: Dict = {
      session_id: a["session_id"],
      assertion,
      value: mergeValue(a["value"], a["v"]),
      timeout_ms: a["timeout_ms"],
    };
    if (target) Object.assign(corps, byNonNuls(target));
    return client.req("POST", "/expect", {
      json: corps,
      timeout: Math.max(client.delaiS, Math.trunc(Number(a["timeout_ms"]) / 1000) + 5),
    });
  };
}
