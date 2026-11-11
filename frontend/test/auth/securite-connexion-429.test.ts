// SPDX-License-Identifier: MIT
/** frontend/test/auth/securite-connexion-429.test.ts — page de connexion : un 429 affiche une attente réaliste, en français, sans fermer la session. */
import { describe, expect, it } from "vitest";
import { ref } from "vue";

import { setupAuth } from "../../src/features/auth/auth";
import type { UtilisateurAffiche } from "../../src/features/auth/auth";
import { GestionnaireSession } from "../../src/features/auth/session";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

describe("login() sur 429", () => {
  it("message de patience, session intacte", async () => {
    const session = new GestionnaireSession();
    const appels: string[] = [];
    const http = new ClientHttp(session, (u) => {
      appels.push(u);
      return Promise.resolve(json({ detail: "Trop de tentatives de connexion." }, 429));
    });
    const auth = setupAuth(
      {
        user: ref<UtilisateurAffiche | null>(null),
        isAdminView: ref(false),
        messages: ref<unknown[]>([]),
        currentChatId: ref<unknown>(null),
        isStreaming: ref(false),
      },
      { showToast: () => undefined, fetchAuth: () => Promise.resolve(null) },
      { session, http, fenetre: { location: { href: "/" } } },
    );
    auth.loginForm.value = { username: "alice", password: "pw" };
    await auth.login();
    expect(auth.loginError.value).toBe("Trop de tentatives. Patientez quelques minutes avant de réessayer.");
    expect(appels).toEqual(["/api/login-lite"]);
    expect(session.etat.statut).toBe("inconnu");
    expect(auth.isLoading.value).toBe(false);
  });
});
