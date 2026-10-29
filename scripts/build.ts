import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const repository = "YuanchuLink/sources";
const output = "dist";
const includePrereleases = Bun.env.INCLUDE_PRERELEASES === "true";
type Asset = { name: string; browser_download_url: string };
type Release = {
  draft: boolean;
  prerelease: boolean;
  tag_name: string;
  name: string | null;
  published_at: string | null;
  html_url: string;
  assets: Asset[];
};
type Record = Release & {
  project: string;
  version: string;
  archive: Asset;
  checksum?: string;
};

function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const match = value.match(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
    );
    if (!match) throw new Error(`Invalid semantic version: ${value}`);
    return match;
  };
  const x = parse(a),
    y = parse(b);
  for (let i = 1; i <= 3; i++) {
    const diff = Number(x[i]) - Number(y[i]);
    if (diff) return diff;
  }
  const xp = x[4],
    yp = y[4];
  if (xp === yp) return 0;
  if (!xp) return 1;
  if (!yp) return -1;
  const xs = xp.split("."),
    ys = yp.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    if (xs[i] === undefined) return -1;
    if (ys[i] === undefined) return 1;
    if (xs[i] === ys[i]) continue;
    const xn = /^\d+$/.test(xs[i]),
      yn = /^\d+$/.test(ys[i]);
    if (xn && yn) return Number(xs[i]) - Number(ys[i]);
    if (xn !== yn) return xn ? -1 : 1;
    return xs[i].localeCompare(ys[i]);
  }
  return 0;
}

async function fetchReleases(): Promise<Release[]> {
  const all: Release[] = [];
  for (let page = 1; ; page++) {
    const url = `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`;
    console.log(`Fetching GitHub Releases page ${page}...`);
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(20_000),
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(Bun.env.GITHUB_TOKEN
            ? { Authorization: `Bearer ${Bun.env.GITHUB_TOKEN}` }
            : {}),
        },
      });
    } catch (error) {
      throw new Error(
        `GitHub API request failed on page ${page}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `GitHub API ${response.status}${response.status === 403 || response.status === 429 ? " (rate limited or forbidden)" : ""}: ${detail.slice(0, 500)}`,
      );
    }
    const pageData: unknown = await response.json();
    if (!Array.isArray(pageData))
      throw new Error("GitHub API returned an invalid releases response");
    all.push(...(pageData as Release[]));
    if (pageData.length < 100) break;
  }
  return all;
}

const releases = await fetchReleases();
const groups = new Map<string, Record[]>();
for (const release of releases) {
  if (release.draft || (release.prerelease && !includePrereleases)) continue;
  const match = release.tag_name.match(
    /^([A-Za-z0-9][A-Za-z0-9._-]*)\/v((?:0|[1-9]\d*)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/,
  );
  if (!match) {
    console.warn(`Skipping release with invalid tag: ${release.tag_name}`);
    continue;
  }
  const [, project, version] = match;
  try {
    compareVersions(version, version);
  } catch {
    console.warn(
      `Skipping release with invalid semantic version: ${release.tag_name}`,
    );
    continue;
  }
  const filename = `${project}-v${version}.tar.gz`;
  const archive = release.assets.find((asset) => asset.name === filename);
  if (!archive) {
    console.warn(`Skipping ${release.tag_name}: missing ${filename} asset`);
    continue;
  }
  const item: Record = { ...release, project, version, archive };
  const sums = release.assets.find((asset) => asset.name === "SHA256SUMS");
  if (sums) {
    try {
      const response = await fetch(sums.browser_download_url, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        console.warn(
          `Could not fetch SHA256SUMS for ${release.tag_name}: HTTP ${response.status}`,
        );
      } else {
        const checksumLine = (await response.text())
          .split(/\r?\n/)
          .map((line) => line.match(/^([a-f\d]{64})\s+\*?(.+)$/i))
          .find((line) => line?.[2] === filename);
        if (checksumLine) item.checksum = checksumLine[1].toLowerCase();
        else
          console.warn(`No valid SHA-256 entry for ${filename} in SHA256SUMS`);
      }
    } catch (error) {
      console.warn(
        `Could not fetch SHA256SUMS for ${release.tag_name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const group = groups.get(project) ?? [];
  group.push(item);
  groups.set(project, group);
}
for (const items of groups.values())
  items.sort((a, b) => compareVersions(b.version, a.version));

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp("site/style.css", join(output, "style.css"));
await writeFile(join(output, "CNAME"), "sources.yuanchu.link\n");
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const date = (value: string | null) =>
  value ? new Date(value).toISOString().slice(0, 10) : "Unknown";
const page = (title: string, content: string, base: string) =>
  `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="YuanchuLink public source archives"><title>${esc(title)} | Sources</title><link rel="stylesheet" href="${base}style.css"></head><body><div class="layout"><div class="content-area"><header class="top"><a class="brand" href="${base}"><span class="brand-name">源初计划</span><span class="brand-subtitle">sources</span></a></header><main>${content}</main><footer>Source archives distributed through GitHub Releases.</footer></div></div></body></html>`;
const link = (href: string, text: string, cls = "") =>
  `<a${cls ? ` class="${cls}"` : ""} href="${esc(href)}">${esc(text)}</a>`;
const writePage = async (path: string, html: string) => {
  const full = join(output, path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, html);
};
const projects = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
const rows = projects.length
  ? projects
      .map(
        ([id, items]) =>
          `<tr class="row"><td class="cell">${link(`${encodeURIComponent(id)}/`, id)}</td><td class="cell">${link(items[0].archive.browser_download_url, `v${items[0].version}`)}</td><td class="cell">${items.length}</td></tr>`,
      )
      .join("")
  : `<tr><td colspan="3" class="cell empty">No source releases have been published yet.</td></tr>`;
await writePage(
  "index.html",
  page(
    "Index",
    `<h1>yuanchulink</h1><div class="table-wrap"><table class="table"><thead><tr><th class="head" scope="col">Project</th><th class="head" scope="col">Latest release</th><th class="head" scope="col">Versions</th></tr></thead><tbody>${rows}</tbody></table></div>`,
    "./",
  ),
);
for (const [project, items] of projects) {
  const listing = items
    .map(
      (item) =>
        `<tr class="row"><td class="cell">${link(item.archive.browser_download_url, `v${item.version}`)}</td><td class="cell"><time>${date(item.published_at)}</time></td><td class="cell"><code>${item.checksum ?? "Unavailable"}</code></td><td class="cell">${link(item.archive.browser_download_url, "Download archive", "download")}</td></tr>`,
    )
    .join("");
  await writePage(
    `${project}/index.html`,
    page(
      project,
      `<h1>${link("/", "yuanchulink")} / ${esc(project)}</h1><h2>Releases</h2><div class="table-wrap"><table class="table"><thead><tr><th class="head" scope="col">Version</th><th class="head" scope="col">Published</th><th class="head" scope="col">SHA-256</th><th class="head" scope="col">Archive</th></tr></thead><tbody>${listing}</tbody></table></div>`,
      "../",
    ),
  );
}
console.log(
  `Built static index for ${projects.length} projects from ${releases.length} releases.`,
);
