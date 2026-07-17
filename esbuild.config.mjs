import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import process from "node:process";

// Build modes:
//   (none)        → dev watch into the Test vault
//   "production"  → one-shot build into the Test vault
//   "release"     → installable artifact into dist/ (minified)
const mode = process.argv[2];
const release = mode === "release";
const prod = mode === "production" || release;

// Dev/prod builds target the Test vault directly. Unlike para-garden this is a
// standalone plugin with no live install to clobber, so we use the real id.
const TEST_VAULT_OUTDIR =
  "/home/maltaisio/Repos/Obsidian_dev/Test/.obsidian/plugins/openloops-hidden-files";
const OUTDIR = release ? "dist/openloops-hidden-files" : TEST_VAULT_OUTDIR;

mkdirSync(OUTDIR, { recursive: true });

// Obsidian needs manifest.json alongside main.js. No styles.css — this plugin
// has no CSS (settings tab uses Obsidian's built-in components).
function copyStatics() {
  copyFileSync("manifest.json", `${OUTDIR}/manifest.json`);
}

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/*",
    "@lezer/*",
    // Externalize Node built-ins (we import from "node:fs/promises"). The
    // wildcard covers every node:-prefixed import without a helper dependency.
    "node:*",
  ],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: `${OUTDIR}/main.js`,
  minify: prod,
});

copyStatics();

if (prod) {
  await ctx.rebuild();
  copyStatics();
  await ctx.dispose();
  process.exit(0);
} else {
  await ctx.watch();
  console.log(`[openloops-hidden-files] watching → ${OUTDIR}`);
}
