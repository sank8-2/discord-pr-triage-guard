export class PolicyDeniedError extends Error {
  constructor(reason, decisions = []) {
    super(reason);
    this.name = "PolicyDeniedError";
    this.decisions = decisions;
  }
}

export class GitHubError extends Error {
  constructor(status, retryAfterSeconds = 0) {
    super(`GitHub returned ${status}`);
    this.name = "GitHubError";
    this.status = status;
    this.retryAfterMs = Math.max(0, Number(retryAfterSeconds) || 0) * 1000;
  }
}

export class DiscordError extends Error {
  constructor(status, retryAfterSeconds = 0) {
    super(`Discord returned ${status}`);
    this.name = "DiscordError";
    this.status = status;
    this.retryAfterMs = Math.max(0, Number(retryAfterSeconds) || 0) * 1000;
  }
}
