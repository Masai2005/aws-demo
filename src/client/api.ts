import type { ApiError, Comment, Ok, Post, User } from "../shared/types";

export class RequestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new RequestError(res.status, (data as ApiError | null)?.error ?? "Something went wrong");
  return data as T;
}

export const api = {
  login: (username: string, password: string) => request<User>("/api/login", "POST", { username, password }),
  logout: () => request<Ok>("/api/logout", "POST"),
  me: () => request<User>("/api/me"),
  listPosts: () => request<Post[]>("/api/posts"),
  createPost: (body: string) => request<Post>("/api/posts", "POST", { body }),
  deletePost: (id: number) => request<Ok>(`/api/posts/${id}`, "DELETE"),
  toggleLike: (id: number) => request<Post>(`/api/posts/${id}/like`, "POST"),
  listComments: (postId: number) => request<Comment[]>(`/api/posts/${postId}/comments`),
  addComment: (postId: number, body: string) => request<Comment>(`/api/posts/${postId}/comments`, "POST", { body }),
  deleteComment: (id: number) => request<Ok>(`/api/comments/${id}`, "DELETE"),
};

export const errorText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");
