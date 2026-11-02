# 🔒 Security

Squabble handles portfolio records and integration credentials. Treat the
current release as a **local beta**: the controls described here are useful
boundaries, not an assurance that an instance is ready for unrestricted
public access. See the [privacy and data-flow guide](docs/privacy.md)
([简体中文](docs/privacy.zh-CN.md)) for what the server and providers can access.

## 📨 Report a vulnerability privately

Use this repository's
[GitHub private vulnerability reporting](https://github.com/Lueyu/squabble/security/advisories/new).
Do not put credentials, real portfolio data, or exploit details in a public
issue. We do not publish an alternative security email or a guaranteed response
time here.

Include the affected version or commit, deployment mode, relevant endpoint or
file, reproduction steps, and impact. A minimal proof of concept with test data
helps; it is not required. Test only instances and accounts you are authorized
to assess.

## 🎯 Scope?

- **Account isolation:** reading or changing another account's holdings,
  transactions, reports, settings, notifications, or agent sessions.
- **Authentication and authorization:** login, recovery, token validation and
  revocation, bypasses, and agent/MCP permission enforcement.
- **Secrets and private records:** exposure through APIs, logs, browser storage,
  imports, errors, backups, or provider requests.
- **Server and browser security:** injection, unsafe rendering, server-side
  requests, unsafe uploads, and exploitable dependencies.
- **Installation defaults:** exposed services, sample credentials, local
  account creation, and boundaries between clean and demo installations.

Fictional demo records are intentional. A way to access or modify someone
else's real records is still a security issue. An operator's configuration can
also matter to the report; include enough context to reproduce it.

## 🛡️ Controls and their limits

| Area | Current behavior and boundary |
|---|---|
| Accounts | Passwords use bcrypt; recovery codes are stored as SHA-256 hashes. Bearer access/refresh tokens are kept in browser local storage, so browser compromise or script injection can expose them. |
| Recovery | Account recovery changes the password and code and revokes prior account and agent sessions. Generating a replacement code revokes prior account sessions. There is no email recovery or MFA flow. |
| Record access | Business services use authenticated owner identifiers to scope records. This protects application-level account boundaries; it does not hide records from the server/database operator. |
| Saved provider keys | LLM/Finnhub credentials use AES-256-GCM at rest. The server possesses the decryption secret. This is not end-to-end encryption or zero knowledge, and it does not encrypt all database fields. |
| Other secrets | Notification configuration is stored without that application-layer encryption. Screenshot-recognition credentials are saved in browser local storage and sent through the server for recognition requests. |
| Abuse protection | Authentication has an in-memory, per-process IP rate limiter. It is not a shared rate limiter for multiple replicas or a complete public-service abuse-control system. |
| First account | The clean local stack and desktop app allow one account to be registered. The registration endpoint requires same-origin JSON on a loopback host to prevent a web page from claiming that account through a cross-site form. |
| Auditability | Analysis run events exist. A comprehensive audit of administrator access, privacy-consent controls, account-wide export, and complete self-service account erasure are not yet available. |

## ⚠️ Boundaries the local trust boundary

The supported web stack binds its application port to `127.0.0.1` on the host,
does not publish PostgreSQL, starts with an empty database, and generates stable
JWT and settings-encryption keys in a persistent volume. The desktop app runs
its backend and private PostgreSQL on loopback, with secrets and data under the
user's application data directory. Back up the data and matching keys together;
losing the settings key requires saved provider keys to be re-entered. See the
[local setup and backup guide](docs/self-hosting.md).

The separate `docker-compose.demo.yml` installs a fictional dataset and a
known `demo` / `demo1234` account. Keep it on loopback and never store real
records in it. Do not expose either local installation to the public network
without independently designing authentication, HTTPS, operations, retention,
and instance-specific privacy notice. Public server deployment is not a
supported release path.

Keep the optional agent gateway disabled unless needed, grant connected agents
only necessary access, and review every enabled provider request. A host-wide
model key can send analysis context to a provider even when an account has not
saved a personal key. The repository does not provide a general deletion
schedule or control logs kept by external providers.
