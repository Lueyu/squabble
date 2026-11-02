# 🔒 Privacy and data flow

[简体中文](privacy.zh-CN.md) · [Security](../SECURITY.md) · [Self-hosting](self-hosting.md)

**Research-team connections and tools:** separately saved model keys receive the same server-side encryption as the default key. Each selected provider receives that member's bounded research context, including relevant user notes and previous replies. Optional DeepSeek web search sends a ticker and a bounded research query; it has a separate request-usage ledger. SEC requests contain public issuer identifiers. Team configuration, messages, cited evidence and reports are stored in your instance. See [data-source boundaries](research-data.md).

Squabble supports a local Docker Compose installation and a standalone Windows
or macOS desktop installation. Both keep the application database under your
control. Squabble does not operate a hosted account service. Local installation
does **not** mean offline operation: public quotes and currency rates use
external providers even when you have not configured an AI key.

The desktop app requests the GitHub Releases API only when you choose **Help →
Check for Updates**. The request includes the installed version in its
User-Agent, and GitHub receives normal network metadata such as your IP
address. It does not upload portfolio records or database contents.

This guide describes the current repository's behavior. It is a technical trust
guide, not a privacy notice for every website running Squabble or a claim of
legal compliance. The project is in public beta; the gaps below matter when
deciding where to keep real portfolio records.

## 👥 Who can access your data?

| How you use Squabble | What that means |
|---|---|
| **Local Docker Compose** | Records live in the PostgreSQL Docker volume and any backups you make. The repository maintainers do not receive them through a bundled central collection service. Anyone with access to your computer, Docker volumes, or backups is part of the trust boundary. |
| **Desktop app** | Records and application secrets live in Squabble's application data directory on your computer. On Windows this is normally `%APPDATA%\Squabble`; on macOS it is normally `~/Library/Application Support/Squabble`. Anyone with access to that directory or its backups is part of the trust boundary. |
| **You use an external integration** | Relevant data also reaches the selected AI, financial-data, notification, or agent service. Their handling of it is outside this repository's control. |

Squabble does not provide a hosted account or sync service. If a third party
independently operates an instance, that operator controls its database and
secrets and can access stored records. Account separation in the app does not
prevent infrastructure administrators from reading data.

**Saved API-key encryption is not zero knowledge.** The server holds the
decryption key and decrypts credentials to use them. An operator with access to
both the database and server secrets can do the same. Portfolio records are not
end-to-end encrypted.

## 💾 What is stored, and where?

“Instance database” below means the database in your Docker installation or
desktop application.

| Data | Storage and handling |
|---|---|
| Account | Username, display name, bcrypt password hash, SHA-256 recovery-code hash, session version, and timestamps in the instance database. Registration requires no phone number, real name, or verified email. Optional notification recipients may include an email address. |
| Portfolio workspace | Holdings, cash accounts, transactions, watchlists, journals, snapshots, imported rows and import history in the instance database. Free-text fields can contain personal information you enter. |
| Research and automation | Reports, evidence, model-generated arguments and summaries, risk checks, execution steps, run events, strategy rules, and Agent Builder preferences/prompts in the instance database. Reports distinguish basic rules from AI analysis. |
| Council discussions | Full user notes, member names/preferences, frozen profile configuration and version, candidate orders, collected evidence snapshots, member replies and report versions in the instance database. Old revisions remain saved when new input invalidates them. An approved report can link to its paper order. |
| Model budget | Per-user limits, optional estimated prices, model and task identifiers, request purpose, reserved/reported token counts, status and timestamps in the instance database. The budget ledger does not itself store prompt bodies. Failed or interrupted requests can retain their reserved usage. |
| Paper trading | Paper accounts, positions, orders, trades, proposals, and manually recorded execution notes in the instance database. Paper records use separate tables from real holdings and transactions. |
| Saved LLM and Finnhub credentials | Encrypted with AES-256-GCM in the instance database. Settings responses expose status and a masked suffix, not the full saved key. The server decrypts the key when making a provider request. |
| Notification configuration | Destinations, webhook URLs, bot tokens, SMTP credentials, and other channel settings in the instance database. **These fields do not currently use the LLM/Finnhub credential-encryption mechanism** and are returned to the owning user's channel settings. |
| Browser or desktop webview storage | Access and refresh tokens, interface preferences, and screenshot-recognition provider settings, including its API key, in local storage. In the desktop app, this storage belongs to Squabble's application data directory. The screenshot-recognition key is separate from the saved analysis key. |
| Screenshot recognition | The image and recognition credentials pass through the instance server to the selected vision endpoint. The current extraction handler does not persist those inputs to the database; confirmed imported rows and import history are stored. |
| Operational data | The application writes browser-console and server logs. Authentication rate limiting keeps temporary IP-based counters in server memory. Operators, reverse proxies, hosts, and external providers may keep additional request or error logs. |

There is no bundled analytics SDK or central usage-reporting service in this
repository. **That does not mean there are no logs, network requests, or
third-party records.** A deployment can add its own monitoring.

## 📤 What leaves the instance?

| Action | Recipient and information sent |
|---|---|
| Quotes, symbol search, and FX updates | Public market-data sources such as Tencent, Sina, and Yahoo receive symbols or search queries; Frankfurter receives currency queries. These services also see normal connection metadata. This traffic exists in basic mode, without a personal API key. Some public quote/search endpoints currently use HTTP. |
| AI analysis | The resolved model endpoint receives research prompts, evidence, and selected portfolio context, which can include holdings, quantity, cost, market value, and portfolio weight. It receives the provider key needed to authenticate the request. |
| Agent Builder AI review | When enabled, the model receives the custom prompt and candidate-signal context. Explicit rule evaluation itself does not require an LLM. |
| Investment council | The configured model receives member preferences, profile/candidate context, selected evidence excerpts, full user notes included in the request, and previous member opinion excerpts for the manager. Pausing cannot retract a request already sent. Full discussion records and evidence snapshots remain stored on the instance even when only excerpts are sent. |
| Finnhub research | When configured, Finnhub receives the API key and company/symbol queries for available research data. |
| Screenshot recognition | The chosen vision endpoint receives the full submitted image, extraction prompt, and recognition API key through the instance server. Crop unrelated names, account numbers, and balances before submitting. |
| Notifications | Enabled Webhook, Bark, ServerChan, SMTP, or Telegram channels receive event messages and required routing/authentication information. Proposal messages may include the symbol, direction, paper quantity, and rationale. A channel test also sends a message. |
| Connected agents | An agent you give a session token can receive data exposed by its permitted tools. Any external agent or model it uses has its own data handling. The optional legacy gateway is a separate operator-controlled integration. |

Model and financial connection tests can also make provider requests and incur
usage. Check the selected provider's own retention and data-use terms; this app
cannot set them or retract data already delivered.

The research budget applies to calls through the shared server LLM client, including model connection tests and retries. Screenshot recognition/OCR uses a separate path and is not covered. Conservative reservations and user-entered cost estimates are not provider bills. See the [council and budget guide](investment-council.md).

### Basic mode and the operator's model key

Analysis uses your saved personal LLM configuration first. If you have no
personal configuration and the operator sets `DOUBAO_API_KEY`, it uses that
server-provided model. If neither is configured, basic reports run rules on the
instance server without an LLM call; quotes and FX can still use the network.

**Deleting your personal model configuration can reactivate the operator's
model.** It is not an “all AI off” switch. The current app has no separate
per-user consent control for that fallback. Check the active configuration in
Settings before running analysis. A broken saved key stops analysis and
asks for re-entry; it does not silently switch to the operator's model.

## 🛡️ Controls today

- **Settings:** view the active integration source; replace or remove saved
  LLM/Finnhub settings. Removing Finnhub returns research to public sources.
  Revoking a key at its provider is a separate action.
- **Notifications and agents:** disable or delete notification channels; pause
  Agent Builder or disable its AI review/proposal notifications; revoke agent
  sessions you no longer use.
- **Council and budget:** pause a discussion, disable the council for a Builder profile, and change per-user model limits. Pausing stops later work; an in-flight provider call may still finish. Full notes and report history are retained, and resuming does not reset the discussion's task allowance.
- **Account recovery:** save the one-time recovery code offline. Recovery resets
  the password, replaces the code, and revokes earlier account and agent
  sessions. Generating a new code with your password replaces the old code and
  revokes earlier account sessions. There is no email-based recovery flow.
- **This browser or desktop app:** sign out to clear session tokens. Clear the
  site's browser storage or the desktop app's webview storage to remove locally
  saved recognition credentials and preferences; signing out alone does not
  clear all of them.
- **Your own installation:** control access to the database, application data,
  backups, logs and integration settings. For Docker Compose, back up the
  PostgreSQL volume and the settings-encryption key together. For desktop,
  quit the app before copying its application data directory. Changing or
  losing the settings key makes existing saved provider keys unreadable until
  users re-enter them.

## ⚠️ Gaps and current gaps

The project does **not** implement a general retention schedule or automatic
expiry for portfolio records, reports, logs, and backups. Their lifetime depends
on the instance and its operator. Deleting a live record or saved setting does
not remove copies in backups, logs, or external providers.

Complete self-service account erasure and account-wide data export are not yet
available. A comprehensive administrator-access audit and privacy-consent UI
are also not complete. Existing analysis run events are not an audit of every
administrator or database access. Do not assume an independently hosted
instance offers these controls because this guide describes them as gaps.

If you operate an instance for other people, publish a **separate, truthful
instance privacy notice** before inviting them. Describe who operates it, an
actual contact route, where records and backups live, your logging and retention
practices, enabled providers and fallback model, and how you handle export or
deletion requests. Do not copy self-hosting language that says users alone hold
the database. This repository does not identify an official hosted service or
supply operator-specific contact details or terms.

## ✅ Verify implementation

Start with the [database schema](../server/database/schema.ts),
[authentication](../server/modules/auth/auth.service.ts),
[provider settings](../server/modules/settings/settings.service.ts),
[credential encryption](../server/modules/settings/settings-security.ts),
[model calls](../server/modules/multi-agent/llm.service.ts),
[screenshot recognition](../server/modules/import/ocr.service.ts), and
[notification delivery](../server/modules/notifications/notification.service.ts).
Review deployment configuration and dependencies as well as application calls
when checking outbound traffic. Report sensitive discrepancies through the
[security reporting route](../SECURITY.md).
