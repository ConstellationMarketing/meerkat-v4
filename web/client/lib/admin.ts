/**
 * Admin utilities for managing users and other administrative tasks
 */

export interface DeleteUserRequest {
  email?: string;
  userId?: string;
}

export interface DeleteUserResponse {
  success: boolean;
  message: string;
  deletedUser: {
    id: string;
    email: string;
  };
}

/**
 * Delete a user from Supabase Auth by email or ID
 * This is an admin-only operation
 */
export async function deleteUserFromAuth(
  request: DeleteUserRequest,
): Promise<DeleteUserResponse> {
  if (!request.email && !request.userId) {
    throw new Error("Must provide either email or userId");
  }

  const response = await fetch("/api/delete-user", {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to delete user");
  }

  return response.json();
}

/**
 * Delete a user from Supabase Auth AND remove all their associated data
 * (articles, comments, access records, etc.)
 * This is an admin-only operation
 */
export async function deleteUserAndDataFromAuth(
  request: DeleteUserRequest,
): Promise<DeleteUserResponse> {
  if (!request.email && !request.userId) {
    throw new Error("Must provide either email or userId");
  }

  const response = await fetch("/api/delete-user-cascade", {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to delete user");
  }

  return response.json();
}
