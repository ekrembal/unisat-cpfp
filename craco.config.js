const webpack = require('webpack');

module.exports = {
  webpack: {
    configure: (webpackConfig) => {
      // Add fallbacks for Node.js modules
      webpackConfig.resolve.fallback = {
        ...webpackConfig.resolve.fallback,
        buffer: require.resolve('buffer'),
        crypto: require.resolve('crypto-browserify'),
        stream: require.resolve('stream-browserify'),
        util: require.resolve('util'),
        process: require.resolve('process/browser'),
        fs: false,
        path: require.resolve('path-browserify'),
      };

      // Add plugins for global variables
      webpackConfig.plugins = [
        ...webpackConfig.plugins,
        new webpack.ProvidePlugin({
          Buffer: ['buffer', 'Buffer'],
          process: 'process/browser',
        }),
      ];

      // Add rules for WASM files
      webpackConfig.module.rules.push({
        test: /\.wasm$/,
        type: 'javascript/auto',
        loader: 'file-loader',
        options: {
          publicPath: 'dist/',
        },
      });

      // Ignore specific warnings for tiny-secp256k1
      webpackConfig.ignoreWarnings = [
        /Failed to parse source map/,
        /Critical dependency: the request of a dependency is an expression/,
      ];

      return webpackConfig;
    },
  },
};
