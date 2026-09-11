import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptDirectory, "..");
const distDirectory = resolve(projectDirectory, "dist");
const indexPath = resolve(distDirectory, "index.html");
const outputPath = resolve(distDirectory, "fox-focus.html");

const mimeTypes = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const assetPath = (reference) => {
  const pathname = new URL(reference, "https://fox-focus.local").pathname;

  if (!pathname.startsWith("/assets/")) {
    throw new Error(`Expected a built asset reference, received ${reference}.`);
  }

  const path = resolve(distDirectory, `.${pathname}`);

  if (!path.startsWith(`${distDirectory}/`)) {
    throw new Error(`Asset path escapes dist: ${reference}.`);
  }

  return path;
};

const dataUri = async (reference) => {
  const path = assetPath(reference);
  const mimeType = mimeTypes[extname(path).toLowerCase()];

  if (!mimeType) {
    throw new Error(`No MIME type configured for ${path}.`);
  }

  const content = await readFile(path);
  return `data:${mimeType};base64,${content.toString("base64")}`;
};

const inlineCssAssets = async (css) => {
  const matches = [...css.matchAll(/url\((['"]?)(\/assets\/[^)'"\s]+)\1\)/g)];
  let result = "";
  let offset = 0;

  for (const match of matches) {
    const [source, quote, reference] = match;
    const index = match.index ?? 0;
    const replacement = `url(${quote}${await dataUri(reference)}${quote})`;

    result += css.slice(offset, index);
    result += replacement;
    offset = index + source.length;
  }

  return result + css.slice(offset);
};

const html = await readFile(indexPath, "utf8");
const stylesheetTag = html.match(/<link\b[^>]*\brel="stylesheet"[^>]*>/)?.[0];
const moduleScriptTag = html
  .match(/<script\b[^>]*\btype="module"[^>]*\bsrc="[^"]+"[^>]*><\/script>/)?.[0];

if (!stylesheetTag || !moduleScriptTag) {
  throw new Error("Could not find Vite's stylesheet and module script in dist/index.html.");
}

const stylesheetReference = stylesheetTag.match(/\bhref="([^"]+)"/)?.[1];
const scriptReference = moduleScriptTag.match(/\bsrc="([^"]+)"/)?.[1];

if (!stylesheetReference || !scriptReference) {
  throw new Error("Could not read a built asset reference.");
}

const [css, script] = await Promise.all([
  readFile(assetPath(stylesheetReference), "utf8").then(inlineCssAssets),
  readFile(assetPath(scriptReference), "utf8"),
]);

const bundledScript = `<script>\n${script.replaceAll("</script>", "<\\/script>")}\n    </script>`;
const standaloneHtml = html
  .replace(stylesheetTag, () => `<style>\n${css}\n    </style>`)
  .replace(moduleScriptTag, "")
  .replace("</body>", () => `    ${bundledScript}\n  </body>`);

await writeFile(outputPath, standaloneHtml, "utf8");

console.log(`Created ${outputPath}`);
