import { cp, mkdir, rm } from "node:fs/promises";

const output = "dist";

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp("site/index.html", `${output}/index.html`);
await cp("site/style.css", `${output}/style.css`);

const result = await Bun.build({
  entrypoints: ["site/main.ts"],
  outdir: output,
  target: "browser",
});

if (!result.success) {
  throw new AggregateError(result.logs, "Failed to build the site");
}
