// Fills in the sites' colours in authentik's branding, from palette.json: SharedUI's
// brand/palette.json (the one place colours are defined), which the Dockerfile downloads from a
// tagged SharedUI release next to this script, with SharedUI's brand/logo.svg in brand/.
//
// In brand.css, brand/*.svg and templates/**/*.html, [[light.<name>]] and [[dark.<name>]] become
// that colour's light or dark value, e.g. [[dark.primary]]. An unknown name fails the build.
// It also draws brand/email-logo.png (the logo emails attach) from brand/logo.svg with sharp,
// which the Dockerfile installs.
//
//   node render-brand.mjs <out-dir>
// The Dockerfile runs it when the image builds; locally it's a quick check of the templates.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2];
if (!out) throw new Error("Usage: node render-brand.mjs <out-dir>");

const { groups } = JSON.parse(readFileSync(join(here, "palette.json"), "utf8"));
const colours = Object.assign({}, ...Object.values(groups));

function files(path) {
  return statSync(path).isDirectory()
    ? readdirSync(path).flatMap((name) => files(join(path, name)))
    : [path];
}

const sources = [
  join(here, "brand.css"),
  ...files(join(here, "brand")).filter((f) => f.endsWith(".svg")),
  ...files(join(here, "templates")).filter((f) => f.endsWith(".html")),
];

const errors = [];
for (const source of sources) {
  const name = relative(here, source);
  const text = readFileSync(source, "utf8").replace(
    /\[\[(light|dark)\.([a-z-]+)\]\]/g,
    (match, theme, colour) => {
      if (colours[colour]) return colours[colour][theme];
      errors.push(`${name}: unknown colour ${match}`);
      return match;
    },
  );
  const target = join(out, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

// The email logo: a PNG, because many email clients don't show SVG.
let sharp;
try {
  sharp = (await import("sharp")).default;
} catch {
  console.log(`Rendered ${sources.length} files into ${out} (no sharp, so no email-logo.png)`);
  process.exit(0);
}
await sharp(join(out, "brand/logo.svg"), { density: 300 })
  .resize(96, 96)
  .png()
  .toFile(join(out, "brand/email-logo.png"));
console.log(`Rendered ${sources.length} files and brand/email-logo.png into ${out}`);
