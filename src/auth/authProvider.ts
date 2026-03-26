import * as vscode from 'vscode';

// Delegated scope for Azure DevOps Services — grants access on behalf of the signed-in user.
// '.default' requests app-only permissions and causes TF400813 unauthorized errors.
const ADO_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/user_impersonation';
const AUTH_PROVIDER_ID = 'microsoft';
const PREFERRED_ACCOUNT_ID_KEY = 'azureDevOpsPrComments.preferredMicrosoftAccountId';
const SIGN_IN_DETAIL = 'Sign in with the Microsoft work or school account that has access to your Azure DevOps organization.';
const CONSUMER_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';
const HIDDEN_ACCOUNTS_KEY = 'azureDevOpsPrComments.hiddenAccountIds';

interface AccountQuickPickItem extends vscode.QuickPickItem {
  account?: vscode.AuthenticationSessionAccountInformation;
  action?: 'new' | 'showAll';
}

export class AuthProvider {
  private _session: vscode.AuthenticationSession | undefined;

  constructor(private readonly state: vscode.Memento) {}

  /**
   * Returns a valid session, prompting sign-in if needed.
   */
  async getSession(createIfNone = true): Promise<vscode.AuthenticationSession | undefined> {
    if (!createIfNone && this._session) {
      return this._session;
    }

    try {
      const preferredAccount = await this.getPreferredAccount();
      const hasStoredPreference = this.state.get<string>(PREFERRED_ACCOUNT_ID_KEY) !== undefined;

      let session: vscode.AuthenticationSession | undefined;

      if (createIfNone) {
        // Interactive mode: prompt for sign-in if needed.
        session = await vscode.authentication.getSession(
          AUTH_PROVIDER_ID,
          [ADO_SCOPE],
          {
            createIfNone: { detail: SIGN_IN_DETAIL },
            ...(preferredAccount ? { account: preferredAccount } : {}),
          },
        );
      } else {
        // Silent session restoration — try progressively harder strategies.
        // Each has its own try/catch so a failure doesn't skip later attempts.
        session = await this.restoreSessionSilently(preferredAccount, hasStoredPreference);
      }

      if (session) {
        this._session = session;
        await this.state.update(PREFERRED_ACCOUNT_ID_KEY, session.account.id);
      }
      return session ?? this._session;
    } catch (err) {
      if (!createIfNone) {
        return this._session;
      }
      throw err;
    }
  }

  /**
   * Tries multiple strategies to restore an existing session without showing
   * a sign-in prompt. Handles auth-provider initialisation delays that occur
   * after extension-update reloads.
   */
  private async restoreSessionSilently(
    preferredAccount: vscode.AuthenticationSessionAccountInformation | undefined,
    hasStoredPreference: boolean,
  ): Promise<vscode.AuthenticationSession | undefined> {
    const accountOpt = preferredAccount ? { account: preferredAccount } : {};

    // 1. Quick silent check — no provider activation, instant result.
    try {
      const s = await vscode.authentication.getSession(
        AUTH_PROVIDER_ID, [ADO_SCOPE], { silent: true, ...accountOpt },
      );
      if (s) { return s; }
    } catch { /* provider may not be ready yet */ }

    // 2. Non-silent check — activates the provider but does not create a
    //    session. The account hint helps VS Code pick the right session even
    //    when the session preference has been cleared.
    try {
      const s = await vscode.authentication.getSession(
        AUTH_PROVIDER_ID, [ADO_SCOPE], accountOpt,
      );
      if (s) { return s; }
    } catch { /* continue to retries */ }

    // 3. Retry loop — the provider may still be loading sessions from the OS
    //    credential store (common after extension-update reloads).
    if (!hasStoredPreference) { return undefined; }

    for (const delay of [1500, 3000]) {
      await new Promise((r) => setTimeout(r, delay));
      try {
        const retryAccount = await this.getPreferredAccount();
        const retryOpt = retryAccount ? { account: retryAccount } : {};
        const s = await vscode.authentication.getSession(
          AUTH_PROVIDER_ID, [ADO_SCOPE], { silent: true, ...retryOpt },
        );
        if (s) { return s; }
      } catch { /* keep trying */ }
    }

    return undefined;
  }

  /**
   * Returns the Bearer token for use in API calls. Prompts sign-in if no session exists.
   */
  async getToken(): Promise<string> {
    const session = await this.getSession(true);
    if (!session) {
      throw new Error('Not signed in to Azure DevOps. Run "Azure DevOps PR Comments: Sign In".');
    }
    return session.accessToken;
  }

  async signInWithChallenge(wwwAuthenticate: string): Promise<void> {
    this._session = await vscode.authentication.getSession(
      AUTH_PROVIDER_ID,
      { wwwAuthenticate, fallbackScopes: [ADO_SCOPE] },
      {
        forceNewSession: {
          detail: `${SIGN_IN_DETAIL} Azure DevOps requested a tenant-specific sign-in challenge.`,
        },
      }
    );

    await this.state.update(PREFERRED_ACCOUNT_ID_KEY, this._session.account.id);
    vscode.window.showInformationMessage(
      `Signed in to Azure DevOps as ${this._session.account.label}.`
    );
  }

  /**
   * Sign in explicitly (shows the browser auth flow).
   * Pass forceNewSession=true to always prompt for account selection.
   */
  async signIn(forceNewSession = false): Promise<void> {
    this._session = forceNewSession
      ? await this.promptForAccountSelection()
      : await vscode.authentication.getSession(
          AUTH_PROVIDER_ID,
          [ADO_SCOPE],
          { createIfNone: { detail: SIGN_IN_DETAIL } }
        );

    await this.state.update(PREFERRED_ACCOUNT_ID_KEY, this._session.account.id);
    vscode.window.showInformationMessage(
      `Signed in to Azure DevOps as ${this._session?.account.label ?? 'unknown'}.`
    );
  }

  /**
   * Sign out by clearing the cached session. VS Code manages token storage,
   * so we just remove our reference.
   */
  async signOut(): Promise<void> {
    this._session = undefined;
    await this.state.update(PREFERRED_ACCOUNT_ID_KEY, undefined);
    vscode.window.showInformationMessage('Signed out of Azure DevOps.');
  }

  clearCachedSession(): void {
    this._session = undefined;
  }

  hasStoredPreference(): boolean {
    return this.state.get<string>(PREFERRED_ACCOUNT_ID_KEY) !== undefined;
  }

  isSignedIn(): boolean {
    return this._session !== undefined;
  }

  getDisplayName(): string | undefined {
    return this._session?.account.label;
  }

  getAccountTenantId(session: vscode.AuthenticationSession | undefined = this._session): string | undefined {
    const accountId = session?.account.id;
    if (!accountId) {
      return undefined;
    }

    const parts = accountId.split('.');
    return parts.length > 1 ? parts[parts.length - 1] : undefined;
  }

  isConsumerMicrosoftAccount(session: vscode.AuthenticationSession | undefined = this._session): boolean {
    return this.getAccountTenantId(session) === CONSUMER_TENANT_ID;
  }

  private async getPreferredAccount(): Promise<vscode.AuthenticationSessionAccountInformation | undefined> {
    const preferredAccountId = this.state.get<string>(PREFERRED_ACCOUNT_ID_KEY);
    if (!preferredAccountId) {
      return undefined;
    }

    const accounts = await vscode.authentication.getAccounts(AUTH_PROVIDER_ID);
    return accounts.find((account) => account.id === preferredAccountId);
  }

  private async promptForAccountSelection(): Promise<vscode.AuthenticationSession> {
    const accounts = await vscode.authentication.getAccounts(AUTH_PROVIDER_ID);
    const hiddenAccountIds = this.state.get<string[]>(HIDDEN_ACCOUNTS_KEY, []);
    const visibleAccounts = accounts.filter((a) => !hiddenAccountIds.includes(a.id));

    if (visibleAccounts.length === 0 && hiddenAccountIds.length === 0) {
      return vscode.authentication.getSession(AUTH_PROVIDER_ID, [ADO_SCOPE], {
        forceNewSession: { detail: SIGN_IN_DETAIL },
      });
    }

    const trashButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('trash'),
      tooltip: 'Remove this account from the list',
    };

    return new Promise<vscode.AuthenticationSession>((resolve, reject) => {
      const qp = vscode.window.createQuickPick<AccountQuickPickItem>();
      qp.title = 'Choose the Microsoft account to use for Azure DevOps';
      qp.placeholder = 'Your work or school account is required for Entra-backed Azure DevOps orgs.';

      const buildItems = (): AccountQuickPickItem[] => {
        const items: AccountQuickPickItem[] = visibleAccounts.map((account) => ({
          label: account.label,
          description: 'Existing Microsoft account',
          account,
          buttons: [trashButton],
        }));
        items.push({
          label: 'Use another Microsoft account',
          description: 'Sign in with a different work or school account',
          action: 'new',
        });
        if (hiddenAccountIds.length > 0) {
          items.push({
            label: `$(eye) Show hidden accounts (${hiddenAccountIds.length})`,
            description: 'Unhide previously removed accounts',
            action: 'showAll',
          });
        }
        return items;
      };

      qp.items = buildItems();
      let settled = false;

      qp.onDidTriggerItemButton(async (e) => {
        const item = e.item;
        if (item.account) {
          hiddenAccountIds.push(item.account.id);
          await this.state.update(HIDDEN_ACCOUNTS_KEY, hiddenAccountIds);
          const idx = visibleAccounts.findIndex((a) => a.id === item.account!.id);
          if (idx >= 0) { visibleAccounts.splice(idx, 1); }
          qp.items = buildItems();
        }
      });

      qp.onDidAccept(async () => {
        const selection = qp.selectedItems[0];
        if (!selection || settled) { return; }
        settled = true;
        qp.dispose();

        try {
          if (selection.action === 'showAll') {
            await this.state.update(HIDDEN_ACCOUNTS_KEY, []);
            resolve(await this.promptForAccountSelection());
            return;
          }

          if (selection.action === 'new' || !selection.account) {
            resolve(
              await vscode.authentication.getSession(AUTH_PROVIDER_ID, [ADO_SCOPE], {
                forceNewSession: { detail: SIGN_IN_DETAIL },
              }),
            );
            return;
          }

          resolve(
            await vscode.authentication.getSession(AUTH_PROVIDER_ID, [ADO_SCOPE], {
              createIfNone: { detail: SIGN_IN_DETAIL },
              account: selection.account,
            }),
          );
        } catch (err) {
          reject(err);
        }
      });

      qp.onDidHide(() => {
        if (!settled) {
          settled = true;
          qp.dispose();
          reject(new Error('Sign-in cancelled.'));
        }
      });

      qp.show();
    });
  }
}
