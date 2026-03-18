import * as vscode from 'vscode';
import type { PullRequest } from '../api/types.js';

export class StatusBarManager implements vscode.Disposable {
  private readonly _item: vscode.StatusBarItem;

  constructor() {
    this._item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this._item.command = 'azurePrComments.refresh';
    this._item.tooltip = 'Azure DevOps PR Comments — Click to refresh';
  }

  showLoading(): void {
    this._item.command = 'azurePrComments.refresh';
    this._item.tooltip = 'Azure DevOps PR Comments — Refreshing';
    this._item.text = '$(sync~spin) Azure PR';
    this._item.show();
  }

  showPullRequest(pr: PullRequest, threadCount: number): void {
    const icon = '$(git-pull-request)';
    const badge = threadCount > 0 ? ` · $(comment) ${threadCount}` : '';
    this._item.command = 'azurePrComments.refresh';
    this._item.text = `${icon} PR #${pr.pullRequestId}${badge}`;
    this._item.tooltip = `${pr.title}\nClick to refresh comments`;
    this._item.show();
  }

  showNoPullRequest(): void {
    this._item.command = 'azurePrComments.refresh';
    this._item.text = '$(git-branch) No open PR';
    this._item.tooltip = 'No open Azure DevOps pull request for this branch';
    this._item.show();
  }

  showAccessDenied(): void {
    this._item.command = 'azurePrComments.diagnose';
    this._item.text = '$(warning) Azure DevOps access denied';
    this._item.tooltip = 'Signed in, but the Azure DevOps API denied access. Click for diagnostics.';
    this._item.show();
  }

  showNotConnected(): void {
    this._item.text = '$(azure) Sign in to Azure DevOps';
    this._item.command = 'azurePrComments.signIn';
    this._item.tooltip = 'Click to sign in';
    this._item.show();
  }

  hide(): void {
    this._item.hide();
  }

  dispose(): void {
    this._item.dispose();
  }
}
