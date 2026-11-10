# From Issue for T3 Code

Requires the prototype host fork; upstream T3 Code is unsupported.

This external plugin targets Dj's prototype plugin host fork. It does not imply
upstream approval or compatibility with upstream T3 Code.

The implementation contributes a project-specific **From Issue** option under
**Settings → Projects → New threads** and a searchable issue selector on draft
and saved threads. Selected issues open inside the client and supply bounded,
refreshed reference material to agent turns. Links are stored on the owning
server and survive client reconnects and plugin restarts.

Initial issue sources are Source Control and Linear. GitHub reads and GitLab reads through `glab api` reuse the
host's selected account and credentials for the project's detected repository.
GitCafe, Forgejo, Bitbucket, Azure DevOps, Cursor Origin and unknown hosts
currently return explicit unsupported status. There is no GitHub fallback.
Linear uses a personal API key entered through a password field with explicit
per-project consent. Use a read-only key limited to the teams you intend to
share. Disconnect removes the stored key; it does not revoke the key at Linear.

The plugin keeps at most 20 links per thread, returns 20 search results per page,
rechecks selected issues, and supplies at most 14,000 characters of issue context
per turn. It does not write back to trackers, include comments or attachments,
or transfer its private link database through thread rehoming. Removing the
plugin removes its host-managed data. Reinstalling cannot recover removed links.

## Install and use

Install `https://github.com/digitalxero/t3-from-issue` in **Settings → Plugins**
on the prototype fork with [host PR #3](https://github.com/djgilcrease/t3code/pull/3)
integrated. Release notes pin the exact verified host commit. The plugin checks
API version 1 and the `contextual-associations`, `portable-view-navigation`,
`command-invocation-context`, `task-context`, and `project-source-reads`
capabilities during activation.

Choose a project in **Settings → Projects**, enable **From Issue** under
**New threads**, choose Source Control or Linear, and save the source. Linear
requires a read-only personal API key and explicit consent for that project.
In a new or saved thread, open **Issues** in its info panel, search, and select
up to twenty issues. Click a linked issue to load its current description in
the panel; Back returns to the selector. Additional links expand with Show more.
Remove detaches one issue; Clear issues detaches all. Search and details are
read-only. Agent-accessible search, select, remove, clear and open commands use
the host's trusted caller project and thread identity.

The owning server performs tracker calls, so remote web clients need no local
CLI or credentials. Each environment keeps its own associations and Linear
consent. Moving a thread to another environment does not transfer this plugin's
private database. Standard repository URLs are supported; SSH host aliases and
custom SSH ports that do not match the detected API host are unsupported.

Verification includes real GitHub reads and issue selection in the web client,
a live public GitLab API read through glab, worker IPC and per-turn context tests,
and mocked Linear authorization/pagination/permission-loss tests. Live Linear
account access and native mobile/Electron UI verification are not claimed.

## Development

Node 24; `npm ci`, `npm run check`. `dist/plugin.mjs` bundles all JavaScript
dependencies. The repository root manifest and module version must match the
stable release tag before repository-URL installation is announced.

Original implementation, MIT licensed. Effect is bundled under its MIT license.
