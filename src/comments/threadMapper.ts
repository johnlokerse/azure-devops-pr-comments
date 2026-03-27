import * as vscode from 'vscode';
import { isResolvedThreadStatus, type PullRequestThread, type PullRequestComment } from '../api/types.js';
import { resolveImages } from './imageProcessor.js';

export interface MappedThread {
  thread: PullRequestThread;
  uri: vscode.Uri;
  range: vscode.Range;
}

export class ThreadMapper {
  constructor(private readonly workspaceRoot: vscode.Uri) {}

  /**
   * Maps PR threads to VS Code file URIs and line ranges.
   * Skips threads without file context (e.g. PR-level comments).
   */
  mapThreads(threads: PullRequestThread[], showResolved: boolean): MappedThread[] {
    const result: MappedThread[] = [];

    for (const thread of threads) {
      if (!thread.threadContext?.filePath) {
        continue;
      }
      if (!showResolved && isResolvedThreadStatus(thread.status)) {
        continue;
      }
      if (thread.comments.length === 0) {
        continue;
      }

      const uri = this.resolveFileUri(thread.threadContext.filePath);
      const range = this.buildRange(thread);
      result.push({ thread, uri, range });
    }

    return result;
  }

  /**
   * Converts an ADO file path (/src/foo.ts) to a workspace URI.
   */
  private resolveFileUri(adoFilePath: string): vscode.Uri {
    // ADO paths start with a leading slash; remove it
    const relativePath = adoFilePath.replace(/^\/+/, '');
    return vscode.Uri.joinPath(this.workspaceRoot, relativePath);
  }

  /**
   * Builds a VS Code Range from the thread's right-file position (feature branch side).
   * Falls back to line 0 if no position info is available.
   */
  private buildRange(thread: PullRequestThread): vscode.Range {
    const ctx = thread.threadContext;
    if (!ctx?.rightFileStart) {
      return new vscode.Range(0, 0, 0, 0);
    }

    // ADO line numbers are 1-based; VS Code is 0-based
    const startLine = Math.max(0, (ctx.rightFileStart.line ?? 1) - 1);
    const endLine = ctx.rightFileEnd
      ? Math.max(0, (ctx.rightFileEnd.line ?? 1) - 1)
      : startLine;

    // Anchor the thread to whole lines instead of character offsets. This is
    // more robust because Azure DevOps offsets can be absent or drift slightly
    // across iterations, while VS Code always renders the gutter marker on the
    // line-based range.
    return new vscode.Range(startLine, 0, endLine, 0);
  }
}

/**
 * Formats a comment for display as a VS Code Comment body (Markdown).
 * Resolves Azure DevOps attachment images to local file URIs.
 */
export async function buildCommentBody(
  comment: PullRequestComment,
  getToken: () => Promise<string>
): Promise<vscode.MarkdownString> {
  const content = await resolveImages(comment.content, getToken);
  const md = new vscode.MarkdownString(content);
  // Do not trust user-controlled PR comment content by default.
  // Use an empty enabledCommands list to prevent command URIs.
  md.isTrusted = { enabledCommands: [] };
  return md;
}

/**
 * Formats the date for display in comment mode.
 */
export function formatDate(isoDate: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(isoDate));
  } catch {
    return isoDate;
  }
}

export function describeThreadLocation(thread: PullRequestThread): string {
  const path = thread.threadContext?.filePath ?? '(no file)';
  const startLine = thread.threadContext?.rightFileStart?.line ?? 1;
  const endLine = thread.threadContext?.rightFileEnd?.line ?? startLine;
  return `${path}:${startLine}-${endLine} [${thread.status}]`;
}
