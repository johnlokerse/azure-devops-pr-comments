# Contributing

## Quick start

```bash
npm install
```

## Development workflow (fast iteration)

The project uses **esbuild** to bundle the extension into a single `dist/extension.js`. No VSIX build needed during development.

1. **Open a terminal** and start esbuild in watch mode:
   ```bash
   npm run watch
   ```
   This does an initial build and then automatically rebuilds on every file change.

2. **Press F5** in VS Code. This opens an **Extension Development Host** — a separate VS Code window with the extension loaded.

3. **In the dev host**, open an Azure DevOps git repository that has an active pull request. Use **Azure DevOps PR Comments: Sign In** to authenticate.

4. **Edit source files** in `src/`. Esbuild rebuilds the bundle automatically in the terminal.

5. **Reload the dev host** (`Developer: Reload Window` or `Cmd+R`) to pick up the latest build.

> **Note:** Breakpoints work in TypeScript source files because esbuild generates sourcemaps in development mode.

## Build VSIX (for release)

```bash
npm run build:prod
npx @vscode/vsce package
```

Output: `azure-devops-pr-comments-<version>.vsix`

## Scripts

| Command | Purpose |
|---|---|
| `npm run build` | One-shot esbuild dev build (with sourcemaps) |
| `npm run build:prod` | Minified production build |
| `npm run watch` | Continuous rebuild on file changes |
| `npm run lint` | ESLint check |
