# Azure DevOps PR Comments

This extension shows Azure DevOps pull request comment threads inline in VS Code.

It is meant for working with an existing pull request from your local branch. You can load the current PR, read file-level review comments in the editor, reply to a thread, resolve or reopen a thread, and open the PR in Azure DevOps.

![Example of inline PR comments in VS Code](images/example.png)

## What it does

- Shows file-level PR comment threads on the lines they belong to
- Lets you reply to an existing thread from VS Code
- Lets you resolve or reopen a thread
- Adds status bar buttons for manual refresh and opening the PR in Azure DevOps

## How to use it

1. Open a repository that is cloned from Azure DevOps Services.
2. Run **Azure DevOps PR Comments: Sign In** from the Command Palette.
3. Sign in with your Microsoft/Entra ID work account.
4. Click the refresh button in the status bar, or run **Azure DevOps PR Comments: Refresh PR Comments**.
5. If the current branch has an active pull request, the related file-level threads will appear in the editor.

## Requirements

- VS Code 1.85 or later
- A repository hosted in Azure DevOps Services (`dev.azure.com`)
- Access to the Azure DevOps organization with a Microsoft/Entra ID account (personal accounts do not work!)

## Settings

| Setting | Default | Description |
|---|---|---|
| `azureDevOpsPrComments.organizationUrl` | *(auto-detect)* | Override the detected Azure DevOps organization URL |
| `azureDevOpsPrComments.project` | *(auto-detect)* | Override the detected Azure DevOps project name |
| `azureDevOpsPrComments.showResolvedThreads` | `false` | Show resolved threads as well |

## Commands

| Command | Description |
|---|---|
| `Azure DevOps PR Comments: Sign In` | Sign in to Azure DevOps |
| `Azure DevOps PR Comments: Sign Out` | Sign out |
| `Azure DevOps PR Comments: Refresh PR Comments` | Load or refresh comments for the current PR |
| `Azure DevOps PR Comments: Open in Azure DevOps` | Open the current PR in Azure DevOps |
| `Azure DevOps PR Comments: Show Diagnostics` | Show basic diagnostics for sign-in, repository detection, and PR lookup |

## Notes

- Refresh is manual. The extension does not auto-refresh comments in the background.
- Only the first active PR for the current branch is shown.
- Only file-level threads are shown inline. PR-level comments without a file are not.
- Creating new top-level review threads is not supported from the editor at the moment.
- Azure DevOps Server (on-premises) is not supported.

## Supported remote URL formats

- `https://dev.azure.com/org/project/_git/repo`
- `https://org@dev.azure.com/org/project/_git/repo`
- `https://org.visualstudio.com/project/_git/repo`
- `git@ssh.dev.azure.com:v3/org/project/repo`
