const path = require('path');

// Same setup as logseq-panes-mode: one UMD bundle in build/, CSS/SVG imported as strings.
module.exports = (_env, argv) => ({
  entry: './src/index.ts',
  devtool: argv.mode === 'development' ? 'eval-source-map' : false,
  output: {
    filename: 'index.js',
    path: path.resolve(__dirname, 'build'),
    clean: true,
    library: { type: 'umd', name: 'LogseqAiPanel' },
  },
  resolve: { extensions: ['.ts', '.js'] },
  module: {
    rules: [
      { test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ },
      { test: /\.(css|svg)$/, type: 'asset/source' },
    ],
  },
  performance: { hints: false },
});
