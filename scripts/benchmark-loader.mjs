import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixTarget(target) {
  if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
  if (fs.existsSync(target + ".js")) return target + ".js";
  if (fs.existsSync(target + ".mjs")) return target + ".mjs";
  if (fs.existsSync(path.join(target, "index.js"))) return path.join(target, "index.js");
  return target;
}

export function resolve(specifier, context, nextResolve) {
  if (specifier === "open-sse" || specifier.startsWith("open-sse/")) {
    const subpath = specifier === "open-sse" ? "index.js" : specifier.slice("open-sse/".length);
    const target = fixTarget(path.join(root, "open-sse", subpath));
    return { url: pathToFileURL(target).href, shortCircuit: true };
  }
  if (specifier.startsWith("@/")) {
    const target = fixTarget(path.join(root, "src", specifier.slice(2)));
    return { url: pathToFileURL(target).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
