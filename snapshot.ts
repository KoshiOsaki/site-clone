// snapshot.ts
import fs from "node:fs/promises";
import path from "node:path";
import { mkdirSync, createWriteStream } from "node:fs";
import puppeteer, { HTTPResponse } from "puppeteer";
import archiver from "archiver";

const ROOT_URL = "https://www.889100.com/column";
const OUT_DIR = "snapshot";
const MAX_PAGES = 50; // 無限巡回を防ぐ上限
const CONCURRENT = 4; // 同時ブラウザタブ数

/* ------------------------- ユーティリティ -------------------------- */
function slug(url: URL): string {
  return (
    (url.pathname === "/"
      ? "root"
      : url.pathname.replace(/^\/|\/$/g, "")
    ).replace(/[^a-zA-Z0-9_-]/g, "_") || "index"
  );
}
function localHtmlFile(u: URL) {
  return `${slug(u)}.html`;
}
function isSameSite(root: URL, child: URL) {
  return root.origin === child.origin;
}
/* ------------------------------------------------------------------- */

async function main() {
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch();
  const rootURL = new URL(ROOT_URL);

  // BFS 用キュー
  const queue: URL[] = [rootURL];
  const visited = new Set<string>();

  const workers: Promise<void>[] = [];

  while (queue.length && visited.size < MAX_PAGES) {
    while (workers.length < CONCURRENT && queue.length) {
      const url = queue.shift()!;
      if (visited.has(url.href)) continue;
      visited.add(url.href);
      workers.push(handlePage(url, queue, rootURL, browser));
    }
    await Promise.race(workers).then(() => {
      // 終了した worker をリストから外す
      for (let i = workers.length - 1; i >= 0; --i) {
        if (
          (workers[i] as any).status === "fulfilled" ||
          (workers[i] as any).status === "rejected"
        ) {
          workers.splice(i, 1);
        }
      }
    });
  }
  await Promise.all(workers);
  await browser.close();

  // 圧縮
  await zipDirectory(OUT_DIR, `${OUT_DIR}.zip`);
  console.log(`✔ 完了: ${visited.size} ページを ${OUT_DIR}.zip に保存`);
}

async function handlePage(
  url: URL,
  queue: URL[],
  rootURL: URL,
  browser: puppeteer.Browser
) {
  const page = await browser.newPage();

  // img の取得
  const imgDir = path.join(OUT_DIR, "images");
  mkdirSync(imgDir, { recursive: true });

  page.on("response", async (resp: HTTPResponse) => {
    const ctype = resp.headers()["content-type"] || "";
    if (!ctype.startsWith("image/")) return;

    try {
      const buffer = await resp.buffer();
      const u = new URL(resp.url());
      const fname = `${slug(u)}${path.extname(u.pathname)}`;
      const fpath = path.join(imgDir, fname);
      await fs.writeFile(fpath, buffer);
    } catch {
      /* ignore */
    }
  });

  await page.goto(url.href, { waitUntil: "networkidle2" });

  // HTML 取得 & 解析
  const { html, links, imgs } = await page.evaluate(() => {
    const anchors = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a")
    ).map((a) => a.href);
    const images = Array.from(
      document.querySelectorAll<HTMLImageElement>("img")
    ).map((i) => i.src);
    return {
      html: document.documentElement.outerHTML,
      links: anchors,
      imgs: images,
    };
  });

  // 画像 src をローカル参照へ置換
  let rewritten = html;
  for (const imgURL of imgs) {
    try {
      const u = new URL(imgURL);
      const fname = `${slug(u)}${path.extname(u.pathname)}`;
      rewritten = rewritten.replaceAll(imgURL, `./images/${fname}`);
    } catch {
      // 無効なURLの場合はスキップ
    }
  }

  // 内部リンクを書き換え & キューへ追加
  for (const link of links) {
    try {
      const u = new URL(link, url);
      if (!isSameSite(rootURL, u)) continue;
      rewritten = rewritten.replaceAll(link, `./${localHtmlFile(u)}`);
      if (!visited.has(u.href) && !queue.some((q) => q.href === u.href))
        queue.push(u);
    } catch {
      // 無効なURLの場合はスキップ
    }
  }

  // HTML 保存
  const filePath = path.join(OUT_DIR, localHtmlFile(url));
  await fs.writeFile(filePath, rewritten);
  await page.close();
}

async function zipDirectory(src: string, destZip: string) {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const stream = createWriteStream(destZip);

  return new Promise<void>((resolve, reject) => {
    archive.directory(src, false).on("error", reject).pipe(stream);

    stream.on("close", resolve);
    archive.finalize();
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
