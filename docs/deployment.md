# Self-hosting the prototype

Fox Focus is one Node process with a SQLite workspace file. It does not need a database server, Redis, or a background worker service for the prototype.

## Run it safely

Use the Docker quick start in the [README](../README.md) for a clean local install. It creates a named volume at `/data` in the container. That volume holds both `focus.sqlite` and the generated workspace password.

For an internet-facing installation, keep port 8789 on loopback or a private network. Put a TLS reverse proxy, Tailscale, or another private access layer in front of it. Do not publish the container port directly to the public internet.

The first startup creates a random password at `/data/workspace-password` with mode `0600`. Sign in with the fixed username `fox`. This is a temporary single-user privacy gate, not account management. The homepage and workspace API use the same credentials.

- `/` is the password-protected workspace.
- `/app` redirects to `/` for older bookmarks.
- `/api/v1/workspace` and `/api/v1/hermes` require the same password.
- `/healthz` is public and returns no workspace data.

## Hermes is optional and read-only

To show a Hermes Personal Tasks board, mount that board directory read-only and set `HERMES_KANBAN_DB` to its SQLite database path. Mount the database's WAL and shared-memory sidecar files with it. The adapter opens SQLite in read-only mode and returns task titles, status, numeric priority, derived update time, ownership, source list names, and parent task titles. It reads explicit source metadata from task bodies internally to recover list names; it never returns the bodies. Structure-only list headings appear as list buttons, not actionable tasks.

Visible list buttons switch directly between individual lists, including empty lists. My Tasks opens by default when present. Switching lists clears the search so items are not accidentally hidden. It does not copy Hermes records into local editable tasks. The Personal Tasks board remains canonical. Running without the mount simply leaves the Hermes panel unavailable.

## SQLite and backups

The workspace opens SQLite with WAL mode, full synchronous writes, and a five-second busy timeout. WAL mode lets readers continue during short writes, but it does not make SQLite a multi-writer database. Keep one app replica and keep the database, `-wal`, and `-shm` files on local disk. Do not use an NFS or SMB share for the live database.

Back up a running database with SQLite's online backup API or `VACUUM INTO`. Validate the result with `PRAGMA quick_check`. Do not copy only `focus.sqlite` while WAL mode is active, because recent transactions may still live in the sidecar file.

Before a destructive restore or a volume deletion, stop the container and make a verified copy. `docker compose down -v` deletes the workspace volume and the generated password.

## Deployment checks

After deploying a new image, check the container health endpoint locally and verify that anonymous requests to the workspace API receive `401`. Then sign in normally and make a small local edit to confirm the data volume is still mounted.

The repository's Jenkins pipeline builds an image, runs tests, starts an isolated candidate, then deploys only the app container. It must not recreate the persistent data volume or any separately managed reverse proxy or tunnel. Once the public repository is connected to Jenkins, the job should read the checked-in `Jenkinsfile` from source control rather than a copied working tree.

No release process should package the SQLite file, password file, Hermes database, or provider credentials into an image or repository.
