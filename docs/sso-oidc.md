# OpenID Connect single sign-on (SSO)

Let people sign in to Elpis with the account their organization already manages, instead of a password
created in Elpis. Elpis sends the person to an OpenID Connect provider (Keycloak, Authentik, LemonLDAP::NG,
AD FS…) and receives a signed identity token. The password never reaches Elpis. Up to five providers can be
declared. Elpis does not talk to a directory itself: see [Connecting a directory](#connecting-a-directory).

Reference of every setting: [configuration.md](configuration.md#openid-connect-single-sign-on-auth). Emergency exit:
[operations.md](operations.md#sso-openid-connect-emergency-exit). Journal events:
[audit-events.md](audit-events.md#openid-connect-single-sign-on-admin). What people see:
[user-guide.md](user-guide.md#signing-in-with-your-organizations-account).

## What it is, and what it is not

- Single sign-on protocol: OpenID Connect, authorization code flow with PKCE (S256), Elpis being a
  confidential client (it holds a client secret).
- Not provided: SAML, Kerberos or other ticket-based sign-in, authentication by a header set by a front
  proxy.
- **No second factor in Elpis.** Two-factor authentication is set up at the provider; Elpis can require
  that the identity token proves it (`required_amr`, or the `acr` levels you declare in `mfa_acr`, see
  [Requiring a second factor](#requiring-a-second-factor)).
- Nothing is on by default. Without a provider, nothing changes: no new route answers, no outgoing call is
  made, the login page is the same.
- Roles and groups of Elpis can follow the groups of the provider. This is optional and
  off by default: see [Roles and groups from the provider](#roles-and-groups-from-the-provider). Without it,
  accounts created by a provider are ordinary users and administrators are promoted in the console as usual.

## Before you start

1. **A public address.** The `https` address people type to reach Elpis (`https://elpis.example.lan`, no
   path). It is the only source of the return address given to the provider, and cannot change while a
   provider is on.
2. **HTTPS in service.** Set up HTTPS access (Administration › **Accès HTTPS**, see
   [configuration.md](configuration.md#https-caddy-front-end)). A provider cannot be switched on while the
   session cookie is not secure.
3. **An administrator with a local password, kept as the way back in.** Elpis refuses to switch a provider
   on, to suspend, delete or demote the last such administrator, and accounts created by a provider have no
   local password. Do not link your own administrator account to a provider.
4. **The certificate authority.** The provider (https) is verified against the
   certificate authorities of the Elpis server. If yours is internal, paste it in the **Autorité de
   certification** (Certificate authority) field of the provider (section **3. Client**): PEM, 64 KiB at most; when present it is the
   only trust anchor of that provider. The name in the address must be one of the **subject alternative
   names** of the certificate: the common name is not read, a wildcard only counts as a whole first label
   (`*.example.lan`), and an address given as an IP needs an IP entry. The server must offer TLS 1.2 or 1.3
   with a forward-secret key exchange and an authenticated cipher (see [Compatibility](#compatibility)).
5. **The clocks.** Elpis and the provider must agree on the time. **Contrôler les réglages** measures the difference and fails
   beyond the tolerance (**Écart d'horloge, s**, clock skew, 60 s by default, 0 to 300).
6. **The network.** The Elpis host must reach the provider over https.
   Private addresses of your network are fine; loopback, link-local, unspecified and multicast addresses are
   refused. No proxy is used and redirects are not followed.
7. **A dedicated host name.** Serve nothing else on the host name of Elpis: browsers share cookies between
   all the services of a host name, whatever their port.

The console page is Administration › **Utilisateurs & accès** (Users & access) › **SSO OpenID Connect**; the
search of the console also finds it by `oidc`, `openid`, `sso` or `entreprise`. A status card says
**SSO OpenID Connect actif** (OpenID Connect SSO on) with the active providers, or **Connexion locale seule**
(Local sign-in only) with who can still sign in: only the local password sign-in when no provider is
switched on (accounts created by a provider have no local password); only the local sign-in, with a ⚠, when
providers are switched on but none is operative; only the
administrators, with a ⚠, when **4. Mots de passe locaux** is set to **Administrateurs seulement** and no
provider is active. Then four numbered cards follow the order of the setup:

1. **Prérequis** (Prerequisites): the three prerequisites above, each marked ✓ or ✗ with what to do, the
   **Adresse publique** (Public address) field with its own **Enregistrer** (Save), and **Ouvrir Accès HTTPS**
   (Open HTTPS access).
2. **Fournisseurs** (Providers): the list, with **Ajouter** (Add). A provider is **Actif** (Active),
   **Éteint** (Off) or **Inopérant** (Inoperative: switched on but not active), and an inoperative one says in
   its line which condition is missing and how to restore it: switch the provider off to fix its settings,
   its secret or its sign-in trial (the public address needs every provider switched off); HTTPS and the local
   administrator are restored without switching it off.
3. **Comptes existants** (Existing accounts): the prepared links, see [Accounts](#accounts).
4. **Mots de passe locaux** (Local passwords): **Tous les comptes** (All accounts) or **Administrateurs
   seulement** (Administrators only), with its own **Enregistrer**.

Nothing appears or disappears on this page or in the provider drawer as you fill, save or switch on: what is
not available yet is greyed out, with the reason written next to it. Only results, errors and validation
warnings come and go; the button of **8. Activation** reads **Activer** or **Désactiver** in the same place,
and each address to declare is replaced, in the same place, by what is missing until it can be written.

## Setting up a provider

1. In **1. Prérequis**, enter the **Adresse publique** and save it with the card's **Enregistrer**. Leave
   **4. Mots de passe locaux** on **Tous les comptes** for now.
2. In **2. Fournisseurs**, click **Ajouter**. A provider is always created switched off. The drawer has eight
   numbered sections, in the order of the procedure; they are the same for a new, a saved and an active
   provider.
3. **1. Fournisseur** (Provider): the **Libellé** (Label), the **Identifiant dans Elpis** (Identifier in Elpis,
   used in the addresses; derived from the label until you type it yourself: lowercase letters, digits and
   dashes, 31 characters at most, fixed once the provider is added) and the **Adresse de l'émetteur (issuer)**.
4. **2. À déclarer chez le fournisseur** (To declare at the provider): the **Adresse de retour
   (redirect_uri)** and the **Déconnexion par canal arrière (backchannel_logout_uri)**, with **Copier**
   (Copy). Until the public address and the identifier are filled, each line says what is missing.
5. **3. Client**: the **Identifiant client (client_id)** and the **Secret client (client_secret)**, and the
   **Autorité de certification** if the certificate of the provider is not recognized. The secret goes to the
   secrets vault when you click **Ajouter** or **Enregistrer**, is never shown again (the field then says
   **Enregistré**, with **Supprimer** to remove it) and is bound to the provider address and its certificate
   authority: changing either asks for it again.
6. **4. Accès** (Access): the **Groupes requis** (Required groups): at least one is needed to switch on, and
   only the members of one of them can sign in. Type a group and press `Enter` or **Ajouter**. Then the second
   factor, one field under the other, each with its help line: **Niveaux exigés (acr)**, **Niveaux qui
   prouvent un second facteur (acr)** and **Méthodes exigées (amr)**, with a fixed line under them that says
   who must prove a second factor: all accounts, the administrators only, or nobody (or that administrators
   will always be refused). See [Requiring a second factor](#requiring-a-second-factor).
7. **5. Rôles et groupes** (Roles and groups, folded, off by default) and **6. Avancé** (Advanced, folded):
   see below.
8. **7. Vérification** (Verification): **a. Contrôler les réglages** (Check the settings; see [What the check
   covers](#what-the-check-covers)), then save with **Ajouter**: the drawer stays open on the new provider,
   scrolled to this section, with the result of the check. With the provider still switched off, **b. Se
   connecter pour essayer** (Sign in to try) with a real account (see [The sign-in
   trial](#the-sign-in-trial)). The second is greyed out until the provider is saved.
9. **8. Activation**: the six conditions (public address, HTTPS, local administrator, required group, secret
   saved, successful sign-in trial) and **Modifications enregistrées** (Changes saved: nothing typed in the
   drawer is waiting to be saved, the secret included) are listed with ✓ or ✗, then **Activer** (Switch on),
   which says what is missing while it is disabled. After **Activer** or **Désactiver**, the drawer shows the
   settings as saved on the server; the confirmation of **Désactiver** says when changes typed and not saved
   will be lost.
10. Test it as a person would, in a private window.
11. When everything works, you may set **4. Mots de passe locaux** to **Administrateurs seulement**: other
    accounts then cannot use a local password. The console greys this choice out, with its reason, while no
    provider is active; the server refuses it unless an active administrator with a local password remains.

While a provider is switched on, only its **Libellé** and its **Fraîcheur (jours)** (freshness, under
**6. Avancé**) can change, as the drawer says at the top; the rest is greyed out. To change anything else,
switch it off (**Désactiver**, in **8. Activation**, which closes the sessions of the accounts attached to it),
change, try again, switch on. If someone else switches the provider on while its drawer is open, the drawer
reloads the saved settings and keeps the label and the freshness you typed; if anything else could not be
sent, **Enregistrer** says so and the drawer stays open. Once accounts are attached, the settings that
identify a person cannot change any more: the **Identifiant client**, the **Adresse de l'émetteur** and the
**Revendication sujet**, each with the reason written under it. A provider with attached accounts cannot be
deleted: detach them first.

### What the check covers

**Contrôler les réglages** checks the settings shown, saved or not, and only reads; its result goes away as
soon as one of the checked settings changes. The secret typed is never sent to the check: it only learns that
a secret is typed and not saved yet. Steps are listed with their level.
**Réglages** (valid settings), **Prérequis** (public address, secure session cookie,
local administrator), **Résolution** (name resolves), **Adresse** (allowed address, with a warning when it is
the address of the Elpis host itself), **Certificat** (TLS 1.2 or later, trusted, valid; a warning below 30
days left).

- **Découverte** (the discovery document at the issuer address, whose `issuer` must match
  exactly), **Horloge**, **Points d'accès** (endpoints on the same origin as the issuer), **Algorithmes**,
  **Clés de signature** (it lists the algorithms the provider announces and the algorithm, or the key type,
  of each published key; it fails when the configured algorithm is neither announced nor carried by a key,
  or when no key can verify it, RSA keys of 2048 bits at least; when no key states its algorithm, it says so
  and warns unless the algorithm is `RS256`, the protocol default, since only a real sign-in shows which
  algorithm the provider uses for this client), **Authentification** (client authentication method
  announced), **Secret** (saved; a secret typed but not saved yet is a warning, not a failure: **Se
  connecter pour essayer** checks it once the provider is saved), and warnings:
  **PKCE** (the provider does not announce PKCE S256: check that it requires it), **Sujet** (subject not read
  from `sub`), **Niveaux exigés** (`required_acr` holds several values: see [how the levels are
  requested](#requiring-a-second-factor)) and **Requête poussée** (the provider announces pushed authorization
  requests, which Elpis then uses).

A provider can be switched on after a successful sign-in trial on its saved settings: the condition **Connexion
d'essai réussie** (Successful sign-in trial) of **8. Activation**. After any later change, check and try
again. The condition rests on the last **successful** trial of the current settings, even when a later trial
refused an account: this is intended, the trial proves the settings, not an account (a refusal of a person
says something about that person, not about the provider).

### The sign-in trial

**Se connecter pour essayer** (available once the provider is saved and while it is switched off, on the
saved settings; otherwise greyed out with the reason) opens the
provider in a new tab and walks through a real sign-in. No account and no session is created, and nothing is
written but the result. The console then shows the decision, the same as a real sign-in would take on the same
accounts (the same checks, in the same order, on the database read without writing): **Cette personne se
connecterait au compte…** (This person would sign in as…), **Un compte … serait créé** (An account … would be
created), **…devrait d'abord saisir l'ancien mot de passe du compte…** (a prepared link: the old password
would be asked first; at that first sign-in the rights can only go down), **…serait rattachée au compte…
sans ancien mot de passe** (a prepared link with the offline-verified option), or **Connexion refusée**
(Sign-in refused) with the account concerned when there is one and the reason: no proof of a second factor
for an administrator group, account suspended by an administrator, a local account already has the name
(prepare its link), an account linked to a provider already has the name (see **One identity per account**
below), prepared link no longer valid, groups. When the sign-in does not get that far, **L'essai
a échoué** (The trial failed) names the cause and what to do where: client secret or client authentication
method refused (sections 3 and 6), token signed with another algorithm (section 6), extra audiences of the
client at the provider, issuer or client that do not match (sections 1 and 3), clock, subject, no identity
token, settings changed during the trial; anything else points to Supervision › Journaux (line `essai SSO
<id>`). The provider's own words are never shown. The claims received are listed (issuer, stable
identifier, identifier, name, email, `acr`, `amr`, groups). The line **Second facteur** says whether the
token proves a second factor and how (**prouvé par le niveau acr**, a level declared in `mfa_acr`, or
**prouvé par les méthodes amr**), otherwise what is missing given the settings: no declared `acr` level,
`amr` methods that are not enough (`mfa`, `mca`, or two families such as `pwd` and `otp`), or both. A token
without a readable list of groups shows **groupes absents ou illisibles**. Use it to check the claim names,
the group values and the `acr` levels your provider really sends. Try it with a member of a required group,
then with a non-member. The trial validates the provider only when the person would get in (a sign-in, an
account creation, or a prepared link), with the groups readable, and for the settings that started it: a
refusal, an error or a later change of the settings leaves the provider untested. Read the decision line.
When roles or groups follow the provider and the person would get in, the result also reports the role and
the Elpis groups the person would get; a refusal reports none.

The trial ends in the browser that started it, with the binding cookie alone: the administrator's session
cookie is not needed on the way back, so a strict `same_site` setting does not prevent the trial. The result
is stored, read in the console under the administrator's session, and the trial is refused if that account is
no longer an active administrator.

## Connecting a directory

Elpis does not connect to a directory (Active Directory, FreeIPA, OpenLDAP, 389 Directory Server) itself.
Put the directory behind an identity provider that federates it, then declare that provider here as above.

- **Keycloak**: its User Federation connects LDAP and Active Directory servers; FreeIPA / Red Hat IdM has its
  own integration section in the Keycloak documentation.
- **LemonLDAP::NG**: its authentication and user backends include LDAP and Active Directory.
- **AD FS** or **Microsoft Entra ID** for an Active Directory estate: see their sections below.

Whatever the product, the requirements that matter to the directory are settled at the provider, not in Elpis:

- **Required groups** are the groups the provider puts in the groups claim of the identity token. Make the
  provider send them (see the provider sections below and the sign-in trial).
- **Second factor and lockout** after repeated failures are set at the provider. Elpis can require the token
  to prove a second factor (see [Requiring a second factor](#requiring-a-second-factor)).
- **A departure** is seen at the person's next sign-in (the groups are read again), through back-channel
  logout when the provider sends it (see [Sign-out](#sign-out)), and through the freshness of the access
  (**Fraîcheur (jours)**, 14 days by default): tokens, OAuth grants and routines of a person not seen for that
  long stop. Removing a person's **last** group is not the same as removing a required group: see [Life
  cycle](#life-cycle). To cut access at once, suspend the account in **Comptes**.

## Single sign-on (OpenID Connect)

Create a client for Elpis at the provider:

- **Confidential client** (it has a secret) using the **authorization code** flow, with **PKCE S256**.
- **Return address** (redirect URI) and **back-channel logout address**: copy them from the drawer, section
  **2. À déclarer chez le fournisseur** (To declare at the provider), with **Copier** (Copy). They are
  `<public address>/api/auth/oidc/<id>/callback` and `<public address>/api/auth/oidc/<id>/backchannel-logout`;
  they are written once the public address and the **Identifiant dans Elpis** (Identifier in Elpis) are filled, and the line says
  what is missing until then. For sign-out, also allow `<public address>/` as post-logout address.
- **Groups in the identity token**: a claim holding a list of strings (default name `groups`). Some providers
  send a person's single group as one string: a string that is exactly a **required group** lets the person
  in, as long as roles and groups do not follow this provider. When they do
  ([Roles and groups from the provider](#roles-and-groups-from-the-provider)), a list is required, because a
  single string does not say whether it is the whole list. Any other string, such as several groups glued
  together (`a;b`), is unreadable. If the identity token lacks the groups or the login name and the provider
  announces a user-information endpoint on the same origin as the issuer, Elpis reads it there as well; an
  endpoint on another origin is never called, and **Contrôler les réglages** says so.
- **The identity token is for Elpis alone**: a token that lists another audience next to the client
  identifier is refused.
- A **signature algorithm** for the identity token that matches **Signature du jeton
  (id_token_signed_response_alg)** (default `RS256`; an asymmetric one). Symmetric and unsigned algorithms are
  never accepted.

Then in the drawer: **Adresse de l'émetteur (issuer)** (exactly as the provider announces it, such as
`https://sso.example.lan/realms/entreprise`), **Identifiant client (client_id)**, **Secret client
(client_secret)**, **Groupes requis** (the group names as they appear in the claim), and under **6. Avancé**
(Advanced). Every standard field carries its OpenID Connect name in brackets, to find the same field in the
console of the provider:

| Field (setting)                                                                                | Default                | Meaning                                                                                                        |
| ---------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Authentification client (token_endpoint_auth_method)** (`client_auth`)                       | `basic`                | **En-tête (client_secret_basic)** or **Corps de requête (client_secret_post)**; the check verifies the provider supports it |
| **Signature du jeton (id_token_signed_response_alg)** (`id_token_alg`)                         | `RS256`                | Must be announced by the provider and have a published key                                                     |
| **Portées (scope)** (`scopes`)                                                                 | `openid profile email` | Space separated, `openid` mandatory; add the one that releases groups if the provider needs it                 |
| **Revendication sujet (sub)** (`subject_claim`)                                                | `sub`                  | The stable key of the person. Never a name that can be reassigned                                              |
| **Revendication nom (preferred_username)** (`username_claim`)                                  | `preferred_username`   | The login name; the Elpis name is derived from it                                                              |
| **Revendication e-mail (email)** / **affichée (name)** (`email_claim`, `name_claim`)           | `email`, `name`        | Shown by the sign-in trial (the email only when `email_verified` is true); not kept on the account             |
| **Revendication groupes (groups)** (`groups_claim`)                                            | `groups`               | A dotted path (`realm_access.roles`) works                                                                     |
| **Âge max., s (max_age)** (`max_age_sec`)                                                      | `0`                    | Asks the provider for a recent authentication, 0 to 604800; 0 asks nothing                                     |
| **Écart d'horloge, s** (`clock_skew_sec`)                                                      | `60`                   | Clock difference tolerated, 0 to 300                                                                           |
| **Session, s** (`session_max_age_sec`)                                                         | `0`                    | Session length for this provider, 0 to 2592000; 0 follows the global session length                            |

Starting a sign-in is limited per client address (in IPv6, per /64 prefix), and the number of sign-ins in
progress is capped per address and per provider; at the per-address cap the oldest sign-in in progress of the
address is dropped instead of refusing the new one. On the way back, a request takes an allowance token only
when it carries no live sign-in of the browser. Behind a reverse proxy, declare it as a trusted proxy
(`ACCESS_LOG_TRUSTED_PROXIES`, see [configuration.md](configuration.md#environment-variables)): otherwise
every person appears to come from the address of the proxy and shares one allowance.

A login name drawn from the email claim (or from the claim that holds the email) only creates an account, or
updates the login kept with the identity, when `email_verified` is true; otherwise the sign-in is refused
(`name_invalid`) and the trial says so.

The **subject** is what ties an account to the provider: choose a claim that is unique to the person and
never changes. The trial warns when the subject equals the login name.

### Requiring a second factor

Set the second factor at the provider, then make Elpis require it, in section **4. Accès** of the drawer,
with three space-separated lists (empty means no requirement):

- **Niveaux exigés (acr)** (`required_acr`): a sign-in is accepted only when the identity token carries one
  of these `acr` values, compared exactly.
- **Niveaux qui prouvent un second facteur (acr)** (`mfa_acr`, empty by default): the `acr` values your
  provider issues only after a second factor. **Only these levels prove a second factor.** Elpis never
  infers it from the name or the number of a level: each provider names its levels its own way (at
  LemonLDAP::NG, `loa-2` is a password alone).
- **Méthodes exigées (amr)** (`required_amr`): a sign-in is accepted only when the token carries one of these
  `amr` methods, compared without regard to case.

Any one value of each list is enough to sign in. A level declared in `mfa_acr` must be one the token can
carry: when `required_acr` is set, a declared level that is not in it never gets through the sign-in.

**How the levels are requested.** The whole `required_acr` list is sent to the provider in one `acr_values`
parameter, and providers do not read it the same way: Keycloak aims at the lowest level of the list,
LemonLDAP::NG takes the first value it knows as the minimum for everybody (with `loa-5 loa-2`, every person
has to raise their session; with `loa-2 loa-5`, nothing changes). A single list therefore cannot say "a
password for users, a second factor for administrators"; leave the choice to the provider (by group or by
role) and let Elpis check the proof. **Contrôler les réglages** warns when `required_acr` holds several
values: check them with **Se connecter pour essayer**.

The fixed line under the fields says what Elpis guarantees, by the rule the server applies at sign-in:

- **Second facteur exigé pour tous les comptes : …** (Second factor required for all accounts), when every
  token that can sign in proves a second factor: every value of `required_acr` is declared in `mfa_acr`, or
  every listed `amr` is `mfa` or `mca`.
- **⚠ Second facteur exigé des administrateurs seulement : les autres comptes peuvent entrer avec …** (Second
  factor required from administrators only: the other accounts can sign in with …; **sans second facteur**,
  without a second factor, when nothing is required to sign in), when the settings invite the provider to a
  second factor (see below) and **5. Rôles et groupes** gives the administrator role through groups, but a
  value that proves nothing is enough for the others: with `required_amr` set to `pwd otp`, a token carrying
  only `pwd` signs in an ordinary account; with `required_acr` `loa-2 loa-5` and `mfa_acr` `loa-5`, a token at
  `loa-2` does.
- **⚠ Administrateurs toujours refusés : …** (Administrators always refused), when administrator groups are
  set and `required_acr` is filled, but none of its values is declared in `mfa_acr` and `required_amr` holds
  no strong method: the token of a sign-in always carries an undeclared level, so an administrator is refused
  unless the provider happens to send strong `amr` methods. `./elpis doctor` says so as well.
- **⚠ Aucun second facteur garanti par Elpis** (No second factor guaranteed by Elpis) otherwise: Elpis then
  checks no proof for anybody, administrators linked to the provider included.

Becoming an administrator through a group is judged on what the received token proves. The settings only
have to invite the provider to a second factor: `required_amr` lists at least one method of possession or
inherence (for example `pwd otp`), `mfa` or `mca`, or `mfa_acr` declares at least one level. `pwd` alone, or
`required_acr` without `mfa_acr` whatever its levels are called, invites to nothing: administrator groups are
then refused when you save. Then, at each
sign-in, the token must carry `mfa` or `mca` in `amr`, or two methods of different families (RFC 8176:
knowledge `pwd` `pin` `kba`; possession `otp` `hwk` `swk` `sms` `tel` `sc`; inherence `face` `fpt` `iris`
`retina` `vbm`), or an `acr` declared in `mfa_acr`. A sign-in whose token lists an administrator group without
such a proof is refused (`mfa_required`, cause `admin_without_mfa`), even when it satisfies the settings: with
`required_amr` set to `pwd otp`, a token carrying only `pwd` is refused. A refusal shows "Une vérification en
deux étapes est exigée".

Examples, as played against real servers:

- **Keycloak**, one-time password asked by the sign-in flow to the administrators only: prove it with the
  methods, **Méthodes exigées** `pwd otp`, `mfa_acr` empty. The `acr` of Keycloak (`1`, or `0` when a session
  is reused) says nothing about the one-time password here. See [Keycloak](#keycloak) for the `amr` claim.
- **LemonLDAP::NG** sends no `amr` (version 2.20): only `acr` proves the second factor. With its default
  levels (`loa-2` after the password, `loa-5` after a one-time password), declare `loa-5` in **Niveaux qui
  prouvent un second facteur** and leave **Niveaux exigés** empty (or `loa-2 loa-5`, in that order). With
  levels renamed to numbers (`1` after the password, `2` after the one-time password), declare `2`.

### Keycloak

- Client: **Client authentication** on, **Standard flow** on; in advanced settings set the PKCE method to
  `S256`. Issuer: `https://sso.example.lan/realms/<realm>`. Subject `sub`, login `preferred_username`.
- Groups: add a **Group Membership** mapper with the claim name `groups`, **Add to ID token** on. Turn **Full
  group path** off, or enter the group with its leading slash.
- **A person who belongs to no group has no groups claim**: Elpis refuses with `groups_unknown` (the trial
  says **groupes absents ou illisibles**). This is expected for people outside every group; see [Life cycle](#life-cycle)
  for a departure.
- Second factor: set the **AMR reference** of the steps of the sign-in flow (`pwd` on the password step,
  `otp` on the one-time password step) and add an **Authentication Method Reference (AMR)** mapper to the
  client (**Add to ID token** on): without the references the `amr` claim is empty. Then set **Méthodes
  exigées** to `pwd otp`.
- **The sign-in that enrols a one-time password does not prove it.** When the person sets up the one-time
  password as a required action, the token of that sign-in carries only `pwd`: an administrator is refused
  once ("Une vérification en deux étapes est exigée", `admin_without_mfa`) and signs in again, this time with
  the code. Tell your administrators before their first sign-in.
- Sign-out: set the **Backchannel logout URL**, and **Backchannel logout session required** on.
- **Disabling a user in Keycloak sends no logout.** Keycloak calls the back-channel address when a session is
  ended (sign-out, **Sessions › Logout**), not when a user is disabled: the Elpis session of that person stays
  open until it ends (24 hours by default, or the **Session, s** of the provider). To cut it at once, suspend
  the account in **Comptes**, or end the user's sessions in Keycloak before disabling it; the
  non-interactive access stops when the freshness runs out (see [Life cycle](#life-cycle)).

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
- Set **Authentification client** to **Corps de requête (client_secret_post)**: with the header method, a client identifier
  or a secret holding a character other than letters and digits is refused by the provider.
- Expose the groups as a claim through the relying party's attributes, as a list (array type `auto` or
  `always`), and check in the trial that **Groupes** lists them one by one. A person with a single group is
  let in when that group is a required group; a string holding several groups is not a list. If roles or groups
  follow the provider, send a list every time (array type `always`). With a directory behind it, a person
  without any group gets no groups claim at all (`groups_unknown`, **groupes absents ou illisibles**).
- **Second factor**: LemonLDAP::NG sends no `amr`; its `acr` level proves the second factor only once you
  declare it in **Niveaux qui prouvent un second facteur** (`loa-5` with the default level names). See the
  examples of [Requiring a second factor](#requiring-a-second-factor). Do not put the strongest level first
  in **Niveaux exigés**: LemonLDAP::NG would then require it from everybody.

### AD FS

- Create an application group with a **server application** (confidential client) and the return address of
  Elpis. The subject (`sub`) is specific to each client: it is stable for Elpis and different in other
  applications, which is expected.
- Claims must be in the **identity token**: add the `allatclaims` scope to **Portées**, and issue the groups
  and the login name through issuance transform rules (for example the Active Directory `sAMAccountName` as
  an outgoing claim named `username`, the groups as `group`). Then set **Revendication nom** and
  **Revendication groupes** to those names. Check them in the trial.
- AD FS sends a person's single group as one string: the person is let in when it is a required group. If
  roles or groups follow the provider, Elpis needs a list every time: issue the groups so that at least two
  values are always present, or leave roles managed in Elpis.

### Microsoft Entra ID

- Register an application with a **client secret** and the return address of Elpis (platform **Web**).
  Issuer: `https://login.microsoftonline.com/<tenant id>/v2.0`, with the identifier of **your tenant**; the
  shared issuers (`common`, `organizations`) are refused.
- **Put the groups in the identity token** (token configuration, groups claim): they come as a list of group
  identifiers, which is what **Groupes requis** then takes. The user-information endpoint of Entra ID is on
  another host and is not called, so the login name and the groups must be in the identity token.
- A person in too many groups for the token gets no groups claim and is refused (`groups_unknown`): limit the
  claim to the groups assigned to the application.
- **The v2.0 identity token may carry neither `amr` nor `acr`.** Microsoft's public reference of the identity
  token claims lists neither of them. If you set `required_amr` or `required_acr`, everybody is then refused
  (`mfa_required`) and administrator groups cannot be used. Run the sign-in trial first to see what your tenant
  really sends; if nothing usable arrives, require the second factor in Entra ID (conditional access) and keep
  the administrators as local accounts.
- **Entra ID is a cloud service**: the Elpis server must reach the Internet (`login.microsoftonline.com`) for
  discovery, keys and token exchange.

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
API tokens and the access granted to applications by the account, which the person must create again. An administrator or moderator account needs an explicit confirmation, the
last local administrator cannot be linked, and a suspended account must be reactivated first.

On the page, card **3. Comptes existants** (Existing accounts), available as soon as a provider is saved:
  choose the **Fournisseur** (preselected when there is only one), the **Compte local**, enter the
  **Identifiant attendu chez le fournisseur** (Expected identifier at the provider: the value of the login claim: letters, digits,
  `.`, `_`, `@` and `-`, 255 characters at most, compared exactly except for the case), click **Préparer le
  rattachement** (Prepare the link). It is valid for 30 days. A login that is an email address matches only
  when the provider says the email is verified. On their first sign-in the person enters their old Elpis
  password **once** ("Relier mon compte", Link my account); the link is made and the password removed. After
  five wrong passwords the prepared link is deleted and you must prepare it again. A ticked **Identité vérifiée
  hors ligne : ne pas demander l'ancien mot de passe** (Identity verified offline: do not ask for the old
  password) skips that step; it exists for ordinary users only, and such a link is valid 72 hours.
  Administrators and moderators always prove their old password and the console asks for a confirmation (the
  box stays on the card, greyed out for an ordinary account).
  Changing the **Revendication nom** of the provider deletes its prepared links. A prepared link always
  revokes the personal API tokens and the application access of the account.

**Detaching.** **Comptes** (Accounts), the **Détacher** (Detach) icon of the row: the account becomes local
again with a temporary password you type (to change at the next sign-in); its sessions, tokens and grants are
revoked. You cannot detach your own account.

**One identity per account.** An account is tied to one identity of one provider. The same person declared
at two providers is two identities: when both give the same login name, the second is refused (`conflict`);
otherwise it gets an account of its own. An account already linked cannot be linked to a second provider. To move an account from one
provider to another, detach it, then prepare its link to the other provider (card **3. Comptes existants**).
When the sign-in trial says that an account linked to a provider already has the name, rename the login at one
of the providers (that identity then gets an account of its own), or delete the extra Elpis account in **Comptes**.

## Roles and groups from the provider

By default Elpis decides nothing about roles and groups: accounts created by a provider are ordinary users, and
an administrator gives roles and groups in the console. Two independent options, both **off by default** and
set per provider, let the provider decide instead:

| Setting                  | Default | Meaning                                                                                                   |
| ------------------------ | ------- | --------------------------------------------------------------------------------------------------------- |
| `roles.enabled`          | `false` | The role (user, moderator, administrator) of the accounts of the provider follows their groups            |
| `roles.admin_groups`     | `[]`    | Up to 20 groups whose members are administrators, no duplicate                                            |
| `roles.moderator_groups` | `[]`    | Up to 20 groups whose members are moderators, no duplicate                                                |
| `group_map.enabled`      | `false` | The membership of some Elpis groups follows the groups of the provider                                    |
| `group_map.map`          | `[]`    | Up to 50 pairs `{external, group_id}`: the external group, and the identifier of the Elpis group it feeds |

The groups are written exactly as for **Groupes requis**: the exact value found in the groups claim of the
identity token. The match is exact, never partial. A group of the
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
- **One membership that cannot be read changes nothing.** If a single group to read is unreadable (no groups claim in the token, or one that is not a list), neither the role nor the groups of that person change.
  An unreadable answer is never taken as "not a member".

When the decision is applied:

- **At each successful sign-in**, in both directions: the role goes up or down, groups are added or removed. An
  account created at a first sign-in gets its role and groups at once. The sign-in that completes a link with
  the old password (single sign-on) may lower the role at once, before the session opens; a promotion, and
  any addition, waits for the next sign-in.
- A **demotion closes the sessions** of the person. Elpis never demotes the last active administrator that has
  a local password.
- The **role of such an account can be lowered by hand, never raised**: for every account attached to a
  provider whose `roles.enabled` is on, **Comptes** only offers the current role and the lower ones, shown
  with the mark **géré par le fournisseur** (managed by the provider), and the console refuses a promotion. The
  role is recalculated from the groups at the next sign-in. The change is recorded as `admin.user.role` with
  `role_managed`.

**Administrator groups.** Giving the administrator role through groups is a deliberate step. When you save a
provider with administrator groups, when you create it or change them, the save is refused until you confirm
explicitly that their members become administrators: the drawer asks you to type **administrateur**. The
confirmation is asked again when the way the groups are read changes: the groups claim, `required_acr`,
`required_amr` or `mfa_acr`. The provider must also be invited to a second factor (a level declared in
`mfa_acr`, or a `required_amr` with a method of possession or inherence, `mfa` or `mca`; see
[Requiring a second factor](#requiring-a-second-factor)), otherwise the settings are refused; administrator
groups of a provider that does not require one are ignored, and `./elpis doctor` warns about
it. At sign-in the received token must prove the second factor, or the sign-in is refused. A mapping to an Elpis group that does not exist is refused when you save.

**In the drawer.** The section **5. Rôles et groupes** (Roles and groups) is folded by default. Its first box,
**Donner les rôles d'après les groupes du fournisseur** (Give roles from the provider groups), turns on the
role decision; **Groupes administrateurs** (Administrator groups) and **Groupes modérateurs** (Moderator
groups) take the groups, one at a time, with **Ajouter**. The second box, **Affecter aux groupes Elpis
d'après les groupes du fournisseur** (Assign Elpis groups from the provider groups), turns on the mapping:
pick the external group (**Groupe du fournisseur**) and the **Groupe Elpis…** (Elpis group) it feeds, then
**Ajouter**. With administrator groups, a fixed notice reminds you that an administrator of Elpis can run
commands on the server. For single sign-on without a second factor, the section asks you to require a
second factor first (section **4. Accès**): with the role decision on, the save stays unavailable and the
foot of the drawer says why; with it off, the save goes through and the groups do nothing yet.

**Changing these settings** follows the general rule: switch the provider off, change them, try again, switch
on. They are part of what the sign-in trial covers.

### Testing the settings

Check what each kind of person would get before switching on, with at least one member of an administrator
group, one of a moderator group and one plain member. A trial creates no account and changes no role or group.

- The result of the [sign-in trial](#the-sign-in-trial) reports the same for the person who
  signed in: the role and the Elpis groups, whether the groups were readable, the mapped Elpis groups that no
  longer exist, and whether the administrator groups are ignored for lack of a second factor.

The security journal records `auth.role.sync` when a role changes and `auth.groups.sync` when groups are added
or removed (see [audit-events.md](audit-events.md#authentication)). `./elpis doctor` notes the providers whose
roles or groups are managed.

## Life cycle

**Groups are read at every sign-in.** A person already linked who signs in with their groups, none of them a
required group, is refused and their account is suspended; it is reactivated at their next sign-in once they
are back in a group, unless an administrator suspended it. A provider that supports back-channel logout ends
sessions as it decides (see [Sign-out](#sign-out)).

**A person removed from all their groups is refused, not suspended.** Keycloak and LemonLDAP::NG (with a
directory) leave out the groups claim of a person who has no group left. Elpis reads a missing claim as
"groups unknown", never as "no group" (a provider can also omit it for other reasons): the sign-in is refused
(`groups_unknown`) and nothing is changed on the account. Its non-interactive access (personal tokens, OAuth
grants, routines) stops when the freshness runs out (below). To cut everything at once, suspend the account
in **Comptes**; to have departures suspended at the next sign-in, keep a group that everybody has at the
provider (a default group), so that the claim is always sent.

**Freshness.** Access that does not go through an interactive session (personal tokens, OAuth grants,
scheduled runs of routines) is refused for an account whose identity was not confirmed for **Fraîcheur
(jours)** (`freshness_days`, 14 by default, 1 to 90). A person confirms their identity by signing in
interactively, so a person who relies on tokens signs in at least
that often. A provider that is off or deleted confirms nothing: the access of its accounts is refused.
Background wake-ups of conversations (the turns a finished job starts on its own) follow the same rule as
scheduled routines: no wake-up and no watch for an account whose access is stale.

**Local accounts when the local mode is "Administrateurs seulement".** The same non-interactive accesses
(personal tokens, OAuth grants, routines, webhooks, wake-ups) of a local account that is not an administrator are
refused as stale. Nothing is deleted: they work again as soon as the mode is back to "Tous les comptes". The
console says so when the mode is switched.

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
Sécurité (`auth.login.denied`, `details.ref`). Repeated refusals from the same address, for the same cause and
provider, are summarized: only the first one of a minute keeps its reference in the journal, so a reference may
be missing there; refusals of different causes are never merged. All the
reasons are listed in [audit-events.md](audit-events.md#authentication).

| Message shown                                                                        | Code (`auth_error`) | Probable cause                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Votre compte n'est pas autorisé à utiliser Elpis. Demandez à votre administrateur." | `not_in_group`      | Not in a required group (check the group value in the trial)                                                                                                                                      |
| (same message)                                                                       | `groups_unknown`    | No groups claim (Keycloak and LemonLDAP::NG leave it out for a person without group), not a list of strings, or too many groups for the token                                                     |
| (same message)                                                                       | `conflict`          | An account already has the derived name, the name is invalid or reserved, or the prepared link does not match                                                                                     |
| (same message)                                                                       | `suspended`         | Account suspended: at a sign-in without a required group, or by an administrator                                                                                                                  |
| "Une vérification en deux étapes est exigée. Reconnectez-vous en la validant."       | `mfa_required`      | `acr` / `amr` of the token do not match **required_acr** / **required_amr**, or an administrator group without proof (`admin_without_mfa`; Keycloak: the sign-in that enrols a one-time password) |
| "Connexion refusée par le service de votre organisation."                            | `denied`            | The provider answered with an error (person refused or cancelled there)                                                                                                                           |
| "La connexion a pris trop de temps. Réessayez."                                      | `expired`           | The sign-in was too long, was opened from another address than the public one, or the browser blocked cookies                                                                                     |
| "Le service de connexion de votre organisation ne répond pas…"                       | `unavailable`       | Provider unreachable, discovery or keys unreadable, client secret missing, no local administrator left                                                                                            |
| "La connexion n'a pas abouti. Réessayez ou demandez à votre administrateur."         | `failed`            | Anything else: token rejected (signature, issuer, audience, nonce, expiry: `lib:<code>`), clock difference, subject missing                                                                       |
| (same message)                                                                       | `failed`            | `client_auth_rejected` in the journal: the provider refused the client secret; check it, then try the other client authentication method                                                          |
| (same message)                                                                       | `failed`            | `aud_untrusted` in the journal: the identity token lists another audience than Elpis                                                                                                              |
| (same message)                                                                       | `failed`            | `iss_mismatch` in the journal: the answer does not come from the configured issuer                                                                                                                |
| (same message)                                                                       | `failed`            | `alg_unexpected` in the journal: the identity token is signed with another algorithm than **Signature du jeton**; set the one of the client at the provider                                       |

Other messages: "Cette demande a expiré. Reconnectez-vous par le service de votre organisation." (the
old-password step waited too long), "Cette demande n'est plus valable. Reconnectez-vous par le service de votre
organisation ou demandez à votre administrateur." (the prepared link is gone: expired, deleted, or five wrong
passwords) and "Trop de tentatives, réessayez dans un instant." (rate limit).

Commands on the host, described in [operations.md](operations.md#sso-openid-connect-emergency-exit):

- `./elpis auth status`: public address, local mode, and per provider switched on (`activé`), active (`actif`)
  and tested (`testé`). A provider that is on but not active (`actif non (inopérant)`, **Inopérant** in the
  console) has an unmet condition (sign-in trial, secret, groups, public address).
- `./elpis doctor` (or `./elpis auth doctor`): provider state, certificate authorities nearing their end,
  providers whose roles or groups are managed, last local
  administrator.
- `./elpis auth off`: switches every provider off and reopens the local password to everyone. Use it when the
  provider is the problem and nobody can sign in.
- `./elpis auth reactivate <account>`: lifts a suspension from the host.

## Security, in plain terms

- **What crosses Elpis.** The person's password is typed at the provider and never reaches Elpis.
- **What is stored.** The client secret lives only in the secrets vault (as instance
  secrets, never in `config.json`) and no route returns them. `config.json` holds the settings and the pasted
  certificate authority. For each linked account Elpis keeps the provider, its issuer, the stable key
  (subject) and the login last read, with when the link was made and last confirmed: no email and no name of
  the provider. While a session opened by the provider lasts, its identity token is kept encrypted for the
  sign-out at the provider; the result of the last sign-in trial (with the email and name it showed) is kept
  for the console until the next trial or until the provider is switched off or deleted.
- **What is logged.** The security journal records sign-ins and refusals, links, suspensions, provider changes
  and tests (see [audit-events.md](audit-events.md#openid-connect-single-sign-on-admin)). Passwords, secrets, tokens and
  anything the provider says in its own words are never logged; a typed login is only kept as a hash.
- **TLS is always verified.** There is no switch to disable certificate verification. Without a trusted
  authority **Contrôler les réglages** fails and tells you to paste yours. The server name is checked against the subject
  alternative names only, and only forward-secret, authenticated cipher suites are accepted.
- **Trust.** The provider is trusted to say who a person is and which groups they belong to.
  The host name of Elpis is its trust boundary: dedicated to it, in HTTPS. See [SECURITY.md](../SECURITY.md).
- **Behind a NAT.** Starting a sign-in shares the rate of the client address (a bucket of 50, refilled every
  15 seconds), and when the number of flows in progress for an address reaches its ceiling the oldest flow of that
  address is evicted. Behind one shared address (NAT, proxy), a hostile host can therefore exhaust the bucket and
  make colleagues' starts fail (429), or cut the flow of a colleague who starts at the same moment, who then
  simply starts again. The return of the provider is not affected.
- **The settings are written only by the console** (and `./elpis auth off`): neither the raw editor nor the
  configuration API can create or overwrite the `auth` section.

## Compatibility

What follows comes from two kinds of proof. **Played on a real server**: the whole journey (test, sign-in,
refusals, sign-out) ran against that product in a container. **Played on its profile**: the automated tests
replay what the product documents (discovery, token shapes, group formats) against a local provider. A product that is not listed has not been looked at; one that follows the standards below should
work, and **Contrôler les réglages** then **Se connecter pour essayer** will say so.

### What Elpis expects from any server

- **TLS 1.2 or 1.3** with a forward-secret key exchange (ECDHE or DHE) and an authenticated cipher (AES-GCM
  or ChaCha20-Poly1305). Servers that only offer static RSA key exchange or CBC ciphers are refused.
- **A certificate that names the server in its subject alternative names.** The common name is not read, and a
  wildcard only counts as a whole first label (`*.example.lan`). An address given as an IP needs an IP entry.
- **OpenID Connect**: discovery, authorization code flow with PKCE S256, a confidential client
  authenticated by its secret (header or request body), an identity token signed with an asymmetric algorithm
  (RS256, RS384, RS512, PS256, PS384, PS512, ES256, ES384, ES512 or EdDSA), and the token and key endpoints on
  the same origin as the issuer.

### Identity providers

| Provider                                | Status                  | Settings and limits                                                                                                                                                                   |
| --------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keycloak                                | Played on a real server | See [Keycloak](#keycloak). Sign-out both ways                                                                                                                                         |
| LemonLDAP::NG                           | Played on a real server | See [LemonLDAP::NG](#lemonldapng): client authentication in the request body; second factor through a declared `acr` level (no `amr`); a single group sent as a string was played too |
| Dex                                     | Played on a real server | Add the `groups` scope. No sign-out at the provider                                                                                                                                   |
| Providers built on `node-oidc-provider` | Played on a real server | RS256, PS256, ES256, ES384 and EdDSA, both client authentication methods, pushed authorization requests, sign-out both ways                                                           |
| Microsoft Entra ID                      | Played on its profile   | See [Microsoft Entra ID](#microsoft-entra-id): groups in the identity token, issuer of your tenant                                                                                    |
| AD FS                                   | Played on its profile   | See [AD FS](#ad-fs)                                                                                                                                                                   |
| Authentik                               | Played on its profile   | See [Authentik](#authentik): a signing key is mandatory                                                                                                                               |
| Okta                                    | Played on its profile   | Standard settings; create a `groups` claim                                                                                                                                            |
| GitLab                                  | Played on its profile   | The groups are read at the user-information endpoint (full group paths). No sign-out at the provider                                                                                  |
| Authelia                                | Played on its profile   | Add the `groups` scope; the groups and the login name are read at the user-information endpoint                                                                                       |
| Kanidm                                  | Played on its profile   | ES256, client authentication in the header, `groups` scope                                                                                                                            |
| Auth0, Ory Hydra                        | Played on its profile   | Type the issuer with its final slash. Auth0: put the groups in a claim with a plain name                                                                                              |
| Zitadel                                 | Played on its profile   | Provide the groups as a list of strings (an Action); its native roles claim is an object and is not read                                                                              |
| OneLogin                                | Played on its profile   | Add the `groups` scope                                                                                                                                                                |
| Google, Amazon Cognito                  | Not supported           | Their token and key endpoints are on other hosts than the issuer. Put an identity broker you run (Keycloak, Dex) in front                                                             |

- **Groups are a list of strings.** A claim holding one string lets the person in when it is exactly a
  required group and neither roles nor groups follow the provider; otherwise a list is required. Several
  groups glued in one string (`a;b`) are never split, and are read as no groups (**groupes absents ou illisibles**).
- **Back-channel sign-out** needs a provider that sends logout tokens (Keycloak and `node-oidc-provider` were
  played on real servers). A logout token without an expiry is accepted when it is recent; one listing another
  audience than Elpis is refused.
- **Not read**: a claim whose name is an address (`https://…`), a signed or encrypted user-information
  answer, an encrypted identity token, an issuer shared by several tenants.
- **A required group is mandatory**: a provider that cannot say which groups a person belongs to cannot be
  switched on.
