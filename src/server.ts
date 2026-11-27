import index from "./client/index.html";
import { apiRoutes, notFound } from "./api";
import { openDb } from "./db";

const db = openDb(process.env.DB_FILE ?? "data.sqlite");

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3456),
  development: process.env.NODE_ENV !== "production",
  routes: { "/": index, ...apiRoutes(db) },
  fetch: notFound,
});

console.log(`Likes app running at ${server.url}  (demo login: demo / demo1234)`);
