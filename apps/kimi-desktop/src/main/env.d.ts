// kap-server bundles agent-core-v2 prompt assets as raw strings.
declare module '*?raw' {
  const content: string;
  export default content;
}
