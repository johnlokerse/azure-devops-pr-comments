import * as vscode from 'vscode';
import type { AzureDevOpsClient } from '../api/azureDevOpsClient.js';
import { isResolvedThreadStatus, type PullRequest, type PullRequestThread, type ThreadStatus } from '../api/types.js';
import { ThreadMapper, buildCommentBody, formatDate } from './threadMapper.js';
import { parseSuggestion, type SuggestionBlock } from './suggestionParser.js';
import { resolveImages } from './imageProcessor.js';

const CONTROLLER_ID = 'azurePrComments';
const CONTROLLER_LABEL = 'Azure DevOps PR Comments';

function threadStatusContextValue(status: ThreadStatus): string {
  switch (status) {
    case 'fixed': return 'resolved';
    case 'wontFix': return 'wontfix';
    case 'closed': return 'closed';
    case 'byDesign': return 'bydesign';
    case 'pending': return 'pending';
    default: return 'active';
  }
}

function threadStatusLabel(status: ThreadStatus): string {
  switch (status) {
    case 'active': return 'Active';
    case 'pending': return 'Pending';
    case 'fixed': return 'Resolved';
    case 'wontFix': return "Won't Fix";
    case 'closed': return 'Closed';
    case 'byDesign': return 'By Design';
    default: return 'Active';
  }
}

function threadLabel(threadId: number, status?: ThreadStatus): string {
  if (status) {
    return `Thread #${threadId} · ${threadStatusLabel(status)}`;
  }
  return `Thread #${threadId}`;
}

interface StoredSuggestion {
  suggestedCode: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

export class PrCommentController implements vscode.Disposable {
  private readonly _controller: vscode.CommentController;
  private readonly _threadMap = new Map<number, vscode.CommentThread>();
  private readonly _suggestionMap = new Map<number, StoredSuggestion>();
  private _disposables: vscode.Disposable[] = [];
  private _currentPr: PullRequest | undefined;
  private _adoClient: AzureDevOpsClient | undefined;
  private _getToken: (() => Promise<string>) | undefined;

  constructor() {
    this._controller = vscode.comments.createCommentController(CONTROLLER_ID, CONTROLLER_LABEL);
    this._controller.commentingRangeProvider = undefined; // Read-only by default; replies go via command
    this._controller.options = {
      placeHolder: 'Reply to this thread…',
      prompt: 'Reply',
    };
  }

  /**
   * Renders all fetched threads as inline VS Code comment threads.
   *
   * Performs incremental updates: existing threads are mutated in-place so that
   * any reply text the user is currently composing is not destroyed.  Only
   * threads that have been removed from Azure DevOps are disposed.
   */
  async renderThreads(
    pr: PullRequest,
    adoThreads: PullRequestThread[],
    adoClient: AzureDevOpsClient,
    workspaceRoot: vscode.Uri,
    showResolved: boolean,
    getToken: () => Promise<string>
  ): Promise<void> {
    this._currentPr = pr;
    this._adoClient = adoClient;
    this._getToken = getToken;

    const mapper = new ThreadMapper(workspaceRoot);
    const mapped = mapper.mapThreads(adoThreads, showResolved);

    const seenThreadIds = new Set<number>();

    for (const { thread, uri, range } of mapped) {
      const firstComment = thread.comments[0];
      const suggestion = firstComment ? parseSuggestion(firstComment.content) : undefined;
      const threadContext = thread.threadContext;
      const filePath = threadContext?.filePath?.trim();
      const renderableSuggestion = suggestion && filePath ? suggestion : undefined;

      if (renderableSuggestion && filePath && threadContext) {
        this._suggestionMap.set(thread.id, {
          suggestedCode: renderableSuggestion.suggestedCode,
          filePath,
          startLine: threadContext.rightFileStart?.line ?? 1,
          endLine: threadContext.rightFileEnd?.line ?? threadContext.rightFileStart?.line ?? 1,
        });
      } else {
        this._suggestionMap.delete(thread.id);
      }

      const vsComments = await Promise.all(
        thread.comments.map((c, idx) =>
          this.buildVsComment(c, thread, idx === 0 ? renderableSuggestion : undefined)
        )
      );

      // If the thread has no renderable comments, dispose any existing VS Code
      // thread for this ID and skip — do NOT add to seenThreadIds so the
      // cleanup pass below will also remove it if it somehow already exists.
      if (vsComments.length === 0) {
        const stale = this._threadMap.get(thread.id);
        if (stale) {
          stale.dispose();
          this._threadMap.delete(thread.id);
          this._suggestionMap.delete(thread.id);
        }
        continue;
      }

      // Only mark as seen once we know the thread will actually be rendered.
      seenThreadIds.add(thread.id);

      const existingThread = this._threadMap.get(thread.id);
      if (existingThread) {
        if (existingThread.uri.toString() !== uri.toString()) {
          // URI changed (thread moved to a different file) — must recreate since
          // the VS Code API does not allow mutating a thread's uri in-place.
          existingThread.dispose();

          const vsThread = this.createVsThread(uri, range, vsComments, thread);
          this._threadMap.set(thread.id, vsThread);
        } else {
          // Update the existing thread object in-place to preserve any open reply
          // box — disposing and recreating it would clear unsaved reply text.
          this.updateVsThread(existingThread, range, vsComments, thread);
        }
      } else {
        const vsThread = this.createVsThread(uri, range, vsComments, thread);

        this._threadMap.set(thread.id, vsThread);
      }
    }

    // Dispose threads that no longer exist in the updated data
    for (const [threadId, vsThread] of this._threadMap) {
      if (!seenThreadIds.has(threadId)) {
        vsThread.dispose();
        this._threadMap.delete(threadId);
        this._suggestionMap.delete(threadId);
      }
    }
  }

  /**
   * Handles a reply submitted by the user in the VS Code comment UI.
   */
  async handleReply(reply: vscode.CommentReply): Promise<void> {
    if (!this._currentPr || !this._adoClient) {
      vscode.window.showErrorMessage('Azure DevOps PR Comments: No active pull request.');
      return;
    }

    const adoThreadId = (reply.thread as unknown as { adoThreadId: number }).adoThreadId;
    if (!adoThreadId) {
      return;
    }

    const text = reply.text.trim();
    if (!text) {
      return;
    }

    try {
      const newComment = await this._adoClient.replyToThread(
        this._currentPr.pullRequestId,
        adoThreadId,
        text
      );

      // Append the new comment to the existing VS Code thread
      const vsThread = this._threadMap.get(adoThreadId);
      if (vsThread) {
        const adoThread = { id: adoThreadId, status: 'active' as const, comments: [] };
        vsThread.comments = [
          ...vsThread.comments,
          await this.buildVsComment(newComment, adoThread),
        ];
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Azure DevOps PR Comments: Failed to post reply — ${String(err)}`);
    }
  }

  async setStatusActive(vsThread: vscode.CommentThread): Promise<void> {
    await this.changeThreadStatus(vsThread, 'active');
  }

  async setStatusPending(vsThread: vscode.CommentThread): Promise<void> {
    await this.changeThreadStatus(vsThread, 'pending');
  }

  async setStatusResolved(vsThread: vscode.CommentThread): Promise<void> {
    await this.changeThreadStatus(vsThread, 'fixed');
  }

  async setStatusWontFix(vsThread: vscode.CommentThread): Promise<void> {
    await this.changeThreadStatus(vsThread, 'wontFix');
  }

  async setStatusClosed(vsThread: vscode.CommentThread): Promise<void> {
    await this.changeThreadStatus(vsThread, 'closed');
  }

  private async changeThreadStatus(
    vsThread: vscode.CommentThread,
    status: ThreadStatus
  ): Promise<void> {
    if (!this._currentPr || !this._adoClient) {
      return;
    }
    const adoThreadId = (vsThread as unknown as { adoThreadId: number }).adoThreadId;
    if (!adoThreadId) {
      return;
    }
    try {
      await this._adoClient.updateThreadStatus(this._currentPr.pullRequestId, adoThreadId, status);
      vsThread.label = threadLabel(adoThreadId, status);
      vsThread.state = isResolvedThreadStatus(status)
        ? vscode.CommentThreadState.Resolved
        : vscode.CommentThreadState.Unresolved;
      vsThread.contextValue = threadStatusContextValue(status);
      (vsThread as unknown as { adoStatus: ThreadStatus }).adoStatus = status;
    } catch (err) {
      vscode.window.showErrorMessage(`Azure DevOps PR Comments: Failed to update thread — ${String(err)}`);
    }
  }

  clearThreads(): void {
    this._threadMap.forEach((t) => t.dispose());
    this._threadMap.clear();
    this._suggestionMap.clear();
  }

  dispose(): void {
    this.clearThreads();
    this._disposables.forEach((d) => d.dispose());
    this._controller.dispose();
  }

  getSuggestion(threadId: number): StoredSuggestion | undefined {
    return this._suggestionMap.get(threadId);
  }

  private createVsThread(
    uri: vscode.Uri,
    range: vscode.Range | undefined,
    comments: readonly vscode.Comment[],
    thread: PullRequestThread
  ): vscode.CommentThread {
    const initialRange = range ?? new vscode.Range(0, 0, 0, 0);
    const vsThread = this._controller.createCommentThread(uri, initialRange, comments);
    vsThread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    vsThread.canReply = true;
    this.updateVsThread(vsThread, range, comments, thread);
    return vsThread;
  }

  private updateVsThread(
    vsThread: vscode.CommentThread,
    range: vscode.Range | undefined,
    comments: readonly vscode.Comment[],
    thread: PullRequestThread
  ): void {
    vsThread.range = range;
    vsThread.comments = comments;
    vsThread.label = threadLabel(thread.id, thread.status);
    vsThread.state = isResolvedThreadStatus(thread.status)
      ? vscode.CommentThreadState.Resolved
      : vscode.CommentThreadState.Unresolved;
    vsThread.contextValue = threadStatusContextValue(thread.status);

    // Store the ADO thread ID and current status on the VS thread for later operations.
    (vsThread as unknown as { adoThreadId: number; adoStatus: ThreadStatus }).adoThreadId = thread.id;
    (vsThread as unknown as { adoThreadId: number; adoStatus: ThreadStatus }).adoStatus = thread.status;
  }

  private async buildVsComment(
    comment: { id: number; content: string; author: { displayName: string }; publishedDate: string },
    thread: { id: number; status: string },
    suggestion?: SuggestionBlock
  ): Promise<vscode.Comment> {
    if (suggestion) {
      const prose = suggestion.prose
        ? await resolveImages(suggestion.prose, this._getToken!)
        : '';
      const md = new vscode.MarkdownString('', true);
      md.isTrusted = { enabledCommands: ['azurePrComments.applySuggestion'] };
      if (prose) {
        md.appendMarkdown(prose + '\n\n');
      }
      md.appendMarkdown('**Suggested change**\n\n---\n\n');
      md.appendCodeblock(suggestion.suggestedCode);
      md.appendMarkdown('---\n\n');
      const args = encodeURIComponent(JSON.stringify({ threadId: thread.id }));
      md.appendMarkdown(`[$(check) Apply change](command:azurePrComments.applySuggestion?${args})`);
      return {
        body: md,
        author: { name: comment.author.displayName },
        label: formatDate(comment.publishedDate),
        mode: vscode.CommentMode.Preview,
      };
    }

    return {
      body: await buildCommentBody(comment as Parameters<typeof buildCommentBody>[0], this._getToken!),
      author: { name: comment.author.displayName },
      label: formatDate(comment.publishedDate),
      mode: vscode.CommentMode.Preview,
    };
  }
}
