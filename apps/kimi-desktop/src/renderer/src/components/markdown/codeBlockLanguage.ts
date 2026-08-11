const LANGUAGE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  js: 'JavaScript', jsx: 'JavaScript', javascript: 'JavaScript',
  ts: 'TypeScript', tsx: 'TypeScript', typescript: 'TypeScript',
  json: 'JSON', jsonc: 'JSON', json5: 'JSON',
  py: 'Python', python: 'Python',
  rb: 'Ruby', ruby: 'Ruby',
  go: 'Go', rs: 'Rust', rust: 'Rust',
  c: 'C', cpp: 'C++', 'c++': 'C++', csharp: 'C#', 'c#': 'C#',
  java: 'Java', kt: 'Kotlin', kotlin: 'Kotlin',
  swift: 'Swift', php: 'PHP',
  sh: 'Shell', bash: 'Bash', shell: 'Shell', shellscript: 'Shell', zsh: 'Zsh',
  sql: 'SQL', graphql: 'GraphQL',
  html: 'HTML', xml: 'XML', svg: 'SVG',
  css: 'CSS', scss: 'SCSS', less: 'Less', postcss: 'PostCSS',
  md: 'Markdown', markdown: 'Markdown', mdx: 'MDX',
  yaml: 'YAML', yml: 'YAML', toml: 'TOML',
  dockerfile: 'Dockerfile', make: 'Makefile', makefile: 'Makefile',
  ini: 'INI', powershell: 'PowerShell', ps1: 'PowerShell',
  diff: 'Diff', latex: 'LaTeX', tex: 'LaTeX',
  nix: 'Nix', proto: 'Protocol Buffer', cmake: 'CMake', wasm: 'WebAssembly',
  'objective-c': 'Objective-C', 'shell session': 'Shell Session',
};

export interface CodeBlockLanguage {
  readonly id: string | null;
  readonly label: string;
}

export function codeBlockLanguage(language: string | undefined): CodeBlockLanguage {
  const raw = language?.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (raw === '' || raw === 'text' || raw === 'plaintext' || raw === 'txt') {
    return { id: null, label: '纯文本' };
  }
  return { id: raw, label: LANGUAGE_DISPLAY_NAMES[raw] ?? raw };
}
