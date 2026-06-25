/* eslint-disable no-undef */
const devCerts = require("office-addin-dev-certs");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const path = require("path");

const urlDev = "https://localhost:3333/";
const urlProd = "https://flowcore-io.github.io/usable-excel/";

async function getHttpsOptions() {
  const httpsOptions = await devCerts.getHttpsServerOptions();
  // office-addin-dev-certs returns { ca, cert, key } (PEM) — NOT { pfx, passphrase }.
  // Passing pfx/passphrase (undefined) makes webpack-dev-server fall back to its
  // own self-signed server.pem, which the Office WebView rejects as untrusted.
  return { ca: httpsOptions.ca, cert: httpsOptions.cert, key: httpsOptions.key };
}

module.exports = async (env, options) => {
  const dev = options.mode === "development";
  const buildType = dev ? "dev" : "prod";

  return {
    devtool: "source-map",
    entry: {
      polyfill: ["core-js/stable", "regenerator-runtime/runtime"],
      taskpane: ["./src/taskpane/index.tsx", "./src/taskpane/taskpane.html"],
      commands: "./src/commands/commands.ts",
    },
    output: {
      clean: true,
      path: path.resolve(__dirname, "dist"),
      publicPath: dev ? "/" : "/usable-excel/",
    },
    resolve: {
      extensions: [".ts", ".tsx", ".html", ".js"],
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          exclude: /node_modules/,
          use: {
            loader: "ts-loader",
          },
        },
        {
          test: /\.html$/,
          exclude: /node_modules/,
          use: "html-loader",
        },
        {
          test: /\.(png|jpg|jpeg|gif|ico)$/,
          type: "asset/resource",
          generator: {
            filename: "assets/[name][ext][query]",
          },
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        filename: "taskpane.html",
        template: "./src/taskpane/taskpane.html",
        chunks: ["polyfill", "taskpane"],
      }),
      new HtmlWebpackPlugin({
        filename: "commands.html",
        template: "./src/commands/commands.html",
        chunks: ["polyfill", "commands"],
      }),
      // Self-contained OAuth dialog — no JS chunks, template output as-is
      new HtmlWebpackPlugin({
        filename: "auth-dialog.html",
        template: "./src/taskpane/auth-dialog.html",
        chunks: [],
        inject: false,
      }),
      new CopyWebpackPlugin({
        patterns: [
          {
            from: "assets/*",
            to: "assets/[name][ext][query]",
          },
          {
            from: "manifest*.xml",
            to: "[name]" + "[ext]",
            transform(content) {
              if (dev) {
                return content;
              } else {
                return content.toString().replace(new RegExp(urlDev, "g"), urlProd);
              }
            },
          },
        ],
      }),
    ],
    devServer: {
      hot: true,
      headers: {
        "Access-Control-Allow-Origin": "*",
        // Office WebView (WKWebView) aggressively caches the unhashed parent
        // bundle (taskpane.js), so code changes don't appear on reload. Force
        // revalidation in dev so a pane reload always fetches fresh assets.
        "Cache-Control": "no-store",
      },
      server: {
        type: "https",
        options: env.WEBPACK_BUILD || options.https !== undefined ? options.https : await getHttpsOptions(),
      },
      port: 3333,
      // Proxy /auth/token → Keycloak token endpoint (avoids CORS from the dialog page)
      proxy: [
        {
          context: ["/auth/token"],
          target: "https://auth.flowcore.io",
          pathRewrite: { "^/auth/token": "/realms/memory-mesh/protocol/openid-connect/token" },
          changeOrigin: true,
          secure: true,
        },
      ],
    },
  };
};
