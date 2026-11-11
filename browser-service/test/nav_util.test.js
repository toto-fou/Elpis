// SPDX-License-Identifier: MIT
// Régression : classification du résultat de navigation (page.goto).
//
// Bug d'origine : naviguer vers http://IP:port (ex. http://192.1.1.1:8080) via
// l'action goto produisait un HTTP 500 opaque — l'exception de page.goto
// remontait au catch externe (seul /start la protégeait). Le fix capture
// l'erreur et la classe via classifyNavOutcome : succès, succès partiel
// (page atteinte malgré un timeout de load-state), ou 502 nav_error propre.
//
// Tests purs (aucun navigateur requis) : node --test.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyNavOutcome,
  authHint,
  cleanNavError,
  estPageErreur,
  finalUrl,
  tlsWarning,
} from "../nav_util.js";

test("goto réussi → 200 success, pas de warning", () => {
  const o = classifyNavOutcome("http://192.1.1.1:8080", "about:blank", "http://192.1.1.1:8080/", null);
  assert.equal(o.httpStatus, 200);
  assert.equal(o.body.status, "success");
  assert.equal(o.body.url, "http://192.1.1.1:8080/");
  assert.equal(o.body.nav_warning, undefined);
});

test("IP:port joignable mais lente (goto lève mais la page a chargé) → 200 succès partiel", () => {
  // Cas réel du bug : domcontentloaded ne se déclenche pas → goto timeout,
  // mais on a bien atterri sur la cible. Doit RÉUSSIR, pas 500.
  const o = classifyNavOutcome(
    "http://192.1.1.1:8080",
    "about:blank",
    "http://192.1.1.1:8080/",
    "Timeout 60000ms exceeded",
  );
  assert.equal(o.httpStatus, 200);
  assert.equal(o.body.status, "success");
  assert.equal(o.body.url, "http://192.1.1.1:8080/");
  assert.equal(o.body.nav_warning, "Timeout 60000ms exceeded");
});

test("IP:port injoignable sur page neuve (reste about:blank) → 502 nav_error", () => {
  const o = classifyNavOutcome(
    "http://192.1.1.1:8080",
    "about:blank",
    "about:blank",
    "net::ERR_CONNECTION_REFUSED",
  );
  assert.equal(o.httpStatus, 502);
  assert.equal(o.body.status, "nav_error");
  assert.match(o.body.error, /192\.1\.1\.1:8080/);
  assert.match(o.body.error, /ERR_CONNECTION_REFUSED/);
});

test("goto refusé qui ne quitte pas la page courante → 502 (pas un faux succès)", () => {
  // Chromium ne commit pas la nav échouée → page.url() reste sur la page
  // précédente. Rester sur place == échec, surtout PAS un succès.
  const o = classifyNavOutcome(
    "http://192.1.1.1:8080",
    "https://exemple.fr/page",
    "https://exemple.fr/page",
    "net::ERR_ADDRESS_UNREACHABLE",
  );
  assert.equal(o.httpStatus, 502);
  assert.equal(o.body.status, "nav_error");
  assert.equal(o.body.url, "https://exemple.fr/page");
});

test("redirection : goto lève mais on a bougé vers une autre URL → 200 succès partiel", () => {
  const o = classifyNavOutcome(
    "http://192.1.1.1:8080",
    "about:blank",
    "http://192.1.1.1:8080/login",
    "Timeout 60000ms exceeded",
  );
  assert.equal(o.httpStatus, 200);
  assert.equal(o.body.status, "success");
  assert.equal(o.body.url, "http://192.1.1.1:8080/login");
});

test("landed vide/undefined avec erreur → 502 nav_error (url null)", () => {
  const o = classifyNavOutcome("http://192.1.1.1:8080", "about:blank", "", "net::ERR_NAME_NOT_RESOLVED");
  assert.equal(o.httpStatus, 502);
  assert.equal(o.body.status, "nav_error");
  assert.equal(o.body.url, null);
});

test("le message nav_error inclut TOUJOURS l'URL cible et la cause", () => {
  const o = classifyNavOutcome(
    "http://10.0.0.5:9000/api",
    "about:blank",
    "about:blank",
    "net::ERR_CONNECTION_TIMED_OUT",
  );
  assert.match(o.body.error, /http:\/\/10\.0\.0\.5:9000\/api/);
  assert.match(o.body.error, /ERR_CONNECTION_TIMED_OUT/);
});

// ── authHint : guidage du modèle sur les pages protégées par auth HTTP ──
// (aucun outil n'accepte d'identifiant : le secret http-auth attaché s'applique à l'ouverture de la session)
test("401 → hint vers pw_session(start) et /secret attach, jamais un identifiant passé à un outil", () => {
  const h = authHint(401);
  assert.ok(h, "un hint doit être renvoyé pour 401");
  assert.match(h, /401/);
  assert.match(h, /pw_session\(action='start'/);
  assert.match(h, /\/secret attach <name>/);
  assert.doesNotMatch(h, /username=|password=/);
});

test("407 → hint proxy", () => {
  const h = authHint(407);
  assert.ok(h);
  assert.match(h, /407|[Pp]roxy/);
});

test("200/404/null → pas de hint d'auth", () => {
  assert.equal(authHint(200), null);
  assert.equal(authHint(404), null);
  assert.equal(authHint(null), null);
  assert.equal(authHint(undefined), null);
});

// ── Navigation en échec : code stable, cause sans séquences ANSI ni journal d'appel ──
const ERREUR_PLAYWRIGHT =
  "page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://x.invalid/\n" +
  'Call log:\n\u001b[2m  - navigating to "https://x.invalid/", waiting until "domcontentloaded"\u001b[22m\n';

test("cleanNavError : première ligne, sans préfixe page.goto ni séquences ANSI", () => {
  assert.equal(cleanNavError(ERREUR_PLAYWRIGHT), "net::ERR_TUNNEL_CONNECTION_FAILED at https://x.invalid/");
  assert.equal(cleanNavError("\u001b[31mTimeout 60000ms exceeded.\u001b[39m"), "Timeout 60000ms exceeded.");
  assert.equal(cleanNavError(undefined), "");
});

test("échec réel : code navigation_failed, message anglais nettoyé, correctif", () => {
  const o = classifyNavOutcome(
    "https://x.invalid/",
    "https://exemple.fr/",
    "https://exemple.fr/",
    ERREUR_PLAYWRIGHT,
  );
  assert.equal(o.httpStatus, 502);
  assert.equal(o.body.code, "navigation_failed");
  assert.equal(
    o.body.error,
    "Navigation to https://x.invalid/ failed: net::ERR_TUNNEL_CONNECTION_FAILED at https://x.invalid/",
  );
  assert.match(o.body.fix, /^The tab still shows the page it showed before \(https:\/\/exemple\.fr\/\)/);
  assert.ok(!/\u001b|Call log/.test(JSON.stringify(o.body)));
});

test("échec avec la page d'erreur du navigateur engagée : jamais un succès partiel, l'onglet décrit tel qu'il est", () => {
  const erreur = "chrome-error://chromewebdata/";
  const o = classifyNavOutcome("https://x.invalid/", "http://lan/form", erreur, ERREUR_PLAYWRIGHT);
  assert.equal(o.httpStatus, 502);
  assert.equal(o.body.url, erreur);
  assert.match(
    o.body.fix,
    /^The tab now shows the browser error page \(chrome-error:\/\/chromewebdata\/\), no longer http:\/\/lan\/form: go back to it with pw_act\(action='back'\)/,
  );
  const neuf = classifyNavOutcome("https://x.invalid/", "about:blank", erreur, ERREUR_PLAYWRIGHT);
  assert.equal(neuf.httpStatus, 502);
  assert.doesNotMatch(neuf.body.fix, /back/);
  const revenu = classifyNavOutcome(
    "https://x.invalid/",
    "http://lan/form",
    "http://lan/form",
    ERREUR_PLAYWRIGHT,
    { restored: true },
  );
  assert.match(
    revenu.body.fix,
    /^The tab went back to the page it showed before \(http:\/\/lan\/form\), reloaded/,
  );
  for (const r of [o, neuf, revenu]) assert.doesNotMatch(r.body.fix, /intact/);
  assert.ok(
    estPageErreur(erreur) && !estPageErreur("about:blank") && !estPageErreur("http://lan/"),
  );
});

test("succès partiel : nav_warning nettoyé", () => {
  const o = classifyNavOutcome(
    "http://a/",
    "about:blank",
    "http://a/",
    "page.goto: Timeout 60000ms exceeded.\nCall log:\n\u001b[2m- x\u001b[22m",
  );
  assert.equal(o.body.nav_warning, "Timeout 60000ms exceeded.");
});

test("finalUrl : adresse finale seulement après une redirection (adresse demandée normalisée)", () => {
  assert.equal(finalUrl("http://a.fr", "http://a.fr/"), null);
  assert.equal(finalUrl("http://a.fr/x", "http://a.fr/x"), null);
  assert.equal(finalUrl("http://a.fr/redirige", "http://a.fr/cible"), "http://a.fr/cible");
  assert.equal(finalUrl("http://a.fr/", ""), null);
});

test("tlsWarning : expiré, pas encore valide, auto-signé ; rien pour un certificat valide ou absent", () => {
  const maintenant = Date.UTC(2026, 0, 1) / 1000;
  const expire = {
    issuer: "ca",
    subjectName: "site",
    validFrom: Date.UTC(2020, 0, 1) / 1000,
    validTo: Date.UTC(2021, 0, 1) / 1000,
    protocol: "TLS 1.3",
  };
  assert.deepEqual(tlsWarning(expire, maintenant), {
    problems: ["expired"],
    message:
      "certificate expired on 2021-01-01T00:00:00.000Z - the page was loaded anyway (certificate errors are not blocking).",
    issuer: "ca",
    subject: "site",
    valid_from: "2020-01-01T00:00:00.000Z",
    valid_to: "2021-01-01T00:00:00.000Z",
    protocol: "TLS 1.3",
  });
  assert.deepEqual(
    tlsWarning(
      { ...expire, validFrom: maintenant + 10, validTo: maintenant + 99, issuer: "site" },
      maintenant,
    ).problems,
    ["not_yet_valid", "self_signed"],
  );
  assert.equal(tlsWarning({ ...expire, validTo: maintenant + 3600 }, maintenant), null);
  assert.equal(tlsWarning(null), null);
});
