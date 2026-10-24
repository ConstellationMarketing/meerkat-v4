import { cp, access, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../dist/os/", import.meta.url));
const checkout = process.argv[2];
if (!checkout) throw new Error("Usage: node scripts/export-to-os.mjs <os-checkout>");
const root = resolve(checkout);
await access(join(root, "vite.config.js"));
await access(join(root, "functions"));
await access(join(source, "index.html"));
const target = join(root, "meerkat");
console.log(`Replacing ${target} with ${source}`);
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
