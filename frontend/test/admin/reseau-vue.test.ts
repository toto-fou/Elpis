// SPDX-License-Identifier: MIT
/** frontend/test/admin/reseau-vue.test.ts — console › Sandbox › Réseau : verdicts des destinations tirés des règles posées (évaluateur de la chaîne OUTPUT, cas connus), textes et causes, repères « à protéger », états du serveur, forme enregistrée des adresses, sandbox durcie et règles posées selon le profil édité. */
import { describe, expect, it } from "vitest";

import {
  destinationsVues,
  domainesSansAdresse,
  hotesEpingles,
  ipv4Canonique,
  jugerAdresse,
  profilDurci,
  reglesPosees,
  resolveursConteneur,
  sourceVue,
  texteRegles,
} from "../../src/features/admin/reseau-vue";
import type { ContexteVue, ProfilVu } from "../../src/features/admin/reseau-vue";

const CTX: ContexteVue = {
  sudo: true,
  machine: { addresses: ["192.0.2.10", "198.51.100.7"], broadcasts: ["192.0.2.255"] },
  domaines: {
    "api.example.com": ["192.0.2.20", "192.0.2.21"],
    "absent.example.net": [],
    "lent.example.net": null,
    "meta.example.com": ["169.254.169.254"],
  },
  etat: "charge",
};
/** Machine dont les adresses sont dans des plages locales (pont Docker, réseau privé). */
const PRIVEE: ContexteVue = { ...CTX, machine: { addresses: ["10.0.0.5", "172.17.0.1"], broadcasts: [] } };
const resume = (p: ProfilVu, ctx = CTX): string[] =>
  destinationsVues(p, ctx).map(
    (l) => `${l.nom} | ${l.verdict} | ${l.ports} | ${l.detail}${l.risque ? " | !" : ""}`,
  );
/** Ligne d'une destination nommée. */
const ligne = (p: ProfilVu, nom: string, ctx = CTX): string | undefined =>
  resume(p, ctx).find((l) => l.startsWith(`${nom} | `));
const liste = (champs: Partial<ProfilVu>): ProfilVu => ({ id: "liste", mode: "allowlist_ip", ...champs });
const ouvert = (champs: Partial<ProfilVu> = {}): ProfilVu => ({ id: "ouvert", mode: "bridge", ...champs });
const SANDBOXES =
  "Autres sandboxes | refus |  | trafic entre sandboxes coupé par le réseau elpis-sandbox, quelles que soient les règles";

describe("évaluateur : verdict d'une adresse d'après les règles posées", () => {
  it("profil ouvert, « Réseau local » seul : lien local et 100.100.100.200 refusés, 168.63.129.16 et internet joignables", () => {
    const p = ouvert({ block_lan: true });
    expect(jugerAdresse(p, CTX, "169.254.169.254")).toEqual({ verdict: "refus", passe: "" });
    expect(jugerAdresse(p, CTX, "100.100.100.200")).toEqual({ verdict: "refus", passe: "" });
    expect(jugerAdresse(p, CTX, "168.63.129.16")).toEqual({ verdict: "ok", passe: "tous" });
    expect(jugerAdresse(p, CTX, "203.0.113.9")).toEqual({ verdict: "ok", passe: "tous" });
    expect(jugerAdresse(p, PRIVEE, "172.17.0.1")).toEqual({ verdict: "refus", passe: "" });
  });

  it("liste blanche : adresse listée, réseau qui la couvre, ports et résolveurs ; reste refusé", () => {
    const p = liste({
      ips: ["10.0.0.0/8", "0.0.0.0/0"],
      dns: ["10.0.0.53"],
      ports: [443],
      _portsMode: "list",
    });
    expect(jugerAdresse(p, CTX, "10.1.2.3")).toEqual({ verdict: "partiel", passe: "TCP 443" });
    expect(jugerAdresse(p, CTX, "10.0.0.53")).toEqual({ verdict: "partiel", passe: "UDP 53, TCP 53, 443" });
    expect(jugerAdresse(liste({ ips: ["10.0.0.0/8"] }), CTX, "10.1.2.3")).toEqual({
      verdict: "ok",
      passe: "tous",
    });
    expect(jugerAdresse(liste({ ips: ["10.0.0.0/8"] }), CTX, "172.17.0.1")).toEqual({
      verdict: "refus",
      passe: "",
    });
  });

  it("sans interface : tout refusé ; profil ouvert sans protection : tout joignable", () => {
    expect(jugerAdresse({ id: "i", mode: "none" }, CTX, "203.0.113.9").verdict).toBe("refus");
    expect(jugerAdresse(ouvert(), CTX, "169.254.169.254").verdict).toBe("ok");
  });
});

describe("destinations vues d'une sandbox", () => {
  it("profil isolé : rien ne sort, seuls les relais de l'hôte répondent", () => {
    expect(resume({ id: "isolated", mode: "none" })).toEqual([
      "Toutes destinations | refus |  | aucune interface réseau (--network none)",
      "Autres sandboxes | refus |  | trafic entre sandboxes coupé",
      "Dépôts Git | relais |  | par le relais Git de l'hôte : tous les dépôts",
      "Navigateur | relais |  | par le relais du navigateur : sites de la sandbox (localhost) seulement",
    ]);
  });

  it("liste blanche : entrées sur leurs ports, domaine épinglé, sans réponse ou introuvable ; un réseau listé ouvre en partie le réseau local", () => {
    const p = liste({
      ips: ["10.20.30.40/16", "192.0.2.77/32"],
      domains: ["api.example.com", "absent.example.net", "lent.example.net"],
      ports: [443, 80],
      _portsMode: "list",
      git_access: "servers",
      git_servers: ["git.example.lan", "github.com/acme"],
    });
    expect(resume(p)).toEqual([
      "10.20.0.0/16 | ok | TCP 443, 80 | réseau autorisé",
      "192.0.2.77 | ok | TCP 443, 80 | adresse autorisée",
      "api.example.com | ok | TCP 443, 80 | 192.0.2.20 épinglée, 192.0.2.21 autorisée aussi",
      "absent.example.net | inactif |  | nom introuvable : une sandbox créée maintenant ne le joindrait pas",
      "lent.example.net | inactif |  | pas de réponse DNS en 3 s : la création attend plus longtemps et peut l'épingler",
      "Autres noms | refus |  | aucun résolveur : seuls les domaines listés ont une adresse",
      "Reste d'internet | refus |  | tout ce qui n'est pas listé",
      "Réseau local | partiel |  | autorisé par la liste : 10.20.0.0/16 (TCP 443, 80) ; le reste hors liste | !",
      "Machine hôte | refus |  | hors liste",
      "Métadonnées du cloud | refus |  | hors liste",
      SANDBOXES,
      "Dépôts Git | relais |  | par le relais Git de l'hôte : git.example.lan, github.com/acme",
      "Navigateur | relais |  | par le relais du navigateur : mêmes destinations que la liste",
    ]);
    expect(domainesSansAdresse(p, CTX)).toEqual(["absent.example.net", "lent.example.net"]);
  });

  it("liste blanche : résolveur sur UDP et TCP 53, « Tous » malgré une liste en mémoire, domaine pas encore relevé selon l'état du serveur", () => {
    const p = liste({
      domains: ["nouveau.example.org"],
      dns: ["198.51.100.53"],
      ports: [22],
      _portsMode: "all",
      git_access: "accounts",
    });
    expect(resume(p).slice(0, 2)).toEqual([
      "nouveau.example.org | ok | tous | adresses relevées à l'enregistrement du profil",
      "198.51.100.53 | ok | UDP 53, TCP 53 | résolveur DNS",
    ]);
    expect(resume(p, { ...CTX, etat: "attente" })[0]).toBe(
      "nouveau.example.org | ok | tous | résolution en cours",
    );
    expect(resume(p, { ...CTX, etat: "echec" })[0]).toBe(
      "nouveau.example.org | ok | tous | résolution indisponible : adresses relevées à la création",
    );
    expect(ligne(p, "Dépôts Git")).toBe(
      "Dépôts Git | relais |  | par le relais Git de l'hôte : dépôts des comptes Git de chaque utilisateur",
    );
  });

  it("liste blanche : ce que la liste ouvre dans chaque catégorie sensible, avec sa cause et le repère", () => {
    expect(ligne(liste({ ips: ["10.0.0.0/8"] }), "Réseau local")).toBe(
      "Réseau local | partiel |  | autorisé par la liste : 10.0.0.0/8 ; le reste hors liste | !",
    );
    expect(ligne(liste({ ips: ["192.0.2.10"] }), "Machine hôte")).toBe(
      "Machine hôte | partiel |  | autorisée par la liste : 192.0.2.10 ; le reste hors liste | !",
    );
    expect(ligne(liste({ ips: ["192.0.2.0/24"], ports: [22] }), "Machine hôte")).toBe(
      "Machine hôte | partiel |  | autorisée par la liste : 192.0.2.0/24 (TCP 22) ; le reste hors liste | !",
    );
    expect(ligne(liste({ domains: ["meta.example.com"] }), "Métadonnées du cloud")).toBe(
      "Métadonnées du cloud | partiel |  | autorisées par le domaine meta.example.com : 169.254.169.254 ; le reste hors liste | !",
    );
    expect(ligne(liste({ dns: ["10.0.0.53"] }), "Réseau local")).toBe(
      "Réseau local | partiel |  | résolveur DNS : 10.0.0.53 (UDP 53, TCP 53) ; le reste hors liste | !",
    );
  });

  it("liste blanche ouverte à 0.0.0.0/0 : tout autorisé par la liste ; sur un port, le reste des ports refusé", () => {
    const tout = liste({ ips: ["0.0.0.0/0"] });
    expect(
      resume(tout).filter(
        (l) => !l.startsWith("Autres") && !l.startsWith("Dépôts") && !l.startsWith("Navigateur"),
      ),
    ).toEqual([
      "0.0.0.0/0 | ok | tous | réseau autorisé",
      "Reste d'internet | ok | tous | autorisé par la liste : 0.0.0.0/0",
      "Réseau local | ok | tous | autorisé par la liste : 0.0.0.0/0 | !",
      "Machine hôte | ok | tous | autorisée par la liste : 0.0.0.0/0 | !",
      "Métadonnées du cloud | ok | tous | autorisées par la liste : 0.0.0.0/0 | !",
    ]);
    const https = liste({ ips: ["0.0.0.0/0"], ports: [443] });
    expect(ligne(https, "Reste d'internet")).toBe(
      "Reste d'internet | partiel |  | autorisé par la liste : 0.0.0.0/0 (TCP 443) ; autres ports et protocoles refusés",
    );
    expect(ligne(https, "Réseau local")).toBe(
      "Réseau local | partiel |  | autorisé par la liste : 0.0.0.0/0 (TCP 443) ; autres ports et protocoles refusés | !",
    );
  });

  it("profil ouvert sans protection : tout est joignable, chaque accès sensible est à protéger ; Git sans serveur listé : refusé", () => {
    expect(resume(ouvert({ git_access: "servers", git_servers: [] }))).toEqual([
      "Internet | ok | tous | destinations publiques",
      "Métadonnées du cloud | ok | tous | joignables : jetons de la machine exposés | !",
      "Réseau local | ok | tous | joignable | !",
      "Machine hôte | ok | tous | ports de l'hôte joignables | !",
      SANDBOXES,
      "Dépôts Git | refus |  | par le relais Git de l'hôte : aucun serveur listé, tout refusé",
      "Navigateur | relais |  | par le relais du navigateur : internet et réseau local (liste du navigateur)",
    ]);
  });

  it("profil ouvert, « Réseau local » seul : métadonnées en partie joignables, machine refusée si ses adresses sont locales", () => {
    const p = ouvert({ block_lan: true });
    expect(resume(p).slice(0, 4)).toEqual([
      "Internet | ok | tous | destinations publiques",
      "Métadonnées du cloud | partiel |  | joignables : 168.63.129.16 ; refusées par Réseau local : 169.254.0.0/16, 100.100.100.200 | !",
      "Réseau local | refus |  | refusé par Réseau local",
      "Machine hôte | ok | tous | ports de l'hôte joignables | !",
    ]);
    expect(ligne(p, "Machine hôte", PRIVEE)).toBe(
      "Machine hôte | refus |  | 2 adresses de la machine, refusées par Réseau local",
    );
    const mixte: ContexteVue = {
      ...CTX,
      machine: { addresses: ["172.17.0.1", "203.0.113.5"], broadcasts: [] },
    };
    expect(ligne(p, "Machine hôte", mixte)).toBe(
      "Machine hôte | partiel |  | joignable : 203.0.113.5 ; refusée par Réseau local : 172.17.0.1 | !",
    );
  });

  it("profil ouvert protégé : refus de ce qui est coché avec sa cause, exceptions du réseau local, relais du navigateur sans IPv6", () => {
    const p = ouvert({ block_metadata: true, block_host: true });
    expect(resume(p).slice(1, 4)).toEqual([
      "Métadonnées du cloud | refus |  | refusées par Métadonnées du cloud",
      "Réseau local | partiel |  | joignable, sauf 100.100.100.200, 169.254.0.0/16 (refus par Métadonnées du cloud), 224.0.0.0/4, 255.255.255.255 (refus par Machine hôte) | !",
      "Machine hôte | refus |  | 2 adresses de la machine, refusées par Machine hôte, diffusion et multidiffusion aussi",
    ]);
    expect(resume(p).at(-1)).toBe(
      "Navigateur | relais |  | par le relais du navigateur : protections du profil appliquées, sans IPv6",
    );
    expect(resume(ouvert({ block_metadata: true, block_lan: true, block_host: true })).slice(1, 4)).toEqual([
      "Métadonnées du cloud | refus |  | refusées par Métadonnées du cloud",
      "Réseau local | refus |  | refusé par Réseau local",
      "Machine hôte | refus |  | 2 adresses de la machine, refusées par Machine hôte, diffusion et multidiffusion aussi",
    ]);
  });

  it("relevé de la machine : en lecture, indisponible, vide ; sans la protection « hôte », la règle finale avec le relevé manquant", () => {
    const p = ouvert({ block_metadata: true, block_host: true });
    expect(ligne(p, "Machine hôte", { ...CTX, machine: null, etat: "attente" })).toBe(
      "Machine hôte | refus |  | adresses de la machine en cours de lecture",
    );
    expect(ligne(p, "Machine hôte", { ...CTX, machine: null, etat: "echec" })).toBe(
      "Machine hôte | refus |  | relevé de la machine indisponible",
    );
    expect(ligne(p, "Machine hôte", { ...CTX, machine: null })).toBe(
      "Machine hôte | refus |  | relevé de la machine indisponible",
    );
    expect(ligne(p, "Machine hôte", { ...CTX, machine: { addresses: [], broadcasts: [] } })).toBe(
      "Machine hôte | refus |  | aucune adresse de la machine relevée : la sandbox ne démarrerait pas",
    );
    expect(ligne(p, "Réseau local", { ...CTX, machine: null })).toContain(
      "224.0.0.0/4, 255.255.255.255 (refus par Machine hôte)",
    );
    expect(ligne(ouvert({ block_lan: true }), "Machine hôte", { ...CTX, machine: null })).toBe(
      "Machine hôte | ok | tous | ports de l'hôte joignables (relevé de la machine indisponible) | !",
    );
    expect(ligne(liste({ ips: ["10.0.0.0/8"] }), "Machine hôte", { ...CTX, machine: null })).toBe(
      "Machine hôte | refus |  | hors liste, sauf adresse listée qui la couvre (relevé de la machine indisponible)",
    );
  });
});

describe("forme enregistrée, sandbox durcie, boîte de la sandbox", () => {
  it.each([
    ["10.0.0.5", "10.0.0.5"],
    ["10.0.0.5/32", "10.0.0.5"],
    ["10.0.0.7/24", "10.0.0.0/24"],
    ["203.0.113.200/25", "203.0.113.128/25"],
    ["0.0.0.0/0", "0.0.0.0/0"],
    ["255.255.255.255/31", "255.255.255.254/31"],
    [" 192.0.2.1/08 ", "192.0.0.0/8"],
  ])("%j → %j", (saisie, attendu) => {
    expect(ipv4Canonique(saisie)).toBe(attendu);
  });

  it.each(["10.0.0.256", "010.0.0.1", "10.0.0.0/33", "10.0.0.0/", "fe80::1", "a/b/c", "10.0.0.0/8/9"])(
    "%j : illisible",
    (saisie) => {
      expect(ipv4Canonique(saisie)).toBeNull();
    },
  );

  it("sans sudo : sudo refusé partout, liste blanche, ou profil ouvert protégé", () => {
    expect(profilDurci({ id: "i", mode: "none" }, true)).toBe(false);
    expect(profilDurci({ id: "i", mode: "none" }, false)).toBe(true);
    expect(profilDurci({ id: "o", mode: "bridge" }, true)).toBe(false);
    expect(profilDurci({ id: "o", mode: "bridge", block_lan: true }, true)).toBe(true);
    expect(profilDurci({ id: "l", mode: "allowlist_ip", block_lan: false }, true)).toBe(true);
    expect(profilDurci({ id: "l", mode: "allowlist_ip", block_host: true, ips: [] }, true)).toBe(true);
    expect(profilDurci({ id: "n", mode: "none", block_host: true }, true)).toBe(false);
  });

  it("boîte de la sandbox : sudo et réseau", () => {
    expect(sourceVue({ id: "i", mode: "none" }, CTX)).toEqual({
      sudo: "sudo permis",
      reseau: "sans interface réseau",
    });
    expect(sourceVue({ id: "l", mode: "allowlist_ip" }, CTX)).toEqual({
      sudo: "sans sudo · lecture seule",
      reseau: "réseau elpis-sandbox",
    });
  });
});

describe("règles posées", () => {
  it("sans interface, sans filtre, machine inconnue", () => {
    expect(reglesPosees({ id: "i", mode: "none" }, CTX)).toEqual({ genre: "sans-reseau" });
    expect(reglesPosees(ouvert(), CTX)).toEqual({ genre: "sans-filtre" });
    expect(reglesPosees(ouvert({ block_host: true }), { ...CTX, machine: null })).toEqual({
      genre: "machine-inconnue",
    });
  });

  it("profil ouvert protégé : plages refusées triées, puis tout le reste accepté ; texte avec les appels d'ip6tables", () => {
    const r = reglesPosees(ouvert({ block_metadata: true, block_host: true }), CTX);
    expect(r.genre).toBe("regles");
    if (r.genre !== "regles") return;
    const refus = (n: string): string => `-A OUTPUT -d ${n} -j REJECT --reject-with icmp-host-unreachable`;
    expect(r.ipv4.slice(6)).toEqual([
      refus("100.100.100.200/32"),
      refus("168.63.129.16/32"),
      refus("169.254.0.0/16"),
      refus("192.0.2.10/32"),
      refus("192.0.2.255/32"),
      refus("198.51.100.7/32"),
      refus("224.0.0.0/4"),
      refus("255.255.255.255/32"),
      "-A OUTPUT -j ACCEPT",
      "COMMIT",
    ]);
    const texte = texteRegles(r);
    expect(texte.startsWith("*filter\n:INPUT ACCEPT [0:0]\n")).toBe(true);
    expect(texte.split("\n").slice(-5)).toEqual([
      "# IPv6 : tout refusé",
      "ip6tables -P OUTPUT DROP",
      "ip6tables -A OUTPUT -o lo -j ACCEPT",
      "ip6tables -A OUTPUT -m state --state RELATED,ESTABLISHED -j ACCEPT",
      "ip6tables -A OUTPUT -j REJECT --reject-with icmp6-adm-prohibited",
    ]);
  });

  it("liste blanche : un domaine pas encore relevé est signalé, ses adresses n'apparaissent pas", () => {
    const r = reglesPosees(
      liste({ ips: ["203.0.113.10"], domains: ["nouveau.example.org"], _portsMode: "all" }),
      CTX,
    );
    expect(r.genre === "regles" && r.inconnus).toEqual(["nouveau.example.org"]);
    expect(r.genre === "regles" && r.ipv4.filter((l) => l.startsWith("-A OUTPUT -d "))).toEqual([
      "-A OUTPUT -d 203.0.113.10 -j ACCEPT",
    ]);
  });

  it("résolveurs du conteneur (--dns) et noms épinglés (--add-host) : première adresse de chaque domaine relevé", () => {
    const p = liste({ domains: ["api.example.com", "absent.example.net", "lent.example.net"] });
    expect(resolveursConteneur(p)).toEqual(["192.0.2.1"]);
    expect(resolveursConteneur({ ...p, dns: ["198.51.100.53"] })).toEqual(["198.51.100.53"]);
    expect(hotesEpingles(p, CTX)).toEqual(["api.example.com:192.0.2.20"]);
    expect([resolveursConteneur(ouvert()), hotesEpingles(ouvert(), CTX)]).toEqual([[], []]);
  });
});
