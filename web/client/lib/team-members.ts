import { supabase } from "@/lib/supabase";

export interface TeamMember {
  id: string;
  user_id: string;
  email_address: string;
  role: "admin" | "member";
  created_at: string;
}

export async function getTeamMembers(): Promise<TeamMember[]> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    console.log("🔄 Fetching team members from /api/team-members...");
    const response = await fetch("/api/team-members", {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    console.log("📊 Team members API response status:", response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ Team members API error:", {
        status: response.status,
        statusText: response.statusText,
        body: errorText,
      });
      throw new Error(
        `Failed to fetch team members: ${response.status} ${response.statusText}`,
      );
    }

    const data = await response.json();
    console.log("✅ Team members fetched successfully:", {
      count: data?.length || 0,
      members:
        data?.map((m: TeamMember) => ({
          id: m.id,
          email: m.email_address,
          role: m.role,
          user_id: m.user_id,
        })) || [],
    });
    return data;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("❌ Error fetching team members:", errorMsg);

    // Return empty array instead of throwing on network errors
    // to gracefully degrade when the API is temporarily unavailable
    if (errorMsg.includes("Failed to fetch") || errorMsg.includes("abort")) {
      console.warn(
        "⚠️ Team members API unavailable, returning empty list. This will cause members to see all articles!",
      );
      return [];
    }

    console.warn("⚠️ Unexpected error in getTeamMembers, returning empty list");
    return [];
  }
}

export async function addTeamMember(
  email: string,
  role: "admin" | "member",
): Promise<TeamMember> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch("/api/team-members", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, role }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Failed to add team member");
    }

    return await response.json();
  } catch (error) {
    console.error("Error adding team member:", error);
    throw error;
  }
}

export async function updateTeamMemberRole(
  memberId: string,
  role: "admin" | "member",
): Promise<TeamMember> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch("/api/team-members", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ memberId, role }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Failed to update team member");
    }

    return await response.json();
  } catch (error) {
    console.error("Error updating team member:", error);
    throw error;
  }
}

export async function removeTeamMember(memberId: string): Promise<void> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch("/api/team-members", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ memberId }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Failed to remove team member");
    }
  } catch (error) {
    console.error("Error removing team member:", error);
    throw error;
  }
}

export async function getUserRole(
  userId: string,
): Promise<"admin" | "member" | null> {
  try {
    console.log("🔍 Getting user role for userId:", userId);

    const members = await getTeamMembers();

    if (!members || members.length === 0) {
      console.warn(
        "⚠️ No team members returned from API! This indicates the API is not working correctly.",
      );
      console.warn(
        "🔴 CRITICAL: User will be treated as having no role, which defaults to showing ALL articles!",
      );
      return null;
    }

    console.log("🔎 Searching for user in team members list...");
    const userMember = members.find((m) => {
      const matches = m.user_id === userId;
      if (matches) {
        console.log("✅ Found user in team members:", {
          email: m.email_address,
          role: m.role,
          user_id: m.user_id,
        });
      }
      return matches;
    });

    if (!userMember) {
      console.warn("⚠️ User not found in team members list:", {
        userId,
        availableUserIds: members.map((m) => m.user_id),
      });
      return null;
    }

    console.log("✅ User role determined:", userMember.role);
    return userMember.role;
  } catch (error) {
    console.error("Error getting user role:", error);
    return null;
  }
}
