import * as Effect from "effect/Effect";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  sourceRepository,
  gitlabIssue,
  githubIssue,
  linearIssue,
  taskReference,
} from "./issues.js";

const fail = (operation, cause) => ({ _tag: "PluginError", operation, cause });
const effect = (operation, fn) =>
  Effect.tryPromise({ try: fn, catch: (cause) => fail(operation, cause) });
const str = (v) => {
  if (typeof v !== "string" || !v || v.length > 16384)
    throw new Error("Missing context");
  return v;
};
const action = (command, input, label = command) => ({
  id: command,
  label,
  command,
  input,
});
const text = (message) => ({
  title: "From Issue",
  blocks: [{ id: "message", kind: "text", text: message }],
});
const fields = "id identifier title description url archivedAt state { type }";
export default {
  apiVersion: 1,
  id: "from-issue",
  name: "From Issue",
  version: "0.1.0",
  activate: (context) =>
    effect("activate", async () => {
      if (
        ![
          "contextual-associations",
          "portable-view-navigation",
          "command-invocation-context",
          "task-context",
          "project-source-reads",
        ].every((v) => context.capabilities?.includes(v))
      )
        throw new Error(
          "This plugin requires the prototype host with contextual associations, task context and project source reads.",
        );
      const file = join(context.dataDirectory, "associations.json");
      await mkdir(context.dataDirectory, { recursive: true });
      let state;
      try {
        state = JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        state = { projects: [], threads: [] };
      }
      if (!Array.isArray(state.projects) || !Array.isArray(state.threads))
        throw new Error("Invalid saved state");
      let tail = Promise.resolve();
      const serial = (fn) => {
        const next = tail.then(fn);
        tail = next.catch(() => {});
        return next;
      };
      const persist = async (next) => {
        await writeFile(`${file}.new`, JSON.stringify(next), { mode: 0o600 });
        await rename(`${file}.new`, file);
        state = next;
      };
      const project = (id) =>
        state.projects.find((p) => p.id === id) ?? {
          id,
          enabled: false,
          source: "source-control",
        };
      const selections = (p, t) =>
        state.threads.find((row) => row.projectId === p && row.threadId === t)
          ?.issues ?? [];
      const secretKey = (id) =>
        `linear-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
      const linear = async (id, query, variables, tokenOverride) => {
        const token =
          tokenOverride ??
          (await Effect.runPromise(context.secrets.get(secretKey(id))));
        if (!token)
          throw new Error(
            "Connect Linear with a read-only personal API key and explicit consent in this project's settings.",
          );
        const response = await fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: { Authorization: token, "Content-Type": "application/json" },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        });
        if (!response.ok)
          throw new Error(
            "Linear authentication, permissions or rate limit prevented this request.",
          );
        const raw = await response.text();
        if (raw.length > 128 * 1024)
          throw new Error("Linear response exceeds the limit.");
        const body = JSON.parse(raw);
        if (body.errors || !body.data)
          throw new Error(
            "Linear could not read these issues. Check the key's permissions.",
          );
        return body.data;
      };
      const describe = (id) => Effect.runPromise(context.projects.describe(id));
      const source = async (id, path) =>
        JSON.parse(
          await Effect.runPromise(
            context.projects.readSource({ projectId: id, path }),
          ),
        );
      const refresh = async (p, issue) => {
        if (issue.source === "github" || issue.source === "gitlab") {
          const repo = sourceRepository(await describe(p));
          if (
            repo.source !== issue.source ||
            repo.host !== issue.host ||
            repo.repository !== issue.repository
          )
            throw new Error(
              "The project's repository has changed; remove this link before selecting from the new repository.",
            );
          return (repo.source === "gitlab" ? gitlabIssue : githubIssue)(
            await source(
              p,
              `${repo.prefix}/issues/${encodeURIComponent(issue.key)}`,
            ),
            repo,
          );
        }
        const { organization, issue: current } = await linear(
          p,
          `query($id: String!) { organization { id } issue(id: $id) { ${fields} } }`,
          { id: issue.key },
        );
        if (organization.id !== issue.repository || !current)
          throw new Error(
            "Issue is unavailable in the connected Linear workspace.",
          );
        return linearIssue(current, organization.id);
      };
      const settings = async (input) => {
        const id = str(input?.projectId);
        await describe(id);
        const config = project(id);
        const blocks = [
          {
            id: "enabled",
            kind: "toggle",
            label: "From Issue",
            value: config.enabled,
            action: action("configure", {
              projectId: id,
              enabled: !config.enabled,
              source: config.source,
            }),
          },
        ];
        if (config.enabled)
          blocks.push({
            id: "source",
            kind: "form",
            label: "Save issue source",
            command: "configure",
            input: { projectId: id, enabled: true },
            fields: [
              {
                name: "source",
                kind: "select",
                label: "Issue source",
                value: config.source,
                options: [
                  { label: "Source Control", value: "source-control" },
                  { label: "Linear", value: "linear" },
                ],
              },
            ],
          });
        if (config.enabled && config.source === "linear")
          blocks.push(
            {
              id: "connect",
              kind: "form",
              label: "Connect Linear",
              command: "connect",
              input: { projectId: id },
              fields: [
                {
                  name: "token",
                  kind: "password",
                  label: "Read-only Linear personal API key",
                  required: true,
                },
                {
                  name: "consent",
                  kind: "boolean",
                  label:
                    "Allow this project to search Linear and send selected issue context to its agents",
                  value: false,
                },
              ],
            },
            {
              id: "disconnect",
              kind: "actions",
              actions: [
                action("disconnect", { projectId: id }, "Disconnect Linear"),
              ],
            },
          );
        return { title: "From Issue", blocks };
      };
      const associationView = async (input) => {
        const p = str(input?.projectId),
          t = str(input?.threadId);
        const config = project(p);
        if (!config.enabled) return { title: "From Issue", blocks: [] };
        const search = input?.associationSearch ?? {},
          query =
            typeof search.query === "string" ? search.query.slice(0, 200) : "";
        const cursor =
          typeof search.cursor === "string" ? search.cursor : undefined;
        const selected = selections(p, t);
        const options = [];
        let nextCursor;
        try {
          if (config.source === "source-control") {
            const repo = sourceRepository(await describe(p));
            const page = cursor ? Number(cursor) : 1;
            if (!Number.isSafeInteger(page) || page < 1 || page > 100)
              throw new Error("Invalid search page");

            if (repo.source === "gitlab") {
              const response = await source(
                p,
                `${repo.prefix}/issues?state=opened&scope=all&search=${encodeURIComponent(query)}&per_page=20&page=${page}`,
              );
              if (!Array.isArray(response))
                throw new Error("Invalid source-control response");
              options.push(
                ...response
                  .map((item) => gitlabIssue(item, repo))
                  .filter((item) => item.open),
              );
              if (response.length === 20) nextCursor = String(page + 1);
            } else {
              // Repository constraints follow the text; results are checked against the selected repository.
              const response = await source(
                p,
                `search/issues?q=${encodeURIComponent(query + " repo:" + repo.repository + " is:issue is:open")}&per_page=20&page=${page}`,
              );
              if (!Array.isArray(response.items))
                throw new Error("Invalid source-control response");
              for (const item of response.items) {
                if (
                  item.repository_url?.endsWith(`/${repo.prefix}`) &&
                  !item.pull_request &&
                  item.state === "open"
                )
                  options.push(githubIssue(item, repo));
              }
              if (page * 20 < Math.min(response.total_count, 1000))
                nextCursor = String(page + 1);
            }
          } else {
            const filter = {
              state: { type: { nin: ["completed", "canceled"] } },
              ...(query
                ? {
                    or: [
                      { title: { containsIgnoreCase: query } },
                      { description: { containsIgnoreCase: query } },
                    ],
                  }
                : {}),
            };
            const response = await linear(
              p,
              `query($filter: IssueFilter, $after: String) { organization { id } issues(first: 20, after: $after, filter: $filter) { nodes { ${fields} } pageInfo { hasNextPage endCursor } } }`,
              { filter, after: cursor ?? null },
            );
            if (response.organization.id !== config.workspace)
              throw new Error(
                "Linear workspace changed. Reconnect with explicit consent.",
              );
            options.push(
              ...response.issues.nodes
                .map((item) => linearIssue(item, config.workspace))
                .filter((item) => item.open),
            );
            if (response.issues.pageInfo.hasNextPage)
              nextCursor = response.issues.pageInfo.endCursor;
          }
        } catch (error) {
          return {
            title: "From Issue",
            blocks: [
              {
                id: "error",
                kind: "text",
                text: error.message?.startsWith("Source Control")
                  ? error.message
                  : "Issue search unavailable. Check this project's source, authentication and permissions. Existing links can still be removed.",
              },
              associationBlock(p, t, selected, [], undefined),
            ],
          };
        }
        return {
          title: "From Issue",
          blocks: [associationBlock(p, t, selected, options, nextCursor)],
        };
      };
      function associationBlock(p, t, selected, options, nextCursor) {
        const item = (issue, remove) => ({
          id: issue.id,
          label: issue.label,
          select: action(
            remove ? "remove" : "select",
            { projectId: p, threadId: t, issue },
            remove ? "Remove" : "Select",
          ),
          open: action(
            "open",
            { projectId: p, threadId: t, issue },
            "Open issue",
          ),
        });
        return {
          id: "issues",
          kind: "associations",
          label: "Issues",
          clear: action("clear", { projectId: p, threadId: t }, "Clear issues"),
          selected: selected.map((issue) => item(issue, true)),
          options: options.map((issue) =>
            item(
              issue,
              selected.some((v) => v.id === issue.id),
            ),
          ),
          ...(nextCursor ? { nextCursor } : {}),
        };
      }
      const command = (id, permission, fn, agent = false) => ({
        id,
        title: id,
        description: `From Issue: ${id}`,
        permission,
        agent,
        run: (input, invocation) =>
          effect(id, () =>
            serial(() =>
              fn({
                ...input,
                ...(invocation?.audience === "agent"
                  ? {
                      projectId: invocation.projectId,
                      threadId: invocation.threadId,
                    }
                  : {}),
              }),
            ),
          ).pipe(
            Effect.catch(() =>
              Effect.succeed({
                $t3: "notice",
                tone: "danger",
                text:
                  id === "connect"
                    ? "Linear connection failed. Consent and a valid read-only key are required."
                    : id === "select"
                      ? "Issue could not be linked. It may be closed, unavailable, or the project source changed. Search again and check access."
                      : "The operation could not be completed. Check the project source and permissions.",
              }),
            ),
          ),
      });
      return {
        views: [
          {
            id: "settings",
            title: "From Issue",
            location: "project-new-thread",
            permission: "orchestration:read",
            read: (input) => effect("settings", () => settings(input)),
          },
          {
            id: "issues",
            title: "From Issue",
            location: "thread-associations",
            permission: "orchestration:read",
            read: (input) => effect("issues", () => associationView(input)),
          },
        ],
        commands: [
          command("search", "orchestration:read", associationView, true),
          command("configure", "settings:write", async (input) => {
            const id = str(input.projectId);
            await describe(id);
            if (
              typeof input.enabled !== "boolean" ||
              !["source-control", "linear"].includes(input.source)
            )
              throw new Error("Invalid settings");
            const config = {
              ...project(id),
              enabled: input.enabled,
              source: input.source,
            };
            await persist({
              ...state,
              projects: [...state.projects.filter((p) => p.id !== id), config],
            });
            return null;
          }),
          command("connect", "settings:write", async (input) => {
            const id = str(input.projectId);
            await describe(id);
            if (input.consent !== true)
              throw new Error("Explicit consent is required");
            const token = str(input.token);
            const { organization } = await linear(
              id,
              "{ organization { id name } }",
              {},
              token,
            );
            await Effect.runPromise(context.secrets.set(secretKey(id), token));
            await persist({
              ...state,
              projects: [
                ...state.projects.filter((p) => p.id !== id),
                { ...project(id), workspace: organization.id },
              ],
            });
            return null;
          }),
          command("disconnect", "settings:write", async (input) => {
            const id = str(input.projectId);
            await Effect.runPromise(context.secrets.remove(secretKey(id)));
            return null;
          }),
          command(
            "select",
            "orchestration:operate",
            async (input) => {
              const p = str(input.projectId),
                t = str(input.threadId);
              if (!project(p).enabled)
                throw new Error("From Issue is disabled");
              const issue = await refresh(p, input.issue);
              if (!issue.open)
                throw new Error(
                  "This issue is closed or archived. Search again.",
                );
              const existing = selections(p, t);
              if (existing.some((i) => i.id === issue.id)) return null;
              if (existing.length >= 20)
                throw new Error("At most twenty issues can be linked");
              await persist({
                ...state,
                threads: [
                  ...state.threads.filter(
                    (r) => r.projectId !== p || r.threadId !== t,
                  ),
                  { projectId: p, threadId: t, issues: [...existing, issue] },
                ],
              });
              return null;
            },
            true,
          ),
          command(
            "remove",
            "orchestration:operate",
            async (input) => {
              const p = str(input.projectId),
                t = str(input.threadId);
              await persist({
                ...state,
                threads: [
                  ...state.threads.filter(
                    (r) => r.projectId !== p || r.threadId !== t,
                  ),
                  {
                    projectId: p,
                    threadId: t,
                    issues: selections(p, t).filter(
                      (i) => i.id !== input.issue?.id,
                    ),
                  },
                ],
              });
              return null;
            },
            true,
          ),
          command(
            "clear",
            "orchestration:operate",
            async (input) => {
              const p = str(input.projectId),
                t = str(input.threadId);
              await persist({
                ...state,
                threads: state.threads.filter(
                  (r) => r.projectId !== p || r.threadId !== t,
                ),
              });
              return null;
            },
            true,
          ),
          command(
            "open",
            "orchestration:read",
            async (input) => {
              const p = str(input.projectId),
                t = str(input.threadId);
              const linked = selections(p, t).find(
                (i) => i.id === input.issue?.id,
              );
              if (!linked) throw new Error("Issue is no longer linked");
              try {
                const current = await refresh(p, linked);
                return {
                  $t3: "view",
                  view: {
                    title: current.label,
                    blocks: [
                      {
                        id: "issue",
                        kind: "text",
                        text: `${current.url}\n${current.open ? "Open" : "Closed"}\n\n${current.body}`.slice(
                          0,
                          16384,
                        ),
                      },
                    ],
                  },
                };
              } catch {
                return {
                  $t3: "view",
                  view: {
                    title: "Unavailable linked issue",
                    blocks: [
                      {
                        id: "unavailable",
                        kind: "text",
                        text: "This issue is unavailable or permission was revoked. Cached private content is not displayed. Remove the link or restore access.",
                      },
                    ],
                  },
                };
              }
            },
            true,
          ),
        ],
        taskContext: (input) =>
          effect("task-context", async () => {
            await tail;
            if (!project(input.projectId).enabled) return "";
            const fresh = [];
            for (const issue of selections(input.projectId, input.threadId)) {
              try {
                fresh.push(await refresh(input.projectId, issue));
              } catch {
                fresh.push({
                  ...issue,
                  body: "Issue unavailable. No cached description is supplied.",
                  title: "Unavailable linked issue",
                  open: false,
                });
              }
            }
            return taskReference(fresh);
          }),
      };
    }),
};
