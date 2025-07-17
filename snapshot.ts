// snapshot.ts
import fs from "node:fs/promises";
import path from "node:path";
import { mkdirSync, createWriteStream } from "node:fs";
import archiver from "archiver";
import * as puppeteer from "puppeteer";
import { HTTPResponse } from "puppeteer";
import prompts from "prompts";


const MAX_PAGES = 10; // 無限巡回を防ぐ上限、メモリ使用量削減のためさらに減らす
const BATCH_SIZE = 3; // メモリ解放のために、この数のページを処理した後に一時停止する

/* ------------------------- ユーティリティ -------------------------- */
function slug(url: URL): string {
  return (
    (url.pathname === "/"
      ? "root"
      : url.pathname.replace(/^\/|\/$/g, "")
    ).replace(/[^a-zA-Z0-9_-]/g, "_") || "index"
  );
}
function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // $&はマッチした部分文字列全体を意味します
}
function localHtmlFile(u: URL) {
  return `${slug(u)}.html`;
}
function isSameSite(root: URL, child: URL) {
  return root.origin === child.origin;
}
/* ------------------------------------------------------------------- */

async function main() {
  const response = await prompts([
    {
      type: "text",
      name: "targetUrl",
      message: "複製したいページのURLを入力してください",
      validate: (value) => {
        try {
          new URL(value);
          return true;
        } catch {
          return "有効なURLを入力してください";
        }
      },
    },
    {
      type: "text",
      name: "alias",
      message: "ページのエイリアスを入力してください",
      validate: (value) =>
        value.length > 0 ? true : "エイリアスは必須です",
    },
  ]);

  if (!response.targetUrl || !response.alias) {
    console.log("処理を中断しました。");
    return;
  }

  const { targetUrl, alias } = response;

  const rootURL = new URL(targetUrl);
  const outDir = path.join("snapshot", alias);

  await fs.rm(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--disable-extensions",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });

  const queue: URL[] = [rootURL];
  const crawled = new Set<string>();

  while (queue.length > 0 && crawled.size < MAX_PAGES) {
    const url = queue.shift()!;
    if (crawled.has(url.href)) {
      continue;
    }
    crawled.add(url.href);

    console.log(`処理中: ${url.href} (${crawled.size}/${MAX_PAGES})`);

    try {
      await handlePage(url, queue, rootURL, browser, crawled, outDir);
    } catch (error) {
      console.error(`ページ処理エラー: ${url.href}`, error);
    }
  }

  await browser.close();

  await zipDirectory(outDir, `${outDir}.zip`);
  console.log(`✔ 完了: ${crawled.size} ページを ${outDir}.zip に保存`);
}
async function handlePage(
  url: URL,
  queue: URL[],
  rootURL: URL,
  browser: puppeteer.Browser,
  crawled: Set<string>,
  outDir: string
) {
  const page = await browser.newPage();

  // メモリ使用量を削減するための設定
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    // 画像、CSS、フォントのみ許可し、他はブロック
    const resourceType = request.resourceType();
    if (["image", "stylesheet", "font", "document"].includes(resourceType)) {
      request.continue();
    } else {
      request.abort();
    }
  });

  // 保存先ディレクトリの準備
  const imgDir = path.join(outDir, "images");
  mkdirSync(imgDir, { recursive: true });
  const cssDir = path.join(outDir, "css");
  mkdirSync(cssDir, { recursive: true });

  const assetPromises: Promise<void>[] = [];
  page.on("response", (resp: HTTPResponse) => {
    const ctype = resp.headers()["content-type"] || "";
    const u = new URL(resp.url());

    // 画像を保存
    if (ctype.startsWith("image/")) {
      const promise = (async () => {
        try {
          const buffer = await resp.buffer();
          const fname = `${slug(u)}${path.extname(u.pathname)}`;
          const fpath = path.join(imgDir, fname);
          await fs.writeFile(fpath, buffer);
        } catch (e) {
          console.error(`画像保存エラー: ${u.href}`);
        }
      })();
      assetPromises.push(promise);
      // CSSを保存
    } else if (ctype.startsWith("text/css")) {
      const promise = (async () => {
        try {
          const buffer = await resp.text();
          const fname = `${slug(u)}.css`;
          const fpath = path.join(cssDir, fname);
          await fs.writeFile(fpath, buffer);
        } catch (e) {
          console.error(`CSS保存エラー: ${u.href}`, e);
        }
      })();
      assetPromises.push(promise);
    }
  });

  try {
    await page.goto(url.href, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  } catch (error) {
    console.error(`ページ読み込みエラー: ${url.href}`, error);
    await page.close();
    return;
  }

  // アセット(画像・CSS)のダウンロードが完了するのを待つ
  await Promise.all(assetPromises);

  // HTMLからリンク、画像、CSSのURLを取得
  const { links, imgs, css } = await page.evaluate(() => {
    const anchors = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a")
    ).map((a) => a.getAttribute("href"));
    const images = Array.from(
      document.querySelectorAll<HTMLImageElement>("img")
    ).map((i) => i.src);
    const stylesheets = Array.from(
      document.querySelectorAll('link[rel="stylesheet"]')
    ).map((l) => l.getAttribute("href"));
    return { links: anchors, imgs: images, css: stylesheets };
  });

  const html = await page.content();

  // アセットのダウンロード時間を確保するために3秒待機
  await new Promise((resolve) => setTimeout(resolve, 3000));

  await page.close();

  let rewritten = html;

  // 画像のsrcをローカルパスに置換
  for (const imgURL of imgs) {
    if (!imgURL) continue;
    try {
      const u = new URL(imgURL);
      const fname = `${slug(u)}${path.extname(u.pathname)}`;
      rewritten = rewritten.replace(
        new RegExp(escapeRegExp(imgURL), "g"),
        `./images/${fname}`
      );
    } catch (e) {
      console.error(`画像URL書き換えエラー: ${imgURL}`, e);
    }
  }

  // CSSのhrefをローカルパスに置換
  for (const cssHref of css) {
    if (!cssHref) continue;
    try {
      const u = new URL(cssHref, url.href);
      const fname = `${slug(u)}.css`;
      rewritten = rewritten.replace(
        new RegExp(escapeRegExp(cssHref), "g"),
        `./css/${fname}`
      );
    } catch (e) {
      console.error(`CSS書き換えエラー: ${cssHref}`, e);
    }
  }

  // aタグのhrefをローカルパスに置換
  for (const anchorHref of links) {
    if (!anchorHref) continue;
    try {
      const u = new URL(anchorHref, url.href);
      if (u.hostname === rootURL.hostname) {
        const fname = localHtmlFile(u);
        rewritten = rewritten.replace(
          new RegExp(`href="${escapeRegExp(anchorHref)}"`, "g"),
          `href="./${fname}"`
        );
      }
    } catch (e) {
      // ignore invalid URLs
    }
  }

  // HTMLを保存
  const filePath = path.join(outDir, localHtmlFile(url));
  await fs.writeFile(filePath, rewritten);

  // キューに新しいURLを追加
  for (const link of links) {
    if (!link) continue;
    try {
      const nextURL = new URL(link, url.href);
      if (
        nextURL.hostname === rootURL.hostname &&
        !queue.some((q) => q.href === nextURL.href) &&
        !crawled.has(nextURL.href)
      ) {
        queue.push(nextURL);
      }
    } catch {
      /* ignore */
    }
  }
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
