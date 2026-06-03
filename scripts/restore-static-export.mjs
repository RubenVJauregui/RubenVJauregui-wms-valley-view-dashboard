import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(root, "website-source");
const exportDir = join(root, "out");

if (!existsSync(sourceDir)) {
  throw new Error("Missing website-source restore snapshot.");
}

rmSync(exportDir, { recursive: true, force: true });
mkdirSync(exportDir, { recursive: true });
cpSync(sourceDir, exportDir, { recursive: true });
