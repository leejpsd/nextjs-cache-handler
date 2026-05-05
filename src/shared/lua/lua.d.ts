// Ambient declaration so `.lua` imports type-check. tsup's `loader: { '.lua':
// 'text' }` returns the file contents as a string at bundle time.
declare module "*.lua" {
  const content: string;
  export default content;
}
