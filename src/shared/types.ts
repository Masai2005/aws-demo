// Shapes shared by the Bun server and the React client.

export type User = { id: number; username: string };

export type Post = {
  id: number;
  author: User;
  body: string;
  createdAt: string; // ISO 8601, UTC
  likeCount: number;
  likedByMe: boolean;
  commentCount: number;
};

export type Comment = {
  id: number;
  postId: number;
  parentId: number | null; // set when this comment is a reply
  author: User;
  body: string;
  createdAt: string; // ISO 8601, UTC
};

export type Ok = { ok: true };
export type ApiError = { error: string };

export const MAX_TEXT_LENGTH = 500;
export const DEMO_USER = { username: "demo", password: "demo1234" } as const;
