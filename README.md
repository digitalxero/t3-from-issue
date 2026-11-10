# From Issue for T3 Code

Work in progress. No stable release is available yet.

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

## Development

Node 24; `npm ci`, `npm run check`. `dist/plugin.mjs` bundles all JavaScript
dependencies. The repository root manifest and module version must match the
stable release tag before repository-URL installation is announced.

Original implementation, MIT licensed. Effect is bundled under its MIT license.
