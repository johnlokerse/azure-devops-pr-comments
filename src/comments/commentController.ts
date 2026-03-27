import * as vscode from 'vscode';
import type { AzureDevOpsClient } from '../api/azureDevOpsClient.js';
import { isResolvedThreadStatus, type PullRequest, type PullRequestThread } from '../api/types.js';
import { ThreadMapper, buildCommentBody, formatDate } from './threadMapper.js';
import { parseSuggestion, type SuggestionBlock } from './suggestionParser.js';
import { resolveImages } from './imageProcessor.js';

const CONTROLLER_ID = 'azurePrComments';
const CONTROLLER_LABEL = 'Azure DevOps PR Comments';

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

    // Clear existing threads
    this.clearThreads();

    const mapper = new ThreadMapper(workspaceRoot);
    const mapped = mapper.mapThreads(adoThreads, showResolved);

    for (const { thread, uri, range } of mapped) {
      const firstComment = thread.comments[0];
      const suggestion = firstComment ? parseSuggestion(firstComment.content) : undefined;

      if (suggestion && thread.threadContext?.filePath) {
        this._suggestionMap.set(thread.id, {
          suggestedCode: suggestion.suggestedCode,
          filePath: thread.threadContext.filePath,
          startLine: thread.threadContext.rightFileStart?.line ?? 1,
          endLine: thread.threadContext.rightFileEnd?.line ?? thread.threadContext.rightFileStart?.line ?? 1,
        });
      }

      const vsComments = await Promise.all(
        thread.comments.map((c, idx) =>
          this.buildVsComment(c, thread, idx === 0 ? suggestion : undefined)
        )
      );
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
          await this.buildVsComment(newComment, adoThread),
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
