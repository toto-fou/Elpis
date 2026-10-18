// SPDX-License-Identifier: MIT
// deploy/codecs/webp/elpis_webp_enc.c — encodage WebP avec perte du thread des images, réglages de Pillow (préréglage par défaut, alpha_quality 100).
#include <stdint.h>
#include <stdlib.h>

#include "src/webp/encode.h"

// Image RGBA → WebP (`*taille` octets, à libérer par elpis_webp_free) ; NULL en cas d'échec.
uint8_t* elpis_webp_encode(const uint8_t* rgba, int largeur, int hauteur, float qualite, int methode, size_t* taille) {
  WebPConfig config;
  WebPPicture image;
  WebPMemoryWriter ecrivain;
  if (!WebPConfigPreset(&config, WEBP_PRESET_DEFAULT, qualite)) return NULL;
  config.method = methode;
  config.alpha_quality = 100;
  config.exact = 0;
  if (!WebPValidateConfig(&config) || !WebPPictureInit(&image)) return NULL;
  image.width = largeur;
  image.height = hauteur;
  if (!WebPPictureImportRGBA(&image, rgba, largeur * 4)) {
    WebPPictureFree(&image);
    return NULL;
  }
  WebPMemoryWriterInit(&ecrivain);
  image.writer = WebPMemoryWrite;
  image.custom_ptr = &ecrivain;
  const int ok = WebPEncode(&config, &image);
  WebPPictureFree(&image);
  if (!ok) {
    WebPMemoryWriterClear(&ecrivain);
    return NULL;
  }
  *taille = ecrivain.size;
  return ecrivain.mem;
}

// Libère un tampon rendu par elpis_webp_encode.
void elpis_webp_free(void* tampon) { WebPFree(tampon); }
