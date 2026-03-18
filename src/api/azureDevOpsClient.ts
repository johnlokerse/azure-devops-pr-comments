import type { AdoRepository, PullRequest, PullRequestThread, PullRequestComment, ThreadStatus, AdoIdentity } from './types.js';

const API_VERSION = '7.1';

export class AzureDevOpsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly wwwAuthenticate?: string,
  ) {
    super(message);
    this.name = 'AzureDevOpsApiError';
  }
}

export class AzureDevOpsClient {

  constructor(
    private readonly repo: AdoRepository,
    private readonly getToken: () => Promise<string>
  ) {}

  /** No-op: kept for API compatibility */
  invalidateClient(): void {}

  async getActivePullRequest(branch: string): Promise<PullRequest | undefined> {
    const url = this.url(
      `git/repositories/${encodeURIComponent(this.repo.repo)}/pullRequests`,
      {
        'searchCriteria.sourceRefName': `refs/heads/${branch}`,
        'searchCriteria.status': 'active',
        '$top': '1',
      }
    );
    const data = await this.get<{ value: RawPullRequest[]; count: number }>(url);
    if (!data.value || data.value.length === 0) {
      return undefined;
    }
    return this.mapPullRequest(data.value[0]);
  }

  async getPullRequestThreads(prId: number): Promise<PullRequestThread[]> {
    const url = this.url(
      `git/repositories/${encodeURIComponent(this.repo.repo)}/pullRequests/${prId}/threads`
    );
    const data = await this.get<{ value: RawThread[] }>(url);
    if (!data.value) {
      return [];
    }
    return data.value
      .filter((t) => !t.isDeleted)
      .map((t) => this.mapThread(t));
  }

  async replyToThread(prId: number, threadId: number, text: string): Promise<PullRequestComment> {
    const url = this.url(
      `git/repositories/${encodeURIComponent(this.repo.repo)}/pullRequests/${prId}/threads/${threadId}/comments`
    );
    const comment = await this.post<RawComment>(url, { content: text, commentType: 1 });
    return this.mapComment(comment);
  }

  async updateThreadStatus(prId: number, threadId: number, status: ThreadStatus): Promise<void> {
    const url = this.url(
      `git/repositories/${encodeURIComponent(this.repo.repo)}/pullRequests/${prId}/threads/${threadId}`
    );
    await this.patch(url, { status: this.mapThreadStatusToAdo(status) });
  }

  // ── URL builder ─────────────────────────────────────────────────────────────

  private url(path: string, params: Record<string, string> = {}): string {
    const base = `${this.repo.organizationUrl}/${encodeURIComponent(this.repo.project)}/_apis/${path}`;
    const qs = new URLSearchParams({ 'api-version': API_VERSION, ...params });
    return `${base}?${qs}`;
  }

  // ── HTTP helpers ─────────────────────────────────────────────────────────────

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getToken();
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  private async get<T>(url: string): Promise<T> {
    const headers = await this.authHeaders();
    const response = await fetch(url, { headers });
    return this.handleResponse<T>(response, url);
  }

  private async post<T>(url: string, body: unknown): Promise<T> {
    const headers = await this.authHeaders();
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    return this.handleResponse<T>(response, url);
  }

  private async patch<T>(url: string, body: unknown): Promise<T> {
    const headers = await this.authHeaders();
    const response = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(body) });
    return this.handleResponse<T>(response, url);
  }

  private async handleResponse<T>(response: Response, url: string): Promise<T> {
    if (!response.ok) {
      let detail = '';
      try {
        const json = await response.json() as { message?: string };
        detail = json.message ?? JSON.stringify(json);
      } catch {
        detail = await response.text();
      }
      // Include URL path (without query string) in error for easier diagnosis
      const urlPath = url.split('?')[0];
      const wwwAuthenticate = response.headers.get('www-authenticate') ?? undefined;
      throw new AzureDevOpsApiError(
        `HTTP ${response.status} — ${urlPath}\n${detail}`,
        response.status,
        urlPath,
        wwwAuthenticate,
      );
    }
    return response.json() as Promise<T>;
  }

  // ── Mapping helpers ──────────────────────────────────────────────────────────

  private mapPullRequest(pr: RawPullRequest): PullRequest {
    return {
      pullRequestId: pr.pullRequestId,
      title: pr.title ?? '(no title)',
      description: pr.description,
      status: pr.status ?? 'unknown',
      sourceBranch: (pr.sourceRefName ?? '').replace('refs/heads/', ''),
      targetBranch: (pr.targetRefName ?? '').replace('refs/heads/', ''),
      createdBy: this.mapIdentity(pr.createdBy),
      creationDate: pr.creationDate ?? new Date().toISOString(),
    };
  }

  private mapThread(t: RawThread): PullRequestThread {
    return {
      id: t.id,
      status: this.mapAdoThreadStatus(t.status),
      isDeleted: t.isDeleted ?? false,
      threadContext: t.threadContext
        ? {
            filePath: t.threadContext.filePath ?? '',
            rightFileStart: t.threadContext.rightFileStart
              ? { line: t.threadContext.rightFileStart.line ?? 1, offset: t.threadContext.rightFileStart.offset ?? 1 }
              : undefined,
            rightFileEnd: t.threadContext.rightFileEnd
              ? { line: t.threadContext.rightFileEnd.line ?? 1, offset: t.threadContext.rightFileEnd.offset ?? 1 }
              : undefined,
            leftFileStart: t.threadContext.leftFileStart
              ? { line: t.threadContext.leftFileStart.line ?? 1, offset: t.threadContext.leftFileStart.offset ?? 1 }
              : undefined,
          }
        : undefined,
      comments: (t.comments ?? [])
        .filter((c) => !c.isDeleted && c.commentType !== 3)
        .map((c) => this.mapComment(c)),
    };
  }

  private mapComment(c: RawComment): PullRequestComment {
    return {
      id: c.id,
      content: c.content ?? '',
      author: this.mapIdentity(c.author),
      publishedDate: c.publishedDate ?? new Date().toISOString(),
      lastUpdatedDate: c.lastUpdatedDate ?? new Date().toISOString(),
      commentType: 'text',
      isDeleted: c.isDeleted ?? false,
    };
  }

  private mapIdentity(identity: RawIdentity | undefined): AdoIdentity {
    return {
      id: identity?.id ?? '',
      displayName: identity?.displayName ?? 'Unknown',
      uniqueName: identity?.uniqueName ?? '',
      imageUrl: identity?.imageUrl,
    };
  }

  private mapAdoThreadStatus(status: number | undefined): ThreadStatus {
    switch (status) {
      case 1: return 'active';
      case 2: return 'fixed';
      case 3: return 'wontFix';
      case 4: return 'closed';
      case 5: return 'byDesign';
      case 6: return 'pending';
      default: return 'unknown';
    }
  }

  private mapThreadStatusToAdo(status: ThreadStatus): number {
    switch (status) {
      case 'active': return 1;
      case 'fixed': return 2;
      case 'wontFix': return 3;
      case 'closed': return 4;
      case 'byDesign': return 5;
      case 'pending': return 6;
      default: return 1;
    }
  }
}

// ── Raw ADO REST API response types ─────────────────────────────────────────────

interface RawIdentity {
  id: string;
  displayName: string;
  uniqueName: string;
  imageUrl?: string;
}

interface RawPullRequest {
  pullRequestId: number;
  title?: string;
  description?: string;
  status?: string;
  sourceRefName?: string;
  targetRefName?: string;
  createdBy: RawIdentity;
  creationDate?: string;
}

interface RawThread {
  id: number;
  status?: number;
  isDeleted?: boolean;
  threadContext?: {
    filePath?: string;
    rightFileStart?: { line?: number; offset?: number };
    rightFileEnd?: { line?: number; offset?: number };
    leftFileStart?: { line?: number; offset?: number };
  };
  comments?: RawComment[];
}

interface RawComment {
  id: number;
  content?: string;
  author: RawIdentity;
  publishedDate?: string;
  lastUpdatedDate?: string;
  commentType?: number;
  isDeleted?: boolean;
}
