import * as vscode from 'vscode';
import type { AdoRepository } from '../api/types.js';

// Matches: https://dev.azure.com/org/project/_git/repo
const DEV_AZURE_COM_REGEX = /https?:\/\/(?:[^@]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)/;

// Matches: https://org.visualstudio.com/project/_git/repo
const VISUALSTUDIO_COM_REGEX = /https?:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+)/;

// Matches SSH: git@ssh.dev.azure.com:v3/org/project/repo
const SSH_DEV_AZURE_REGEX = /git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)/;

interface GitExtensionAPI {
  repositories: GitRepository[];
}

interface GitRepository {
  state: {
    remotes: Array<{ fetchUrl?: string; pushUrl?: string }>;
    HEAD?: { name?: string };
  };
}

export class RepositoryDetector {
  /**
   * Returns the Azure DevOps repository details for the current workspace,
   * or undefined if the workspace is not an Azure DevOps repo.
   * Workspace settings override auto-detection.
   */
  async detect(): Promise<AdoRepository | undefined> {
    const config = vscode.workspace.getConfiguration('azureDevOpsPrComments');
    const configOrg = config.get<string>('organizationUrl')?.trim();
    const configProject = config.get<string>('project')?.trim();

    const remoteUrl = await this.getRemoteUrl();
    if (!remoteUrl) {
      if (configOrg && configProject) {
        // Can't auto-detect repo name without a remote URL
        vscode.window.showWarningMessage(
          'Azure DevOps PR Comments: Could not detect repository from git remote. Please ensure this is an Azure DevOps repository.'
        );
      }
      return undefined;
    }

    const parsed = this.parseRemoteUrl(remoteUrl);
    if (!parsed) {
      return undefined;
    }

    // Settings override auto-detected org/project
    const org = configOrg
      ? configOrg.replace(/\/+$/, '').split('/').pop() ?? parsed.org
      : parsed.org;
    const project = configProject || parsed.project;

    return {
      org,
      project,
      repo: parsed.repo,
      organizationUrl: configOrg || `https://dev.azure.com/${parsed.org}`,
    };
  }

  /**
   * Returns the current git branch name via the VS Code git extension API.
   */
  async getCurrentBranch(): Promise<string | undefined> {
    const gitApi = await this.getGitApi();
    if (!gitApi || gitApi.repositories.length === 0) {
      return undefined;
    }
    return gitApi.repositories[0].state.HEAD?.name;
  }

  private async getRemoteUrl(): Promise<string | undefined> {
    const gitApi = await this.getGitApi();
    if (!gitApi || gitApi.repositories.length === 0) {
      return undefined;
    }
    const remotes = gitApi.repositories[0].state.remotes;
    const origin = remotes.find((r) => r.fetchUrl?.includes('azure.com') || r.fetchUrl?.includes('visualstudio.com'));
    return origin?.fetchUrl ?? remotes[0]?.fetchUrl;
  }

  private async getGitApi(): Promise<GitExtensionAPI | undefined> {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (!gitExtension) {
      return undefined;
    }
    if (!gitExtension.isActive) {
      await gitExtension.activate();
    }
    return gitExtension.exports.getAPI(1) as GitExtensionAPI;
  }

  parseRemoteUrl(url: string): { org: string; project: string; repo: string } | undefined {
    const devAzure = url.match(DEV_AZURE_COM_REGEX);
    if (devAzure) {
      return { org: devAzure[1], project: devAzure[2], repo: devAzure[3] };
    }

    const vscom = url.match(VISUALSTUDIO_COM_REGEX);
    if (vscom) {
      return { org: vscom[1], project: vscom[2], repo: vscom[3] };
    }

    const ssh = url.match(SSH_DEV_AZURE_REGEX);
    if (ssh) {
      return { org: ssh[1], project: ssh[2], repo: ssh[3] };
    }

    return undefined;
  }
}
