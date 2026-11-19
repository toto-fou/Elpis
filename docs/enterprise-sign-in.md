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
- Roles and groups of Elpis driven by directory groups (`roles`, `group_map` in the settings) are not covered
  here. Accounts created by a provider are ordinary users; administrators are promoted in the console as
  usual.

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
   only trust anchor of that provider. The name in the address must match the certificate.
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
   remove it) and is bound to the host and port of the provider: changing them asks for it again.
5. Click **Tester** (Test). See [What the test checks](#what-the-test-checks).
6. Single sign-on only: save, then click **Essayer la connexion** (Try the sign-in) and sign in with a real
   account. See [The sign-in trial](#the-sign-in-trial).
7. Click **Activer** (Switch on). The button explains what is missing when it is disabled.
8. Test it as a person would, in a private window.
9. When everything works, you may set **Connexion locale** to **Administrateurs seulement** (Administrators
   only): other accounts then cannot use a local password. Elpis refuses it unless an active administrator
   with a local password remains.

While a provider is on, its settings are locked: switch it off (**Désactiver**, which closes the sessions of
the accounts attached to it), change, test again, switch on. Only the label and **Fraîcheur (jours)** do not
require a new test. Once accounts are attached, the stable key cannot change any more (**Attribut
identifiant** for a directory, **Identifiant client**, **Autorité** and **Revendication sujet** for single
sign-on). A provider with attached accounts cannot be deleted: detach them first.

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
  l'annuaire** (clock difference).
- Single sign-on: **Découverte** (the discovery document at the issuer address, whose `issuer` must match
  exactly), **Horloge**, **Points d'accès** (endpoints on the same origin as the issuer), **Algorithmes**,
  **Clés de signature** (a key of the configured algorithm is published), **Authentification** (client
  authentication method announced), **Secret**, and warnings such as **Sujet** (subject not read from `sub`).

For a directory, fill **Utilisateur d'essai** (Test user) with the login of a person who must be able to
sign in. The user is only looked up: **no password of any user is ever asked or sent**. Without it the test
stays incomplete and the directory cannot be switched on. A test that fails on a step stops the following
ones.

A directory can be switched on after a complete test whose settings are saved. A single sign-on provider
also needs a sign-in trial. After any later change, run the test again.

### The sign-in trial

**Essayer la connexion** opens the provider in a new tab and walks through a real sign-in. Nothing is
recorded: no account, no session is created. The console then shows the decision, for example **Cette
personne se connecterait au compte…** (This person would sign in as…), **Un compte … serait créé** (An
account … would be created) or **Connexion refusée** (Sign-in refused) with the reason, and the claims
received (issuer, stable identifier, identifier, name, email, `acr`, `amr`, groups). Use it to check the
claim names and group values. Try it with a member of a required group, then with a non-member. The trial
only needs the groups to be readable to count; read the decision line.

## Directory (LDAP)

Choose a **Préréglage** (Preset): it fills the fields that are still empty. **Adresses** takes one to three
`ldaps://` addresses, one per line (replicas): the next is tried only when the previous is unreachable.
Create a **read-only service account** for Elpis. It needs to search the user base and to read, on user
entries, the four attributes below and the state attributes of the preset, and to read the required groups
(and their membership attribute). The test names what it cannot read.

How a sign-in goes: the service account looks the typed login up with the **Filtre** (Filter, `{username}`
once) under **Base des comptes**; the entry must be active, the person must belong to a required group; only
then is the typed password sent to the directory, on a separate connection, as a bind of the person's own
entry. A typed login that matches a local account with a local password is a local sign-in and never reaches
the directory.

| Field (setting)                        | FreeIPA                                                  | Active Directory                                                          | OpenLDAP                                         | 389 Directory Server                                |
| -------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------- |
| **Préréglage** (`preset`)              | FreeIPA                                                  | Active Directory                                                          | OpenLDAP                                         | OpenLDAP                                            |
| **Adresses** (`urls`)                  | `ldaps://ipa.example.lan`                                | `ldaps://dc1.example.lan`                                                 | `ldaps://ldap.example.lan`                       | `ldaps://ds.example.lan`                            |
| **Compte de service** (`bind_dn`)      | `uid=elpis,cn=sysaccounts,cn=etc,dc=example,dc=lan`      | `cn=svc-elpis,cn=Users,dc=example,dc=lan`                                 | `cn=elpis,ou=services,dc=example,dc=lan`         | `cn=elpis,ou=services,dc=example,dc=lan`            |
| **Base des comptes** (`user_base_dn`)  | `cn=users,cn=accounts,dc=example,dc=lan`                 | `cn=Users,dc=example,dc=lan`                                              | `ou=people,dc=example,dc=lan`                    | `ou=people,dc=example,dc=lan`                       |
| **Filtre** (`user_filter`)             | `(&(objectClass=person)(uid={username}))`                | `(&(objectCategory=person)(objectClass=user)(sAMAccountName={username}))` | `(&(objectClass=inetOrgPerson)(uid={username}))` | `(&(objectClass=inetOrgPerson)(uid={username}))`    |
| **Attribut identifiant** (`attrs.id`)  | `ipaUniqueID`                                            | `objectGUID`                                                              | `entryUUID`                                      | `nsUniqueId`                                        |
| **Attribut nom** (`attrs.username`)    | `uid`                                                    | `sAMAccountName`                                                          | `uid`                                            | `uid`                                               |
| **Attribut e-mail** (`attrs.email`)    | `mail`                                                   | `mail`                                                                    | `mail`                                           | `mail`                                              |
| **Attribut affiché** (`attrs.name`)    | `displayName`                                            | `displayName`                                                             | `cn`                                             | `cn`                                                |
| **Appartenance** (`groups.mode`)       | `memberOf`                                               | **Chaîne (Active Directory)** (`chain`)                                   | `member`                                         | `memberOf` (MemberOf plugin enabled), else `member` |
| **Groupes requis** (`required_groups`) | `cn=elpis-users,cn=groups,cn=accounts,dc=example,dc=lan` | `cn=elpis-users,ou=groups,dc=example,dc=lan`                              | `cn=elpis-users,ou=groups,dc=example,dc=lan`     | `cn=elpis-users,ou=groups,dc=example,dc=lan`        |
| State read by Elpis                    | `nsAccountLock`, `krbPasswordExpiration`                 | `userAccountControl`, `msDS-User-Account-Control-Computed`                | none                                             | none                                                |

The distinguished names above are examples. **Groupes requis** always takes the **full DN** of the group.
Several groups may be listed: one is enough.

- **Stable key.** **Attribut identifiant** must be an identifier generated by the server (`entryUUID`,
  `ipaUniqueID`, `objectGUID` or `nsUniqueId`), single-valued, and different from the other three
  attributes. Never use a name or a mail: the account stays attached to this key when the person is renamed.
- **Groups.** `member` reads the `member` / `uniqueMember` attributes of the group entry: direct members
  only. `memberOf` reads the `memberOf` attribute of the person, so nested groups count only if the directory
  computes them there. `chain` uses the Active Directory transitive rule, so nested groups count.
- **FreeIPA.** If the test says the password expiration is not readable, give the service account read access
  to `krbPasswordExpiration` and `nsAccountLock`: otherwise an expired password is not refused by Elpis itself.
- **Active Directory.** Type the `sAMAccountName`, not the UPN. A required group must not be the primary group
  of its members (such as Domain Users): primary membership is not visible in `memberOf` and the test rejects
  it.
- **OpenLDAP and 389 Directory Server.** Elpis reads no account state for them. To retire someone, remove them
  from the required group or delete the entry. 389 Directory Server uses the OpenLDAP preset with `nsUniqueId`.
- **Expired password, locked or disabled account.** Where the state is read (FreeIPA, Active Directory), such
  an entry is refused before any password is sent. The person sees the usual wrong-login message; the reason
  is in the security journal (`entry_disabled`, `entry_locked`, `password_expired`).
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
- **Groups in the identity token**: a claim holding a list of strings (default name `groups`). If the identity
  token lacks the groups or the login name and the provider announces a user-information endpoint, Elpis
  reads it there as well.
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
| **Âge max. (s)** (`max_age_sec`)                                      | `0`                    | Asks the provider for a recent authentication; 0 asks nothing                                  |
| **Écart (s)** (`clock_skew_sec`)                                      | `60`                   | Clock difference tolerated, 0 to 300                                                           |
| **Session (s)** (`session_max_age_sec`)                               | `0`                    | Session length for this provider; 0 follows the global session length                          |

The **subject** is what ties an account to the provider: choose a claim that is unique to the person and
never changes. The trial warns when the subject equals the login name.

### Requiring a second factor

Set the second factor at the provider, then make Elpis require it: **Niveaux d'authentification (acr)**
(`required_acr`) and **Méthodes d'authentification (amr)** (`required_amr`), space-separated lists. A sign-in
is accepted when the identity token carries one of the listed `acr` values and, if set, one of the listed
`amr` methods; the `acr` values are also sent in the request. Empty means no requirement, and the drawer says
that no two-step check is then guaranteed by Elpis. A refusal shows "Une vérification en deux étapes est
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
- Expose the groups as a claim through the relying party's attributes and check in the trial that **Groupes**
  lists them one by one; a single string is not a list of groups.

### AD FS

- Create an application group with a **server application** (confidential client) and the return address of
  Elpis. The subject (`sub`) is specific to each client: it is stable for Elpis and different in other
  applications, which is expected.
- Claims must be in the **identity token**: add the `allatclaims` scope to **Portées**, and issue the groups
  and the login name through issuance transform rules (for example the Active Directory `sAMAccountName` as
  an outgoing claim named `username`, the groups as `group`). Then set **Revendication nom** and
  **Revendication groupes** to those names. Check them in the trial.

## Accounts

**Creation at first sign-in.** A person who belongs to a required group and has no Elpis account gets one
automatically: role user, no local password. The Elpis name derives from the login: lowercase, anything other
than letters, digits, `_` and `-` becomes `-` (so `jean.dupont` becomes `jean-dupont`), at least 2 and at most
64 characters; `admin`, `root`, `system`, `elpis`, `guest` and `user_<number>` are reserved. If an account
already has that name (letters and `.`, `-`, `_` compared loosely) the sign-in is refused: Elpis never attaches a
person to an existing account because of the name or the email. People already known to Elpis must be linked
as follows.

**Linking an existing account.** Linking removes the local password of the account (its conversations and
files are kept), closes its sessions and ties it to one identity of the provider. An administrator account
needs an explicit confirmation, the last local administrator cannot be linked, and a suspended account must
be reactivated first.

- _Directory._ **Connexion d'entreprise**, on the active directory: **Rattacher les comptes existants** (Link
  existing accounts). For each local account the assistant proposes the directory entry of the same name; tick
  the lines, or **Chercher dans l'annuaire** (Search the directory) for another entry (3 characters at least),
  then **Rattacher N compte(s)**, then **Confirmer ?**. Only an active entry that belongs to a required group
  can be chosen.
- _Single sign-on._ In the provider drawer, **Comptes existants** (Existing accounts): choose the **Compte
  local**, enter the **Identifiant attendu chez le fournisseur** (the value of the login claim, compared
  without regard to case), click **Préparer le rattachement** (Prepare the link). It is valid for 30 days. On
  their first sign-in the person enters their old Elpis password **once** ("Relier mon compte", Link my
  account); the link is made and the password removed. A ticked **Identité vérifiée hors ligne : ne pas demander
  l'ancien mot de passe** (Identity verified offline: do not ask for the old password) skips that step; it
  exists for ordinary users only, and such a link is valid 72 hours. An administrator always proves their old
  password and the console asks for a confirmation.

**Detaching.** **Comptes** (Accounts), the **Détacher** (Detach) icon of the row: the account becomes local
again with a temporary password you type (to change at the next sign-in); its sessions, tokens and grants are
revoked. You cannot detach your own account.

## Life cycle

**Directory check.** Every 15 minutes (the first pass two minutes after Elpis starts), Elpis reads again each
linked identity by its stable key. A person who left, whose entry is disabled, or who is no longer in a
required group is suspended (shown as **Désactivé** in **Comptes**): sessions closed, personal API tokens and
OAuth grants refused at once and deleted after 7 days of suspension. A person who comes back is reactivated at
the next check or sign-in, if the directory suspended them; an account you suspended yourself stays so. A
departure is acted on only after two successive checks report it.

- **Mass-departure guard.** If at least 3 departures are found and they exceed 20 % of the linked accounts of
  that directory, or if all of them are, nothing is suspended: the console shows "N comptes ne sont plus dans
  l'annuaire ou dans un groupe requis. Par précaution, aucun n'a été désactivé." with the list of accounts, and
  the button **Désactiver ces N comptes** (Deactivate these N accounts) once you have read it.
- **An unreadable answer is never a departure.** A directory that is unreachable, a missing required group, a
  refused service account: the pass is shown **Abandonnée** (Abandoned) with its reason, and nothing is
  changed. `./elpis doctor` also warns about a stale or abandoned pass.
- **Vérifier maintenant** (Check now) runs a pass at once. The line **Dernière vérification de l'annuaire**
  reports the accounts seen, suspended, reactivated and unreadable.

**Single sign-on** has no periodic check: the groups are read at every sign-in, and a provider that supports
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
- **Accepter la déconnexion par canal arrière** (Accept back-channel logout, `logout.backchannel`): the
  provider calls the back-channel address of Elpis when the person signs out elsewhere or is closed at the
  provider. Elpis checks the signed logout token (signature, issuer, audience, validity) and closes the matching
  sessions; the provider only gets a status code. That call comes from the provider to Elpis: **the provider
  must trust the certificate of Elpis** (add your internal authority to it) and reach its public address.

## When it does not work

What people see after a single sign-on failure is a message and a short **Référence** (reference). Search it in
`./elpis logs main` (a line `connexion SSO <id> refusée (réf. …) : <cause>`) or in Supervision › Journaux ›
Sécurité (`auth.login.denied`, `details.ref`). A directory failure always shows the usual wrong-login message;
the reason is in the security journal, under `auth.login.denied` with `login_method` `ldap:<id>`. All the
reasons are listed in [audit-events.md](audit-events.md#authentication).

| Message shown                                                                        | Code (`auth_error`) | Probable cause                                                                                                              |
| ------------------------------------------------------------------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| "Votre compte n'est pas autorisé à utiliser Elpis. Demandez à votre administrateur." | `not_in_group`      | Not in a required group (check the group value in the trial)                                                                |
| (same message)                                                                       | `groups_unknown`    | No groups claim, not a list of strings, or too many groups for the token (Keycloak: person without group)                   |
| (same message)                                                                       | `conflict`          | An account already has the derived name, the name is invalid or reserved, or the prepared link does not match               |
| (same message)                                                                       | `suspended`         | Account suspended: by the directory check (left the group) or by an administrator                                           |
| "Une vérification en deux étapes est exigée. Reconnectez-vous en la validant."       | `mfa_required`      | `acr` / `amr` of the token do not match **required_acr** / **required_amr**                                                 |
| "Connexion refusée par le service de votre organisation."                            | `denied`            | The provider answered with an error (person refused or cancelled there)                                                     |
| "La connexion a pris trop de temps. Réessayez."                                      | `expired`           | The sign-in was too long, was opened from another address than the public one, or the browser blocked cookies               |
| "Le service de connexion de votre organisation ne répond pas…"                       | `unavailable`       | Provider unreachable, discovery or keys unreadable, client secret missing, no local administrator left                      |
| "La connexion n'a pas abouti. Réessayez ou demandez à votre administrateur."         | `failed`            | Anything else: token rejected (signature, issuer, audience, nonce, expiry: `lib:<code>`), clock difference, subject missing |

Other messages: "Cette demande a expiré. Reconnectez-vous par le service de votre organisation." (the
old-password step waited too long) and "Trop de tentatives, réessayez dans un instant." (rate limit).

Commands on the host, described in [operations.md](operations.md#enterprise-sign-in-emergency-exit):

- `./elpis auth status`: public address, local mode, and per provider switched on / active / tested. A
  provider that is on but not active has an unmet condition (test, secret, groups, public address).
- `./elpis doctor` (or `./elpis auth doctor`): provider state, certificate authorities nearing their end,
  directory check age, held-back suspensions, last local administrator.
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
  authority the test fails and tells you to paste yours.
- **Trust.** The directory and the provider are trusted to say who a person is and which groups they belong to.
  The host name of Elpis is its trust boundary: dedicated to it, in HTTPS. See [SECURITY.md](../SECURITY.md).
- **The settings are written only by the console** (and `./elpis auth off`): neither the raw editor nor the
  configuration API can create or overwrite the `auth` section.

## What has been proven

Sign-in journeys have been played against 389 Directory Server, OpenLDAP and Keycloak. FreeIPA, Active
Directory, Authentik, LemonLDAP::NG and AD FS follow the same standard settings but still have to be validated
on your site: run **Tester** (and **Essayer la connexion**) on each before switching it on.
