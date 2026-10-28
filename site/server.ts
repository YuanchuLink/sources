import { resolve, sep } from "node:path";

const root = resolve("dist");
const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  async fetch(request) {
    const url = new URL(request.url);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith("/")) path += "index.html";
    const filePath = resolve(root, `.${path}`);
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`))
      return new Response("Not Found", { status: 404 });
    const file = Bun.file(filePath);
    if (!(await file.exists()))
      return new Response("Not Found", { status: 404 });
    return new Response(file);
  },
});
console.log(`Sources available at ${server.url}`);
