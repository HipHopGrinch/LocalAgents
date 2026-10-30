export type DeliveryStack = 'typescript' | 'static-web' | 'python' | 'go' | 'rust' | 'node';

const STACKS: DeliveryStack[] = ['typescript', 'static-web', 'python', 'go', 'rust', 'node'];

export function isDeliveryStack(value: string): value is DeliveryStack {
  return (STACKS as string[]).includes(value);
}

/**
 * Infer how the user wants the result delivered.
 * Website language without React/TypeScript means a browser-openable static site.
 */
export function inferDeliveryStack(text: string): DeliveryStack {
  const t = text.toLowerCase();
  if (/\b(rust|cargo)\b/.test(t)) return 'rust';
  if (/\b(golang|\bgo\s+(cli|app|module|program)|go\.mod)\b/.test(t) || /\bin go\b/.test(t)) return 'go';
  if (/\b(python|tkinter|django|flask|fastapi|\.py\b)\b/.test(t)) return 'python';
  if (/\belectron\b/.test(t)) return 'node';
  if (/\b(react|next\.js|nextjs|\.tsx\b|typescript)\b/.test(t) && !/\b(no react|no typescript|plain html|static html)\b/.test(t)) {
    return 'typescript';
  }
  if (/\b(html|webpage|website|web page|browser|landing|e-?commerce|shop|store|cart)\b/.test(t)) {
    return 'static-web';
  }
  if (/\b(node|npm|express)\b/.test(t)) return 'node';
  return 'typescript';
}

export function stackFromFilePaths(paths: string[]): DeliveryStack | null {
  const files = paths.map(p => p.toLowerCase());
  if (files.some(p => p.endsWith('.rs') || p.endsWith('cargo.toml'))) return 'rust';
  if (files.some(p => p.endsWith('.go') || p.endsWith('go.mod'))) return 'go';
  if (files.some(p => p.endsWith('.py'))) return 'python';
  const hasTs = files.some(p => p.endsWith('.ts') || p.endsWith('.tsx'));
  const hasHtml = files.some(p => p.endsWith('.html'));
  if (hasHtml && !hasTs) return 'static-web';
  if (files.some(p => p.endsWith('package.json') || p.endsWith('.js'))) {
    if (!hasTs) return hasHtml ? 'static-web' : 'node';
  }
  if (hasTs) return 'typescript';
  return null;
}

export function verifyCommandForStack(stack: DeliveryStack): string | null {
  switch (stack) {
    case 'python':
      return 'python -c "import pathlib,py_compile,sys; files=list(pathlib.Path(\'.\').rglob(\'*.py\'));\n[py_compile.compile(str(f), doraise=True) for f in files[:12]]; print(\'python ok\', len(files))"';
    case 'go':
      return 'go build ./...';
    case 'rust':
      return 'cargo build';
    case 'node':
      return 'npm install';
    case 'static-web':
      return 'powershell -NoProfile -Command "if (Test-Path -Path index.html) { Write-Output \'index.html ok\'; exit 0 } else { Write-Output \'missing index.html\'; exit 1 }"';
    default:
      return null;
  }
}

export const DELIVERY_POLICY = `## Delivery policy (assume and execute)
Infer the stack from the user's words and the files already in the workspace, state that assumption in one sentence, then implement it. Do not stop to ask unless two stacks are equally plausible.

- Browser site, shop, cart, or "open in a browser" without React/TypeScript: static index.html + styles.css + app.js. No build step.
- Python: .py files plus a run command.
- Electron or a Node server: package.json and JavaScript or TypeScript matching the request.
- Go: go.mod and .go files, then go build.
- Rust: Cargo.toml and src/main.rs, then cargo build.
- Do not invent React or TypeScript for a request that asked for a webpage, HTML, or a simple script.
- If an APPROVED PLAN is present, follow that stack exactly.
- When the user wants pictures and <generate_image> is available, call it and reference the saved file. If it returns a placeholder path, use that path.
- Use <web_search> for library APIs, install docs, and errors you cannot resolve from the workspace.`;

export const TOOLCHAIN_PLAYBOOK = `## Toolchain playbook (Windows PowerShell)
After writing files, run the check for that stack. If the tool is missing, install it with winget, then retry the build once.
- Python: python --version, then winget install -e --id Python.Python.3.12 if missing.
- Node: node --version, then winget install -e --id OpenJS.NodeJS.LTS if missing.
- Go: go version, then winget install -e --id GoLang.Go if missing.
- Rust: cargo --version, then winget install -e --id Rustlang.Rustup if missing.
Do not run format, diskpart, del /s, or recursive force-deletes.`;
