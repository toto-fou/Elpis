// SPDX-License-Identifier: MIT
// deploy/codecs/webp/elpis_webp_dec.c — décodage WebP du thread des images : première image en RGBA, comme Pillow (WebPAnimDecoder).
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "src/webp/decode.h"
#include "src/webp/demux.h"

// Première image du flux en RGBA (`largeur` × `hauteur` × 4 octets, à libérer par free) ; NULL si le flux est refusé.
uint8_t* elpis_webp_decode(const uint8_t* donnees, size_t taille, int* largeur, int* hauteur) {
  WebPData flux = {donnees, taille};
  WebPAnimDecoderOptions options;
  if (!WebPAnimDecoderOptionsInit(&options)) return NULL;
  options.color_mode = MODE_RGBA;
  options.use_threads = 0;
  WebPAnimDecoder* decodeur = WebPAnimDecoderNew(&flux, &options);
  if (decodeur == NULL) return NULL;
  WebPAnimInfo info;
  uint8_t* image = NULL;
  uint8_t* sortie = NULL;
  int horodatage = 0;
  if (WebPAnimDecoderGetInfo(decodeur, &info) && WebPAnimDecoderGetNext(decodeur, &image, &horodatage)) {
    const size_t n = (size_t)info.canvas_width * info.canvas_height * 4;
    sortie = (uint8_t*)malloc(n);
    if (sortie != NULL) {
      memcpy(sortie, image, n);
      *largeur = (int)info.canvas_width;
      *hauteur = (int)info.canvas_height;
    }
  }
  WebPAnimDecoderDelete(decodeur);
  return sortie;
}
