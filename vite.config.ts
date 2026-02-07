import { defineConfig } from "vite";
import license from "rollup-plugin-license";
import path from "path";

export default defineConfig({
  plugins: [
    license({
      thirdParty: {
        includePrivate: false,
        output: {
          file: path.join(__dirname, "src/assets/licenses.json"),
          template(dependencies) {
            return JSON.stringify(dependencies, null, 2);
          },
        },
      },
    }),
  ],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    target: "es2020",
    outDir: "dist"
  }
});
