import * as vscode from 'vscode';

// Delegated scope for Azure DevOps Services — grants access on behalf of the signed-in user.
// '.default' requests app-only permissions and causes TF400813 unauthorized errors.
const ADO_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/user_impersonation';
const AUTH_PROVIDER_ID = 'microsoft';
const PREFERRED_ACCOUNT_ID_KEY = 'azureDevOpsPrComments.preferredMicrosoftAccountId';
const SIGN_IN_DETAIL = 'Sign in with the Microsoft work or school account that has access to your Azure DevOps organization.';
const CONSUMER_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';

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
      const session = await vscode.authentication.getSession(
        AUTH_PROVIDER_ID,
        [ADO_SCOPE],
        createIfNone
          ? {
              createIfNone: { detail: SIGN_IN_DETAIL },
              ...(preferredAccount ? { account: preferredAccount } : {}),
            }
          : {
              createIfNone: false,
              ...(preferredAccount ? { account: preferredAccount } : {}),
            }
      );
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
   * Returns the Bearer token for use in API calls. Prompts sign-in if no session exists.
   */
  async getToken(): Promise<string> {
    const session = await this.getSession(true);
    if (!session) {
      throw new Error('Not signed in to Azure DevOps. Run "Azure PR Comments: Sign In".');
    }
    return session.accessToken;
  }

  async signInWithChallenge(wwwAuthenticate: string): Promise<void> {
    this._session = await vscode.authentication.getSession(
      AUTH_PROVIDER_ID,
      { wwwAuthenticate, fallbackScopes: [ADO_SCOPE] },
      {
        clearSessionPreference: true,
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

    if (accounts.length === 0) {
      return vscode.authentication.getSession(AUTH_PROVIDER_ID, [ADO_SCOPE], {
        clearSessionPreference: true,
        forceNewSession: { detail: SIGN_IN_DETAIL },
      });
    }

    const selection = await vscode.window.showQuickPick(
      [
        ...accounts.map((account) => ({
          label: account.label,
          description: 'Existing Microsoft account',
          account,
        })),
        {
          label: 'Use another Microsoft account',
          description: 'Sign in with a different work or school account',
        },
      ],
      {
        title: 'Choose the Microsoft account to use for Azure DevOps',
        placeHolder: 'Your work or school account is required for Entra-backed Azure DevOps orgs.',
      }
    );

    if (!selection) {
      throw new Error('Sign-in cancelled.');
    }

    if (!('account' in selection) || !selection.account) {
      return vscode.authentication.getSession(AUTH_PROVIDER_ID, [ADO_SCOPE], {
        clearSessionPreference: true,
        forceNewSession: { detail: SIGN_IN_DETAIL },
      });
    }

    return vscode.authentication.getSession(AUTH_PROVIDER_ID, [ADO_SCOPE], {
      clearSessionPreference: true,
      createIfNone: { detail: SIGN_IN_DETAIL },
      account: selection.account,
    });
  }
}
