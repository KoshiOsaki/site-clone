import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "child_process";
import prompts from "prompts";

const SNAPSHOT_DIR = "snapshot";

async function main() {
  let dirs;
  try {
    dirs = (await fs.readdir(SNAPSHOT_DIR, { withFileTypes: true }))
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);
  } catch (error) {
    console.error(`'${SNAPSHOT_DIR}' ディレクトリの読み込みに失敗しました。`);
    return;
  }

  if (dirs.length === 0) {
    console.log(`'${SNAPSHOT_DIR}' 内にプレビューできるディレクトリがありません。`);
    return;
  }

  const response = await prompts({
    type: "select",
    name: "alias",
    message: "プレビューするエイリアスを選択してください",
    choices: dirs.map((dir) => ({ title: dir, value: dir })),
  });

  if (!response.alias) {
    console.log("処理を中断しました。");
    return;
  }

  const targetDir = path.join(SNAPSHOT_DIR, response.alias);
  console.log(`\nhttp-server を起動します... ${targetDir}`);

  const serverProcess = exec(`npx http-server ${targetDir}`);

  serverProcess.stdout?.on("data", (data) => {
    console.log(data);
  });

  serverProcess.stderr?.on("data", (data) => {
    console.error(data);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
