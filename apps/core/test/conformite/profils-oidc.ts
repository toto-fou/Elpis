// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/profils-oidc.ts — profils de produits d'identité joués par le fournisseur factice : chemins, document de découverte, forme des jetons et réglages Elpis de chaque produit, avec les adresses publiques lues. */
import type { OidcFactice, OptionsFactice, Utilisateur } from "../identite/oidc-factice";

export type Verdict = "fonctionne" | "reglage" | "non";
export type Sourcage = "document public" | "documentation" | "non sourcé";

export interface ProfilProduit {
  readonly cle: string;
  readonly nom: string;
  readonly sources: readonly string[];
  readonly sourcage: Sourcage;
  readonly verdict: Verdict;
  readonly resume: string;
  readonly idp: OptionsFactice;
  /** Champs du document de découverte propres au produit (`undefined` : champ que le produit ne publie pas). */
  readonly decouverte: (idp: OidcFactice, surOrigine?: boolean) => Record<string, unknown>;
  readonly reglages: Record<string, unknown>;
  /** Personne du groupe requis (`groupes` : appartenances rendues par le produit). */
  readonly utilisateur: (nom: string, groupes?: readonly string[]) => Utilisateur;
  readonly groupeRequis: string;
  /** Vrai si le départ est refusé par la découverte (points d'accès hors de l'origine de l'émetteur). */
  readonly horsOrigine?: boolean;
  /** Corps rendu par UserInfo pour cette personne (défaut : le seul `sub`, comme un produit qui ne rend rien d'autre). */
  readonly userinfo?: (u: Utilisateur) => Record<string, unknown>;
  /** Code de refus attendu quand le document est ramené sur l'origine (défaut : la connexion réussit). */
  readonly apresOrigine?: string;
}

const uuid = (n: string): string => {
  const h = Buffer.from(`uuid-${n}`).toString("hex").padEnd(32, "0").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const hex64 = (n: string): string => Buffer.from(`hash-${n}`).toString("hex").padEnd(64, "0").slice(0, 64);

const NOMS = (nom: string): Record<string, unknown> => ({
  preferred_username: nom,
  name: `Nom de ${nom}`,
  email: `${nom}@exemple.lan`,
  email_verified: true,
});

const BASE_SECRET = "secret-client-de-test";
const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const CLIENT_GUID = "6731de76-14a6-49ae-97bc-6eba6914391e";
const GROUPE_ENTRA = "b5a2c9a4-0e0a-4b0e-8d57-6f1f4a0f0c11";

export const PROFILS: readonly ProfilProduit[] = [
  {
    cle: "keycloak",
    nom: "Keycloak",
    sources: [
      "https://www.keycloak.org/securing-apps/oidc-layers",
      "https://www.keycloak.org/docs/latest/securing_apps/index.html",
    ],
    sourcage: "documentation",
    verdict: "fonctionne",
    resume: "fonctionne ; groupes par le mappeur « Group Membership » (chemins) ou `realm_access.roles`",
    idp: {
      racine: "/realms/elpis",
      alg: "RS256",
      chemins: {
        auth: "/realms/elpis/protocol/openid-connect/auth",
        token: "/realms/elpis/protocol/openid-connect/token",
        certs: "/realms/elpis/protocol/openid-connect/certs",
        userinfo: "/realms/elpis/protocol/openid-connect/userinfo",
        logout: "/realms/elpis/protocol/openid-connect/logout",
        par: "/realms/elpis/protocol/openid-connect/ext/par/request",
      },
    },
    decouverte: () => ({
      backchannel_logout_session_supported: true,
      frontchannel_logout_supported: true,
      subject_types_supported: ["public", "pairwise"],
      grant_types_supported: [
        "authorization_code",
        "implicit",
        "refresh_token",
        "password",
        "client_credentials",
      ],
      response_types_supported: [
        "code",
        "none",
        "id_token",
        "token",
        "id_token token",
        "code id_token",
        "code token",
        "code id_token token",
      ],
      id_token_signing_alg_values_supported: [
        "PS384",
        "ES384",
        "RS384",
        "HS256",
        "HS512",
        "ES256",
        "RS256",
        "HS384",
        "ES512",
        "PS256",
        "PS512",
        "RS512",
      ],
      token_endpoint_auth_methods_supported: [
        "private_key_jwt",
        "client_secret_basic",
        "client_secret_post",
        "tls_client_auth",
        "client_secret_jwt",
      ],
      code_challenge_methods_supported: ["plain", "S256"],
    }),
    reglages: { groups_claim: "groups", client_auth: "basic" },
    groupeRequis: "/elpis",
    utilisateur: (nom, groupes = ["/elpis"]) => ({
      sub: uuid(nom),
      claims: {
        ...NOMS(nom),
        sid: uuid(`sid-${nom}`),
        azp: "elpis",
        acr: "1",
        typ: "ID",
        auth_time: Math.floor(Date.now() / 1000),
        groups: groupes,
        realm_access: { roles: ["offline_access", "default-roles-elpis"] },
        resource_access: { elpis: { roles: ["utilisateur"] }, account: { roles: ["view-profile"] } },
      },
    }),
  },
  {
    cle: "entra",
    nom: "Microsoft Entra ID (v2.0)",
    sources: [
      "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration",
      "https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference",
    ],
    sourcage: "document public",
    verdict: "reglage",
    resume:
      "fonctionne avec ce réglage : le point UserInfo (graph.microsoft.com) est hors de l'origine de l'émetteur donc ignoré, l'identifiant et les groupes (identifiants d'objet) doivent figurer dans le jeton d'identité",
    idp: {
      racine: `/${TENANT}/v2.0`,
      alg: "RS256",
      clientId: CLIENT_GUID,
      authClient: "post",
      chemins: {
        auth: `/${TENANT}/oauth2/v2.0/authorize`,
        token: `/${TENANT}/oauth2/v2.0/token`,
        certs: `/${TENANT}/discovery/v2.0/keys`,
        logout: `/${TENANT}/oauth2/v2.0/logout`,
      },
    },
    decouverte: (idp) => ({
      userinfo_endpoint: "https://graph.microsoft.com/oidc/userinfo",
      backchannel_logout_supported: undefined,
      frontchannel_logout_supported: true,
      http_logout_supported: true,
      subject_types_supported: ["pairwise"],
      response_types_supported: ["code", "id_token", "code id_token", "id_token token"],
      response_modes_supported: ["query", "fragment", "form_post"],
      token_endpoint_auth_methods_supported: [
        "client_secret_post",
        "private_key_jwt",
        "client_secret_basic",
        "self_signed_tls_client_auth",
      ],
      code_challenge_methods_supported: undefined,
      scopes_supported: ["openid", "profile", "email", "offline_access"],
      claims_supported: [
        "sub",
        "iss",
        "aud",
        "exp",
        "iat",
        "auth_time",
        "acr",
        "nonce",
        "preferred_username",
        "name",
        "tid",
        "ver",
        "at_hash",
        "c_hash",
        "email",
      ],
      tenant_region_scope: null,
      cloud_instance_name: "microsoftonline.com",
      msgraph_host: "graph.microsoft.com",
      mtls_endpoint_aliases: { token_endpoint: `${idp.origine}/mtls/token` },
    }),
    reglages: { groups_claim: "groups", client_auth: "post", username_claim: "preferred_username" },
    groupeRequis: GROUPE_ENTRA,
    utilisateur: (nom, groupes = [GROUPE_ENTRA]) => ({
      sub: Buffer.from(`pairwise-${nom}`).toString("base64url").padEnd(43, "A").slice(0, 43),
      claims: {
        preferred_username: `${nom}@contoso.onmicrosoft.com`,
        name: `Nom de ${nom}`,
        oid: uuid(nom),
        tid: TENANT,
        ver: "2.0",
        groups: groupes,
        sid: uuid(`sid-${nom}`),
      },
    }),
  },
  {
    cle: "adfs",
    nom: "AD FS (2016 / 2019)",
    sources: [
      "https://learn.microsoft.com/en-us/windows-server/identity/ad-fs/development/ad-fs-openid-connect-oauth-concepts",
    ],
    sourcage: "documentation",
    verdict: "reglage",
    resume:
      "fonctionne avec ce réglage : `groups_claim` = `group`, `username_claim` = `upn` ; une personne à un seul groupe est lue (revendication rendue en chaîne) quand cette chaîne est un groupe réglé",
    idp: {
      racine: "/adfs",
      alg: "RS256",
      chemins: {
        auth: "/adfs/oauth2/authorize/",
        token: "/adfs/oauth2/token/",
        certs: "/adfs/discovery/keys",
        userinfo: "/adfs/userinfo",
        logout: "/adfs/oauth2/logout",
      },
    },
    decouverte: () => ({
      backchannel_logout_supported: undefined,
      frontchannel_logout_supported: true,
      response_types_supported: [
        "code",
        "id_token",
        "code id_token",
        "id_token token",
        "code token",
        "code id_token token",
      ],
      token_endpoint_auth_methods_supported: [
        "client_secret_post",
        "client_secret_basic",
        "private_key_jwt",
        "windows_client_authentication",
      ],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [
        "openid",
        "profile",
        "email",
        "allatclaims",
        "aza",
        "logon_cert",
        "vpn_cert",
        "user_impersonation",
      ],
      subject_types_supported: ["pairwise"],
    }),
    reglages: { groups_claim: "group", username_claim: "upn", client_auth: "basic" },
    groupeRequis: "elpis",
    utilisateur: (nom, groupes = ["elpis", "Domain Users"]) => ({
      sub: Buffer.from(`adfs-${nom}`).toString("base64"),
      claims: {
        upn: `${nom}@corp.lan`,
        unique_name: `CORP\\${nom}`,
        group: groupes.length === 1 ? groupes[0] : groupes,
        email: `${nom}@corp.lan`,
        auth_time: Math.floor(Date.now() / 1000),
        appid: "elpis",
      },
    }),
  },
  {
    cle: "okta",
    nom: "Okta (serveur d'autorisation personnalisé)",
    sources: [
      "https://login.okta.com/.well-known/openid-configuration",
      "https://developer.okta.com/docs/api/openapi/okta-oauth/guides/overview/",
    ],
    sourcage: "document public",
    verdict: "fonctionne",
    resume: "fonctionne ; revendication `groups` à créer sur le serveur d'autorisation",
    idp: {
      racine: "/oauth2/default",
      alg: "RS256",
      chemins: {
        auth: "/oauth2/default/v1/authorize",
        token: "/oauth2/default/v1/token",
        certs: "/oauth2/default/v1/keys",
        userinfo: "/oauth2/default/v1/userinfo",
        logout: "/oauth2/default/v1/logout",
      },
    },
    decouverte: () => ({
      backchannel_logout_supported: undefined,
      response_modes_supported: ["query", "fragment", "form_post", "okta_post_message"],
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
        "client_secret_jwt",
        "private_key_jwt",
        "none",
      ],
      code_challenge_methods_supported: ["S256"],
      request_parameter_supported: true,
      claims_supported: [
        "iss",
        "ver",
        "sub",
        "aud",
        "iat",
        "exp",
        "jti",
        "auth_time",
        "amr",
        "idp",
        "nonce",
        "name",
        "preferred_username",
        "email",
        "email_verified",
        "groups",
      ],
    }),
    reglages: { groups_claim: "groups" },
    groupeRequis: "elpis",
    utilisateur: (nom, groupes = ["elpis", "Everyone"]) => ({
      sub: `00u${Buffer.from(nom).toString("hex").padEnd(17, "x").slice(0, 17)}`,
      claims: {
        ...NOMS(nom),
        ver: 1,
        jti: `ID.${nom}`,
        amr: ["pwd"],
        idp: "00oidp",
        groups: groupes,
        auth_time: Math.floor(Date.now() / 1000),
      },
    }),
  },
  {
    cle: "auth0",
    nom: "Auth0",
    sources: [
      "https://samples.auth0.com/.well-known/openid-configuration",
      "https://auth0.com/docs/secure/tokens/json-web-tokens/create-custom-claims",
    ],
    sourcage: "document public",
    verdict: "reglage",
    resume:
      "fonctionne avec ce réglage : émetteur saisi avec sa barre finale, groupes dans une revendication SANS espace de noms (les noms en adresse https:// ne sont pas acceptés par les réglages)",
    idp: {
      racine: "",
      barreFinale: true,
      alg: "RS256",
      chemins: {
        auth: "/authorize",
        token: "/oauth/token",
        certs: "/.well-known/jwks.json",
        userinfo: "/userinfo",
        logout: "/oidc/logout",
        par: "/oauth/par",
      },
    },
    decouverte: () => ({
      backchannel_logout_session_supported: true,
      id_token_signing_alg_values_supported: ["HS256", "RS256", "PS256"],
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
        "private_key_jwt",
        "none",
      ],
      code_challenge_methods_supported: ["S256", "plain"],
      request_uri_parameter_supported: false,
      subject_types_supported: ["public"],
    }),
    reglages: { groups_claim: "elpis_groups", username_claim: "nickname" },
    groupeRequis: "elpis",
    utilisateur: (nom, groupes = ["elpis"]) => ({
      sub: `auth0|${Buffer.from(nom).toString("hex").padEnd(24, "0").slice(0, 24)}`,
      claims: {
        ...NOMS(nom),
        nickname: nom,
        picture: "https://s.gravatar.com/avatar/x.png",
        updated_at: "2026-11-01T10:00:00.000Z",
        sid: `sid-${nom}`,
        elpis_groups: groupes,
      },
    }),
  },
  {
    cle: "google",
    nom: "Google",
    sources: ["https://accounts.google.com/.well-known/openid-configuration"],
    sourcage: "document public",
    verdict: "non",
    resume:
      "ne fonctionne pas : points de jetons, de clés et UserInfo sur d'autres hôtes (oauth2.googleapis.com, www.googleapis.com, openidconnect.googleapis.com) ; aucune revendication de groupes, or un groupe requis est obligatoire",
    horsOrigine: true,
    apresOrigine: "groups_unknown",
    idp: {
      racine: "",
      alg: "RS256",
      authClient: "post",
      issDansReponse: true,
      chemins: {
        auth: "/o/oauth2/v2/auth",
        token: "/token",
        certs: "/oauth2/v3/certs",
        userinfo: "/v1/userinfo",
      },
    },
    decouverte: (_idp, surOrigine = false) => ({
      device_authorization_endpoint: "https://oauth2.googleapis.com/device/code",
      ...(surOrigine
        ? {}
        : {
            token_endpoint: "https://oauth2.googleapis.com/token",
            userinfo_endpoint: "https://openidconnect.googleapis.com/v1/userinfo",
            jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
          }),
      end_session_endpoint: undefined,
      backchannel_logout_supported: undefined,
      revocation_endpoint: "https://oauth2.googleapis.com/revoke",
      response_types_supported: [
        "code",
        "token",
        "id_token",
        "code token",
        "code id_token",
        "token id_token",
        "code token id_token",
        "none",
      ],
      response_modes_supported: ["query", "fragment", "form_post"],
      subject_types_supported: ["public"],
      scopes_supported: ["openid", "email", "profile"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      claims_supported: [
        "aud",
        "email",
        "email_verified",
        "exp",
        "family_name",
        "given_name",
        "iat",
        "iss",
        "name",
        "picture",
        "sub",
      ],
      code_challenge_methods_supported: ["plain", "S256"],
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:device_code",
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      ],
      authorization_response_iss_parameter_supported: true,
    }),
    reglages: { client_auth: "post" },
    groupeRequis: "elpis",
    utilisateur: (nom) => ({
      sub: String(100000000000000000000n + BigInt(Buffer.from(nom).reduce((a, c) => a * 31 + c, 7))),
      claims: { ...NOMS(nom), preferred_username: undefined, azp: "elpis", hd: "exemple.lan", at_hash: "x" },
    }),
  },
  {
    cle: "authentik",
    nom: "Authentik",
    sources: ["https://docs.goauthentik.io/add-secure-apps/providers/oauth2/"],
    sourcage: "documentation",
    verdict: "reglage",
    resume:
      "fonctionne avec ce réglage : une clé de signature (RS256 ou ES256) affectée au fournisseur Authentik, sinon jetons HS256 refusés ; émetteur avec barre finale",
    idp: {
      racine: "/application/o/elpis",
      barreFinale: true,
      alg: "RS256",
      chemins: {
        auth: "/application/o/authorize/",
        token: "/application/o/token/",
        certs: "/application/o/elpis/jwks/",
        userinfo: "/application/o/userinfo/",
        logout: "/application/o/elpis/end-session/",
      },
    },
    decouverte: () => ({
      backchannel_logout_supported: true,
      backchannel_logout_session_supported: true,
      frontchannel_logout_supported: true,
      subject_types_supported: ["public"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      code_challenge_methods_supported: ["plain", "S256"],
      response_types_supported: [
        "code",
        "id_token",
        "id_token token",
        "code token",
        "code id_token",
        "code id_token token",
      ],
    }),
    reglages: { groups_claim: "groups" },
    groupeRequis: "elpis",
    utilisateur: (nom, groupes = ["elpis", "authentik Admins"]) => ({
      sub: hex64(nom),
      claims: {
        ...NOMS(nom),
        nickname: nom,
        groups: groupes,
        sid: hex64(`sid-${nom}`),
        auth_time: Math.floor(Date.now() / 1000),
      },
    }),
  },
  {
    cle: "lemonldap",
    nom: "LemonLDAP::NG",
    sources: ["https://lemonldap-ng.org/documentation/latest/openidconnectservice.html"],
    sourcage: "documentation",
    verdict: "reglage",
    resume:
      "fonctionne avec ce réglage : jeton signé RS256 ou ES256 (clé asymétrique) et groupes rendus en tableau de chaînes ; chemins des points d'accès non sourcés",
    idp: {
      racine: "",
      alg: "RS256",
      chemins: {
        auth: "/oauth2/authorize",
        token: "/oauth2/token",
        certs: "/oauth2/jwks",
        userinfo: "/oauth2/userinfo",
        logout: "/oauth2/logout",
      },
    },
    decouverte: () => ({
      backchannel_logout_supported: true,
      frontchannel_logout_supported: true,
      subject_types_supported: ["public"],
      token_endpoint_auth_methods_supported: [
        "client_secret_post",
        "client_secret_basic",
        "private_key_jwt",
        "client_secret_jwt",
      ],
      code_challenge_methods_supported: ["plain", "S256"],
    }),
    reglages: { groups_claim: "groups" },
    groupeRequis: "elpis",
    utilisateur: (nom, groupes = ["elpis", "users"]) => ({
      sub: nom,
      claims: { ...NOMS(nom), groups: groupes, sid: `llng-${nom}`, auth_time: Math.floor(Date.now() / 1000) },
    }),
  },
  {
    cle: "gitlab",
    nom: "GitLab",
    sources: ["https://gitlab.com/.well-known/openid-configuration"],
    sourcage: "document public",
    verdict: "fonctionne",
    resume: "fonctionne ; `groups` rend les chemins complets des groupes",
    idp: {
      racine: "",
      alg: "RS256",
      chemins: {
        auth: "/oauth/authorize",
        token: "/oauth/token",
        certs: "/oauth/discovery/keys",
        userinfo: "/oauth/userinfo",
      },
    },
    decouverte: () => ({
      end_session_endpoint: undefined,
      backchannel_logout_supported: undefined,
      revocation_endpoint: "https://gitlab.example/oauth/revoke",
      response_modes_supported: ["query", "fragment", "form_post"],
      grant_types_supported: ["authorization_code", "client_credentials", "device_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      subject_types_supported: ["public"],
      claim_types_supported: ["normal"],
      code_challenge_methods_supported: ["plain", "S256"],
      claims_supported: [
        "iss",
        "sub",
        "aud",
        "exp",
        "iat",
        "sub_legacy",
        "name",
        "nickname",
        "preferred_username",
        "email",
        "email_verified",
        "groups",
        "groups_direct",
        "https://gitlab.org/claims/groups/owner",
      ],
    }),
    reglages: { groups_claim: "groups" },
    groupeRequis: "elpis",
    utilisateur: (nom, groupes = ["elpis", "elpis/equipe"]) => ({
      sub: String(1000 + nom.length),
      claims: {
        ...NOMS(nom),
        nickname: nom,
        sub_legacy: hex64(nom),
        groups_direct: groupes,
        groups: groupes,
        auth_time: Math.floor(Date.now() / 1000),
      },
    }),
  },
  {
    cle: "dex",
    nom: "Dex",
    sources: ["https://dexidp.io/docs/configuration/tokens/", "https://dexidp.io/docs/connectors/oidc/"],
    sourcage: "documentation",
    verdict: "reglage",
    resume:
      "fonctionne avec ce réglage : portée `groups` ajoutée aux portées demandées ; pas de déconnexion annoncée",
    idp: {
      racine: "/dex",
      alg: "RS256",
      chemins: { auth: "/dex/auth", token: "/dex/token", certs: "/dex/keys", userinfo: "/dex/userinfo" },
    },
    decouverte: () => ({
      end_session_endpoint: undefined,
      backchannel_logout_supported: undefined,
      response_types_supported: ["code", "id_token", "token"],
      subject_types_supported: ["public"],
      scopes_supported: ["openid", "email", "groups", "profile", "offline_access"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      code_challenge_methods_supported: ["S256", "plain"],
      claims_supported: [
        "iss",
        "sub",
        "aud",
        "iat",
        "exp",
        "email",
        "email_verified",
        "locale",
        "name",
        "preferred_username",
        "at_hash",
      ],
    }),
    reglages: { groups_claim: "groups", scopes: ["openid", "profile", "email", "groups"] },
    groupeRequis: "elpis",
    utilisateur: (nom, groupes = ["elpis"]) => ({
      sub: Buffer.from(`\n${String.fromCharCode(nom.length)}${nom}\x12\x05local`).toString("base64url"),
      claims: {
        ...NOMS(nom),
        groups: groupes,
        at_hash: "abc",
        federated_claims: { connector_id: "local", user_id: nom },
      },
    }),
  },
  {
    cle: "zitadel",
    nom: "Zitadel",
    sources: [
      "https://zitadel.com/docs/apis/openidoauth/endpoints",
      "https://zitadel.com/docs/apis/openidoauth/claims",
    ],
    sourcage: "documentation",
    verdict: "reglage",
    resume:
      "fonctionne avec ce réglage : groupes fournis en tableau de chaînes par une Action ; les rôles natifs (objet `urn:zitadel:iam:org:project:roles`) ne sont pas lus ; profil lu par UserInfo",
    idp: {
      racine: "",
      alg: "RS256",
      chemins: {
        auth: "/oauth/v2/authorize",
        token: "/oauth/v2/token",
        certs: "/oauth/v2/keys",
        userinfo: "/oidc/v1/userinfo",
        logout: "/oidc/v1/end_session",
      },
    },
    decouverte: () => ({
      backchannel_logout_supported: undefined,
      subject_types_supported: ["public"],
      token_endpoint_auth_methods_supported: [
        "none",
        "client_secret_basic",
        "client_secret_post",
        "private_key_jwt",
      ],
      code_challenge_methods_supported: ["S256"],
    }),
    reglages: { groups_claim: "elpis_groups" },
    groupeRequis: "elpis",
    userinfo: (u) => ({ sub: u.sub, ...NOMS(String(u.claims?.["nom"] ?? "alice")) }),
    utilisateur: (nom, groupes = ["elpis"]) => ({
      sub: String(77776025198584418n + BigInt(nom.length)),
      claims: {
        nom,
        elpis_groups: groupes,
        "urn:zitadel:iam:org:project:roles": { elpis: { "266901234": "exemple.lan" } },
        amr: ["pwd", "mfa"],
        preferred_username: undefined,
        name: undefined,
        email: undefined,
      },
    }),
  },
  {
    cle: "authelia",
    nom: "Authelia",
    sources: ["https://www.authelia.com/integration/openid-connect/introduction/"],
    sourcage: "documentation",
    verdict: "fonctionne",
    resume:
      "fonctionne ; PAR et paramètre `iss` de la réponse (RFC 9207) joués ; aucune déconnexion annoncée",
    idp: {
      racine: "",
      alg: "RS256",
      issDansReponse: true,
      chemins: {
        auth: "/api/oidc/authorization",
        token: "/api/oidc/token",
        certs: "/jwks.json",
        userinfo: "/api/oidc/userinfo",
        par: "/api/oidc/pushed-authorization-request",
      },
    },
    decouverte: (idp) => ({
      end_session_endpoint: undefined,
      backchannel_logout_supported: undefined,
      pushed_authorization_request_endpoint: `${idp.origine}/api/oidc/pushed-authorization-request`,
      authorization_response_iss_parameter_supported: true,
      require_pushed_authorization_requests: false,
      subject_types_supported: ["public", "pairwise"],
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
        "client_secret_jwt",
        "private_key_jwt",
        "none",
      ],
      code_challenge_methods_supported: ["S256"],
    }),
    reglages: { groups_claim: "groups" },
    groupeRequis: "elpis",
    utilisateur: (nom, groupes = ["elpis", "admins"]) => ({
      sub: uuid(nom),
      claims: { ...NOMS(nom), groups: groupes, auth_time: Math.floor(Date.now() / 1000), amr: ["pwd"] },
    }),
  },
  {
    cle: "ping",
    nom: "PingFederate / PingOne",
    sources: [
      "https://docs.pingidentity.com/pingfederate/latest/administrators_reference_guide/pf_openid_connect_discovery_endpoint.html (introuvable)",
    ],
    sourcage: "non sourcé",
    verdict: "fonctionne",
    resume:
      "non confirmé par un document : forme standard jouée avec les chemins usuels de PingFederate ; fonctionne tant que les points d'accès restent sur l'origine de l'émetteur",
    idp: {
      racine: "",
      alg: "RS256",
      chemins: {
        auth: "/as/authorization.oauth2",
        token: "/as/token.oauth2",
        certs: "/pf/JWKS",
        userinfo: "/idp/userinfo.openid",
        logout: "/idp/startSLO.ping",
        par: "/as/par.oauth2",
      },
    },
    decouverte: () => ({
      subject_types_supported: ["public"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "private_key_jwt"],
    }),
    reglages: { groups_claim: "memberOf" },
    groupeRequis: "elpis",
    utilisateur: (nom, groupes = ["elpis"]) => ({ sub: nom, claims: { ...NOMS(nom), memberOf: groupes } }),
  },
  {
    cle: "hydra",
    nom: "Ory Hydra",
    sources: ["https://www.ory.com/docs/hydra/self-hosted/configure-deploy"],
    sourcage: "documentation",
    verdict: "reglage",
    resume:
      "fonctionne avec ce réglage : émetteur saisi avec sa barre finale ; les revendications viennent de l'application de connexion de l'exploitant",
    idp: {
      racine: "",
      barreFinale: true,
      alg: "RS256",
      issDansReponse: true,
      chemins: {
        auth: "/oauth2/auth",
        token: "/oauth2/token",
        certs: "/.well-known/jwks.json",
        userinfo: "/userinfo",
        logout: "/oauth2/sessions/logout",
      },
    },
    decouverte: () => ({
      backchannel_logout_supported: true,
      backchannel_logout_session_supported: true,
      authorization_response_iss_parameter_supported: true,
      subject_types_supported: ["public"],
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
        "private_key_jwt",
        "none",
      ],
      code_challenge_methods_supported: ["S256"],
    }),
    reglages: { groups_claim: "groups" },
    groupeRequis: "elpis",
    utilisateur: (nom, groupes = ["elpis"]) => ({
      sub: uuid(nom),
      claims: {
        ...NOMS(nom),
        groups: groupes,
        sid: uuid(`sid-${nom}`),
        auth_time: Math.floor(Date.now() / 1000),
      },
    }),
  },
  {
    cle: "panva",
    nom: "node-oidc-provider",
    sources: ["https://op.panva.cz/.well-known/openid-configuration"],
    sourcage: "document public",
    verdict: "fonctionne",
    resume: "fonctionne ; jeton en PS256, PAR annoncé, déconnexion par canal arrière annoncée",
    idp: {
      racine: "",
      alg: "PS256",
      chemins: {
        auth: "/auth",
        token: "/token",
        certs: "/jwks",
        userinfo: "/me",
        logout: "/session/end",
        par: "/request",
      },
    },
    decouverte: (idp) => ({
      pushed_authorization_request_endpoint: `${idp.origine}/request`,
      backchannel_logout_supported: true,
      backchannel_logout_session_supported: true,
      subject_types_supported: ["public", "pairwise"],
      token_endpoint_auth_methods_supported: [
        "none",
        "client_secret_basic",
        "client_secret_jwt",
        "client_secret_post",
        "private_key_jwt",
        "self_signed_tls_client_auth",
      ],
      code_challenge_methods_supported: ["S256"],
    }),
    reglages: { groups_claim: "groups", id_token_alg: "PS256" },
    groupeRequis: "elpis",
    utilisateur: (nom, groupes = ["elpis"]) => ({
      sub: uuid(nom),
      claims: {
        ...NOMS(nom),
        groups: groupes,
        sid: uuid(`sid-${nom}`),
        auth_time: Math.floor(Date.now() / 1000),
        acr: "urn:mace:incommon:iap:bronze",
        amr: ["pwd"],
      },
    }),
  },
  {
    cle: "kanidm",
    nom: "Kanidm",
    sources: ["https://kanidm.github.io/kanidm/stable/integrations/oauth2.html"],
    sourcage: "documentation",
    verdict: "fonctionne",
    resume:
      "fonctionne ; jeton ES256, authentification du client par l'en-tête Basic, groupes sous forme de noms complets (SPN) et d'UUID",
    idp: {
      racine: "/oauth2/openid/elpis",
      alg: "ES256",
      chemins: {
        auth: "/ui/oauth2",
        token: "/oauth2/token",
        certs: "/oauth2/openid/elpis/public_key.jwk",
        userinfo: "/oauth2/openid/elpis/userinfo",
        logout: "/oauth2/openid/elpis/logout",
      },
    },
    decouverte: () => ({
      end_session_endpoint: undefined,
      backchannel_logout_supported: undefined,
      subject_types_supported: ["public"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
    }),
    reglages: { groups_claim: "groups", client_auth: "basic", id_token_alg: "ES256" },
    groupeRequis: "elpis@idm.exemple.lan",
    utilisateur: (nom, groupes = ["elpis@idm.exemple.lan"]) => ({
      sub: uuid(nom),
      claims: {
        ...NOMS(nom),
        preferred_username: `${nom}@idm.exemple.lan`,
        groups: [...groupes, uuid("groupe-elpis")],
      },
    }),
  },
  {
    cle: "cognito",
    nom: "Amazon Cognito",
    sources: ["https://docs.aws.amazon.com/cognito/latest/developerguide/federation-endpoints.html"],
    sourcage: "documentation",
    verdict: "non",
    resume:
      "ne fonctionne pas : points d'autorisation, de jetons et UserInfo sur le domaine de la réserve d'utilisateurs (*.auth.<région>.amazoncognito.com), hors de l'origine de l'émetteur (cognito-idp.<région>.amazonaws.com)",
    horsOrigine: true,
    idp: {
      racine: "/eu-west-3_AbCdEf123",
      alg: "RS256",
      chemins: {
        auth: "/oauth2/authorize",
        token: "/oauth2/token",
        certs: "/eu-west-3_AbCdEf123/.well-known/jwks.json",
        userinfo: "/oauth2/userInfo",
      },
    },
    decouverte: (_idp, surOrigine = false) => ({
      ...(surOrigine
        ? {}
        : {
            authorization_endpoint: "https://exemple.auth.eu-west-3.amazoncognito.com/oauth2/authorize",
            token_endpoint: "https://exemple.auth.eu-west-3.amazoncognito.com/oauth2/token",
            userinfo_endpoint: "https://exemple.auth.eu-west-3.amazoncognito.com/oauth2/userInfo",
          }),
      end_session_endpoint: undefined,
      backchannel_logout_supported: undefined,
      subject_types_supported: ["public"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    }),
    reglages: { groups_claim: "cognito:groups" },
    groupeRequis: "elpis",
    utilisateur: (nom, groupes = ["elpis"]) => ({
      sub: uuid(nom),
      claims: {
        ...NOMS(nom),
        "cognito:groups": groupes,
        "cognito:username": nom,
        token_use: "id",
        auth_time: Math.floor(Date.now() / 1000),
      },
    }),
  },
  {
    cle: "onelogin",
    nom: "OneLogin",
    sources: ["https://developers.onelogin.com/openid-connect/api/authorization-code"],
    sourcage: "documentation",
    verdict: "reglage",
    resume:
      "fonctionne avec ce réglage : portée `groups` ajoutée ; chemins `/oidc/2/*` non confirmés par la documentation lue",
    idp: {
      racine: "/oidc/2",
      alg: "RS256",
      authClient: "post",
      chemins: {
        auth: "/oidc/2/auth",
        token: "/oidc/2/token",
        certs: "/oidc/2/certs",
        userinfo: "/oidc/2/me",
        logout: "/oidc/2/logout",
      },
    },
    decouverte: () => ({
      backchannel_logout_supported: undefined,
      subject_types_supported: ["public"],
      code_challenge_methods_supported: ["S256"],
    }),
    reglages: {
      groups_claim: "groups",
      client_auth: "post",
      scopes: ["openid", "profile", "email", "groups"],
    },
    groupeRequis: "elpis",
    utilisateur: (nom, groupes = ["elpis"]) => ({
      sub: String(40000000 + nom.length),
      claims: { ...NOMS(nom), groups: groupes },
    }),
  },
  {
    cle: "forgerock",
    nom: "ForgeRock / PingAM",
    sources: ["https://backstage.forgerock.com/docs/am/7.5/oidc1-guide/index.html (redirigé, non lu)"],
    sourcage: "non sourcé",
    verdict: "fonctionne",
    resume:
      "non confirmé par un document : forme standard jouée avec l'émetteur sous `/am/oauth2` ; fonctionne tant que les points d'accès restent sur l'origine",
    idp: {
      racine: "/am/oauth2",
      alg: "RS256",
      chemins: {
        auth: "/am/oauth2/authorize",
        token: "/am/oauth2/access_token",
        certs: "/am/oauth2/connect/jwk_uri",
        userinfo: "/am/oauth2/userinfo",
        logout: "/am/oauth2/connect/endSession",
      },
    },
    decouverte: () => ({
      subject_types_supported: ["public"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    }),
    reglages: { groups_claim: "groups" },
    groupeRequis: "elpis",
    utilisateur: (nom, groupes = ["elpis"]) => ({
      sub: uuid(nom),
      claims: { ...NOMS(nom), groups: groupes },
    }),
  },
  {
    cle: "ibm",
    nom: "IBM Security Verify",
    sources: [],
    sourcage: "non sourcé",
    verdict: "fonctionne",
    resume:
      "non confirmé par un document : aucune source lue ; forme standard jouée avec un émetteur sous chemin",
    idp: {
      racine: "/oidc/endpoint/default",
      alg: "RS256",
      chemins: {
        auth: "/oidc/endpoint/default/authorize",
        token: "/oidc/endpoint/default/token",
        certs: "/oidc/endpoint/default/jwks",
        userinfo: "/oidc/endpoint/default/userinfo",
        logout: "/oidc/endpoint/default/logout",
      },
    },
    decouverte: () => ({ subject_types_supported: ["public"] }),
    reglages: { groups_claim: "groups" },
    groupeRequis: "elpis",
    utilisateur: (nom, groupes = ["elpis"]) => ({
      sub: uuid(nom),
      claims: { ...NOMS(nom), groups: groupes },
    }),
  },
  {
    cle: "shibboleth",
    nom: "Shibboleth IdP (greffon OIDC)",
    sources: [
      "https://shibboleth.atlassian.net/wiki/spaces/IDPPLUGINS/pages/1376878976/OIDC+OP (chemins non lus)",
    ],
    sourcage: "non sourcé",
    verdict: "fonctionne",
    resume:
      "non confirmé par un document : le greffon annonce le code, PKCE et les trois déconnexions ; forme standard jouée",
    idp: {
      racine: "",
      alg: "RS256",
      chemins: {
        auth: "/idp/profile/oidc/authorize",
        token: "/idp/profile/oidc/token",
        certs: "/idp/profile/oidc/keyset",
        userinfo: "/idp/profile/oidc/userinfo",
        logout: "/idp/profile/oidc/logout",
      },
    },
    decouverte: () => ({ subject_types_supported: ["public", "pairwise"] }),
    reglages: { groups_claim: "groups", username_claim: "preferred_username" },
    groupeRequis: "elpis",
    utilisateur: (nom, groupes = ["elpis"]) => ({
      sub: uuid(nom),
      claims: { ...NOMS(nom), groups: groupes },
    }),
  },
];

export const SECRET_PAR_DEFAUT = BASE_SECRET;
