import * as vscode from 'vscode';
import type { AzureDevOpsClient } from '../api/azureDevOpsClient.js';
import { isResolvedThreadStatus, type PullRequest, type PullRequestThread } from '../api/types.js';
import { ThreadMapper, buildCommentBody, formatDate } from './threadMapper.js';

const CONTROLLER_ID = 'azurePrComments';
const CONTROLLER_LABEL = 'Azure DevOps PR Comments';

export class PrCommentController implements vscode.Disposable {
  private readonly _controller: vscode.CommentController;
  private readonly _threadMap = new Map<number, vscode.CommentThread>();
  private _disposables: vscode.Disposable[] = [];
  private _currentPr: PullRequest | undefined;
  private _adoClient: AzureDevOpsClient | undefined;

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
   */
  async renderThreads(
    pr: PullRequest,
    adoThreads: PullRequestThread[],
    adoClient: AzureDevOpsClient,
    workspaceRoot: vscode.Uri,
    showResolved: boolean
  ): Promise<void> {
    this._currentPr = pr;
    this._adoClient = adoClient;

    // Clear existing threads
    this.clearThreads();

    const mapper = new ThreadMapper(workspaceRoot);
    const mapped = mapper.mapThreads(adoThreads, showResolved);

    for (const { thread, uri, range } of mapped) {
      const vsComments = thread.comments.map((c) => this.buildVsComment(c, thread));
      if (vsComments.length === 0) {
        continue;
      }

      const vsThread = this._controller.createCommentThread(uri, range, vsComments);
      vsThread.label = `Thread #${thread.id}`;
      vsThread.state = isResolvedThreadStatus(thread.status)
        ? vscode.CommentThreadState.Resolved
        : vscode.CommentThreadState.Unresolved;
      vsThread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      vsThread.contextValue = vsThread.state === vscode.CommentThreadState.Unresolved ? 'open' : 'resolved';
      vsThread.canReply = true;

      // Store the ADO thread ID on the VS thread for later operations
      (vsThread as unknown as { adoThreadId: number }).adoThreadId = thread.id;

      this._threadMap.set(thread.id, vsThread);
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
          this.buildVsComment(newComment, adoThread),
        ];
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Azure DevOps PR Comments: Failed to post reply — ${String(err)}`);
    }
  }

  /**
   * Resolves a thread.
   */
  async resolveThread(vsThread: vscode.CommentThread): Promise<void> {
    await this.changeThreadStatus(vsThread, 'fixed');
  }

  /**
   * Reopens a resolved thread.
   */
  async reopenThread(vsThread: vscode.CommentThread): Promise<void> {
    await this.changeThreadStatus(vsThread, 'active');
  }

  private async changeThreadStatus(
    vsThread: vscode.CommentThread,
    status: 'active' | 'fixed'
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
      vsThread.state = status === 'active'
        ? vscode.CommentThreadState.Unresolved
        : vscode.CommentThreadState.Resolved;
      vsThread.contextValue = status === 'active' ? 'open' : 'resolved';
    } catch (err) {
      vscode.window.showErrorMessage(`Azure DevOps PR Comments: Failed to update thread — ${String(err)}`);
    }
  }

  clearThreads(): void {
    this._threadMap.forEach((t) => t.dispose());
    this._threadMap.clear();
  }

  dispose(): void {
    this.clearThreads();
    this._disposables.forEach((d) => d.dispose());
    this._controller.dispose();
  }

  private buildVsComment(
    comment: { id: number; content: string; author: { displayName: string }; publishedDate: string },
    _thread: { id: number; status: string }
  ): vscode.Comment {
    return {
      body: buildCommentBody(comment as Parameters<typeof buildCommentBody>[0]),
      author: { name: comment.author.displayName },
      label: formatDate(comment.publishedDate),
      mode: vscode.CommentMode.Preview,
    };
  }
}
