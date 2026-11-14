import { defineConfig } from "tsdown";

// Same files and names tsup made: index and cli, as CJS (.js, .d.ts) and ESM (.mjs, .d.mts).
export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["cjs", "esm"],
  dts: true,
  target: "es2020",
  outExtensions: ({ format }) =>
    format === "cjs" ? { js: ".js", dts: ".d.ts" } : { js: ".mjs", dts: ".d.mts" },
});
