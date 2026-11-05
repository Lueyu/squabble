# Public server deployment

[简体中文](public-deployment.zh-CN.md) · [Local installation](self-hosting.md) · [Privacy](privacy.md)

Squabble currently supports two installation paths: the standalone Windows or
macOS desktop app and a clean local Docker Compose installation. It does not
operate a hosted account service or provide a supported public server
deployment. The earlier single-server beta instructions have been retired.

For a personal installation, use the [local installation guide](self-hosting.md).
The default Compose setup binds the app to your computer's loopback interface;
it is intended for access from that computer. The optional demo setup uses
fictional sample data and is not suitable for real accounts.

Desktop and the source example use `AUTH_MODE=local` for direct workspace access.
That mode requires loopback binding and no proxy trust; never publish it through
a reverse proxy or tunnel. Docker retains account authentication. Any independently
operated remote deployment must retain `AUTH_MODE=account` and its access controls.

If you independently expose a modified installation to other people, you
operate that service and hold their database and secrets. You are responsible
for its security, backups, provider terms and an accurate privacy notice.
Squabble's local installation instructions do not cover that operation. The
[privacy guide](privacy.md) explains the application's current data flows and
limitations.
