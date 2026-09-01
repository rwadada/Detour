/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular imports make module boundaries and initialization order hard to reason about.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: "A module nothing imports and that isn't an entry point is probably dead code.",
      from: { orphan: true, pathNot: ['\\.test\\.tsx?$'] },
      to: {},
    },
  ],
  options: {
    // Two independent module graphs (the Node CLI package and the standalone
    // Vite dashboard) — analyzed via separate invocations (see the `dep-cruise`
    // npm script) rather than one shared config, since they don't import
    // across the package boundary (web/src/types.ts is hand-mirrored, not
    // imported, for exactly that reason).
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    exclude: '\\.test\\.tsx?$',
  },
};
