// kap-server bundles agent-core-v2 prompt assets as raw strings.
declare module '*?raw' {
  const content: string;
  export default content;
}

// Node-side renderer contract tests import the lazy KaTeX component without
// executing its Vite-managed stylesheet import.
declare module 'katex/dist/katex.min.css';
