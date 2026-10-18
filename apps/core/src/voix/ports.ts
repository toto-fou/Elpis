// SPDX-License-Identifier: MIT
/** apps/core/src/voix/ports.ts — port du client du moteur vocal utilisé par la console (sondes STT/TTS, modèles et voix chargés), branché par le lot des relais LAN (B1-27). */
import type { Dict } from "@elpis/commun";

/** `shared_infra/voice/client.py` : `sonde_stt`, `sonde_tts`, `liste_modeles` ; un échec du moteur lève `VoiceError`. */
export interface ClientVoix {
  sondeStt(cfg: Dict): Promise<Dict>;
  sondeTts(cfg: Dict): Promise<Dict>;
  listeModeles(section: "stt" | "tts", cfg: Dict): Promise<Dict>;
}

/** Client absent (B1-27 pas encore branché) : la console le rend comme toute erreur inattendue du Python. */
export class ClientVoixAbsent extends Error {
  override name = "ClientVoixAbsent";
  constructor() {
    super("client du moteur vocal non branché");
  }
}

let installe: ClientVoix | null = null;

/** Pose (ou retire, `null`) le client du process. */
export function installerClientVoix(client: ClientVoix | null): void {
  installe = client;
}

export function clientVoix(): ClientVoix {
  if (installe === null) throw new ClientVoixAbsent();
  return installe;
}
