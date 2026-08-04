import { readFile } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-static";

export async function GET() {
  const css = await readFile(path.join(process.cwd(), "app", "globals.css"), "utf8");

  return new Response(css, {
    headers: { "Content-Type": "text/css; charset=utf-8" },
  });
}
