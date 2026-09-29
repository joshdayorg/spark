type Candidate = unknown;

function getRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function getField(value: unknown, key: string): Candidate {
  return getRecord(value)?.[key] ?? null;
}

function getPath(value: unknown, path: string[]): Candidate {
  let current: unknown = value;
  for (const key of path) {
    const record = getRecord(current);
    if (!record) {
      return null;
    }
    current = record[key];
  }
  return current ?? null;
}

function getAction(body: unknown): string | null {
  const action = getField(body, "action");
  return typeof action === "string" ? action : null;
}

function getBoolean(value: unknown, key: string): boolean {
  return getField(value, key) === true;
}

export function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function latestValidCommitTimestamp(body: unknown): number | null {
  const commits = getField(body, "commits");
  if (!Array.isArray(commits)) {
    return null;
  }

  let latest: number | null = null;
  for (const commit of commits) {
    const timestamp = parseTimestamp(getField(commit, "timestamp"));
    if (timestamp !== null && (latest === null || timestamp > latest)) {
      latest = timestamp;
    }
  }
  return latest;
}

function genericGithubTimestampCandidates(body: unknown): Candidate[] {
  return [
    getField(body, "updated_at"),
    getField(body, "created_at"),
    getPath(body, ["repository", "updated_at"]),
    getPath(body, ["repository", "pushed_at"]),
  ];
}

function eventGithubTimestampCandidates(
  body: unknown,
  githubEvent: string,
): Candidate[] {
  const action = getAction(body);
  const eventType = githubEvent.toLowerCase();

  switch (eventType) {
    case "push":
      return [
        getPath(body, ["head_commit", "timestamp"]),
        latestValidCommitTimestamp(body),
        getPath(body, ["repository", "pushed_at"]),
        getPath(body, ["repository", "updated_at"]),
      ];

    case "pull_request": {
      const pullRequest = getField(body, "pull_request");
      if (action === "closed" || action === "merged" || getBoolean(pullRequest, "merged")) {
        return [
          getField(pullRequest, "merged_at"),
          getField(pullRequest, "closed_at"),
          getField(pullRequest, "updated_at"),
          getField(pullRequest, "created_at"),
        ];
      }
      if (action === "opened") {
        return [
          getField(pullRequest, "created_at"),
          getField(pullRequest, "updated_at"),
        ];
      }
      return [
        getField(pullRequest, "updated_at"),
        getField(pullRequest, "created_at"),
      ];
    }

    case "issues": {
      const issue = getField(body, "issue");
      if (action === "closed") {
        return [
          getField(issue, "closed_at"),
          getField(issue, "updated_at"),
          getField(issue, "created_at"),
        ];
      }
      if (action === "opened") {
        return [getField(issue, "created_at"), getField(issue, "updated_at")];
      }
      return [getField(issue, "updated_at"), getField(issue, "created_at")];
    }

    case "issue_comment": {
      const comment = getField(body, "comment");
      if (action === "edited") {
        return [
          getField(comment, "updated_at"),
          getField(comment, "created_at"),
        ];
      }
      if (action === "created") {
        return [
          getField(comment, "created_at"),
          getField(comment, "updated_at"),
        ];
      }
      return [
        getField(comment, "updated_at"),
        getField(comment, "created_at"),
        getPath(body, ["issue", "updated_at"]),
      ];
    }

    case "pull_request_review":
      return [
        getPath(body, ["review", "submitted_at"]),
        getPath(body, ["pull_request", "updated_at"]),
        getPath(body, ["pull_request", "created_at"]),
      ];

    case "pull_request_review_comment":
      return [
        getPath(body, ["comment", "updated_at"]),
        getPath(body, ["comment", "created_at"]),
        getPath(body, ["pull_request", "updated_at"]),
      ];

    case "release":
      return [
        getPath(body, ["release", "published_at"]),
        getPath(body, ["release", "created_at"]),
        getPath(body, ["repository", "updated_at"]),
      ];

    case "repository":
      return [
        getPath(body, ["repository", "updated_at"]),
        getPath(body, ["repository", "pushed_at"]),
        getPath(body, ["repository", "created_at"]),
      ];

    case "workflow_run":
      return [
        getPath(body, ["workflow_run", "updated_at"]),
        getPath(body, ["workflow_run", "run_started_at"]),
        getPath(body, ["workflow_run", "created_at"]),
        getPath(body, ["workflow_run", "head_commit", "timestamp"]),
      ];

    case "check_run": {
      const checkRun = getField(body, "check_run");
      if (action === "completed") {
        return [
          getField(checkRun, "completed_at"),
          getField(checkRun, "started_at"),
        ];
      }
      return [
        getField(checkRun, "started_at"),
        getField(checkRun, "completed_at"),
        getPath(body, ["check_run", "check_suite", "updated_at"]),
        getPath(body, ["check_run", "check_suite", "created_at"]),
      ];
    }

    case "status":
      return [
        getField(body, "updated_at"),
        getField(body, "created_at"),
        getPath(body, ["commit", "commit", "committer", "date"]),
        getPath(body, ["commit", "commit", "author", "date"]),
      ];

    case "commit_comment":
      return [
        getPath(body, ["comment", "updated_at"]),
        getPath(body, ["comment", "created_at"]),
      ];

    case "deployment":
      return [
        getPath(body, ["deployment", "updated_at"]),
        getPath(body, ["deployment", "created_at"]),
      ];

    case "deployment_status":
      return [
        getPath(body, ["deployment_status", "updated_at"]),
        getPath(body, ["deployment_status", "created_at"]),
        getPath(body, ["deployment", "created_at"]),
      ];

    default:
      return [];
  }
}

export function githubTimestamp(
  body: unknown,
  githubEvent: string,
  now = Date.now(),
): number {
  const candidates = [
    ...eventGithubTimestampCandidates(body, githubEvent),
    ...genericGithubTimestampCandidates(body),
  ];

  for (const candidate of candidates) {
    const timestamp = parseTimestamp(candidate);
    if (timestamp !== null) {
      return timestamp;
    }
  }

  return now;
}
