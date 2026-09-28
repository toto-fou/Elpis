# Security policy / Politique de sécurité

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.
Use the private vulnerability reporting of the repository hosting service
("Security" tab → "Report a vulnerability"), or contact the maintainers
privately. Include:

- the affected version or commit,
- a description of the problem and its impact,
- the steps to reproduce it (a minimal proof of concept if possible).

We aim to acknowledge a report within 7 days and to publish a fix, with
credit if you wish, once it is available.

## Signaler une faille

Merci de **ne pas ouvrir de ticket public** pour un problème de sécurité.
Utilisez le signalement privé de vulnérabilité de l'hébergeur du dépôt
(onglet « Security » → « Report a vulnerability »), ou contactez les
mainteneurs en privé, avec la version concernée, l'impact et les étapes pour
reproduire.

## Scope / Périmètre

Elpis runs code on behalf of users inside a per-user Docker sandbox. Reports
about escaping that sandbox, crossing user boundaries, authentication or
session handling, and server-side request forgery are especially welcome.
Deployments that expose the `desktop-agent` or the tool host without
authentication are outside the supported configuration.
