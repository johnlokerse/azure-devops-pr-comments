/**
 * Resolves Azure DevOps attachment image URLs in Markdown content by fetching
 * them with authentication and saving to local temp files that VS Code can
 * render natively.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import * as vscode from 'vscode';

/** Maximum image size to download (5 MB). Larger images are left as-is. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Matches Markdown image syntax: ![alt](url)
 * Captures: group 1 = alt text, group 2 = URL
 */
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

/** Directory used to store fetched images as temp files. */
const IMAGE_DIR = path.join(os.tmpdir(), 'ado-pr-images');

/** In-memory cache: original URL → local file URI string (or null on failure). */
const imageCache = new Map<string, string | null>();

/**
 * Returns true when the URL points to an Azure DevOps hosted attachment
 * (i.e. dev.azure.com or *.visualstudio.com with an _apis path segment).
 */
function isAzureDevOpsImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const isAdoHost =
      host === 'dev.azure.com' ||
      host.endsWith('.visualstudio.com');
    return isAdoHost && parsed.pathname.includes('/_apis/');
  } catch {
    return false;
  }
}

function ensureImageDir(): void {
  if (!fs.existsSync(IMAGE_DIR)) {
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
  }
}

/** Maps common MIME types to file extensions. */
function extensionForMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    case 'image/svg+xml': return 'svg';
    case 'image/bmp': return 'bmp';
    default: return 'png';
  }
}

/**
 * Fetches a single image URL with a Bearer token, saves it to a temp file,
 * and returns a VS Code file URI string, or null on failure.
 */
async function fetchImageToFile(
  url: string,
  token: string
): Promise<string | null> {
  try {
    ensureImageDir();

    // Deterministic filename based on URL
    const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);

    // Check for existing cached file
    const existing = fs.readdirSync(IMAGE_DIR).find((f) => f.startsWith(hash));
    if (existing) {
      return vscode.Uri.file(path.join(IMAGE_DIR, existing)).toString();
    }

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      return null;
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_IMAGE_BYTES) {
      return null;
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      return null;
    }

    const contentType =
      response.headers.get('content-type')?.split(';')[0].trim() || 'image/png';
    const ext = extensionForMime(contentType);
    const filePath = path.join(IMAGE_DIR, `${hash}.${ext}`);
    fs.writeFileSync(filePath, Buffer.from(buffer));

    return vscode.Uri.file(filePath).toString();
  } catch {
    return null;
  }
}

/**
 * Scans `content` for Markdown image references that point to Azure DevOps,
 * fetches them with the provided auth token, saves them locally, and replaces
 * the URLs with local file URIs that VS Code can render.
 *
 * Non-ADO URLs and images that fail to download are left unchanged.
 */
export async function resolveImages(
  content: string,
  getToken: () => Promise<string>
): Promise<string> {
  // Collect all ADO image URLs that need resolving
  const matches: { full: string; alt: string; url: string }[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(MARKDOWN_IMAGE_RE.source, MARKDOWN_IMAGE_RE.flags);
  while ((match = re.exec(content)) !== null) {
    const url = match[2];
    if (isAzureDevOpsImageUrl(url)) {
      matches.push({ full: match[0], alt: match[1], url });
    }
  }

  if (matches.length === 0) {
    return content;
  }

  const token = await getToken();

  // Fetch all images in parallel, using cache when available
  const results = await Promise.all(
    matches.map(async (m) => {
      if (imageCache.has(m.url)) {
        return { ...m, fileUri: imageCache.get(m.url)! };
      }
      const fileUri = await fetchImageToFile(m.url, token);
      imageCache.set(m.url, fileUri);
      return { ...m, fileUri };
    })
  );

  let resolved = content;
  for (const { alt, url, fileUri } of results) {
    if (fileUri) {
      resolved = resolved.replace(`![${alt}](${url})`, `![${alt}](${fileUri})`);
    }
  }

  return resolved;
}

/** Clears the in-memory image cache and removes temp files. */
export function clearImageCache(): void {
  imageCache.clear();
  try {
    if (fs.existsSync(IMAGE_DIR)) {
      for (const file of fs.readdirSync(IMAGE_DIR)) {
        fs.unlinkSync(path.join(IMAGE_DIR, file));
      }
    }
  } catch {
    // best-effort cleanup
  }
}
