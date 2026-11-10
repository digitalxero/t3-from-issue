import { test } from "node:test";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../src/plugin.js";
import {
  gitlabIssue,
  gitlabRepository,
  githubIssue,
  githubRepository,
  taskReference,
} from "../src/issues.js";

const repo = {
  host: "github.com",
  repository: "acme/app",
  prefix: "repos/acme/app",
};
const issue = {
  number: 123,
  title: "Fix navigation",
  body: "Details",
  html_url: "https://github.com/acme/app/issues/123",
  state: "open",
};
test("provider and repository identity cannot fall back to a different forge", () => {
  assert.throws(() => githubRepository({ provider: "gitlab", apiReads: true }));
  assert.throws(() =>
    githubRepository({
      provider: "github",
      apiReads: true,
      remoteUrl: "https://other.test/acme/app",
      baseUrl: "https://github.com",
    }),
  );
  assert.notEqual(
    githubIssue(issue, repo).id,
    githubIssue({ ...issue, html_url: "https://github.com/acme/other/issues/123" }, { ...repo, repository: "acme/other" }).id,
  );
  assert.ok(
    taskReference(
      Array(20).fill({ ...githubIssue(issue, repo), body: "x".repeat(6000) }),
    ).length <= 14000,
  );
});
test("links survive restart, refresh before use, reject closed selections and clear without auth", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "from-issue-test-"));
  let current = issue;
  let accessible = true;
  const context = {
    dataDirectory,
    capabilities: [
      "contextual-associations",
      "portable-view-navigation",
      "command-invocation-context",
      "task-context",
      "project-source-reads",
    ],
    projects: {
      describe: (projectId) =>
        Effect.succeed({
          projectId,
          provider: "github",
          apiReads: true,
          remoteUrl: "https://github.com/acme/app.git",
          baseUrl: "https://github.com",
          directory: "/unused",
        }),
      readSource: () =>
        accessible
          ? Effect.succeed(JSON.stringify(current))
          : Effect.fail({
              _tag: "PluginError",
              operation: "denied",
              cause: null,
            }),
    },
    secrets: { get: () => Effect.succeed(null) },
  };
  const activate = () => Effect.runPromise(plugin.activate(context));
  const run = (api, id, input) =>
    Effect.runPromise(api.commands.find((c) => c.id === id).run(input));
  try {
    let api = await activate();
    await run(api, "configure", {
      projectId: "p",
      enabled: true,
      source: "source-control",
    });
    const input = {
      projectId: "p",
      threadId: "draft-stable-id",
      issue: githubIssue(issue, repo),
    };
    await run(api, "select", input);
    api = await activate();
    assert.match(await Effect.runPromise(api.taskContext(input)), /Details/);
    current = { ...issue, number: 124, html_url: "https://github.com/acme/app/issues/124" };
    assert.match((await run(api, "open", input)).view.blocks[0].text, /unavailable/);
    current = { ...issue, body: "Updated", state: "closed" };
    assert.match(
      await Effect.runPromise(api.taskContext(input)),
      /Closed[\s\S]*Updated/,
    );
    assert.equal(
      (await run(api, "select", { ...input, threadId: "another" })).tone,
      "danger",
    );
    accessible = false;
    assert.doesNotMatch(
      await Effect.runPromise(api.taskContext(input)),
      /Details|Updated/,
    );
    assert.match(
      (await run(api, "open", input)).view.blocks[0].text,
      /unavailable/,
    );
    await run(api, "remove", input);
    assert.equal(await Effect.runPromise(api.taskContext(input)), "");
    accessible = true;
    current = issue;
    await Effect.runPromise(
      api.commands
        .find((c) => c.id === "select")
        .run(
          { ...input, projectId: "forged", threadId: "forged" },
          { audience: "agent", projectId: "p", threadId: "draft-stable-id" },
        ),
    );
    assert.match(await Effect.runPromise(api.taskContext(input)), /Details/);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("GitLab keeps nested repository identity and uses issue iid rather than global id", () => {
  const repository = gitlabRepository({
    provider: "gitlab",
    apiReads: true,
    baseUrl: "https://gitlab.example",
    remoteUrl: "git@gitlab.example:team/subgroup/app.git",
  });
  assert.equal(repository.prefix, "projects/team%2Fsubgroup%2Fapp");
  const item = gitlabIssue(
    {
      id: 9999,
      iid: 123,
      title: "Fix",
      description: "Details",
      web_url: "https://gitlab.example/team/subgroup/app/-/issues/123",
      state: "opened",
    },
    repository,
  );
  assert.equal(
    gitlabIssue({ iid: 123, title: "Fix", web_url: "https://gitlab.example/team/subgroup/app/-/work_items/123", state: "opened" }, repository).id,
    item.id,
  );
  assert.equal(item.key, "123");
  assert.equal(item.id, "gitlab:gitlab.example:team/subgroup/app:123");
  assert.equal(item.open, true);
  assert.equal(
    gitlabIssue(
      { iid: 123, title: "Fix", web_url: item.url, state: "closed" },
      repository,
    ).open,
    false,
  );
});

test("bounded task context retains every selected issue identity", () => {
  const issues = Array.from({ length: 20 }, (_, i) => ({
    ...githubIssue({ ...issue, number: i + 1, html_url: `https://github.com/acme/app/issues/${i + 1}` }, repo),
    body: "x".repeat(6000),
  }));
  const reference = taskReference(issues);
  assert.ok(reference.length <= 14000);
  for (const item of issues) assert.ok(reference.includes(item.id));
});

test("Linear requires consent, keeps credentials private, paginates and clears links", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "from-issue-linear-"));
  const secrets = new Map();
  let accessible = true;
  const requests = [];
  const linearItem = {
    id: "opaque-id",
    identifier: "ENG-123",
    title: "Linear task",
    description: "Private details",
    url: "https://linear.app/acme/issue/ENG-123",
    archivedAt: null,
    state: { type: "started" },
  };
  t.mock.method(globalThis, "fetch", async (_, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    if (!accessible) return new Response("Denied", { status: 403 });
    return Response.json({
      data: {
        organization: { id: "workspace", name: "Acme" },
        issue: linearItem,
        issues: {
          nodes: [linearItem],
          pageInfo: {
            hasNextPage: !request.variables?.after,
            endCursor: "page-two",
          },
        },
      },
    });
  });
  const context = {
    dataDirectory,
    capabilities: [
      "contextual-associations",
      "portable-view-navigation",
      "command-invocation-context",
      "task-context",
      "project-source-reads",
    ],
    projects: { describe: (projectId) => Effect.succeed({ projectId }) },
    secrets: {
      get: (key) => Effect.succeed(secrets.get(key) ?? null),
      set: (key, value) => Effect.sync(() => secrets.set(key, value)),
      remove: (key) => Effect.sync(() => secrets.delete(key)),
    },
  };
  try {
    const api = await Effect.runPromise(plugin.activate(context));
    const run = (id, input) =>
      Effect.runPromise(api.commands.find((c) => c.id === id).run(input));
    const input = { projectId: "linear-project", threadId: "draft-stable" };
    await run("configure", { ...input, enabled: true, source: "linear" });
    assert.match(
      JSON.stringify(await Effect.runPromise(api.views[1].read(input))),
      /authentication/,
    );
    assert.equal(
      (
        await run("connect", {
          ...input,
          token: "test-api-key",
          consent: false,
        })
      ).tone,
      "danger",
    );
    assert.equal(requests.length, 0);
    await run("connect", { ...input, token: "test-api-key", consent: true });
    let view = await Effect.runPromise(api.views[1].read(input));
    assert.doesNotMatch(JSON.stringify(view), /test-api-key/);
    assert.equal(view.blocks[0].nextCursor, "page-two");
    await Effect.runPromise(
      api.views[1].read({
        ...input,
        associationSearch: { query: "task", cursor: "page-two" },
      }),
    );
    assert.equal(requests.at(-1).variables.after, "page-two");
    await run("select", view.blocks[0].options[0].select.input);
    assert.match(
      await Effect.runPromise(api.taskContext(input)),
      /linear:workspace:opaque-id/,
    );
    accessible = false;
    assert.doesNotMatch(
      await Effect.runPromise(api.taskContext(input)),
      /Private details/,
    );
    await run("clear", input);
    assert.equal(await Effect.runPromise(api.taskContext(input)), "");
    await run("disconnect", input);
    assert.equal(secrets.size, 0);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("does not relabel issue redirects as an issue in the configured repository", () => {
  assert.throws(() => githubIssue({ ...issue, html_url: "https://github.com/acme/other/issues/123" }, repo));
  assert.throws(() => gitlabIssue({ iid: 123, title: "Moved", web_url: "https://gitlab.example/other/app/-/issues/123", state: "opened" }, { host: "gitlab.example", repository: "team/app" }));
});
