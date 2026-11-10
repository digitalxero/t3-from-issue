const requireString = (value) => {
  if (typeof value !== "string" || !value) throw new Error("Invalid issue response");
  return value;
};
export function githubRepository(context) {
  if (context.provider !== "github" || !context.apiReads || !context.remoteUrl) throw new Error(`Source Control provider '${context.provider}' is unsupported for issue reads.`);
  const raw = context.remoteUrl.replace(/^git@([^:]+):/, "https://$1/");
  const url = new URL(raw);
  const host = new URL(context.baseUrl).host;
  if (url.host !== host) throw new Error("Repository host does not match the selected source-control host.");
  const repository = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Unsupported repository path.");
  return { host, repository, prefix: `repos/${repository.split("/").map(encodeURIComponent).join("/")}` };
}
export function githubIssue(item, repository) {
  if (item.pull_request || !Number.isSafeInteger(item.number) || item.number < 1) throw new Error("Invalid issue response");
  return { source: "github", host: repository.host, repository: repository.repository, key: String(item.number), id: `github:${repository.host}:${repository.repository}:${item.number}`, label: `${repository.repository}#${item.number}: ${requireString(item.title)}`.slice(0, 200), title: item.title.slice(0, 200), body: typeof item.body === "string" ? item.body.slice(0, 6000) : "", url: requireString(item.html_url), open: item.state === "open" };
}
export function linearIssue(item, workspace) {
  return { source: "linear", host: "linear.app", repository: workspace, key: requireString(item.id), id: `linear:${workspace}:${item.id}`, label: `${requireString(item.identifier)}: ${requireString(item.title)}`.slice(0, 200), title: item.title.slice(0, 200), body: typeof item.description === "string" ? item.description.slice(0, 6000) : "", url: requireString(item.url), open: !item.archivedAt && !["completed", "canceled"].includes(item.state?.type) };
}
export function taskReference(issues) {
  if (issues.length === 0) return "";
  const index = issues.map((issue) => `${issue.id}\n${issue.title}\n${issue.url}\n${issue.open ? "Open" : "Closed"}`).join("\n\n");
  const remaining = 14000 - index.length - issues.length * 4;
  if (remaining < 0) throw new Error("Selected issue identities exceed the task context budget");
  const share = Math.floor(remaining / issues.length);
  return index + "\n\n" + issues.map((issue, i) => `[${i + 1}] ${issue.body.slice(0, share)}`).join("\n");
}

export function gitlabRepository(context) {
  if (context.provider !== "gitlab" || !context.apiReads || !context.remoteUrl) throw new Error(`Source Control provider '${context.provider}' is unsupported for issue reads.`);
  const url = new URL(context.remoteUrl.replace(/^git@([^:]+):/, "https://$1/"));
  const host = new URL(context.baseUrl).host;
  const repository = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
  if (url.host !== host || !/^[\w.-]+(?:\/[\w.-]+)+$/.test(repository)) throw new Error("Unsupported repository identity");
  return { host, repository, prefix: `projects/${encodeURIComponent(repository)}` };
}
export function sourceRepository(context) {
  return context.provider === "gitlab" ? { ...gitlabRepository(context), source: "gitlab" } : { ...githubRepository(context), source: "github" };
}
export function gitlabIssue(item, repository) {
  if (!Number.isSafeInteger(item.iid) || item.iid < 1) throw new Error("Invalid issue response");
  return { source: "gitlab", host: repository.host, repository: repository.repository, key: String(item.iid), id: `gitlab:${repository.host}:${repository.repository}:${item.iid}`, label: `${repository.repository}#${item.iid}: ${requireString(item.title)}`.slice(0, 200), title: item.title.slice(0, 200), body: typeof item.description === "string" ? item.description.slice(0, 6000) : "", url: requireString(item.web_url), open: item.state === "opened" };
}
