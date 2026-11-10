import { test } from "node:test";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../src/plugin.js";
import { gitlabIssue, gitlabRepository, githubIssue, githubRepository, taskReference } from "../src/issues.js";

const repo = { host: "github.com", repository: "acme/app", prefix: "repos/acme/app" };
const issue = { number: 123, title: "Fix navigation", body: "Details", html_url: "https://github.com/acme/app/issues/123", state: "open" };
test("provider and repository identity cannot fall back to a different forge", () => {
  assert.throws(() => githubRepository({ provider: "gitlab", apiReads: true }));
  assert.throws(() => githubRepository({ provider: "github", apiReads: true, remoteUrl: "https://other.test/acme/app", baseUrl: "https://github.com" }));
  assert.notEqual(githubIssue(issue, repo).id, githubIssue(issue, { ...repo, repository: "acme/other" }).id);
  assert.ok(taskReference(Array(20).fill({ ...githubIssue(issue, repo), body: "x".repeat(6000) })).length <= 14000);
});
test("links survive restart, refresh before use, reject closed selections and clear without auth", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "from-issue-test-"));
  let current = issue;
  let accessible = true;
  const context = { dataDirectory, capabilities: ["contextual-associations", "task-context", "project-source-reads"], projects: {
    describe: (projectId) => Effect.succeed({ projectId, provider: "github", apiReads: true, remoteUrl: "https://github.com/acme/app.git", baseUrl: "https://github.com", directory: "/unused" }),
    readSource: () => accessible ? Effect.succeed(JSON.stringify(current)) : Effect.fail({ _tag: "PluginError", operation: "denied", cause: null }),
  }, secrets: { get: () => Effect.succeed(null) } };
  const activate = () => Effect.runPromise(plugin.activate(context));
  const run = (api, id, input) => Effect.runPromise(api.commands.find((c) => c.id === id).run(input));
  try {
    let api = await activate();
    await run(api, "configure", { projectId: "p", enabled: true, source: "source-control" });
    const input = { projectId: "p", threadId: "draft-stable-id", issue: githubIssue(issue, repo) };
    await run(api, "select", input);
    api = await activate();
    assert.match(await Effect.runPromise(api.taskContext(input)), /Details/);
    current = { ...issue, body: "Updated", state: "closed" };
    assert.match(await Effect.runPromise(api.taskContext(input)), /Closed\nUpdated/);
    await assert.rejects(run(api, "select", { ...input, threadId: "another" }));
    accessible = false;
    assert.doesNotMatch(await Effect.runPromise(api.taskContext(input)), /Details|Updated/);
    assert.match((await run(api, "open", input)).text, /unavailable/);
    await run(api, "remove", input);
    assert.equal(await Effect.runPromise(api.taskContext(input)), "");
  } finally { await rm(dataDirectory, { recursive: true, force: true }); }
});

test("GitLab keeps nested repository identity and uses issue iid rather than global id", () => {
  const repository = gitlabRepository({ provider: "gitlab", apiReads: true, baseUrl: "https://gitlab.example", remoteUrl: "git@gitlab.example:team/subgroup/app.git" });
  assert.equal(repository.prefix, "projects/team%2Fsubgroup%2Fapp");
  const item = gitlabIssue({ id: 9999, iid: 123, title: "Fix", description: "Details", web_url: "https://gitlab.example/team/subgroup/app/-/issues/123", state: "opened" }, repository);
  assert.equal(item.key, "123");
  assert.equal(item.id, "gitlab:gitlab.example:team/subgroup/app:123");
  assert.equal(item.open, true);
  assert.equal(gitlabIssue({ iid: 123, title: "Fix", web_url: item.url, state: "closed" }, repository).open, false);
});
