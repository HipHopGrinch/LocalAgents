export function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'py':
      return 'python';
    case 'json':
      return 'json';
    case 'html':
      return 'html';
    case 'css':
      return 'css';
    case 'md':
      return 'markdown';
    case 'rs':
      return 'rust';
    case 'go':
      return 'go';
    case 'cpp':
    case 'c':
    case 'h':
    case 'hpp':
      return 'cpp';
    case 'ps1':
    case 'psm1':
      return 'powershell';
    case 'sh':
    case 'bash':
      return 'shell';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'sql':
      return 'sql';
    default:
      return 'plaintext';
  }
}
