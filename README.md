## Sources

源初计划公开源代码归档与分发仓库。

### 开发

本项目使用 [Mise](https://mise.jdx.dev/) 管理 Bun 运行环境。先安装 Mise，再运行以下命令：

```sh
mise install
bun install
bun run dev
bun run lint
bun run typecheck
bun run build
```

构建会从 `YuanchuLink/sources` GitHub Releases 获取索引；API 失败时构建会报错。可设置 `GITHUB_TOKEN` 提高 API 限额。设置 `INCLUDE_PRERELEASES=true` 可纳入预发布版本。运行 `bun run dev` 可在本地查看已生成的 `dist/` 静态站点。
