// SPDX-License-Identifier: MIT
/** packages/images/src/pngjs.d.ts — types de la partie de pngjs utilisée (lecture et écriture synchrones). */
declare module "pngjs" {
  type PngLu = {
    width: number;
    height: number;
    depth: number;
    colorType: number;
    data: Uint8Array | Uint16Array;
  };
  type OptionsLecture = { skipRescale?: boolean; checkCRC?: boolean };
  type OptionsEcriture = {
    colorType?: number;
    inputColorType?: number;
    inputHasAlpha?: boolean;
    bitDepth?: number;
    deflateLevel?: number;
  };
  const pngjs: {
    PNG: {
      sync: {
        read(octets: Buffer, options?: OptionsLecture): PngLu;
        write(png: { width: number; height: number; data: Buffer }, options?: OptionsEcriture): Buffer;
      };
    };
  };
  export default pngjs;
}
