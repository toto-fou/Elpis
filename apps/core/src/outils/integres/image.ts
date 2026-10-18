// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/image.ts — outil `generate_image` du tour : le modèle génère des images, plafonnées par tour, rangées comme celles du tour « Images » (llm_core/tools/image_tool.py). */
import { intPy, pyJsonDumps, stripPy, strPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Base } from "@elpis/db";

import type { SurEvenement } from "../../boucle/evenements";
import { journal } from "../../journal";
import { cleanPrefs } from "../../images/acces";
import { ImageError } from "../../images/base";
import {
  effectiveMaxN,
  getImageConfig,
  imageReady,
  parseSize,
  RATIOS,
  sizeForRatio,
} from "../../images/config";
import type { ConfigImage } from "../../images/config";
import { readBytes, validId } from "../../images/magasin";
import type { RefImage } from "../../images/magasin";
import { buildRequest, capabilities, generateAndStore, ProgressTracker } from "../../images/service";
import type { OutilIntegre } from "../catalogue";

const log = journal("image");

export const TOOL_NAME = "generate_image";

export function definitionOutilImage(maxN: number): Dict {
  return {
    type: "function",
    function: {
      name: TOOL_NAME,
      description:
        "Generate images from a text description with the image engine and show " +
        "them to the user in the chat. Use it when the user asks for a picture, an " +
        "illustration, a logo, a mock-up or any visual. The images appear under your " +
        "message automatically: do not describe links or paste URLs. To modify an " +
        "image generated earlier, pass its id as ref_image_id.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "Detailed visual description in English: subject, setting, " +
              "style, lighting, composition. Text to render goes in double " +
              "quotes, verbatim.",
          },
          aspect_ratio: { type: "string", enum: [...RATIOS], description: "Width:height (default 1:1)." },
          n: { type: "integer", minimum: 1, maximum: maxN, description: "Number of images (default 1)." },
          ref_image_id: { type: "string", description: "Id of an image generated earlier, to modify it." },
        },
        required: ["prompt"],
      },
    },
  };
}

/** Taille demandée : format × côté préféré, ou la taille fixe du moteur au format le plus proche. */
export function tailleOutil(cfg: ConfigImage, ratio: string, side: number): string {
  const [w, h] = sizeForRatio(ratio, Math.min(side, cfg.max_side));
  if (cfg.size_policy !== "fixed") return `${w}x${h}`;
  const voulu = w / h;
  const tailles = (cfg.sizes ?? []).map((x) => parseSize(x)).filter((s): s is [number, number] => s !== null);
  if (!tailles.length) return `${w}x${h}`;
  let [bw, bh] = tailles[0]!;
  for (const [tw, th] of tailles.slice(1))
    if (Math.abs(tw / th - voulu) < Math.abs(bw / bh - voulu)) [bw, bh] = [tw, th];
  return `${bw}x${bh}`;
}

export interface OptionsOutilImage {
  readonly base: Base;
  readonly userId: number;
  readonly chatId: string | null;
  readonly onEvent: SurEvenement;
  readonly signal?: AbortSignal;
  readonly sink: Dict;
  readonly prefs: unknown;
}

const refus = (error: string, ascii = true): string =>
  pyJsonDumps({ ok: false, error }, { ensureAscii: ascii });

/** `{generate_image}` construit pour un tour, ou `{}` si le moteur n'est pas prêt ; appels et images comptés AVANT l'attente (appels parallèles compris). */
export function buildImageBuiltinTool(o: OptionsOutilImage): Record<string, OutilIntegre> {
  const cfg = getImageConfig();
  if (!imageReady(cfg)) return {};
  const side = cleanPrefs(veritePy(o.prefs) ? o.prefs : {}, cfg).side;
  const appels = { n: 0, images: 0 };
  const emettre = async (ev: Dict): Promise<void> => void (await o.onEvent?.(ev));

  const run = async (brut: unknown): Promise<string> => {
    const live = getImageConfig();
    if (!imageReady(live)) return refus("Image engine disabled.");
    appels.n += 1;
    if (appels.n > live.tool_max_calls)
      return refus(
        `Limit reached: at most ${live.tool_max_calls} image generations per turn. Show the user what you have.`,
      );
    const args: Dict =
      brut !== null && typeof brut === "object" && !Array.isArray(brut) ? (brut as Dict) : {};
    const prompt = stripPy(strPy(veritePy(args["prompt"]) ? args["prompt"] : ""));
    let ratio = strPy(veritePy(args["aspect_ratio"]) ? args["aspect_ratio"] : "1:1");
    if (!(RATIOS as readonly string[]).includes(ratio)) ratio = "1:1";
    let n: number;
    try {
      n = intPy(veritePy(args["n"]) ? args["n"] : 1);
    } catch {
      n = 1;
    }
    const reste = effectiveMaxN(live) - appels.images;
    if (reste <= 0)
      return refus(
        `Limit reached: at most ${effectiveMaxN(live)} images per turn. Show the user what you have.`,
      );
    n = Math.max(1, Math.min(n, reste));
    appels.images += n;
    const t0 = performance.now();
    let refs: RefImage[];
    let meta: Dict;
    try {
      let source: Uint8Array | null = null;
      const ref = args["ref_image_id"];
      if (veritePy(ref)) {
        if (!validId(ref)) throw new ImageError("Unknown ref_image_id.", { code: "invalid" });
        source = await readBytes(o.base, o.userId, ref);
        if (source === null)
          throw new ImageError("Image to modify not found or expired.", { code: "invalid" });
      }
      const caps = await capabilities(live, o.signal);
      const req = await buildRequest(live, prompt, { size: tailleOutil(live, ratio, side), n }, caps, source);
      const suivi = new ProgressTracker(req);
      await emettre(suivi.event("tool"));
      ({ refs, meta } = await generateAndStore(live, req, {
        userId: o.userId,
        chatId: o.chatId,
        prompt,
        caps,
        onProgress: () => emettre(suivi.event("tool")),
        ...(o.signal ? { signal: o.signal } : {}),
        tracker: suivi,
        extra: { source: "tool" },
        base: o.base,
      }));
    } catch (e) {
      if (!(e instanceof ImageError)) throw e;
      appels.images -= n;
      if (e.detail) log.warn(`outil : ${e.message} — ${e.detail}`);
      await emettre({ type: "image_error", source: "tool", ...e.payload() });
      return refus(e.message, false);
    }
    const images = (
      Array.isArray(o.sink["images"]) ? o.sink["images"] : (o.sink["images"] = [])
    ) as unknown[];
    images.push(...refs);
    if (Object.keys(meta).length) o.sink["meta"] = meta;
    await emettre({ type: "image", source: "tool", items: refs, prompt });
    log.info(
      `outil : user=${o.userId} chat=${Array.from(o.chatId ?? "")
        .slice(0, 12)
        .join("")} : ${refs.length} image(s) en ${((performance.now() - t0) / 1000).toFixed(1)} s`,
    );
    return pyJsonDumps(
      {
        ok: true,
        images: refs.map((r) => ({ id: r.id, width: r.width ?? null, height: r.height ?? null })),
        note: "Displayed to the user under your message.",
      },
      { ensureAscii: false },
    );
  };

  return {
    [TOOL_NAME]: { definition: definitionOutilImage(effectiveMaxN(cfg)), handler: (args) => run(args) },
  };
}
