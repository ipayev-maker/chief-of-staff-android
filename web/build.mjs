import { mkdir, writeFile } from "node:fs/promises";

const source =
  process.env.COS_BUNDLE_URL ||
  "https://spabmyyxiufuzsaydrmx.supabase.co/functions/v1/cos-v3-export?name=live";

const response = await fetch(source, { cache: "no-store" });

if (!response.ok) {
  throw new Error(`Failed to fetch Chief of Staff bundle: ${response.status} ${response.statusText}`);
}

const html = await response.text();

if (!html.toLowerCase().includes("<!doctype html")) {
  throw new Error("Chief of Staff bundle is not valid HTML");
}

await mkdir("dist", { recursive: true });
await writeFile("dist/index.html", html, "utf8");

console.log(`Chief of Staff bundle written: ${html.length} chars`);
