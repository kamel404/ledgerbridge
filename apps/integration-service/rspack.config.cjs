// Lambda bundle for this service, used by `npm run build:lambda`.
//
// Why rspack: Nest's dependency injection reads TypeScript decorator metadata.
// Plain esbuild does not emit it, so injected services would be undefined at
// runtime. rspack's built-in SWC loader is configured by the Nest CLI with
// `decoratorMetadata: true`, so metadata survives. (Nest 12's webpack builder
// refuses ESM projects, which is why this isn't webpack.)
//
// Output: dist-lambda/<entry>.js, one self-contained CommonJS file per Lambda
// entry point with all node_modules bundled in. CDK uploads this folder as
// the function code (Phase 3).
const path = require('node:path');

/** Writes dist-lambda/package.json so Node treats the bundles as CommonJS,
 *  even though this package is "type": "module". */
class CommonJsMarkerPlugin {
  apply(compiler) {
    const { Compilation, sources } = compiler.webpack;
    compiler.hooks.thisCompilation.tap('CommonJsMarkerPlugin', (compilation) => {
      compilation.hooks.processAssets.tap(
        { name: 'CommonJsMarkerPlugin', stage: Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL },
        () => {
          compilation.emitAsset('package.json', new sources.RawSource('{ "type": "commonjs" }\n'));
        },
      );
    });
  }
}

/**
 * Nest loads some packages only if they are installed (microservices,
 * websockets, class-validator, ...). Skip them in the bundle when they are
 * missing, otherwise the build fails on an import that never runs.
 */
const OPTIONAL_PACKAGE = /^(@nestjs\/(microservices|websockets)|class-validator|class-transformer)(\/|$)/;
function isMissingOptionalPackage(resource) {
  if (!OPTIONAL_PACKAGE.test(resource)) return false;
  try {
    require.resolve(resource, { paths: [__dirname] });
    return false;
  } catch {
    return true;
  }
}

/**
 * @param {import('@rspack/core').Configuration} defaults Nest CLI defaults
 * @param {typeof import('@rspack/core')} rspack
 */
const ENTRIES = {
  // One entry per Lambda. Later phases add reconcile, ...
  http: './src/lambda/http.ts',
  worker: './src/lambda/worker.ts',
  csv: './src/lambda/csv.ts',
  dlq: './src/lambda/dlq.ts',
};

module.exports = (defaults, rspack) => ({
  ...defaults,
  entry: ENTRIES,
  // Bundle every dependency: the Lambda zip has no node_modules folder.
  // Node built-ins (fs, crypto, ...) stay as require() via externalsPresets.
  externals: [],
  externalsPresets: { node: true },
  experiments: {},
  // Dynamic import() stays inside the entry file instead of becoming a chunk.
  // Needed once there are two entries: chunks they share (0.js, 1.js) can't be
  // merged into both by LimitChunkCountPlugin.
  module: {
    ...defaults.module,
    parser: { ...defaults.module?.parser, javascript: { ...defaults.module?.parser?.javascript, dynamicImportMode: 'eager' } },
  },
  output: {
    path: path.resolve(__dirname, 'dist-lambda'),
    filename: '[name].js',
    library: { type: 'commonjs2' },
    clean: true,
  },
  plugins: [
    // Replaces Nest's default IgnorePlugin, which misses '.js'-suffixed paths.
    new rspack.IgnorePlugin({ checkResource: isMissingOptionalPackage }),
    // Inline dynamic imports so each Lambda is exactly one file: one chunk per
    // entry (with maxChunks below the entry count, shared chunks like 0.js appear).
    new rspack.optimize.LimitChunkCountPlugin({ maxChunks: Object.keys(ENTRIES).length }),
    new CommonJsMarkerPlugin(),
  ],
});
