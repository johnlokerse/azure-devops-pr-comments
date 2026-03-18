export interface AdoRepository {
  org: string;
  project: string;
  repo: string;
  organizationUrl: string;
}

export interface PullRequest {
  pullRequestId: number;
  title: string;
  description?: string;
  status: string;
  sourceBranch: string;
  targetBranch: string;
  createdBy: AdoIdentity;
  creationDate: string;
}

export interface AdoIdentity {
  displayName: string;
  uniqueName: string;
  imageUrl?: string;
  id: string;
}

export interface PullRequestThread {
  id: number;
  status: ThreadStatus;
  threadContext?: ThreadContext;
  comments: PullRequestComment[];
  isDeleted?: boolean;
}

export type ThreadStatus = 'active' | 'fixed' | 'wontFix' | 'closed' | 'byDesign' | 'pending' | 'unknown';

export interface ThreadContext {
  filePath: string;
  rightFileStart?: FilePosition;
  rightFileEnd?: FilePosition;
  leftFileStart?: FilePosition;
  leftFileEnd?: FilePosition;
}

export interface FilePosition {
  line: number;
  offset: number;
}

export interface PullRequestComment {
  id: number;
  content: string;
  author: AdoIdentity;
  publishedDate: string;
  lastUpdatedDate: string;
  commentType: CommentType;
  isDeleted?: boolean;
}

export type CommentType = 'unknown' | 'text' | 'codeChange' | 'system';
