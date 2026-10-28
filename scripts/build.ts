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
  body: string | null;
  assets: Asset[];
};
type Record = Release & {
  project: string;
  version: string;
  archive: Asset;
  checksum?: string;
  originalRepository?: string;
  originalTag?: string;
  originalCommit?: string;
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
  const body = release.body ?? "";
  const metadata = (key: string) =>
    body
      .match(new RegExp(`^\\s*[-*]?\\s*${key}:\\s*([^\\r\\n]+)`, "im"))?.[1]
      ?.trim();
  const repo = metadata("Original repository");
  if (repo && /^[\w.-]+\/[\w.-]+$/.test(repo)) item.originalRepository = repo;
  const tag = metadata("Original tag");
  if (tag) item.originalTag = tag;
  const commit = metadata("Original commit");
  if (commit && /^[0-9a-f]{7,40}$/i.test(commit)) item.originalCommit = commit;
  const sums = release.assets.find((asset) => asset.name === "SHA256SUMS");
  if (sums) {
    console.log(`Fetching checksum asset for ${release.tag_name}...`);
    let response: Response;
    try {
      response = await fetch(sums.browser_download_url, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        console.warn(
          `Could not fetch SHA256SUMS for ${release.tag_name}: HTTP ${response.status}; checksum omitted.`,
        );
      } else {
        const content = await response.text();
        const checksums = content
          .split(/\r?\n/)
          .map((line) => line.match(/^([a-f\d]{64})\s+\*?(.+)$/i))
          .filter((entry): entry is RegExpMatchArray => entry !== null);
        item.checksum = checksums
          .find((entry) => entry[2] === filename)?.[1]
          .toLowerCase();
        if (!item.checksum)
          console.warn(`No valid checksum for ${filename} in SHA256SUMS`);
      }
    } catch (error) {
      console.warn(
        `Could not fetch SHA256SUMS for ${release.tag_name}: ${error instanceof Error ? error.message : String(error)}; checksum omitted.`,
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
  `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="YuanchuLink public source archives"><title>${esc(title)} | Sources</title><link rel="stylesheet" href="${base}style.css"></head><body><header class="top"><a href="${base}">YuanchuLink / <strong>Sources</strong></a><span>Source archive index</span></header><main>${content}</main><footer>Source archives distributed through GitHub Releases.</footer></body></html>`;
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
          `<tr><th scope="row">${link(`${encodeURIComponent(id)}/`, id)}</th><td>${link(`${encodeURIComponent(id)}/v${encodeURIComponent(items[0].version)}/`, `v${items[0].version}`)}</td><td>${items.length}</td></tr>`,
      )
      .join("")
  : `<tr><td colspan="3" class="empty">No source releases have been published yet.</td></tr>`;
await writePage(
  "index.html",
  page(
    "Index",
    `<h1>YuanchuLink / Sources</h1><p class="intro">源初计划公开源代码归档与分发仓库。</p><h2>Projects</h2><div class="table-wrap"><table><thead><tr><th>Project</th><th>Latest release</th><th>Versions</th></tr></thead><tbody>${rows}</tbody></table></div>`,
    "./",
  ),
);
for (const [project, items] of projects) {
  const projectUrl = `/${encodeURIComponent(project)}/`;
  const listing = items
    .map(
      (item) =>
        `<li><div>${link(`v${encodeURIComponent(item.version)}/`, `v${item.version}`)}<time>${date(item.published_at)}</time></div>${link(item.archive.browser_download_url, "Download archive", "download")}</li>`,
    )
    .join("");
  await writePage(
    `${project}/index.html`,
    page(
      project,
      `<nav>${link("/", "← All projects")}</nav><h1>${esc(project)}</h1><h2>Releases</h2><ul class="releases">${listing}</ul>`,
      "../",
    ),
  );
  for (const item of items) {
    const metadata = [
      item.originalRepository &&
        `<dt>Original repository</dt><dd>${link(`https://github.com/${item.originalRepository}`, item.originalRepository)}</dd>`,
      item.originalTag &&
        `<dt>Original tag</dt><dd><code>${esc(item.originalTag)}</code></dd>`,
      item.originalCommit &&
        `<dt>Original commit</dt><dd><code>${esc(item.originalCommit)}</code></dd>`,
    ]
      .filter(Boolean)
      .join("");
    const checksum = item.checksum
      ? `<dt>SHA-256</dt><dd><code>${item.checksum}</code></dd>`
      : `<dt>SHA-256</dt><dd>Not available</dd>`;
    const content = `<nav>${link("/", "← All projects")} / ${link(projectUrl, project)}</nav><h1>${esc(project)} <span class="version">v${esc(item.version)}</span></h1><p class="muted">Published ${date(item.published_at)}</p><section class="panel"><h2>Source archive</h2><p><code>${esc(item.archive.name)}</code></p>${link(item.archive.browser_download_url, "Download official source archive", "download")}</section><dl><dt>GitHub Release</dt><dd>${link(item.html_url, "View release")}</dd>${checksum}${metadata}</dl><aside>Download the official source archive from the uploaded Release assets. GitHub-generated source archives contain the Sources repository, not the original project.</aside>`,
      base = "../../";
    await writePage(
      `${project}/v${item.version}/index.html`,
      page(`${project} v${item.version}`, content, base),
    );
  }
}
console.log(
  `Built static index for ${projects.length} projects from ${releases.length} releases.`,
);
