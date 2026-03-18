import * as vscode from 'vscode';
import type { PullRequest } from '../api/types.js';

export class StatusBarManager implements vscode.Disposable {
  private readonly _item: vscode.StatusBarItem;
  private readonly _refreshItem: vscode.StatusBarItem;
  private readonly _openInAzureDevOpsItem: vscode.StatusBarItem;

  constructor() {
    this._item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this._refreshItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      99
    );
    this._refreshItem.command = 'azurePrComments.refresh';
    this._refreshItem.text = '$(refresh)';
    this._refreshItem.tooltip = 'Refresh Azure DevOps PR comments';
    this._openInAzureDevOpsItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      98
    );
    this._openInAzureDevOpsItem.command = 'azurePrComments.openInAzureDevOps';
    this._openInAzureDevOpsItem.text = '$(link-external)';
    this._openInAzureDevOpsItem.tooltip = 'Open current pull request in Azure DevOps';
  }

  showIdle(): void {
    this._item.command = undefined;
    this._item.text = '$(git-pull-request) Azure PR';
    this._item.tooltip = 'Azure DevOps PR Comments — Use the refresh button to load comments.';
    this._item.show();
    this.showRefreshButton();
    this._openInAzureDevOpsItem.hide();
  }

  showLoading(): void {
    this._item.command = undefined;
    this._item.tooltip = 'Azure DevOps PR Comments — Refreshing';
    this._item.text = '$(sync~spin) Azure PR';
    this._item.show();
    this._refreshItem.command = undefined;
    this._refreshItem.text = '$(sync~spin)';
    this._refreshItem.tooltip = 'Azure DevOps PR Comments — Refreshing';
    this._refreshItem.show();
    this._openInAzureDevOpsItem.hide();
  }

  showPullRequest(pr: PullRequest, threadCount: number): void {
    const icon = '$(git-pull-request)';
    const badge = threadCount > 0 ? ` · $(comment) ${threadCount}` : '';
    this._item.command = undefined;
    this._item.text = `${icon} PR #${pr.pullRequestId}${badge}`;
    this._item.tooltip = `${pr.title}\nUse the refresh button to update comments.`;
    this._item.show();
    this.showRefreshButton();
    this.showOpenInAzureDevOpsButton();
  }

  showNoPullRequest(): void {
    this._item.command = undefined;
    this._item.text = '$(git-branch) No open PR';
    this._item.tooltip = 'No open Azure DevOps pull request for this branch. Use the refresh button to check again.';
    this._item.show();
    this.showRefreshButton();
    this._openInAzureDevOpsItem.hide();
  }

  showAccessDenied(): void {
    this._item.command = 'azurePrComments.diagnose';
    this._item.text = '$(warning) Azure DevOps access denied';
    this._item.tooltip = 'Signed in, but the Azure DevOps API denied access. Click for diagnostics.';
    this._item.show();
    this.showRefreshButton();
    this._openInAzureDevOpsItem.hide();
  }

  showNotConnected(): void {
    this._item.text = '$(azure) Sign in to Azure DevOps';
    this._item.command = 'azurePrComments.signIn';
    this._item.tooltip = 'Click to sign in';
    this._item.show();
    this._refreshItem.hide();
    this._openInAzureDevOpsItem.hide();
  }

  hide(): void {
    this._item.hide();
    this._refreshItem.hide();
    this._openInAzureDevOpsItem.hide();
  }

  dispose(): void {
    this._item.dispose();
    this._refreshItem.dispose();
    this._openInAzureDevOpsItem.dispose();
  }

  private showRefreshButton(): void {
    this._refreshItem.command = 'azurePrComments.refresh';
    this._refreshItem.text = '$(refresh)';
    this._refreshItem.tooltip = 'Refresh Azure DevOps PR comments';
    this._refreshItem.show();
  }

  private showOpenInAzureDevOpsButton(): void {
    this._openInAzureDevOpsItem.command = 'azurePrComments.openInAzureDevOps';
    this._openInAzureDevOpsItem.text = '$(link-external)';
    this._openInAzureDevOpsItem.tooltip = 'Open current pull request in Azure DevOps';
    this._openInAzureDevOpsItem.show();
  }
}
