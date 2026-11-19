# Enterprise sign-in: directory (LDAP) and single sign-on (OpenID Connect)

Let people sign in to Elpis with the account their organization already manages, instead of a password
created in Elpis. Two kinds of provider exist and can be mixed (five providers at most):

- **Directory**: Elpis checks the username and password against an LDAP directory over LDAPS (FreeIPA,
  Active Directory, OpenLDAP, 389 Directory Server).
- **Single sign-on**: Elpis sends the person to an OpenID Connect provider (Keycloak, Authentik,
  LemonLDAP::NG, AD FS…) and receives a signed identity token. The password never reaches Elpis.

Reference of every setting: [configuration.md](configuration.md#enterprise-sign-in-auth). Emergency exit:
[operations.md](operations.md#enterprise-sign-in-emergency-exit). Journal events:
[audit-events.md](audit-events.md#enterprise-sign-in-admin). What people see:
[user-guide.md](user-guide.md#signing-in-with-your-organizations-account).

## What it is, and what it is not

- Directory protocol: LDAPS only (`ldaps://`). Plain `ldap://` and StartTLS are not accepted.
- Single sign-on protocol: OpenID Connect, authorization code flow with PKCE (S256), Elpis being a
  confidential client (it holds a client secret).
- Not provided: SAML, Kerberos or other ticket-based sign-in, authentication by a header set by a front
  proxy.
- **No second factor in Elpis.** Two-factor authentication is set up at the provider; Elpis can require
  that the identity token proves it (`required_acr` / `required_amr`, see
  [Requiring a second factor](#requiring-a-second-factor)). A directory sign-in is a password only.
- Nothing is on by default. Without a provider, nothing changes: no new route answers, no outgoing call is
  made, the login page is the same.
- Roles and groups of Elpis can follow the groups of the directory or of the provider. This is optional and
  off by default: see [Roles and groups from the directory](#roles-and-groups-from-the-directory). Without it,
  accounts created by a provider are ordinary users and administrators are promoted in the console as usual.

## Before you start

1. **HTTPS in service.** Set up HTTPS access first (Administration › **Accès HTTPS**, see
   [configuration.md](configuration.md#https-caddy-front-end)). A provider cannot be switched on while the
   session cookie is not secure.
2. **A public address.** The `https` address people type to reach Elpis (`https://elpis.example.lan`, no
   path). It is the only source of the return address given to the provider, and cannot change while a
   provider is on.
3. **An administrator with a local password, kept as the way back in.** Elpis refuses to switch a provider
   on, to suspend, delete or demote the last such administrator, and accounts created by a provider have no
   local password. Do not link your own administrator account to a provider.
4. **The certificate authority.** The directory (LDAPS) and the provider (https) are verified against the
   certificate authorities of the Elpis server. If yours is internal, paste it in the **Autorité de
   certification** (Certificate authority) field of the provider: PEM, 64 KiB at most; when present it is the
   only trust anchor of that provider. The name in the address must be one of the **subject alternative
   names** of the certificate: the common name is not read, a wildcard only counts as a whole first label
   (`*.example.lan`), and an address given as an IP needs an IP entry. The server must offer TLS 1.2 or 1.3
   with a forward-secret key exchange and an authenticated cipher (see [Compatibility](#compatibility)).
5. **The clocks.** Elpis, the directory and the provider must agree on the time. The test measures the
   difference and fails beyond the tolerance (single sign-on: **Écart (s)**, 60 s by default, 0 to 300).
6. **The network.** The Elpis host must reach the directory (default port 636) or the provider over https.
   Private addresses of your network are fine; loopback, link-local, unspecified and multicast addresses are
   refused. No proxy is used and redirects are not followed.
7. **A dedicated host name.** Serve nothing else on the host name of Elpis: browsers share cookies between
   all the services of a host name, whatever their port.

The console page is Administration › **Utilisateurs & accès** (Users & access) › **Connexion d'entreprise**
(Enterprise sign-in). Its first card lists the three prerequisites above (public address, secure session
cookie, local administrator) and says what is missing.

## Setting up a provider

The same steps apply to both kinds.

1. On **Connexion d'entreprise**, **Réglages généraux** (General settings): enter the **Adresse publique**
   (Public address) and save with **Enregistrer** (Save). **Connexion locale** (Local sign-in) stays on
   **Tous les comptes** (All accounts) for now.
2. In **Fournisseurs** (Providers), click **Ajouter** (Add), then **Annuaire LDAP** or **SSO OpenID Connect**.
   A provider is always created switched off.
3. Fill the drawer (the values are below), including **Groupes requis** (Required groups): at least one is
   needed to switch on, and only the members of one of them can sign in. Type a group and press `Enter` or
   **Ajouter**.
4. Enter the secret: **Mot de passe du compte de service** (Service account password) for a directory,
   **Secret client** (Client secret) for single sign-on. Click **Ajouter** or **Enregistrer**. The secret goes
   to the secrets vault, is never shown again (the field then says **Enregistré**, with **Supprimer** to
   remove it) and is bound to its addresses, its certificate authority and, for a directory, its service account: changing
   any of them asks for it again.
5. Click **Tester** (Test). See [What the test checks](#what-the-test-checks).
6. Single sign-on only: save, then, with the provider still switched off, click **Essayer la connexion**
   (Try the sign-in) and sign in with a real account. See [The sign-in trial](#the-sign-in-trial).
7. Click **Activer** (Switch on). The button explains what is missing when it is disabled.
8. Test it as a person would, in a private window.
9. When everything works, you may set **Connexion locale** to **Administrateurs seulement** (Administrators
   only): other accounts then cannot use a local password. Elpis refuses it unless an active administrator
   with a local password remains.

While a provider is on, its settings are locked: switch it off (**Désactiver**, which closes the sessions of
the accounts attached to it), change, test again, switch on. Only the label and **Fraîcheur (jours)** do not
require a new test. Once accounts are attached, the settings that identify a person cannot change any more:
for a directory the **Attribut identifiant**, the **Base des comptes** and the addresses (at least one host must
stay); for single sign-on the **Identifiant client**, the **Autorité** and the **Revendication sujet**. A provider
with attached accounts cannot be deleted: detach them first.

### What the test checks

**Tester** checks the settings shown, saved or not, and only reads. Steps are listed with their level.
Common to both kinds: **Réglages** (valid settings), **Prérequis** (public address, secure session cookie,
local administrator), **Résolution** (name resolves), **Adresse** (allowed address, with a warning when it is
the address of the Elpis host itself), **Certificat** (TLS 1.2 or later, trusted, valid; a warning below 30
days left).

- Directory: **Compte de service** (the bind with the stored or typed password), **Base des utilisateurs**
  (the base exists and is readable), **Groupes requis** (each group exists; for Active Directory, a required
  group that is a primary group is refused), **Utilisateur d'essai** (see below), **Groupes de l'utilisateur
  d'essai**, **Profil de l'utilisateur d'essai** (the Elpis name derived from the login), **Horloge de
  l'annuaire** (clock difference; a warning beyond 60 s). When roles or groups follow the directory, two more
  steps appear: **Groupes des rôles** and **Droits de l'utilisateur d'essai** (see
  [Testing the settings](#testing-the-settings)).
- Single sign-on: **Découverte** (the discovery document at the issuer address, whose `issuer` must match
  exactly), **Horloge**, **Points d'accès** (endpoints on the same origin as the issuer), **Algorithmes**,
  **Clés de signature** (a signing key of the configured algorithm is published; RSA keys of 2048 bits at
  least), **Authentification** (client authentication method announced), **Secret**, and warnings:
  **PKCE** (the provider does not announce PKCE S256: check that it requires it), **Sujet** (subject not read
  from `sub`) and **Requête poussée** (the provider announces pushed authorization requests, which Elpis then
  uses).

For a directory, fill **Utilisateur d'essai** (Test user) with the login of a person who must be able to
sign in. The user is only looked up: **no password of any user is ever asked or sent**. Without it the test
stays incomplete and the directory cannot be switched on. A step that fails stops the steps that depend on it.
A service password typed in the drawer is used for that test only; five failed binds of the same service
account within 15 minutes pause further tests.

A directory can be switched on after a complete test whose settings are saved. A single sign-on provider
also needs a sign-in trial. After any later change, run the test again.

### The sign-in trial

**Essayer la connexion** (available while the provider is switched off, on the saved settings) opens the
provider in a new tab and walks through a real sign-in. No account and no session is created. The console
then shows the decision, for example **Cette
personne se connecterait au compte…** (This person would sign in as…), **Un compte … serait créé** (An
account … would be created) or **Connexion refusée** (Sign-in refused) with the reason, and the claims
received (issuer, stable identifier, identifier, name, email, `acr`, `amr`, groups). Use it to check the
claim names and group values. Try it with a member of a required group, then with a non-member. The trial
validates the provider only when it ends in a sign-in or in an account creation, with the groups readable,
and for the settings that started it: a refusal, an error or a later change of the settings leaves the
provider untested. Read the decision line. When roles or groups follow the provider, the result also reports
the role and the Elpis groups the person would get.

## Directory (LDAP)

Choose a **Préréglage** (Preset: FreeIPA, Active Directory, OpenLDAP or **Autre**): it fills the fields that
are still empty. **Adresses** takes one to three
`ldaps://` addresses, one per line (replicas): the next is tried only when the previous is unreachable.
Create a **read-only service account** for Elpis. It needs to search the user base and to read, on user
entries, the four attributes below and the state attributes of the preset, and to read the required groups
(and their membership attribute). The test names what it cannot read.

How a sign-in goes: the service account looks the typed login up with the **Filtre** (Filter, `{username}`
once, as the whole value of an equality test) under **Base des comptes**; the entry must be active, the person must belong to a required group; only
then is the typed password sent to the directory, on a separate connection, as a bind of the person's own
entry. A person who is not in a required group is never linked: no account is created, no password is sent,
and the sign-in shows the usual wrong-login message. A sign-in suspends nobody; suspending people who left is
the work of the [periodic check](#life-cycle). A typed login that matches a local account with a local password is a local sign-in and never reaches
the directory; a directory entry whose login is the name of such an account is refused as well.
Logins must be plain text, without combining marks or invisible characters: the test warns when the login of
the test user contains some, and Elpis refuses such a login at sign-in.

| Field (setting)                        | FreeIPA                                                      | Active Directory                                                          | OpenLDAP                                         | 389 Directory Server                                |
| -------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------- |
| **Préréglage** (`preset`)              | FreeIPA                                                      | Active Directory                                                          | OpenLDAP                                         | OpenLDAP                                            |
| **Adresses** (`urls`)                  | `ldaps://ipa.example.lan`                                    | `ldaps://dc1.example.lan`                                                 | `ldaps://ldap.example.lan`                       | `ldaps://ds.example.lan`                            |
| **Compte de service** (`bind_dn`)      | `uid=elpis,cn=sysaccounts,cn=etc,dc=example,dc=lan`          | `cn=svc-elpis,cn=Users,dc=example,dc=lan`                                 | `cn=elpis,ou=services,dc=example,dc=lan`         | `cn=elpis,ou=services,dc=example,dc=lan`            |
| **Base des comptes** (`user_base_dn`)  | `cn=users,cn=accounts,dc=example,dc=lan`                     | `cn=Users,dc=example,dc=lan`                                              | `ou=people,dc=example,dc=lan`                    | `ou=people,dc=example,dc=lan`                       |
| **Filtre** (`user_filter`)             | `(&(objectClass=person)(uid={username}))`                    | `(&(objectCategory=person)(objectClass=user)(sAMAccountName={username}))` | `(&(objectClass=inetOrgPerson)(uid={username}))` | `(&(objectClass=inetOrgPerson)(uid={username}))`    |
| **Attribut identifiant** (`attrs.id`)  | `ipaUniqueID`                                                | `objectGUID`                                                              | `entryUUID`                                      | `nsUniqueId`                                        |
| **Attribut nom** (`attrs.username`)    | `uid`                                                        | `sAMAccountName`                                                          | `uid`                                            | `uid`                                               |
| **Attribut e-mail** (`attrs.email`)    | `mail`                                                       | `mail`                                                                    | `mail`                                           | `mail`                                              |
| **Attribut affiché** (`attrs.name`)    | `displayName`                                                | `displayName`                                                             | `cn`                                             | `cn`                                                |
| **Appartenance** (`groups.mode`)       | `memberOf`                                                   | **Chaîne (Active Directory)** (`chain`)                                   | `member`                                         | `memberOf` (MemberOf plugin enabled), else `member` |
| **Groupes requis** (`required_groups`) | `cn=elpis-users,cn=groups,cn=accounts,dc=example,dc=lan`     | `cn=elpis-users,ou=groups,dc=example,dc=lan`                              | `cn=elpis-users,ou=groups,dc=example,dc=lan`     | `cn=elpis-users,ou=groups,dc=example,dc=lan`        |
| State read by Elpis                    | `nsAccountLock`, `krbPasswordExpiration`, `krbLastPwdChange` | `userAccountControl`, `msDS-User-Account-Control-Computed`                | none                                             | none                                                |

The distinguished names above are examples. **Groupes requis** always takes the **full DN** of the group.
Several groups may be listed: one is enough.

- **Stable key.** **Attribut identifiant** must be an identifier generated by the server (`entryUUID`,
  `ipaUniqueID`, `objectGUID` or `nsUniqueId`), single-valued, and different from the other three
  attributes. Never use a name or a mail: the account stays attached to this key when the person is renamed.
- **Groups.** `member` reads the `member` / `uniqueMember` attributes of the group entry: direct members
  only. `memberOf` reads the `memberOf` attribute of the person, so nested groups count only if the directory
  computes them there. `chain` uses the Active Directory transitive rule, so nested groups count.
- **FreeIPA.** Give the service account read access to `nsAccountLock`, `krbPasswordExpiration` and
  `krbLastPwdChange`. A locked entry is refused; an entry without an expiration date counts as active only if
  `krbLastPwdChange` shows that a password was set. Without these attributes the entry state is unknown and the
  sign-in is refused (`state_unknown` in the journal).
- **Service account.** **Compte de service** takes the full distinguished name of the account, written with
  the usual attribute names (`cn`, `uid`, `ou`, `dc`…). A user principal name (`svc@example.lan`) or a
  `DOMAIN\name` is refused.
- **Active Directory.** Type the `sAMAccountName`, not the UPN. A required group must not be the primary group
  of its members (such as Domain Users): primary membership is not visible in `memberOf` and the test rejects
  it. Give the address of a domain controller on the LDAPS port (636), not the global catalog (3269), which
  does not serve the account state Elpis reads.
- **OpenLDAP and 389 Directory Server.** Elpis reads no account state for them. To retire someone, remove them
  from the required group or delete the entry. 389 Directory Server uses the OpenLDAP preset with `nsUniqueId`.
- **Expired password, locked or disabled account.** Where the state is read (FreeIPA, Active Directory), such
  an entry is refused before any password is sent. The person sees the usual wrong-login message; the reason
  is in the security journal (`entry_disabled`, `entry_locked`, `password_expired`, `state_unknown`).
- **Lockout.** **Essais** (`max_failures`, default 4, 1 to 20) within **Fenêtre (s)** (`failure_window_sec`,
  default 900): Elpis counts the attempts per directory entry and stops contacting the directory beyond that,
  the allowance draining continuously. Keep **Essais** **below the lockout threshold of the directory**, so
  that Elpis refuses first and the account is not locked. **Délai (s)** (`timeout_sec`, default 10) bounds
  each directory operation.
- A directory that is down, or whose service password is missing, shows the usual wrong-login message to the
  person, and `directory_unavailable` in the journal.

## Single sign-on (OpenID Connect)

Create a client for Elpis at the provider:

- **Confidential client** (it has a secret) using the **authorization code** flow, with **PKCE S256**.
- **Return address** (redirect URI) and **back-channel logout address**: copy them from the drawer, **À
  déclarer chez le fournisseur** (To declare at the provider), with **Copier** (Copy). They are
  `<public address>/api/auth/oidc/<id>/callback` and `<public address>/api/auth/oidc/<id>/backchannel-logout`;
  they appear once the public address and the **Identifiant** (Identifier) are filled. For sign-out, also
  allow `<public address>/` as post-logout address.
- **Groups in the identity token**: a claim holding a list of strings (default name `groups`). Some providers
  send a person's single group as one string: a string that is exactly a **required group** lets the person
  in, and nothing more is read from it (no role, no group, and it never counts as "not a member"). Any other
  string, such as several groups glued together (`a;b`), is unreadable. If the identity token lacks the groups or the login name and the provider
  announces a user-information endpoint on the same origin as the issuer, Elpis reads it there as well; an
  endpoint on another origin is never called, and the test says so.
- **The identity token is for Elpis alone**: a token that lists another audience next to the client
  identifier is refused.
- A **signature algorithm** for the identity token that matches **Algorithme de signature du jeton** (default
  `RS256`; an asymmetric one). Symmetric and unsigned algorithms are never accepted.

Then in the drawer: **Autorité** (issuer address, exactly as the provider announces it, such as
`https://sso.example.lan/realms/entreprise`), **Identifiant client** (Client identifier), **Secret client**,
**Groupes requis** (the group names as they appear in the claim), and under **Avancé** (Advanced):

| Field (setting)                                                       | Default                | Meaning                                                                                        |
| --------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| **Authentification client** (`client_auth`)                           | `basic`                | **En-tête (basic)** or **Corps de requête (post)**; the test checks the provider supports it   |
| **Algorithme de signature du jeton** (`id_token_alg`)                 | `RS256`                | Must be announced by the provider and have a published key                                     |
| **Portées** (`scopes`)                                                | `openid profile email` | Space separated, `openid` mandatory; add the one that releases groups if the provider needs it |
| **Revendication sujet** (`subject_claim`)                             | `sub`                  | The stable key of the person. Never a name that can be reassigned                              |
| **Revendication nom** (`username_claim`)                              | `preferred_username`   | The login name; the Elpis name is derived from it                                              |
| **Revendication e-mail** / **affichée** (`email_claim`, `name_claim`) | `email`, `name`        | The email is kept only when `email_verified` is true                                           |
| **Revendication groupes** (`groups_claim`)                            | `groups`               | A dotted path (`realm_access.roles`) works                                                     |
| **Âge max. (s)** (`max_age_sec`)                                      | `0`                    | Asks the provider for a recent authentication, 0 to 604800; 0 asks nothing                     |
| **Écart (s)** (`clock_skew_sec`)                                      | `60`                   | Clock difference tolerated, 0 to 300                                                           |
| **Session (s)** (`session_max_age_sec`)                               | `0`                    | Session length for this provider, 0 to 2592000; 0 follows the global session length            |

Starting a sign-in is limited per client address (in IPv6, per /64 prefix), and the number of sign-ins in
progress is capped per address and per provider. Behind a reverse proxy, declare it as a trusted proxy
(`ACCESS_LOG_TRUSTED_PROXIES`, see [configuration.md](configuration.md#environment-variables)): otherwise
every person appears to come from the address of the proxy and shares one allowance.

The **subject** is what ties an account to the provider: choose a claim that is unique to the person and
never changes. The trial warns when the subject equals the login name.

### Requiring a second factor

Set the second factor at the provider, then make Elpis require it: **Niveaux d'authentification (acr)**
(`required_acr`) and **Méthodes d'authentification (amr)** (`required_amr`), space-separated lists. A sign-in
is accepted when the identity token carries one of the listed `acr` values and, if set, one of the listed
`amr` methods; the `acr` values are also sent in the request. Empty means no requirement, and the drawer says
that no two-step check is then guaranteed by Elpis. For an administrator group, a `required_amr` made only of single-factor methods (`pwd`, `pin`, `kba`,
`geo`) is not enough. A refusal shows "Une vérification en deux étapes est
exigée".

### Keycloak

- Client: **Client authentication** on, **Standard flow** on; in advanced settings set the PKCE method to
  `S256`. Issuer: `https://sso.example.lan/realms/<realm>`. Subject `sub`, login `preferred_username`.
- Groups: add a **Group Membership** mapper with the claim name `groups`, **Add to ID token** on. Turn **Full
  group path** off, or enter the group with its leading slash.
- **A person who belongs to no group has no groups claim**: Elpis cannot read the groups and refuses with
  `groups_unknown` ("groups unreadable"). This is expected for people outside every group.
- Sign-out: set the **Backchannel logout URL**, and **Backchannel logout session required** on.

### Authentik

- Provider type OAuth2/OpenID, client type **Confidential**, redirect URI as given by Elpis (strict matching).
  Issuer: `https://authentik.example.lan/application/o/<application slug>/`, with the final slash.
- **Choose a signing key** (a certificate key pair) on the provider: without one the tokens are signed with the
  client secret, which Elpis refuses. Set **Algorithme de signature du jeton** to match the key (`RS256` for
  an RSA key).
- Groups: the `groups` claim holds group names. Subject `sub`, login `preferred_username`.

### LemonLDAP::NG

- Declare Elpis as an OpenID Connect relying party with the **authorization code** flow and a client secret.
  Issuer: the portal address, such as `https://auth.example.lan`.
- **The default subject is the user name.** Set the attribute used as subject to a unique value that never
  changes, then use `sub`; otherwise the trial warns.
- Set **Authentification client** to **Corps de requête (post)**: with the header method, a client identifier
  or a secret holding a character other than letters and digits is refused by the provider.
- Expose the groups as a claim through the relying party's attributes, as a list (array type `auto` or
  `always`), and check in the trial that **Groupes** lists them one by one. A person with a single group is
  let in when that group is a required group; a string holding several groups is not a list. For roles and
  groups to follow the provider, send a list (array type `always`).

### AD FS

- Create an application group with a **server application** (confidential client) and the return address of
  Elpis. The subject (`sub`) is specific to each client: it is stable for Elpis and different in other
  applications, which is expected.
- Claims must be in the **identity token**: add the `allatclaims` scope to **Portées**, and issue the groups
  and the login name through issuance transform rules (for example the Active Directory `sAMAccountName` as
  an outgoing claim named `username`, the groups as `group`). Then set **Revendication nom** and
  **Revendication groupes** to those names. Check them in the trial.
- AD FS sends a person's single group as one string: the person is let in when it is a required group, and
  roles are read from lists only.

### Microsoft Entra ID

- Register an application with a **client secret** and the return address of Elpis (platform **Web**).
  Issuer: `https://login.microsoftonline.com/<tenant id>/v2.0`, with the identifier of **your tenant**; the
  shared issuers (`common`, `organizations`) are refused.
- **Put the groups in the identity token** (token configuration, groups claim): they come as a list of group
  identifiers, which is what **Groupes requis** then takes. The user-information endpoint of Entra ID is on
  another host and is not called, so the login name and the groups must be in the identity token.
- A person in too many groups for the token gets no groups claim and is refused (`groups_unknown`): limit the
  claim to the groups assigned to the application.

## Accounts

**Creation at first sign-in.** A person who belongs to a required group and has no Elpis account gets one
automatically: role user, no local password. The Elpis name derives from the login: lowercase, anything other
than letters, digits, `_` and `-` becomes `-` (so `jean.dupont` becomes `jean-dupont`), at least 2 and at most
64 characters; `admin`, `root`, `system`, `elpis`, `guest` and `user_<number>` are reserved. If an account
already has that name (letters and `.`, `-`, `_` compared loosely) the sign-in is refused: Elpis never attaches a
person to an existing account because of the name or the email. People already known to Elpis must be linked
as follows.

**Linking an existing account.** Linking removes the local password of the account (its conversations and
files are kept), closes its sessions and ties it to one identity of the provider. It also revokes the personal
API tokens and the access granted to applications by the account, which the person must create again; only
the link assistant for a directory can keep them, with its checkbox **Conserver les jetons d'API et les accès
des applications de ces comptes**. An administrator or moderator account needs an explicit confirmation, the
last local administrator cannot be linked, and a suspended account must be reactivated first.

- _Directory._ **Connexion d'entreprise**, on the active directory: **Rattacher les comptes existants** (Link
  existing accounts). For each local account the assistant proposes the directory entry of the same name; tick
  the lines, or **Chercher dans l'annuaire** (Search the directory) for another entry (3 characters at least),
  then **Rattacher N compte(s)**, then **Confirmer ?**. Only an entry that is active, belongs to a required
  group and can sign in with its login can be chosen.
- _Single sign-on._ In the provider drawer, **Comptes existants** (Existing accounts): choose the **Compte
  local**, enter the **Identifiant attendu chez le fournisseur** (the value of the login claim: letters, digits,
  `.`, `_`, `@` and `-`, 255 characters at most, compared exactly except for the case), click **Préparer le
  rattachement** (Prepare the link). It is valid for 30 days. A login that is an email address matches only
  when the provider says the email is verified. On their first sign-in the person enters their old Elpis
  password **once** ("Relier mon compte", Link my account); the link is made and the password removed. After
  five wrong passwords the prepared link is deleted and you must prepare it again. A ticked **Identité vérifiée
  hors ligne : ne pas demander l'ancien mot de passe** (Identity verified offline: do not ask for the old
  password) skips that step; it exists for ordinary users only, and such a link is valid 72 hours.
  Administrators and moderators always prove their old password and the console asks for a confirmation.
  Changing the **Revendication nom** of the provider deletes its prepared links. A prepared link always
  revokes the personal API tokens and the application access of the account.

**Detaching.** **Comptes** (Accounts), the **Détacher** (Detach) icon of the row: the account becomes local
again with a temporary password you type (to change at the next sign-in); its sessions, tokens and grants are
revoked. You cannot detach your own account.

## Roles and groups from the directory

By default Elpis decides nothing about roles and groups: accounts created by a provider are ordinary users, and
an administrator gives roles and groups in the console. Two independent options, both **off by default** and
set per provider, let the directory or the provider decide instead:

| Setting                  | Default | Meaning                                                                                                   |
| ------------------------ | ------- | --------------------------------------------------------------------------------------------------------- |
| `roles.enabled`          | `false` | The role (user, moderator, administrator) of the accounts of the provider follows their groups            |
| `roles.admin_groups`     | `[]`    | Up to 20 groups whose members are administrators, no duplicate                                            |
| `roles.moderator_groups` | `[]`    | Up to 20 groups whose members are moderators, no duplicate                                                |
| `group_map.enabled`      | `false` | The membership of some Elpis groups follows the groups of the provider                                    |
| `group_map.map`          | `[]`    | Up to 50 pairs `{external, group_id}`: the external group, and the identifier of the Elpis group it feeds |

The groups are written exactly as for **Groupes requis**: the **full DN** of the group for a directory, and the
exact value found in the groups claim for single sign-on. The match is exact, never partial. A group of the
roles or of the mapping does not have to be a required group; who may sign in is still decided by the required
groups alone. Several external groups may feed the same Elpis group.

How the decision is made, for each person:

- **Role.** A member of an administrator group is an administrator; otherwise a member of a moderator group is a
  moderator; otherwise a user. A person who belongs to none of the listed groups is therefore a user. With the
  option on but no usable group listed, nothing happens: it never turns everybody into a user.
- **Groups.** Only the Elpis groups named in the mapping are managed, the others are never touched. A person is
  in such a group when they are in at least one of the external groups mapped to it; a manual change to a
  managed group is undone at the next sign-in. A mapped Elpis group that no longer exists is ignored and
  noted in the log.
- **One membership that cannot be read changes nothing.** If a single group to read is unreadable (directory
  error, missing group, no groups claim in the token), neither the role nor the groups of that person change.
  An unreadable answer is never taken as "not a member".
- **A group with no visible member changes nothing either.** For a directory, when the service account sees
  no member at all in a group of the roles or of the mapping (the group is empty, or hidden from that
  account), nobody is demoted and nobody is removed because of it. The test reports it as a warning. As a
  consequence, an administrator group that you emptied on purpose demotes nobody at the periodic check: lower
  those roles by hand in **Comptes**.

When the decision is applied:

- **At each successful sign-in**, in both directions: the role goes up or down, groups are added or removed. An
  account created at a first sign-in gets its role and groups at once. The sign-in that completes a link with
  the old password (single sign-on) may lower the role at once, before the session opens; a promotion, and
  any addition, waits for the next sign-in.
- **During the periodic directory check**, for the people it finds present, only demotions and removals are
  applied, never a promotion or an addition. Those wait for the person's next sign-in. The pass reads the
  administrators and moderators first, so that a pass cut short by its time limit leaves the other accounts
  for the next one; an entry that cannot be read is left as it is.
- **Single sign-on has no periodic check**, so a change of groups at the provider reaches Elpis at the next
  sign-in of the person.
- A **demotion closes the sessions** of the person. Elpis never demotes the last active administrator that has
  a local password.
- The **role of such an account can be lowered by hand, never raised**: for every account attached to a
  provider whose `roles.enabled` is on, **Comptes** only offers the current role and the lower ones, shown
  with the mark **géré par l'annuaire** (managed by the directory), and the console refuses a promotion. The
  role is recalculated from the groups at the next sign-in. The change is recorded as `admin.user.role` with
  `role_managed`.

**Administrator groups.** Giving the administrator role through groups is a deliberate step. When you save a
provider with administrator groups, when you create it or change them, the save is refused until you confirm
explicitly that their members become administrators: the drawer asks you to type **administrateur**. The
confirmation is asked again when the way the groups are read changes: the **Appartenance** (Membership)
mode of a directory, or, for single sign-on, the groups claim, `required_acr` or `required_amr`. For single
sign-on the provider must also require a second factor (`required_acr`, or a `required_amr` that lists at
least one method proving more than a single factor; `pwd`, `pin`, `kba` and `geo` do not, see
[Requiring a second factor](#requiring-a-second-factor)), otherwise the settings are refused; administrator
groups of a single sign-on provider that does not require one are ignored, and `./elpis doctor` warns about
it. A mapping to an Elpis group that does not exist is refused when you save.

**In the drawer.** The section **Rôles et groupes** (Roles and groups) is folded by default. Its first box,
**Donner les rôles d'après les groupes de l'annuaire** (Give roles from the directory groups), turns on the
role decision; **Groupes administrateurs** (Administrator groups) and **Groupes modérateurs** (Moderator
groups) take the groups, one at a time, with **Ajouter**. The second box, **Affecter aux groupes Elpis
d'après les groupes de l'annuaire** (Assign Elpis groups from the directory groups), turns on the mapping:
pick the external group (**Groupe de l'annuaire**) and the **Groupe Elpis…** (Elpis group) it feeds, then
**Ajouter**. With administrator groups, a fixed notice reminds you that an administrator of Elpis can run
commands on the server. For single sign-on without a second factor, the section asks you to require a
two-step verification first and the save stays unavailable.

**Changing these settings** follows the general rule: switch the provider off, change them, test again, switch
on. They are part of what the test covers.

### Testing the settings

Check what each kind of person would get before switching on, with at least one member of an administrator
group, one of a moderator group and one plain member. Nothing is written by a test.

- **Directory.** When an option is on, **Tester** adds two steps. **Groupes des rôles** fails if a group of the
  roles or of the mapping does not exist, and states when members of the administrator groups would become
  administrators. **Droits de l'utilisateur d'essai** gives the role and the identifiers of the Elpis groups
  the test user would get, or a warning when a membership cannot be read (nothing would then change at sign-in).
  **Groupes des rôles** also warns when the service account sees no member in a group of the roles or of the
  mapping: the roles are then not modified.
- **Single sign-on.** The result of the [sign-in trial](#the-sign-in-trial) reports the same for the person who
  signed in: the role and the Elpis groups, whether the groups were readable, the mapped Elpis groups that no
  longer exist, and whether the administrator groups are ignored for lack of a second factor.

The security journal records `auth.role.sync` when a role changes and `auth.groups.sync` when groups are added
or removed (see [audit-events.md](audit-events.md#authentication)). `./elpis doctor` notes the providers whose
roles or groups are managed.

## Life cycle

**Directory check.** Every 15 minutes (the first pass two minutes after Elpis starts), Elpis reads again each
linked identity by its stable key. A person who left, whose entry is disabled, or who is no longer in a
required group is suspended (shown as **Désactivé** in **Comptes**): sessions closed, personal API tokens and
OAuth grants refused at once and deleted after 7 days of suspension. A person who comes back is reactivated at
the next check or sign-in, if the directory suspended them. An account you suspend yourself replaces the
suspension of the directory: it stays suspended until you lift it, and its tokens are revoked at once. A
departure is acted on only after a second check reports it, at least two minutes and at most two intervals
after the first. At the first sighting, access that does not go through a session (API tokens, OAuth grants,
routines, webhooks) is refused at once, and nothing is suspended or deleted; if the person turns out to be
there at the next check, that access works again by itself. The second check follows about three minutes
later, and the person is suspended then.

- **Mass-departure guard.** If at least 3 departures are found and they exceed 20 % of the active linked
  accounts of that directory, or if all of them are, nothing is suspended: the console shows "N comptes ne sont plus dans
  l'annuaire ou dans un groupe requis. Par précaution, aucun n'a été désactivé." with the list of accounts, and
  the button **Désactiver ces N comptes** (Deactivate these N accounts) once you have read it.
- **An unreadable answer is never a departure.** A directory that is unreachable, a missing required group, a
  refused service account, or a service account that can no longer read the user entries or the membership of
  a required group: the pass is shown **Abandonnée** (Abandoned) with its reason, and nothing is changed. `./elpis doctor` also warns about a stale or abandoned pass.
  If a required group was emptied on purpose, the check keeps being abandoned (reason
  `membership_unreadable`): switch the provider off, or disable the accounts in the console.
- When roles or groups follow the directory, each pass also re-reads them for the people found present (see
  [Roles and groups from the directory](#roles-and-groups-from-the-directory)).
- **Vérifier maintenant** (Check now) runs a pass at once. The line **Dernière vérification de l'annuaire**
  reports the accounts seen, suspended, reactivated and unreadable.

**Single sign-on** has no periodic check: the groups are read at every sign-in. A person already linked who
signs in without a required group is refused and their account is suspended; it is reactivated at their next
sign-in once they are back in a group, unless an administrator suspended it. A provider that supports
back-channel logout ends sessions as it decides (see [Sign-out](#sign-out)).

**Freshness.** Access that does not go through an interactive session (personal tokens, OAuth grants,
scheduled runs of routines) is refused for an account whose identity was not confirmed for **Fraîcheur
(jours)** (`freshness_days`, 14 by default, 1 to 90). A directory confirms identities at every check; with
single sign-on, a person confirms theirs by signing in, so a person who relies on tokens signs in at least
that often. A provider that is off or deleted confirms nothing: the access of its accounts is refused.

**Disabling is not deleting.** Suspension and detaching keep the conversations, files and settings of the
account. Elpis never deletes an account by itself.

## Sign-out

- **Déconnecter aussi chez le fournisseur** (`logout.rp_initiated`): when the person signs out of Elpis, the
  browser is sent to the end-session address announced by the provider, returning to `<public address>/`.
  That address comes from the discovery document of the provider, which Elpis keeps up to date in the
  background (about every 55 minutes): right after the provider is switched on, the person may be signed out
  of Elpis only, for up to an hour.
- **Accepter la déconnexion par canal arrière** (Accept back-channel logout, `logout.backchannel`): the
  provider calls the back-channel address of Elpis when the person signs out elsewhere or is closed at the
  provider. Elpis checks the signed logout token (signature, issuer, audience, age, expiry when it carries one,
  and the presence of its `jti` identifier) and closes the matching sessions; a token already applied is accepted again without effect. The
  provider only gets a status code, and refused calls are limited per client address. When the token names
  one session of the provider, the terminals opened from that session are closed with it. That call comes from the provider to Elpis: **the provider
  must trust the certificate of Elpis** (add your internal authority to it) and reach its public address.

## When it does not work

What people see after a single sign-on failure is a message and a short **Référence** (reference). Search it in
`./elpis logs main` (a line `connexion SSO <id> refusée (réf. …) : <cause>`) or in Supervision › Journaux ›
Sécurité (`auth.login.denied`, `details.ref`). A directory failure always shows the usual wrong-login message;
the reason is in the security journal, under `auth.login.denied` with `login_method` `ldap:<id>`. All the
reasons are listed in [audit-events.md](audit-events.md#authentication).

| Message shown                                                                        | Code (`auth_error`) | Probable cause                                                                                                                           |
| ------------------------------------------------------------------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| "Votre compte n'est pas autorisé à utiliser Elpis. Demandez à votre administrateur." | `not_in_group`      | Not in a required group (check the group value in the trial)                                                                             |
| (same message)                                                                       | `groups_unknown`    | No groups claim, not a list of strings, or too many groups for the token (Keycloak: person without group)                                |
| (same message)                                                                       | `conflict`          | An account already has the derived name, the name is invalid or reserved, or the prepared link does not match                            |
| (same message)                                                                       | `suspended`         | Account suspended: by the directory check (left the group) or by an administrator                                                        |
| "Une vérification en deux étapes est exigée. Reconnectez-vous en la validant."       | `mfa_required`      | `acr` / `amr` of the token do not match **required_acr** / **required_amr**                                                              |
| "Connexion refusée par le service de votre organisation."                            | `denied`            | The provider answered with an error (person refused or cancelled there)                                                                  |
| "La connexion a pris trop de temps. Réessayez."                                      | `expired`           | The sign-in was too long, was opened from another address than the public one, or the browser blocked cookies                            |
| "Le service de connexion de votre organisation ne répond pas…"                       | `unavailable`       | Provider unreachable, discovery or keys unreadable, client secret missing, no local administrator left                                   |
| "La connexion n'a pas abouti. Réessayez ou demandez à votre administrateur."         | `failed`            | Anything else: token rejected (signature, issuer, audience, nonce, expiry: `lib:<code>`), clock difference, subject missing              |
| (same message)                                                                       | `failed`            | `client_auth_rejected` in the journal: the provider refused the client secret; check it, then try the other client authentication method |
| (same message)                                                                       | `failed`            | `aud_untrusted` in the journal: the identity token lists another audience than Elpis                                                     |
| (same message)                                                                       | `failed`            | `iss_mismatch` in the journal: the answer does not come from the configured issuer                                                       |

Other messages: "Cette demande a expiré. Reconnectez-vous par le service de votre organisation." (the
old-password step waited too long), "Cette demande n'est plus valable. Reconnectez-vous par le service de votre
organisation ou demandez à votre administrateur." (the prepared link is gone: expired, deleted, or five wrong
passwords) and "Trop de tentatives, réessayez dans un instant." (rate limit).

Commands on the host, described in [operations.md](operations.md#enterprise-sign-in-emergency-exit):

- `./elpis auth status`: public address, local mode, and per provider switched on / active / tested. A
  provider that is on but not active has an unmet condition (test, secret, groups, public address).
- `./elpis doctor` (or `./elpis auth doctor`): provider state, certificate authorities nearing their end,
  directory check age, held-back suspensions, providers whose roles or groups are managed, last local
  administrator.
- `./elpis auth off`: switches every provider off and reopens the local password to everyone. Use it when the
  provider is the problem and nobody can sign in.
- `./elpis auth reactivate <account>`: lifts a suspension from the host.

## Security, in plain terms

- **What crosses Elpis.** With a directory, the person's directory password goes through Elpis, which relays
  it to the directory and keeps it nowhere. With single sign-on it never does: the password is typed at the
  provider. Prefer single sign-on when you have one.
- **What is stored.** The service password and the client secret live only in the secrets vault (as instance
  secrets, never in `config.json`) and no route returns them. `config.json` holds the settings and the pasted
  certificate authority. For each linked account Elpis keeps the provider, the stable key, and the login, email
  and name last read.
- **What is logged.** The security journal records sign-ins and refusals, links, suspensions, provider changes
  and tests (see [audit-events.md](audit-events.md#enterprise-sign-in-admin)). Passwords, secrets, tokens and
  anything the provider says in its own words are never logged; a typed login is only kept as a hash.
- **TLS is always verified.** There is no switch to disable certificate verification. Without a trusted
  authority the test fails and tells you to paste yours. The server name is checked against the subject
  alternative names only, and only forward-secret, authenticated cipher suites are accepted.
- **Trust.** The directory and the provider are trusted to say who a person is and which groups they belong to.
  The host name of Elpis is its trust boundary: dedicated to it, in HTTPS. See [SECURITY.md](../SECURITY.md).
- **The settings are written only by the console** (and `./elpis auth off`): neither the raw editor nor the
  configuration API can create or overwrite the `auth` section.

## Compatibility

What follows comes from two kinds of proof. **Played on a real server**: the whole journey (test, sign-in,
refusals, sign-out) ran against that product in a container. **Played on its profile**: the automated tests
replay what the product documents (discovery, token shapes, group formats) against a local provider or
directory. A product that is not listed has not been looked at; one that follows the standards below should
work, and **Tester** then **Essayer la connexion** will say so.

### What Elpis expects from any server

- **TLS 1.2 or 1.3** with a forward-secret key exchange (ECDHE or DHE) and an authenticated cipher (AES-GCM
  or ChaCha20-Poly1305). Servers that only offer static RSA key exchange or CBC ciphers are refused.
- **A certificate that names the server in its subject alternative names.** The common name is not read, and a
  wildcard only counts as a whole first label (`*.example.lan`). An address given as an IP needs an IP entry.
- **Directory**: LDAP v3 over LDAPS, a service account given as a full distinguished name, a stable
  server-generated key (`entryUUID`, `ipaUniqueID`, `objectGUID` or `nsUniqueId`), and groups whose members are
  distinguished names (`member`, `uniqueMember`) or that are listed in `memberOf` on the person.
- **Single sign-on**: OpenID Connect discovery, authorization code flow with PKCE S256, a confidential client
  authenticated by its secret (header or request body), an identity token signed with an asymmetric algorithm
  (RS256, RS384, RS512, PS256, PS384, PS512, ES256, ES384, ES512 or EdDSA), and the token and key endpoints on
  the same origin as the issuer.

### Directories

| Directory                                                                  | Status                  | Settings and limits                                                                                                                 |
| -------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 389 Directory Server                                                       | Played on a real server | OpenLDAP preset with `nsUniqueId`; `memberOf` with the MemberOf plugin (nested groups count), else `member`                         |
| OpenLDAP                                                                   | Played on a real server | OpenLDAP preset; `member`, or `memberOf` with the memberof overlay                                                                  |
| Samba AD DC                                                                | Played on a real server | Active Directory preset, as is (disabled account, password to change, nested groups)                                                |
| LLDAP                                                                      | Played on a real server | OpenLDAP preset, `entryUUID`, either membership mode. See the note below                                                            |
| Active Directory (Windows Server 2016+)                                    | Played on its profile   | Active Directory preset. Use a domain controller on port 636, not the global catalog (3269), which does not serve the account state |
| FreeIPA / Red Hat IdM                                                      | Played on its profile   | FreeIPA preset; its 389 Directory Server engine was played on a real server with the FreeIPA attributes                             |
| OpenDJ / ForgeRock DS                                                      | Played on its profile   | **Autre** preset, `entryUUID`, `member` mode (`isMemberOf` is not read)                                                             |
| Groups that are only `posixGroup`                                          | Not supported           | Members listed by login (`memberUid`) are not read: use groups of distinguished names                                               |
| NetIQ eDirectory, Oracle Internet Directory, IBM Security Directory Server | Not supported           | Their stable key attribute is not one of the four accepted                                                                          |

- **LLDAP.** For a person who is not in the group it answers "no such object" instead of an empty result, which
  Elpis reads as "groups unreadable". The person is refused all the same; but a person **removed** from the
  required group is not suspended by the periodic check: their sign-in is refused at once, and their tokens and
  routines stop when the verification of the account lapses (**Fraîcheur**, 14 days by default). To cut
  someone off at once, suspend the account in Elpis.
- **Sign-in name.** One login format per directory: the **Filtre** takes `{username}` once.
- **Account state** (disabled, locked, expired) is read on FreeIPA and Active Directory only. Elsewhere the
  directory itself refuses the bind and the person sees the usual wrong-login message.

### Identity providers

| Provider                                | Status                  | Settings and limits                                                                                                          |
| --------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Keycloak                                | Played on a real server | See [Keycloak](#keycloak). Sign-out both ways                                                                                |
| LemonLDAP::NG                           | Played on a real server | See [LemonLDAP::NG](#lemonldapng): client authentication in the request body; a single group sent as a string was played too |
| Dex                                     | Played on a real server | Add the `groups` scope. No sign-out at the provider                                                                          |
| Providers built on `node-oidc-provider` | Played on a real server | RS256, PS256, ES256, ES384 and EdDSA, both client authentication methods, pushed authorization requests, sign-out both ways  |
| Microsoft Entra ID                      | Played on its profile   | See [Microsoft Entra ID](#microsoft-entra-id): groups in the identity token, issuer of your tenant                           |
| AD FS                                   | Played on its profile   | See [AD FS](#ad-fs)                                                                                                          |
| Authentik                               | Played on its profile   | See [Authentik](#authentik): a signing key is mandatory                                                                      |
| Okta                                    | Played on its profile   | Standard settings; create a `groups` claim                                                                                   |
| GitLab                                  | Played on its profile   | The groups are read at the user-information endpoint (full group paths). No sign-out at the provider                         |
| Authelia                                | Played on its profile   | Add the `groups` scope; the groups and the login name are read at the user-information endpoint                              |
| Kanidm                                  | Played on its profile   | ES256, client authentication in the header, `groups` scope                                                                   |
| Auth0, Ory Hydra                        | Played on its profile   | Type the issuer with its final slash. Auth0: put the groups in a claim with a plain name                                     |
| Zitadel                                 | Played on its profile   | Provide the groups as a list of strings (an Action); its native roles claim is an object and is not read                     |
| OneLogin                                | Played on its profile   | Add the `groups` scope                                                                                                       |
| Google, Amazon Cognito                  | Not supported           | Their token and key endpoints are on other hosts than the issuer. Put an identity broker you run (Keycloak, Dex) in front    |

- **Groups are a list of strings.** A claim holding one string only lets the person in when it is exactly a
  required group; roles, mapped groups and suspensions are decided from lists only. Several groups glued in
  one string (`a;b`) are never split, and give "groups unreadable".
- **Back-channel sign-out** needs a provider that sends logout tokens (Keycloak and `node-oidc-provider` were
  played on real servers). A logout token without an expiry is accepted when it is recent; one listing another
  audience than Elpis is refused.
- **Not read**: a claim whose name is an address (`https://…`), a signed or encrypted user-information
  answer, an encrypted identity token, an issuer shared by several tenants.
- **A required group is mandatory**: a provider that cannot say which groups a person belongs to cannot be
  switched on.
