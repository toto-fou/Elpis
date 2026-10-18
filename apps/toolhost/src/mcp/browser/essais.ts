// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/essais.ts — outils d'essai d'IHM : `pw_mock`, `pw_recorder`, `pw_observe`, `pw_a11y`, `pw_visual`. */
import { reprPy, stripPy, veritePy, versFlottantPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { dslToSelector, errPw, first } from "@elpis/navigateur";
import type { ContexteAppel } from "@elpis/outils-mcp";

import { borne, ouvrirAppel } from "./appel";
import type { ServicesBrowser } from "./appel";

/** `pw_mock` : réponses réseau simulées (add, list, clear, remove). */
export function pwMock(s: ServicesBrowser) {
  return async (a: Dict, ctx: ContexteAppel): Promise<unknown> => {
    const o = await ouvrirAppel(ctx, s, a["session_id"]);
    if (o.refus !== null) return o.refus;
    const { client } = o.appel;
    const sid = a["session_id"];
    const action = a["action"] as string;
    if (action === "add") {
      if (!a["url_pattern"]) return errPw("url_pattern required", "pass the URL (glob) pattern to mock");
      return client.req("POST", "/mock/add", {
        json: {
          session_id: sid,
          url_pattern: a["url_pattern"],
          status: a["status"],
          body: a["body"],
          content_type: a["content_type"],
          delay_ms: a["delay_ms"],
          times: a["times"],
        },
      });
    }
    if (action === "list") return client.req("GET", "/mock/list", { params: { session_id: sid } });
    if (action === "clear") return client.req("POST", "/mock/clear", { json: { session_id: sid } });
    if (action === "remove")
      return client.req("POST", "/mock/remove", { json: { session_id: sid, url_pattern: a["url_pattern"] } });
    return errPw(`unknown action ${reprPy(action)}`, "use: add|list|clear|remove");
  };
}

/** `pw_recorder` : enregistrement des gestes et export en script de test. */
export function pwRecorder(s: ServicesBrowser) {
  return async (a: Dict, ctx: ContexteAppel): Promise<unknown> => {
    const o = await ouvrirAppel(ctx, s, a["session_id"]);
    if (o.refus !== null) return o.refus;
    const { client } = o.appel;
    const sid = a["session_id"];
    const action = a["action"] as string;
    if (action === "start" || action === "stop" || action === "clear")
      return client.req("POST", `/recorder/${action}`, { json: { session_id: sid } });
    if (action === "dump")
      return client.req("GET", "/recorder/dump", { params: { session_id: sid, format: a["format"] } });
    if (action === "status") return client.req("GET", "/recorder/status", { params: { session_id: sid } });
    return errPw(`unknown action ${reprPy(action)}`, "use: start|stop|dump|clear|status");
  };
}

/** `pw_observe` : observation indexée, AX ou Set-of-Mark (`action` synonyme de `mode`). */
export function pwObserve(s: ServicesBrowser) {
  return async (a: Dict, ctx: ContexteAppel): Promise<unknown> => {
    const o = await ouvrirAppel(ctx, s, a["session_id"]);
    if (o.refus !== null) return o.refus;
    const { client } = o.appel;
    const mode = first(a["action"], a["mode"]) || "indexed";
    const params: Dict = {
      session_id: a["session_id"],
      mode: ["indexed", "ax", "som"].includes(mode) ? mode : "indexed",
      viewport_only: a["viewport_only"] ? "true" : "false",
      max_items: borne(a["max_items"], 1, 200),
    };
    if (Number(a["since_step"]) > 0) params["since_step"] = a["since_step"];
    if (!a["pierce_shadow"]) params["pierce_shadow"] = "false";
    return client.req("GET", "/observe", { params, timeout: Math.max(client.delaiS, 15) });
  };
}

/** `pw_a11y` : audit WCAG d'une portée CSS (`scope`, `selector` ou cible DSL ; `body` par défaut). */
export function pwA11y(s: ServicesBrowser) {
  return async (a: Dict, ctx: ContexteAppel): Promise<unknown> => {
    const o = await ouvrirAppel(ctx, s, a["session_id"]);
    if (o.refus !== null) return o.refus;
    const { client } = o.appel;
    const portee = first(a["scope"], a["selector"]) || dslToSelector(a["target"] as string) || "body";
    return client.req("POST", "/a11y_audit", {
      json: { session_id: a["session_id"], scope: portee },
      timeout: Math.max(client.delaiS, 20),
    });
  };
}

/** `pw_visual` : comparaison de la page (ou d'un élément) à sa référence. */
export function pwVisual(s: ServicesBrowser) {
  return async (a: Dict, ctx: ContexteAppel): Promise<unknown> => {
    const o = await ouvrirAppel(ctx, s, a["session_id"]);
    if (o.refus !== null) return o.refus;
    const { client } = o.appel;
    const corps: Dict = {
      session_id: a["session_id"],
      name: a["name"] || "default",
      threshold: versFlottantPy(a["threshold"] as number),
      update: veritePy(a["update"]),
    };
    const sel = stripPy((a["selector"] as string) || "") || dslToSelector(a["target"] as string);
    if (sel) corps["selector"] = sel;
    return client.req("POST", "/visual", { json: corps, timeout: Math.max(client.delaiS, 30) });
  };
}
