// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/elements.ts — `pw_find`, `pw_act` (crochets de la mémoire AX avant et après le geste) et `pw_chain` : cibles en DSL traduites pour le service. */
import { estDict, reprPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Base } from "@elpis/db";
import { messageErreur } from "@elpis/mcp";
import {
  buildLocatorPayload,
  clampItems,
  dslToByKw,
  dslToSelector,
  errPw,
  first,
  mergeTarget,
  mergeValue,
  parseTargetDsl,
  recordAction,
  refusUrl,
  waitPayload,
} from "@elpis/navigateur";
import type { ContexteAppel } from "@elpis/outils-mcp";

import { ouChamps, ouvrirAppel, rappelOngletActif, urlApres } from "./appel";
import type { ServicesBrowser } from "./appel";
import { nettoyerResultat, normaliserReference, resoudreSecrets } from "./creds";
import type { SecretResolu } from "./creds";
import { fichiersUpload } from "./fichiers";

const NAV: Readonly<Record<string, string>> = {
  goto: "goto",
  back: "back",
  forward: "forward",
  reload: "reload",
};
const GESTES: Readonly<Record<string, string>> = {
  click: "click",
  fill: "fill",
  type: "type",
  clear: "clear",
  press: "press",
  select: "select_option",
  hover: "hover",
  check: "check",
  uncheck: "uncheck",
  focus: "focus",
  scroll: "scroll",
  scroll_to: "scroll_into_view",
  dblclick: "double_click",
  rclick: "right_click",
  upload: "upload",
  drag: "drag",
  expand: "expand",
  collapse: "collapse",
};
const BY_DSL: readonly (readonly [string, string])[] = [
  ["role", "by_role"],
  ["name", "by_name"],
  ["text", "by_text"],
  ["label", "by_label"],
  ["placeholder", "by_placeholder"],
  ["test_id", "by_test_id"],
  ["alt", "by_alt"],
  ["title", "by_title"],
  ["css", "by_css"],
  ["xpath", "by_xpath"],
];

/** Ordre des `by_*` dans le corps d'un geste de `pw_act` (celui de `_build_locator_payload`). */
const BY_ACT = [
  "by_role",
  "by_name",
  "by_text",
  "by_label",
  "by_placeholder",
  "by_test_id",
  "by_css",
  "by_xpath",
  "by_alt",
  "by_title",
] as const;

/** Paramètres `by_*` non nuls d'une cible DSL. */
export function byNonNuls(target: string): Dict {
  return Object.fromEntries(Object.entries(dslToByKw(target)).filter(([, v]) => v !== null));
}

/** `pw_find` : sans cible, inspection légère ; sinon `/locator` (DSL prioritaire, `max_items` l'emporte sur `max`). */
export function pwFind(s: ServicesBrowser) {
  return async (a: Dict, ctx: ContexteAppel): Promise<unknown> => {
    const o = await ouvrirAppel(ctx, s, a["session_id"]);
    if (o.refus !== null) return o.refus;
    const { client } = o.appel;
    const target = mergeTarget(a["target"] as string, a["selector"] as string);
    const seuls = ["role", "text", "label", "placeholder", "test_id", "css", "xpath", "alt", "title"];
    if (!target && !seuls.some((k) => veritePy(a[k]))) {
      const params: Dict = { session_id: a["session_id"], level: "lite", skip_screenshot: "true" };
      if (veritePy(a["max_items"])) params["max_items"] = clampItems(a["max_items"]);
      return client.req("GET", "/smart_inspect", { params });
    }
    const [charge] = buildLocatorPayload({
      target,
      ...(Object.fromEntries(
        ["role", "name", "text", "label", "placeholder", "test_id", "css", "xpath", "alt", "title"].map(
          (k) => [k, a[k]],
        ),
      ) as Dict),
      nth: a["nth"],
      max: veritePy(a["max_items"]) ? clampItems(a["max_items"]) : a["max"],
    });
    charge["session_id"] = a["session_id"];
    if (a["include_frames"]) charge["include_frames"] = true;
    return client.req("POST", "/locator", { json: charge });
  };
}

/** Rôle et nom retenus pour la mémoire AX d'un geste : paramètres, puis résultat, puis valeurs déduites du geste. */
function roleEtNom(geste: string, resolus: Dict, resultat: unknown): [unknown, unknown] {
  let role: unknown = veritePy(resolus["role"]) ? resolus["role"] : "";
  let nom: unknown = veritePy(resolus["name"]) ? resolus["name"] : "";
  if (estDict(resultat)) {
    if (!veritePy(role)) role = ouChamps(resultat, "element_role", "role");
    if (!veritePy(nom)) nom = ouChamps(resultat, "element_name", "accessible_name");
  }
  if (!veritePy(nom)) nom = ouChamps(resolus, "text", "label", "placeholder", "test_id");
  if (!veritePy(role)) {
    if (geste === "fill" || geste === "type") role = "textbox";
    else if (
      (geste === "click" || geste === "dblclick") &&
      veritePy(ouChamps(resolus, "text", "label", "test_id", "css"))
    )
      role = "button";
    else if (geste === "select") role = "combobox";
    else if (geste === "check" || geste === "uncheck") role = "checkbox";
    else role = "generic";
  }
  if (!veritePy(nom) && veritePy(ouChamps(resolus, "css", "xpath", "ref")))
    nom = ouChamps(resolus, "css", "xpath") || `ref:${String(resolus["ref"])}`;
  return [role, nom];
}

const GESTES_SECRETS: ReadonlySet<string> = new Set(["fill", "type"]);

const REFUS_GESTE_SECRET = (geste: string): Dict =>
  errPw("secret_gesture_refused", "", {
    message: `secret= is only usable with action='fill' or 'type' (got ${JSON.stringify(geste)})`,
    fix: "fill / type the secret into a field with a target; never put it in goto, evaluate, press…",
  });

const REFUS_CIBLE_SECRET: Dict = errPw("secret_requires_target", "", {
  message: "secret= needs the field to fill: a target (or ref), never the focused element",
  fix: "pw_act(session_id, action='fill', target='label=Password', secret='TOKEN.password')",
});

/** `pw_act` : `pick` (toute liste déroulante), navigation (garde de l'adresse ; ni élément ni transition AX), gestes sur une cible (`nth`, `strict`, fichiers du bac pour `upload` ; transition AX s'ils changent de page) ; page jointe au résultat. */
export function pwAct(s: ServicesBrowser) {
  return async (a: Dict, ctx: ContexteAppel): Promise<unknown> => {
    const o = await ouvrirAppel(ctx, s, a["session_id"]);
    if (o.refus !== null) return o.refus;
    const { client, ax } = o.appel;
    const sid = a["session_id"] as string;
    const geste = first(a["action"], a["do"]);
    let v = mergeValue(a["value"], a["v"]);
    const target = mergeTarget(a["target"] as string, a["selector"] as string);
    const refSecret = normaliserReference(a["secret"]);
    let secrets: SecretResolu[] = [];
    if (refSecret) {
      if (!GESTES_SECRETS.has(geste)) return REFUS_GESTE_SECRET(geste);
      if (
        !target &&
        !first(
          a["ref"],
          a["role"],
          a["text"],
          a["label"],
          a["placeholder"],
          a["test_id"],
          a["css"],
          a["xpath"],
          a["alt"],
          a["title"],
        )
      )
        return REFUS_CIBLE_SECRET;
      const r = await resoudreSecrets(s, ctx, [refSecret]);
      if ("refus" in r) return r.refus;
      secrets = r.secrets;
      v = secrets[0]?.valeur ?? "";
    }
    const urlAvant = ax !== null ? await client.axGetCurrentUrl(sid) : "";
    const observe = a["observe"] as boolean;
    if (geste === "pick") {
      const sel = dslToSelector(target);
      if (!sel)
        return errPw("target_required", "", {
          message: "pick needs to know WHICH dropdown to open.",
          fix: "pw_act(session_id, action='pick', target='css=#city', option_label='Lyon')",
        });
      if (!first(a["option_label"], a["option_value"], v))
        return errPw("option_required", "", {
          message: "pick needs the option to choose.",
          fix: "pass option_label='<visible text>' (or option_value=).",
        });
      const texte = a["option_label"] || v || "";
      const r = await client.req("POST", "/handle_dropdown", {
        json: {
          session_id: sid,
          selector: sel,
          option_text: texte,
          option_value: a["option_value"] || "",
          search_text: texte,
        },
        timeout: Math.max(client.delaiS, 25),
      });
      return client.finishAct(await rappelOngletActif(client, sid, r), sid, observe, a["max_items"]);
    }
    if (Object.hasOwn(NAV, geste)) {
      const url = a["url"] as string;
      if (geste === "goto") {
        const bloque = await refusUrl(url);
        if (bloque !== null) return bloque;
      }
      const r = await client.req("POST", "/action", {
        json: { session_id: sid, type: NAV[geste], url, ...waitPayload(a["wait_after"]) },
        timeout: Math.max(client.delaiS, 75),
      });
      return client.finishAct(r, sid, observe, a["max_items"]);
    }
    if (!geste)
      return errPw("action_required", "", {
        message: "pw_act needs to know WHICH gesture to perform.",
        fix: "pw_act(session_id, action='click'|'fill'|'press'|'goto'|…, target='role=button|name=Login'). action= (legacy synonym: do=) is required.",
      });
    if (!Object.hasOwn(GESTES, geste))
      return errPw(
        `action=${reprPy(geste)} unknown`,
        `use: ${[...Object.keys(GESTES), ...Object.keys(NAV), "pick"].join("|")}`,
      );
    const [charge, resolus] = buildLocatorPayload({
      target,
      ...(Object.fromEntries(
        [
          "role",
          "name",
          "text",
          "label",
          "placeholder",
          "test_id",
          "css",
          "xpath",
          "alt",
          "title",
          "ref",
        ].map((k) => [k, a[k]]),
      ) as Dict),
    });
    const direction = a["direction"];
    const amount = a["amount"];
    const type =
      geste === "scroll" && target && !direction && !veritePy(amount) ? "scroll_into_view" : GESTES[geste];
    const corps: Dict = { session_id: sid, type, ref: charge["ref"] };
    for (const by of BY_ACT) corps[by] = charge[by];
    Object.assign(corps, {
      text: v || null,
      value: v || null,
      key: v || null,
      ...waitPayload(a["wait_after"]),
    });
    if (secrets.length > 0) Object.assign(corps, { key: null, secret_origin: secrets[0]?.origine });
    if (a["option_label"]) corps["option_label"] = a["option_label"];
    if (a["option_value"]) corps["option_value"] = a["option_value"];
    if (typeof charge["nth"] === "number") corps["nth"] = charge["nth"];
    if (a["strict"] === true) corps["strict"] = true;
    if (geste === "upload") {
      const f = await fichiersUpload(a["files"], o.appel.username);
      if ("refus" in f) return f.refus;
      corps["files"] = f.fichiers;
    }
    if (direction) corps["direction"] = direction;
    if (veritePy(amount)) corps["amount"] = amount;
    if (geste === "drag") {
      const vers = mergeTarget(a["to"] as string, "");
      if (vers) {
        corps["to"] = byNonNuls(vers);
        const selVers = dslToSelector(vers);
        if (selVers) corps["target_selector"] = selVers;
      } else if (!(direction || veritePy(amount)))
        return errPw("drag_destination_required", "", {
          message: "drag needs WHERE to drop.",
          fix: "pw_act(session_id, action='drag', target='css=#a', to='css=#b') — or direction=/amount= for an offset.",
        });
    }
    const repli = dslToSelector(target);
    if (repli) corps["selector"] = repli;
    const r = nettoyerResultat(
      await rappelOngletActif(client, sid, await client.req("POST", "/action", { json: corps })),
      secrets,
    );
    if (ax !== null) {
      try {
        const apres = await urlApres(client, r, sid);
        const [role, nom] = roleEtNom(geste, resolus, r);
        if (veritePy(role) && veritePy(nom))
          await recordAction(ax, {
            url: apres as string,
            role: role as string,
            name: nom as string,
            result: r,
            locatorKw: resolus,
            urlBefore: urlAvant,
            ancestors: estDict(r) && Array.isArray(r["ancestors"]) ? r["ancestors"] : [],
          });
      } catch (e) {
        s.journal.warn(`[ax-hook] hook exception: ${messageErreur(e)}`);
      }
    }
    return nettoyerResultat(await client.finishAct(r, sid, observe, a["max_items"]), secrets);
  };
}

/** Étape de `pw_chain` pour le service : verbe en `type`, cible DSL en `by_*` plus sélecteur de repli, `v`/`value` vers `key`, `value` ou `text`. */
function etape(brute: Dict): Dict {
  const e: Dict = { ...brute };
  const prendre = (k: string): unknown => {
    const v = Object.hasOwn(e, k) ? e[k] : null;
    delete e[k];
    return v;
  };
  let verbe = prendre("do");
  if (!veritePy(verbe)) verbe = prendre("type");
  if (!veritePy(verbe)) verbe = prendre("action");
  if (veritePy(verbe)) e["type"] = verbe;
  if (Object.hasOwn(e, "target") && veritePy(e["target"])) {
    const d = parseTargetDsl(e["target"] as string);
    if (veritePy(d["ref"])) e["ref"] = d["ref"];
    for (const [k, by] of BY_DSL) if (veritePy(d[k])) e[by] = d[k];
    if (typeof d["nth"] === "number" || typeof d["nth"] === "bigint") e["nth"] = d["nth"];
    const repli = veritePy(d["ref"])
      ? `ref:${String(d["ref"])}`
      : veritePy(d["test_id"])
        ? `[data-testid="${String(d["test_id"])}"]`
        : veritePy(d["label"])
          ? `label=${String(d["label"])}`
          : veritePy(d["placeholder"])
            ? `placeholder=${String(d["placeholder"])}`
            : veritePy(d["text"])
              ? d["text"]
              : veritePy(d["css"])
                ? d["css"]
                : veritePy(d["xpath"])
                  ? `xpath=${String(d["xpath"])}`
                  : veritePy(d["role"]) && veritePy(d["name"])
                    ? d["name"]
                    : null;
    if (repli !== null && !Object.hasOwn(e, "selector")) e["selector"] = repli;
    delete e["target"];
  }
  const choix = e["type"] === "select" || e["type"] === "select_option";
  let v = prendre("v");
  if (v === null && !choix) v = prendre("value");
  if (v !== null) {
    const cle = e["type"] === "press" ? "key" : choix ? "value" : "text";
    e[cle] = veritePy(e[cle]) ? e[cle] : v;
  }
  return e;
}

/** Transitions des étapes de `/chain` qui ont changé de page (`navigated`, `url_before`, `url`) apprises par la mémoire AX, comme un geste de pw_act. */
async function apprendreEtapes(s: ServicesBrowser, ax: Base, actions: Dict[], r: unknown): Promise<void> {
  if (!estDict(r) || !Array.isArray(r["results"])) return;
  for (const res of r["results"] as unknown[]) {
    if (!estDict(res) || res["navigated"] !== true || res["success"] === false) continue;
    const brute = actions[Number(res["step"])];
    if (!estDict(brute)) continue;
    try {
      const resolus = parseTargetDsl(mergeTarget(brute["target"] as string, brute["selector"] as string));
      const geste = String(first(brute["do"], brute["action"], brute["type"]) || res["action"] || "");
      const [role, nom] = roleEtNom(geste, resolus, res);
      if (veritePy(role) && veritePy(nom))
        await recordAction(ax, {
          url: String(res["url"] ?? ""),
          role: role as string,
          name: nom as string,
          result: res,
          locatorKw: resolus,
          urlBefore: String(res["url_before"] ?? ""),
        });
    } catch (e) {
      s.journal.warn(`[ax-hook] chain step hook exception: ${messageErreur(e)}`);
    }
  }
}

/** `pw_chain` : étapes traduites et jouées en un aller-retour (`/chain`), étapes qui ont navigué apprises (mémoire AX), page jointe au résultat. */
export function pwChain(s: ServicesBrowser) {
  return async (a: Dict, ctx: ContexteAppel, brut: Dict): Promise<unknown> => {
    const o = await ouvrirAppel(ctx, s, a["session_id"]);
    if (o.refus !== null) return o.refus;
    const { client, ax } = o.appel;
    const actions = (Array.isArray(brut["actions"]) ? brut["actions"] : a["actions"]) as Dict[];
    if (!actions.length) return errPw("actions[] required", "pass a non-empty list of action steps");
    const refs = new Set<string>();
    for (const st of actions) {
      const ref = estDict(st) ? normaliserReference(st["secret"]) : "";
      if (!ref) continue;
      const geste = first(st["do"], st["type"], st["action"]);
      if (!GESTES_SECRETS.has(geste)) return REFUS_GESTE_SECRET(geste);
      if (
        !first(
          st["target"],
          st["selector"],
          st["ref"],
          st["by_css"],
          st["by_role"],
          st["by_label"],
          st["by_placeholder"],
        )
      )
        return REFUS_CIBLE_SECRET;
      refs.add(ref);
    }
    let secrets: SecretResolu[] = [];
    if (refs.size > 0) {
      const res = await resoudreSecrets(s, ctx, [...refs]);
      if ("refus" in res) return res.refus;
      secrets = res.secrets;
    }
    const envoyees = actions.map((st) => {
      const ref = estDict(st) ? normaliserReference(st["secret"]) : "";
      if (!ref) return etape(st);
      const secret = secrets.find((x) => x.ref === ref);
      const { secret: _s, value: _v, v: _w, text: _t, ...reste } = st;
      return etape({ ...reste, text: secret?.valeur ?? "", secret_origin: secret?.origine ?? "" });
    });
    const r = nettoyerResultat(
      await client.req("POST", "/chain", {
        json: {
          session_id: a["session_id"],
          actions: envoyees,
          stop_on_error: a["stop_on_error"],
          screenshot_on_fail: a["screenshot_on_fail"],
        },
        timeout: Math.max(client.delaiS, 60),
      }),
      secrets,
    );
    if (ax !== null) await apprendreEtapes(s, ax, actions, r);
    return nettoyerResultat(
      await client.finishAct(r, a["session_id"] as string, a["observe"] as boolean, a["max_items"]),
      secrets,
    );
  };
}
