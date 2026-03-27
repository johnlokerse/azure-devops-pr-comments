import * as vscode from 'vscode';
import { AuthProvider } from './auth/authProvider.js';
import { isResolvedThreadStatus } from './api/types.js';
import { RepositoryDetector } from './git/repositoryDetector.js';
import { AzureDevOpsApiError, AzureDevOpsClient } from './api/azureDevOpsClient.js';
import { PrCommentController } from './comments/commentController.js';
import { ThreadMapper, describeThreadLocation, type MappedThread } from './comments/threadMapper.js';
import { StatusBarManager } from './ui/statusBar.js';
import { clearImageCache } from './comments/imageProcessor.js';

let commentController: PrCommentController | undefined;
let statusBar: StatusBarManager | undefined;
let lastRenderedThreadsKey: string | undefined;
let currentPullRequestUrl: string | undefined;
let refreshInProgress = false;
let refreshQueued = false;
let pendingAuthRetry: ReturnType<typeof setTimeout> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const auth = new AuthProvider(context.globalState);
  const repoDetector = new RepositoryDetector();
  commentController = new PrCommentController();
  statusBar = new StatusBarManager();
  const output = vscode.window.createOutputChannel('Azure DevOps PR Comments');
  const diagOutput = vscode.window.createOutputChannel('Azure DevOps PR Comments — Diagnostics');
  statusBar.showIdle();

  context.subscriptions.push(commentController, statusBar, output, diagOutput);

  // ── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('azurePrComments.signIn', async () => {
      // forceNewSession ensures the user can pick the right account
      await auth.signIn(true);
      lastRenderedThreadsKey = undefined;
      currentPullRequestUrl = undefined;
      statusBar?.showIdle();
    }),

    vscode.commands.registerCommand('azurePrComments.signOut', async () => {
      await auth.signOut();
      refreshQueued = false;
      lastRenderedThreadsKey = undefined;
      currentPullRequestUrl = undefined;
      commentController?.clearThreads();
      clearImageCache();
      statusBar?.showNotConnected();
    }),

    vscode.commands.registerCommand('azurePrComments.refresh', () => refresh()),

    vscode.commands.registerCommand('azurePrComments.openInAzureDevOps', async () => {
      if (!currentPullRequestUrl) {
        vscode.window.showInformationMessage(
          'Azure DevOps PR Comments: refresh the current pull request first, then use Open in Azure DevOps.'
        );
        return;
      }

      await vscode.env.openExternal(vscode.Uri.parse(currentPullRequestUrl));
    }),

    vscode.commands.registerCommand('azurePrComments.replyToThread', async (reply: vscode.CommentReply) => {
      await commentController?.handleReply(reply);
    }),

    vscode.commands.registerCommand('azurePrComments.diagnose', async () => {
      const session = await auth.getSession(false);
      const repo = await repoDetector.detect();
      const branch = await repoDetector.getCurrentBranch();
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
      let prSummary = 'PR: (not checked)';
      let threadSummary = 'Threads: (not checked)';
      let mappedSummary = 'Mapped threads: (not checked)';
      let locationsSummary = 'Locations: (not checked)';

      if (session && repo && branch) {
        try {
          const client = new AzureDevOpsClient(repo, () => auth.getToken());
          const pr = await client.getActivePullRequest(branch);
          if (pr) {
            prSummary = `PR: #${pr.pullRequestId} ${pr.title}`;
            const threads = await client.getPullRequestThreads(pr.pullRequestId);
            threadSummary = `Threads: ${threads.length}`;
            locationsSummary = `Locations: ${threads.slice(0, 10).map(describeThreadLocation).join(', ') || '(none)'}`;

            // Log raw comment content to dedicated channel so suggestion format can be discovered
            diagOutput.clear();
            diagOutput.show(true);
            diagOutput.appendLine('── Raw comment content (for suggestion format discovery) ──');
            for (const thread of threads) {
              for (const comment of thread.comments) {
                diagOutput.appendLine(`Thread #${thread.id}, Comment #${comment.id}: ${JSON.stringify(comment.content)}`);
              }
            }
            diagOutput.appendLine('──────────────────────────────────────────────────────────');
            if (workspaceRoot) {
              const mapper = new ThreadMapper(workspaceRoot);
              const showResolved = vscode.workspace.getConfiguration('azureDevOpsPrComments')
                .get<boolean>('showResolvedThreads', false);
              const mapped = mapper.mapThreads(threads, showResolved);
              mappedSummary = `Mapped threads: ${mapped.length}`;
            }
          } else {
            prSummary = 'PR: none found for current branch';
            threadSummary = 'Threads: 0';
            mappedSummary = 'Mapped threads: 0';
            locationsSummary = 'Locations: (none)';
          }
        } catch (err) {
          prSummary = `PR lookup error: ${String(err)}`;
          threadSummary = 'Threads: (lookup failed)';
          mappedSummary = 'Mapped threads: (lookup failed)';
          locationsSummary = 'Locations: (lookup failed)';
        }
      }

      const lines = [
        `Signed in: ${session ? `Yes (${session.account.label})` : 'No'}`,
        `Account ID: ${session?.account.id ?? '(not available)'}`,
        `Tenant ID: ${auth.getAccountTenantId(session) ?? '(not available)'}`,
        `Consumer MSA account: ${session ? (auth.isConsumerMicrosoftAccount(session) ? 'Yes' : 'No') : 'Unknown'}`,
        `Branch: ${branch ?? '(not detected)'}`,
        `Org URL: ${repo?.organizationUrl ?? '(not detected)'}`,
        `Project: ${repo?.project ?? '(not detected)'}`,
        `Repo: ${repo?.repo ?? '(not detected)'}`,
        prSummary,
        threadSummary,
        mappedSummary,
        locationsSummary,
      ];

      const msg = lines.join('\n');
      const copy = 'Copy to clipboard';
      const choice = await vscode.window.showInformationMessage(
        `Azure DevOps PR Comments — Diagnostics\n\n${lines.join('\n')}`,
        copy
      );
      if (choice === copy) {
        await vscode.env.clipboard.writeText(msg);
      }
    }),

    vscode.commands.registerCommand('azurePrComments.applySuggestion', async (args: { threadId: number }) => {
      const suggestion = commentController?.getSuggestion(args.threadId);
      if (!suggestion) {
        vscode.window.showErrorMessage('Azure DevOps PR Comments: Could not find suggestion data. Try refreshing first.');
        return;
      }

      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!workspaceRoot) {
        vscode.window.showErrorMessage('Azure DevOps PR Comments: No workspace open.');
        return;
      }

      const relativePath = suggestion.filePath.replace(/^\/+/, '');
      const fileUri = vscode.Uri.joinPath(workspaceRoot, relativePath);
      const startLine = Math.max(0, suggestion.startLine - 1);
      const endLine = Math.max(0, suggestion.endLine - 1);

      try {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        const range = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(fileUri, range, suggestion.suggestedCode);
        const success = await vscode.workspace.applyEdit(edit);
        if (success) {
          await vscode.workspace.save(fileUri);
          vscode.window.showInformationMessage(
            'Azure DevOps PR Comments: Suggestion applied — resolve the thread in Azure DevOps when ready.'
          );
        } else {
          vscode.window.showErrorMessage('Azure DevOps PR Comments: Failed to apply suggestion.');
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Azure DevOps PR Comments: Failed to apply suggestion — ${String(err)}`);
      }
    }),

    vscode.commands.registerCommand('azurePrComments.resolveThread', async (thread: vscode.CommentThread) => {
      await commentController?.resolveThread(thread);
    }),

    vscode.commands.registerCommand('azurePrComments.reopenThread', async (thread: vscode.CommentThread) => {
      await commentController?.reopenThread(thread);
    }),
  );

  // ── Automatic refresh triggers ───────────────────────────────────────────

  // 1. Refresh once on activation (silent no-op if not authenticated yet)
  void refresh();

  // 2. Detect branch changes by watching .git/HEAD
  let branchDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  const gitHeadWatcher = vscode.workspace.createFileSystemWatcher('**/.git/HEAD');
  gitHeadWatcher.onDidChange(() => {
    clearTimeout(branchDebounceTimer);
    branchDebounceTimer = setTimeout(() => {
      lastRenderedThreadsKey = undefined;
      currentPullRequestUrl = undefined;
      void refresh();
    }, 500);
  });
  context.subscriptions.push(gitHeadWatcher);

  // 3. Periodic polling — restartable so config changes take effect immediately
  let pollingTimer: ReturnType<typeof setInterval> | undefined;
  let countdownTimer: ReturnType<typeof setInterval> | undefined;
  let countdownSeconds = 0;
  let pollingIntervalSeconds = 0;

  function startPolling(): void {
    if (pollingTimer !== undefined) { clearInterval(pollingTimer); pollingTimer = undefined; }
    if (countdownTimer !== undefined) { clearInterval(countdownTimer); countdownTimer = undefined; }
    const intervalMinutes = Math.max(
      0,
      vscode.workspace.getConfiguration('azureDevOpsPrComments').get<number>('autoRefreshInterval', 5)
    );
    if (intervalMinutes > 0) {
      pollingIntervalSeconds = intervalMinutes * 60;
      countdownSeconds = pollingIntervalSeconds;
      pollingTimer = setInterval(() => void refresh(), pollingIntervalSeconds * 1000);
      countdownTimer = setInterval(() => {
        countdownSeconds = Math.max(0, countdownSeconds - 1);
        statusBar?.updateCountdown(countdownSeconds);
      }, 1000);
    } else {
      pollingIntervalSeconds = 0;
      countdownSeconds = 0;
    }
  }
  startPolling();
  context.subscriptions.push({ dispose: () => { clearInterval(pollingTimer); clearInterval(countdownTimer); clearTimeout(branchDebounceTimer); clearTimeout(pendingAuthRetry); } });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('azureDevOpsPrComments.autoRefreshInterval')) {
        startPolling();
      }
    })
  );

  // 4. Re-authenticate when VS Code auth sessions change.
  //    When all extensions reload (e.g. after an extension update), VS Code's
  //    built-in Microsoft auth provider reinitialises. The initial refresh may
  //    run before it is ready and find no session. Listening here lets us
  //    automatically restore the session once the provider is available again.
  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions((e) => {
      if (e.provider.id === 'microsoft') {
        void refresh();
      }
    })
  );

  // ── Core refresh function ─────────────────────────────────────────────────

  async function refresh(): Promise<void> {
    if (refreshInProgress) {
      refreshQueued = true;
      return;
    }

    try {
      refreshInProgress = true;

      statusBar?.showLoading();
      output.clear();
      output.appendLine('Refreshing Azure DevOps PR comments...');

      // Try to get a session without prompting the user
      const session = await auth.getSession(false);
      if (!session) {
        output.appendLine('No cached Azure DevOps session found.');
        lastRenderedThreadsKey = undefined;
        currentPullRequestUrl = undefined;
        commentController?.clearThreads();

        // If the user was previously signed in, the auth provider may still be
        // loading after an extension-update reload. Keep the status bar neutral
        // and schedule one final retry — the onDidChangeSessions listener may
        // also trigger a refresh when the provider becomes available.
        if (!pendingAuthRetry && auth.hasStoredPreference()) {
          output.appendLine('Previously signed in — scheduling one more retry…');
          statusBar?.showIdle();
          pendingAuthRetry = setTimeout(() => {
            pendingAuthRetry = undefined;
            void refresh();
          }, 5000);
        } else {
          statusBar?.showNotConnected();
        }
        return;
      }
      if (pendingAuthRetry) { clearTimeout(pendingAuthRetry); pendingAuthRetry = undefined; }
      output.appendLine(`Signed in as: ${session.account.label}`);
      output.appendLine(`Tenant ID: ${auth.getAccountTenantId(session) ?? '(unknown)'}`);
      output.appendLine(`Consumer MSA account: ${auth.isConsumerMicrosoftAccount(session) ? 'yes' : 'no'}`);

      const repo = await repoDetector.detect();
      if (!repo) {
        output.appendLine('No Azure DevOps repository detected in this workspace.');
        lastRenderedThreadsKey = undefined;
        currentPullRequestUrl = undefined;
        commentController?.clearThreads();
        statusBar?.hide();
        return;
      }
      output.appendLine(`Repository: ${repo.organizationUrl} / ${repo.project} / ${repo.repo}`);

      const branch = await repoDetector.getCurrentBranch();
      if (!branch) {
        output.appendLine('Could not detect the current branch.');
        lastRenderedThreadsKey = undefined;
        currentPullRequestUrl = undefined;
        commentController?.clearThreads();
        statusBar?.showNoPullRequest();
        return;
      }
      output.appendLine(`Branch: ${branch}`);

      const client = new AzureDevOpsClient(repo, () => auth.getToken());

      try {
        const pr = await getPullRequestWithRetry(client, repo, branch, output);
        if (!pr) {
          output.appendLine('No active PR found for the current branch.');
          statusBar?.showNoPullRequest();
          lastRenderedThreadsKey = undefined;
          currentPullRequestUrl = undefined;
          commentController?.clearThreads();
          return;
        }
        output.appendLine(`PR: #${pr.pullRequestId} ${pr.title}`);
        currentPullRequestUrl = buildPullRequestUrl(repo, pr.pullRequestId);

        const config = vscode.workspace.getConfiguration('azureDevOpsPrComments');
        const showResolved = config.get<boolean>('showResolvedThreads', false);

        const threads = await client.getPullRequestThreads(pr.pullRequestId);
        output.appendLine(`Fetched threads: ${threads.length}`);
        for (const thread of threads) {
          output.appendLine(`- ${describeThreadLocation(thread)} (${thread.comments.length} comments)`);
        }
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!workspaceRoot) {
          output.appendLine('No workspace root found.');
          return;
        }

        const mapper = new ThreadMapper(workspaceRoot);
        const mappedThreads = mapper.mapThreads(threads, showResolved);
        output.appendLine(`Mapped threads: ${mappedThreads.length}`);
        for (const mappedThread of mappedThreads) {
          output.appendLine(`  -> ${mappedThread.uri.fsPath}:${mappedThread.range.start.line + 1}`);
        }

        const renderedThreadsKey = buildRenderedThreadsKey(pr.pullRequestId, workspaceRoot, showResolved, mappedThreads);
        if (renderedThreadsKey !== lastRenderedThreadsKey) {
          await commentController?.renderThreads(pr, threads, client, workspaceRoot, showResolved, () => auth.getToken());
          lastRenderedThreadsKey = renderedThreadsKey;
          output.appendLine('Rendered comment threads in VS Code.');
        } else {
          output.appendLine('Threads unchanged; skipped re-render.');
        }

        const activeThreadCount = threads.filter((t) => !isResolvedThreadStatus(t.status)).length;

        statusBar?.showPullRequest(pr, activeThreadCount);
      } catch (err) {
        const msg = String(err);
        currentPullRequestUrl = undefined;
        output.appendLine(`Refresh failed: ${msg}`);
        if (msg.includes('VS403363') && auth.isConsumerMicrosoftAccount(session)) {
          vscode.window.showErrorMessage(
            'Azure DevOps PR Comments: this signed-in Microsoft account is a personal/consumer account. Azure DevOps Entra OAuth for this resource does not natively support MSA users, even if the browser session works. Use a work or school account for the extension.'
          );
          statusBar?.showAccessDenied();
        } else if (msg.includes('VS403363')) {
          vscode.window.showErrorMessage(
            'Azure DevOps PR Comments: Azure DevOps rejected the current Microsoft account. The extension needs a tenant-specific work or school token for this org.'
          );
          statusBar?.showAccessDenied();
        } else if (msg.includes('TF400813')) {
          vscode.window.showErrorMessage(`Azure DevOps PR Comments: ${msg}`);
          statusBar?.showAccessDenied();
        } else if (msg.includes('401') || msg.toLowerCase().includes('unauthorized')) {
          client.invalidateClient();
          auth.clearCachedSession();
          statusBar?.showNotConnected();
        } else {
          vscode.window.showErrorMessage(`Azure DevOps PR Comments: ${msg}`);
          statusBar?.showNoPullRequest();
        }
      }
    } finally {
      refreshInProgress = false;
      if (pollingIntervalSeconds > 0) {
        countdownSeconds = pollingIntervalSeconds;
      }
      if (refreshQueued) {
        refreshQueued = false;
        void refresh();
      }
    }
  }

  async function getPullRequestWithRetry(
    client: AzureDevOpsClient,
    repo: { org: string; project: string; repo: string; organizationUrl: string },
    branch: string,
    output: vscode.OutputChannel,
  ) {
    try {
      return await client.getActivePullRequest(branch);
    } catch (err) {
      if (!(err instanceof AzureDevOpsApiError)) {
        throw err;
      }

      const message = err.message;
      if (
        err.status === 401 &&
        err.wwwAuthenticate &&
        err.wwwAuthenticate.trim().toLowerCase() !== 'bearer' &&
        (message.includes('VS403363') || message.includes('TF400813'))
      ) {
        output.appendLine('Azure DevOps returned an auth challenge. Requesting a tenant-specific token...');
        output.appendLine(`WWW-Authenticate: ${err.wwwAuthenticate}`);
        await auth.signInWithChallenge(err.wwwAuthenticate);

        const retryClient = new AzureDevOpsClient(repo, () => auth.getToken());
        return retryClient.getActivePullRequest(branch);
      }

      throw err;
    }
  }
}

function buildRenderedThreadsKey(
  pullRequestId: number,
  workspaceRoot: vscode.Uri,
  showResolved: boolean,
  mappedThreads: MappedThread[]
): string {
  return JSON.stringify({
    pullRequestId,
    workspaceRoot: workspaceRoot.toString(),
    showResolved,
    threads: mappedThreads.map(({ thread, uri, range }) => ({
      id: thread.id,
      status: thread.status,
      uri: uri.toString(),
      range: {
        start: { line: range.start.line, character: range.start.character },
        end: { line: range.end.line, character: range.end.character },
      },
      comments: thread.comments.map((comment) => ({
        id: comment.id,
        content: comment.content,
        publishedDate: comment.publishedDate,
        lastUpdatedDate: comment.lastUpdatedDate,
        isDeleted: comment.isDeleted ?? false,
      })),
    })),
  });
}

function buildPullRequestUrl(
  repo: { project: string; repo: string; organizationUrl: string },
  pullRequestId: number
): string {
  const organizationUrl = repo.organizationUrl.replace(/\/+$/, '');
  return `${organizationUrl}/${encodeURIComponent(repo.project)}/_git/${encodeURIComponent(repo.repo)}/pullrequest/${pullRequestId}`;
}

export function deactivate(): void {
}
