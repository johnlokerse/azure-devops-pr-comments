# Azure DevOps PR Comments

A Visual Studio Code extension that shows Azure DevOps pull request comments **inline in your editor** — so you can read, reply to, and resolve review threads without leaving VS Code.

## Features

- **Inline comments**: PR review threads appear as annotations on the exact lines they reference
- **Microsoft Entra ID sign-in**: Authenticate securely with your work account — no Personal Access Tokens needed
- **Auto-detection**: Automatically detects your Azure DevOps organization, project, and repository from your git remote URL
- **Interactive**: Reply to threads and resolve/reopen them directly from the editor
- **Status bar**: Shows the current PR number and open comment count at a glance
- **Auto-refresh**: Automatically refreshes comments in the background (configurable interval)

## Getting Started

1. Open a workspace that is cloned from an Azure DevOps repository
2. Run **Azure PR Comments: Sign In** from the Command Palette (`Ctrl+Shift+P`)
3. Sign in with your Microsoft/Entra ID account in the browser
4. PR comments for your current branch will appear inline in the editor

## Requirements

- VS Code 1.85 or later
- A repository cloned from Azure DevOps Services (`dev.azure.com`)
- A Microsoft/Entra ID account with access to the Azure DevOps organization

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `azureDevOpsPrComments.organizationUrl` | *(auto-detect)* | Override the Azure DevOps organization URL |
| `azureDevOpsPrComments.project` | *(auto-detect)* | Override the Azure DevOps project name |
| `azureDevOpsPrComments.refreshIntervalSeconds` | `60` | Auto-refresh interval in seconds (0 to disable) |
| `azureDevOpsPrComments.showResolvedThreads` | `false` | Show resolved/closed comment threads |

## Commands

| Command | Description |
|---|---|
| `Azure PR Comments: Sign In` | Sign in to Azure DevOps via Entra ID |
| `Azure PR Comments: Sign Out` | Sign out |
| `Azure PR Comments: Refresh PR Comments` | Manually refresh comments |

## Supported Remote URL Formats

The extension auto-detects your Azure DevOps repository from the following git remote URL formats:

- `https://dev.azure.com/org/project/_git/repo`
- `https://org@dev.azure.com/org/project/_git/repo`
- `https://org.visualstudio.com/project/_git/repo`
- `git@ssh.dev.azure.com:v3/org/project/repo`

## Known Limitations

- Only the first open PR for the current branch is shown
- PR-level comments (not attached to a file) are not shown inline
- Only Azure DevOps Services (cloud) is supported; Azure DevOps Server (on-premise) is not
