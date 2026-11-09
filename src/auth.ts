export type Role = "admin" | "viewer";

export interface User {
  id: string;
  role: Role;
}

const USERS: Readonly<Record<string, User>> = {
  admin: { id: "admin", role: "admin" },
  viewer: { id: "viewer", role: "viewer" },
};

/** Identity is trusted input. It is never taken from the model output. */
export function resolveIdentity(userId: string): User | null {
  return USERS[userId] ?? null;
}

export function canRead(user: User): boolean {
  return user.role === "admin" || user.role === "viewer";
}

export function canRelease(user: User): boolean {
  return user.role === "admin";
}
