// js-yaml 3.x ships no type declarations; ClawMem binds only the surface `src/indexer.ts`'s frontmatter engine uses.
declare module "js-yaml" {
  const jsYaml: {
    safeLoad(src: string, options?: Record<string, unknown>): unknown;
    Schema: new (definition: { include?: unknown[]; implicit?: unknown[]; explicit?: unknown[] }) => unknown;
    CORE_SCHEMA: unknown;
    DEFAULT_SAFE_SCHEMA: { implicit: { tag: string }[]; explicit: { tag: string }[] };
  };
  export default jsYaml;
}
