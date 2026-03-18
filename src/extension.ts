import * as vscode from 'vscode';
import { AuthProvider } from './auth/authProvider.js';
import { RepositoryDetector } from './git/repositoryDetector.js';
import { AzureDevOpsApiError, AzureDevOpsClient } from './api/azureDevOpsClient.js';
import { PrCommentController } from './comments/commentController.js';
import { ThreadMapper, describeThreadLocation } from './comments/threadMapper.js';
import { StatusBarManager } from './ui/statusBar.js';

let refreshTimer: ReturnType<typeof setInterval> | undefined;
let commentController: PrCommentController | undefined;
let statusBar: StatusBarManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const auth = new AuthProvider(context.globalState);
  const repoDetector = new RepositoryDetector();
  commentController = new PrCommentController();
  statusBar = new StatusBarManager();
  const output = vscode.window.createOutputChannel('Azure DevOps PR Comments');

  context.subscriptions.push(commentController, statusBar, output);

  // ── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('azurePrComments.signIn', async () => {
      // forceNewSession ensures the user can pick the right account
      await auth.signIn(true);
      await refresh();
    }),

    vscode.commands.registerCommand('azurePrComments.signOut', async () => {
      await auth.signOut();
      commentController?.clearThreads();
      statusBar?.showNotConnected();
    }),

    vscode.commands.registerCommand('azurePrComments.refresh', () => refresh()),

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
        `Azure PR Comments — Diagnostics\n\n${lines.join('\n')}`,
        copy
      );
      if (choice === copy) {
        await vscode.env.clipboard.writeText(msg);
      }
    }),

    vscode.commands.registerCommand('azurePrComments.resolveThread', async (thread: vscode.CommentThread) => {
      await commentController?.resolveThread(thread);
    }),

    vscode.commands.registerCommand('azurePrComments.reopenThread', async (thread: vscode.CommentThread) => {
      await commentController?.reopenThread(thread);
    }),
  );

  // ── Auto-refresh on branch change ─────────────────────────────────────────

  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (gitExtension) {
    if (!gitExtension.isActive) {
      gitExtension.activate().then(() => watchBranchChanges(context, repoDetector, auth, refresh));
    } else {
      watchBranchChanges(context, repoDetector, auth, refresh);
    }
  }

  // ── Initial load ──────────────────────────────────────────────────────────

  refresh();
  setupRefreshTimer(context, refresh);

  // Re-setup timer when config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('azureDevOpsPrComments.refreshIntervalSeconds')) {
        setupRefreshTimer(context, refresh);
      }
      if (e.affectsConfiguration('azureDevOpsPrComments')) {
        void refresh();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      void refresh();
    }),
    vscode.workspace.onDidOpenTextDocument(() => {
      void refresh();
    })
  );

  // ── Core refresh function ─────────────────────────────────────────────────

  async function refresh(): Promise<void> {
    statusBar?.showLoading();
    output.clear();
    output.appendLine('Refreshing Azure DevOps PR comments...');

    // Try to get a session without prompting the user
    const session = await auth.getSession(false);
    if (!session) {
      output.appendLine('No cached Azure DevOps session found.');
      statusBar?.showNotConnected();
      return;
    }
    output.appendLine(`Signed in as: ${session.account.label}`);
    output.appendLine(`Tenant ID: ${auth.getAccountTenantId(session) ?? '(unknown)'}`);
    output.appendLine(`Consumer MSA account: ${auth.isConsumerMicrosoftAccount(session) ? 'yes' : 'no'}`);

    const repo = await repoDetector.detect();
    if (!repo) {
      output.appendLine('No Azure DevOps repository detected in this workspace.');
      statusBar?.hide();
      return;
    }
    output.appendLine(`Repository: ${repo.organizationUrl} / ${repo.project} / ${repo.repo}`);

    const branch = await repoDetector.getCurrentBranch();
    if (!branch) {
      output.appendLine('Could not detect the current branch.');
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
        commentController?.clearThreads();
        return;
      }
      output.appendLine(`PR: #${pr.pullRequestId} ${pr.title}`);

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

      await commentController?.renderThreads(pr, threads, client, workspaceRoot, showResolved);
      output.appendLine('Rendered comment threads in VS Code.');

      const activeThreadCount = threads.filter(
        (t) => t.status === 'active' || t.status === 'pending'
      ).length;

      statusBar?.showPullRequest(pr, activeThreadCount);
    } catch (err) {
      const msg = String(err);
      output.appendLine(`Refresh failed: ${msg}`);
      if (msg.includes('VS403363') && auth.isConsumerMicrosoftAccount(session)) {
        vscode.window.showErrorMessage(
          'Azure PR Comments: this signed-in Microsoft account is a personal/consumer account. Azure DevOps Entra OAuth for this resource does not natively support MSA users, even if the browser session works. Use a work or school account for the extension.'
        );
        statusBar?.showAccessDenied();
      } else if (msg.includes('VS403363')) {
        vscode.window.showErrorMessage(
          'Azure PR Comments: Azure DevOps rejected the current Microsoft account. The extension needs a tenant-specific work or school token for this org.'
        );
        statusBar?.showAccessDenied();
      } else if (msg.includes('TF400813')) {
        vscode.window.showErrorMessage(`Azure PR Comments: ${msg}`);
        statusBar?.showAccessDenied();
      } else if (msg.includes('401') || msg.toLowerCase().includes('unauthorized')) {
        client.invalidateClient();
        auth.clearCachedSession();
        statusBar?.showNotConnected();
      } else {
        vscode.window.showErrorMessage(`Azure PR Comments: ${msg}`);
        statusBar?.showNoPullRequest();
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

function watchBranchChanges(
  context: vscode.ExtensionContext,
  repoDetector: RepositoryDetector,
  _auth: AuthProvider,
  refresh: () => Promise<void>
): void {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (!gitExtension) {
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gitApi = gitExtension.exports.getAPI(1) as any;
  if (!gitApi?.repositories?.length) {
    return;
  }

  const repo = gitApi.repositories[0];
  context.subscriptions.push(
    repo.state.onDidChange(async () => {
      const branch = await repoDetector.getCurrentBranch();
      if (branch) {
        await refresh();
      }
    })
  );
}

function setupRefreshTimer(
  context: vscode.ExtensionContext,
  refresh: () => Promise<void>
): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }

  const config = vscode.workspace.getConfiguration('azureDevOpsPrComments');
  const intervalSeconds = config.get<number>('refreshIntervalSeconds', 60);

  if (intervalSeconds > 0) {
    refreshTimer = setInterval(() => refresh(), intervalSeconds * 1000);
    context.subscriptions.push({ dispose: () => { if (refreshTimer) { clearInterval(refreshTimer); } } });
  }
}

export function deactivate(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
}
